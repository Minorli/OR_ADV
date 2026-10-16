const { freshPageModule } = require('./native-harness.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram'), apiPath = path.join(root, 'services/api.js');
const event = (dataset, value) => ({ currentTarget: { dataset }, detail: { value } });
function page(name, options = {}) {
  let definition; global.Page = value => { definition = value; };
  const file = path.join(root, 'pages', name + '.js'); freshPageModule(file);
  const p = { ...definition, data: structuredClone(definition.data), setData(values, callback) { for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let target = this.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value; } callback?.(); } };
  p.onLoad?.(options); return p;
}
async function environment(role = 'content_admin', showcase = false) {
  const storage = new Map(), calls = [], routes = [];
  global.wx = { getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    showToast() {}, showModal: async () => ({ confirm: true }), pageScrollTo() {}, navigateTo: value => routes.push(value.url), switchTab: value => routes.push(value.url), stopPullDownRefresh() {},
  };
  delete require.cache[require.resolve(apiPath)]; delete require.cache[require.resolve(path.join(root, 'services/member-media.js'))];
  const real = require(apiPath); real.resetMock(showcase ? undefined : 'empty'); real.switchMockRole('member'); const member = await real.currentMember(); real.switchMockRole('owner');
  if (role === 'content_admin') await real.call('staff.roles.assign', { memberId: member.id, role, reason: '核定内容工作授权' });
  if (role === 'manager') await real.call('staff.roles.assign', { memberId: member.id, role: 'owner', designation: 'manager', reason: '核定车队经理授权' });
  real.switchMockRole(role === 'owner' ? 'owner' : 'member');
  const module = require.cache[require.resolve(apiPath)]; let intercept; module.exports = { ...real,
    async currentMember() { calls.push('identity.me'); return real.currentMember(); },
    async call(action, ...args) { calls.push(action); return intercept ? intercept(action, args, real) : real.call(action, ...args); },
  };
  return { api: real, member, calls, routes, setIntercept(value) { intercept = value; }, restore() { module.exports = real; } };
}

test('content administrator has working publishing controls without private queues or business workbench entry', async () => {
  const env = await environment();
  try {
    const content = page('club-content/index', { mode: 'manage', section: 'handbook' }); await content.load(); assert.equal(content.data.error, ''); assert.equal(content.data.canManageContent, true); assert.equal(content.data.isOwner, false);
    assert(!env.calls.includes('staff.club.inquiry.list')); assert.deepEqual(content.data.inquiries, []);
    content.field(event({ field: 'introduction' }, '内容管理员核实后的公开说明')); content.publishRights(event({}, ['accepted'])); await content.publish(); assert.equal(content.data.error, '');
    const learning = page('learning/index'); await learning.load(); await learning.toggleEditor(); assert.equal(learning.data.editor, true); assert(Array.isArray(learning.data.bank.questions));
    const skills = page('skills/index'); await skills.load(); skills.open(event({ id: 'basic-posture' })); await skills.toggleReference(); assert.equal(skills.data.referenceEditor, true); assert.equal(skills.data.reviewMode, false);
    const before = env.calls.length; await skills.toggleReview(); assert(!env.calls.slice(before).includes('staff.skills.queue'));
    const profile = page('profile/index'); await profile.load(); assert.equal(profile.data.staff, false); assert.equal(profile.data.canManageContent, true); profile.clubManagement(); assert(env.routes.at(-1).includes('club-content/index?mode=manage'));
    const staff = page('staff/index'); await staff.load(); assert.equal(staff.data.authorized, false);
    const members = page('staff-members/index'); await members.load(); assert.equal(members.data.authorized, false); assert.deepEqual(members.data.items, []);
  } finally { env.restore(); }
});

test('owner manages business identity and content job independently without forcing public consent or points', async () => {
  const env = await environment('owner');
  try {
    const p = page('staff-members/index'); await p.load(); await p.select(event({ id: env.member.id }));
    p.role(event({}, String(p.data.roleValues.indexOf('content_admin')))); p.setData({ reason: '安排公开内容编辑工作' }); await p.saveRole(); assert.equal(p.data.error, '');
    p.setData({ reason: '核对创始合伙人名单', expiryDate: '' }); await p.assignKind(event({ kind: 'founder' })); assert.equal(p.data.error, '');
    env.api.switchMockRole('member'); const after = await env.api.currentMember(); assert.equal(after.memberKind, 'founder'); assert.deepEqual(after.roles, ['content_admin']); assert.equal(after.growthPoints, 0); assert.equal(after.recommendationOptIn, false); assert.equal(after.rankingOptIn, false);
    assert.equal((await env.api.call('recommendation.list')).items.some(item => item.nickname === after.nickname), false);
  } finally { env.restore(); }
});

test('manager displays the correct title and shares owner management while the primary role stays protected', async () => {
  const env = await environment('manager');
  try {
    const profile = page('profile/index'); await profile.load(); assert.equal(profile.data.adminTitle, '车队经理'); assert.equal(profile.data.isOwner, true);
    const members = page('staff-members/index'); await members.load(); assert.equal(members.data.authorized, true); assert.equal(members.data.adminTitle, '车队经理');
    assert(members.data.items.find(item => item.id === env.member.id).roleBadges.includes('车队经理'));
    const primary = members.data.items.find(item => item.memberNumber === 0); await members.select(event({ id: primary.id })); assert.equal(members.data.selected.isPrimaryOwner, true);
    members.role(event({}, String(members.data.roleValues.indexOf('owner')))); assert.equal(members.data.roleProtected, true);
    members.setData({ reason: '不能撤销可信主理人', roleEnabled: false }); await members.saveRole(); assert(members.data.error || members.data.roleEnabled);
  } finally { env.restore(); }
});

test('unsaved member management remains with the verified actor and cannot grant permissions after an actor switch', async () => {
  const env = await environment('manager');
  try {
    env.api.switchMockRole('owner'); const p = page('staff-members/index'); await p.load(); await p.select(event({ id: env.member.id }));
    p.setData({ reason: '尚未保存的授权依据' }); env.calls.length = 0; await p.resume(); assert.deepEqual(env.calls, ['identity.me']); assert.equal(p.data.reason, '尚未保存的授权依据');
    env.api.switchMockRole('member'); env.calls.length = 0; await p.saveRole(); assert(!env.calls.includes('staff.roles.assign')); assert.equal(p.data.selected, null); assert.equal(p.data.reason, '');
  } finally { env.restore(); }
});

test('owner downgrade clears private history audit rows even on the same dirty or busy member and discards delayed owner responses', async () => {
  for (const pendingResponse of [false, true]) {
    const env = await environment('manager', true); let release, started;
    const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
    let pending;
    try {
      env.api.switchMockRole('founder');
      const own = await env.api.call('history.review.save', { activityId: 'history-ride', stars: 3, comment: '撤回后只有业务管理员保留审计', publishConsent: true, nicknameConsent: true, honorConsent: false, consentVersion: 1 }, 0);
      await env.api.call('history.review.withdraw', { activityId: 'history-ride' }, own.revision); env.api.switchMockRole('member');
      const p = page('history-detail/index', { activityId: 'history-ride', mode: 'manage' }); await p.load(); assert(p.data.queue.some(row => row.comment === own.review.comment));
      p.setData({ dirty: true, busy: true, intro: '旧管理身份的未保存说明' });
      if (pendingResponse) {
        env.setIntercept(async (action, args, real) => { const result = await real.call(action, ...args); if (action === 'staff.history.reviews') { started(); await gate; } return result; });
        pending = p.loadManage(); await began;
      }
      env.api.switchMockRole('owner');
      await env.api.call('staff.roles.assign', { memberId: env.member.id, role: 'owner', enabled: false, reason: '改为仅维护公开内容' }, 1);
      await env.api.call('staff.roles.assign', { memberId: env.member.id, role: 'content_admin', reason: '仅公开内容权限' }); env.api.switchMockRole('member');
      env.setIntercept(undefined);
      if (pendingResponse) { await p.resume(); release(); await pending; }
      else { await assert.rejects(p.assertViewer(true), error => error.code === 'STALE_IDENTITY'); await p.resume(); }
      assert.equal(p.data.isOwner, false); assert.equal(p.data.canManageContent, true); assert.deepEqual(p.data.queue, []);
      assert.equal(p.data.intro, ''); assert(!JSON.stringify(p.data).includes(own.review.comment)); assert.equal(p.data.busy, false);
    } finally { release(); await pending; env.restore(); }
  }
});
