const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../app/miniprogram');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function environment() {
  let accepted = true, confirmation; const effects = [];
  class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const api = { ApiError, errorMessage: error => error.message, toast: message => effects.push(message), confirm: async () => { effects.push('confirm'); return confirmation ? confirmation() : accepted; } };
  const module = { exports: {} }, file = path.join(root, 'services/reference-controller.ts');
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: name => { assert.equal(name, './api'); return api; }, console });
  return { ...module.exports, ApiError, effects, accept(value) { accepted = value; }, confirmation(fn) { confirmation = fn; } };
}
function instance(definition, properties = {}) {
  const events = [], host = { data: structuredClone(definition.data || {}), properties,
    setData(values, callback) { for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let target = this.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value; } callback?.(); },
    triggerEvent(name, detail) { events.push({ name, detail }); }, events };
  Object.assign(host, definition.methods);
  host.attach = () => definition.lifetimes?.attached?.call(host);
  host.show = () => definition.pageLifetimes?.show?.call(host);
  host.hide = () => definition.pageLifetimes?.hide?.call(host);
  host.detach = () => definition.lifetimes?.detached?.call(host);
  return host;
}

test('adapter runs onLoad once and deduplicates first show while preserving each real foreground', async () => {
  const env = environment(), loaded = gate(), calls = [];
  const controller = env.defineReferencePage({ data: { embedded: false, value: '' },
    async onLoad(params) { calls.push('load:' + params.id); await loaded.promise; this.setData({ value: params.id }); },
    onShow() { calls.push('show'); }, onHide() { calls.push('hide'); }, onUnload() { calls.push('unload'); } });
  const p = instance(env.referenceComponent(controller), { params: { id: 'actual-activity' } });
  p.show(); const mounting = p.attach(); p.show(); assert.deepEqual(calls, ['load:actual-activity']);
  loaded.release(); await mounting; p.show(); assert.deepEqual(calls, ['load:actual-activity', 'show']); assert.equal(p.data.embedded, true); assert.equal(controller.data.embedded, false);
  p.hide(); p.hide(); await p.show(); assert.equal(calls.filter(x => x === 'show').length, 2); assert.equal(calls.filter(x => x === 'hide').length, 1);
  p.detach(); p.detach(); assert.equal(calls.filter(x => x === 'unload').length, 1);
});

test('synchronous guards stay booleans and cannot become truthy promises that bypass a denied write', async () => {
  const env = environment(); let writes = 0;
  const p = instance(env.referenceComponent(env.defineReferencePage({ data: { allow: false }, canWrite() { return this.data.allow; },
    save() { if (!this.canWrite()) return false; writes++; return true; } })));
  await p.attach(); assert.equal(p.canWrite(), false); assert.equal(p.save(), false); assert.equal(writes, 0);
  p.setData({ allow: true }); assert.equal(p.canWrite(), true); assert.equal(p.save(), true); assert.equal(writes, 1);
});

test('ordinary hide preserves camera drafts and only the original fresh foreground check clears a revoked role', async () => {
  const env = environment(); let owner = true, unloads = 0, verifications = 0;
  const p = instance(env.referenceComponent(env.defineReferencePage({ data: { draft: '', dirty: false, owner: true },
    onShow() { verifications++; if (!owner) this.setData({ owner: false, draft: '', dirty: false }); }, onUnload() { unloads++; this.setData({ draft: '', dirty: false }); } })));
  await p.attach(); p.setData({ draft: '/saved/actual-camera-file', dirty: true }); p.hide(); assert.equal(unloads, 0); assert.equal(p.data.draft, '/saved/actual-camera-file');
  await p.show(); assert.equal(p.data.dirty, true); assert.equal(verifications, 2);
  p.hide(); owner = false; await p.show(); assert.equal(p.data.owner, false); assert.equal(p.data.draft, ''); assert.equal(unloads, 0);
  p.detach(); assert.equal(unloads, 1);
});

test('detached controllers reject late helper writes and ignore late private setData without touching another instance', async () => {
  const env = environment(), release = gate(); let writes = 0;
  const definition = env.referenceComponent(env.defineReferencePage({ data: { privateText: '' },
    async read() { await release.promise; this.setData({ privateText: 'old-private-response' }); },
    async write() { await release.promise; this.send(); }, send() { writes++; }, onUnload() { this.setData({ privateText: '' }); } }));
  const old = instance(definition), current = instance(definition); await old.attach(); const reading = old.read(), writing = old.write(); old.detach(); await current.attach();
  current.setData({ privateText: 'new-instance-record' }); release.release(); await reading; await assert.rejects(writing, error => error.code === 'REFERENCE_CLOSED');
  assert.equal(old.data.privateText, ''); assert.equal(current.data.privateText, 'new-instance-record'); assert.equal(writes, 0);
});

test('close blocks in-flight writes, respects cancelled dirty confirmation and reports only an explicit change marker', async () => {
  const env = environment();
  const p = instance(env.referenceComponent(env.defineReferencePage({ data: { busy: true, dirty: false, notice: 'not proof of a saved change' } }), { isBusy: data => data.busy, isDirty: data => data.dirty }));
  await p.attach(); assert.equal((await p.referenceRequestClose()).allowed, false); assert(!env.effects.includes('confirm'));
  p.setData({ busy: false, dirty: true }); env.accept(false); assert.equal((await p.referenceRequestClose()).allowed, false);
  env.accept(true); const plain = await p.referenceRequestClose(); assert.equal(plain.allowed, true); assert.equal(plain.changed, false);
  p.setData({ dirty: false, referenceChanged: true }); const changed = await p.referenceRequestClose(); assert.equal(changed.allowed, true); assert.equal(changed.changed, true);
});

test('close confirmation is deduplicated and a hide invalidates its old consent to close', async () => {
  const env = environment(), modal = gate(); env.confirmation(() => modal.promise);
  const p = instance(env.referenceComponent(env.defineReferencePage({ data: { dirty: true } }), { isDirty: data => data.dirty }));
  await p.attach(); const first = p.referenceRequestClose(), second = p.referenceRequestClose(); assert.equal(first, second);
  p.hide(); await p.show(); modal.release(true); assert.equal((await first).allowed, false); assert.equal(env.effects.filter(x => x === 'confirm').length, 1);
});

function overlay() {
  let definition; const file = path.join(root, 'components/reference-overlay/index.ts');
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { Component: value => { definition = value; } });
  return definition;
}
test('overlay maps original section/level options, remounts changed routes and ignores old close confirmation results', async () => {
  const definition = overlay(), host = instance(definition, { kind: 'core', params: {} }); await host.attach();
  assert.equal(host.data.isSheet, true); assert.equal(host.data.mounts[0].params.section, 'core'); const firstKey = host.data.mounts[0].key;
  const modal = gate(); host.selectComponent = () => ({ referenceRequestClose: () => modal.promise }); const closing = host.requestClose();
  host.properties = { kind: 'skills', params: { level: 'advanced' } }; definition.observers['kind, params'].call(host);
  assert.equal(host.data.isSheet, false); assert.equal(host.data.mounts[0].params.level, 'advanced'); assert.notEqual(host.data.mounts[0].key, firstKey);
  modal.release({ allowed: true, changed: true }); await closing; assert.equal(host.events.length, 0);
  host.properties = { kind: 'rules', params: { section: 'private' } }; host.syncPanel(); assert.equal(host.data.mounts[0].params.section, 'points');
  host.selectComponent = () => ({ referenceRequestClose: async () => ({ allowed: true, changed: false }) }); await host.requestClose();
  assert.equal(host.events[0].name, 'close'); assert.equal(host.events[0].detail.changed, false, 'closing unchanged content cannot ask the profile to reload');
});
