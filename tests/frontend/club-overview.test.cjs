const { freshPageModule } = require('./native-harness.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const app = path.resolve(__dirname, '../../app/miniprogram');
const apiPath = path.join(app, 'services/api.js');
function environment() {
  const storage = new Map(), routes = [];
  global.wx = {
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: key => storage.delete(key),
    showToast() {}, async showModal() { return { confirm: true }; }, stopPullDownRefresh() {},
    navigateTo: value => routes.push(value.url), switchTab: value => routes.push(value.url),
  };
  delete require.cache[require.resolve(apiPath)]; delete require.cache[require.resolve(path.join(app, 'services/member-media.js'))];
  const api = require(apiPath); api.resetMock('empty'); return { api, routes };
}
function page(name) {
  let definition; global.Page = value => { definition = value; };
  const file = path.join(app, 'pages', name + '.js'); freshPageModule(file);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = values => Object.assign(instance.data, values);
  return instance;
}
const pause = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function apply(api) {
  const activities = await api.call('activity.list', { state: 'published' });
  const activity = activities.items.find(item => item.minGrowthPoints === 0);
  await api.call('registration.apply', { activityId: activity.id, acceptedRuleVersion: activity.ruleVersion });
  return activity;
}

test('home shows only published partner content and ranking uses its real own public position', async () => {
  const { api, routes } = environment();
  const home = page('activities/index'); await home.load();
  assert(home.data.items.length > 0); assert.equal(home.data.partnersConfigured, false);
  api.switchMockRole('owner');
  const content = { title: '内测合作说明', introduction: '用于验证页面的虚构合作资料。', blocks: [{ heading: '演示装备伙伴', body: '展示经负责人核定的实际合作说明，不含价格或服务承诺。' }], people: [], contacts: [], offers: [] };
  const published = await api.call('staff.club.content.save', { section: 'partners', content, status: 'published', rightsAcknowledged: true }, 0);
  api.switchMockRole('member'); const activity = await apply(api); await home.load();
  assert.equal(home.data.error, ''); assert.equal(home.data.partnersConfigured, true);
  assert.equal(home.data.partners[0].heading, '演示装备伙伴'); assert.equal(home.data.nextTrip.activityId, activity.id);
  assert.equal(home.data.heroSlides.length, 4);
  home.partners(); assert.equal(home.data.refPanel, 'partners');
  home.learning(); assert.equal(home.data.refPanel, 'learning'); home.trip();
  assert(routes.some(route => route.startsWith('/pages/trip/detail?id=')));
  const ranking = page('ranking/index'); await ranking.load();
  assert.equal(ranking.data.error, ''); assert.equal(ranking.data.ownRanking.rankingOptIn, false);
  assert.equal(ranking.data.ownRanking.rank, null); assert.equal(ranking.data.ownRanking.publicCount, null);
  const pointsBefore = ranking.data.member.growthPoints;
  await ranking.optIn();
  assert.equal(ranking.data.ownRanking.rankingOptIn, true); assert.equal(ranking.data.ownRanking.rank, 1); assert.equal(ranking.data.ownRanking.publicCount, 1);
  assert.equal(ranking.data.member.growthPoints, pointsBefore);
  ranking.duties(); assert.equal(ranking.data.refPanel, 'core'); ranking.rules(); assert.equal(ranking.data.refPanel, 'rules');
  await ranking.optIn(); assert.equal(ranking.data.ownRanking.rank, null); assert.equal(ranking.data.ownRanking.publicCount, null);
  api.switchMockRole('owner');
  await api.call('staff.club.content.save', { section: 'partners', content, status: 'draft' }, published.revision);
  await home.load(); assert.equal(home.data.partnersConfigured, false); assert.equal(home.data.partners.length, 0); assert(home.data.items.length > 0);
});

test('home removes private header before awaiting and discards the old identity registration response', async () => {
  const { api } = environment(); api.switchMockRole('member'); await apply(api);
  const entered = pause(), release = pause(), module = require.cache[require.resolve(apiPath)], real = module.exports;
  let held = false;
  module.exports = { ...real, async call(action, ...args) {
    const result = await real.call(action, ...args);
    if (action === 'registration.mine' && !held) { held = true; entered.release(); await release.promise; }
    return result;
  } };
  try {
    const home = page('activities/index'), original = await api.currentMember();
    home.setData({ member: original, kindLabel: '旧身份', nextTrip: { title: '旧私人同行' } });
    const pending = home.load();
    assert.equal(home.data.member, null); assert.equal(home.data.nextTrip, null); assert.equal(home.data.kindLabel, '游客');
    await entered.promise; api.switchMockRole('founder'); release.release(); await pending;
    assert.equal(home.data.member, null); assert.equal(home.data.nextTrip, null);
    await home.load(); assert.notEqual(home.data.member.id, original.id); assert.equal(home.data.nextTrip, null);
  } finally { module.exports = real; }
});

test('a delayed own-rank callback cannot replace the newly loaded identity or its private ranking state', async () => {
  const { api } = environment(); api.switchMockRole('member'); const original = await api.currentMember();
  await api.call('profile.update', { rankingOptIn: true, rankingConsentVersion: 1 }, original.revision);
  const entered = pause(), release = pause(), module = require.cache[require.resolve(apiPath)], real = module.exports;
  let held = false;
  module.exports = { ...real, async call(action, ...args) {
    const result = await real.call(action, ...args);
    if (action === 'ranking.mine' && !held) { held = true; entered.release(); await release.promise; }
    return result;
  } };
  try {
    const ranking = page('ranking/index'), pending = ranking.load(); await entered.promise;
    api.switchMockRole('founder'); await ranking.load();
    const nextId = ranking.data.member.id; assert.notEqual(nextId, original.id); assert.equal(ranking.data.ownRanking.rankingOptIn, false);
    release.release(); await pending;
    assert.equal(ranking.data.member.id, nextId); assert.equal(ranking.data.ownRanking.rank, null); assert.equal(ranking.data.ownRanking.publicCount, null);
    assert.equal(ranking.data.ownRankingError, '');
  } finally { module.exports = real; }
});
