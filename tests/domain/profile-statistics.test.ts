import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import { memberIdFor, userIdFor } from '../../shared/models';
import type { Membership, User } from '../../shared/models';
import type { Store } from '../../shared/store';
import { Context } from '../../shared/context';
import { ownRanking } from '../../shared/club-overview';

const NOW = '2026-10-16T12:00:00.000Z', mid = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
function setup() {
  const store = createDemoStore(NOW); let n = 0;
  const serviceFor = (backing: Store = store) => createService(backing, { now: () => NOW });
  const call = (action: string, payload: Record<string, unknown> = {}, revision?: number, backing: Store = store) => serviceFor(backing).handle({ action, payload, expectedRevision: revision, clubId: 'oradv', requestId: `profile-statistics-${++n}` }, DEMO_IDENTITIES.member);
  const optIn = async () => { const who = data(await call('identity.me')); return data(await call('profile.update', { rankingOptIn: true, rankingConsentVersion: 1 }, who.revision)); };
  return { store, call, optIn };
}
function data(result: any): any { assert(result.ok, JSON.stringify(result)); return result.data; }

test('profile uses persisted joining time and unknown actual distance, and never scans a nonconsenting member ranking', async () => {
  const env = setup(), member = env.store.snapshot().memberships[mid] as Membership;
  const backing: Store = { transaction: env.store.transaction.bind(env.store), async query(collection, filters, options) { assert.notEqual(collection, 'public_rankings'); return env.store.query(collection, filters, options); } };
  const before = env.store.snapshot(), overview = data(await env.call('profile.overview', {}, undefined, backing));
  assert.equal(overview.statistics.joinedAt, member.createdAt); assert.equal(overview.statistics.rank, null); assert.equal(overview.statistics.rankedMembers, null);
  assert.equal(overview.statistics.distanceKm, null); assert.equal(overview.statistics.distanceStatus, 'unrecorded'); assert.equal(overview.statisticsError, '');
  assert.deepEqual(env.store.snapshot(), before);
});

test('profile rank reuses the actual live public ranking while optional backend failures preserve the verified private profile', async () => {
  const env = setup(); await env.optIn();
  const rank = data(await env.call('ranking.mine')), overview = data(await env.call('profile.overview'));
  assert.equal(overview.statistics.rank, rank.rank); assert.equal(overview.statistics.rankedMembers, rank.publicCount);
  const backing: Store = { transaction: env.store.transaction.bind(env.store), async query(collection, filters, options) { if (collection === 'public_rankings') throw Error('private-ranking-SDK-details'); return env.store.query(collection, filters, options); } };
  const failed = data(await env.call('profile.overview', {}, undefined, backing));
  assert.equal(failed.member.id, mid); assert(failed.dossier); assert.equal(failed.statistics.rank, null); assert.equal(failed.statistics.rankedMembers, null); assert(failed.statisticsError);
  assert(!JSON.stringify(failed).includes('SDK-details'));
});

test('identity disabled during the optional rank read fails closed, while consent withdrawal returns no stale rank', async () => {
  for (const change of ['disable', 'withdraw']) {
    const env = setup(); await env.optIn(); let changed = false;
    const backing: Store = { transaction: env.store.transaction.bind(env.store), async query<T>(collection: string, filters: Record<string, unknown>, options: any) {
      const rows = await env.store.query<T>(collection, filters, options);
      if (!changed && collection === 'public_rankings') {
        changed = true;
        await env.store.transaction(async tx => {
          if (change === 'disable') { const id = userIdFor(DEMO_IDENTITIES.member), user = await tx.get<User>('users', id); await tx.set('users', id, { ...user!, status: 'disabled' }); }
          else { const member = await tx.get<Membership>('memberships', mid); await tx.set('memberships', mid, { ...member!, rankingOptIn: false, revision: member!.revision + 1 }); }
        });
      }
      return rows;
    } };
    const response = await env.call('profile.overview', {}, undefined, backing);
    if (change === 'disable') { assert(!response.ok); assert.equal(response.error.code, 'FORBIDDEN'); }
    else { const overview = data(response); assert.equal(overview.member.rankingOptIn, false); assert.equal(overview.statistics.rank, null); assert.equal(overview.statistics.rankedMembers, null); }
  }
});

test('optional ranking budget stops before another page without weakening the complete ranking endpoint', async () => {
  const env = setup(); await env.optIn(); let queries = 0;
  const backing: Store = { transaction: env.store.transaction.bind(env.store), async query(collection, filters, options) { queries++; return env.store.query(collection, filters, options); } };
  const ctx = new Context(backing, { now: () => NOW }, { action: 'ranking.mine', clubId: 'oradv', payload: {}, requestId: 'budget-rank' }, DEMO_IDENTITIES.member);
  await assert.rejects(ownRanking(ctx, { deadlineMs: Date.now() - 1 }), { code: 'TEMPORARY_FAILURE' }); assert.equal(queries, 0);
  assert.notEqual(data(await env.call('ranking.mine')).rank, null);
});
