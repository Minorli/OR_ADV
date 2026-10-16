import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShowcaseStore, showcaseSnapshot } from '../../shared/demo-showcase';
import { demoSnapshot, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import { completionIdFor, key, memberIdFor, registrationIdFor, shanghaiDay, shanghaiYear, statsIdFor, userIdFor } from '../../shared/models';
import type { Checkin, MemberStats, Membership, Qualification, SettlementJob, StaffRole } from '../../shared/models';
import type { Activity, LedgerEntry, PageResult, PointsResult, RecommendationEntry, Registration, RpcResponse, TrustedIdentity } from '../../shared/types';
import type { StoreSnapshot } from '../../shared/store';

const NOW = '2026-10-16T08:00:00.000Z';
const rows = <T>(snapshot: StoreSnapshot, collection: string) => Object.values(snapshot[collection] ?? {}) as T[];
const memberId = (role: keyof typeof DEMO_IDENTITIES) => memberIdFor('oradv', userIdFor(DEMO_IDENTITIES[role]));
function setup(now = NOW) {
  const store = createShowcaseStore(now);
  const service = createService(store, { now: () => now });
  let sequence = 0;
  const request = async <T>(identity: TrustedIdentity | null, action: string, payload: Record<string, unknown> = {}, expectedRevision?: number) => {
    const response = await service.handle({ action, payload, expectedRevision, clubId: 'oradv', requestId: `showcase-${++sequence}` }, identity) as RpcResponse<T>;
    if (!response.ok) assert.fail(`${action}: ${response.error.code} ${response.error.message}`);
    return response.data;
  };
  return { store, service, request };
}

test('showcase covers every existing module while keeping the minimal fixture independent', () => {
  const snapshot = showcaseSnapshot(NOW);
  const activities = rows<Activity>(snapshot, 'activities');
  assert.equal(activities.length, 11);
  assert.equal(rows(snapshot, 'memberships').length, 24);
  assert.deepEqual(new Set(activities.map(row => row.state)), new Set(['draft', 'published', 'in_progress', 'ended', 'settled', 'cancelled']));
  for (const name of ['registrations', 'activity_briefings', 'checkins', 'points_ledger', 'member_stats', 'public_rankings', 'public_recommendations', 'qualifications', 'settlement_jobs', 'audit_logs']) {
    assert(rows(snapshot, name).length > 0, `${name} has examples`);
  }
  assert(activities.every(row => row.fixtureOnly && row.title.includes('演示')));
  assert(rows<Membership>(snapshot, 'memberships').every(row => row.nickname.includes('演示')));
  assert(rows<Membership>(snapshot, 'memberships').filter(row => row.memberKind === 'founder').length >= 3);
  const baseline = demoSnapshot(NOW);
  assert.equal(rows(baseline, 'activities').length, 3);
  assert.equal(rows(baseline, 'memberships').length, 6);
  assert.equal(rows(baseline, 'registrations').length, 0);
  snapshot.activities['intro-ride'] = null;
  assert(showcaseSnapshot(NOW).activities['intro-ride'], 'factory returns independent snapshots');
});

test('showcase registrations, capacity and FIFO counters agree with actual member records', () => {
  const snapshot = showcaseSnapshot(NOW);
  const registrations = rows<Registration>(snapshot, 'registrations');
  const activities = rows<Activity>(snapshot, 'activities');
  for (const activity of activities) {
    const participants = registrations.filter(row => row.activityId === activity.id);
    assert.equal(activity.reservedSeats, participants.filter(row => row.seatState === 'held').length, activity.id);
    assert.equal(activity.waitlistCount, participants.filter(row => row.state === 'waitlisted').length, activity.id);
    assert(activity.reservedSeats <= activity.capacity && activity.capacity <= 30);
    assert.equal(activity.nextQueueSeq, Math.max(0, ...participants.map(row => row.queueSeq)));
    assert.equal(new Set(participants.map(row => row.queueSeq)).size, participants.length);
    for (const row of participants) {
      const member = snapshot.memberships[row.memberId] as Membership;
      assert(member);
      assert(snapshot.users[member.userId]);
      assert.equal(row.id, registrationIdFor('oradv', activity.id, member.id));
      assert.equal(row.acceptedRuleVersion, activity.ruleVersion);
      assert(Date.parse(row.createdAt) <= Date.parse(row.updatedAt));
      assert(Date.parse(row.updatedAt) <= Date.parse(NOW));
      if (row.state === 'waitlisted') assert.equal(row.seatState, 'none');
      if (row.state === 'cancelled' || row.state === 'rejected') assert.notEqual(row.seatState, 'held');
    }
  }
  const full = activities.find(row => row.id === 'full-ride')!;
  assert.equal(full.reservedSeats, full.capacity);
  assert(full.waitlistCount! >= 2);
  assert(!registrations.some(row => row.activityId === 'intro-ride' && [memberId('member'), memberId('founder')].includes(row.memberId)));
});

test('showcase checkins and settlement provenance agree with timelines and ledger aggregates', () => {
  const snapshot = showcaseSnapshot(NOW);
  const checkins = rows<Checkin>(snapshot, 'checkins');
  const ledger = rows<LedgerEntry>(snapshot, 'points_ledger');
  for (const checkin of checkins) {
    const registration = snapshot.registrations[registrationIdFor('oradv', checkin.activityId, checkin.memberId)] as Registration;
    assert(registration);
    assert.equal(checkin.id, key('checkin', 'oradv', checkin.activityId, checkin.memberId, checkin.phase, checkin.day));
    assert.equal(checkin.day, shanghaiDay(checkin.verifiedAt));
    assert(checkin.verifiedAt <= NOW);
    assert(rows<StaffRole>(snapshot, 'staff_roles').some(role => role.userId === checkin.verifiedBy && role.enabled
      && (!role.expiresAt || role.expiresAt > checkin.verifiedAt) && (role.activityIds === null || role.activityIds.includes(checkin.activityId))), 'verifier has authority for this activity');
    if (checkin.phase === 'return') {
      const departure = snapshot.checkins[key('checkin', 'oradv', checkin.activityId, checkin.memberId, 'departure', checkin.day)] as Checkin;
      assert.equal(departure.result, 'present');
      assert(departure.verifiedAt <= checkin.verifiedAt);
    }
  }
  for (const registration of rows<Registration>(snapshot, 'registrations')) {
    const activity = snapshot.activities[registration.activityId] as Activity;
    if (registration.lastDepartureDay) assert(snapshot.checkins[key('checkin', 'oradv', activity.id, registration.memberId, 'departure', registration.lastDepartureDay)]);
    if (registration.lastReturnDay) assert(snapshot.checkins[key('checkin', 'oradv', activity.id, registration.memberId, 'return', registration.lastReturnDay)]);
    if (registration.state !== 'completed') continue;
    const entry = snapshot.points_ledger[registration.settlementId!] as LedgerEntry;
    assert.equal(entry.id, completionIdFor(activity, registration));
    assert.equal(entry.year, shanghaiYear(activity.actualCompletedAt!));
    assert.equal(entry.growthDelta, activity.pointsRule.growth);
    assert.equal(entry.annualDelta, activity.pointsRule.annual);
    assert.equal(entry.effectiveAt, activity.actualCompletedAt);
    assert(registration.lastReturnDay);
  }
  for (const stats of rows<MemberStats>(snapshot, 'member_stats').filter(row => row.memberId)) {
    const entries = ledger.filter(entry => entry.memberId === stats.memberId && (stats.scope === 'growth' || entry.year === stats.year));
    assert.equal(stats.id, statsIdFor('oradv', stats.memberId, stats.year));
    assert.equal(stats.points, entries.reduce((sum, row) => sum + (stats.scope === 'growth' ? row.growthDelta : row.annualDelta), 0));
    assert.equal(stats.completedCount, entries.reduce((sum, row) => sum + row.completedCountDelta, 0));
    assert(stats.points >= 0 && stats.completedCount >= 0);
  }
  assert(ledger.some(row => row.awardType === 'reversal'), 'one linked correction example');
});

test('showcase permissions, private trips and independent publication consents remain enforced', async () => {
  const { request, service, store } = setup();
  const publicActivities = await request<PageResult<Activity>>(null, 'activity.list');
  assert(!publicActivities.items.some(row => row.id === 'draft-ride'));
  assert(!JSON.stringify(publicActivities).includes('演示集合点'));
  const guestBriefing = await service.handle({ action: 'activity.briefing.get', payload: { activityId: 'day-trip' }, clubId: 'oradv', requestId: 'guest-private' }, null);
  assert.equal(guestBriefing.ok, false);
  const briefing = await request<{ checklist: string[]; contactValue: string }>(DEMO_IDENTITIES.member, 'activity.briefing.get', { activityId: 'day-trip' });
  assert(briefing.checklist.length >= 4);
  assert(briefing.contactValue.includes('演示'));
  const recommendations = await request<PageResult<RecommendationEntry>>(null, 'recommendation.list');
  assert(recommendations.items.length >= 10);
  assert.equal(recommendations.items[0].memberKind, 'founder');
  assert(recommendations.items.some(row => row.growthPoints === undefined), 'recommendation-only member keeps scores private');
  assert(!recommendations.items.some(row => row.memberPublicId === (store.snapshot().memberships[memberId('member')] as Membership).publicId));
  const leaderboard = await request<PageResult<{ score: number }>>(null, 'ranking.list', { metric: 'growth' });
  const founder = await request<PointsResult>(DEMO_IDENTITIES.founder, 'points.mine');
  assert(leaderboard.items[0].score > founder.growthPoints, 'founder priority does not modify actual scores');
  const scoped = await request<PageResult<Activity>>(DEMO_IDENTITIES.leader, 'staff.activity.list');
  assert(scoped.items.some(row => row.id === 'ongoing-ride'));
  assert(!scoped.items.some(row => row.id === 'draft-ride'));
  const memberRoles = rows<StaffRole>(store.snapshot(), 'staff_roles').filter(row => row.userId === userIdFor(DEMO_IDENTITIES.founder));
  assert.equal(memberRoles.length, 0);
  const qualifications = rows<Qualification>(store.snapshot(), 'qualifications');
  assert(qualifications.some(row => row.decision === 'pending'));
  assert(qualifications.some(row => row.decision === 'rejected'));
  assert(qualifications.some(row => row.decision === 'approved' && !!row.expiresAt && row.expiresAt < NOW));
});

test('showcase stays usable for ordinary/founder applications, FIFO and repeatable staff settlement', async () => {
  const { request, store } = setup();
  const regular = await request<Registration>(DEMO_IDENTITIES.member, 'registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 1 });
  assert.equal(regular.state, 'pending_confirmation');
  const founder = await request<Registration>(DEMO_IDENTITIES.founder, 'registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 1 });
  assert.equal(founder.state, 'confirmed');
  const heldIdentity = { appId: 'demo-app', openId: 'fictional-showcase-6' };
  const heldMemberId = memberIdFor('oradv', userIdFor(heldIdentity));
  const held = store.snapshot().registrations[registrationIdFor('oradv', 'full-ride', heldMemberId)] as Registration;
  await request(heldIdentity, 'registration.cancel', { registrationId: held.id, reason: '演示：释放名额后检查候补顺序' }, held.revision);
  const promoted = await request<Registration>(DEMO_IDENTITIES.owner, 'staff.waitlist.promote', { activityId: 'full-ride' });
  assert.equal(promoted.memberId, memberId('member'));
  assert.equal(promoted.state, 'pending_confirmation');
  const before = await request<PointsResult>(DEMO_IDENTITIES.member, 'points.mine');
  const pending = await request<{ eligibleCount: number; unresolvedCount: number }>(DEMO_IDENTITIES.owner, 'staff.settlement.preview', { activityId: 'settlement-ride', ruleVersion: 1 });
  assert(pending.eligibleCount >= 3);
  assert.equal(pending.unresolvedCount, 0);
  const job = await request<SettlementJob>(DEMO_IDENTITIES.owner, 'staff.settlement.run', { activityId: 'settlement-ride', ruleVersion: 1 });
  assert.equal(job.status, 'completed');
  const after = await request<PointsResult>(DEMO_IDENTITIES.member, 'points.mine');
  const activity = store.snapshot().activities['settlement-ride'] as Activity;
  assert.equal(after.growthPoints - before.growthPoints, activity.pointsRule.growth);
  await request(DEMO_IDENTITIES.owner, 'staff.settlement.run', { activityId: 'settlement-ride', ruleVersion: 1 });
  assert.equal((await request<PointsResult>(DEMO_IDENTITIES.member, 'points.mine')).growthPoints, after.growthPoints);
});

test('showcase dates and annual totals follow the supplied time across Shanghai year boundaries', async () => {
  for (const now of ['2026-12-31T16:00:00.000Z', '2026-12-31T16:05:00.000Z', '2027-06-15T03:00:00.000Z']) {
    const { request, store } = setup(now);
    const snapshot = store.snapshot();
    const intro = snapshot.activities['intro-ride'] as Activity;
    assert(intro.applicationClosesAt > now);
    const ongoing = snapshot.activities['ongoing-ride'] as Activity;
    assert.equal(shanghaiDay(ongoing.actualStartedAt!), shanghaiDay(now));
    const departures = rows<Checkin>(snapshot, 'checkins').filter(row => row.activityId === ongoing.id);
    assert(departures.length > 0 && departures.every(row => row.day === shanghaiDay(now) && row.verifiedAt <= now));
    const points = await request<PointsResult>(DEMO_IDENTITIES.member, 'points.mine');
    assert.equal(points.year, shanghaiYear(now));
    assert(points.items.length > 0 && points.annualPoints > 0, 'current-year growth screen has a recent completion even on January 1');
    const ledger = rows<LedgerEntry>(snapshot, 'points_ledger').filter(row => row.memberId === memberId('member'));
    assert.equal(points.annualPoints, ledger.filter(row => row.year === points.year).reduce((sum, row) => sum + row.annualDelta, 0));
    for (const entry of ledger) assert.equal(entry.year, shanghaiYear(entry.effectiveAt));
    for (const activity of rows<Activity>(snapshot, 'activities')) {
      assert(activity.startAt < activity.endAt);
      if (activity.actualCompletedAt) assert(activity.actualCompletedAt <= now);
    }
    for (const checkin of rows<Checkin>(snapshot, 'checkins')) {
      assert(checkin.verifiedAt <= now);
      assert.equal(checkin.day, shanghaiDay(checkin.verifiedAt));
      if (checkin.phase === 'return') {
        const departure = snapshot.checkins[key('checkin', 'oradv', checkin.activityId, checkin.memberId, 'departure', checkin.day)] as Checkin;
        assert(departure?.result === 'present' && departure.verifiedAt <= checkin.verifiedAt);
        const activity = snapshot.activities[checkin.activityId] as Activity;
        if (activity.actualCompletedAt) assert(checkin.verifiedAt <= activity.actualCompletedAt);
      }
    }
  }
});
