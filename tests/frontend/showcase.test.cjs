const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('native modules open with populated local demonstrations and reset without touching earlier data', async () => {
  const previousStore = { retained: 'v0.2 local rehearsal' };
  const storage = new Map([
    ['oradv-beta-store-v2', previousStore], ['oradv-beta-identity-v2', 'owner'],
    ['oradv-checklist-old-registration-1', ['0']],
  ]);
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    removeStorageSync: key => storage.delete(key),
    showToast: () => {}, showModal: async () => ({ confirm: true, cancel: false }),
    navigateTo: () => {}, navigateBack: () => {}, switchTab: () => {}, stopPullDownRefresh: () => {},
  };
  const root = path.resolve(__dirname, '../../app/miniprogram');
  const definitions = new Map();
  function page(name) {
    let definition = definitions.get(name);
    if (!definition) {
      global.Page = value => { definition = value; };
      require(path.join(root, 'pages', name + '.js'));
      assert.ok(definition, `${name} registers a native Page`);
      definitions.set(name, definition);
    }
    const instance = { ...definition, data: structuredClone(definition.data) };
    instance.setData = values => {
      for (const [key, value] of Object.entries(values)) {
        const parts = key.split('.'); let target = instance.data;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = value;
      }
    };
    return instance;
  }
  const apiPath = path.join(root, 'services/api.js');
  const api = require(apiPath);
  assert.equal(api.mockRole(), 'guest', 'earlier rehearsal identity is not silently reused');
  assert.equal(await api.currentMember(), null);
  const activities = page('activities/index'); await activities.load();
  assert.equal(activities.data.error, '');
  assert.equal(activities.data.filter, 'all', 'reference home includes the public upcoming and recent activity cards');
  assert(activities.data.items.every(item => item.state !== 'draft'), 'the default public view never includes drafts');
  activities.setData({ filter: 'published' }); await activities.load();
  assert(activities.data.items.length > 0 && activities.data.items.every(item => item.state === 'published'), 'recruitment filtering remains a functioning public control');
  activities.setData({ filter: 'all' }); await activities.load();
  for (const id of ['intro-ride', 'day-trip', 'ongoing-ride', 'history-ride', 'full-ride']) {
    assert(activities.data.items.some(item => item.id === id), `${id} has an activity card`);
  }
  assert(!activities.data.items.some(item => item.id === 'draft-ride'), 'internal draft is not public');

  const club = page('ranking/index'); await club.load();
  assert.equal(club.data.error, '');
  assert(club.data.items.length > 0, 'points leaderboard is ready to inspect');
  assert(club.data.recommendations.length > 0, 'club recommendations are ready to inspect');
  assert.equal(club.data.recommendations[0].memberKind, 'founder');

  api.switchMockRole('member');
  const mine = page('mine/index'); await mine.load();
  assert.equal(mine.data.error, '');
  assert(mine.data.items.some(item => item.activityId === 'history-ride' && item.state === 'completed'));
  assert(mine.data.items.some(item => item.activityId === 'day-trip' && item.state === 'confirmed'));
  assert(mine.data.items.some(item => item.activityId === 'full-ride' && item.state === 'waitlisted'));
  assert(!mine.data.items.some(item => item.activityId === 'intro-ride'), 'intro remains available for a fresh application');
  const points = page('points/index'); await points.load();
  assert.equal(points.data.error, '');
  assert(points.data.summary.growthPoints > 0);
  assert(points.data.items.some(item => item.activityId === 'history-ride'));
  const profile = page('profile/index'); await profile.load();
  const defaultNickname = profile.data.member.nickname;
  assert.equal(profile.data.member.rankingOptIn, false);
  assert.equal(profile.data.member.recommendationOptIn, false, 'main rider keeps separate public consents unset');
  profile.nickname({ detail: { value: '改名后的演示车友' } });
  profile.nicknameBlur({ detail: { value: '改名后的演示车友' } });
  profile.nicknameReview({ detail: { pass: true, timeout: false } }); await profile.save();
  assert.equal(profile.data.member.nickname, '改名后的演示车友');
  const trip = page('trip/detail'); trip.setData({ id: 'day-trip' }); await trip.load();
  assert.equal(trip.data.error, '');
  assert.equal(trip.data.canReadBriefing, true);
  assert(trip.data.briefing?.meetingPoint);
  assert(trip.data.checklist.length > 0);
  trip.checklist({ detail: { value: ['0'] } });
  assert.equal(trip.data.checklist[0].checked, true);

  api.switchMockRole('owner');
  const staff = page('staff/index'); await staff.load();
  assert.equal(staff.data.error, '');
  assert.equal(staff.data.selected.id, 'ongoing-ride');
  assert(staff.data.unreturnedCount > 0);
  assert(staff.data.todayDepartureCount > 0);
  assert(staff.data.items.some(item => item.id === 'draft-ride'));
  staff.setData({ selected: staff.data.items.find(item => item.id === 'settlement-ride') });
  await staff.loadRoster(); await staff.preview();
  assert.equal(staff.data.error, '');
  assert(staff.data.preview.eligibleCount > 0);
  staff.setData({ selected: staff.data.items.find(item => item.id === 'full-ride') });
  await staff.loadRoster();
  assert(staff.data.registrations.some(item => item.state === 'waitlisted'));
  const members = page('staff-members/index'); await members.load();
  assert.equal(members.data.error, '');
  assert(members.data.items.length > 0);
  assert(members.data.nextCursor, 'member directory includes a second page');
  await members.loadMembers(true);
  assert(members.data.items.length > 20);

  // Use the actual profile control so its default reset cannot drift from the API.
  await profile.reset();
  assert.equal(api.mockRole(), 'guest');
  api.switchMockRole('member'); await trip.load();
  assert.equal((await api.currentMember()).nickname, defaultNickname, 'reset restores the fictional member records');
  assert.equal(trip.data.checklist[0].checked, false, 'reset restores preparation checkboxes too');
  assert.deepEqual(storage.get('oradv-beta-store-v2'), previousStore);
  assert.equal(storage.get('oradv-beta-identity-v2'), 'owner');
  assert.deepEqual(storage.get('oradv-checklist-old-registration-1'), ['0'], 'legacy or real checklist is untouched');
  assert(storage.has('oradv-beta-store-v3'));
  assert.equal(storage.get('oradv-beta-identity-v3'), 'member');

  const member = await api.currentMember();
  await api.call('profile.update', { nickname: '演示改名已保存' }, member.revision);
  delete require.cache[require.resolve(apiPath)];
  const reopened = require(apiPath);
  assert.equal(reopened.mockRole(), 'member');
  assert.equal((await reopened.currentMember()).nickname, '演示改名已保存', 'v3 local changes survive reopening');
});
