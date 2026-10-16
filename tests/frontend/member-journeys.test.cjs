const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('member pages distinguish founder participation, manual confirmation, private trips and public consents', async () => {
  const storage = new Map();
  let clipboard = '';
  const dialed = [];
  global.wx = {
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    removeStorageSync: key => storage.delete(key),
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    showToast: () => {}, showModal: async () => ({ confirm: true, cancel: false }),
    setClipboardData: async ({ data }) => { clipboard = data; return {}; }, makePhoneCall: async ({ phoneNumber }) => { dialed.push(phoneNumber); return {}; },
    navigateTo: () => {}, switchTab: () => {}, stopPullDownRefresh: () => {},
  };
  const root = path.resolve(__dirname, '../../app/miniprogram');
  const captured = new Map();
  function capture(name) {
    let definition = captured.get(name);
    if (!definition) {
      global.Page = value => { definition = value; };
      require(path.join(root, 'pages', name + '.js'));
      assert.ok(definition, `${name} registers native Page`);
      captured.set(name, definition);
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
  const api = require(path.join(root, 'services/api.js'));
  const { contactPerson } = require(path.join(root, 'services/member.js'));
  await contactPerson('phone', '+1 (202) 555-0100');
  assert.deepEqual(dialed, ['+12025550100'], 'approved formatted phone contacts use the native dialer with normalized digits');
  assert.equal(clipboard, '', 'a phone contact must not unexpectedly switch to clipboard mode');
  api.resetMock('empty');
  api.switchMockRole('owner');
  const activity = await api.call('activity.get', { activityId: 'intro-ride' });
  await api.call('staff.briefing.save', {
    activityId: activity.id, meetingPoint: '仅确认成员可见的演示集合点', meetingTime: activity.startAt,
    contactName: '演示领队', contactMethod: 'wechat', contactValue: 'demo-trip-contact',
    checklist: ['核对必要护具', '按本场要求准备补给'], notes: '这是参加者专属资料。',
  }, 0);

  api.switchMockRole('guest');
  const guestTrip = capture('trip/detail'); guestTrip.setData({ id: activity.id });
  await guestTrip.load();
  assert.equal(guestTrip.data.member, null);
  assert.equal(guestTrip.data.briefing, null);

  const apply = capture('registration/apply'); apply.setData({ id: activity.id });
  await apply.load(); apply.setData({ identityConsent: true, ruleConsent: true });
  await apply.submit();
  assert.equal(apply.data.error, '');
  assert.equal(apply.data.result.state, 'pending_confirmation');
  assert.equal(apply.data.feeHint, true, 'only eligible held ordinary application gets offline arrangement prompt');
  const memberId = (await api.currentMember()).id;
  const memberTrip = capture('trip/detail'); memberTrip.setData({ id: activity.id });
  await memberTrip.load();
  assert.equal(memberTrip.data.error, '');
  assert.equal(memberTrip.data.canReadBriefing, false);
  assert.equal(memberTrip.data.briefing, null);
  assert(!JSON.stringify(memberTrip.data).includes('仅确认成员可见的演示集合点'));
  await assert.rejects(() => api.call('activity.briefing.get', { activityId: activity.id }));

  api.switchMockRole('owner');
  await api.call('staff.registration.confirm', { registrationId: apply.data.result.id }, apply.data.result.revision);
  api.switchMockRole('member');
  await memberTrip.load();
  assert.equal(memberTrip.data.canReadBriefing, true);
  assert.equal(memberTrip.data.briefing.meetingPoint, '仅确认成员可见的演示集合点');
  assert.equal(memberTrip.data.checklist.length, 2);
  memberTrip.checklist({ detail: { value: ['0'] } });
  await memberTrip.load();
  assert.equal(memberTrip.data.checklist[0].checked, true, 'preparation checkboxes persist without becoming verification');
  assert.equal(memberTrip.data.records.length, 0, 'preparation checkbox does not create field verification');
  await memberTrip.cancel();
  assert.equal(memberTrip.data.registration.state, 'cancelled');
  assert.equal(memberTrip.data.briefing, null, 'cancel refresh clears previously loaded private data');
  await assert.rejects(() => api.call('activity.briefing.get', { activityId: activity.id }));

  api.switchMockRole('founder');
  const founderApply = capture('registration/apply'); founderApply.setData({ id: activity.id });
  await founderApply.load(); founderApply.setData({ ruleConsent: true }); await founderApply.submit();
  assert.equal(founderApply.data.result.state, 'confirmed');
  assert.equal(founderApply.data.feeHint, false);
  assert.equal((await api.currentMember()).growthPoints, 0);
  assert.deepEqual((await api.currentMember()).roles, [], 'founder identity grants no employee role');
  const founderId = (await api.currentMember()).id;

  api.switchMockRole('member');
  const profile = capture('profile/index'); await profile.load();
  assert.equal(profile.data.memberNumber, memberId.slice(-8));
  await profile.copyMemberNumber();
  assert.equal(clipboard, memberId.slice(-8), 'own member identifier can be shared through an existing trusted channel');
  assert.equal(profile.data.member.memberKind, 'regular', 'copying an identifier grants no member privilege');
  profile.setData({ kindReason: '申请核对既有称呼' }); await profile.requestKind();
  assert.equal(profile.data.member.memberKind, 'regular', 'request does not grant founder identity');
  assert.equal(profile.data.member.kindRequestStatus, 'pending');
  await profile.recommendation();
  assert.equal(profile.data.member.recommendationOptIn, true);
  assert.equal(profile.data.member.rankingOptIn, false, 'recommendation consent cannot publish points');
  let recommended = await api.call('recommendation.list');
  assert.equal(recommended.items.length, 1);
  assert.equal(recommended.items[0].growthPoints, undefined);
  assert.equal(recommended.items[0].completedCount, undefined);

  api.switchMockRole('founder'); await profile.load(); await profile.recommendation();
  const club = capture('ranking/index'); await club.load();
  assert.equal(club.data.mode, 'recommended');
  assert.equal(club.data.recommendations.length, 2);
  assert.equal(club.data.recommendations[0].memberKind, 'founder');
  assert.equal(club.data.items.length, 0, 'recommendation opt-in has not joined the actual points leaderboard');
  const ownFounder = await api.currentMember();
  assert.equal(ownFounder.id, founderId);
  await profile.recommendation(); await club.load();
  assert.equal(club.data.recommendations.length, 1, 'recommendation withdrawal removes entry');
  assert.equal((await api.currentMember()).memberKind, 'founder', 'withdrawal leaves member identity intact');
  api.switchMockRole('member');
  assert.equal((await api.currentMember()).id, memberId);
  await profile.load(); await profile.rankingConsent();
  assert.equal(profile.data.member.rankingOptIn, true);
  recommended = await api.call('recommendation.list');
  assert.equal(recommended.items[0].growthPoints, 0, 'points become public only after separate consent');

  api.switchMockRole('owner');
  let small = await api.call('staff.activity.save', {
    title: '名额与行前资料边界测试', description: activity.description, location: activity.location,
    difficulty: activity.difficulty, startAt: activity.startAt, endAt: activity.endAt,
    applicationClosesAt: activity.applicationClosesAt, capacity: 1, minGrowthPoints: 0,
    requiredQualifications: [], requiresReview: false, pointsRule: activity.pointsRule,
    safetyNotice: activity.safetyNotice, equipment: activity.equipment,
  });
  small = await api.call('staff.activity.publish', { activityId: small.id }, small.revision);
  api.switchMockRole('founder');
  const noBriefingApply = capture('registration/apply'); noBriefingApply.setData({ id: small.id });
  await noBriefingApply.load(); noBriefingApply.setData({ ruleConsent: true }); await noBriefingApply.submit();
  assert.equal(noBriefingApply.data.result.state, 'confirmed');
  const noBriefingTrip = capture('trip/detail'); noBriefingTrip.setData({ id: small.id });
  await noBriefingTrip.load();
  assert.equal(noBriefingTrip.data.error, '');
  assert.equal(noBriefingTrip.data.briefing, null);
  assert.equal(noBriefingTrip.data.briefingError, '行前安排尚未发布，请联系负责人');
  api.switchMockRole('member');
  const waitlistApply = capture('registration/apply'); waitlistApply.setData({ id: small.id });
  await waitlistApply.load(); waitlistApply.setData({ ruleConsent: true }); await waitlistApply.submit();
  assert.equal(waitlistApply.data.result.state, 'waitlisted');
  assert.equal(waitlistApply.data.feeHint, false, 'waitlist must not prompt offline payment');
  api.switchMockRole('owner');
  const cancelTarget = await api.call('activity.get', { activityId: small.id });
  await api.call('staff.activity.cancel', { activityId: small.id, reason: '演示活动取消边界验证' }, cancelTarget.revision);
  api.switchMockRole('founder'); await noBriefingTrip.load();
  assert.equal(noBriefingTrip.data.registration.state, 'confirmed', 'activity cancellation preserves registration history');
  assert.equal(noBriefingTrip.data.registration.stateText, '活动已取消');
  assert.equal(noBriefingTrip.data.canReadBriefing, false);
  assert.equal(noBriefingTrip.data.feeHint, false);
  assert.equal(noBriefingTrip.data.briefing, null);
});
