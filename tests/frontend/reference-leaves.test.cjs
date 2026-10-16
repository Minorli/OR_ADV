const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const app = path.resolve(__dirname, '../../app/miniprogram');
const names = ['activity/detail', 'dossier/index', 'learning/index', 'skills/index', 'club-content/index', 'history-detail/index', 'redemption/index'];
const who = () => ({ id: 'rider-one', nickname: '车友', clubId: 'oradv', roles: [], memberKind: 'regular', memberNumber: 7, growthPoints: 62, annualPoints: 20, revision: 1 });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function environment() {
  let member = who(), role = 'member', definition, responder = async action => { throw Error('unexpected RPC ' + action); }, imageResult = { assetId: 'own-image', previewUrl: '/own-image' };
  const calls = [], uploads = [], effects = [], modules = new Map();
  class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const api = { ApiError, isMock: true, runtime: { mode: 'mock', appId: 'local-only', envId: 'local-test', version: 'local' }, mockRole: () => role,
    currentMember: async () => member, call: async (action, payload, revision) => { calls.push({ action, payload, revision }); return responder(action, payload, revision); },
    errorMessage: error => error.message, toast: text => effects.push(text), confirm: async () => true };
  const media = { MemberMediaError: class extends Error {}, hasMemberMediaDrafts: () => false, memberMediaDrafts: async () => [],
    chooseAndUploadMemberImage: async (...args) => { uploads.push(args); if (imageResult instanceof Error) throw imageResult; return imageResult; }, resolveMemberMedia: async () => ({ url: '/own-image' }) };
  const wx = { getStorageSync() {}, setStorageSync() {}, removeStorageSync() {}, navigateBack: value => effects.push({ back: value }), navigateTo: value => effects.push(value), switchTab: value => effects.push(value), previewImage: value => effects.push(value) };
  function load(file) {
    if (file === path.join(app, 'services/api.ts')) return api;
    if (file === path.join(app, 'services/member-media.ts')) return media;
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, wx, Page: value => { definition = value; }, console, setTimeout, clearTimeout,
      require(specifier) { if (!specifier.startsWith('.')) return require(specifier); const base = path.resolve(path.dirname(file), specifier); const resolved = [base, base + '.ts', base + '.json'].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()); assert(resolved, specifier); return resolved.endsWith('.json') ? JSON.parse(fs.readFileSync(resolved, 'utf8')) : load(resolved); } }, { filename: file });
    return module.exports;
  }
  function page(name) {
    definition = null; load(path.join(app, 'pages', name + '.ts')); assert(definition, name);
    const p = { ...definition, data: structuredClone(definition.data) };
    p.setData = values => { for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let target = p.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value; } };
    return p;
  }
  return { api, calls, uploads, effects, page, respond(fn) { responder = fn; }, identity(value, nextRole = role) { member = value; role = nextRole; }, image(value) { imageResult = value; } };
}
function dossier(env) {
  const p = env.page('dossier/index');
  p.setData({ mode: 'own', viewerId: 'rider-one', loadedRole: 'member', dossier: { revision: 1, status: 'draft' } });
  p.addBike(); return p;
}
const event = dataset => ({ currentTarget: { dataset } });
test('all seven leaves preserve native routes, embedded close dispatch and standalone back navigation', () => {
  for (const name of names) {
    const env = environment(), p = env.page(name), emitted = [];
    assert.equal(p.data.embedded, false, name); p.referenceClose(); assert.equal(env.effects.at(-1).back.delta, 1);
    p.setData({ embedded: true }); p.triggerEvent = (type, detail) => emitted.push({ type, detail }); p.referenceClose();
    assert.equal(emitted.at(-1).type, 'requestclose'); assert.equal(emitted.at(-1).detail.changed, false);
    p.setData({ referenceChanged: true }); p.referenceClose(); assert.equal(emitted.at(-1).detail.changed, true);
  }
});
test('leaf markup keeps canonical internal structure and native bindings without enabling sensitive dossier inputs', () => {
  for (const name of names) {
    const markup = fs.readFileSync(path.join(app, 'pages', name + '.wxml'), 'utf8');
    const sanitized = markup.replace(/\{\{[\s\S]*?\}\}/g, 'BINDING'), stack = [];
    for (const match of sanitized.matchAll(/<(\/?)([\w-]+)(?:\s+[^<>]*?)?\s*(\/?)>/g)) { const [, closing, tag, selfClose] = match; if (closing) assert.equal(stack.pop(), tag, name + ': balanced native markup'); else if (!selfClose) stack.push(tag); }
    assert.equal(stack.length, 0, name + ': closed native markup');
    assert.match(markup, /class="page reference-v2/); assert.match(markup, /embedded \? 'is-embedded'/); assert.match(markup, /v2-(?:sheet|modal)-content/); assert.match(markup, /bindtap="referenceClose"/); assert.doesNotMatch(markup, /<(?:h[1-6]|p|b|i|span|a|em|svg)\b/);
  }
  const markup = fs.readFileSync(path.join(app, 'pages/dossier/index.wxml'), 'utf8');
  for (const text of ['一、个人基础信息', '二、全套护具照片', '三、车辆信息', '四、轮胎状态', '血型', '身份证号', '驾驶证照片', '摩托车行驶证', '既往病史 / 过敏史', '队服尺码']) assert(markup.includes(text), text);
  assert.doesNotMatch(markup, /data-field="(?:blood|idno|lic|ins|med|age|size)"/);
  const history = fs.readFileSync(path.join(app, 'pages/history-detail/index.wxml'), 'utf8');
  assert(history.indexOf('class="honor"') < history.indexOf('class="photo-row"')); assert(history.indexOf('class="photo-row"') < history.indexOf('class="video-card')); assert(history.indexOf('class="video-card') < history.indexOf('class="review"'));
});
test('dossier album and camera selections reach the real upload boundary and bind only the chosen bike slot', async () => {
  for (const source of ['album', 'camera']) {
    const env = environment(), p = dossier(env), id = p.data.draft.bikes[0].id;
    await p.openUpload(event({ bikeId: id, part: 'tireAssetId' })); assert.equal(p.data.uploadTarget.label, '轮胎状态');
    await p.uploadFrom(event({ source })); assert.equal(p.data.uploadTarget, null); assert.equal(env.uploads.length, 1);
    assert.equal(env.uploads[0][0], 'dossier'); assert.equal(env.uploads[0][2], false); assert.deepEqual(Array.from(env.uploads[0][3]), [source]);
    assert.equal(p.data.draft.bikes[0].tireAssetId, 'own-image'); assert.equal(p.data.draft.bikes[0].photoAssetId, null); assert.equal(p.data.dirty, true);
  }
});
test('dossier rejects forged targets, changed viewers and failed uploads without inventing a saved photograph', async () => {
  const env = environment(), p = dossier(env);
  await p.openUpload(event({ gear: 'blood' })); await p.openUpload(event({ bikeId: 'other-bike', part: 'photoAssetId' })); assert.equal(p.data.uploadTarget, null); assert.equal(env.uploads.length, 0);
  await p.openUpload(event({ gear: 'helmet' })); env.identity(who(), 'founder'); await p.uploadFrom(event({ source: 'camera' })); assert.equal(env.uploads.length, 0); assert.equal(p.data.uploadTarget, null);
  env.identity(who(), 'member'); env.image(new Error('照片暂时无法上传')); await p.openUpload(event({ gear: 'helmet' })); await p.uploadFrom(event({ source: 'album' })); assert.equal(p.data.draft.gear.helmet, null); assert.match(p.data.error, /无法上传/); assert.equal(p.data.uploading, false);
  for (const field of ['blood', 'idno', 'med', 'size']) p.field({ currentTarget: { dataset: { field } }, detail: { value: '不应保存' } });
  for (const field of ['blood', 'idno', 'med', 'size']) assert.equal(Object.hasOwn(p.data.draft, field), false);
});
test('late dossier target verification cannot reopen an upload selector after unload', async () => {
  const env = environment(), p = dossier(env), held = gate(); env.api.currentMember = async () => { await held.promise; return who(); };
  const pending = p.openUpload(event({ gear: 'helmet' })); p.load = async () => {}; p.onUnload(); held.release(); await pending;
  assert.equal(p.data.uploadTarget, null); assert.equal(p.data.dossier, null); assert.equal(env.uploads.length, 0);
});
test('successful knowledge answers retain server feedback and mark the embedded view changed only after fresh verification', async () => {
  const env = environment(), p = env.page('learning/index'); p.setData({ embedded: true, loadedEnvironment: JSON.stringify(['mock', 'local-only', 'local-test']), member: who(), loadedRole: 'member', isOwner: false, canManageContent: false });
  const initial = { id: 'attempt', revision: 1, answeredCount: 0, total: 20, status: 'active', question: { id: 'question-one', prompt: '核对现场条件', options: ['一', '二', '三', '四'] } };
  p.showPractice(initial); p.select(event({ index: 2 })); env.respond(async action => { assert.equal(action, 'learning.answer'); return { ...initial, revision: 2, answeredCount: 1, feedback: { correct: false, rightIndex: 1, explanation: '以指导人员核定为准' } }; });
  await p.answer(); assert.equal(p.data.feedback.rightText, '二'); assert.equal(p.data.feedback.correct, false); assert.equal(p.data.progress, 5); assert.equal(p.data.referenceChanged, true); assert.equal(env.calls[0].payload.selectedIndex, 2);
  const second = environment(), q = second.page('learning/index'); q.setData({ embedded: true, loadedEnvironment: JSON.stringify(['mock', 'local-only', 'local-test']), member: who(), loadedRole: 'member' }); q.showPractice(initial); q.select(event({ index: 0 })); second.respond(async () => { throw new second.api.ApiError('NETWORK', '答案尚未保存'); }); await q.answer(); assert.equal(q.data.referenceChanged, undefined); assert.equal(q.data.feedback, null); assert.equal(q.data.error, '答案尚未保存');
});
test('core presentation fields remain immutable editable content and rule grouping preserves every published block', () => {
  const env = environment(), p = env.page('club-content/index'); p.setData({ section: 'core', mode: 'manage', canManageContent: true, identityReady: true, loadedRole: 'member', loadedEnvironment: JSON.stringify(['mock', 'local-only', 'local-test']), draft: { people: [{ name: '公开称呼', duty: '领队', introduction: '', responsibilities: [] }] } });
  const before = p.data.draft; p.personField({ currentTarget: { dataset: { index: 0, field: 'distanceKm' } }, detail: { value: '1200' } }); assert.equal(p.data.draft.people[0].distanceKm, 1200); assert.notEqual(p.data.draft, before); assert.equal(before.people[0].distanceKm, undefined);
  p.personField({ currentTarget: { dataset: { index: 0, field: 'roles' } }, detail: { value: 'owner' } }); assert.equal(p.data.draft.people[0].roles, undefined);
  const rows = p.ruleSections({ blocks: [{ heading: '积分获取', body: '实际结算记录' }, { heading: '兑换规则', body: '先预留再交付' }, { heading: '补充说明', body: '这段也必须保留' }] }); assert.equal(rows.length, 5); assert.equal(rows[0].body, '实际结算记录'); assert.equal(rows[3].body, '先预留再交付'); assert.equal(rows[4].body, '这段也必须保留');
});
test('wallet refresh notifications ignore stale fences and emit change only for an acknowledged mutation', async () => {
  const env = environment(), p = env.page('redemption/index'); p.setData({ embedded: true, member: who(), loadedRole: 'member', loadedEnvironment: JSON.stringify(['mock', 'local-only', 'local-test']), identityReady: true });
  const fence = p.fence(); p.load = async () => p.setData({ version: p.data.version + 1 }); await p.reloadAfter(fence, '已保存'); assert.equal(p.data.referenceChanged, true); assert.equal(p.data.notice, '已保存');
  p.setData({ referenceChanged: false }); p.onHide(); await p.reloadAfter(fence, '旧页面结果'); assert.equal(p.data.referenceChanged, false); assert.notEqual(p.data.notice, '旧页面结果');
});

test('embedded safety opens the first real question once while existing, completed, unavailable and guest views never create attempts', async () => {
  const existing = { id: 'saved-attempt', revision: 3, status: 'active', answeredCount: 4, total: 20, question: { id: 'q5', prompt: '继续已保存的第五题', options: ['一', '二', '三', '四'] } };
  for (const state of ['new', 'active', 'completed', 'unpublished', 'guest', 'standalone']) {
    const env = environment(), p = env.page('learning/index'); p.setData({ embedded: state !== 'standalone' }); if (state === 'guest') env.identity(null, 'guest');
    env.respond(async action => {
      if (action === 'learning.catalog') return { configured: state !== 'unpublished', title: '已核定题库' };
      if (action === 'learning.mine') return { attempt: state === 'active' ? existing : state === 'completed' ? { ...existing, status: 'completed', question: null } : null };
      if (action === 'learning.start') return { ...existing, id: 'new-attempt', answeredCount: 0 };
      throw Error(action);
    });
    await p.load(); assert.equal(p.data.error, ''); assert.equal(env.calls.filter(row => row.action === 'learning.start').length, state === 'new' ? 1 : 0, state);
    if (state === 'new') { assert.equal(p.data.displayQuestion.id, 'q5'); await p.load(); assert.equal(env.calls.filter(row => row.action === 'learning.start').length, 1); }
    if (state === 'active') assert.equal(p.data.practice.id, 'saved-attempt');
    if (state === 'completed') assert.equal(p.data.practice.status, 'completed');
  }
});
test('failed automatic start preserves a single attempt intent and stale cross-environment reads cannot create attempts', async () => {
  const env = environment(), p = env.page('learning/index'); p.setData({ embedded: true });
  env.respond(async action => { if (action === 'learning.catalog') return { configured: true }; if (action === 'learning.mine') return { attempt: null }; if (action === 'learning.start') throw new env.api.ApiError('NETWORK', '开练结果尚待核对'); throw Error(action); });
  await p.load(); assert.equal(p.data.autoStartAttempted, true); assert.equal(p.data.error, '开练结果尚待核对'); await p.load(); assert.equal(env.calls.filter(row => row.action === 'learning.start').length, 1); assert.equal(p.data.referenceChanged, undefined);
  const second = environment(), q = second.page('learning/index'), held = gate(); q.setData({ embedded: true }); second.respond(async action => { if (action === 'learning.catalog') { await held.promise; return { configured: true }; } if (action === 'learning.mine') return { attempt: null }; throw Error('must not start across environments: ' + action); });
  const pending = q.load(); second.api.runtime.envId = 'other-env'; held.release(); await pending; assert.equal(second.calls.filter(row => row.action === 'learning.start').length, 0); assert.equal(q.data.member, null);
});

test('partial contact content keeps technician, rescue and joining sections and every real contact action', () => {
  const env = environment(), p = env.page('club-content/index');
  const row = (label, method) => ({ label, method, name: '', value: '已核定联系信息', hours: '', note: '', action: '联系' });
  const input = [row('俱乐部主要联系', 'wechat'), row('工作室地址', 'address'), row('紧急救援', 'phone'), row('商务洽谈', 'wechat')];
  const groups = p.groupContacts(input); assert.deepEqual(Array.from(groups, group => group.title), ['核心技师', '紧急救援', '客服与入队', '其他联系']);
  assert.equal(groups[0].items[0].index, 1); assert.equal(groups[1].items[0].index, 2); assert.equal(groups[2].items[0].index, 0); assert.equal(groups[3].items[0].index, 3);
  const partial = p.groupContacts([input[0]]); assert.equal(partial.length, 3); assert.equal(partial[0].items.length, 0); assert.equal(partial[1].items.length, 0); assert.equal(partial[2].items.length, 1); assert.equal(input[0].index, undefined);
});
