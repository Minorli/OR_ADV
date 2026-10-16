import { DomainError, integer, requireThat, text } from './errors';
import { CLUB_ID } from './types';
import type { MemberSummary, Role, RpcRequest, TrustedIdentity } from './types';
import type { Store, Transaction } from './store';
import { key, memberIdFor, shanghaiYear, statsIdFor, userIdFor } from './models';
import { memberIdentityFields } from './member-identity';
import { readMemberNumber } from './member-number';
import type { Actor, Activity, Audit, MemberStats, Membership, PublicRanking, ServiceOptions, StaffRole, User } from './models';

export class Context {
  readonly clubId: string;
  readonly now: string;
  readonly traceId: string;
  constructor(readonly store: Store, readonly options: ServiceOptions, readonly request: RpcRequest, readonly identity: TrustedIdentity | null, traceId?: string) {
    this.clubId = options.clubId ?? CLUB_ID;
    this.now = (options.now ?? (() => new Date().toISOString()))();
    this.traceId = traceId ?? this.id();
  }
  id() { return (this.options.id ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`))(); }
  async actor(tx: Transaction): Promise<Actor> {
    requireThat(this.identity?.appId && this.identity.openId, 'UNAUTHENTICATED', '请先建立微信身份');
    const user = await tx.get<User>('users', userIdFor(this.identity));
    requireThat(user, 'UNAUTHENTICATED', '请先阅读说明并建立身份');
    requireThat(user.status === 'active', 'FORBIDDEN', '账号当前不可使用');
    const member = await tx.get<Membership>('memberships', memberIdFor(this.clubId, user.id));
    requireThat(member?.clubId === this.clubId, 'FORBIDDEN', '没有本俱乐部访问权限');
    return { user, member };
  }
  async roles(tx: Transaction, actor: Actor): Promise<StaffRole[]> {
    const roles = await Promise.all((['owner','operator','leader','checkin'] as Role[]).map((role) => tx.get<StaffRole>('staff_roles', key('role', this.clubId, actor.user.id, role))));
    return roles.filter((role): role is StaffRole => !!role && role.clubId === this.clubId && role.userId === actor.user.id && role.enabled && (!role.expiresAt || role.expiresAt > this.now)
      && (['owner','operator'].includes(role.role) ? role.activityIds === null : Array.isArray(role.activityIds) && role.activityIds.length > 0));
  }
  async staff(tx: Transaction, allowed: Role[], activityId?: string): Promise<Actor> {
    const actor = await this.actor(tx);
    const roles = await this.roles(tx, actor);
    requireThat(roles.some((role) => allowed.includes(role.role) && (!activityId || role.activityIds === null || role.activityIds.includes(activityId))), 'FORBIDDEN', '没有此项操作或本场活动权限');
    return actor;
  }
  revision(current: { revision: number }, supplied: unknown = this.request.expectedRevision) {
    requireThat(typeof supplied === 'number' && Number.isInteger(supplied), 'INVALID_INPUT', '请提供当前版本');
    requireThat(current.revision === supplied, 'CONFLICT_REFRESH', '资料已更新，请刷新后重试');
  }
  async activity(tx: Transaction, id: unknown): Promise<Activity> {
    const activity = await tx.get<Activity>('activities', text(id, 'activityId', 100));
    requireThat(activity?.clubId === this.clubId, 'ACTIVITY_NOT_FOUND', '活动不存在或不可访问');
    return activity;
  }
  async summary(tx: Transaction, actor: Actor, year = shanghaiYear(this.now)): Promise<MemberSummary> {
    const growth = await tx.get<MemberStats>('member_stats', statsIdFor(this.clubId, actor.member.id, null));
    const annual = await tx.get<MemberStats>('member_stats', statsIdFor(this.clubId, actor.member.id, year));
    return { id: actor.member.id, clubId: this.clubId, nickname: actor.member.nickname, memberNumber: readMemberNumber(actor.member.memberNumber), hasAvatar: !!actor.member.avatarFileId, rankingOptIn: actor.member.rankingOptIn,
      rankingConsentVersion: actor.member.rankingConsentVersion, growthPoints: growth?.points ?? 0,
      annualPoints: annual?.points ?? 0, completedCount: growth?.completedCount ?? 0, revision: actor.member.revision,
      roles: (await this.roles(tx, actor)).map((role) => role.role), ...memberIdentityFields(actor.member, this.now) };
  }
  async audit(tx: Transaction, actor: Actor, targetType: string, targetId: string, summary: Record<string, unknown>, reason = '') {
    const id = this.id();
    const entry: Audit = { id, clubId: this.clubId, actorId: actor.user.id, action: this.request.action, targetType, targetId,
      requestId: this.request.requestId, traceId: this.traceId, summary, reason, createdAt: this.now };
    await tx.set('audit_logs', id, entry);
  }
}

export function publicActivity(activity: Activity) {
  return { id: activity.id, clubId: activity.clubId, title: activity.title, description: activity.description, location: activity.location,
    difficulty: activity.difficulty, state: activity.state, startAt: activity.startAt, endAt: activity.endAt,
    applicationClosesAt: activity.applicationClosesAt, capacity: activity.capacity, reservedSeats: activity.reservedSeats,
    minGrowthPoints: activity.minGrowthPoints, requiredQualifications: activity.requiredQualifications, requiresReview: activity.requiresReview,
    ruleVersion: activity.ruleVersion, revision: activity.revision, pointsRule: activity.pointsRule,
    actualCompletedAt: activity.actualCompletedAt, actualStartedAt: activity.actualStartedAt ?? null, safetyNotice: activity.safetyNotice, equipment: activity.equipment,
    fixtureOnly: activity.fixtureOnly ?? false };
}

export async function refreshRankings(ctx: Context, tx: Transaction, member: Membership, year: number) {
  const growth = await tx.get<MemberStats>('member_stats', statsIdFor(ctx.clubId, member.id, null));
  const annual = await tx.get<MemberStats>('member_stats', statsIdFor(ctx.clubId, member.id, year));
  for (const metric of ['growth','annual','completed_count']) {
    const scopeYear = metric === 'annual' ? year : null;
    const id = key('ranking', ctx.clubId, member.id, metric, scopeYear ?? 'all');
    const row: PublicRanking & { visible: boolean } = { id, clubId: ctx.clubId, memberId: member.id, memberPublicId: member.publicId,
      nickname: member.nickname, metric, year: scopeYear, score: metric === 'growth' ? growth?.points ?? 0 : metric === 'annual' ? annual?.points ?? 0 : growth?.completedCount ?? 0,
      completedCount: growth?.completedCount ?? 0, consentVersion: member.rankingConsentVersion, visible: member.rankingOptIn };
    await tx.set('public_rankings', id, row);
  }
}

export interface Cursor { value: unknown; id: string; offset?: number; score?: number; rank?: number; signature?: string }
export function parseCursor(value: unknown): Cursor | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const cursor = JSON.parse(decodeURIComponent(text(value, 'cursor', 2000))) as Cursor;
    requireThat(cursor && typeof cursor.id === 'string' && 'value' in cursor, 'INVALID_INPUT', '分页游标不正确');
    if (cursor.offset !== undefined) integer(cursor.offset, 'offset');
    return cursor;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_INPUT', '分页游标不正确');
  }
}
export const encodeCursor = (cursor: Cursor) => encodeURIComponent(JSON.stringify(cursor));
export async function collect<T extends { id: string }>(store: Store, collection: string, filters: Record<string, unknown>, orderBy: keyof T & string = 'id', direction: 'asc' | 'desc' = 'asc'): Promise<T[]> {
  const rows: T[] = [];
  let after: Cursor | undefined;
  for (let page = 0; page < 100; page++) {
    const batch = await store.query<T>(collection, filters, { orderBy, direction, limit: 100, after });
    rows.push(...batch);
    if (batch.length < 100) return rows;
    const last = batch[batch.length - 1];
    after = { value: last[orderBy], id: last.id };
  }
  throw new DomainError('TEMPORARY_FAILURE', '记录较多，需要分批处理', true);
}
export function paginated<T extends { id: string }>(rows: T[], orderBy: keyof T, limit = 20) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor({ value: last[orderBy], id: last.id }) : null };
}
