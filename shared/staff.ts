import { Context, collect } from './context';
import { integer, requireThat, text } from './errors';
import { key, yearRevisionIdFor } from './models';
import type { MemberStats, Membership, StaffRole, YearRevision } from './models';
import type { Role } from './types';
import { BETA_MAX_SNAPSHOT_MEMBERS } from './limits';

export async function assignRole(ctx: Context) {
  const p = ctx.request.payload;
  const role = text(p.role, '角色', 20) as Role;
  requireThat(['owner','operator','leader','checkin'].includes(role), 'INVALID_INPUT', '角色不正确');
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner']);
    const member = await tx.get<Membership>('memberships', text(p.memberId, 'memberId', 100));
    requireThat(member?.clubId === ctx.clubId, 'FORBIDDEN', '成员不属于本俱乐部');
    const scope = p.activityIds ?? null;
    requireThat(scope === null || (Array.isArray(scope) && scope.length <= 30 && scope.every((value) => typeof value === 'string' && value.length <= 100)), 'INVALID_INPUT', '活动授权范围不正确');
    if (['owner','operator'].includes(role)) requireThat(scope === null, 'INVALID_INPUT', '主理人与运营为俱乐部全局角色，活动限定权限请用领队或核验员');
    if (['leader','checkin'].includes(role)) requireThat(Array.isArray(scope) && scope.length > 0, 'INVALID_INPUT', '现场员工必须指定活动');
    if (Array.isArray(scope)) for (const activityId of scope) await ctx.activity(tx, activityId);
    const expiresAt = p.expiresAt === null || p.expiresAt === undefined ? null : text(p.expiresAt, '授权期限', 40);
    requireThat(!expiresAt || (Number.isFinite(Date.parse(expiresAt)) && new Date(expiresAt).toISOString() > ctx.now), 'INVALID_INPUT', '授权期限须在未来');
    requireThat(p.enabled === undefined || typeof p.enabled === 'boolean', 'INVALID_INPUT', '启用状态不正确');
    requireThat(!(role === 'owner' && actor.user.id === member.userId && (p.enabled === false || expiresAt !== null)), 'STATE_CONFLICT', '不能撤销自己的主理人权限或设置自己的授权到期');
    const id = key('role', ctx.clubId, member.userId, role);
    const prior = await tx.get<StaffRole>('staff_roles', id);
    if (prior) ctx.revision(prior);
    const assignment: StaffRole = { id, clubId: ctx.clubId, userId: member.userId, role, activityIds: scope as string[] | null,
      enabled: p.enabled !== false, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, grantedBy: actor.user.id, revision: (prior?.revision ?? 0) + 1 };
    await tx.set('staff_roles', id, assignment);
    await ctx.audit(tx, actor, 'staff_role', id, { memberId: member.id, role, activityIds: scope, enabled: assignment.enabled, expiresAt: assignment.expiresAt, revision: assignment.revision }, p.reason ? text(p.reason, '授权说明', 500) : '');
    return { memberId: member.id, ...assignment, userId: undefined };
  });
}

interface AnnualSnapshot {
  id: string; clubId: string; year: number; snapshotVersion: number;
  ruleVersion: number; status: 'frozen' | 'issued'; frozenAt: string; revision: number;
  memberAwards: { memberId: string; points: number; completedCount: number; item: string; status: string }[];
}
export async function rewardSnapshot(ctx: Context) {
  const year = integer(ctx.request.payload.year, '年份', 2000);
  const ruleVersion = integer(ctx.request.payload.ruleVersion, '奖励规则版本', 1);
  requireThat(year <= 2200, 'INVALID_INPUT', '年份不正确');
  const guardId = yearRevisionIdFor(ctx.clubId, year);
  const basisRevision = await ctx.store.transaction(async (tx) => {
    await ctx.staff(tx, ['owner','operator']);
    return (await tx.get<YearRevision>('member_stats', guardId))?.revision ?? 0;
  });
  const stats = await collect<MemberStats>(ctx.store, 'member_stats', { clubId: ctx.clubId, scope: 'year', year });
  requireThat(stats.length <= BETA_MAX_SNAPSHOT_MEMBERS, 'INVALID_INPUT', `测试版奖励快照最多${BETA_MAX_SNAPSHOT_MEMBERS}人，请按批次设计后再执行`);
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner','operator']);
    const receiptId = key('snapshot_rule', ctx.clubId, year, ruleVersion);
    const existing = await tx.get<{ snapshotId: string }>('annual_rewards', receiptId);
    if (existing) {
      const snapshot = await tx.get<AnnualSnapshot>('annual_rewards', existing.snapshotId);
      requireThat(snapshot, 'STATE_CONFLICT', '快照索引异常，请联系运营');
      return snapshot;
    }
    requireThat(((await tx.get<YearRevision>('member_stats', guardId))?.revision ?? 0) === basisRevision, 'CONFLICT_REFRESH', '年度积分正在变更，请刷新对账后重新生成快照');
    const controlId = key('snapshot_version', ctx.clubId, year);
    const control = await tx.get<{ version: number }>('annual_rewards', controlId);
    const version = (control?.version ?? 0) + 1;
    const memberAwards: AnnualSnapshot['memberAwards'] = [];
    for (const candidate of stats) {
      const current = await tx.get<MemberStats>('member_stats', candidate.id);
      if (current && current.completedCount > 0) memberAwards.push({ memberId: current.memberId, points: current.points, completedCount: current.completedCount, item: '', status: 'pending' });
    }
    memberAwards.sort((a,b) => b.points-a.points || a.memberId.localeCompare(b.memberId));
    const snapshot: AnnualSnapshot = { id: key('annual', ctx.clubId, year, version), clubId: ctx.clubId, year, snapshotVersion: version,
      ruleVersion, status: 'frozen', frozenAt: ctx.now, revision: 1, memberAwards };
    await tx.set('annual_rewards', snapshot.id, snapshot);
    await tx.set('annual_rewards', receiptId, { id: receiptId, clubId: ctx.clubId, year, ruleVersion, snapshotId: snapshot.id });
    await tx.set('annual_rewards', controlId, { id: controlId, clubId: ctx.clubId, year, version });
    await ctx.audit(tx, actor, 'annual_rewards', snapshot.id, { year, snapshotVersion: version, ruleVersion, count: memberAwards.length });
    return snapshot;
  });
}

export async function recordReward(ctx: Context) {
  const p = ctx.request.payload;
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner','operator']);
    const id = key('annual', ctx.clubId, integer(p.year, '年份', 2000), integer(p.snapshotVersion, '快照版本', 1));
    const snapshot = await tx.get<AnnualSnapshot>('annual_rewards', id);
    requireThat(snapshot?.clubId === ctx.clubId, 'STATE_CONFLICT', '快照不存在');
    ctx.revision(snapshot);
    const memberId = text(p.memberId, 'memberId', 100), item = text(p.item, '奖品', 100), status = text(p.status, '发放状态', 30);
    requireThat(['pending','issued','withheld'].includes(status), 'INVALID_INPUT', '发放状态不正确');
    requireThat(snapshot.memberAwards.some((row) => row.memberId === memberId), 'INVALID_INPUT', '成员不在此快照');
    const memberAwards = snapshot.memberAwards.map((row) => row.memberId === memberId ? { ...row, item, status } : row);
    const next: AnnualSnapshot = { ...snapshot, memberAwards, revision: snapshot.revision + 1, status: memberAwards.every((row) => row.status === 'issued') ? 'issued' : 'frozen' };
    await tx.set('annual_rewards', id, next);
    await ctx.audit(tx, actor, 'annual_rewards', id, { memberId, item, status, revision: next.revision });
    return next;
  });
}
