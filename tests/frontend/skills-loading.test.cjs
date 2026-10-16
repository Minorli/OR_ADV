const { freshPageModule } = require('./native-harness.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const app = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(app, 'services/api.js'), mediaPath = path.join(app, 'services/member-media.js');
const skillsPath = path.join(app, 'pages/skills/index.js');
const DRAFTS_KEY = 'oradv-member-media-drafts-v1';
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function skills() {
  let definition; global.Page = value => { definition = value; };
  freshPageModule(skillsPath);
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
  const module = require.cache[require.resolve(apiPath)]; let intercept, identityError, identityResult;
  module.exports = { ...real,
    async currentMember() { calls.push('identity.me'); if (identityError) throw identityError; return identityResult ? identityResult(await real.currentMember()) : real.currentMember(); },
    async call(action, ...args) { calls.push(action); return intercept ? intercept(action, args, real) : real.call(action, ...args); },
  };
  delete require.cache[require.resolve(mediaPath)];
  return { api: real, calls, storage, setIntercept(value) { intercept = value; }, failIdentity(value) { identityError = value; },
    mapIdentity(value) { identityResult = value; }, media: () => require(mediaPath),
    restore() { module.exports = real; delete require.cache[require.resolve(mediaPath)]; } };
}

test('skill catalog cold and idle foreground loads use one fresh identity without redundant empty-draft requests', async () => {
  for (const role of ['guest', 'member']) {
    const env = await environment(role);
    try {
      const page = skills(); await page.resume();
      assert.equal(page.data.error, ''); assert.equal(page.data.loading, false);
      assert.deepEqual(env.calls, role === 'guest' ? ['identity.me'] : ['identity.me', 'skills.mine']);
      assert.equal(page.data.items.length, role === 'guest' ? 0 : 12);
      env.calls.length = 0; await page.resume();
      assert.deepEqual(env.calls, role === 'guest' ? ['identity.me'] : ['identity.me', 'skills.mine'], 'each new foreground verifies identity freshly');
    } finally { env.restore(); }
  }
});

test('foreground checks preserve an active skill form and clear owner state after permission changes', async () => {
  const env = await environment('owner');
  try {
    const page = skills(); await page.resume();
    page.open({ currentTarget: { dataset: { id: 'basic-posture' } } });
    page.setData({ busy: true, note: '尚未提交的私人说明', referenceReason: '私人核对记录', referenceEditor: true });
    env.calls.length = 0; await page.resume();
    assert.deepEqual(env.calls, ['identity.me']); assert.equal(page.data.note, '尚未提交的私人说明'); assert.equal(page.data.busy, true);
    env.mapIdentity(member => ({ ...member, roles: [] }));
    await page.resume();
    assert.equal(page.data.isOwner, false); assert.equal(page.data.selected, null); assert.equal(page.data.busy, false);
    assert.equal(page.data.note, ''); assert.equal(page.data.referenceReason, ''); assert.equal(page.data.referenceEditor, false);
    assert.deepEqual(page.data.queue, []); assert.equal(page.data.reviewVideoUrl, '');
  } finally { env.restore(); }
});

test('late skill responses cannot replace another member or unload generation', async () => {
  for (const change of ['member', 'unload']) {
    const env = await environment('member'), release = gate(), started = gate();
    env.setIntercept(async (action, args, real) => {
      const role = real.mockRole(), result = await real.call(action, ...args);
      if (action === 'skills.mine' && role === 'member') { started.release(); await release.promise; result.items[0].submission = { note: '上一身份的私人记录' }; }
      return result;
    });
    const page = skills(), pending = page.resume();
    try {
      await started.promise;
      if (change === 'member') { env.api.switchMockRole('founder'); await page.resume(); }
      else page.onUnload();
      const currentId = page.data.member?.id; release.release(); await pending;
      assert.equal(page.data.member?.id, currentId);
      assert(!page.data.items.some(item => item.submission?.note === '上一身份的私人记录'));
      if (change === 'member') assert.equal(page.data.member.memberKind, 'founder');
      else assert.equal(page.data.member, null);
    } finally { release.release(); env.restore(); }
  }
});

test('identity and catalog failures clear private skill drafts instead of retaining a previous verified screen', async () => {
  for (const failed of ['identity.me', 'skills.mine']) {
    const env = await environment('member');
    try {
      const page = skills(); await page.resume();
      page.open({ currentTarget: { dataset: { id: 'basic-posture' } } });
      page.setData({ note: '私人未提交说明', previewUrl: 'private-file', assetId: 'private-asset', historyVideoUrl: 'private-history', reviewVideoUrl: 'private-review' });
      if (failed === 'identity.me') env.failIdentity(new env.api.ApiError('NETWORK', '身份暂时无法核对'));
      else env.setIntercept((action, args, real) => action === 'skills.mine' ? Promise.reject(new real.ApiError('FORBIDDEN', '账号当前不可使用')) : real.call(action, ...args));
      await page.load();
      assert.equal(page.data.member, null); assert.deepEqual(page.data.items, []); assert.equal(page.data.note, '');
      assert.equal(page.data.selected, null); assert.equal(page.data.previewUrl, ''); assert.equal(page.data.assetId, '');
      assert.equal(page.data.historyVideoUrl, ''); assert.equal(page.data.reviewVideoUrl, ''); assert(page.data.error);
    } finally { env.restore(); }
  }
});

test('local media draft empty fast path skips identity only without scoped candidates; populated drafts remain member isolated', async () => {
  const env = await environment('member');
  try {
    const media = env.media();
    assert.deepEqual(await media.memberMediaDrafts(), []); assert.deepEqual(env.calls, []);
    const member = await env.api.currentMember();
    const draft = { id: 'local-private-draft', memberId: member.id, purpose: 'skill', kind: 'video', label: '本人练习', localPath: '/user-data/private-video', scope: 'mock', createdAt: new Date().toISOString() };
    env.storage.set(DRAFTS_KEY, [draft]);
    assert.deepEqual(await media.memberMediaDrafts(), [draft]); assert.deepEqual(env.calls, ['identity.me']);
    env.api.switchMockRole('founder'); assert.deepEqual(await media.memberMediaDrafts(), []);
    assert.deepEqual(env.storage.get(DRAFTS_KEY), [draft], 'another identity cannot remove or adopt a draft');
    env.calls.length = 0; env.storage.set(DRAFTS_KEY, [{ ...draft, scope: 'cloud', appId: 'wx1111111111111111', envId: 'cloud-other' }]);
    assert.deepEqual(await media.memberMediaDrafts(), []); assert.deepEqual(env.calls, [], 'a different mode has no scoped candidates');
  } finally { env.restore(); }
});
