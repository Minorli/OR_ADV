const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram'), apiPath = path.join(root, 'services/api.js');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const event = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
function page(name, options = {}) {
  let definition; global.Page = value => { definition = value; };
  const file = path.join(root, 'pages', name, 'index.js'); delete require.cache[require.resolve(file)]; require(file);
  const result = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  result.onLoad?.(options); return result;
}
function environment(role = 'member') {
  const storage = new Map(), calls = [];
  global.wx = { getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    showToast() {}, showModal: async () => ({ confirm: true }), pageScrollTo() {}, navigateTo() {}, switchTab() {}, stopPullDownRefresh() {},
  };
  delete require.cache[require.resolve(apiPath)]; delete require.cache[require.resolve(path.join(root, 'services/member-media.js'))];
  const real = require(apiPath); real.resetMock(); real.switchMockRole(role);
  const module = require.cache[require.resolve(apiPath)], runtime = { ...real.runtime }; let intercept, identity = member => member;
  module.exports = { ...real, runtime, async currentMember() { calls.push('identity.me'); return identity(await real.currentMember()); },
    async call(action, ...args) { calls.push(action); return intercept ? intercept(action, args, real) : real.call(action, ...args); } };
  return { api: real, calls, storage, runtime, setIntercept(value) { intercept = value; }, setIdentity(value) { identity = value; }, restore() { module.exports = real; } };
}

test('club sections and initial inquiry queues share exactly one fresh identity per foreground load', async () => {
  for (const [role, options, expected] of [
    ['guest', { section: 'handbook' }, 3], ['member', { section: 'handbook' }, 3],
    ['member', { section: 'business' }, 4], ['owner', { section: 'core', mode: 'manage' }, 4],
  ]) {
    const env = environment(role);
    try {
      const p = page('club-content', options); await p.resume(); assert.equal(p.data.error, '');
      assert.equal(env.calls.filter(action => action === 'identity.me').length, 1); assert.equal(env.calls.length, expected);
      env.calls.length = 0; await p.resume(); assert.equal(env.calls.filter(action => action === 'identity.me').length, 1, 'each foreground reads a new identity');
      if (role === 'member' && options.section === 'business') {
        env.calls.length = 0; await p.loadInquiries(); assert.deepEqual(env.calls, ['identity.me', 'club.inquiry.mine'], 'independent inquiry retry still verifies freshly');
      }
    } finally { env.restore(); }
  }
});

test('history detail and owner story queues share one identity including private photo-free management', async () => {
  for (const [role, mode, expected] of [['guest', '', 2], ['member', '', 3], ['owner', 'manage', 5]]) {
    const env = environment(role);
    try {
      const p = page('history-detail', { activityId: 'history-ride', mode }); await p.resume(); assert.equal(p.data.error, '');
      assert.equal(env.calls.filter(action => action === 'identity.me').length, 1); assert.equal(env.calls.length, expected);
      env.calls.length = 0; await p.resume(); assert.equal(env.calls.filter(action => action === 'identity.me').length, 1);
      if (mode) { env.calls.length = 0; await p.loadManage(); assert(env.calls.filter(action => action === 'identity.me').length >= 1, 'independent management retry retains fresh verification'); }
    } finally { env.restore(); }
  }
});

test('dirty or busy forms verify freshly without losing same-member edits and clear revoked owner content', async () => {
  for (const name of ['club-content', 'history-detail']) {
    const env = environment('owner'), options = name === 'club-content' ? { section: 'core', mode: 'manage' } : { activityId: 'history-ride', mode: 'manage' };
    try {
      const p = page(name, options); await p.resume();
      if (name === 'club-content') p.field(event('introduction', '尚未保存的私有编辑'));
      else p.field(event('intro', '尚未保存的私有编辑'));
      p.setData({ busy: true }); env.calls.length = 0; await p.resume();
      assert.deepEqual(env.calls, ['identity.me']); assert.equal(name === 'club-content' ? p.data.draft.introduction : p.data.intro, '尚未保存的私有编辑');
      env.setIdentity(member => member ? { ...member, roles: [] } : null); await p.resume();
      assert.equal(p.data.isOwner, false); assert.equal(name === 'club-content' ? p.data.draft.introduction : p.data.intro, '');
      assert.equal(name === 'club-content' ? p.data.content : p.data.story, null); assert.equal(p.data.busy, false);
      assert.equal((p.data.inquiries || p.data.queue).length, 0);
    } finally { env.restore(); }
  }
});

test('old private reads never populate a different member after a foreground switch', async () => {
  for (const name of ['club-content', 'history-detail']) {
    const env = environment(), release = gate(), began = gate();
    if (name === 'club-content') await env.api.call('club.inquiry.submit', { kind: 'business', contact: 'fictional-a-contact', message: '仅属于旧身份的咨询', submissionId: 'loading-review-seed-0001', consent: true });
    else await env.api.call('history.review.save', { activityId: 'history-ride', stars: 3, comment: '仅属于旧身份的评价', publishConsent: true, nicknameConsent: true, honorConsent: false, consentVersion: 1 }, 0);
    const privateAction = name === 'club-content' ? 'club.inquiry.mine' : 'history.review.mine';
    env.setIntercept(async (action, args, real) => {
      const role = real.mockRole(), result = await real.call(action, ...args);
      if (role === 'member' && action === privateAction) { began.release(); await release.promise; }
      return result;
    });
    const p = page(name, name === 'club-content' ? { section: 'business' } : { activityId: 'history-ride' }), pending = p.resume();
    try {
      await began.promise; env.api.switchMockRole('founder'); await p.resume();
      const currentId = (await env.api.currentMember()).id; release.release(); await pending;
      assert.equal(p.data.member.id, currentId);
      if (name === 'club-content') { assert.equal(p.data.inquiryContact, ''); assert(p.data.inquiries.every(row => row.memberId === currentId)); }
      else { assert.equal(p.data.comment, ''); assert(!p.data.own?.review || p.data.own.review.memberId === currentId); }
    } finally { release.release(); env.restore(); }
  }
});

test('same-member newer loads supersede older queue responses', async () => {
  for (const name of ['club-content', 'history-detail']) {
    const env = environment('owner'), release = gate(), began = gate(); let count = 0;
    const actionName = name === 'club-content' ? 'staff.club.inquiry.list' : 'staff.history.get';
    env.setIntercept(async (action, args, real) => {
      const result = await real.call(action, ...args);
      if (action === actionName && ++count === 1) { began.release(); await release.promise; return name === 'history-detail' ? { ...result, intro: '不可覆盖新版的旧说明' } : { ...result, items: [{ id: 'old-private-inquiry' }] }; }
      return result;
    });
    const p = page(name, name === 'club-content' ? { mode: 'manage', section: 'core' } : { mode: 'manage', activityId: 'history-ride' }), pending = p.resume();
    try {
      await began.promise; await p.load(); release.release(); await pending;
      if (name === 'club-content') assert(!p.data.inquiries.some(row => row.id === 'old-private-inquiry'));
      else assert.notEqual(p.data.intro, '不可覆盖新版的旧说明');
      assert.equal(p.data.error, '');
    } finally { release.release(); env.restore(); }
  }
});

test('independent initial data reads start before unrelated responses finish', async () => {
  for (const name of ['club-content', 'history-detail']) {
    const env = environment('owner'), release = gate(), blocked = name === 'club-content' ? 'club.public' : 'history.review.mine';
    env.setIntercept(async (action, args, real) => { const result = await real.call(action, ...args); if (action === blocked) await release.promise; return result; });
    const p = page(name, name === 'club-content' ? { mode: 'manage', section: 'core' } : { mode: 'manage', activityId: 'history-ride' }), pending = p.resume();
    try {
      await new Promise(resolve => setImmediate(resolve));
      const expected = name === 'club-content' ? ['staff.club.content.get', 'staff.club.inquiry.list'] : ['staff.history.get', 'staff.history.reviews'];
      for (const action of expected) assert(env.calls.includes(action), `${action} must not wait for ${blocked}`);
    } finally { release.release(); await pending; env.restore(); }
    assert.equal(p.data.error, '');
  }
});

test('a live environment change invalidates pending private results', async () => {
  for (const name of ['club-content', 'history-detail']) {
    const env = environment('owner'), release = gate(), began = gate(), actionName = name === 'club-content' ? 'staff.club.inquiry.list' : 'staff.history.get';
    env.setIntercept(async (action, args, real) => { const result = await real.call(action, ...args); if (action === actionName) { began.release(); await release.promise; } return result; });
    const p = page(name, name === 'club-content' ? { mode: 'manage', section: 'core' } : { mode: 'manage', activityId: 'history-ride' }), pending = p.resume();
    try {
      await began.promise; env.runtime.envId = 'other-environment'; release.release(); await pending;
      if (name === 'club-content') { assert.equal(p.data.identityReady, false); assert.equal(p.data.member, null); assert.deepEqual(p.data.inquiries, []); }
      else { assert.equal(p.data.member, null); assert.equal(p.data.story, null); assert.deepEqual(p.data.queue, []); }
    } finally { release.release(); env.restore(); }
  }
});

test('failed foreground identity verification clears private dirty forms', async () => {
  for (const name of ['club-content', 'history-detail']) {
    const env = environment('owner');
    try {
      const p = page(name, name === 'club-content' ? { mode: 'manage', section: 'core' } : { mode: 'manage', activityId: 'history-ride' }); await p.resume();
      p.field(event(name === 'club-content' ? 'introduction' : 'intro', '未保存的私人编辑')); p.setData({ busy: true });
      env.setIdentity(() => { throw new env.api.ApiError('NETWORK', 'identity unavailable'); }); await p.resume();
      assert.equal(p.data.member, null); assert.equal(p.data.isOwner, false); assert.equal(name === 'club-content' ? p.data.draft.introduction : p.data.intro, '');
      assert(p.data.error.includes('identity unavailable'));
    } finally { env.restore(); }
  }
});
