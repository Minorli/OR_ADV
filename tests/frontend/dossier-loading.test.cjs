const { freshPageModule } = require('./native-harness.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const app = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(app, 'services/api.js'), mediaPath = path.join(app, 'services/member-media.js');
const dossierPath = path.join(app, 'pages/dossier/index.js');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function dossier(mode = 'own', memberId = '') {
  let definition; global.Page = value => { definition = value; };
  freshPageModule(dossierPath);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = values => Object.assign(instance.data, values); instance.onLoad({ mode, memberId });
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
  delete require.cache[require.resolve(mediaPath)];
  return { api: real, calls, setIntercept(value) { intercept = value; }, failIdentity(value) { identityError = value; },
    mapIdentity(value) { identityResult = value; }, waitIdentity(value) { identityWait = value; }, restore() { module.exports = real; delete require.cache[require.resolve(mediaPath)]; } };
}
function privateDraft(page, extra = {}) {
  page.renderDraft({ ...page.data.draft, riderName: '私人称呼', contactValue: 'private-contact' },
    { urls: { private: 'private-photo' }, queue: [{ memberId: 'private-member', nickname: '私人待审成员' }], pendingUploads: [{ draftId: 'private-draft' }], ...extra });
}
function assertPrivateCleared(page) {
  assert.equal(page.data.dossier, null); assert.equal(page.data.viewerId, ''); assert.equal(page.data.draft.riderName, '');
  assert.equal(page.data.draft.contactValue, ''); assert.deepEqual(page.data.urls, {}); assert.deepEqual(page.data.queue, []);
  assert.deepEqual(page.data.pendingUploads, []); assert.equal(page.data.reviewReason, '');
}

test('dossier own and queue initial and clean foregrounds use one fresh identity each', async () => {
  for (const [role, mode, action] of [['member', 'own', 'dossier.mine'], ['owner', 'queue', 'staff.dossier.list'], ['guest', 'own', null]]) {
    const env = await environment(role);
    try {
      const page = dossier(mode);
      for (let visit = 0; visit < 2; visit++) {
        env.calls.length = 0; await page.resume();
        assert.deepEqual(env.calls, action ? ['identity.me', action] : ['identity.me']);
        assert.equal(page.data.mode, mode); assert.equal(page.data.loading, false);
        if (action) assert.equal(page.data.error, ''); else assert(page.data.error.includes('身份'));
      }
    } finally { env.restore(); }
  }
});

test('a clean foreground hides old private dossier contents while awaiting fresh identity', async () => {
  for (const mode of ['own', 'queue']) {
    const env = await environment(mode === 'queue' ? 'owner' : 'member'), release = gate(), started = gate();
    const page = dossier(mode);
    try {
      await page.resume(); privateDraft(page);
      env.waitIdentity(async () => { started.release(); await release.promise; });
      const pending = page.resume();
      try { await started.promise; assertPrivateCleared(page); assert.equal(page.data.mode, mode); }
      finally { release.release(); await pending; }
      assert.equal(page.data.error, '');
    } finally { release.release(); env.restore(); }
  }
});

test('dirty, saving and uploading foregrounds keep same-member edits under a fresh identity check', async () => {
  for (const flag of ['dirty', 'saving', 'uploading']) {
    const env = await environment();
    try {
      const page = dossier(); await page.resume(); const viewerId = page.data.viewerId;
      privateDraft(page, { [flag]: true }); env.calls.length = 0; await page.resume();
      assert.deepEqual(env.calls, ['identity.me']); assert.equal(page.data.viewerId, viewerId);
      assert.equal(page.data.draft.riderName, '私人称呼'); assert.equal(page.data.draft.contactValue, 'private-contact'); assert.equal(page.data[flag], true);
      env.api.switchMockRole('founder'); await page.resume();
      assert.notEqual(page.data.viewerId, viewerId); assert.equal(page.data.draft.riderName, ''); assert.equal(page.data.draft.contactValue, '');
      assert.equal(page.data.dirty, false); assert.equal(page.data.saving, false); assert.equal(page.data.uploading, false);
      assert.deepEqual(page.data.urls, {}); assert.deepEqual(page.data.pendingUploads, []);
    } finally { env.restore(); }
  }
});

test('late private dossier responses cannot overwrite another member or revive an unloaded page', async () => {
  for (const change of ['member', 'unload']) {
    const env = await environment(), release = gate(), started = gate();
    env.setIntercept(async (action, args, real) => {
      const role = real.mockRole(), result = await real.call(action, ...args);
      if (action === 'dossier.mine' && role === 'member') { started.release(); await release.promise; result.draft.riderName = '上一身份的私人称呼'; }
      return result;
    });
    const page = dossier(), pending = page.resume();
    try {
      await started.promise;
      if (change === 'member') { env.api.switchMockRole('founder'); await page.resume(); }
      else page.onUnload();
      const viewerId = page.data.viewerId; release.release(); await pending;
      assert.equal(page.data.viewerId, viewerId); assert.notEqual(page.data.draft.riderName, '上一身份的私人称呼');
      if (change === 'unload') assertPrivateCleared(page);
    } finally { release.release(); env.restore(); }
  }
});

test('identity, dossier and staff failures clear old private state while showing a useful error', async () => {
  for (const failed of ['identity.me', 'dossier.mine', 'staff.dossier.list', 'owner-role']) {
    const staff = ['staff.dossier.list', 'owner-role'].includes(failed), env = await environment(staff ? 'owner' : 'member');
    try {
      const page = dossier(staff ? 'queue' : 'own'); await page.resume(); privateDraft(page, { dirty: true, reviewReason: '私人复核意见' });
      if (failed === 'identity.me') env.failIdentity(new env.api.ApiError('NETWORK', '身份暂时无法核对'));
      else if (failed === 'owner-role') env.mapIdentity(member => ({ ...member, roles: [] }));
      else env.setIntercept((action, args, real) => action === failed ? Promise.reject(new real.ApiError('NETWORK', `${failed} unavailable`)) : real.call(action, ...args));
      if (['identity.me', 'owner-role'].includes(failed)) await page.resume(); else await page.load();
      assertPrivateCleared(page); assert(page.data.error); assert.equal(page.data.loading, false);
      assert.equal(page.data.mode, staff ? 'queue' : 'own');
    } finally { env.restore(); }
  }
});

test('staff dossier pagination keeps existing rows and cursor while rechecking identity', async () => {
  const env = await environment('owner'), seen = [];
  env.setIntercept(async (action, args, real) => {
    if (action !== 'staff.dossier.list') return real.call(action, ...args);
    seen.push(args[0]); return { items: [{ memberId: seen.length === 1 ? 'first' : 'second' }], nextCursor: seen.length === 1 ? 'next-page' : null };
  });
  try {
    const page = dossier('queue'); await page.resume(); env.calls.length = 0; await page.load(true);
    assert.deepEqual(env.calls, ['identity.me', 'staff.dossier.list']); assert.deepEqual(seen, [{}, { cursor: 'next-page' }]);
    assert.deepEqual(page.data.queue.map(row => row.memberId), ['first', 'second']); assert.equal(page.data.nextCursor, null);
  } finally { env.restore(); }
});
