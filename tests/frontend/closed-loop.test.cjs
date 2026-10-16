const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('built native pages complete the staff/member loop and reversible ranking consent', async () => {
  const storage = new Map();
  global.wx = {
    getStorageSync: (key) => storage.get(key),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    removeStorageSync: key => storage.delete(key),
    setStorageSync: (key, value) => storage.set(key, value),
    showToast: () => {},
    showModal: async () => ({ confirm: true, cancel: false }),
    navigateTo: () => {}, switchTab: () => {}, stopPullDownRefresh: () => {},
  };
  const root = path.resolve(__dirname, '../../app/miniprogram');
  function capture(name) {
    let definition;
    global.Page = (value) => { definition = value; };
    require(path.join(root, 'pages', name + '.js'));
    assert.ok(definition, `${name} registers a native Page`);
    const instance = { ...definition, data: structuredClone(definition.data) };
    instance.setData = (values) => {
      for (const [key, value] of Object.entries(values)) {
        const parts = key.split('.');
        let target = instance.data;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = value;
      }
    };
    return instance;
  }
  const api = require(path.join(root, 'services/api.js'));
  api.resetMock('empty');
  const form = capture('registration/apply');
  form.setData({ id: 'intro-ride' });
  await form.load();
  assert.equal(form.data.member, null);
  form.setData({ identityConsent: true, ruleConsent: true });
  await form.submit();
  assert.equal(form.data.error, '');
  assert.ok(form.data.success);
  assert.equal((await api.currentMember()).growthPoints, 0, 'application does not grant points');

  api.switchMockRole('owner');
  const staff = capture('staff/index');
  await staff.load();
  staff.setData({ selected: staff.data.items.find((activity) => activity.id === 'intro-ride') });
  await staff.loadRoster();
  const event = (action) => ({ currentTarget: { dataset: { id: staff.data.registrations[0].id, action } } });
  await staff.registrationAction(event('approve'));
  assert.equal(staff.data.error, '');
  assert.equal(staff.data.registrations[0].state, 'pending_confirmation');
  await staff.registrationAction(event('confirm'));
  assert.equal(staff.data.registrations[0].state, 'confirmed');
  await staff.lifecycle({ currentTarget: { dataset: { action: 'start' } } });
  assert.equal(staff.data.error, '');
  await staff.registrationAction(event('departure'));
  assert.equal(staff.data.registrations[0].state, 'checked_in');
  await staff.registrationAction(event('return'));
  assert.equal(staff.data.registrations[0].state, 'pending_settlement');
  await staff.lifecycle({ currentTarget: { dataset: { action: 'end' } } });
  assert.equal(staff.data.error, '');
  await staff.preview();
  assert.equal(staff.data.preview.eligibleCount, 1);
  await staff.settle();
  assert.equal(staff.data.error, '');
  assert.equal(staff.data.settlement.status, 'completed');
  await staff.preview();
  await staff.settle();
  assert.equal(staff.data.error, '', 'retrying settlement is safe');

  api.switchMockRole('member');
  const points = capture('points/index');
  await points.load();
  assert.equal(points.data.error, '');
  assert.equal(points.data.summary.growthPoints, 100);
  assert.equal(points.data.summary.completedCount, 1);
  assert.equal(points.data.items.length, 1, 'settlement retry does not duplicate the award');
  const ranking = capture('ranking/index');
  await ranking.load();
  assert.equal(ranking.data.items.length, 0, 'public ranking defaults to private');
  await ranking.optIn();
  assert.equal(ranking.data.error, '');
  assert.equal(ranking.data.items.length, 1);
  await ranking.optIn();
  assert.equal(ranking.data.error, '');
  assert.equal(ranking.data.items.length, 0, 'withdrawal removes public data immediately');

  api.switchMockRole('owner');
  staff.setData({ ledgerId: points.data.items[0].id, reversalReason: '复核原完成核验记录，按纠错流程冲正' });
  await staff.reverse();
  assert.equal(staff.data.error, '');
  api.switchMockRole('member');
  await points.load();
  assert.equal(points.data.summary.growthPoints, 0);
  assert.equal(points.data.summary.completedCount, 0);
  assert.equal(points.data.items.length, 2, 'reversal preserves the original ledger');
  const mine = capture('mine/index');
  await mine.load();
  assert.equal(mine.data.items[0].state, 'completed', 'correction preserves actual completion history');
  assert.equal(mine.data.items[0].stateText, '完成已更正');
});
