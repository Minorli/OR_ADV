const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../app/miniprogram');

test('staff roster gives every unreturned rider equal safety priority and filters today accurately', () => {
  const { rosterPresentation } = require(path.join(root, 'pages/staff/roster.js'));
  const today = '2026-10-15';
  const base = { state: 'checked_in', lastDepartureDay: today, queueSeq: 1 };
  const rows = [
    { ...base, id: 'founder-returned', nickname: '已回场', memberKind: 'founder', lastReturnDay: today, queueSeq: 0 },
    { ...base, id: 'regular-out', nickname: '普通车友', memberKind: 'regular', confirmationPath: 'staff_manual', queueSeq: 2 },
    { ...base, id: 'founder-out', nickname: '创始车友', memberKind: 'founder', confirmationPath: 'founder_direct', queueSeq: 3 },
    { ...base, id: 'yesterday-returned', nickname: '昨日已回场', memberKind: 'regular', lastDepartureDay: '2026-10-14', lastReturnDay: '2026-10-14' },
  ];
  const result = rosterPresentation(rows, today);
  assert.equal(result.unreturnedCount, 2);
  assert.equal(result.todayDepartureCount, 3);
  assert.equal(result.todayReturnCount, 1);
  assert.deepEqual(result.visible.slice(0, 2).map(item => item.id), ['regular-out', 'founder-out']);
  assert.equal(result.visible.find(item => item.id === 'founder-out').confirmationText, '创始身份自动确认');
  assert.deepEqual(rosterPresentation(rows, today, 'unreturned', '普通').visible.map(item => item.id), ['regular-out']);
  assert.equal(rosterPresentation(rows, today, 'today').visible.length, 3);
  const sameName = [{ ...base, id: 'one', nickname: '同名车友', memberId: 'member-12345678' }, { ...base, id: 'two', nickname: '同名车友', memberId: 'member-87654321' }];
  assert.deepEqual(rosterPresentation(sameName, today).visible.map(item => item.memberCode), ['12345678', '87654321']);
  assert.deepEqual(rosterPresentation(sameName, today, 'all', '87654321').visible.map(item => item.id), ['two']);
});

test('owner native member controls use revisions and cannot force public consent or grant a staff role through founder status', async () => {
  const storage = new Map();
  global.wx = {
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    removeStorageSync: key => storage.delete(key),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    showToast: () => {}, showModal: async () => ({ confirm: true, cancel: false }),
    navigateTo: () => {}, navigateBack: () => {}, switchTab: () => {}, stopPullDownRefresh: () => {},
  };
  const api = require(path.join(root, 'services/api.js'));
  api.resetMock('empty'); api.switchMockRole('member');
  const member = await api.call('identity.ensure', { consentVersions: { privacy: 1, terms: 1 }, nickname: '成员管理验收' });
  api.switchMockRole('owner');
  let definition;
  global.Page = value => { definition = value; };
  require(path.join(root, 'pages/staff-members/index.js'));
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = values => {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split('.'); let target = page.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
  };
  await page.load();
  assert.equal(page.data.authorized, true);
  assert.equal(page.data.error, '');
  const target = page.data.items.find(item => item.memberId === member.id || item.id === member.id);
  assert.ok(target);
  assert.equal(target.memberCode, member.id.slice(-8));
  await page.select({ currentTarget: { dataset: { id: target.id } } });
  assert.equal(page.data.error, '');
  page.setData({ reason: '核对主理人已有创始会员名册', expiryDate: '' });
  await page.assignKind({ currentTarget: { dataset: { kind: 'founder' } } });
  assert.equal(page.data.error, '');
  assert.equal(page.data.selected.memberKind, 'founder');
  assert(page.data.selected.revision > target.revision);
  page.setData({ reason: '调整推荐顺序，等待本人自主选择公开', priority: '12' });
  await page.savePriority();
  assert.equal(page.data.error, '');
  assert.equal(page.data.selected.recommendationOptIn, false);
  api.switchMockRole('member');
  const after = await api.currentMember();
  assert.equal(after.memberKind, 'founder');
  assert.deepEqual(after.roles, []);
  assert.equal((await api.call('recommendation.list')).items.some(item => item.nickname === member.nickname), false);
  await page.load();
  assert.equal(page.data.authorized, false);
  assert.equal(page.data.items.length, 0);
});
