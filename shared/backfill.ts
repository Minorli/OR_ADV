import { Context, collect } from './context';
import { integer, requireThat, text } from './errors';
import { key, registrationIdFor, shanghaiYear } from './models';
import type { Membership, User } from './models';
import type { Activity, LedgerEntry, Registration } from './types';
import { applyStats } from './points';
import { awardActivityWallet } from './points-wallet';
import { BETA_MAX_CAPACITY } from './limits';
import { activityDisplayFields } from './activity-display';
import { readMemberNumber } from './member-number';

const BACKFILL_ATTEMPTS = 10;

function timestamp(value: unknown, name: string) {
  const result = text(value, name, 40);
  requireThat(Number.isFinite(Date.parse(result)) && /Z$|[+-]\d\d:\d\d$/.test(result), 'INVALID_INPUT', `${name}须包含时区`);
  return new Date(result).toISOString();
}
function boundedPoints(value: unknown, name: string) {
  const points = integer(value, name, 0);
  requireThat(points <= 1000, 'INVALID_INPUT', `${name}须在0至1000之间`);
  return points;
}

/** Owner records an activity that already happened. It is archived immediately and does not open registration. */
export async function recordPastActivity(ctx: Context) {
  const p = ctx.request.payload;
  requireThat(Object.keys(p).every((field) => ['title', 'description', 'location', 'startAt', 'endAt', 'actualCompletedAt', 'growth', 'annual', 'coverKey', 'distanceKm'].includes(field)), 'INVALID_INPUT', '补录活动包含不支持的字段');
  const growth = boundedPoints(p.growth ?? 0, '成长积分');
  const annual = boundedPoints(p.annual ?? 0, '年度积分');
  const startAt = timestamp(p.startAt, '开始时间');
  const endAt = timestamp(p.endAt, '结束时间');
  const completed = timestamp(p.actualCompletedAt ?? p.endAt, '实际完成时间');
  requireThat(startAt < endAt && completed >= startAt && completed <= ctx.now, 'INVALID_INPUT', '补录活动的时间须已经结束');
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner']);
    const id = ctx.id();
    const activity: Activity = {
      id, clubId: ctx.clubId, title: text(p.title, '标题', 80), description: text(p.description, '回顾简介', 4000),
      location: text(p.location, '公开区域', 100), difficulty: '已完成', state: 'settled',
      startAt, endAt, applicationClosesAt: startAt, capacity: BETA_MAX_CAPACITY, reservedSeats: 0,
      minGrowthPoints: 0, requiredQualifications: [], requiresReview: true,
      ruleVersion: 1, revision: 1, pointsRule: { growth, annual, redeemable: 0 },
      nextQueueSeq: 0, actualCompletedAt: completed, actualStartedAt: startAt,
      safetyNotice: '本场为已完成活动补录，不开放报名。', equipment: '以当时活动要求为准。', backfill: true,
      ...activityDisplayFields({ coverKey: p.coverKey, distanceKm: p.distanceKm ?? null, itinerary: [] }),
    };
    await tx.set('activities', id, activity);
    await ctx.audit(tx, actor, 'activity', id, { state: 'settled', backfill: true, growth, annual, revision: 1 }, '补录已完成活动');
    return { id, title: activity.title, revision: activity.revision, growth, annual, actualCompletedAt: completed };
  });
}

/** Owner awards one member for a settled activity. The same grant is idempotent; a different amount must be reversed first. */
export async function grantPastPoints(ctx: Context) {
  const p = ctx.request.payload;
  requireThat(Object.keys(p).every((field) => ['activityId', 'memberNumber', 'growth', 'annual', 'reason'].includes(field)), 'INVALID_INPUT', '补录积分包含不支持的字段');
  const activityId = text(p.activityId, 'activityId', 100);
  const memberNumber = integer(p.memberNumber, '成员编号', 0);
  const reason = text(p.reason, '补录依据', 500);
  await ctx.store.transaction(async (tx) => { await ctx.staff(tx, ['owner']); });
  const roster = await collect<Membership>(ctx.store, 'memberships', { clubId: ctx.clubId });
  requireThat(roster.length <= 200, 'STATE_CONFLICT', '当前内测成员数量超过200人，请联系主理人处理');
  const found = roster.filter((row) => readMemberNumber(row.memberNumber) === memberNumber);
  requireThat(found.length === 1, 'INVALID_INPUT', '未找到该成员编号');
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner'], activityId);
    const activity = await tx.get<Activity>('activities', activityId);
    requireThat(activity?.clubId === ctx.clubId && activity.state === 'settled' && activity.actualCompletedAt, 'STATE_CONFLICT', '只能为已归档的活动补录积分');
    requireThat(activity.backfill === true, 'STATE_CONFLICT', '只能为补录的往期活动补记积分；正常活动请走报名、核验和结算');
    requireThat((activity.pointsRule.redeemable ?? 0) === 0, 'STATE_CONFLICT', '补录活动不发放兑换积分');
    const member = await tx.get<Membership>('memberships', found[0].id);
    requireThat(member?.clubId === ctx.clubId && readMemberNumber(member.memberNumber) === memberNumber, 'INVALID_INPUT', '未找到该成员编号');
    const user = await tx.get<User>('users', member.userId);
    requireThat(user?.status === 'active', 'FORBIDDEN', '该成员账号不可使用');
    const growth = p.growth === undefined ? activity.pointsRule.growth : boundedPoints(p.growth, '成长积分');
    const annual = p.annual === undefined ? activity.pointsRule.annual : boundedPoints(p.annual, '年度积分');
    const registrationId = registrationIdFor(ctx.clubId, activity.id, member.id);
    const existingReg = await tx.get<Registration>('registrations', registrationId);
    // A reversed completion stays in the ledger; a corrected grant uses the next numbered slot.
    let ledgerId = '';
    for (let attempt = 1; attempt <= BACKFILL_ATTEMPTS && !ledgerId; attempt++) {
      const candidate = attempt === 1 ? key(ctx.clubId, activity.id, member.id, 'completion') : key(ctx.clubId, activity.id, member.id, 'completion', attempt);
      const existingLedger = await tx.get<LedgerEntry>('points_ledger', candidate);
      if (!existingLedger) { ledgerId = candidate; break; }
      if (await tx.get<LedgerEntry>('points_ledger', key('reversal', candidate))) continue;
      requireThat(existingLedger.awardType === 'completion' && existingLedger.growthDelta === growth && existingLedger.annualDelta === annual && existingLedger.memberId === member.id, 'STATE_CONFLICT', '该成员本场已有不同积分，请先冲正后再补录');
      return { ledgerId: candidate, registrationId, idempotent: true, growth, annual, memberPublicId: member.publicId };
    }
    requireThat(ledgerId, 'STATE_CONFLICT', '该成员本场更正次数过多，请联系开发人员核对');
    requireThat(!existingReg || (existingReg.state === 'completed' && (ledgerId === key(ctx.clubId, activity.id, member.id, 'completion') ? !existingReg.settlementId : existingReg.completionVoided === true)),
      'STATE_CONFLICT', '该成员已有其他参加记录，不能直接补录');
    const entry: LedgerEntry = {
      id: ledgerId, clubId: ctx.clubId, memberId: member.id, activityId: activity.id, awardType: 'completion', businessKey: ledgerId,
      growthDelta: growth, annualDelta: annual, completedCountDelta: 1,
      year: shanghaiYear(activity.actualCompletedAt), effectiveAt: activity.actualCompletedAt, ruleVersion: activity.ruleVersion,
      relatedEntryId: null, actorId: actor.user.id, reason,
    };
    await tx.set('points_ledger', ledgerId, entry);
    await applyStats(ctx, tx, entry);
    await awardActivityWallet(ctx, tx, activity, entry);
    const registration: Registration = existingReg ?? {
      id: registrationId, clubId: ctx.clubId, activityId: activity.id, memberId: member.id, memberNumber,
      state: 'completed', seatState: 'none', reviewDecision: 'approved', queueSeq: 0, attempt: 1, revision: 0,
      acceptedRuleVersion: activity.ruleVersion, holdExpiresAt: null, settlementId: null,
      createdAt: activity.actualCompletedAt, updatedAt: ctx.now, nickname: member.nickname,
    };
    const { voidedAt: _voidedAt, ...kept } = registration;
    const next: Registration = { ...kept, state: 'completed', settlementId: ledgerId, completionVoided: false, revision: registration.revision + 1, updatedAt: ctx.now };
    await tx.set('registrations', registrationId, next);
    await ctx.audit(tx, actor, 'points_ledger', ledgerId, { backfill: true, memberId: member.id, memberNumber, growthDelta: growth, annualDelta: annual, year: entry.year }, reason);
    return { ledgerId, registrationId, idempotent: false, growth, annual, memberPublicId: member.publicId };
  });
}
