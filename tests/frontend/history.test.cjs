const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('public archive browses settled events without login or private member records', async () => {
  const storage = new Map(), navigated = [];
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    navigateTo: value => navigated.push(value.url), switchTab: value => navigated.push(value.url),
    showToast: () => {}, showModal: async () => ({ confirm: true }), stopPullDownRefresh: () => {},
  };
  const root = path.resolve(__dirname, '../../app/miniprogram');
  const api = require(path.join(root, 'services/api.js'));
  api.resetMock();
  let definition;
  global.Page = value => { definition = value; };
  require(path.join(root, 'pages/history/index.js'));
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = values => Object.assign(page.data, values);
  await page.load();
  assert.equal(page.data.error, '');
  assert.equal(await api.currentMember(), null, 'public archive does not create a membership');
  assert.equal(page.data.items.length, 3);
  assert(page.data.items.every(row => row.cover.startsWith('/assets/covers/')));
  for (const row of page.data.items) assert.equal((await api.call('activity.get', { activityId: row.id })).state, 'settled', 'every feed card still represents a genuinely settled activity');
  assert(!JSON.stringify(page.data.items).match(/memberId|wxOpenId|meetingPoint|contactValue|avatarFileId/));
  assert(page.data.items.every(row => !('safetyNotice' in row.activity || 'equipment' in row.activity || 'nextQueueSeq' in row.activity)), 'the complete public feed retains explicit public projection and excludes operational records');
  assert(page.data.items.every(row => Array.isArray(row.photos) && Array.isArray(row.reviewPreviews) && row.reviewPreviews.length <= 2), 'reference cards include real bounded media and review previews');
  assert(page.data.items[0].startAt >= page.data.items[1].startAt, 'loaded archive is newest first');
  page.search({ detail: { value: '砂石' } }); await page.load();
  assert.equal(page.data.visibleItems.length, 1);
  assert.equal(page.data.visibleItems[0].id, 'history-training');
  page.search({ detail: { value: '不存在的行程' } }); await page.load();
  assert.equal(page.data.visibleItems.length, 0);
  page.search({ detail: { value: '' } });
  const month = page.data.months.find(row => row.value !== 'all');
  page.selectMonth({ currentTarget: { dataset: { month: month.value } } }); await page.load();
  assert(page.data.visibleItems.every(row => row.archiveMonth === month.value));
  page.open({ currentTarget: { dataset: { id: 'history-ride' } } });
  assert.equal(navigated.at(-1), '/pages/history-detail/index?activityId=history-ride');
  const actor = api.mockRole();
  assert.equal(actor, 'guest');
});
