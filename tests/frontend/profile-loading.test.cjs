const { freshPageModule } = require('./native-harness.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(root, 'services/api.js'), profilePath = path.join(root, 'pages/profile/index.js');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function profile() {
  let definition; global.Page = value => { definition = value; };
  freshPageModule(profilePath);
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
    async call(action, ...args) { calls.push(action); if (action === 'profile.overview' && identityError) throw identityError; return intercept ? intercept(action, args, real) : real.call(action, ...args); },
  };
  return { api: real, calls, files, setIntercept(value) { intercept = value; }, failIdentity(value) { identityError = value; }, cloudContext(target) { module.exports = { ...module.exports, isMock: false, mockRole: () => 'guest', runtime: target }; }, restore() { module.exports = real; } };
}

test('profile opens with exactly one complete overview request for guests, members and saved avatars', async () => {
  for (const [role, avatar] of [['guest', false], ['member', false], ['member', true]]) {
    const env = await environment(role, avatar);
    try {
      const p = profile(); await p.onShow();
      assert.deepEqual(env.calls, ['profile.overview']); assert.equal(p.data.loading, false); assert.equal(p.data.identityVerified, true);
      assert.equal(Boolean(p.data.member), role !== 'guest'); if (avatar) assert(p.data.avatarUrl);
      env.calls.length = 0; await p.onShow(); assert.deepEqual(env.calls, ['profile.overview'], 'later visits refresh through one request');
    } finally { env.restore(); }
  }
});

test('duplicate foreground callbacks share one pending request and reveal the complete page together', async () => {
  const env = await environment('member', true), held = gate(), started = gate();
  env.setIntercept(async (action, args, real) => { const result = await real.call(action, ...args); if (action === 'profile.overview') { started.release(); await held.promise; } return result; });
  const p = profile(), first = p.onShow(); await started.promise; const second = p.onShow();
  try {
    assert.deepEqual(env.calls, ['profile.overview']); assert.equal(p.data.loading, true); assert.equal(p.data.member, null); assert.equal(p.data.avatarUrl, '');
    held.release(); await Promise.all([first, second]);
    assert(p.data.member); assert(p.data.avatarUrl); assert.equal(p.data.dossierParts.length, 6); assert.equal(p.data.dossierCount, '0 / 11'); assert.equal(p.data.loading, false);
  } finally { held.release(); env.restore(); }
});

test('optional contact and avatar notices preserve the complete profile while a failed overview clears private state', async () => {
  for (const section of ['contactError', 'avatarError']) {
    const env = await environment('member', true);
    env.setIntercept(async (action, args, real) => { const result = await real.call(action, ...args); return action === 'profile.overview' ? { ...result, [section]: '暂时无法显示', ...(section === 'avatarError' ? { avatarUrl: '' } : {}) } : result; });
    try {
      const p = profile(); await p.resume(); assert(p.data.member); assert.equal(p.data.dossierError, '');
      assert.equal(section === 'contactError' ? p.data.error : p.data.avatarError, '暂时无法显示');
      env.failIdentity(new env.api.ApiError('NETWORK', 'identity unavailable'));
      p.setData({ avatarBase64: 'private-image', nickname: 'private-draft', showEdit: false }); await p.load();
      assert.equal(p.data.member, null); assert.equal(p.data.avatarUrl, ''); assert.equal(p.data.avatarBase64, ''); assert.equal(p.data.nickname, ''); assert.equal(p.data.identityVerified, false);
    } finally { env.restore(); }
  }
});

test('external private retries and dirty or saving foregrounds still verify identity freshly', async () => {
  const env = await environment('member', true);
  try {
    const p = profile(); await p.resume(); env.calls.length = 0;
    await p.loadAvatar(); assert.deepEqual(env.calls, ['identity.me', 'profile.avatar.get']);
    env.calls.length = 0; await p.loadDossier(); assert.deepEqual(env.calls, ['identity.me', 'dossier.mine']);
    p.setData({ saving: true, avatarBase64: 'private-in-progress', nickname: '未保存的称呼' });
    env.calls.length = 0; await Promise.all([p.resume(), p.resume()]); assert.deepEqual(env.calls, ['identity.me'], 'concurrent verification does not duplicate the identity call');
    assert.equal(p.data.avatarBase64, 'private-in-progress'); assert.equal(p.data.nickname, '未保存的称呼');
    env.api.switchMockRole('founder'); await p.resume(); assert.equal(p.data.member.memberKind, 'founder'); assert.equal(p.data.saving, false); assert.equal(p.data.avatarBase64, ''); assert.equal(p.data.avatarUrl, '');
    p.setData({ showEdit: true, nickname: '尚未保存' }); env.calls.length = 0; await p.resume(); assert.deepEqual(env.calls, ['identity.me']); assert.equal(p.data.nickname, '尚未保存');
  } finally { env.restore(); }
});

test('a delayed previous account overview cannot replace a newer account page', async () => {
  const env = await environment('member', true), held = gate(), started = gate();
  env.setIntercept(async (action, args, real) => { const role = real.mockRole(), result = await real.call(action, ...args); if (action === 'profile.overview' && role === 'member') { started.release(); await held.promise; } return result; });
  const p = profile(), pending = p.resume(); await started.promise;
  try {
    env.api.switchMockRole('founder'); await p.resume(); const currentId = p.data.member.id;
    held.release(); await pending; assert.equal(p.data.member.id, currentId); assert.equal(p.data.member.memberKind, 'founder'); assert.equal(p.data.avatarUrl, ''); assert.equal(p.data.dossierCount, '0 / 11');
  } finally { held.release(); env.restore(); }
});

test('an explicit newer refresh supersedes an older same-member overview', async () => {
  const env = await environment('member', true), held = gate(), started = gate(); let count = 0;
  env.setIntercept(async (action, args, real) => { const result = await real.call(action, ...args); if (action === 'profile.overview' && ++count === 1) { started.release(); await held.promise; return { ...result, avatarUrl: '/obsolete-avatar', dossier: { ...result.dossier, ready: 99 } }; } return result; });
  const p = profile(), pending = p.resume(); await started.promise;
  try { await p.load(); const currentUrl = p.data.avatarUrl; held.release(); await pending; assert.equal(p.data.avatarUrl, currentUrl); assert.notEqual(currentUrl, '/obsolete-avatar'); assert.equal(p.data.dossierCount, '0 / 11'); }
  finally { held.release(); env.restore(); }
});

test('independent dossier retry refuses mismatched member data', async () => {
  const env = await environment('member', true);
  try { const p = profile(); await p.load(); env.setIntercept(async (action, args, real) => { const result = await real.call(action, ...args); return action === 'dossier.mine' ? { ...result, memberId: 'another-member' } : result; }); await p.loadDossier(); assert.equal(p.data.member, null); assert.equal(p.data.avatarUrl, ''); assert.equal(p.data.identityVerified, false); assert(p.data.error.includes('当前成员资料已变化')); }
  finally { env.restore(); }
});

test('an unloaded profile cannot apply its late overview response', async () => {
  const env = await environment('member', true), held = gate(), started = gate();
  env.setIntercept(async (action, args, real) => { const result = await real.call(action, ...args); if (action === 'profile.overview') { started.release(); await held.promise; } return result; });
  const p = profile(), pending = p.onShow(); await started.promise; p.onUnload(); held.release(); await pending;
  assert.equal(p.data.member, null); assert.equal(p.data.avatarUrl, ''); env.restore();
});

test('a new visible lifecycle under the same cloud role cannot reuse an old account overview', async () => {
  const env = await environment('member', true), held = gate(), started = gate();
  env.cloudContext({ mode: 'cloud', appId: 'wx0123456789abcdef', envId: 'profile-cloud-a', version: 'test' });
  env.setIntercept(async (action, args, real) => { const role = real.mockRole(), result = await real.call(action, ...args); if (action === 'profile.overview' && role === 'member') { started.release(); await held.promise; } return result; });
  const p = profile(), first = p.onShow(); await started.promise; p.onHide(); env.api.switchMockRole('founder');
  try { await p.onShow(); const current = p.data.member.id; held.release(); await first; assert.equal(p.data.member.id, current); assert.equal(p.data.member.memberKind, 'founder'); assert.equal(p.data.avatarUrl, ''); assert.equal(env.calls.filter(c => c === 'profile.overview').length, 2); }
  finally { held.release(); env.restore(); }
});

test('an environment change creates a fresh request and discards the old cloud overview', async () => {
  const env = await environment('member', true), held = gate(), started = gate(), target = { mode: 'cloud', appId: 'wx0123456789abcdef', envId: 'profile-cloud-a', version: 'test' }; let firstCall = true;
  env.cloudContext(target); env.setIntercept(async (action, args, real) => { const result = await real.call(action, ...args); if (action === 'profile.overview' && firstCall) { firstCall = false; started.release(); await held.promise; return { ...result, avatarUrl: '/private-env-a' }; } return result; });
  const p = profile(), first = p.onShow(); await started.promise; target.envId = 'profile-cloud-b'; env.api.switchMockRole('founder');
  try { await p.onShow(); const current = p.data.member.id; held.release(); await first; assert.equal(p.data.member.id, current); assert.equal(p.data.avatarUrl, ''); assert.equal(p.data.member.memberKind, 'founder'); assert.equal(env.calls.filter(c => c === 'profile.overview').length, 2); }
  finally { held.release(); env.restore(); }
});
