const { freshPageModule } = require('./native-harness.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram'), apiPath = path.join(root, 'services/api.js');
const event = (dataset = {}, value) => ({ currentTarget: { dataset }, detail: { value } });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function page(name = 'redemption/index', options = {}) {
  let definition; global.Page = value => { definition = value; };
  const file = path.join(root, 'pages', name + '.js'); freshPageModule(file);
  const p = { ...definition, data: structuredClone(definition.data), setData(values, callback) { for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let target = this.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value; } callback?.(); } };
  p.onLoad?.(options); return p;
}
async function setup(funded = false) {
  const storage = new Map(), calls = [], routes = []; let intercept, modal;
  global.wx = { env: { USER_DATA_PATH: '/user-data' }, getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key), getFileSystemManager: () => ({ unlinkSync() {} }),
    showToast() {}, showModal: async options => ({ confirm: await modal?.(options) !== false }), navigateTo: value => routes.push(value.url), switchTab: value => routes.push(value.url), stopPullDownRefresh() {} };
  delete require.cache[require.resolve(apiPath)]; delete require.cache[require.resolve(path.join(root, 'services/member-media.js'))];
  const real = require(apiPath); real.resetMock('empty'); real.switchMockRole('owner');
  if (funded) {
    await real.call('staff.points.policy.save', { enabled: true, defaultRewardMode: 'growth', ruleText: '参加已公布活动，完整核验并结算后取得兑换积分。交付前可取消。', reason: '核定本地流程测试规则' }, 0);
    const base = await real.call('activity.get', { activityId: 'intro-ride' });
    let activity = await real.call('staff.activity.save', { title: '兑换积分完整流程活动', description: base.description, location: base.location, difficulty: base.difficulty,
      startAt: base.startAt, endAt: base.endAt, applicationClosesAt: base.applicationClosesAt, capacity: 4, minGrowthPoints: 0, requiredQualifications: [], requiresReview: false,
      pointsRule: { growth: 100, annual: 100, redeemable: 100 }, safetyNotice: base.safetyNotice, equipment: base.equipment });
    activity = await real.call('staff.activity.publish', { activityId: activity.id }, activity.revision);
    real.switchMockRole('member'); let registration = await real.call('registration.apply', { activityId: activity.id, acceptedRuleVersion: activity.ruleVersion });
    real.switchMockRole('owner'); registration = await real.call('staff.registration.confirm', { registrationId: registration.id }, registration.revision);
    activity = await real.call('activity.get', { activityId: activity.id }); activity = await real.call('staff.activity.start', { activityId: activity.id }, activity.revision);
    registration = await real.call('staff.checkin.record', { registrationId: registration.id, phase: 'departure', result: 'present' }, registration.revision);
    await real.call('staff.checkin.record', { registrationId: registration.id, phase: 'return', result: 'present' }, registration.revision);
    activity = await real.call('activity.get', { activityId: activity.id }); activity = await real.call('staff.activity.end', { activityId: activity.id }, activity.revision);
    const settlement = await real.call('staff.settlement.run', { activityId: activity.id, ruleVersion: activity.ruleVersion }); assert.equal(settlement.successCount, 1);
  }
  const module = require.cache[require.resolve(apiPath)], runtime = { ...real.runtime };
  module.exports = { ...real, runtime, async currentMember() { calls.push({ action: 'identity.me' }); return real.currentMember(); },
    async call(action, payload = {}, revision) { calls.push({ action, payload: structuredClone(payload), revision }); return intercept ? intercept(action, payload, revision, real) : real.call(action, payload, revision); } };
  return { api: real, storage, calls, routes, runtime, intercept(value) { intercept = value; }, modal(value) { modal = value; }, restore() { module.exports = real; } };
}
function fillItem(p) { for (const [field, value] of Object.entries({ name: '俱乐部骑行手套', description: '一副骑行手套，具体款式按核定项目交付。', fulfillmentInstructions: '联系负责人核对领取安排。', pointsCost: '40', totalStock: '2', sortOrder: '0', reason: '核实物品、数量和领取办法' })) p.itemField(event({ field }, value)); }
async function createItem(env) {
  env.api.switchMockRole('owner'); const p = page('redemption/index', { mode: 'manage' }); await p.load(); p.newItem(); fillItem(p); await p.saveItem(); assert.equal(p.data.error, ''); assert.equal(p.data.adminItems.length, 1);
  const item = p.data.adminItems[0]; p.openItem(event({ id: item.id })); p.itemField(event({ field: 'reason' }, '核实库存后公开发布')); await p.itemStatus(event({ action: 'publish' })); assert.equal(p.data.error, ''); return p.data.adminItems[0];
}
async function request(env, item) {
  env.api.switchMockRole('member'); const p = page(); await p.load(); p.selectItem(event({ id: item.id })); await p.submit(); assert.equal(p.data.error, ''); assert.equal(p.data.mine.length, 1); return p;
}

// The credited balance below comes from real domain activity registration,
// departure/return, settlement and its wallet hook, never a balance-setting RPC.
test('wallet and redemption cold loads use trusted summaries without extra identity reads or invented catalog data', async () => {
  const env = await setup();
  try {
    env.api.switchMockRole('member'); const p = page(); env.calls.length = 0; await p.load(); assert.equal(p.data.error, ''); assert.deepEqual(p.data.items, []); assert.equal(p.data.wallet.balance, 0); assert.equal(p.data.policy.enabled, false);
    assert.deepEqual(env.calls.map(row => row.action), ['points.wallet', 'redemption.catalog']);
    const points = page('points/index'); env.calls.length = 0; await points.load(); assert.equal(points.data.error, ''); assert.equal(points.data.wallet.available, 0);
    assert.deepEqual(env.calls.map(row => row.action).sort(), ['points.mine', 'points.wallet']); points.redemption(); assert.equal(env.routes.at(-1), '/pages/redemption/index');
    env.api.switchMockRole('guest'); await p.load(); assert.equal(p.data.member, null); assert.equal(p.data.loading, false); assert.equal(p.data.error, '');
  } finally { env.restore(); }
});

test('owner visible controls create, publish, reserve, approve, fulfill and refund without changing growth or yearly totals', async () => {
  const env = await setup(true);
  try {
    const item = await createItem(env), p = await request(env, item); assert.equal(p.data.mine[0].state, 'pending'); assert.equal(p.data.wallet.balance, 100); assert.equal(p.data.wallet.held, 40); assert.equal(p.data.wallet.available, 60);
    const member = await env.api.currentMember(); assert.equal(member.growthPoints, 100); assert.equal(member.annualPoints, 100);
    env.api.switchMockRole('owner'); const admin = page('redemption/index', { mode: 'manage' }); admin.setData({ managePane: 'requests' }); await admin.load(); await admin.openRequest(event({ id: p.data.mine[0].id })); admin.adminReason(event({}, '已核实申请和领取安排')); await admin.process(event({ action: 'approve' })); assert.equal(admin.data.error, '');
    await admin.queueState(event({}, '1')); await admin.openRequest(event({ id: p.data.mine[0].id })); admin.adminReason(event({}, '已核对本人并实际交付')); await admin.process(event({ action: 'fulfill' })); assert.equal(admin.data.error, '');
    env.api.switchMockRole('member'); let wallet = await env.api.call('points.wallet'); assert.equal(wallet.balance, 60); assert.equal(wallet.held, 0); assert.equal(wallet.member.growthPoints, 100); assert.equal(wallet.member.annualPoints, 100);
    env.api.switchMockRole('owner'); await admin.queueState(event({}, '2')); await admin.openRequest(event({ id: p.data.mine[0].id })); admin.adminReason(event({}, '核实整笔退回，物品不恢复库存')); await admin.process(event({ action: 'refund' })); assert(admin.data.error.includes('库存')); assert.equal((await env.api.call('staff.redemption.get', { redemptionId: p.data.mine[0].id })).request.state, 'fulfilled');
    admin.restock(event({}, '2')); await admin.process(event({ action: 'refund' })); assert.equal(admin.data.error, '');
    env.api.switchMockRole('member'); wallet = await env.api.call('points.wallet'); assert.equal(wallet.balance, 100); assert.equal(wallet.held, 0); assert.equal(wallet.member.completedCount, 1);
    env.api.switchMockRole('owner'); const catalog = await env.api.call('staff.redemption.catalog.get'); assert.equal(catalog.items[0].fulfilledStock, 1, 'explicit no-restock choice survives the refund');
  } finally { env.restore(); }
});

test('member cancellation releases the original hold once and keeps immutable activity scores', async () => {
  const env = await setup(true);
  try {
    const p = await request(env, await createItem(env)), id = p.data.mine[0].id; p.reason(event({}, '本人安排变化')); await p.cancel(event({ id })); assert.equal(p.data.error, ''); assert.equal(p.data.mine[0].state, 'cancelled'); assert.equal(p.data.wallet.available, 100);
    const changes = env.calls.filter(row => row.action === 'redemption.cancel').length; await p.cancel(event({ id })); assert.equal(env.calls.filter(row => row.action === 'redemption.cancel').length, changes);
    assert.equal((await env.api.currentMember()).growthPoints, 100);
  } finally { env.restore(); }
});

test('a committed request with a lost response recovers by its original submission ID without another hold', async () => {
  const env = await setup(true);
  try {
    const item = await createItem(env); env.api.switchMockRole('member'); const p = page(); await p.load(); p.selectItem(event({ id: item.id }));
    env.intercept(async (action, payload, revision, real) => { const result = await real.call(action, payload, revision); if (action === 'redemption.request') throw new real.ApiError('NETWORK', '连接中断'); return result; });
    await p.submit(); assert(p.data.error.includes('中断')); assert(p.data.orderIntent); const submission = p.data.orderIntent.payload.submissionId;
    const reopened = page(); await reopened.load(); assert.equal(reopened.data.orderIntent.payload.submissionId, submission); env.intercept(null); await reopened.recoverOrder();
    assert.equal(reopened.data.error, ''); assert.equal(reopened.data.mode, 'mine'); assert.equal(reopened.data.mine.length, 1); assert.equal(reopened.data.wallet.held, 40);
    assert.equal(env.calls.filter(row => row.action === 'redemption.request').length, 1); assert.equal(reopened.data.orderIntent, null);
  } finally { env.restore(); }
});

test('unknown item creation locks the saved body and retries the same nonce without creating another item', async () => {
  const env = await setup(true);
  try {
    const p = page('redemption/index', { mode: 'manage' }); await p.load(); p.newItem(); fillItem(p);
    let lose = true; env.intercept(async (action, payload, revision, real) => { const result = await real.call(action, payload, revision); if (action === 'staff.redemption.catalog.save' && lose) { lose = false; throw new real.ApiError('NETWORK', '保存结果待核对'); } return result; });
    await p.saveItem(); assert(p.data.itemIntent); const payload = structuredClone(p.data.itemIntent.payload); p.itemField(event({ field: 'name' }, '不应覆盖原内容')); assert.equal(p.data.itemForm.name, payload.name);
    const reopened = page('redemption/index', { mode: 'manage' }); await reopened.load(); assert.deepEqual(reopened.data.itemIntent.payload, payload); await reopened.saveItem(); assert.equal(reopened.data.error, ''); assert.equal(reopened.data.adminItems.length, 1);
    const saved = env.calls.filter(row => row.action === 'staff.redemption.catalog.save'); assert.equal(saved.length, 2); assert.deepEqual(saved[0].payload, saved[1].payload); assert.equal(reopened.data.itemIntent, null);
  } finally { env.restore(); }
});

test('hiding a page rejects old read and write responses while same-member drafts resume only after fresh verification', async () => {
  const env = await setup(true);
  try {
    await createItem(env); env.api.switchMockRole('member'); const started = gate(), release = gate();
    env.intercept(async (action, payload, revision, real) => { const result = await real.call(action, payload, revision); if (action === 'redemption.catalog') { started.release(); await release.promise; } return result; });
    const p = page(), pending = p.load(); await started.promise; p.onHide(); release.release(); await pending; assert.equal(p.data.identityReady, false); assert.deepEqual(p.data.items, []);
    env.intercept(null); await p.onShow(); assert.equal(p.data.items.length, 1); assert.equal(p.data.identityReady, true);
    env.api.switchMockRole('owner'); const editor = page('redemption/index', { mode: 'manage' }); await editor.load(); editor.newItem(); fillItem(editor); editor.onHide(); env.calls.length = 0; await editor.onShow();
    assert.equal(editor.data.itemForm.name, '俱乐部骑行手套'); assert.equal(editor.data.itemDirty, true); assert.equal(editor.data.identityReady, true); assert.deepEqual(env.calls.map(row => row.action), ['points.wallet']);
    const saveStarted = gate(), saveRelease = gate(); env.intercept(async (action, payload, revision, real) => { const result = await real.call(action, payload, revision); if (action === 'staff.redemption.catalog.save') { saveStarted.release(); await saveRelease.promise; } return result; });
    const saving = editor.saveItem(); await saveStarted.promise; editor.onHide(); saveRelease.release(); await saving; assert.equal(editor.data.identityReady, false); assert.equal(editor.data.notice, ''); assert(editor.data.itemIntent);
    env.intercept(null); await editor.onShow(); assert.equal(editor.data.identityReady, true); assert(editor.data.itemIntent); await editor.saveItem(); assert.equal(editor.data.error, ''); assert.equal(editor.data.adminItems.length, 2);
    editor.newItem(); fillItem(editor); editor.onHide(); env.api.switchMockRole('member'); await editor.onShow(); assert.equal(editor.data.editor, false); assert.equal(editor.data.itemForm.name, ''); assert.equal(editor.data.isOwner, false);
  } finally { env.restore(); }
});

test('points hide invalidates late personal ledgers and a later foreground fetches the wallet again', async () => {
  const env = await setup(true), started = gate(), release = gate(); env.api.switchMockRole('member');
  env.intercept(async (action, payload, revision, real) => { const result = await real.call(action, payload, revision); if (action === 'points.wallet') { started.release(); await release.promise; } return result; });
  try {
    const p = page('points/index'), pending = p.load(); await started.promise; p.onHide(); release.release(); await pending;
    assert.equal(p.data.member, null); assert.equal(p.data.wallet, null); assert.deepEqual(p.data.items, []); assert.deepEqual(p.data.walletItems, []);
    env.intercept(null); env.calls.length = 0; await p.onShow(); assert.equal(p.data.wallet.balance, 100); assert.equal(p.data.items.length, 1); assert.deepEqual(env.calls.map(row => row.action).sort(), ['points.mine', 'points.wallet']);
  } finally { env.restore(); }
});

test('confirmation actor changes and environment changes stop writes and do not transfer an unknown intent', async () => {
  const env = await setup(true);
  try {
    const item = await createItem(env); env.api.switchMockRole('member'); const p = page(); await p.load(); p.selectItem(event({ id: item.id })); env.calls.length = 0;
    env.modal(() => { env.api.switchMockRole('founder'); return true; }); await p.submit(); assert(!env.calls.some(row => row.action === 'redemption.request')); assert.notEqual(p.data.member?.memberKind, 'regular'); assert.equal(p.data.selected, null);
    env.modal(null); env.api.switchMockRole('member'); await p.load(); p.selectItem(event({ id: item.id })); env.intercept((action, payload, revision, real) => action === 'redemption.request' ? Promise.reject(new real.ApiError('NETWORK', '结果待核对')) : real.call(action, payload, revision));
    await p.submit(); assert(p.data.orderIntent); const original = p.data.orderIntent.payload.submissionId;
    env.api.switchMockRole('founder'); const other = page(); await other.load(); assert.equal(other.data.orderIntent, null);
    env.api.switchMockRole('member'); const previous = env.runtime.envId; env.runtime.envId = 'another-test-environment'; const switched = page(); await switched.load(); assert.equal(switched.data.orderIntent, null);
    env.runtime.envId = previous; const reopened = page(); await reopened.load(); assert.equal(reopened.data.orderIntent.payload.submissionId, original);
  } finally { env.restore(); }
});

test('unknown intent recovery rechecks the server price before resubmitting and ordinary accounts have no management data', async () => {
  const env = await setup(true);
  try {
    const item = await createItem(env); env.api.switchMockRole('member'); const p = page(); await p.load(); p.selectItem(event({ id: item.id }));
    env.intercept((action, payload, revision, real) => action === 'redemption.request' ? Promise.reject(new real.ApiError('NETWORK', '结果待核对')) : real.call(action, payload, revision));
    await p.submit(); assert(p.data.orderIntent);
    const [key, stored] = [...env.storage.entries()].find(([key]) => key.startsWith('oradv-redemption-order-v1-')); env.storage.set(key, { ...stored, cost: 1 }); env.intercept(null);
    const reopened = page(); await reopened.load(); env.calls.length = 0; await reopened.recoverOrder(); assert(reopened.data.error.includes('变化')); assert(!env.calls.some(row => row.action === 'redemption.request')); assert(reopened.data.orderIntent);
    const denied = page('redemption/index', { mode: 'manage' }); await denied.load(); assert.equal(denied.data.isOwner, false); assert.deepEqual(denied.data.adminItems, []); assert.equal(denied.data.policyHead, null); assert(denied.data.error.includes('经理'));
  } finally { env.restore(); }
});

test('both zero and one use owner authorization for policy, drafts and archive; account changes inside confirmation stop creation', async () => {
  const env = await setup();
  try {
    const policy = page('redemption/index', { mode: 'manage' }); policy.setData({ managePane: 'policy' }); await policy.load(); assert.equal(policy.data.policyHead.version, 0);
    policy.policyToggle(event({}, true)); policy.rewardMode(event({}, '1')); policy.policyField(event({ field: 'policyText' }, '新活动逐场核定兑换奖励，交付前可取消申请。')); policy.policyField(event({ field: 'policyReason' }, '核定俱乐部初次兑换规则')); await policy.savePolicy();
    assert.equal(policy.data.error, ''); assert.equal(policy.data.policyHead.version, 1); assert.equal(policy.data.policyHead.defaultRewardMode, 'zero');
    let managerRole, manager;
    for (const role of ['operator', 'leader', 'checkin', 'member', 'founder']) { env.api.switchMockRole(role); const current = await env.api.currentMember(); if (current.memberNumber === 1) { managerRole = role; manager = current; break; } }
    assert(manager, 'the positive fixture sequence contains member one'); env.api.switchMockRole('owner'); assert.equal((await env.api.currentMember()).memberNumber, 0);
    await env.api.call('staff.roles.assign', { memberId: manager.id, role: 'owner', enabled: true, activityIds: null });
    env.api.switchMockRole(managerRole); const admin = page('redemption/index', { mode: 'manage' }); await admin.load(); assert.equal(admin.data.member.memberNumber, 1); assert.equal(admin.data.isOwner, true);
    admin.newItem(); fillItem(admin); await admin.saveItem(); assert.equal(admin.data.error, ''); const draft = admin.data.adminItems[0]; admin.openItem(event({ id: draft.id })); admin.itemField(event({ field: 'name' }, '更改后的骑行手套')); admin.itemField(event({ field: 'reason' }, '核定项目称呼'));
    await admin.itemStatus(event({ action: 'publish' })); assert(admin.data.error.includes('先保存')); await admin.saveItem(); admin.openItem(event({ id: draft.id })); admin.itemField(event({ field: 'reason' }, '核实库存后发布')); await admin.itemStatus(event({ action: 'publish' })); assert.equal(admin.data.error, '');
    admin.openItem(event({ id: draft.id })); admin.itemField(event({ field: 'reason' }, '暂停售出，保留既有申请')); await admin.itemStatus(event({ action: 'archive' })); assert.equal(admin.data.error, ''); assert.equal(admin.data.adminItems[0].status, 'archived');
    env.api.switchMockRole('owner'); const original = page('redemption/index', { mode: 'manage' }); await original.load(); original.newItem(); fillItem(original); env.calls.length = 0;
    env.modal(() => { env.api.switchMockRole(managerRole); return true; }); await original.saveItem(); assert(!env.calls.some(row => row.action === 'staff.redemption.catalog.save')); assert.equal(original.data.editor, false); assert.equal(original.data.itemForm.name, '');
  } finally { env.restore(); }
});

test('a rate-limited retry of unknown committed item creation retains the original nonce across reopen', async () => {
  const env = await setup(true);
  try {
    const p = page('redemption/index', { mode: 'manage' }); await p.load(); p.newItem(); fillItem(p); let lose = true;
    env.intercept(async (action, payload, revision, real) => { const result = await real.call(action, payload, revision); if (action === 'staff.redemption.catalog.save' && lose) { lose = false; throw new real.ApiError('NETWORK', '已提交但响应中断'); } return result; });
    await p.saveItem(); const original = structuredClone(p.data.itemIntent); assert(original);
    env.intercept((action, payload, revision, real) => action === 'staff.redemption.catalog.save' ? Promise.reject(new real.ApiError('RATE_LIMITED', '请稍后重试')) : real.call(action, payload, revision));
    await p.saveItem(); assert.deepEqual(p.data.itemIntent, original);
    const reopened = page('redemption/index', { mode: 'manage' }); await reopened.load(); assert.deepEqual(reopened.data.itemIntent, original);
    env.intercept(null); await reopened.saveItem(); assert.equal(reopened.data.error, ''); assert.equal(reopened.data.adminItems.length, 1); assert.equal(reopened.data.itemIntent, null);
    const creates = env.calls.filter(row => row.action === 'staff.redemption.catalog.save'); assert.equal(creates.length, 3); assert(creates.every(row => row.payload.submissionId === original.payload.submissionId));
  } finally { env.restore(); }
});

test('fixed-role wallet and growth responses for different members never combine, even when the growth ledger is empty', async () => {
  for (const empty of [false, true]) {
    const env = await setup(true); env.api.switchMockRole('member');
    env.intercept(async (action, payload, revision, real) => {
      const result = await real.call(action, payload, revision);
      if (action === 'points.wallet') return { ...result, member: { ...result.member, id: 'different-trusted-member' } };
      if (action === 'points.mine' && empty) return { ...result, items: [] };
      return result;
    });
    try {
      const p = page('points/index'); await p.load(); assert.equal(p.data.member, null); assert.equal(p.data.wallet, null); assert.equal(p.data.summary, null); assert.deepEqual(p.data.items, []); assert.deepEqual(p.data.walletItems, []); assert(p.data.error.includes('身份'));
    } finally { env.restore(); }
  }
});

test('a policy change during the confirmation requires renewed consent and creates no request', async () => {
  const env = await setup(true);
  try {
    const item = await createItem(env); env.api.switchMockRole('member'); const p = page(); await p.load(); p.selectItem(event({ id: item.id }));
    env.modal(async () => { env.api.switchMockRole('owner'); const head = await env.api.call('staff.points.policy.get'); await env.api.call('staff.points.policy.save', { enabled: true, defaultRewardMode: 'growth', ruleText: '更新后的领取与取消规则。', reason: '负责人更新公开规则' }, head.revision); env.api.switchMockRole('member'); return true; });
    env.calls.length = 0; await p.submit(); assert(p.data.error.includes('规则已更新')); assert.equal(p.data.orderIntent, null); assert(!env.calls.some(row => row.action === 'redemption.request')); assert.equal((await env.api.call('points.wallet')).held, 0);
  } finally { env.restore(); }
});
