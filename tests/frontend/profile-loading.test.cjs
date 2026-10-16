const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(root, 'services/api.js'), profilePath = path.join(root, 'pages/profile/index.js');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function profile() {
  let definition; global.Page = value => { definition = value; };
  delete require.cache[require.resolve(profilePath)]; require(profilePath);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = (values, callback) => { Object.assign(instance.data, values); callback?.(); };
  return instance;
}
async function environment(role = 'member', avatar = false) {
  const storage = new Map(), files = new Map(), directories = new Set(['/user-data']), calls = [];
  const absent = () => new Error('ENOENT: file does not exist');
  global.wx = {
    env: { USER_DATA_PATH: '/user-data' },
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    showToast() {}, showModal: async () => ({ confirm: true }), navigateTo() {}, switchTab() {}, pageScrollTo() {},
    getFileSystemManager: () => ({ accessSync(file) { if (!files.has(file) && !directories.has(file)) throw absent(); },
      mkdirSync(dir) { directories.add(dir); }, writeFileSync(file, bytes) { files.set(file, bytes); }, unlinkSync(file) { if (!files.delete(file)) throw absent(); } }),
  };
  delete require.cache[require.resolve(apiPath)]; delete require.cache[require.resolve(path.join(root, 'services/member-media.js'))];
  const real = require(apiPath); real.resetMock('empty'); real.switchMockRole(role);
  if (avatar) { const member = await real.currentMember(); await real.call('profile.avatar.save', { imageBase64: PNG }, member.revision); }
  const module = require.cache[require.resolve(apiPath)]; let intercept, identityError;
  module.exports = { ...real,
    async currentMember() { calls.push('identity.me'); if (identityError) throw identityError; return real.currentMember(); },
    async call(action, ...args) { calls.push(action); return intercept ? intercept(action, args, real) : real.call(action, ...args); },
  };
  return { api: real, calls, files, setIntercept(value) { intercept = value; }, failIdentity(value) { identityError = value; }, restore() { module.exports = real; } };
}

test('ordinary profile foreground loads use exactly one fresh identity read without caching it across visits', async () => {
  for (const role of ['guest', 'member']) {
    const env = await environment(role);
    try {
      const page = profile(); await page.resume();
      assert.equal(page.data.error, '');
      assert.deepEqual(env.calls.sort(), role === 'guest' ? ['club.public', 'identity.me'] : ['club.public', 'dossier.mine', 'identity.me']);
      env.calls.length = 0; await page.resume();
      assert.equal(env.calls.filter(action => action === 'identity.me').length, 1, 'another foreground always revalidates identity');
    } finally { env.restore(); }
  }
});

test('cold avatar and dossier fetches start in parallel under one verified load generation', async () => {
  const env = await environment('member', true), release = gate(), avatarStarted = gate(), started = new Set();
  env.setIntercept(async (action, args, real) => {
    const result = await real.call(action, ...args);
    if (['profile.avatar.get', 'dossier.mine'].includes(action)) { started.add(action); if (action === 'profile.avatar.get') avatarStarted.release(); await release.promise; }
    return result;
  });
  const page = profile(), pending = page.resume();
  try {
    await avatarStarted.promise; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...started].sort(), ['dossier.mine', 'profile.avatar.get'], 'neither private request waits for the other response');
  } finally { release.release(); await pending; env.restore(); }
  assert.equal(page.data.error, ''); assert(page.data.avatarUrl); assert.equal(page.data.dossierError, '');
  assert.deepEqual(env.calls.sort(), ['club.public', 'dossier.mine', 'identity.me', 'profile.avatar.get']);
});

test('pending public contact cannot delay private reads or clearing a failed identity', async () => {
  const env = await environment('member', true), contact = gate();
  env.setIntercept(async (action, args, real) => {
    if (action === 'club.public') await contact.promise;
    return real.call(action, ...args);
  });
  const page = profile(), pending = page.resume();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert(page.data.avatarUrl, 'avatar loads while the optional contact request is still pending');
    assert.equal(page.data.dossierLoading, false); assert.equal(page.data.identityVerified, true);
    assert(env.calls.includes('dossier.mine'));
  } finally { contact.release(); await pending; }
  const secondContact = gate();
  env.setIntercept(async (action, args, real) => { if (action === 'club.public') await secondContact.promise; return real.call(action, ...args); });
  env.failIdentity(new env.api.ApiError('NETWORK', 'identity unavailable'));
  page.setData({ avatarBase64: 'private-unsaved-image', avatarDraftUrl: 'private-unsaved-file', showEdit: true });
  const failed = page.resume();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.member, null); assert.equal(page.data.avatarBase64, ''); assert.equal(page.data.avatarUrl, '');
    assert.equal(page.data.identityVerified, false); assert(page.data.error.includes('identity unavailable'));
  } finally { secondContact.release(); await failed; env.restore(); }
});

test('contact, avatar and dossier failures stay independent while identity failure clears private drafts', async () => {
  for (const failed of ['club.public', 'profile.avatar.get', 'dossier.mine']) {
    const env = await environment('member', true);
    env.setIntercept((action, args, real) => action === failed ? Promise.reject(new real.ApiError('NETWORK', `${failed} unavailable`)) : real.call(action, ...args));
    try {
      const page = profile(); await page.resume(); assert(page.data.member);
      if (failed === 'club.public') { assert(page.data.error.includes('unavailable')); assert(page.data.avatarUrl); assert.equal(page.data.dossierError, ''); }
      if (failed === 'profile.avatar.get') { assert(page.data.avatarError.includes('unavailable')); assert.equal(page.data.dossierError, ''); assert.equal(page.data.error, ''); }
      if (failed === 'dossier.mine') { assert(page.data.dossierError.includes('unavailable')); assert(page.data.avatarUrl); assert.equal(page.data.avatarError, ''); }
      env.failIdentity(new env.api.ApiError('NETWORK', 'identity unavailable'));
      page.setData({ avatarBase64: 'private-unsaved-image', avatarDraftUrl: 'private-unsaved-file', nickname: '未保存的私人昵称', showEdit: true });
      await page.resume();
      assert.equal(page.data.member, null); assert.equal(page.data.avatarUrl, ''); assert.equal(page.data.avatarBase64, '');
      assert.equal(page.data.nickname, ''); assert.equal(page.data.identityVerified, false); assert.equal(page.data.staff, false);
    } finally { env.restore(); }
  }
});

test('external private retries and saving foregrounds still verify identity freshly', async () => {
  const env = await environment('member', true);
  try {
    const page = profile(); await page.resume(); env.calls.length = 0;
    await page.loadAvatar(); assert.deepEqual(env.calls, ['identity.me', 'profile.avatar.get']);
    env.calls.length = 0; await page.loadDossier(); assert.deepEqual(env.calls, ['identity.me', 'dossier.mine']);
    page.setData({ saving: true, avatarBase64: 'private-in-progress', nickname: '未保存的称呼' });
    env.calls.length = 0; await page.resume(); assert.deepEqual(env.calls, ['identity.me']);
    assert.equal(page.data.avatarBase64, 'private-in-progress'); assert.equal(page.data.nickname, '未保存的称呼');
    env.api.switchMockRole('founder'); await page.resume();
    assert.equal(page.data.member.memberKind, 'founder'); assert.equal(page.data.saving, false); assert.equal(page.data.avatarBase64, ''); assert.equal(page.data.avatarUrl, '');
  } finally { env.restore(); }
});

test('older parallel private responses cannot replace the next identity profile', async () => {
  const env = await environment('member', true), release = gate(), avatarStarted = gate();
  const own = await env.api.call('dossier.mine'); await env.api.call('dossier.save', { draft: { ...own.draft, riderName: '只属于上一身份的资料' } }, own.revision);
  env.setIntercept(async (action, args, real) => {
    const role = real.mockRole(), result = await real.call(action, ...args);
    if (role === 'member' && ['profile.avatar.get', 'dossier.mine'].includes(action)) { if (action === 'profile.avatar.get') avatarStarted.release(); await release.promise; }
    return result;
  });
  const page = profile(), pending = page.resume();
  try {
    await avatarStarted.promise; env.api.switchMockRole('founder'); await page.resume();
    const currentId = page.data.member.id; release.release(); await pending;
    assert.equal(page.data.member.id, currentId); assert.equal(page.data.member.memberKind, 'founder');
    assert.equal(page.data.avatarUrl, ''); assert.equal(page.data.dossierCount, '0 / 11'); assert.equal(page.data.dossierError, '');
  } finally { release.release(); env.restore(); }
});

test('a newer same-member load supersedes old private responses and mismatched dossier identities are cleared', async () => {
  const env = await environment('member', true), release = gate(), avatarStarted = gate(), counts = new Map();
  env.setIntercept(async (action, args, real) => {
    const result = await real.call(action, ...args), count = (counts.get(action) || 0) + 1; counts.set(action, count);
    if (['profile.avatar.get', 'dossier.mine'].includes(action) && count === 1) {
      if (action === 'profile.avatar.get') avatarStarted.release(); await release.promise;
      return action === 'profile.avatar.get' ? { url: '/outdated-avatar' } : { ...result, draft: { ...result.draft, riderName: '旧一轮资料' } };
    }
    return result;
  });
  const page = profile(), pending = page.resume();
  try {
    await avatarStarted.promise; await page.resume();
    const currentUrl = page.data.avatarUrl; assert(currentUrl); release.release(); await pending;
    assert.equal(page.data.avatarUrl, currentUrl); assert.equal(page.data.dossierCount, '0 / 11');
    env.setIntercept(async (action, args, real) => {
      const result = await real.call(action, ...args);
      return action === 'dossier.mine' ? { ...result, memberId: 'another-member' } : result;
    });
    await page.resume(); assert.equal(page.data.member, null); assert.equal(page.data.avatarUrl, '');
    assert.equal(page.data.identityVerified, false); assert(page.data.error.includes('当前成员资料已变化'));
  } finally { release.release(); env.restore(); }
});
