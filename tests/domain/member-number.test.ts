import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../../shared/service';
import { MemoryStore } from '../../shared/memory-store';
import { demoSnapshot, DEMO_IDENTITIES, upgradeDemoMemberNumbers } from '../../shared/demo';
import { showcaseSnapshot } from '../../shared/demo-showcase';
import { key, memberIdFor, userIdFor } from '../../shared/models';
import { allocateMemberNumber, memberNumberClaimId, memberSequenceId } from '../../shared/member-number';
import { bootstrapOwner } from '../../shared/owner-bootstrap';
import type { Membership } from '../../shared/models';
import type { MemberSummary, RpcResponse, TrustedIdentity } from '../../shared/types';

const NOW = '2026-10-17T08:00:00.000Z';
const APP_ID = 'wx0123456789abcdef';
const user = (name: string) => ({ appId: APP_ID, openId: `fictional-number-${name}` });
function data<T = any>(response: RpcResponse): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { data: T }).data;
}
function failure(response: RpcResponse, code: string) {
  assert.equal(response.ok, false);
  assert.equal((response as { error: { code: string } }).error.code, code);
}
function setup(store = new MemoryStore({}, () => NOW)) {
  const service = createService(store, { now: () => NOW });
  let sequence = 0;
  const call = (identity: TrustedIdentity, action: string, payload: Record<string, unknown> = {}, expectedRevision?: number) =>
    service.handle({ action, payload, expectedRevision, requestId: `number-${++sequence}`, clubId: 'oradv' }, identity);
  const ensure = async (identity: TrustedIdentity, payload: Record<string, unknown> = {}) => data<MemberSummary>(await call(identity, 'identity.ensure', { consentVersions: { privacy: 1, terms: 1 }, ...payload }));
  return { store, call, ensure };
}
const bootOptions = (memberId: string) => ({ clubId: 'oradv', appId: APP_ID, memberId, actorId: 'deployment:fictional', traceId: 'offline-bootstrap', envId: 'offline-test-env', now: NOW });

test('member numbers start at one, remain unique under concurrency and identity retries consume no new number', async () => {
  const ctx = setup();
  const identities = Array.from({ length: 12 }, (_, index) => user(String(index)));
  const members = await Promise.all(identities.map(identity => ctx.ensure(identity)));
  assert.deepEqual(members.map(member => member.memberNumber).sort((a, b) => a! - b!), Array.from({ length: 12 }, (_, index) => index + 1));
  for (let index = 0; index < members.length; index++) assert.equal((await ctx.ensure(identities[index])).memberNumber, members[index].memberNumber);
  const repeated = await Promise.all(Array.from({ length: 5 }, () => ctx.ensure(identities[0])));
  assert(repeated.every(member => member.memberNumber === members[0].memberNumber));
  const snapshot = ctx.store.snapshot();
  assert.equal((snapshot.clubs[memberSequenceId('oradv')] as any).nextNumber, 13);
  for (const member of members) assert.equal((snapshot.clubs[memberNumberClaimId('oradv', member.memberNumber!)] as any).memberId, member.id);
  assert.equal(snapshot.clubs[memberNumberClaimId('oradv', 0)], undefined);
  assert(members.every(member => !member.roles.length));
});

test('failed member creation rolls back identity, counter and claim atomically', async () => {
  const backing = new MemoryStore({}, () => NOW);
  let fail = true;
  const service = createService({ query: backing.query.bind(backing), transaction: work => backing.transaction(tx => work({ ...tx,
    set: async (collection, id, value) => { if (fail && collection === 'audit_logs') throw new Error('injected audit failure'); return tx.set(collection, id, value); },
  })) }, { now: () => NOW });
  const request = { action: 'identity.ensure', payload: { consentVersions: { privacy: 1, terms: 1 } }, requestId: 'rollback', clubId: 'oradv' };
  failure(await service.handle(request, user('rollback')), 'TEMPORARY_FAILURE');
  assert.deepEqual(backing.snapshot(), {});
  fail = false;
  assert.equal(data<MemberSummary>(await service.handle(request, user('rollback'))).memberNumber, 1);
});

test('forged zero and rollback of the private counter never grant authority or duplicate a claimed number', async () => {
  const ctx = setup();
  const first = await ctx.ensure(user('first'), { memberNumber: 0, role: 'owner' });
  assert.equal(first.memberNumber, 1);
  assert.deepEqual(first.roles, []);
  failure(await ctx.call(user('first'), 'profile.update', { memberNumber: 0 }, first.revision), 'INVALID_INPUT');
  await ctx.store.transaction(async tx => {
    const id = memberSequenceId('oradv'), counter = await tx.get<any>('clubs', id);
    await tx.set('clubs', id, { ...counter, nextNumber: 1 });
  });
  failure(await ctx.call(user('second'), 'identity.ensure', { consentVersions: { privacy: 1, terms: 1 } }), 'STATE_CONFLICT');
  assert.equal(Object.keys(ctx.store.snapshot().users).length, 1);
});

test('trusted bootstrap alone assigns zero, keeps the retired positive claim and later owner grants preserve numbers', async () => {
  const ctx = setup();
  const primary = await ctx.ensure(user('primary'));
  await ctx.store.transaction(tx => bootstrapOwner(tx, bootOptions(primary.id)));
  const after = data<MemberSummary>(await ctx.call(user('primary'), 'identity.me'));
  assert.equal(after.memberNumber, 0);
  assert.deepEqual(after.roles, ['owner']);
  assert.equal((ctx.store.snapshot().clubs[memberNumberClaimId('oradv', 1)] as any).memberId, primary.id);
  assert.equal((ctx.store.snapshot().clubs[memberNumberClaimId('oradv', 0)] as any).memberId, primary.id);
  const second = await ctx.ensure(user('secondary'));
  assert.equal(second.memberNumber, 2, 'retired one is never recycled');
  data(await ctx.call(user('primary'), 'staff.roles.assign', { memberId: second.id, role: 'owner', enabled: true, activityIds: null }));
  assert.equal(data<MemberSummary>(await ctx.call(user('secondary'), 'identity.me')).memberNumber, 2);
  await assert.rejects(ctx.store.transaction(tx => bootstrapOwner(tx, bootOptions(second.id))));
  assert.equal(data<MemberSummary>(await ctx.call(user('primary'), 'identity.me')).memberNumber, 0);
});

test('bootstrap validates trusted identity bindings and conflicting zero reservations without partial role writes', async () => {
  const ctx = setup();
  const person = await ctx.ensure(user('invalid-binding'));
  const id = userIdFor(user('invalid-binding'));
  await ctx.store.transaction(async tx => { const current = await tx.get<any>('users', id); await tx.set('users', id, { ...current, wxOpenId: 'forged-record' }); });
  await assert.rejects(ctx.store.transaction(tx => bootstrapOwner(tx, bootOptions(person.id))));
  assert.equal(Object.keys(ctx.store.snapshot().staff_roles ?? {}).length, 0);
  assert.equal(ctx.store.snapshot().clubs[memberNumberClaimId('oradv', 0)], undefined);
  const reserved = setup(), a = await reserved.ensure(user('reserved-a')), b = await reserved.ensure(user('reserved-b'));
  await reserved.store.transaction(tx => tx.set('clubs', memberNumberClaimId('oradv', 0), { id: memberNumberClaimId('oradv', 0), clubId: 'oradv', kind: 'member_number_claim', memberNumber: 0, memberId: a.id }));
  const before = reserved.store.snapshot();
  await assert.rejects(reserved.store.transaction(tx => bootstrapOwner(tx, bootOptions(b.id))));
  assert.deepEqual(reserved.store.snapshot(), before);
});

test('bootstrap audit failure rolls back zero, retired claims, role and member revision; concurrent bootstrap has one winner', async () => {
  const ctx = setup();
  const first = await ctx.ensure(user('bootstrap-a')), second = await ctx.ensure(user('bootstrap-b'));
  const before = ctx.store.snapshot();
  await assert.rejects(ctx.store.transaction(tx => bootstrapOwner({ ...tx, set: async (collection, id, value) => {
    if (collection === 'audit_logs') throw new Error('injected bootstrap audit failure');
    return tx.set(collection, id, value);
  } }, bootOptions(first.id))));
  assert.deepEqual(ctx.store.snapshot(), before);
  const results = await Promise.allSettled([ctx.store.transaction(tx => bootstrapOwner(tx, bootOptions(first.id))), ctx.store.transaction(tx => bootstrapOwner(tx, bootOptions(second.id)))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const memberships = Object.values(ctx.store.snapshot().memberships) as Membership[];
  assert.equal(memberships.filter(member => member.memberNumber === 0).length, 1);
  assert.equal(Object.keys(ctx.store.snapshot().schema_migrations).length, 1);
});

test('new fixtures number the designated owner zero and their other members form a complete positive range', () => {
  for (const snapshot of [demoSnapshot(NOW), showcaseSnapshot(NOW)]) {
    const ownerId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.owner));
    const members = Object.values(snapshot.memberships) as Membership[];
    assert.equal((snapshot.memberships[ownerId] as Membership).memberNumber, 0);
    assert.deepEqual(members.map(member => member.memberNumber).sort((a, b) => a! - b!), Array.from({ length: members.length }, (_, index) => index));
    assert.equal((snapshot.clubs[memberSequenceId('oradv')] as any).nextNumber, members.length);
    for (const member of members) assert.equal((snapshot.clubs[memberNumberClaimId('oradv', member.memberNumber!)] as any).memberId, member.id);
  }
});

test('legacy demo upgrade is pure, complete, idempotent and preserves avatars, identities and all business records', () => {
  const original = showcaseSnapshot(NOW);
  for (const [id, row] of Object.entries(original.clubs)) if (['member_sequence', 'member_number_claim'].includes((row as any).kind)) delete original.clubs[id];
  for (const value of Object.values(original.memberships) as Membership[]) delete value.memberNumber;
  const own = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
  (original.memberships[own] as Membership).avatarFileId = 'private-fictional-avatar';
  (original.memberships[own] as any).unknownFeature = { retained: true };
  const before = structuredClone(original);
  const next = upgradeDemoMemberNumbers(original);
  assert.deepEqual(original, before, 'input is never modified');
  for (const collection of ['users', 'registrations', 'points_ledger', 'checkins']) assert.deepEqual(next[collection], before[collection]);
  for (const [id, row] of Object.entries(next.memberships)) {
    const { memberNumber: _number, ...rest } = row as Membership;
    assert.deepEqual(rest, before.memberships[id]);
  }
  assert.deepEqual(upgradeDemoMemberNumbers(next), next);
  assert.equal((next.memberships[own] as Membership).avatarFileId, 'private-fictional-avatar');
});

test('demo upgrade preserves existing valid numbers and retired claims, rejects duplicates and zero impersonation', () => {
  const snapshot = demoSnapshot(NOW);
  const members = Object.values(snapshot.memberships) as Membership[];
  const ordinary = members.find(member => member.memberNumber === 1)!;
  const before = structuredClone(snapshot);
  const id = key('member-number', 'oradv', 100);
  snapshot.clubs[id] = { id, clubId: 'oradv', kind: 'member_number_claim', memberNumber: 100, memberId: ordinary.id };
  const upgraded = upgradeDemoMemberNumbers(snapshot);
  assert.equal((upgraded.memberships[ordinary.id] as Membership).memberNumber, 1);
  assert.deepEqual(upgraded.clubs[id], snapshot.clubs[id]);
  assert((upgraded.clubs[memberSequenceId('oradv')] as any).nextNumber > 100);
  const duplicate = structuredClone(before), target = Object.values(duplicate.memberships).find(row => (row as Membership).memberNumber === 2) as Membership;
  target.memberNumber = 1;
  assert.throws(() => upgradeDemoMemberNumbers(duplicate));
  const falseOwner = structuredClone(before);
  (falseOwner.memberships[ordinary.id] as Membership).memberNumber = 0;
  assert.throws(() => upgradeDemoMemberNumbers(falseOwner));
  const invalid = structuredClone(before); (invalid.memberships[ordinary.id] as any).memberNumber = '0';
  assert.throws(() => upgradeDemoMemberNumbers(invalid));
});

test('directory sorts numeric member numbers first, finds zero exactly and never searches hash ID suffixes', async () => {
  const ctx = setup(new MemoryStore(showcaseSnapshot(NOW), () => NOW));
  const list = data(await ctx.call(DEMO_IDENTITIES.owner, 'staff.member.list'));
  assert.deepEqual(list.items.map((member: Membership) => member.memberNumber), Array.from({ length: 20 }, (_, index) => index));
  const second = data(await ctx.call(DEMO_IDENTITIES.owner, 'staff.member.list', { cursor: list.nextCursor }));
  assert.deepEqual(second.items.map((member: Membership) => member.memberNumber), [20, 21, 22, 23]);
  const zero = data(await ctx.call(DEMO_IDENTITIES.owner, 'staff.member.list', { query: '0' }));
  assert.equal(zero.items.length, 1);
  assert.equal(zero.items[0].memberNumber, 0);
  const ownerId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.owner));
  assert.equal(data(await ctx.call(DEMO_IDENTITIES.owner, 'staff.member.list', { query: ownerId.slice(-8) })).items.length, 0);
  assert(data(await ctx.call(DEMO_IDENTITIES.owner, 'staff.member.list', { query: '演示' })).items.length > 0);
  const roster = data(await ctx.call(DEMO_IDENTITIES.owner, 'staff.registration.list', { activityId: 'day-trip' }));
  assert(roster.items.every((row: any) => Number.isSafeInteger(row.memberNumber)));
});

test('unassigned directory rows sort last and a trusted number backfill invalidates old cursors', async () => {
  const snapshot = showcaseSnapshot(NOW), target = Object.values(snapshot.memberships).find(value => (value as Membership).memberNumber === 1) as Membership;
  delete target.memberNumber;
  const ctx = setup(new MemoryStore(snapshot, () => NOW));
  const first = data(await ctx.call(DEMO_IDENTITIES.owner, 'staff.member.list'));
  assert.deepEqual(first.items.map((row: Membership) => row.memberNumber), [0, ...Array.from({ length: 19 }, (_, index) => index + 2)]);
  const tail = data(await ctx.call(DEMO_IDENTITIES.owner, 'staff.member.list', { cursor: first.nextCursor }));
  assert.equal(tail.items.at(-1).memberId, target.id);
  assert.equal(tail.items.at(-1).memberNumber, undefined);
  await ctx.store.transaction(async tx => {
    const current = await tx.get<Membership>('memberships', target.id);
    const number = await allocateMemberNumber(tx, 'oradv', target.id);
    await tx.set('memberships', target.id, { ...current, memberNumber: number });
  });
  failure(await ctx.call(DEMO_IDENTITIES.owner, 'staff.member.list', { cursor: first.nextCursor }), 'CONFLICT_REFRESH');
});

test('unassigned real legacy members remain unassigned and never gain zero from an ordinary read', async () => {
  const ctx = setup();
  const person = await ctx.ensure(user('legacy'));
  await ctx.store.transaction(async tx => { const row = await tx.get<Membership>('memberships', person.id); const { memberNumber: _number, ...rest } = row!; await tx.set('memberships', person.id, rest); });
  const summary = data<MemberSummary>(await ctx.call(user('legacy'), 'identity.me'));
  assert.equal(summary.memberNumber, undefined);
  assert.equal((await ctx.ensure(user('legacy'))).memberNumber, undefined);
});

test('public club editing preserves all private numbering controls and public member projections omit private numbers', async () => {
  const ctx = setup(new MemoryStore(showcaseSnapshot(NOW), () => NOW));
  const clubs = structuredClone(ctx.store.snapshot().clubs);
  const publicClub = data(await ctx.call(DEMO_IDENTITIES.owner, 'club.public'));
  assert.equal('nextNumber' in publicClub, false);
  assert.equal('primaryOwnerMemberId' in publicClub, false);
  data(await ctx.call(DEMO_IDENTITIES.owner, 'staff.club.save', { name: publicClub.name, contactName: '演示组织方', contactMethod: 'other', contactValue: '仅为演示的联系入口' }, publicClub.revision));
  for (const [id, row] of Object.entries(clubs)) if (id !== 'oradv') assert.deepEqual(ctx.store.snapshot().clubs[id], row);
  for (const action of ['recommendation.list', 'ranking.list']) {
    const result = data(await ctx.call(DEMO_IDENTITIES.member, action));
    assert(result.items.length > 0);
    assert(result.items.every((item: any) => !('memberNumber' in item)));
  }
});
