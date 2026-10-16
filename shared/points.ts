import { Context, collect, encodeCursor, paginated, parseCursor, refreshRankings } from './context';
import { DomainError, integer, requireThat, text } from './errors';
import { completionIdFor, key, shanghaiYear, statsIdFor, yearRevisionIdFor } from './models';
import type { LedgerEntry, MemberStats, Membership, PublicRanking, Registration, SettlementJob, User, YearRevision } from './models';
import type { Transaction } from './store';
import { BETA_MAX_CAPACITY } from './limits';
import { awardActivityWallet, reverseActivityWallet } from './points-wallet';

async function applyStats(ctx: Context, tx: Transaction, entry: LedgerEntry) {
  for (const scope of ['growth','year'] as const) {
    const year = scope === 'growth' ? null : entry.year;
    const id = statsIdFor(ctx.clubId, entry.memberId, year);
    const prior = await tx.get<MemberStats>('member_stats', id);
    const points = (prior?.points ?? 0) + (scope === 'growth' ? entry.growthDelta : entry.annualDelta);
    const completedCount = (prior?.completedCount ?? 0) + entry.completedCountDelta;
    requireThat(Number.isSafeInteger(points) && points >= 0 && Number.isSafeInteger(completedCount) && completedCount >= 0, 'STATE_CONFLICT', '积分汇总异常，需先对账');
    await tx.set<MemberStats>('member_stats', id, { id, clubId: ctx.clubId, memberId: entry.memberId, scope, year, points, completedCount, revision: (prior?.revision ?? 0) + 1 });
  }
  const guardId = yearRevisionIdFor(ctx.clubId, entry.year);
  const guard = await tx.get<YearRevision>('member_stats', guardId);
  await tx.set<YearRevision>('member_stats', guardId, { id: guardId, clubId: ctx.clubId, kind: 'year_guard', year: entry.year, revision: (guard?.revision ?? 0) + 1 });
  const member = await tx.get<Membership>('memberships', entry.memberId);
  if (member) await refreshRankings(ctx, tx, member, entry.year);
}
async function settlementActivity(ctx: Context, tx: Transaction) {
  const activityId = text(ctx.request.payload.activityId, 'activityId', 100);
  const actor = await ctx.staff(tx, ['owner','operator'], activityId);
  const activity = await ctx.activity(tx, activityId);
  requireThat(['ended','settled'].includes(activity.state), 'STATE_CONFLICT', '活动结束后才能结算');
  requireThat(ctx.request.payload.ruleVersion === activity.ruleVersion, 'RULE_VERSION_CHANGED', '结算规则版本不一致');
  requireThat(activity.actualCompletedAt, 'STATE_CONFLICT', '缺少实际完成时间');
  requireThat(activity.capacity <= BETA_MAX_CAPACITY, 'INVALID_INPUT', `测试版结算仅支持${BETA_MAX_CAPACITY}人以内的活动`);
  return { actor, activity };
}
export async function previewSettlement(ctx: Context) {
  const { activity } = await ctx.store.transaction((tx) => settlementActivity(ctx, tx));
  const rows = await collect<Registration>(ctx.store, 'registrations', { clubId: ctx.clubId, activityId: activity.id });
  return { activityId: activity.id, ruleVersion: activity.ruleVersion, pointsRule: activity.pointsRule,
    items: rows, eligibleCount: rows.filter((row) => row.state === 'pending_settlement').length,
    unresolvedCount: rows.filter((row) => ['pending_review','pending_confirmation','confirmed','checked_in'].includes(row.state)).length };
}

async function settleMember(ctx: Context, registrationId: string) {
  return ctx.store.transaction(async (tx) => {
    const { actor, activity } = await settlementActivity(ctx, tx);
    const registration = await tx.get<Registration>('registrations', registrationId);
    requireThat(registration?.clubId === ctx.clubId && registration.activityId === activity.id, 'STATE_CONFLICT', '结算对象不存在');
    const id = completionIdFor(activity, registration);
    if (await tx.get<LedgerEntry>('points_ledger', id)) return;
    requireThat(activity.state === 'ended' && registration.state === 'pending_settlement', 'STATE_CONFLICT', '该成员未完成出发和结束核验');
    const entry: LedgerEntry = { id, clubId: ctx.clubId, memberId: registration.memberId, activityId: activity.id, awardType: 'completion', businessKey: id,
      growthDelta: activity.pointsRule.growth, annualDelta: activity.pointsRule.annual, completedCountDelta: 1,
      year: shanghaiYear(activity.actualCompletedAt!), effectiveAt: activity.actualCompletedAt!, ruleVersion: activity.ruleVersion,
      relatedEntryId: null, actorId: actor.user.id, reason: '活动完整核验后结算' };
    await tx.set('points_ledger', id, entry);
    await applyStats(ctx, tx, entry);
    await awardActivityWallet(ctx, tx, activity, entry);
    await tx.set('registrations', registration.id, { ...registration, state: 'completed', settlementId: id, revision: registration.revision + 1, updatedAt: ctx.now });
    await ctx.audit(tx, actor, 'points_ledger', id, { growthDelta: entry.growthDelta, annualDelta: entry.annualDelta, year: entry.year });
  });
}
export async function runSettlement(ctx: Context) {
  const { activity } = await ctx.store.transaction((tx) => settlementActivity(ctx, tx));
  const jobId = key('settlement', ctx.clubId, activity.id, activity.ruleVersion);
  await ctx.store.transaction(async (tx) => {
    await settlementActivity(ctx, tx);
    const prior = await tx.get<SettlementJob>('settlement_jobs', jobId);
    if (!prior || prior.status !== 'completed') await tx.set<SettlementJob>('settlement_jobs', jobId, {
      id: jobId, clubId: ctx.clubId, activityId: activity.id, ruleVersion: activity.ruleVersion,
      status: 'running', successCount: prior?.successCount ?? 0, failureCount: 0, failures: [],
    });
  });
  const rows = await collect<Registration>(ctx.store, 'registrations', { clubId: ctx.clubId, activityId: activity.id });
  const failures: SettlementJob['failures'] = [];
  for (const row of rows.filter((registration) => ['pending_settlement','completed'].includes(registration.state))) {
    try { await settleMember(ctx, row.id); }
    catch (error) { failures.push({ registrationId: row.id, code: error instanceof DomainError ? error.code : 'TEMPORARY_FAILURE' }); }
  }
  // Re-read each authoritative result in a final transaction. Concurrent runs
  // cannot turn an incomplete event into settled or inflate the job counts.
  return ctx.store.transaction(async (tx) => {
    const { actor, activity: current } = await settlementActivity(ctx, tx);
    let successCount = 0;
    let unresolved = false;
    for (const row of rows.filter((registration) => ['pending_review','pending_confirmation','confirmed','checked_in','pending_settlement','completed'].includes(registration.state))) {
      const registration = await tx.get<Registration>('registrations', row.id);
      if (registration?.state === 'completed') successCount++;
      if (registration && ['pending_review','pending_confirmation','confirmed','checked_in','pending_settlement'].includes(registration.state)) unresolved = true;
    }
    const status = failures.length || unresolved ? 'partial_failure' : 'completed';
    const job: SettlementJob = { id: jobId, clubId: ctx.clubId, activityId: current.id, ruleVersion: current.ruleVersion, status,
      successCount, failureCount: failures.length, failures };
    await tx.set('settlement_jobs', jobId, job);
    if (status === 'completed' && current.state !== 'settled') await tx.set('activities', current.id, { ...current, state: 'settled', revision: current.revision + 1 });
    await ctx.audit(tx, actor, 'settlement_job', jobId, { status, successCount, failureCount: failures.length, unresolved });
    return job;
  });
}

export async function reversePoints(ctx: Context) {
  const reason = text(ctx.request.payload.reason, '冲正原因', 500);
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner']);
    const original = await tx.get<LedgerEntry>('points_ledger', text(ctx.request.payload.ledgerId, 'ledgerId', 100));
    requireThat(original?.clubId === ctx.clubId && original.awardType === 'completion', 'STATE_CONFLICT', '只能冲正有效完成流水');
    await ctx.staff(tx, ['owner'], original.activityId);
    const id = key('reversal', original.id);
    const registrationId = key('registration', ctx.clubId, original.activityId, original.memberId);
    const registration = await tx.get<Registration>('registrations', registrationId);
    requireThat(registration, 'STATE_CONFLICT', '原参加记录不存在');
    const existing = await tx.get<LedgerEntry>('points_ledger', id);
    if (existing) return { entry: existing, registration };
    if (ctx.request.expectedRevision !== undefined) ctx.revision(registration);
    requireThat(registration.state === 'completed' && registration.settlementId === original.id, 'STATE_CONFLICT', '原完成状态已发生变化');
    const entry: LedgerEntry = { ...original, id, businessKey: id, awardType: 'reversal', growthDelta: -original.growthDelta,
      annualDelta: -original.annualDelta, completedCountDelta: -original.completedCountDelta, relatedEntryId: original.id, actorId: actor.user.id, reason };
    await tx.set('points_ledger', id, entry);
    await applyStats(ctx, tx, entry);
    await reverseActivityWallet(ctx, tx, original, entry);
    const next: Registration = { ...registration, completionVoided: true, voidedAt: ctx.now, revision: registration.revision + 1, reason, updatedAt: ctx.now };
    await tx.set('registrations', next.id, next);
    await ctx.audit(tx, actor, 'points_ledger', id, { relatedEntryId: original.id, growthDelta: entry.growthDelta, annualDelta: entry.annualDelta }, reason);
    return { entry, registration: next };
  });
}

export async function ownPoints(ctx: Context) {
  const year = ctx.request.payload.year === undefined ? shanghaiYear(ctx.now) : integer(ctx.request.payload.year, '年份', 2000);
  requireThat(year <= 2200, 'INVALID_INPUT', '年份不正确');
  const summary = await ctx.store.transaction(async (tx) => ctx.summary(tx, await ctx.actor(tx), year));
  const rows = await ctx.store.query<LedgerEntry>('points_ledger', { clubId: ctx.clubId, memberId: summary.id, year }, { orderBy: 'effectiveAt', direction: 'desc', limit: 21, after: parseCursor(ctx.request.payload.cursor) });
  const page = paginated(rows, 'effectiveAt');
  const items = await ctx.store.transaction(async (tx) => {
    await ctx.actor(tx);
    const result: LedgerEntry[] = [];
    for (const row of page.items) {
      const activity = await tx.get<{ title: string; clubId: string }>('activities', row.activityId);
      result.push({ ...row, activityTitle: activity?.clubId === ctx.clubId ? activity.title : '俱乐部活动' });
    }
    return result;
  });
  return { memberId: summary.id, growthPoints: summary.growthPoints, annualPoints: summary.annualPoints, completedCount: summary.completedCount, year, ...page, items };
}

export async function listRankings(ctx: Context) {
  const selected = ctx.request.payload.metric ?? 'growth';
  const metric = selected === 'completed' ? 'completed_count' : selected;
  requireThat(['growth','annual','completed_count'].includes(String(metric)), 'INVALID_INPUT', '榜单维度不正确');
  const year = metric === 'annual' ? integer(ctx.request.payload.year ?? shanghaiYear(ctx.now), '年份', 2000) : null;
  const cursor = parseCursor(ctx.request.payload.cursor);
  const rows = await ctx.store.query<PublicRanking>('public_rankings', { clubId: ctx.clubId, metric, year, visible: true }, { orderBy: 'score', direction: 'desc', limit: 21, after: cursor });
  const candidates = rows.slice(0, 20);
  const items = await ctx.store.transaction(async (tx) => {
    const result = [];
    let offset = cursor?.offset ?? 0, previousScore = cursor?.score, previousRank = cursor?.rank ?? 0;
    for (const row of candidates) {
      const member = await tx.get<Membership>('memberships', row.memberId);
      if (!member?.rankingOptIn || member.rankingConsentVersion !== row.consentVersion) continue;
      const user = await tx.get<User>('users', member.userId);
      if (user?.status !== 'active') continue;
      offset++;
      const rank = previousScore === row.score ? previousRank : offset;
      result.push({ memberPublicId: member.publicId, nickname: member.nickname, score: row.score, rank, completedCount: row.completedCount });
      previousScore = row.score; previousRank = rank;
    }
    return result;
  });
  const last = candidates[candidates.length - 1], lastPublic = items[items.length - 1];
  return { items, nextCursor: rows.length > 20 && last ? encodeCursor({ value: last.score, id: last.id, offset: (cursor?.offset ?? 0) + items.length, score: lastPublic?.score, rank: lastPublic?.rank }) : null };
}
