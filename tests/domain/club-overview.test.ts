import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../../shared/context';
import { DomainError } from '../../shared/errors';
import { dispatchClubOverview } from '../../shared/club-overview';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import { key, memberIdFor, shanghaiYear, userIdFor } from '../../shared/models';
import type { Membership, PublicRanking, User } from '../../shared/models';
import type { QueryOptions, Store } from '../../shared/store';
import type { TrustedIdentity } from '../../shared/types';

const NOW = '2026-10-16T08:00:00.000Z';
async function setup() {
  const store = createDemoStore(NOW), service = createService(store, { now: () => NOW });
  const request = (action: string, payload: Record<string, unknown> = {}, expectedRevision?: number) => service.handle({ action, payload, clubId: 'oradv', requestId: 'overview-test', expectedRevision }, DEMO_IDENTITIES.member);
  const call = (payload: Record<string, unknown> = {}, identity: TrustedIdentity | null = DEMO_IDENTITIES.member, customStore: Store = store) => dispatchClubOverview(new Context(customStore, { now: () => NOW }, { action: 'ranking.mine', payload, clubId: 'oradv', requestId: 'own-rank' }, identity));
  return { store, request, call };
}
function result(response: any) { assert.equal(response.ok, true, JSON.stringify(response)); return response.data; }
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);

test('private ranking has no invented rank or participant count and rejects identity overrides', async () => {
  const ctx = await setup();
  const before = ctx.store.snapshot();
  const mine = await ctx.call();
  assert.equal(mine.rankingOptIn, false); assert.equal(mine.rank, null); assert.equal(mine.publicCount, null); assert.equal(mine.score, null);
  assert.equal(mine.metric, 'growth'); assert.equal(mine.year, 2026);
  assert.deepEqual(ctx.store.snapshot(), before, 'overview reads must not mutate business data');
  await rejects(ctx.call({ memberId: 'forged' }), 'INVALID_INPUT');
  await rejects(ctx.call({ metric: 'recommended' }), 'INVALID_INPUT');
  await rejects(ctx.call({ year: '2026' }), 'INVALID_INPUT');
  await rejects(ctx.call({}, null), 'UNAUTHENTICATED');
});

test('own public rank and actual count come from the same 200-member live list with genuine tie ranks', async () => {
  const ctx = await setup();
  const member = result(await ctx.request('identity.me'));
  result(await ctx.request('profile.update', { rankingOptIn: true, rankingConsentVersion: 1 }, member.revision));
  const ownId = member.id;
  await ctx.store.transaction(async tx => {
    const own = (await tx.get<Membership>('memberships', ownId))!;
    for (let number = 0; number < 200; number++) {
      const identity = number === 100 ? DEMO_IDENTITIES.member : { appId: 'demo-app', openId: `overview-${number}` };
      const userId = userIdFor(identity), memberId = memberIdFor('oradv', userId), publicId = number === 100 ? own.publicId : `public-overview-${number}`;
      if (number !== 100) {
        const user: User = { id: userId, clubId: 'oradv', appId: identity.appId, wxOpenId: identity.openId, status: 'active', consentVersions: {}, createdAt: NOW, updatedAt: NOW };
        await tx.set('users', userId, user);
        await tx.set('memberships', memberId, { ...own, id: memberId, userId, publicId, nickname: `演示成员${number}` });
      }
      for (const metric of ['growth', 'annual', 'completed_count']) {
        const year = metric === 'annual' ? shanghaiYear(NOW) : null;
        const id = key('ranking', 'oradv', memberId, metric, year ?? 'all');
        const row: PublicRanking & { visible: boolean } = { id, clubId: 'oradv', memberId, memberPublicId: publicId, nickname: `演示成员${number}`, metric, year,
          score: number < 100 ? 2 : 1, completedCount: 1, consentVersion: 1, visible: true };
        await tx.set('public_rankings', id, row);
      }
    }
  });
  for (const metric of ['growth', 'annual', 'completed_count']) {
    const mine = await ctx.call({ metric, year: 2026 });
    assert.equal(mine.rankingOptIn, true); assert.equal(mine.rank, 101); assert.equal(mine.publicCount, 200); assert.equal(mine.score, 1);
    assert.equal(mine.metric, metric); assert.equal(mine.year, 2026);
    assert.equal((mine as any).memberId, undefined); assert.equal((mine as any).nickname, undefined);
  }
});

test('opt-in without a public projection is unlisted instead of fabricated zero rank', async () => {
  const ctx = await setup();
  const member = result(await ctx.request('identity.me'));
  await ctx.store.transaction(async tx => {
    const original = (await tx.get<Membership>('memberships', member.id))!;
    await tx.set('memberships', member.id, { ...original, rankingOptIn: true, rankingConsentVersion: 1 });
  });
  const mine = await ctx.call(); assert.equal(mine.rankingOptIn, true); assert.equal(mine.rank, null); assert.equal(mine.publicCount, 0);
});

test('withdrawal or disabled identity during a scan never returns an old own rank', async () => {
  for (const operation of ['withdraw', 'disable']) {
    const ctx = await setup(), member = result(await ctx.request('identity.me'));
    result(await ctx.request('profile.update', { rankingOptIn: true, rankingConsentVersion: 1 }, member.revision));
    let changed = false;
    const changing: Store = { transaction: ctx.store.transaction.bind(ctx.store), async query<T>(collection: string, filters: Record<string, unknown>, options?: QueryOptions) {
      const rows = await ctx.store.query<T>(collection, filters, options);
      if (!changed) {
        changed = true;
        if (operation === 'withdraw') {
          const current = result(await ctx.request('identity.me'));
          result(await ctx.request('profile.update', { rankingOptIn: false }, current.revision));
        } else await ctx.store.transaction(async tx => {
          const userId = userIdFor(DEMO_IDENTITIES.member), user = (await tx.get<User>('users', userId))!;
          await tx.set('users', userId, { ...user, status: 'disabled' });
        });
      }
      return rows;
    } };
    await rejects(ctx.call({}, DEMO_IDENTITIES.member, changing), operation === 'withdraw' ? 'CONFLICT_REFRESH' : 'FORBIDDEN');
  }
});
