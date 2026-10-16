import { Context, encodeCursor, parseCursor } from './context';
import { integer, requireThat, text } from './errors';
import { key, statsIdFor } from './models';
import type { Membership, RecommendationProjection, StaffRole, User, MemberStats } from './models';
import { effectiveMemberKind, memberIdentityFields, recommendationSortKey } from './member-identity';
import { sha256 } from './hash';
import type { Transaction } from './store';
import type { RecommendationEntry, Role, StaffMemberSummary, StaffRoleSummary } from './types';
import { readMemberNumber } from './member-number';

async function clubRows<T extends { id: string }>(ctx: Context, collection: string, filters: Record<string, unknown>): Promise<T[]> {
  const rows: T[] = [];
  let after: { value: string; id: string } | undefined;
  for (let page = 0; page < 3; page++) {
    const batch = await ctx.store.query<T>(collection, filters, { orderBy: 'id', limit: 100, after });
    rows.push(...batch);
    requireThat(rows.length <= 200, 'STATE_CONFLICT', '当前内测成员数量超过200人，请联系主理人处理');
    if (batch.length < 100) return rows;
    const last = batch[batch.length - 1];
    after = { value: last.id, id: last.id };
  }
  return rows;
}

export async function roleSummaries(ctx: Context, tx: Transaction, member: Membership): Promise<StaffRoleSummary[]> {
  const rows = await Promise.all((['owner','operator','leader','checkin'] as Role[]).map((role) => tx.get<StaffRole>('staff_roles', key('role', ctx.clubId, member.userId, role))));
  return rows.filter((row): row is StaffRole => !!row && row.clubId === ctx.clubId && row.userId === member.userId)
    .map((row) => ({ role: row.role, revision: row.revision ?? 0, activityIds: row.activityIds, enabled: row.enabled, expiresAt: row.expiresAt }));
}
async function staffMember(ctx: Context, tx: Transaction, member: Membership): Promise<StaffMemberSummary> {
  const user = await tx.get<User>('users', member.userId);
  return { id: member.id, memberId: member.id, nickname: member.nickname, memberNumber: readMemberNumber(member.memberNumber), ...memberIdentityFields(member, ctx.now),
    recommendationPriority: member.recommendationPriority ?? 0, revision: member.revision,
    status: user?.status ?? 'unavailable', staffRoles: await roleSummaries(ctx, tx, member) };
}
export async function syncRecommendation(ctx: Context, tx: Transaction, member: Membership) {
  const id = key('recommendation', ctx.clubId, member.id);
  const projection: RecommendationProjection = { id, clubId: ctx.clubId, memberId: member.id,
    sortKey: recommendationSortKey(member, ctx.now), visible: member.recommendationOptIn === true,
    consentVersion: member.recommendationConsentVersion ?? 0 };
  await tx.set('public_recommendations', id, projection);
}
export async function listMembers(ctx: Context) {
  await ctx.store.transaction((tx) => ctx.staff(tx, ['owner','operator']));
  const query = ctx.request.payload.query === undefined || ctx.request.payload.query === '' ? '' : text(ctx.request.payload.query, '查找内容', 60).toLocaleLowerCase();
  const cursor = parseCursor(ctx.request.payload.cursor);
  const seen = new Set<number>();
  const all = await clubRows<Membership>(ctx, 'memberships', { clubId: ctx.clubId });
  for (const member of all) {
    const number = readMemberNumber(member.memberNumber);
    if (number === undefined) continue;
    requireThat(!seen.has(number), 'STATE_CONFLICT', '成员编号重复，请联系主理人核对');
    seen.add(number);
  }
  const numericQuery = query !== '' && /^\d+$/.test(query);
  const numberQuery = numericQuery ? Number(query) : undefined;
  const rows = all.filter(member => !query || (numericQuery ? member.memberNumber === numberQuery : member.nickname.toLocaleLowerCase().includes(query)))
    .sort((a, b) => {
      if (a.memberNumber !== b.memberNumber) {
        if (a.memberNumber === undefined) return 1;
        if (b.memberNumber === undefined) return -1;
        return a.memberNumber - b.memberNumber;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const signature = sha256(JSON.stringify([query, rows.map(member => [member.id, member.memberNumber ?? null])]));
  requireThat(!cursor || cursor.signature === signature, 'CONFLICT_REFRESH', '成员编号或查找结果已更新，请刷新列表');
  const previous = cursor ? rows.findIndex(member => member.id === cursor.id && (member.memberNumber ?? null) === cursor.value) : -1;
  requireThat(!cursor || previous >= 0, 'INVALID_INPUT', '成员分页位置不正确');
  const selected = rows.slice(previous + 1, previous + 21), last = selected[selected.length - 1];
  const page = { items: selected, nextCursor: last && rows.length > previous + 21 ? encodeCursor({ value: last.memberNumber ?? null, id: last.id, signature }) : null };
  const items: StaffMemberSummary[] = [];
  // Role summaries need four reads per member. Ten per transaction stays
  // safely below CloudBase's 100-operation limit for a 20-member page.
  for (let start = 0; start < page.items.length; start += 10) {
    items.push(...await ctx.store.transaction(async (tx) => {
      await ctx.staff(tx, ['owner','operator']);
      const batch: StaffMemberSummary[] = [];
      for (const candidate of page.items.slice(start, start + 10)) {
        const member = await tx.get<Membership>('memberships', candidate.id);
        if (member?.clubId === ctx.clubId) batch.push(await staffMember(ctx, tx, member));
      }
      return batch;
    }));
  }
  return { items, nextCursor: page.nextCursor };
}
export async function listMemberRoles(ctx: Context) {
  return ctx.store.transaction(async (tx) => {
    await ctx.staff(tx, ['owner']);
    const member = await tx.get<Membership>('memberships', text(ctx.request.payload.memberId, 'memberId', 100));
    requireThat(member?.clubId === ctx.clubId, 'FORBIDDEN', '成员不可访问');
    return { items: await roleSummaries(ctx, tx, member) };
  });
}
export async function assignMemberKind(ctx: Context, priorityOnly = false) {
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner']);
    const p = ctx.request.payload;
    const member = await tx.get<Membership>('memberships', text(p.memberId, 'memberId', 100));
    requireThat(member?.clubId === ctx.clubId, 'FORBIDDEN', '成员不可访问');
    const user = await tx.get<User>('users', member.userId);
    requireThat(user?.status === 'active', 'FORBIDDEN', '该成员账号不可使用');
    ctx.revision(member);
    const reason = text(p.reason, '操作依据', 500);
    let next: Membership;
    if (priorityOnly) {
      const priority = integer(p.priority, '推荐编排', 0);
      requireThat(priority <= 999, 'INVALID_INPUT', '推荐编排须在0至999之间');
      next = { ...member, recommendationPriority: priority, revision: member.revision + 1, updatedAt: ctx.now };
    } else {
      requireThat(p.memberKind === 'founder' || p.memberKind === 'regular', 'INVALID_INPUT', '成员身份不正确');
      let expiresAt: string | null = null;
      if (p.expiresAt !== undefined && p.expiresAt !== null) {
        const value = text(p.expiresAt, '生效期限', 40);
        requireThat(Number.isFinite(Date.parse(value)) && /Z$|[+-]\d\d:\d\d$/.test(value), 'INVALID_INPUT', '生效期限须包含时区');
        expiresAt = new Date(value).toISOString();
        requireThat(expiresAt > ctx.now, 'INVALID_INPUT', '生效期限须在未来');
      }
      next = { ...member, memberKind: p.memberKind, memberKindVersion: (member.memberKindVersion ?? 0) + 1,
        memberKindExpiresAt: p.memberKind === 'founder' ? expiresAt : null, kindRequestStatus: 'resolved', revision: member.revision + 1, updatedAt: ctx.now };
    }
    await tx.set('memberships', next.id, next);
    await syncRecommendation(ctx, tx, next);
    await ctx.audit(tx, actor, 'membership', next.id, priorityOnly
      ? { priority: next.recommendationPriority, revision: next.revision }
      : { from: effectiveMemberKind(member, ctx.now), to: effectiveMemberKind(next, ctx.now), memberKindVersion: next.memberKindVersion, expiresAt: next.memberKindExpiresAt }, reason);
    return staffMember(ctx, tx, next);
  });
}
export async function requestMemberKind(ctx: Context) {
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.actor(tx);
    if (effectiveMemberKind(actor.member, ctx.now) === 'founder') return { status: 'resolved', requestedAt: actor.member.kindRequestedAt ?? ctx.now };
    if (actor.member.kindRequestStatus === 'pending') return { status: 'pending', requestedAt: actor.member.kindRequestedAt };
    const reason = ctx.request.payload.reason === undefined ? '申请核对创始成员身份' : text(ctx.request.payload.reason, '核对说明', 300);
    const member: Membership = { ...actor.member, kindRequestStatus: 'pending', kindRequestedAt: ctx.now,
      kindRequestReason: reason, revision: actor.member.revision + 1, updatedAt: ctx.now };
    await tx.set('memberships', member.id, member);
    await ctx.audit(tx, actor, 'membership', member.id, { kindRequestStatus: 'pending' });
    return { status: 'pending', requestedAt: ctx.now };
  });
}

export async function listRecommendations(ctx: Context) {
  const cursor = parseCursor(ctx.request.payload.cursor);
  // At this club's <=200-member scale, revalidate live consent, identity expiry
  // and score in bounded transactions, then sort on authoritative facts. Stored
  // sort keys alone cannot handle identity expiry between requests.
  const projections = await clubRows<RecommendationProjection>(ctx, 'public_recommendations', { clubId: ctx.clubId, visible: true });
  type OrderedRecommendation = RecommendationEntry & { id: string; sortKey: string; revision: number; priority: number };
  const live: OrderedRecommendation[] = [];
  for (let start = 0; start < projections.length; start += 20) {
    live.push(...await ctx.store.transaction(async (tx) => {
      const batch: OrderedRecommendation[] = [];
      for (const row of projections.slice(start, start + 20)) {
        const member = await tx.get<Membership>('memberships', row.memberId);
        if (member?.clubId !== ctx.clubId || member.recommendationOptIn !== true || member.recommendationConsentVersion !== row.consentVersion) continue;
        const user = await tx.get<User>('users', member.userId);
        if (user?.status !== 'active') continue;
        const stats = member.rankingOptIn ? await tx.get<MemberStats>('member_stats', statsIdFor(ctx.clubId, member.id, null)) : null;
        batch.push({ id: row.id, sortKey: recommendationSortKey(member, ctx.now), revision: member.revision,
          memberPublicId: member.publicId, nickname: member.nickname, memberKind: effectiveMemberKind(member, ctx.now),
          priority: member.recommendationPriority ?? 0, displayOrder: 0,
          ...(member.rankingOptIn ? { growthPoints: stats?.points ?? 0, completedCount: stats?.completedCount ?? 0 } : {}) });
      }
      return batch;
    }));
  }
  live.sort((a,b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Bind the continuation's ordering token as well as displayed values: a
  // priority edit can change the token without moving the member's position.
  const signature = sha256(JSON.stringify(live.map((row) => [sha256(row.sortKey),row.memberPublicId,row.nickname,row.memberKind,row.growthPoints,row.completedCount])));
  requireThat(!cursor || cursor.signature === signature, 'CONFLICT_REFRESH', '成员展示已更新，请刷新列表');
  const remaining = live.map((row, index) => ({ ...row, displayOrder: index + 1 }))
    .filter((row) => !cursor || row.sortKey > String(cursor.value) || (row.sortKey === cursor.value && row.id > cursor.id));
  const selected = remaining.slice(0, 20);
  const last = selected[selected.length - 1];
  return { items: selected.map(({ id: _id, sortKey: _sort, revision: _revision, priority: _priority, ...row }) => row),
    nextCursor: remaining.length > 20 && last ? encodeCursor({ value: last.sortKey, id: last.id, signature }) : null };
}
