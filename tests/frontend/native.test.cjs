const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const load = createRequire(__filename);

test('native pages preserve consent and role/data state across navigation', async () => {
  const storage = new Map();
  let notices = 0;
  Object.assign(globalThis, {
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      showToast: () => { notices++; },
      showModal: async () => ({ confirm: true, cancel: false }),
      navigateTo: () => {}, switchTab: () => {}, stopPullDownRefresh: () => {},
    },
  });
  // Native Page registration is captured; handlers and RPC are the built product code.
  const capture = (relative) => {
    let definition;
    Object.assign(globalThis, { Page: (value) => { definition = value; } });
    load('../../app/miniprogram/' + relative + '.js');
    assert.ok(definition, 'page registered');
    const instance = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
    instance.setData = (values) => Object.assign(instance.data, values);
    return instance;
  };
  const api = load('../../app/miniprogram/services/api.js');
  api.resetMock();
  assert.equal(await api.currentMember(), null);
  const result = await api.call('activity.list');
  const activity = result.items.find((item) => item.minGrowthPoints === 0);
  assert.ok(activity, 'new rider has an entry activity');
  const form = capture('pages/registration/apply');
  form.setData({ id: activity.id });
  await form.load();
  await form.submit();
  assert.equal(await api.currentMember(), null, 'no consent means no identity');
  assert.ok(notices > 0);
  form.setData({ identityConsent: true, ruleConsent: true, nickname: '内测车友' });
  await form.submit();
  assert.equal(form.data.error, '');
  assert.ok(form.data.success);
  const member = await api.currentMember();
  assert.equal(member.growthPoints, 0, 'registration gives no points');
  assert.deepEqual(member.roles, [], 'registration grants no staff role');
  await form.submit();
  const mine = capture('pages/mine/index');
  await mine.load();
  assert.equal(mine.data.items.length, 1, 'double click creates one registration');
  api.switchMockRole('owner');
  await mine.load();
  assert.ok(mine.data.member.roles.includes('owner'), 'previously loaded page sees changed API singleton identity');
  api.switchMockRole('member');
  await mine.load();
  assert.equal(mine.data.member.id, member.id, 'returning page restores original member');
  assert.equal(mine.data.items.length, 1, 'data survives page/role changes');
  await mine.cancel({ currentTarget: { dataset: { id: mine.data.items[0].id } } });
  assert.equal(mine.data.items[0].state, 'cancelled');
  assert.equal((await api.currentMember()).growthPoints, 0);
});
