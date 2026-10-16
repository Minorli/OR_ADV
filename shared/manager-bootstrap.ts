import { requireThat } from './errors';
import { key, memberIdFor, userIdFor } from './models';
import type { Audit, Membership, StaffRole, User } from './models';
import { memberNumberClaimId, memberSequenceId, validateMemberSequence } from './member-number';
import type { MemberNumberClaim, MemberNumberSequence } from './member-number';
import type { Transaction } from './store';

interface ManagerGrant {
  clubId: string; appId: string; memberId: string; excludedMemberIds: string[];
  actorId: string; traceId: string; now: string;
}

/** Trusted deployment tooling only. Neither member numbers nor this helper are product authentication. */
export async function grantVerifiedManager(tx: Transaction, options: ManagerGrant) {
  const { clubId, appId, memberId, actorId, traceId, now } = options;
  requireThat(actorId.startsWith('deployment:') && actorId.length > 20 && !!traceId && Number.isFinite(Date.parse(now)), 'INVALID_INPUT', '可信部署信息不完整');
  const sequence = await tx.get<MemberNumberSequence>('clubs', memberSequenceId(clubId));
  requireThat(sequence, 'STATE_CONFLICT', '必须先核对主理人');
  validateMemberSequence(sequence, clubId);
  requireThat(sequence.primaryOwnerMemberId && sequence.primaryOwnerMemberId !== memberId && !options.excludedMemberIds.includes(memberId), 'STATE_CONFLICT', '经理账号与已核定账号不符');
  async function verified(id: string, number: number) {
    const member = await tx.get<Membership>('memberships', id);
    requireThat(member && member.id === id && member.clubId === clubId && member.id === memberIdFor(clubId, member.userId) && member.memberNumber === number && !(member as Membership & { fixtureOnly?: boolean }).fixtureOnly, 'STATE_CONFLICT', '已核定成员不存在');
    const user = await tx.get<User>('users', member.userId);
    requireThat(user && user.id === member.userId && user.clubId === clubId && user.appId === appId && user.status === 'active' && typeof user.wxOpenId === 'string' && user.wxOpenId.length > 0 && user.id === userIdFor({ appId, openId: user.wxOpenId }), 'STATE_CONFLICT', '账号身份不可核实');
    const claim = await tx.get<MemberNumberClaim>('clubs', memberNumberClaimId(clubId, number));
    requireThat(claim?.id === memberNumberClaimId(clubId, number) && claim.clubId === clubId && claim.memberId === id && claim.memberNumber === number && claim.kind === 'member_number_claim', 'STATE_CONFLICT', '成员编号占用不一致');
    return member;
  }
  const primary = await verified(sequence.primaryOwnerMemberId, 0);
  const primaryRole = await tx.get<StaffRole>('staff_roles', key('role', clubId, primary.userId, 'owner'));
  requireThat(primaryRole?.clubId === clubId && primaryRole.userId === primary.userId && primaryRole.role === 'owner' && primaryRole.enabled && primaryRole.activityIds === null && primaryRole.expiresAt === null, 'STATE_CONFLICT', '主理人长期权限不可核实');
  const member = await verified(memberId, 1);
  const id = key('role', clubId, member.userId, 'owner'), markerId = key('manager-grant', clubId);
  const prior = await tx.get<StaffRole & { designation?: string }>('staff_roles', id);
  const marker = await tx.get<{ memberId: string; roleId: string; status: string }>('schema_migrations', markerId);
  if (marker) {
    requireThat(marker.status === 'closed' && marker.memberId === memberId && marker.roleId === id && prior?.enabled && prior.role === 'owner' && prior.activityIds === null && prior.expiresAt === null && prior.designation === 'manager', 'STATE_CONFLICT', '既有经理授权已变更，禁止自动覆盖');
    return { applied: false, memberNumber: 1, role: 'owner' as const, designation: 'manager' as const };
  }
  requireThat(!prior, 'STATE_CONFLICT', '已有权限须通过管理页面核对，不可覆盖');
  const role: StaffRole & { designation: 'manager' } = { id, clubId, userId: member.userId, role: 'owner', designation: 'manager', activityIds: null, enabled: true, expiresAt: null, grantedBy: actorId, revision: 1 };
  await tx.set('staff_roles', id, role);
  const auditId = key('manager-grant-audit', clubId);
  await tx.set<Audit>('audit_logs', auditId, { id: auditId, clubId, actorId, action: 'deployment.manager.grant', targetType: 'staff_role', targetId: id, requestId: traceId, traceId, summary: { memberId, memberNumber: 1, role: 'owner', designation: 'manager', primaryPreserved: true }, reason: '用户明确授权已核定1号车队经理拥有完整业务管理权限', createdAt: now });
  await tx.set('schema_migrations', markerId, { id: markerId, clubId, status: 'closed', memberId, roleId: id, actorId, createdAt: now });
  return { applied: true, memberNumber: 1, role: 'owner' as const, designation: 'manager' as const };
}
