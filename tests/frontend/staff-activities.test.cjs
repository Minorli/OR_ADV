const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram'), apiPath = path.join(root, 'services/api.js');
const event = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function environment() {
  const storage = new Map(), calls = [], routes = [], scroll = []; let onConfirm, intercept, identity = member => member;
  global.wx = { getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    showToast() {}, showModal: async value => ({ confirm: await onConfirm?.(value) !== false }), pageScrollTo: value => scroll.push(value.selector),
    navigateTo: value => routes.push(value.url), switchTab: value => routes.push(value.url), stopPullDownRefresh() {},
  };
  delete require.cache[require.resolve(apiPath)]; const real = require(apiPath); real.resetMock('empty'); real.switchMockRole('owner');
  const module = require.cache[require.resolve(apiPath)], runtime = { ...real.runtime }; module.exports = { ...real, runtime,
    async currentMember() { calls.push({ action: 'identity.me' }); return identity(await real.currentMember()); },
    async call(action, payload, revision) { calls.push({ action, payload, revision }); return intercept ? intercept(action, payload, revision, real) : real.call(action, payload, revision); },
  };
  let definition; global.Page = value => { definition = value; };
  const file = path.join(root, 'pages/staff/index.js'); delete require.cache[require.resolve(file)]; require(file);
  const p = { ...definition, data: structuredClone(definition.data), setData(values, callback) {
    for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let target = this.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value; } callback?.();
  } };
  return { api: real, p, calls, routes, scroll, runtime, onConfirm(value) { onConfirm = value; }, intercept(value) { intercept = value; }, setIdentity(value) { identity = value; }, restore() { module.exports = real; } };
}
function fill(p) {
  for (const [field, value] of Object.entries({ title: '周末林道同行', description: '按本场准备说明集合，完成出发与回场核对。', location: '北京周边公开区域', safetyNotice: '活动中遇到状况及时联系现场负责人。', equipment: '请按本场核定的装备要求准备。' })) p.field(event(field, value));
}

test('activity editor saves an explicit redeemable reward under the approved policy and locks it after publication', async () => {
  const env = environment(), p = env.p;
  try {
    await env.api.call('staff.points.policy.save', { enabled: false, defaultRewardMode: 'growth', ruleText: '活动完成后记录兑换奖励，交付时核销。', reason: '核定本轮规则' }, 0);
    await p.load(); await p.newActivity(); fill(p); p.field(event('redeemable', '75')); await p.save();
    assert.equal(p.data.error, ''); assert.equal(p.data.selected.pointsRule.redeemable, 75); assert.equal(p.data.selected.pointsRule.walletPolicyVersion, 1);
    await p.lifecycle({ currentTarget: { dataset: { action: 'publish' } } }); await p.edit();
    p.field(event('redeemable', '999')); assert.equal(p.data.form.redeemable, '75', 'content corrections cannot alter the frozen wallet reward');
    const selected = await env.api.call('activity.get', { activityId: p.data.selected.id }); assert.equal(selected.pointsRule.redeemable, 75);
  } finally { env.restore(); }
});

test('owner can create, find the publish action, preview, publish, and correct wording without changing frozen rules', async () => {
  const env = environment(), p = env.p;
  try {
    await p.load(); await p.newActivity(); fill(p); await p.save();
    assert.equal(p.data.error, ''); assert.equal(p.data.selected.state, 'draft'); assert.equal(p.data.pane, 'roster', 'saving lands on the card containing publication controls');
    const id = p.data.selected.id; p.previewActivity(); assert.equal(env.routes.at(-1), `/pages/activity/detail?id=${encodeURIComponent(id)}`);
    await p.lifecycle({ currentTarget: { dataset: { action: 'publish' } } }); assert.equal(p.data.selected.state, 'published');
    const frozen = await env.api.call('activity.get', { activityId: id });
    await p.edit(); assert.equal(p.data.editorKind, 'content');
    p.field(event('capacity', '199')); assert.equal(p.data.form.capacity, String(frozen.capacity), 'locked inputs cannot change through a crafted event');
    p.field(event('title', '周末林道同行 · 集合提示已补充')); p.field(event('description', '补充公开活动介绍，请已确认参加的车友查看行前安排。')); p.field(event('reason', '补充公开介绍，便于参加者查找安排'));
    await p.save(); assert.equal(p.data.error, '');
    const corrected = await env.api.call('activity.get', { activityId: id });
    assert.equal(corrected.title, '周末林道同行 · 集合提示已补充'); assert.equal(corrected.state, 'published'); assert.equal(corrected.ruleVersion, frozen.ruleVersion);
    assert.deepEqual({ ...corrected, title: frozen.title, description: frozen.description, revision: frozen.revision }, frozen);
    const request = env.calls.find(row => row.action === 'staff.activity.content.save');
    assert.deepEqual(Object.keys(request.payload).sort(), ['activityId', 'description', 'reason', 'title']); assert.equal(request.revision, frozen.revision);
  } finally { env.restore(); }
});

test('activity form keeps its own revision and preserves edits after a stale save fails', async () => {
  const env = environment(), p = env.p;
  try {
    await p.load(); p.setData({ selected: p.data.items.find(row => row.id === 'draft-ride') }); await p.edit();
    p.field(event('title', '旧页面尚未保存的标题')); const boundRevision = p.data.form.revision;
    const latest = await env.api.call('staff.activity.save', { id: 'draft-ride', title: '另一页面已保存的标题' }, boundRevision);
    p.setData({ selected: { ...p.data.selected, revision: latest.revision } }); await p.save();
    assert(p.data.error.includes('更新')); assert.equal(p.data.editor, true); assert.equal(p.data.form.title, '旧页面尚未保存的标题');
    const save = env.calls.findLast(row => row.action === 'staff.activity.save'); assert.equal(save.revision, boundRevision);
    assert.equal((await env.api.call('activity.get', { activityId: 'draft-ride' })).title, '另一页面已保存的标题');
  } finally { env.restore(); }
});

test('foreground verification preserves the same editor and actor switches discard old form before any write', async () => {
  const env = environment(), p = env.p;
  try {
    await p.load(); await p.newActivity(); fill(p); const oldId = p.data.member.id;
    env.calls.length = 0; await p.resume(); assert.deepEqual(env.calls.map(row => row.action), ['identity.me']); assert.equal(p.data.form.title, '周末林道同行');
    env.api.switchMockRole('operator'); env.calls.length = 0; await p.save();
    assert(!env.calls.some(row => row.action === 'staff.activity.save')); assert.equal(p.data.editor, false); assert.equal(p.data.form.title, ''); assert.notEqual(p.data.member.id, oldId);
  } finally { env.restore(); }
});

test('changing an otherwise privileged actor inside the confirmation cannot publish the previous actor selection', async () => {
  const env = environment(), p = env.p;
  try {
    await p.load(); p.setData({ selected: p.data.items.find(row => row.id === 'draft-ride') });
    env.onConfirm(() => env.api.switchMockRole('operator')); await p.lifecycle({ currentTarget: { dataset: { action: 'publish' } } });
    assert(!env.calls.some(row => row.action === 'staff.activity.publish')); assert.equal((await env.api.call('activity.get', { activityId: 'draft-ride' })).state, 'draft');
  } finally { env.restore(); }
});

test('late private staff roster responses cannot refill a page after owner access is lost', async () => {
  const env = environment(), release = gate(), began = gate(), p = env.p;
  env.intercept(async (action, payload, revision, real) => { const result = await real.call(action, payload, revision); if (action === 'staff.registration.list') { began.release(); await release.promise; } return result; });
  const pending = p.load();
  try {
    await began.promise; env.api.switchMockRole('member'); await p.load(); release.release(); await pending;
    assert.equal(p.data.authorized, false); assert.equal(p.data.canManage, false); assert.deepEqual(p.data.registrations, []); assert.deepEqual(p.data.items, []); assert.equal(p.data.editor, false);
  } finally { release.release(); env.restore(); }
});

test('ordinary staff load verifies identity once and reads roster and briefing independently', async () => {
  const env = environment(), release = gate();
  env.intercept(async (action, payload, revision, real) => { const result = await real.call(action, payload, revision); if (action === 'staff.registration.list') await release.promise; return result; });
  const pending = env.p.load();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert(env.calls.some(row => row.action === 'activity.briefing.get'), 'briefing must start before the roster response is released');
  } finally { release.release(); await pending; env.restore(); }
  assert.equal(env.calls.filter(row => row.action === 'identity.me').length, 1); assert.equal(env.calls.length, 4); assert.equal(env.p.data.error, '');
});

test('same-account permission loss or a live cloud target change discards the editor before saving', async () => {
  for (const boundary of ['permission', 'environment']) {
    const env = environment(), p = env.p;
    try {
      await p.load(); await p.newActivity(); fill(p); env.calls.length = 0;
      if (boundary === 'permission') env.setIdentity(member => member ? { ...member, roles: [] } : null);
      else env.runtime.envId = 'other-environment';
      await p.save();
      assert(!env.calls.some(row => row.action === 'staff.activity.save')); assert.equal(p.data.editor, false); assert.equal(p.data.form.title, '');
      if (boundary === 'permission') assert.equal(p.data.authorized, false);
    } finally { env.restore(); }
  }
});

test('declining an activity switch preserves the current unsaved form', async () => {
  const env = environment(), p = env.p;
  try {
    await p.load(); await p.newActivity(); fill(p); const previous = p.data.selected.id; env.onConfirm(() => false);
    await p.select({ currentTarget: { dataset: { id: 'advanced-ride' } } });
    assert.equal(p.data.selected.id, previous); assert.equal(p.data.form.title, '周末林道同行'); assert.equal(p.data.editor, true);
  } finally { env.restore(); }
});

test('existing registration, briefing, check-in and settlement controls keep their complete real workflow', async () => {
  const env = environment(), p = env.p;
  try {
    env.api.switchMockRole('member'); const application = await env.api.call('registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 1 });
    env.api.switchMockRole('owner'); await p.load(); await p.select({ currentTarget: { dataset: { id: 'intro-ride' } } });
    p.briefingField(event('meetingPoint', '确认参加者的集合提示')); env.calls.length = 0; await p.resume();
    assert.deepEqual(env.calls.map(row => row.action), ['identity.me']); assert.equal(p.data.briefing.meetingPoint, '确认参加者的集合提示');
    p.briefingField(event('contactName', '本场负责人')); p.briefingField(event('contactValue', 'fictional-owner-contact')); await p.saveBriefing(); assert.equal(p.data.error, '');
    const registrationAction = action => p.registrationAction({ currentTarget: { dataset: { id: application.id, action } } });
    await registrationAction('approve'); await registrationAction('confirm'); assert.equal(p.data.error, '');
    await p.lifecycle({ currentTarget: { dataset: { action: 'start' } } }); await registrationAction('departure'); await registrationAction('return');
    await p.lifecycle({ currentTarget: { dataset: { action: 'end' } } }); await p.preview();
    assert.equal(p.data.error, ''); assert.equal(p.data.preview.eligibleCount, 1); await p.settle();
    assert.equal(p.data.error, ''); assert.equal(p.data.settlement.successCount, 1);
    env.api.switchMockRole('member'); const member = await env.api.currentMember(); assert.equal(member.completedCount, 1); assert.equal(member.growthPoints, 100);
  } finally { env.restore(); }
});
