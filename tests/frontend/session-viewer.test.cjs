const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '../..');
const compiled = new Map();
async function sourceApi(config, wx, mode = 'cloud') {
  const key = JSON.stringify([config, mode]);
  if (!compiled.has(key)) {
    const result = await esbuild.build({ entryPoints: [path.join(root, 'app/miniprogram/services/api.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', define: { __ORADV_MODE__: JSON.stringify(mode) },
      plugins: [{ name: 'isolated-runtime', setup(build) { build.onLoad({ filter: /runtime-config\.json$/ }, () => ({ contents: JSON.stringify(config), loader: 'json' })); } }] });
    compiled.set(key, result.outputFiles[0].text);
  }
  const module = { exports: {} }; vm.runInNewContext(compiled.get(key), { module, exports: module.exports, require, wx, Buffer, console, setTimeout, clearTimeout }); return module.exports;
}
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function transport(storage = new Map()) {
  const calls = [], member = { id: 'same-real-account', nickname: '真实车友', memberNumber: 7, revision: 4, roles: ['owner'], growthPoints: 62 };
  let beforeReply = async () => {}, failLogin = false;
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key), getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    cloud: { async callFunction({ data }) { calls.push(structuredClone(data)); await beforeReply(data); const guest = data.viewerMode === 'guest';
      if (data.action === 'identity.ensure') return { result: failLogin ? { ok: false, error: { code: 'FORBIDDEN', message: '账户不可用' }, traceId: 'local' } : { ok: true, data: structuredClone(member), traceId: 'local' } };
      if (data.action === 'identity.me') return { result: { ok: true, data: guest ? null : structuredClone(member), traceId: 'local' } };
      if (data.action === 'activity.list') return { result: { ok: true, data: { items: [], nextCursor: null }, traceId: 'local' } };
      return { result: guest ? { ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录' }, traceId: 'local' } : { ok: true, data: { private: 'own-record' }, traceId: 'local' } };
    } } };
  return { wx, storage, calls, member, intercept(fn) { beforeReply = fn; }, failLogin(value) { failLogin = value; } };
}
const config = { mode: 'cloud', appId: 'wx0123456789abcdef', envId: 'viewer-test-a', version: 'offline' };
test('sign out persists only an exact cloud scope, reduces every later read and write, and preserves stored records', async () => {
  const env = transport(); env.storage.set('unrelated-private-draft', { keep: true }); const api = await sourceApi(config, env.wx);
  assert.equal((await api.currentMember()).id, env.member.id); await api.signOut(); assert.equal(await api.currentMember(), null);
  await assert.rejects(api.call('points.mine'), error => error.code === 'UNAUTHENTICATED');
  await assert.rejects(api.call('profile.update', { nickname: '不得保存' }, 4), error => error.code === 'UNAUTHENTICATED');
  assert.equal(env.calls.at(-1).viewerMode, 'guest'); assert.deepEqual(env.storage.get('unrelated-private-draft'), { keep: true });
  const reloaded = await sourceApi(config, env.wx); assert.equal(await reloaded.currentMember(), null, 'restart retains the paused view');
  for (const changed of [{ ...config, envId: 'viewer-test-b' }, { ...config, appId: 'wx1111111111111111' }, { ...config, mode: 'mock' }]) {
    const other = await sourceApi(changed, env.wx); assert.equal((await other.currentMember()).id, env.member.id, 'another AppID/EnvId/mode does not inherit a pause');
  }
});
test('only a successful explicit login restores the same account and a failed login remains restricted', async () => {
  const env = transport(), api = await sourceApi(config, env.wx); await api.signOut(); env.failLogin(true);
  await assert.rejects(api.call('identity.ensure', { consentVersions: { privacy: 1, terms: 1 } }), error => error.code === 'FORBIDDEN'); assert.equal(env.calls.at(-1).viewerMode, undefined); assert.equal(await api.currentMember(), null);
  env.failLogin(false); const restored = await api.call('identity.ensure', { consentVersions: { privacy: 1, terms: 1 } }); assert.equal(restored.id, env.member.id);
  assert.equal((await api.currentMember()).id, env.member.id); assert.equal(env.calls.at(-1).viewerMode, undefined); assert.equal((await sourceApi(config, env.wx)).runtime.envId, config.envId);
});
test('a private response or a login started before sign out cannot restore private state or unpause the session', async () => {
  for (const action of ['points.mine', 'identity.ensure']) {
    const env = transport(), api = await sourceApi(config, env.wx), started = gate(), held = gate();
    env.intercept(async data => { if (data.action === action) { started.release(); await held.promise; } });
    const old = api.call(action, action === 'identity.ensure' ? { consentVersions: { privacy: 1, terms: 1 } } : {}); await started.promise;
    await api.signOut(); held.release(); await assert.rejects(old, error => error.code === 'SESSION_CHANGED');
    env.intercept(async () => {}); assert.equal(await api.currentMember(), null);
  }
});
test('an environment change discards a previously authenticated response', async () => {
  const env = transport(), api = await sourceApi(config, env.wx), started = gate(), held = gate();
  env.intercept(async () => { started.release(); await held.promise; }); const old = api.call('points.mine'); await started.promise;
  api.runtime.envId = 'viewer-test-b'; held.release(); await assert.rejects(old, error => error.code === 'SESSION_CHANGED');
});
