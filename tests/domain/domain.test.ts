import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../shared/memory-store';
import { createService } from '../../shared/service';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import type { RpcResponse, TrustedIdentity, Activity, Registration } from '../../shared/types';
import type { Store, Transaction } from '../../shared/store';
import { withMetadata } from '../../shared/store';
import { key, memberIdFor, shanghaiYear, userIdFor, statsIdFor } from '../../shared/models';
import { sha256 } from '../../shared/hash';
import { createHash } from 'node:crypto';

const NOW = '2026-10-15T12:00:00.000Z';
let contextCounter = 0;
function setup(store: Store = createDemoStore(), now = NOW) {
  const contextId = ++contextCounter;
  let counter = 0;
  const service = createService(store, { now: () => now, id: () => `test-${contextId}-${++counter}` });
  const call = (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity | null = DEMO_IDENTITIES.owner, expectedRevision?: number) => service.handle({ action, payload, clubId: 'oradv', requestId: `request-${++counter}`, expectedRevision }, identity);
  return { store, call, service };
}
function data<T = any>(response: RpcResponse): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { data: T }).data;
}
function error(response: RpcResponse, code: string) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal((response as { error: { code: string } }).error.code, code);
}
async function apply(ctx: ReturnType<typeof setup>, identity = DEMO_IDENTITIES.member, activityId = 'intro-ride') {
  return data<Registration>(await ctx.call('registration.apply', { activityId, acceptedRuleVersion: 1 }, identity));
}
async function complete(ctx: ReturnType<typeof setup>, identity = DEMO_IDENTITIES.member, actualCompletedAt = NOW) {
  let registration = await apply(ctx, identity);
  registration = data(await ctx.call('staff.registration.review', { registrationId: registration.id, decision: 'approved' }, DEMO_IDENTITIES.owner, registration.revision));
  registration = data(await ctx.call('staff.registration.confirm', { registrationId: registration.id }, DEMO_IDENTITIES.owner, registration.revision));
  let activity = data<Activity>(await ctx.call('activity.get', { activityId: 'intro-ride' }));
  activity = data(await ctx.call('staff.activity.start', { activityId: activity.id }, DEMO_IDENTITIES.owner, activity.revision));
  registration = data(await ctx.call('staff.checkin.record', { registrationId: registration.id, phase: 'departure', result: 'present' }, DEMO_IDENTITIES.leader));
  registration = data(await ctx.call('staff.checkin.record', { registrationId: registration.id, phase: 'return', result: 'present' }, DEMO_IDENTITIES.leader));
  data(await ctx.call('staff.activity.end', { activityId: activity.id, actualCompletedAt }, DEMO_IDENTITIES.owner, activity.revision));
  return registration;
}

test('memory transactions serialize and roll back every write after failure', async () => {
  const store = new MemoryStore({ counters: { x: { id: 'x', value: 0 } } });
  await Promise.all(Array.from({ length: 15 }, () => store.transaction(async (tx) => {
    const row = await tx.get<{ id: string; value: number }>('counters', 'x');
    await Promise.resolve();
    await tx.set('counters', 'x', { ...row, value: row!.value + 1 });
  })));
  assert.equal((store.snapshot().counters.x as any).value, 15);
  await assert.rejects(store.transaction(async (tx) => { await tx.set('counters', 'x', { value: 900 }); throw new Error('injected'); }));
  assert.equal((store.snapshot().counters.x as any).value, 15);
});

test('new identities start at zero and spoofed authorization cannot grant staff', async () => {
  const ctx = setup();
  const newcomer = { appId: 'demo-app', openId: 'brand-new' };
  const member = data(await ctx.call('identity.ensure', { nickname: '新车友', role: 'owner', openid: DEMO_IDENTITIES.owner.openId, consentVersions: { privacy: 1, terms: 1 } }, newcomer));
  assert.equal(member.growthPoints, 0);
  assert.equal(member.annualPoints, 0);
  assert.deepEqual(member.roles, []);
  assert.equal(data(await ctx.call('identity.ensure', {}, newcomer)).id, member.id);
  error(await ctx.call('staff.activity.list', {}, newcomer), 'FORBIDDEN');
  error(await ctx.call('registration.mine', {}, null), 'UNAUTHENTICATED');
});

test('last-seat contention and retries never overbook; cancellation only releases once', async () => {
  const ctx = setup();
  await ctx.store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, capacity: 1 });
  });
  const other = { appId: 'demo-app', openId: 'other-member' };
  data(await ctx.call('identity.ensure', { nickname: '第二人', consentVersions: { privacy: 1, terms: 1 } }, other));
  const applications = await Promise.all([apply(ctx), apply(ctx, other)]);
  assert.deepEqual(applications.map((row) => row.state).sort(), ['pending_confirmation', 'waitlisted']);
  assert.equal(data<Activity>(await ctx.call('activity.get', { activityId: 'intro-ride' })).reservedSeats, 1);
  const repeated = await apply(ctx);
  assert.equal(repeated.id, applications[0].id);
  const held = applications.find((row) => row.seatState === 'held')!;
  const heldIdentity = held.memberId === data(await ctx.call('identity.ensure', {}, DEMO_IDENTITIES.member)).id ? DEMO_IDENTITIES.member : other;
  data(await ctx.call('registration.cancel', { registrationId: held.id, reason: '行程变化' }, heldIdentity, held.revision));
  data(await ctx.call('registration.cancel', { registrationId: held.id, reason: '重复请求' }, heldIdentity, held.revision));
  assert.equal(data<Activity>(await ctx.call('activity.get', { activityId: 'intro-ride' })).reservedSeats, 0);
  const promoted = data<Registration>(await ctx.call('staff.waitlist.promote', { activityId: 'intro-ride' }));
  assert.equal(promoted.state, 'pending_confirmation');
  assert.equal(data<Activity>(await ctx.call('activity.get', { activityId: 'intro-ride' })).reservedSeats, 1);
});

test('stale revisions and unauthorized staff cannot change another registration', async () => {
  const ctx = setup();
  const registration = await apply(ctx);
  error(await ctx.call('staff.registration.confirm', { registrationId: registration.id }, DEMO_IDENTITIES.member, registration.revision), 'FORBIDDEN');
  error(await ctx.call('staff.registration.review', { registrationId: registration.id, decision: 'approved' }, DEMO_IDENTITIES.owner, 999), 'CONFLICT_REFRESH');
  error(await ctx.call('staff.checkin.record', { registrationId: registration.id, phase: 'departure', result: 'present' }, DEMO_IDENTITIES.leader), 'STATE_CONFLICT');
});

test('points only follow full verification; concurrent settlement and reversal are idempotent', async () => {
  const ctx = setup();
  const registration = await complete(ctx);
  const before = data(await ctx.call('points.mine', {}, DEMO_IDENTITIES.member));
  assert.equal(before.growthPoints, 0);
  const responses = await Promise.all(Array.from({ length: 6 }, () => ctx.call('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: 1 })));
  responses.forEach((response) => data(response));
  const points = data(await ctx.call('points.mine', {}, DEMO_IDENTITIES.member));
  assert.equal(points.growthPoints, 100);
  assert.equal(points.annualPoints, 100);
  assert.equal(points.completedCount, 1);
  assert.equal(points.items.length, 1);
  assert.match(points.items[0].activityTitle, /非铺装入门/);
  const ledger = points.items[0];
  const reversal = data(await ctx.call('staff.points.reverse', { ledgerId: ledger.id, reason: '核验录入更正' }));
  data(await ctx.call('staff.points.reverse', { ledgerId: ledger.id, reason: '重试' }));
  assert.equal(reversal.registration.id, registration.id);
  assert.equal(reversal.registration.state, 'completed');
  assert.equal(reversal.registration.completionVoided, true);
  const corrected = data(await ctx.call('points.mine', {}, DEMO_IDENTITIES.member));
  assert.equal(corrected.growthPoints, 0);
  assert.equal(corrected.completedCount, 0);
  assert.equal(corrected.items.length, 2);
});

test('ranking consent is separate and withdrawal removes existing public projection', async () => {
  const ctx = setup();
  const member = data(await ctx.call('identity.ensure', {}, DEMO_IDENTITIES.member));
  assert.equal(data(await ctx.call('ranking.list', {})).items.length, 0);
  const updated = data(await ctx.call('profile.update', { nickname: '自愿公开', rankingOptIn: true, rankingConsentVersion: 1 }, DEMO_IDENTITIES.member, member.revision));
  const rows = data(await ctx.call('ranking.list', {})).items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nickname, '自愿公开');
  assert.equal(JSON.stringify(rows).includes(DEMO_IDENTITIES.member.openId), false);
  data(await ctx.call('profile.update', { rankingOptIn: false }, DEMO_IDENTITIES.member, updated.revision));
  assert.equal(data(await ctx.call('ranking.list', {})).items.length, 0);
});

test('private deterministic keys use correct SHA256 and never contain raw identity', () => {
  for (const value of ['', 'abc', '原始拉力🏍️', 'x'.repeat(1000)]) assert.equal(sha256(value), createHash('sha256').update(value).digest('hex'));
  const identity = { appId: 'application'.repeat(10), openId: 'raw-private-open-id'.repeat(10) };
  const userId = userIdFor(identity), memberId = memberIdFor('oradv', userId);
  assert.ok(userId.length < 100 && memberId.length < 100);
  assert.equal(memberId.includes(identity.openId), false);
  assert.notEqual(userIdFor({ appId: 'a:b', openId: 'c' }), userIdFor({ appId: 'a', openId: 'b:c' }));
});

test('guest projections hide drafts and unknown resource fields; cross-club requests fail', async () => {
  const ctx = setup();
  await ctx.store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, privateRoster: ['private-contact'], preciseRoute: 'secret-route' });
  });
  const list = data(await ctx.call('activity.list', {}, null));
  assert.equal(list.items.some((row: Activity) => row.state === 'draft'), false);
  assert.equal(JSON.stringify(list).includes('private-contact'), false);
  const activity = data(await ctx.call('activity.get', { activityId: 'intro-ride' }, null));
  assert.equal(activity.preciseRoute, undefined);
  error(await ctx.call('activity.get', { activityId: 'draft-ride' }, null), 'ACTIVITY_NOT_FOUND');
  error(await ctx.service.handle({ action: 'activity.list', requestId: 'cross', clubId: 'other-club', payload: {} }, null), 'FORBIDDEN');
});

test('consent is required before registration identity; disabled members remain blocked', async () => {
  const ctx = setup();
  const identity = { appId: 'demo-app', openId: 'no-consent' };
  assert.equal(data(await ctx.call('identity.me', {}, identity)), null);
  error(await ctx.call('identity.ensure', { nickname: '新用户' }, identity), 'INVALID_INPUT');
  assert.equal(data(await ctx.call('identity.me', {}, identity)), null);
  data(await ctx.call('identity.delete', {}, DEMO_IDENTITIES.member));
  error(await ctx.call('identity.ensure', {}, DEMO_IDENTITIES.member), 'FORBIDDEN');
  error(await ctx.call('registration.mine', {}, DEMO_IDENTITIES.member), 'FORBIDDEN');
});

test('growth threshold equality permits application, does not debit, and stale rules fail', async () => {
  const ctx = setup();
  const member = data(await ctx.call('identity.ensure', {}, DEMO_IDENTITIES.member));
  await ctx.store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, minGrowthPoints: 100 });
    const id = statsIdFor('oradv', member.id, null);
    await tx.set('member_stats', id, { id, clubId: 'oradv', memberId: member.id, scope: 'growth', year: null, points: 99, completedCount: 0, revision: 1 });
  });
  error(await ctx.call('registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 1 }, DEMO_IDENTITIES.member), 'SCORE_TOO_LOW');
  await ctx.store.transaction(async (tx) => {
    const id = statsIdFor('oradv', member.id, null);
    const stats = await tx.get<any>('member_stats', id);
    await tx.set('member_stats', id, { ...stats, points: 100 });
  });
  error(await ctx.call('registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 2 }, DEMO_IDENTITIES.member), 'RULE_VERSION_CHANGED');
  await apply(ctx);
  assert.equal(data(await ctx.call('points.mine', {}, DEMO_IDENTITIES.member)).growthPoints, 100);
});

test('qualifications are independently required and checked again after expiry', async () => {
  const ctx = setup();
  const member = data(await ctx.call('identity.ensure', {}, DEMO_IDENTITIES.member));
  await ctx.store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, requiredQualifications: ['offroad'] });
  });
  error(await ctx.call('registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 1 }, DEMO_IDENTITIES.member), 'QUALIFICATION_REQUIRED');
  await ctx.store.transaction(async (tx) => {
    const id = key('qualification', 'oradv', member.id, 'offroad');
    await tx.set('qualifications', id, { id, clubId: 'oradv', memberId: member.id, type: 'offroad', decision: 'approved', expiresAt: '2026-10-15T12:01:00.000Z' });
  });
  const registration = await apply(ctx);
  const later = setup(ctx.store, '2026-10-15T12:02:00.000Z');
  error(await later.call('staff.registration.review', { registrationId: registration.id, decision: 'approved' }, DEMO_IDENTITIES.owner, registration.revision), 'QUALIFICATION_EXPIRED');
});

test('regular reapplication preserves deterministic id/history and requires administrator confirmation', async () => {
  const ctx = setup();
  await ctx.store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, requiresReview: false });
  });
  const first = await apply(ctx);
  assert.equal(first.state, 'pending_confirmation');
  data(await ctx.call('registration.cancel', { registrationId: first.id, reason: '调整行程' }, DEMO_IDENTITIES.member, first.revision));
  const second = await apply(ctx);
  assert.equal(second.id, first.id);
  assert.equal(second.attempt, 2);
  assert.ok(second.revision > first.revision);
  assert.equal(second.state, 'pending_confirmation');
  assert.equal(data<Activity>(await ctx.call('activity.get', { activityId: 'intro-ride' })).reservedSeats, 1);
});

test('role activity scope, expiry and revocation are enforced server-side', async () => {
  const ctx = setup();
  error(await ctx.call('staff.registration.list', { activityId: 'advanced-ride' }, DEMO_IDENTITIES.leader), 'FORBIDDEN');
  const leaderUserId = userIdFor(DEMO_IDENTITIES.leader);
  const roleId = key('role', 'oradv', leaderUserId, 'leader');
  await ctx.store.transaction(async (tx) => {
    const role = await tx.get<any>('staff_roles', roleId);
    await tx.set('staff_roles', roleId, { ...role, expiresAt: NOW });
  });
  error(await ctx.call('staff.registration.list', { activityId: 'intro-ride' }, DEMO_IDENTITIES.leader), 'FORBIDDEN');
  const leaderMemberId = memberIdFor('oradv', leaderUserId);
  data(await ctx.call('staff.roles.assign', { memberId: leaderMemberId, role: 'leader', activityIds: ['intro-ride'], enabled: false }, DEMO_IDENTITIES.owner, 1));
  error(await ctx.call('staff.registration.list', { activityId: 'intro-ride' }, DEMO_IDENTITIES.leader), 'FORBIDDEN');
  error(await ctx.call('staff.roles.assign', { memberId: leaderMemberId, role: 'owner' }, DEMO_IDENTITIES.leader), 'FORBIDDEN');
});

test('injected member-stats failure rolls back ledger and completion, then retries once', async () => {
  const memory = createDemoStore();
  let failOnce = false;
  const store: Store = {
    query: (collection, filters, options) => memory.query(collection, filters, options),
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => memory.transaction((tx) => work({
      get: (collection, id) => tx.get(collection, id),
      set: async (collection, id, value) => {
        if (failOnce && collection === 'member_stats') { failOnce = false; throw new Error('injected after ledger write'); }
        return tx.set(collection, id, value);
      },
    })),
  };
  const ctx = setup(store);
  const registration = await complete(ctx);
  failOnce = true;
  const first = data(await ctx.call('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: 1 }));
  assert.equal(first.status, 'partial_failure');
  assert.equal(first.failureCount, 1);
  assert.equal(data(await ctx.call('points.mine', {}, DEMO_IDENTITIES.member)).items.length, 0);
  assert.equal((await memory.transaction((tx) => tx.get<Registration>('registrations', registration.id)))!.state, 'pending_settlement');
  const retry = data(await ctx.call('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: 1 }));
  assert.equal(retry.status, 'completed');
  assert.equal(data(await ctx.call('points.mine', {}, DEMO_IDENTITIES.member)).growthPoints, 100);
});

test('annual points follow Shanghai completion year when settlement runs in January', async () => {
  const store = createDemoStore();
  const completedAt = '2026-12-31T15:59:00.000Z';
  await store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, startAt: '2026-12-31T08:00:00.000Z', endAt: completedAt, applicationClosesAt: '2027-01-01T00:00:00.000Z' });
  });
  await complete(setup(store, completedAt), DEMO_IDENTITIES.member, completedAt);
  const january = setup(store, '2027-01-02T00:00:00.000Z');
  data(await january.call('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: 1 }));
  const previousYear = data(await january.call('points.mine', { year: 2026 }, DEMO_IDENTITIES.member));
  const nextYear = data(await january.call('points.mine', { year: 2027 }, DEMO_IDENTITIES.member));
  assert.equal(previousYear.annualPoints, 100);
  assert.equal(nextYear.annualPoints, 0);
  assert.equal(nextYear.growthPoints, 100);
});

test('annual frozen snapshots retain their original award basis after reversal', async () => {
  const ctx = setup();
  await complete(ctx);
  data(await ctx.call('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: 1 }));
  const snapshot = data(await ctx.call('staff.rewards.snapshot', { year: 2026, ruleVersion: 1 }));
  assert.equal(snapshot.memberAwards[0].points, 100);
  const ledger = data(await ctx.call('points.mine', {}, DEMO_IDENTITIES.member)).items[0];
  data(await ctx.call('staff.points.reverse', { ledgerId: ledger.id, reason: '复核完成结果' }));
  const original = data(await ctx.call('staff.rewards.snapshot', { year: 2026, ruleVersion: 1 }));
  const amended = data(await ctx.call('staff.rewards.snapshot', { year: 2026, ruleVersion: 2 }));
  assert.equal(original.memberAwards[0].points, 100);
  assert.equal(amended.snapshotVersion, snapshot.snapshotVersion + 1);
  assert.equal(amended.memberAwards.length, 0);
});

test('owner/operator role scopes cannot bypass global authority, including legacy rows', async () => {
  const ctx = setup();
  const member = data(await ctx.call('identity.ensure', {}, DEMO_IDENTITIES.member));
  error(await ctx.call('staff.roles.assign', { memberId: member.id, role: 'owner', activityIds: ['intro-ride'] }), 'INVALID_INPUT');
  error(await ctx.call('staff.roles.assign', { memberId: member.id, role: 'operator', activityIds: [] }), 'INVALID_INPUT');
  await ctx.store.transaction(async (tx) => {
    const id = key('role', 'oradv', userIdFor(DEMO_IDENTITIES.member), 'owner');
    await tx.set('staff_roles', id, { id, clubId: 'oradv', userId: userIdFor(DEMO_IDENTITIES.member), role: 'owner', activityIds: ['intro-ride'], enabled: true, expiresAt: null, grantedBy: 'legacy', revision: 1 });
  });
  error(await ctx.call('staff.roles.assign', { memberId: member.id, role: 'operator' }, DEMO_IDENTITIES.member), 'FORBIDDEN');
  error(await ctx.call('staff.activity.save', { title: '伪造草稿' }, DEMO_IDENTITIES.member), 'FORBIDDEN');
  error(await ctx.call('staff.rewards.snapshot', { year: 2026, ruleVersion: 1 }, DEMO_IDENTITIES.member), 'FORBIDDEN');
});

test('explicit early start records server time and invalid completion times fail', async () => {
  const ctx = setup(createDemoStore(NOW));
  let activity = data<Activity>(await ctx.call('activity.get', { activityId: 'intro-ride' }));
  assert.ok(activity.applicationClosesAt < activity.startAt && activity.startAt < activity.endAt);
  assert.ok(activity.startAt > NOW);
  activity = data(await ctx.call('staff.activity.start', { activityId: activity.id }, DEMO_IDENTITIES.owner, activity.revision));
  assert.equal(activity.actualStartedAt, NOW);
  error(await ctx.call('staff.activity.end', { activityId: activity.id, actualCompletedAt: '2026-10-15T11:59:59.000Z' }, DEMO_IDENTITIES.owner, activity.revision), 'INVALID_INPUT');
  error(await ctx.call('staff.activity.end', { activityId: activity.id, actualCompletedAt: '2026-10-15T12:00:01.000Z' }, DEMO_IDENTITIES.owner, activity.revision), 'INVALID_INPUT');
  assert.equal(shanghaiYear('2026-12-31T15:59:59.999Z'), 2026);
  assert.equal(shanghaiYear('2026-12-31T16:00:00.000Z'), 2027);
});

test('multi-day departure/return records require each day and award the whole event once', async () => {
  const store = createDemoStore(NOW);
  await store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, startAt: '2026-10-15T02:00:00.000Z', endAt: '2026-10-16T06:00:00.000Z' });
  });
  const firstDay = setup(store);
  let registration = await apply(firstDay);
  registration = data(await firstDay.call('staff.registration.review', { registrationId: registration.id, decision: 'approved' }, DEMO_IDENTITIES.owner, registration.revision));
  registration = data(await firstDay.call('staff.registration.confirm', { registrationId: registration.id }, DEMO_IDENTITIES.owner, registration.revision));
  const activity = data<Activity>(await firstDay.call('activity.get', { activityId: 'intro-ride' }));
  data(await firstDay.call('staff.activity.start', { activityId: activity.id }, DEMO_IDENTITIES.owner, activity.revision));
  registration = data(await firstDay.call('staff.checkin.record', { registrationId: registration.id, phase: 'departure', result: 'present' }, DEMO_IDENTITIES.leader));
  const secondDay = setup(store, '2026-10-16T12:00:00.000Z');
  error(await secondDay.call('staff.checkin.record', { registrationId: registration.id, phase: 'departure', result: 'present' }, DEMO_IDENTITIES.leader), 'STATE_CONFLICT');
  registration = data(await firstDay.call('staff.checkin.record', { registrationId: registration.id, phase: 'return', result: 'present' }, DEMO_IDENTITIES.leader));
  assert.equal(registration.state, 'checked_in');
  registration = data(await secondDay.call('staff.checkin.record', { registrationId: registration.id, phase: 'departure', result: 'present' }, DEMO_IDENTITIES.leader));
  registration = data(await secondDay.call('staff.checkin.record', { registrationId: registration.id, phase: 'return', result: 'present' }, DEMO_IDENTITIES.leader));
  assert.equal(registration.state, 'pending_settlement');
  const latest = data<Activity>(await secondDay.call('activity.get', { activityId: 'intro-ride' }));
  data(await secondDay.call('staff.activity.end', { activityId: latest.id }, DEMO_IDENTITIES.owner, latest.revision));
  data(await secondDay.call('staff.settlement.run', { activityId: latest.id, ruleVersion: 1 }));
  data(await secondDay.call('staff.settlement.run', { activityId: latest.id, ruleVersion: 1 }));
  const points = data(await secondDay.call('points.mine', {}, DEMO_IDENTITIES.member));
  assert.equal(points.growthPoints, 100);
  assert.equal(points.completedCount, 1);
});

test('cancellation racing with departure cannot release an occupied on-site seat', async () => {
  const ctx = setup();
  let registration = await apply(ctx);
  registration = data(await ctx.call('staff.registration.review', { registrationId: registration.id, decision: 'approved' }, DEMO_IDENTITIES.owner, registration.revision));
  registration = data(await ctx.call('staff.registration.confirm', { registrationId: registration.id }, DEMO_IDENTITIES.owner, registration.revision));
  const activity = data<Activity>(await ctx.call('activity.get', { activityId: 'intro-ride' }));
  data(await ctx.call('staff.activity.start', { activityId: activity.id }, DEMO_IDENTITIES.owner, activity.revision));
  const responses = await Promise.all([
    ctx.call('registration.cancel', { registrationId: registration.id, reason: '并发取消' }, DEMO_IDENTITIES.member, registration.revision),
    ctx.call('staff.checkin.record', { registrationId: registration.id, phase: 'departure', result: 'present' }, DEMO_IDENTITIES.leader),
  ]);
  error(responses[0], 'STATE_CONFLICT');
  assert.equal(data<Registration>(responses[1]).state, 'checked_in');
  assert.equal(data<Activity>(await ctx.call('activity.get', { activityId: activity.id })).reservedSeats, 1);
});

test('tie ranks remain stable over cursors, and withdrawn members disappear on later pages', async () => {
  const ctx = setup();
  for (let index = 0; index < 25; index++) {
    const identity = { appId: 'demo-app', openId: `rank-${index}` };
    const member = data(await ctx.call('identity.ensure', { nickname: `榜单成员${index}`, consentVersions: { privacy: 1, terms: 1 } }, identity));
    data(await ctx.call('profile.update', { rankingOptIn: true, rankingConsentVersion: 1 }, identity, member.revision));
  }
  const first = data(await ctx.call('ranking.list', {}));
  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  const second = data(await ctx.call('ranking.list', { cursor: first.nextCursor }));
  assert.equal(second.items.length, 5);
  assert.ok([...first.items,...second.items].every((row: any) => row.rank === 1));
  assert.equal(new Set([...first.items,...second.items].map((row: any) => row.memberPublicId)).size, 25);
  const identity = { appId: 'demo-app', openId: 'rank-0' };
  const me = data(await ctx.call('identity.me', {}, identity));
  data(await ctx.call('profile.update', { rankingOptIn: false }, identity, me.revision));
  const rows = data(await ctx.call('ranking.list', {}));
  const remainder = data(await ctx.call('ranking.list', { cursor: rows.nextCursor }));
  assert.equal(rows.items.length + remainder.items.length, 24);
});

test('historical ranking invalidation is split into transactions below the SDK operation limit', async () => {
  const memory = createDemoStore();
  const memberId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  await memory.transaction(async (tx) => {
    for (let year = 2000; year < 2080; year++) {
      const id = key('ranking', 'oradv', memberId, 'annual', year);
      await tx.set('public_rankings', id, { id, clubId: 'oradv', memberId, memberPublicId: 'fictional-public', metric: 'annual', year, score: 0, completedCount: 0, consentVersion: 1, visible: true, nickname: '原昵称' });
    }
  });
  let maximum = 0;
  const bounded: Store = {
    query: (collection, filters, options) => memory.query(collection, filters, options),
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => memory.transaction((tx) => {
      let operations = 0;
      const count = () => { maximum = Math.max(maximum, ++operations); assert.ok(operations <= 100, 'CloudBase operation budget exceeded'); };
      return work(withMetadata({ get: (collection,id) => { count(); return tx.get(collection,id); }, set: (collection,id,value) => { count(); return tx.set(collection,id,value); } }, NOW));
    }),
  };
  const ctx = setup(bounded);
  const member = data(await ctx.call('identity.me', {}, DEMO_IDENTITIES.member));
  data(await ctx.call('profile.update', { nickname: '最新昵称', rankingOptIn: false }, DEMO_IDENTITIES.member, member.revision));
  const projections = await memory.query<any>('public_rankings', { memberId }, { limit: 100 });
  assert.ok(projections.every((row) => !row.visible && row.nickname === '最新昵称'));
  assert.ok(maximum <= 100);
});

test('annual snapshot rejects a phantom first award inserted after candidate query', async () => {
  const memory = createDemoStore();
  const operator = setup(memory);
  await complete(operator);
  let intercept = true;
  const racing: Store = {
    transaction: (work) => memory.transaction(work),
    query: async <T>(collection: string, filters: Record<string, unknown>, options?: import('../../shared/store').QueryOptions) => {
      const result = await memory.query<T>(collection, filters, options);
      if (intercept && collection === 'member_stats' && filters.scope === 'year') {
        intercept = false;
        data(await operator.call('staff.settlement.run', { activityId: 'intro-ride', ruleVersion: 1 }));
      }
      return result;
    },
  };
  const ctx = setup(racing);
  error(await ctx.call('staff.rewards.snapshot', { year: 2026, ruleVersion: 1 }), 'CONFLICT_REFRESH');
  const retry = data(await ctx.call('staff.rewards.snapshot', { year: 2026, ruleVersion: 1 }));
  assert.equal(retry.memberAwards.length, 1);
  assert.equal(retry.memberAwards[0].points, 100);
});

test('metadata read cache preserves first creation, stamps writes, and supports read-your-writes', async () => {
  const originalTime = '2025-01-01T00:00:00.000Z';
  const rows: Record<string, any> = { existing: { id: 'existing', clubId: 'oradv', createdAt: originalTime, updatedAt: originalTime, schemaVersion: 2 } };
  let reads = 0;
  const transaction = withMetadata({
    get: async <T>(_collection: string, id: string) => { reads++; return rows[id] ? structuredClone(rows[id]) as T : null; },
    set: async (_collection, id, value) => { rows[id] = structuredClone(value); },
  }, NOW);
  const row = await transaction.get<any>('business', 'existing');
  row.createdAt = 'forged-in-memory';
  await transaction.get('business', 'existing');
  await transaction.set('business', 'existing', { id: 'existing', clubId: 'oradv', createdAt: 'forged-replacement', value: 1 });
  assert.equal(rows.existing.createdAt, originalTime);
  assert.equal(rows.existing.updatedAt, NOW);
  assert.equal(rows.existing.schemaVersion, 2);
  await transaction.set('business', 'new', { id: 'new', clubId: 'oradv' });
  assert.equal(rows.new.createdAt, NOW);
  assert.equal(rows.new.schemaVersion, 1);
  assert.equal((await transaction.get<any>('business', 'new')).updatedAt, NOW);
  await transaction.set('business', 'new', { id: 'new', clubId: 'oradv', value: 2 });
  await transaction.set('infrastructure', 'counter', { id: 'counter', count: 1 });
  assert.equal(rows.counter.createdAt, undefined);
  assert.equal(reads, 2, 'each business document should read the underlying adapter only once');
});

test('memory fixtures and restored snapshots backfill metadata without changing saved timestamps', async () => {
  const originalTime = '2025-01-01T00:00:00.000Z';
  const store = new MemoryStore({ business: {
    old: { id: 'old', clubId: 'oradv', createdAt: originalTime, updatedAt: originalTime },
    missing: { id: 'missing', clubId: 'oradv' },
  } }, () => NOW);
  const initial = store.snapshot().business as Record<string, any>;
  assert.equal(initial.old.createdAt, originalTime);
  assert.equal(initial.old.updatedAt, originalTime);
  assert.equal(initial.old.schemaVersion, 1);
  assert.equal(initial.missing.createdAt, NOW);
  const returned = await store.transaction(async (tx) => {
    await tx.set('business', 'old', { id: 'old', clubId: 'oradv', createdAt: 'client-value' });
  });
  assert.equal(returned, undefined);
  const updated = store.snapshot().business.old as any;
  assert.equal(updated.createdAt, originalTime);
  assert.equal(updated.updatedAt, NOW);
});
