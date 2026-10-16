import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import { key, memberIdFor, userIdFor } from '../../shared/models';
import type { Membership, StaffRole, User } from '../../shared/models';
import { memberSequenceId } from '../../shared/member-number';
import type { MemberNumberSequence } from '../../shared/member-number';
import type { RpcResponse, TrustedIdentity } from '../../shared/types';

const NOW = '2026-10-16T12:00:00.000Z';
const primaryId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.owner));
const managerId = memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member));
const primaryRoleId = key('role', 'oradv', userIdFor(DEMO_IDENTITIES.owner), 'owner');
function setup() {
  const store = createDemoStore(NOW); let seq = 0;
  const service = createService(store, { now: () => NOW, id: () => `owner-guard-${++seq}` });
  const call = (action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity = DEMO_IDENTITIES.owner, expectedRevision?: number) => service.handle({ action, payload, expectedRevision, clubId: 'oradv', requestId: `request-${++seq}` }, identity);
  return { store, call, async manager() { data(await call('staff.roles.assign', { memberId: managerId, role: 'owner', enabled: true, activityIds: null, reason: '明确授权另一业务管理员' })); } };
}
function data(response: RpcResponse): any { assert(response.ok, JSON.stringify(response)); return response.data; }
function denied(response: RpcResponse) { assert(!response.ok, JSON.stringify(response)); assert.equal(response.error.code, 'STATE_CONFLICT'); }

test('another owner cannot revoke or expire the trusted primary, regardless of displayed member number', async () => {
  const ctx = setup(); await ctx.manager();
  await ctx.store.transaction(async tx => { const primary = (await tx.get<Membership>('memberships', primaryId))!; await tx.set('memberships', primaryId, { ...primary, memberNumber: 999 }); });
  for (const update of [{ enabled: false }, { expiresAt: '2027-01-01T00:00:00.000Z' }, { enabled: false, expiresAt: '2027-01-01T00:00:00.000Z' }]) {
    const before = ctx.store.snapshot();
    denied(await ctx.call('staff.roles.assign', { memberId: primaryId, role: 'owner', activityIds: null, ...update }, DEMO_IDENTITIES.member, 1));
    assert.deepEqual(ctx.store.snapshot(), before, 'rejected primary changes leave roles, membership and audits untouched');
  }
});

test('trusted primary cannot delete their identity even when another permanent owner exists or their role is damaged', async () => {
  const ctx = setup(); await ctx.manager();
  for (const enabled of [true, false]) {
    await ctx.store.transaction(async tx => { const role = (await tx.get<StaffRole>('staff_roles', primaryRoleId))!; await tx.set('staff_roles', primaryRoleId, { ...role, enabled }); });
    const before = ctx.store.snapshot(); denied(await ctx.call('identity.delete'));
    assert.deepEqual(ctx.store.snapshot(), before);
  }
});

test('another owner can delete only while a different trusted active permanent primary remains', async () => {
  const ctx = setup(); await ctx.manager();
  assert.equal(data(await ctx.call('identity.delete', {}, DEMO_IDENTITIES.member)).status, 'deletion_requested');
  assert.equal((ctx.store.snapshot().users[userIdFor(DEMO_IDENTITIES.member)] as User).status, 'deletion_requested');
  assert.equal((ctx.store.snapshot().users[userIdFor(DEMO_IDENTITIES.owner)] as User).status, 'active');
  assert.equal((ctx.store.snapshot().staff_roles[primaryRoleId] as StaffRole).enabled, true);
  assert.deepEqual(data(await ctx.call('identity.me')).roles, ['owner']);
});

test('missing or damaged primary witnesses fail closed before any administrator deletion writes', async () => {
  for (const fault of ['no-primary', 'missing-member', 'wrong-club', 'disabled-user', 'expired-role', 'temporary-role', 'disabled-role', 'scoped-role', 'wrong-role-user']) {
    const ctx = setup(); await ctx.manager();
    await ctx.store.transaction(async tx => {
      const sequence = (await tx.get<MemberNumberSequence>('clubs', memberSequenceId('oradv')))!;
      if (fault === 'no-primary') await tx.set('clubs', sequence.id, { ...sequence, primaryOwnerMemberId: null });
      if (fault === 'missing-member') await tx.set('clubs', sequence.id, { ...sequence, primaryOwnerMemberId: `member_${'f'.repeat(64)}` });
      const member = (await tx.get<Membership>('memberships', primaryId))!, user = (await tx.get<User>('users', member.userId))!, role = (await tx.get<StaffRole>('staff_roles', primaryRoleId))!;
      if (fault === 'wrong-club') await tx.set('memberships', primaryId, { ...member, clubId: 'other-club' });
      if (fault === 'disabled-user') await tx.set('users', user.id, { ...user, status: 'disabled' });
      if (fault === 'expired-role') await tx.set('staff_roles', role.id, { ...role, expiresAt: '2025-01-01T00:00:00.000Z' });
      if (fault === 'temporary-role') await tx.set('staff_roles', role.id, { ...role, expiresAt: '2027-01-01T00:00:00.000Z' });
      if (fault === 'disabled-role') await tx.set('staff_roles', role.id, { ...role, enabled: false });
      if (fault === 'scoped-role') await tx.set('staff_roles', role.id, { ...role, activityIds: ['intro-ride'] });
      if (fault === 'wrong-role-user') await tx.set('staff_roles', role.id, { ...role, userId: userIdFor(DEMO_IDENTITIES.founder) });
    });
    const before = ctx.store.snapshot(); denied(await ctx.call('identity.delete', {}, DEMO_IDENTITIES.member)); assert.deepEqual(ctx.store.snapshot(), before, fault);
  }
});

test('legacy final owner self-lockout stays blocked while ordinary member deletion stays available', async () => {
  const ctx = setup();
  await ctx.store.transaction(async tx => { const sequence = (await tx.get<MemberNumberSequence>('clubs', memberSequenceId('oradv')))!; await tx.set('clubs', sequence.id, { ...sequence, primaryOwnerMemberId: null }); });
  denied(await ctx.call('identity.delete'));
  denied(await ctx.call('staff.roles.assign', { memberId: primaryId, role: 'owner', enabled: false }, DEMO_IDENTITIES.owner, 1));
  denied(await ctx.call('staff.roles.assign', { memberId: primaryId, role: 'owner', expiresAt: '2027-01-01T00:00:00.000Z' }, DEMO_IDENTITIES.owner, 1));
  assert.equal(data(await ctx.call('identity.delete', {}, DEMO_IDENTITIES.founder)).status, 'deletion_requested');
});

test('displaying zero never grants primary protection or administrator authority', async () => {
  const ctx = setup();
  await ctx.store.transaction(async tx => { const member = (await tx.get<Membership>('memberships', managerId))!; await tx.set('memberships', managerId, { ...member, memberNumber: 0 }); });
  const response = await ctx.call('staff.roles.assign', { memberId: primaryId, role: 'owner', enabled: false }, DEMO_IDENTITIES.member, 1);
  assert(!response.ok); assert.equal(response.error.code, 'FORBIDDEN');
  assert.equal(data(await ctx.call('identity.delete', {}, DEMO_IDENTITIES.member)).status, 'deletion_requested');
});
