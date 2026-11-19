import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../../shared/service';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { memberIdFor, userIdFor } from '../../shared/models';
import type { RpcResponse, TrustedIdentity } from '../../shared/types';

const NOW = '2026-11-01T04:00:00.000Z';
function setup() {
  const store = createDemoStore(NOW);
  let n = 0;
  const call = (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity | null = DEMO_IDENTITIES.owner, expectedRevision?: number) =>
    createService(store, { now: () => NOW, id: () => `backfill-${++n}` }).handle({ action, payload, clubId: 'oradv', requestId: `backfill-${n}`, expectedRevision }, identity);
  return { store, call };
}
function data<T = any>(response: RpcResponse): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { data: T }).data;
}

test('owner can archive a finished activity and grant one idempotent score', async () => {
  const ctx = setup();
  const member = data(await ctx.call('identity.me', {}, DEMO_IDENTITIES.member));
  const denied = await ctx.call('staff.activity.backfill', { title: '已完成的春季穿越', description: '回顾简介', location: '演示路段', startAt: '2026-03-01T01:00:00.000Z', endAt: '2026-03-02T10:00:00.000Z', growth: 80, annual: 80 }, DEMO_IDENTITIES.member);
  assert.equal(denied.ok, false);
  const activity = data<{ id: string }>(await ctx.call('staff.activity.backfill', {
    title: '已完成的春季穿越', description: '这一场的回顾简介', location: '演示路段',
    startAt: '2026-03-01T01:00:00.000Z', endAt: '2026-03-02T10:00:00.000Z', actualCompletedAt: '2026-03-02T10:00:00.000Z',
    growth: 80, annual: 40,
  }));
  const first = data<{ idempotent: boolean; growth: number; ledgerId: string }>(await ctx.call('staff.points.backfill', { activityId: activity.id, memberNumber: member.memberNumber, growth: 80, annual: 40, reason: '核对名单后补记' }));
  assert.equal(first.idempotent, false); assert.equal(first.growth, 80);
  const again = data<{ idempotent: boolean }>(await ctx.call('staff.points.backfill', { activityId: activity.id, memberNumber: member.memberNumber, growth: 80, annual: 40, reason: '重复提交' }));
  assert.equal(again.idempotent, true);
  const changed = await ctx.call('staff.points.backfill', { activityId: activity.id, memberNumber: member.memberNumber, growth: 90, annual: 40, reason: '想直接改分' });
  assert.equal(changed.ok, false);
  const points = data<{ growthPoints: number; items: { id: string }[] }>(await ctx.call('points.mine', { year: 2026 }, DEMO_IDENTITIES.member));
  assert.equal(points.growthPoints, 80);
  assert.equal(points.items.filter(row => row.id === first.ledgerId).length, 1);
  data(await ctx.call('staff.qualification.review', { memberId: member.id, type: 'basic_control', decision: 'approved', reason: '基础控车考核通过' }, DEMO_IDENTITIES.owner, 0));
  const board = data<{ items: { memberPublicId: string; nickname: string; score: number; rank: number; certifiedRider: boolean }[] }>(await ctx.call('ranking.list', {}, DEMO_IDENTITIES.member));
  assert.equal(board.items[0].score, 80); assert.equal(board.items[0].rank, 1); assert.equal(board.items[0].certifiedRider, false);
  const certified = data<{ certifiedRider: boolean }>(await ctx.call('staff.member.certify', { memberPublicId: board.items[0].memberPublicId, certified: true, reason: '授予认证车手' }));
  assert.equal(certified.certifiedRider, true);
  const shown = data<{ items: { certifiedRider: boolean }[] }>(await ctx.call('ranking.list', {}, DEMO_IDENTITIES.member));
  assert.equal(shown.items[0].certifiedRider, true);
  assert.equal(memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member)), member.id);
});

test('a reversed backfill grant can be granted again with a corrected amount, and only backfilled activities accept grants', async () => {
  const ctx = setup();
  const member = data(await ctx.call('identity.me', {}, DEMO_IDENTITIES.member));
  const activity = data<{ id: string }>(await ctx.call('staff.activity.backfill', {
    title: '已完成的秋季穿越', description: '回顾简介', location: '演示路段',
    startAt: '2026-09-01T01:00:00.000Z', endAt: '2026-09-02T10:00:00.000Z', growth: 60, annual: 60,
  }));
  const first = data<{ ledgerId: string }>(await ctx.call('staff.points.backfill', { activityId: activity.id, memberNumber: member.memberNumber, reason: '名单核对' }));
  data(await ctx.call('staff.points.reverse', { ledgerId: first.ledgerId, reason: '分值填错' }));
  const zero = data<{ growthPoints: number }>(await ctx.call('points.mine', { year: 2026 }, DEMO_IDENTITIES.member));
  assert.equal(zero.growthPoints, 0);
  const corrected = data<{ idempotent: boolean; ledgerId: string }>(await ctx.call('staff.points.backfill', { activityId: activity.id, memberNumber: member.memberNumber, growth: 90, annual: 90, reason: '更正后重新补记' }));
  assert.equal(corrected.idempotent, false); assert.notEqual(corrected.ledgerId, first.ledgerId);
  const repeated = data<{ idempotent: boolean }>(await ctx.call('staff.points.backfill', { activityId: activity.id, memberNumber: member.memberNumber, growth: 90, annual: 90, reason: '重复提交' }));
  assert.equal(repeated.idempotent, true);
  const after = data<{ growthPoints: number; completedCount: number }>(await ctx.call('points.mine', { year: 2026 }, DEMO_IDENTITIES.member));
  assert.equal(after.growthPoints, 90); assert.equal(after.completedCount, 1);
  // The corrected grant can itself be reversed.
  data(await ctx.call('staff.points.reverse', { ledgerId: corrected.ledgerId, reason: '再次核对' }));
  assert.equal(data<{ growthPoints: number }>(await ctx.call('points.mine', { year: 2026 }, DEMO_IDENTITIES.member)).growthPoints, 0);
  // A normally run activity never accepts a manual grant.
  await ctx.store.transaction(async tx => {
    const { backfill: _flag, ...normal } = (await tx.get<Record<string, unknown>>('activities', activity.id))!;
    await tx.set('activities', 'normal-settled', { ...normal, id: 'normal-settled' });
  });
  const rejected = await ctx.call('staff.points.backfill', { activityId: 'normal-settled', memberNumber: member.memberNumber, reason: '跳过核验' });
  assert.equal(rejected.ok, false);
  assert.equal((rejected as { error: { code: string } }).error.code, 'STATE_CONFLICT');
  const guest = await ctx.call('staff.points.backfill', { activityId: activity.id, memberNumber: member.memberNumber, reason: '越权' }, DEMO_IDENTITIES.member);
  assert.equal(guest.ok, false);
});

test('a dated basic qualification leaves the board after it expires and a disabled account is hidden at read time', async () => {
  const ctx = setup();
  const member = data(await ctx.call('identity.me', {}, DEMO_IDENTITIES.member));
  data(await ctx.call('staff.qualification.review', { memberId: member.id, type: 'basic_control', decision: 'approved', expiresAt: '2026-11-10T00:00:00.000Z', reason: '有期限的考核' }, DEMO_IDENTITIES.owner, 0));
  const listed = data<{ items: { memberPublicId: string; nickname: string }[] }>(await ctx.call('ranking.list', {}, DEMO_IDENTITIES.owner));
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].nickname, member.nickname);
  member.publicId = listed.items[0].memberPublicId;
  const later = (action: string, payload: Record<string, unknown>, identity: TrustedIdentity) =>
    createService(ctx.store, { now: () => '2026-11-11T00:00:00.000Z' }).handle({ action, payload, clubId: 'oradv', requestId: 'later' }, identity);
  const expired = data<{ items: { memberPublicId: string }[] }>(await later('ranking.list', {}, DEMO_IDENTITIES.owner));
  assert.equal(expired.items.some(item => item.memberPublicId === member.publicId), false);
  data(await ctx.call('staff.qualification.review', { memberId: member.id, type: 'basic_control', decision: 'approved', reason: '长期有效' }, DEMO_IDENTITIES.owner, 1));
  assert.ok(data<{ items: { memberPublicId: string }[] }>(await ctx.call('ranking.list', {}, DEMO_IDENTITIES.owner)).items.some(item => item.memberPublicId === member.publicId));
  await ctx.store.transaction(async tx => {
    const userId = userIdFor(DEMO_IDENTITIES.member), user = (await tx.get<Record<string, unknown>>('users', userId))!;
    await tx.set('users', userId, { ...user, status: 'disabled' });
  });
  const hidden = data<{ items: { memberPublicId: string }[] }>(await ctx.call('ranking.list', {}, DEMO_IDENTITIES.owner));
  assert.equal(hidden.items.some(item => item.memberPublicId === member.publicId), false);
});
