import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../../shared/service';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { key, memberIdFor, statsIdFor, userIdFor } from '../../shared/models';
import type { Activity, Registration, RpcResponse, TrustedIdentity } from '../../shared/types';
import { MemoryStore } from '../../shared/memory-store';
import { withMetadata } from '../../shared/store';
import type { Store, Transaction } from '../../shared/store';

const NOW = '2026-10-15T12:00:00.000Z';
function setup(store: Store = createDemoStore(NOW)) {
  let clock = NOW;
  const service = createService(store, { now: () => clock });
  const call = (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity | null = DEMO_IDENTITIES.owner, expectedRevision?: number) => service.handle({ action, payload, clubId: 'oradv', requestId: `v02-${Math.random()}`, expectedRevision }, identity);
  return { store, call, setClock: (value: string) => { clock = value; } };
}
function data<T = any>(response: RpcResponse): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { data: T }).data;
}
function error(response: RpcResponse, code: string) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal((response as { error: { code: string } }).error.code, code);
}
async function newcomer(ctx: ReturnType<typeof setup>, name: string) {
  const identity = { appId: 'demo-app', openId: name };
  const member = data(await ctx.call('identity.ensure', { nickname: name, consentVersions: { privacy: 1, terms: 1 } }, identity));
  return { identity, member };
}
async function founder(ctx: ReturnType<typeof setup>, name = 'founder-new') {
  const person = await newcomer(ctx, name);
  data(await ctx.call('staff.member.assign', { memberId: person.member.id, memberKind: 'founder', reason: '主理人核定创始成员' }, DEMO_IDENTITIES.owner, person.member.revision));
  return { ...person, member: data(await ctx.call('identity.me', {}, person.identity)) };
}
const apply = async (ctx: ReturnType<typeof setup>, identity: TrustedIdentity) => data<Registration>(await ctx.call('registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 1 }, identity));

test('v0.2 regular accounts cannot self-upgrade, founder directly confirms without granting points or staff', async () => {
  const ctx = setup();
  const regular = await newcomer(ctx, 'ordinary');
  assert.equal(regular.member.memberKind, 'regular');
  error(await ctx.call('profile.update', { memberKind: 'founder' }, regular.identity, regular.member.revision), 'INVALID_INPUT');
  error(await ctx.call('staff.member.assign', { memberId: regular.member.id, memberKind: 'founder', reason: '伪造' }, regular.identity, regular.member.revision), 'FORBIDDEN');
  const core = await founder(ctx);
  const coreRegistration = await apply(ctx, core.identity);
  assert.equal(coreRegistration.state, 'confirmed');
  assert.equal(coreRegistration.memberKindAtApplication, 'founder');
  assert.equal(coreRegistration.confirmationPath, 'founder_direct');
  assert.equal(data(await ctx.call('points.mine', {}, core.identity)).growthPoints, 0);
  assert.deepEqual(core.member.roles, []);
  const application = await apply(ctx, regular.identity);
  assert.equal(application.state, 'pending_confirmation');
  assert.equal(application.reviewDecision, 'pending');
  const confirmed = data<Registration>(await ctx.call('staff.registration.confirm', { registrationId: application.id }, DEMO_IDENTITIES.owner, application.revision));
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.reviewDecision, 'approved');
});

test('founder reapply and FIFO promotion use current server identity without displacing seats', async () => {
  const ctx = setup();
  const core = await founder(ctx);
  let first = await apply(ctx, core.identity);
  data(await ctx.call('registration.cancel', { registrationId: first.id, reason: '重报测试' }, core.identity, first.revision));
  first = await apply(ctx, core.identity);
  assert.equal(first.state, 'confirmed');
  assert.equal(first.attempt, 2);
  data(await ctx.call('registration.cancel', { registrationId: first.id, reason: '让出位置' }, core.identity, first.revision));
  await ctx.store.transaction(async (tx) => {
    const event = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', event.id, { ...event, capacity: 1 });
  });
  const regular = await apply(ctx, DEMO_IDENTITIES.member);
  const waiting = await apply(ctx, core.identity);
  assert.equal(waiting.state, 'waitlisted');
  assert.equal(regular.seatState, 'held');
  data(await ctx.call('registration.cancel', { registrationId: regular.id, reason: '让出位置' }, DEMO_IDENTITIES.member, regular.revision));
  const promoted = data<Registration>(await ctx.call('staff.waitlist.promote', { activityId: 'intro-ride' }));
  assert.equal(promoted.state, 'confirmed');
  assert.equal(promoted.memberKindAtConfirmation, 'founder');
});

test('expired founder becomes regular for new applications; revoked identity leaves existing confirmations intact', async () => {
  const ctx = setup();
  const core = await founder(ctx);
  const joined = await apply(ctx, core.identity);
  data(await ctx.call('staff.member.assign', { memberId: core.member.id, memberKind: 'regular', reason: '身份纠错' }, DEMO_IDENTITIES.owner, core.member.revision));
  assert.equal(data(await ctx.call('registration.mine', {}, core.identity)).items[0].state, 'confirmed');
  data(await ctx.call('registration.cancel', { registrationId: joined.id, reason: '重新提交' }, core.identity, joined.revision));
  const current = data(await ctx.call('identity.me', {}, core.identity));
  data(await ctx.call('staff.member.assign', { memberId: current.id, memberKind: 'founder', expiresAt: '2026-10-15T12:01:00.000Z', reason: '有期限认定' }, DEMO_IDENTITIES.owner, current.revision));
  ctx.setClock('2026-10-15T12:02:00.000Z');
  assert.equal(data(await ctx.call('identity.me', {}, core.identity)).memberKind, 'regular');
  assert.equal((await apply(ctx, core.identity)).state, 'pending_confirmation');
});

test('recommendation consent is separate; low-point founder leads recommendation while real scores stay unchanged', async () => {
  const ctx = setup();
  const core = await founder(ctx);
  const regular = await newcomer(ctx, 'higher-score');
  await ctx.store.transaction(async (tx) => {
    const id = statsIdFor('oradv', regular.member.id, null);
    await tx.set('member_stats', id, { id, clubId: 'oradv', memberId: regular.member.id, scope: 'growth', year: null, points: 500, completedCount: 0, revision: 1 });
  });
  for (const person of [core, regular]) {
    data(await ctx.call('profile.update', { rankingOptIn: true, rankingConsentVersion: 1 }, person.identity, person.member.revision));
  }
  assert.equal(data(await ctx.call('recommendation.list', {}, null)).items.length, 0);
  for (const person of [core, regular]) {
    const me = data(await ctx.call('identity.me', {}, person.identity));
    data(await ctx.call('profile.update', { recommendationOptIn: true, recommendationConsentVersion: 1 }, person.identity, me.revision));
  }
  const recommended = data(await ctx.call('recommendation.list', {}, null)).items;
  assert.equal(recommended[0].memberKind, 'founder');
  assert.equal(recommended[0].growthPoints, 0);
  assert.equal(data(await ctx.call('ranking.list', {}, null)).items[0].score, 500);
  const me = data(await ctx.call('identity.me', {}, core.identity));
  data(await ctx.call('profile.update', { recommendationOptIn: false }, core.identity, me.revision));
  assert.equal(data(await ctx.call('recommendation.list', {}, null)).items.length, 1);
  assert.equal(data(await ctx.call('ranking.list', {}, null)).items.length, 2);
});

test('briefings are private to actual participants and event staff; public detail never leaks meeting data', async () => {
  const ctx = setup();
  const briefing = { activityId: 'intro-ride', meetingPoint: '受限集合地址', meetingTime: NOW, contactName: '现场领队', contactMethod: 'phone', contactValue: '010-00000000', checklist: ['检查护具'], notes: '内部安排' };
  data(await ctx.call('staff.briefing.save', briefing, DEMO_IDENTITIES.owner, 0));
  error(await ctx.call('activity.briefing.get', { activityId: 'intro-ride' }, null), 'UNAUTHENTICATED');
  error(await ctx.call('activity.briefing.get', { activityId: 'intro-ride' }, DEMO_IDENTITIES.member), 'FORBIDDEN');
  const core = await founder(ctx);
  const joined = await apply(ctx, core.identity);
  assert.equal(data(await ctx.call('activity.briefing.get', { activityId: 'intro-ride' }, core.identity)).meetingPoint, briefing.meetingPoint);
  assert.equal(JSON.stringify(data(await ctx.call('activity.get', { activityId: 'intro-ride' }, null))).includes(briefing.meetingPoint), false);
  data(await ctx.call('registration.cancel', { registrationId: joined.id, reason: '取消' }, core.identity, joined.revision));
  error(await ctx.call('activity.briefing.get', { activityId: 'intro-ride' }, core.identity), 'FORBIDDEN');
  error(await ctx.call('activity.briefing.get', { activityId: 'advanced-ride' }, DEMO_IDENTITIES.leader), 'FORBIDDEN');
});

test('approved public contact is necessary before publishing and only owner may configure it', async () => {
  const ctx = setup();
  assert.equal(data(await ctx.call('club.public', {}, null)).configured, true);
  error(await ctx.call('staff.club.save', { name: '俱乐部', contactName: '联系人', contactMethod: 'wechat', contactValue: 'contact', contactInstructions: '工作时间联系' }, DEMO_IDENTITIES.member, 1), 'FORBIDDEN');
  await ctx.store.transaction((tx) => tx.set('clubs', 'oradv', { id: 'oradv', clubId: 'oradv', revision: 1 }));
  error(await ctx.call('staff.activity.publish', { activityId: 'draft-ride' }, DEMO_IDENTITIES.owner, 1), 'INVALID_INPUT');
});

test('founders cannot bypass growth or independent skill qualification and expiry checks', async () => {
  const ctx = setup();
  const core = await founder(ctx);
  await ctx.store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, minGrowthPoints: 1 });
  });
  error(await ctx.call('registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 1 }, core.identity), 'SCORE_TOO_LOW');
  await ctx.store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, minGrowthPoints: 0, requiredQualifications: ['offroad'] });
  });
  error(await ctx.call('registration.apply', { activityId: 'intro-ride', acceptedRuleVersion: 1 }, core.identity), 'QUALIFICATION_REQUIRED');
  data(await ctx.call('staff.qualification.review', { memberId: core.member.id, type: 'offroad', decision: 'approved', expiresAt: '2026-10-15T12:01:00.000Z', reason: '现场专业核验' }, DEMO_IDENTITIES.operator, 0));
  const joined = await apply(ctx, core.identity);
  assert.equal(joined.state, 'confirmed');
  ctx.setClock('2026-10-15T12:02:00.000Z');
  const activity = data(await ctx.call('activity.get', { activityId: 'intro-ride' }));
  data(await ctx.call('staff.activity.start', { activityId: activity.id }, DEMO_IDENTITIES.owner, activity.revision));
  error(await ctx.call('staff.checkin.record', { registrationId: joined.id, phase: 'departure', result: 'present' }, DEMO_IDENTITIES.leader), 'QUALIFICATION_EXPIRED');
});

test('membership version conflicts and recognition requests never grant privileges', async () => {
  const ctx = setup();
  const regular = await newcomer(ctx, 'recognition-request');
  const request = data(await ctx.call('identity.memberKind.request', { reason: '请通过既有渠道核对' }, regular.identity));
  assert.equal(request.status, 'pending');
  const current = data(await ctx.call('identity.me', {}, regular.identity));
  assert.equal(current.memberKind, 'regular');
  assert.equal(current.kindRequestStatus, 'pending');
  assert.equal(data(await ctx.call('identity.memberKind.request', {}, regular.identity)).requestedAt, request.requestedAt);
  error(await ctx.call('staff.member.assign', { memberId: current.id, memberKind: 'founder', reason: '旧版本认定' }, DEMO_IDENTITIES.owner, regular.member.revision), 'CONFLICT_REFRESH');
  data(await ctx.call('staff.member.assign', { memberId: current.id, memberKind: 'founder', reason: '可靠渠道核对完成' }, DEMO_IDENTITIES.owner, current.revision));
  const assigned = data(await ctx.call('identity.me', {}, regular.identity));
  assert.equal(assigned.memberKind, 'founder');
  assert.equal(assigned.kindRequestStatus, 'resolved');
  assert.equal(assigned.rankingOptIn, false);
  assert.equal(assigned.recommendationOptIn, false);
  assert.deepEqual(assigned.roles, []);
});

test('recommendation alone never publishes scores and deleting identity removes every public view', async () => {
  const ctx = setup();
  const core = await founder(ctx);
  data(await ctx.call('profile.update', { nickname: '公开昵称', recommendationOptIn: true, recommendationConsentVersion: 1 }, core.identity, core.member.revision));
  const row = data(await ctx.call('recommendation.list', {}, null)).items[0];
  assert.equal(row.memberKind, 'founder');
  assert.equal('growthPoints' in row, false);
  assert.equal('completedCount' in row, false);
  assert.equal('priority' in row, false);
  assert.equal('memberId' in row, false);
  assert.equal(JSON.stringify(row).includes(core.identity.openId), false);
  data(await ctx.call('identity.delete', {}, core.identity));
  assert.equal(data(await ctx.call('recommendation.list', {}, null)).items.length, 0);
});

test('expired or revoked founders lose priority and stale recommendation cursors must refresh', async () => {
  const ctx = setup();
  const core = await founder(ctx);
  data(await ctx.call('staff.member.assign', { memberId: core.member.id, memberKind: 'founder', expiresAt: '2026-10-15T12:01:00.000Z', reason: '期限认定' }, DEMO_IDENTITIES.owner, core.member.revision));
  const people = [core];
  for (let i = 0; i < 21; i++) people.push(await newcomer(ctx, `recommend-${i}`));
  for (const person of people) {
    const me = data(await ctx.call('identity.me', {}, person.identity));
    data(await ctx.call('profile.update', { recommendationOptIn: true, recommendationConsentVersion: 1 }, person.identity, me.revision));
  }
  const first = data(await ctx.call('recommendation.list', {}, null));
  assert.equal(first.items[0].memberKind, 'founder');
  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  ctx.setClock('2026-10-15T12:02:00.000Z');
  error(await ctx.call('recommendation.list', { cursor: first.nextCursor }, null), 'CONFLICT_REFRESH');
  assert.ok(data(await ctx.call('recommendation.list', {}, null)).items.every((row: any) => row.memberKind === 'regular'));
});

test('member directory covers 200 members with bounded transactions, current roles and matching search', async () => {
  const seed = createDemoStore(NOW).snapshot();
  const sourceMember = Object.values(seed.memberships)[0] as any;
  const sourceUser = Object.values(seed.users)[0] as any;
  for (let index = 0; index < 194; index++) {
    const identity = { appId: 'demo-app', openId: `directory-${index}` };
    const userId = userIdFor(identity), memberId = memberIdFor('oradv', userId);
    seed.users[userId] = { ...sourceUser, id: userId, wxOpenId: identity.openId };
    seed.memberships[memberId] = { ...sourceMember, id: memberId, userId, nickname: index < 2 ? '重名车友' : `目录车友${index}`, publicId: key('public', memberId) };
  }
  const memory = new MemoryStore(seed, () => NOW);
  let maximum = 0;
  const bounded: Store = {
    query: (collection, filters, options) => memory.query(collection, filters, options),
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => memory.transaction((tx) => {
      let operations = 0;
      const count = () => { maximum = Math.max(maximum, ++operations); assert.ok(operations <= 100); };
      return work(withMetadata({ get: (collection,id) => { count(); return tx.get(collection,id); }, set: (collection,id,value) => { count(); return tx.set(collection,id,value); } }, NOW));
    }),
  };
  const ctx = setup(bounded);
  const members: any[] = [];
  let cursor: string | undefined;
  do {
    const page = data(await ctx.call('staff.member.list', { cursor }));
    assert.ok(page.items.length <= 20);
    members.push(...page.items); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(members.length, 200);
  assert.equal(new Set(members.map((member) => member.id)).size, 200);
  const duplicateNames = data(await ctx.call('staff.member.list', { query: '重名车友' }));
  assert.equal(duplicateNames.items.length, 2);
  assert.notEqual(duplicateNames.items[0].id, duplicateNames.items[1].id);
  const owner = members.find((member) => member.staffRoles.some((role: any) => role.role === 'owner'));
  assert.equal(owner.staffRoles[0].revision, 1);
  assert.equal(JSON.stringify(members).includes('wxOpenId'), false);
  error(await ctx.call('staff.member.list', {}, DEMO_IDENTITIES.leader), 'FORBIDDEN');
  assert.ok(maximum <= 100);
});

test('private briefing rejects legacy unscoped leaders and owner cannot expire own authority', async () => {
  const ctx = setup();
  await ctx.store.transaction(async (tx) => {
    const id = key('role', 'oradv', userIdFor(DEMO_IDENTITIES.leader), 'leader');
    const role = await tx.get<any>('staff_roles', id);
    await tx.set('staff_roles', id, { ...role, activityIds: null });
  });
  error(await ctx.call('activity.briefing.get', { activityId: 'advanced-ride' }, DEMO_IDENTITIES.leader), 'FORBIDDEN');
  const owner = data(await ctx.call('identity.me', {}, DEMO_IDENTITIES.owner));
  error(await ctx.call('staff.roles.assign', { memberId: owner.id, role: 'owner', activityIds: null, expiresAt: '2027-01-01T00:00:00.000Z' }, DEMO_IDENTITIES.owner, 1), 'STATE_CONFLICT');
  error(await ctx.call('staff.club.save', { name: '原始拉力', contactName: '联系人', contactMethod: 'phone', contactValue: '不可拨打' }, DEMO_IDENTITIES.owner, 1), 'INVALID_INPUT');
});

test('founder and regular concurrent applications cannot both claim the final seat', async () => {
  const ctx = setup();
  const core = await founder(ctx);
  await ctx.store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, capacity: 1 });
  });
  const results = await Promise.all([apply(ctx, core.identity), apply(ctx, DEMO_IDENTITIES.member)]);
  assert.equal(results.filter((row) => row.seatState === 'held').length, 1);
  assert.equal(results.filter((row) => row.state === 'waitlisted').length, 1);
  assert.equal(data(await ctx.call('activity.get', { activityId: 'intro-ride' })).reservedSeats, 1);
});

test('promotion rechecks revoked founder identity while retaining original application facts', async () => {
  const ctx = setup();
  const core = await founder(ctx);
  await ctx.store.transaction(async (tx) => {
    const activity = (await tx.get<Activity>('activities', 'intro-ride'))!;
    await tx.set('activities', activity.id, { ...activity, capacity: 1 });
  });
  const held = await apply(ctx, DEMO_IDENTITIES.member);
  const waiting = await apply(ctx, core.identity);
  assert.equal(waiting.memberKindAtApplication, 'founder');
  const me = data(await ctx.call('identity.me', {}, core.identity));
  data(await ctx.call('staff.member.assign', { memberId: me.id, memberKind: 'regular', reason: '身份核对更正' }, DEMO_IDENTITIES.owner, me.revision));
  data(await ctx.call('registration.cancel', { registrationId: held.id, reason: '取消参加' }, DEMO_IDENTITIES.member, held.revision));
  const promoted = data<Registration>(await ctx.call('staff.waitlist.promote', { activityId: 'intro-ride' }));
  assert.equal(promoted.memberKindAtApplication, 'founder');
  assert.equal(promoted.state, 'pending_confirmation');
  assert.equal(promoted.confirmationPath, 'staff_manual');
  assert.equal(promoted.confirmedAt, undefined);
});

test('priority changes invalidate recommendation cursors even when visible order is unchanged', async () => {
  const ctx = setup();
  const people = [];
  for (let index = 0; index < 21; index++) {
    const person = await newcomer(ctx, `priority-cursor-${index}`);
    const opted = data(await ctx.call('profile.update', { recommendationOptIn: true, recommendationConsentVersion: 1 }, person.identity, person.member.revision));
    data(await ctx.call('staff.recommendation.save', { memberId: person.member.id, priority: 900 - index * 10, reason: '初始编排' }, DEMO_IDENTITIES.owner, opted.revision));
    people.push(person);
  }
  const first = data(await ctx.call('recommendation.list', {}, null));
  assert.equal(first.items.length, 20);
  const last = people[19];
  const me = data(await ctx.call('identity.me', {}, last.identity));
  data(await ctx.call('staff.recommendation.save', { memberId: last.member.id, priority: 709, reason: '微调编排，展示先后不变' }, DEMO_IDENTITIES.owner, me.revision));
  const refreshed = data(await ctx.call('recommendation.list', {}, null));
  assert.deepEqual(refreshed.items, first.items, 'public entries and their order should remain identical');
  error(await ctx.call('recommendation.list', { cursor: first.nextCursor }, null), 'CONFLICT_REFRESH');
  const next = data(await ctx.call('recommendation.list', { cursor: refreshed.nextCursor }, null));
  assert.equal(next.items.length, 1);
  assert.equal(new Set([...refreshed.items, ...next.items].map((row: any) => row.memberPublicId)).size, 21);
});
