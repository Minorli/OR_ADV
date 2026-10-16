const { freshPageModule } = require('./native-harness.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const app = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(app, 'services/api.js'), mediaPath = path.join(app, 'services/member-media.js');
const learningPath = path.join(app, 'pages/learning/index.js');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function learning() {
  let definition; global.Page = value => { definition = value; };
  freshPageModule(learningPath);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = values => Object.assign(instance.data, values);
  return instance;
}
async function environment(role = 'member') {
  const storage = new Map(), calls = [];
  global.wx = {
    env: { USER_DATA_PATH: '/user-data' },
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    showToast() {}, showModal: async () => ({ confirm: true }), navigateTo() {}, switchTab() {},
    getFileSystemManager: () => ({ unlinkSync() {} }),
  };
  delete require.cache[require.resolve(apiPath)]; delete require.cache[require.resolve(mediaPath)];
  const real = require(apiPath); real.resetMock('empty'); real.switchMockRole(role);
  const module = require.cache[require.resolve(apiPath)]; let intercept, identityError, identityResult, identityWait;
  module.exports = { ...real,
    async currentMember() { calls.push('identity.me'); if (identityWait) await identityWait(); if (identityError) throw identityError; return identityResult ? identityResult(await real.currentMember()) : real.currentMember(); },
    async call(action, ...args) { calls.push(action); return intercept ? intercept(action, args, real) : real.call(action, ...args); },
  };
  return { api: real, calls, setIntercept(value) { intercept = value; }, failIdentity(value) { identityError = value; },
    mapIdentity(value) { identityResult = value; }, waitIdentity(value) { identityWait = value; }, restore() { module.exports = real; } };
}

test('knowledge cold and idle foreground loads use exactly one fresh identity each', async () => {
  for (const role of ['guest', 'member']) {
    const env = await environment(role);
    try {
      const page = learning(); await page.resume();
      assert.equal(page.data.error, ''); assert.equal(page.data.loading, false); assert(page.data.catalog);
      const expected = role === 'guest' ? ['identity.me', 'learning.catalog'] : ['identity.me', 'learning.catalog', 'learning.mine'];
      assert.deepEqual(env.calls.slice().sort(), expected);
      env.calls.length = 0; await page.resume();
      assert.deepEqual(env.calls.slice().sort(), expected, 'foreground revalidates identity without caching or duplicate checks');
    } finally { env.restore(); }
  }
});

test('public curriculum and identity start together before reading the personal practice', async () => {
  const env = await environment(), release = gate(), identityStarted = gate(), catalogStarted = gate();
  env.waitIdentity(async () => { identityStarted.release(); await release.promise; });
  env.setIntercept(async (action, args, real) => { if (action === 'learning.catalog') { catalogStarted.release(); await release.promise; } return real.call(action, ...args); });
  const page = learning(), pending = page.resume();
  try {
    await Promise.all([identityStarted.promise, catalogStarted.promise]);
    assert.deepEqual(env.calls.slice().sort(), ['identity.me', 'learning.catalog']);
  } finally { release.release(); await pending; env.restore(); }
  assert.equal(page.data.error, ''); assert.deepEqual(env.calls.slice().sort(), ['identity.me', 'learning.catalog', 'learning.mine']);
});

test('foreground practice and owner forms retain drafts while fresh checks clear revoked permissions', async () => {
  const env = await environment('owner');
  try {
    const page = learning(); await page.resume();
    const practice = { id: 'saved-attempt', answeredCount: 1, total: 20, question: { id: 'current', prompt: '当前问题', options: ['一', '二', '三', '四'] } };
    page.showPractice(practice); env.calls.length = 0; await page.resume();
    assert.deepEqual(env.calls, ['identity.me']); assert.equal(page.data.practice.id, practice.id);
    page.setData({ practice: null, busy: true, editor: true, draft: { ...page.data.draft, prompt: '尚未提交的题目' }, reason: '私人核对说明' });
    env.calls.length = 0; await page.resume();
    assert.deepEqual(env.calls, ['identity.me']); assert.equal(page.data.draft.prompt, '尚未提交的题目'); assert.equal(page.data.busy, true);
    env.mapIdentity(member => ({ ...member, roles: [] })); await page.resume();
    assert.equal(page.data.isOwner, false); assert.equal(page.data.editor, false); assert.equal(page.data.busy, false);
    assert.equal(page.data.draft.prompt, ''); assert.equal(page.data.reason, ''); assert.equal(page.data.bank, null);
  } finally { env.restore(); }
});

test('late practice responses cannot replace another identity or an unloaded page', async () => {
  for (const change of ['member', 'unload']) {
    const env = await environment(), release = gate(), started = gate();
    env.setIntercept(async (action, args, real) => {
      const role = real.mockRole(), result = await real.call(action, ...args);
      if (action === 'learning.mine' && role === 'member') { started.release(); await release.promise; result.attempt = { id: 'previous-member-private-attempt', answeredCount: 0, total: 20, question: null }; }
      return result;
    });
    const page = learning(), pending = page.resume();
    try {
      await started.promise;
      if (change === 'member') { env.api.switchMockRole('founder'); await page.resume(); }
      else page.onUnload();
      const currentId = page.data.member?.id; release.release(); await pending;
      assert.equal(page.data.member?.id, currentId); assert.equal(page.data.practice, null); assert.equal(page.data.displayQuestion, null);
      if (change === 'member') assert.equal(page.data.member.memberKind, 'founder');
      else assert.equal(page.data.member, null);
    } finally { release.release(); env.restore(); }
  }
});

test('failed foreground identity, public curriculum and personal reads clear private state and expose the error', async () => {
  for (const failed of ['identity.me', 'learning.catalog', 'learning.mine', 'foreground.identity.me']) {
    const env = await environment('owner');
    try {
      const page = learning(); await page.resume();
      page.setData({ editor: true, busy: true, bank: { questions: [{ prompt: '私人题库草稿' }] }, draft: { ...page.data.draft, prompt: '未提交的私人题目' }, reason: '私人说明' });
      if (failed.endsWith('identity.me')) env.failIdentity(new env.api.ApiError('NETWORK', '身份暂时无法核对'));
      else env.setIntercept((action, args, real) => action === failed ? Promise.reject(new real.ApiError('NETWORK', `${failed} unavailable`)) : real.call(action, ...args));
      if (failed === 'foreground.identity.me') await page.resume(); else await page.load();
      assert.equal(page.data.member, null); assert.equal(page.data.practice, null); assert.equal(page.data.displayQuestion, null);
      assert.equal(page.data.bank, null); assert.deepEqual(page.data.questionLabels, []); assert.equal(page.data.draft.prompt, '');
      assert.equal(page.data.reason, ''); assert.equal(page.data.editor, false); assert.equal(page.data.isOwner, false);
      assert.equal(page.data.busy, false); assert.equal(page.data.loading, false); assert(page.data.error);
    } finally { env.restore(); }
  }
});
