import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../shared/memory-store';
import { createService } from '../../shared/service';
import { memberIdFor, userIdFor } from '../../shared/models';
import type { Membership, User } from '../../shared/models';
import { allocateMemberNumber, memberNumberClaimId, memberSequenceId } from '../../shared/member-number';
import { migrateMemberNumbers, memberNumberMigrationId, type MemberNumberMigrationOptions } from '../../shared/member-number-migration';

const NOW = '2026-10-16T13:30:00.000Z', APP = 'wx0123456789abcdef', CLUB = 'oradv';
async function fixture() {
  const store = new MemoryStore({}, () => NOW), service = createService(store, { now: () => NOW });
  const identities = ['developer', 'other', 'employee'].map(name => ({ appId: APP, openId: `fictional-renumber-${name}` }));
  const members: Membership[] = [];
  for (const [index, identity] of identities.entries()) {
    const response = await service.handle({ action: 'identity.ensure', clubId: CLUB, requestId: `fixture-${index}`, payload: { consentVersions: { privacy: 1, terms: 1 } } }, identity);
    assert(response.ok); members.push(store.snapshot().memberships[(response.data as any).id] as Membership);
  }
  const options: MemberNumberMigrationOptions = { appId: APP, clubId: CLUB, developerMemberId: members[0].id, employeeMemberId: members[2].id,
    expectedDeveloperNumber: 1, expectedEmployeeNumber: 3, expectedDeveloperRevision: members[0].revision, expectedEmployeeRevision: members[2].revision,
    actorId: 'deployment:offline-fixture', traceId: 'offline-member-renumber', now: NOW };
  return { store, service, members, identities, options, migrate: () => store.transaction(tx => migrateMemberNumbers(tx, options)) };
}

test('trusted renumber changes only the two display numbers, claim ownership and reservation with an atomic audit marker', async () => {
  const ctx = await fixture(), before = ctx.store.snapshot(), result = await ctx.migrate(), after = ctx.store.snapshot();
  assert.deepEqual(result, { applied: true, developerMemberNumber: 1024, employeeMemberNumber: 1 });
  for (const [index, number] of [[0, 1024], [2, 1]]) {
    const prior = ctx.members[index], member = after.memberships[prior.id] as Membership;
    assert.equal(member.memberNumber, number); assert.equal(member.revision, prior.revision + 1);
    assert.deepEqual({ ...member, memberNumber: prior.memberNumber, revision: prior.revision, updatedAt: prior.updatedAt }, prior);
  }
  assert.deepEqual(after.memberships[ctx.members[1].id], before.memberships[ctx.members[1].id]);
  assert.equal((after.clubs[memberNumberClaimId(CLUB, 1)] as any).memberId, ctx.members[2].id);
  assert.equal((after.clubs[memberNumberClaimId(CLUB, 1024)] as any).memberId, ctx.members[0].id);
  assert.deepEqual(after.clubs[memberNumberClaimId(CLUB, 3)], before.clubs[memberNumberClaimId(CLUB, 3)], 'retired employee claim remains reserved');
  assert.equal(after.clubs[memberNumberClaimId(CLUB, 0)], undefined);
  const counter = after.clubs[memberSequenceId(CLUB)] as any;
  assert.equal(counter.nextNumber, 4); assert.equal(counter.primaryOwnerMemberId, null); assert.deepEqual(counter.reservedNumbers, [1024]);
  for (const collection of Object.keys(before).filter(name => !['memberships', 'clubs', 'audit_logs'].includes(name))) assert.deepEqual(after[collection], before[collection]);
  assert.equal(Object.keys(after.audit_logs).length, Object.keys(before.audit_logs).length + 1);
  assert.equal((after.schema_migrations[memberNumberMigrationId(CLUB)] as any).status, 'closed');
  const next = await ctx.store.transaction(tx => allocateMemberNumber(tx, CLUB, memberIdFor(CLUB, userIdFor({ appId: APP, openId: 'next' }))));
  assert.equal(next, 4, 'high manual number never jumps the ordinary counter');
});

test('repeated and concurrent trusted migration requests are idempotent without additional revisions or audit entries', async () => {
  const ctx = await fixture(), results = await Promise.all(Array.from({ length: 6 }, () => ctx.migrate()));
  assert.equal(results.filter(result => result.applied).length, 1);
  const applied = ctx.store.snapshot(); assert.equal((await ctx.migrate()).applied, false); assert.deepEqual(ctx.store.snapshot(), applied);
  const wrong = { ...ctx.options, developerMemberId: ctx.members[1].id };
  await assert.rejects(ctx.store.transaction(tx => migrateMemberNumbers(tx, wrong))); assert.deepEqual(ctx.store.snapshot(), applied);
});

test('every membership, claim, audit and marker write rolls back together when a migration write fails', async () => {
  for (const failing of ['memberships', 'clubs', 'audit_logs', 'schema_migrations']) {
    const ctx = await fixture(), before = ctx.store.snapshot();
    await assert.rejects(ctx.store.transaction(tx => migrateMemberNumbers({ ...tx, set: async (collection, id, value) => {
      if (collection === failing) throw new Error('injected migration failure'); return tx.set(collection, id, value);
    } }, ctx.options)));
    assert.deepEqual(ctx.store.snapshot(), before);
  }
});

test('zero, duplicate identities, stale revisions, unrelated claims and high-number collisions are rejected before any change', async () => {
  for (const fault of ['zero', 'same-member', 'revision', 'claim-one', 'claim-three', 'claim-high', 'wrong-app', 'wrong-user-binding', 'wrong-member-binding']) {
    const ctx = await fixture(); let options = { ...ctx.options };
    if (fault === 'zero') options.expectedDeveloperNumber = 0;
    if (fault === 'same-member') options.employeeMemberId = options.developerMemberId;
    if (fault === 'revision') options.expectedEmployeeRevision++;
    if (fault === 'wrong-app') options.appId = 'wx1111111111111111';
    await ctx.store.transaction(async tx => {
      if (fault.startsWith('claim-')) {
        const number = fault === 'claim-one' ? 1 : fault === 'claim-three' ? 3 : 1024;
        const id = memberNumberClaimId(CLUB, number);
        await tx.set('clubs', id, { id, clubId: CLUB, kind: 'member_number_claim', memberNumber: number, memberId: ctx.members[1].id });
      }
      if (fault === 'wrong-user-binding') {
        const current = await tx.get<User>('users', ctx.members[0].userId); await tx.set('users', current!.id, { ...current, wxOpenId: 'another-wx-user' });
      }
      if (fault === 'wrong-member-binding') await tx.set('memberships', ctx.members[0].id, { ...ctx.members[0], userId: ctx.members[1].userId });
    });
    const before = ctx.store.snapshot(); await assert.rejects(ctx.store.transaction(tx => migrateMemberNumbers(tx, options))); assert.deepEqual(ctx.store.snapshot(), before);
  }
});

test('allocator skips an explicitly reserved valid 1024 claim but still rejects ordinary occupied counters', async () => {
  const ctx = await fixture(); await ctx.migrate();
  await ctx.store.transaction(async tx => { const current = await tx.get<any>('clubs', memberSequenceId(CLUB)); await tx.set('clubs', current.id, { ...current, nextNumber: 1024 }); });
  const nextId = memberIdFor(CLUB, userIdFor({ appId: APP, openId: 'after-reservation' }));
  assert.equal(await ctx.store.transaction(tx => allocateMemberNumber(tx, CLUB, nextId)), 1025);
  assert.equal((ctx.store.snapshot().clubs[memberSequenceId(CLUB)] as any).nextNumber, 1026);
  await ctx.store.transaction(async tx => { const current = await tx.get<any>('clubs', memberSequenceId(CLUB)); await tx.set('clubs', current.id, { ...current, nextNumber: 1 }); });
  const before = ctx.store.snapshot(); await assert.rejects(ctx.store.transaction(tx => allocateMemberNumber(tx, CLUB, nextId)));
  assert.deepEqual(ctx.store.snapshot(), before);
});

test('malformed, unclaimed and mismatched reserved slots fail closed without consuming a number', async () => {
  for (const fault of ['zero', 'duplicate', 'missing', 'wrong-number']) {
    const ctx = await fixture();
    await ctx.store.transaction(async tx => {
      const current = await tx.get<any>('clubs', memberSequenceId(CLUB));
      await tx.set('clubs', current.id, { ...current, nextNumber: 1024, reservedNumbers: fault === 'zero' ? [0] : fault === 'duplicate' ? [1024, 1024] : [1024] });
      if (fault === 'wrong-number') {
        const id = memberNumberClaimId(CLUB, 1024); await tx.set('clubs', id, { id: memberNumberClaimId(CLUB, 1023), clubId: CLUB, kind: 'member_number_claim', memberNumber: 1023, memberId: ctx.members[0].id });
      }
    });
    const before = ctx.store.snapshot(); await assert.rejects(ctx.store.transaction(tx => allocateMemberNumber(tx, CLUB, ctx.members[0].id)));
    assert.deepEqual(ctx.store.snapshot(), before);
  }
});
