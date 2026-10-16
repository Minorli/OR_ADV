import { requireThat } from './errors';
import { key, memberIdFor, userIdFor } from './models';
import type { Audit, Membership, StaffRole, User } from './models';
import type { Transaction } from './store';
import { reserveOwnerNumber } from './member-number';

interface BootstrapOptions { clubId: string; appId: string; memberId: string; actorId: string; traceId: string; envId: string; now: string }
/** Trusted deployment tooling only, never exposed as a product RPC. */
export async function bootstrapOwner(tx: Transaction, options: BootstrapOptions): Promise<void> {
  const { clubId, appId, memberId, actorId, traceId, envId, now } = options;
  const markerId = key('owner-bootstrap', clubId);
  requireThat(!await tx.get('schema_migrations', markerId), 'STATE_CONFLICT', 'Owner bootstrap has already been closed');
  const member = await tx.get<Membership>('memberships', memberId);
  requireThat(member && member.clubId === clubId && member.id === memberId && member.id === memberIdFor(clubId, member.userId)
    && Number.isSafeInteger(member.revision) && member.revision >= 1, 'STATE_CONFLICT', 'Existing club member not found');
  const user = await tx.get<User>('users', member.userId);
  requireThat(user && user.id === member.userId && user.status === 'active' && user.clubId === clubId && user.appId === appId
    && typeof user.wxOpenId === 'string' && user.wxOpenId.length > 0 && user.id === userIdFor({ appId, openId: user.wxOpenId }),
  'STATE_CONFLICT', 'Member does not belong to a trusted active user in this AppID');
  const roleId = key('role', clubId, member.userId, 'owner');
  requireThat(!await tx.get('staff_roles', roleId), 'STATE_CONFLICT', 'Existing owner role must not be overwritten');
  await reserveOwnerNumber(tx, clubId, memberId, member.memberNumber);
  const role: StaffRole = { id: roleId, clubId, userId: member.userId, role: 'owner', activityIds: null, enabled: true, expiresAt: null, grantedBy: actorId, revision: 1 };
  await tx.set('staff_roles', roleId, { ...role, createdAt: now, updatedAt: now, schemaVersion: 1 });
  await tx.set<Membership>('memberships', member.id, { ...member, memberNumber: 0, revision: member.revision + 1, updatedAt: now });
  const auditId = key('owner-bootstrap-audit', clubId);
  await tx.set<Audit>('audit_logs', auditId, { id: auditId, clubId, actorId, action: 'deployment.owner.bootstrap', targetType: 'membership', targetId: memberId,
    requestId: traceId, traceId, summary: { role: 'owner', memberNumber: 0, previousMemberNumber: member.memberNumber ?? null, environment: envId,
      credentialFingerprint: actorId.startsWith('deployment:') ? actorId.slice('deployment:'.length) : 'authorized-deployment' },
    reason: 'Initial owner authorized by deployment identity; previous positive number remains retired', createdAt: now });
  await tx.set('schema_migrations', markerId, { id: markerId, clubId, version: 1, status: 'closed', memberId, actorId, memberNumber: 0, createdAt: now, updatedAt: now, schemaVersion: 1 });
}
