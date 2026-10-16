import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { grantVerifiedManager } from '../../shared/manager-bootstrap';
import { key, memberIdFor, userIdFor } from '../../shared/models';
import type { Membership, StaffRole, User } from '../../shared/models';
import { memberNumberClaimId, memberSequenceId } from '../../shared/member-number';

const now = '2026-10-16T12:00:00.000Z';
const managerId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
const primaryId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.owner));
const options = { clubId: 'oradv', appId: DEMO_IDENTITIES.member.appId, memberId: managerId, excludedMemberIds: [primaryId], actorId: `deployment:${'a'.repeat(64)}`, traceId: 'manager-verified', now };

async function setup() {
  const store = createDemoStore(now);
  await store.transaction(async tx => {
    const member = (await tx.get<Membership>('memberships', managerId))!;
    await tx.set('memberships', member.id, { ...member, memberNumber: 1 });
    await tx.set('clubs', memberNumberClaimId('oradv', 1), { id: memberNumberClaimId('oradv', 1), clubId: 'oradv', kind: 'member_number_claim', memberNumber: 1, memberId: managerId });
  });
  return store;
}

test('trusted grant preserves primary, numbers and points; identical repeat performs no writes', async () => {
  const store = await setup(), before = store.snapshot();
  assert.deepEqual(await store.transaction(tx => grantVerifiedManager(tx, options)), { applied: true, memberNumber: 1, role: 'owner', designation: 'manager' });
  const after = store.snapshot();
  assert.deepEqual(after.clubs, before.clubs); assert.deepEqual(after.memberships, before.memberships); assert.deepEqual(after.member_stats, before.member_stats); assert.deepEqual(after.points_ledger, before.points_ledger);
  assert.deepEqual(after.staff_roles[key('role', 'oradv', userIdFor(DEMO_IDENTITIES.owner), 'owner')], before.staff_roles[key('role', 'oradv', userIdFor(DEMO_IDENTITIES.owner), 'owner')]);
  assert.equal((after.staff_roles[key('role', 'oradv', userIdFor(DEMO_IDENTITIES.member), 'owner')] as StaffRole).enabled, true);
  assert.equal((await store.transaction(tx => grantVerifiedManager(tx, options))).applied, false); assert.deepEqual(store.snapshot(), after);
});

test('grant rejects wrong account, inactive identity, damaged claims or primary without partial writes', async () => {
  for (const fault of ['excluded', 'wrong-app', 'inactive', 'wrong-number', 'claim', 'primary-role', 'primary-sequence']) {
    const store = await setup();
    await store.transaction(async tx => {
      const member = (await tx.get<Membership>('memberships', managerId))!, user = (await tx.get<User>('users', member.userId))!;
      if (fault === 'inactive') await tx.set('users', user.id, { ...user, status: 'disabled' });
      if (fault === 'wrong-number') await tx.set('memberships', member.id, { ...member, memberNumber: 1024 });
      if (fault === 'claim') await tx.set('clubs', memberNumberClaimId('oradv', 1), { memberId: primaryId, clubId: 'oradv', memberNumber: 1, kind: 'member_number_claim' });
      if (fault === 'primary-role') { const id = key('role', 'oradv', userIdFor(DEMO_IDENTITIES.owner), 'owner'); const role = (await tx.get<StaffRole>('staff_roles', id))!; await tx.set('staff_roles', id, { ...role, enabled: false }); }
      if (fault === 'primary-sequence') { const id = memberSequenceId('oradv'); const sequence = (await tx.get<any>('clubs', id))!; await tx.set('clubs', id, { ...sequence, primaryOwnerMemberId: null }); }
    });
    const before = store.snapshot();
    await assert.rejects(store.transaction(tx => grantVerifiedManager(tx, { ...options, ...(fault === 'excluded' ? { excludedMemberIds: [managerId] } : {}), ...(fault === 'wrong-app' ? { appId: 'wrong-app' } : {}) })));
    assert.deepEqual(store.snapshot(), before, fault);
  }
});

test('existing role or closed-marker changes require manual review rather than overriding a later decision', async () => {
  const store = await setup(); await store.transaction(tx => grantVerifiedManager(tx, options));
  await store.transaction(async tx => { const id = key('role', 'oradv', userIdFor(DEMO_IDENTITIES.member), 'owner'); const role = (await tx.get<StaffRole>('staff_roles', id))!; await tx.set('staff_roles', id, { ...role, enabled: false }); });
  const before = store.snapshot(); await assert.rejects(store.transaction(tx => grantVerifiedManager(tx, options))); assert.deepEqual(store.snapshot(), before);
});
