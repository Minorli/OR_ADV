import { Context, paginated, parseCursor } from './context';
import { DomainError, requireThat, text } from './errors';
import { key, registrationIdFor, shanghaiDay, statsIdFor } from './models';
import type { Activity, Checkin, MemberStats, Membership, Qualification, Registration } from './models';
import type { Transaction } from './store';
import { WAITLIST_RECHECK_BATCH } from './limits';

export async function checkEligibility(ctx: Context, tx: Transaction, activity: Activity, memberId: string) {
  const growth = await tx.get<MemberStats>('member_stats', statsIdFor(ctx.clubId, memberId, null));
  requireThat((growth?.points ?? 0) >= activity.minGrowthPoints, 'SCORE_TOO_LOW', '成长积分未达到本场门槛');
  for (const type of activity.requiredQualifications) {
    const qualification = await tx.get<Qualification>('qualifications', key('qualification', ctx.clubId, memberId, type));
    requireThat(qualification?.clubId === ctx.clubId && qualification.memberId === memberId && qualification.decision === 'approved', 'QUALIFICATION_REQUIRED', '请先完成所需技能核验');
    requireThat(!qualification.expiresAt || qualification.expiresAt > ctx.now, 'QUALIFICATION_EXPIRED', '技能资格已过期，请重新核验');
  }
}

export function requireOpen(ctx: Context, activity: Activity) {
  requireThat(activity.state === 'published' && activity.applicationClosesAt > ctx.now, 'REGISTRATION_CLOSED', '本场已停止报名或候补提升');
}
export async function readRegistration(ctx: Context, tx: Transaction, id: unknown) {
  const registration = await tx.get<Registration>('registrations', text(id, 'registrationId', 100));
  requireThat(registration?.clubId === ctx.clubId, 'STATE_CONFLICT', '申请不存在或不可访问');
  return registration;
}
export async function applyRegistration(ctx: Context) {
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.actor(tx);
    const activity = await ctx.activity(tx, ctx.request.payload.activityId);
    const id = registrationIdFor(ctx.clubId, activity.id, actor.member.id);
    const existing = await tx.get<Registration>('registrations', id);
    if (existing && existing.state !== 'cancelled') return existing;
    requireOpen(ctx, activity);
    requireThat(ctx.request.payload.acceptedRuleVersion === activity.ruleVersion, 'RULE_VERSION_CHANGED', '活动规则已更新，请重新阅读');
    await checkEligibility(ctx, tx, activity, actor.member.id);
    const held = activity.reservedSeats < activity.capacity && (activity.waitlistCount ?? 0) === 0;
    const registration: Registration = { id, clubId: ctx.clubId, activityId: activity.id, memberId: actor.member.id,
      state: held ? activity.requiresReview || existing ? 'pending_review' : 'pending_confirmation' : 'waitlisted',
      seatState: held ? 'held' : 'none', reviewDecision: activity.requiresReview || existing ? 'pending' : 'not_required',
      queueSeq: activity.nextQueueSeq + 1, attempt: (existing?.attempt ?? 0) + 1, revision: (existing?.revision ?? 0) + 1,
      acceptedRuleVersion: activity.ruleVersion, holdExpiresAt: null, settlementId: null, createdAt: existing?.createdAt ?? ctx.now, updatedAt: ctx.now };
    await tx.set('registrations', id, registration);
    await tx.set('activities', activity.id, { ...activity, reservedSeats: activity.reservedSeats + (held ? 1 : 0),
      waitlistCount: (activity.waitlistCount ?? 0) + (held ? 0 : 1), nextQueueSeq: registration.queueSeq, revision: activity.revision + 1 });
    await ctx.audit(tx, actor, 'registration', id, { state: registration.state, attempt: registration.attempt, seatState: registration.seatState });
    return registration;
  });
}

export async function cancelRegistration(ctx: Context) {
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.actor(tx);
    const registration = await readRegistration(ctx, tx, ctx.request.payload.registrationId);
    requireThat(registration.memberId === actor.member.id, 'FORBIDDEN', '只能取消本人申请');
    if (registration.state === 'cancelled') return registration;
    ctx.revision(registration);
    const activity = await ctx.activity(tx, registration.activityId);
    requireThat(['published','closed'].includes(activity.state) && ['pending_review','pending_confirmation','confirmed','waitlisted'].includes(registration.state), 'STATE_CONFLICT', '当前阶段请联系工作人员处理');
    const reason = text(ctx.request.payload.reason, '取消原因', 500);
    const released = registration.seatState === 'held';
    requireThat(!released || activity.reservedSeats > 0, 'STATE_CONFLICT', '名额统计异常，请联系运营');
    const next: Registration = { ...registration, state: 'cancelled', seatState: released ? 'released' : registration.seatState, revision: registration.revision + 1, updatedAt: ctx.now, reason };
    await tx.set('registrations', next.id, next);
    await tx.set('activities', activity.id, { ...activity, reservedSeats: activity.reservedSeats - (released ? 1 : 0),
      waitlistCount: Math.max(0, (activity.waitlistCount ?? 0) - (registration.state === 'waitlisted' ? 1 : 0)), revision: activity.revision + 1 });
    await ctx.audit(tx, actor, 'registration', next.id, { from: registration.state, to: next.state, released }, reason);
    return next;
  });
}

export async function reviewRegistration(ctx: Context, confirm = false) {
  return ctx.store.transaction(async (tx) => {
    // Verify staff status before looking up an arbitrary registration.
    await ctx.staff(tx, ['owner','operator']);
    const registration = await readRegistration(ctx, tx, ctx.request.payload.registrationId);
    const actor = await ctx.staff(tx, ['owner','operator'], registration.activityId);
    ctx.revision(registration);
    const activity = await ctx.activity(tx, registration.activityId);
    requireThat(['published','closed'].includes(activity.state), 'STATE_CONFLICT', '活动状态不允许审核或确认');
    let state: Registration['state'];
    let decision = registration.reviewDecision;
    let reason = '';
    if (confirm) {
      requireThat(registration.state === 'pending_confirmation' && ['approved','not_required'].includes(decision) && registration.seatState === 'held', 'STATE_CONFLICT', '请先通过审核并预留名额');
      state = 'confirmed';
    } else {
      requireThat(['pending_review','waitlisted','pending_confirmation'].includes(registration.state), 'STATE_CONFLICT', '当前状态不允许审核');
      const proposed = ctx.request.payload.decision;
      requireThat(['approved','rejected'].includes(String(proposed)), 'INVALID_INPUT', '审核结论不正确');
      decision = proposed as 'approved' | 'rejected';
      if (decision === 'rejected') { reason = text(ctx.request.payload.reason, '未通过原因', 500); state = 'rejected'; }
      else state = registration.state === 'waitlisted' ? 'waitlisted' : 'pending_confirmation';
    }
    if (state !== 'rejected') {
      requireThat(registration.acceptedRuleVersion === activity.ruleVersion, 'RULE_VERSION_CHANGED', '申请所同意规则与当前规则不同');
      await checkEligibility(ctx, tx, activity, registration.memberId);
    }
    const released = state === 'rejected' && registration.seatState === 'held';
    if (released || (state === 'rejected' && registration.state === 'waitlisted')) {
      requireThat(!released || activity.reservedSeats > 0, 'STATE_CONFLICT', '名额统计异常');
      await tx.set('activities', activity.id, { ...activity, reservedSeats: activity.reservedSeats - (released ? 1 : 0),
        waitlistCount: Math.max(0, (activity.waitlistCount ?? 0) - (registration.state === 'waitlisted' ? 1 : 0)), revision: activity.revision + 1 });
    }
    const next: Registration = { ...registration, state, reviewDecision: decision, seatState: released ? 'released' : registration.seatState, revision: registration.revision + 1, updatedAt: ctx.now, ...(reason ? { reason } : {}) };
    await tx.set('registrations', next.id, next);
    await ctx.audit(tx, actor, 'registration', next.id, { from: registration.state, to: next.state, reviewDecision: decision }, reason);
    return next;
  });
}

export async function promoteWaitlist(ctx: Context) {
  const activityId = text(ctx.request.payload.activityId, 'activityId', 100);
  await ctx.store.transaction((tx) => ctx.staff(tx, ['owner','operator'], activityId));
  const candidates = await ctx.store.query<Registration>('registrations', { clubId: ctx.clubId, activityId, state: 'waitlisted' }, { orderBy: 'queueSeq', direction: 'asc', limit: WAITLIST_RECHECK_BATCH });
  return ctx.store.transaction(async (tx) => {
    const actor = await ctx.staff(tx, ['owner','operator'], activityId);
    const activity = await ctx.activity(tx, activityId);
    if (ctx.request.expectedRevision !== undefined) ctx.revision(activity);
    requireOpen(ctx, activity);
    requireThat(activity.reservedSeats < activity.capacity, 'NO_CAPACITY', '暂无可用名额');
    // Candidates are collected outside the SDK transaction. Every selected row
    // and activity counter is re-read, so retries cannot claim a released row.
    for (const candidate of candidates) {
      const current = await tx.get<Registration>('registrations', candidate.id);
      if (!current || current.state !== 'waitlisted' || current.queueSeq !== candidate.queueSeq) continue;
      const member = await tx.get<Membership>('memberships', current.memberId);
      if (!member) continue;
      const user = await tx.get<{ status: string }>('users', member.userId);
      if (user?.status !== 'active') continue;
      try { await checkEligibility(ctx, tx, activity, current.memberId); }
      catch (error) {
        if (error instanceof DomainError && ['SCORE_TOO_LOW','QUALIFICATION_REQUIRED','QUALIFICATION_EXPIRED'].includes(error.code)) continue;
        throw error;
      }
      if (current.acceptedRuleVersion !== activity.ruleVersion) continue;
      const next: Registration = { ...current, state: activity.requiresReview && current.reviewDecision !== 'approved' ? 'pending_review' : 'pending_confirmation',
        seatState: 'held', revision: current.revision + 1, updatedAt: ctx.now };
      await tx.set('registrations', next.id, next);
      await tx.set('activities', activity.id, { ...activity, reservedSeats: activity.reservedSeats + 1, waitlistCount: Math.max(0, (activity.waitlistCount ?? 0) - 1), revision: activity.revision + 1 });
      await ctx.audit(tx, actor, 'registration', next.id, { from: 'waitlisted', to: next.state });
      return next;
    }
    requireThat(candidates.length < WAITLIST_RECHECK_BATCH, 'STATE_CONFLICT', '前五名候补需先人工处理失效资格、取消或规则变化后再提升');
    return null;
  });
}

export async function listRegistrations(ctx: Context, staff = false) {
  const actor = await ctx.store.transaction(async (tx) => staff
    ? ctx.staff(tx, ['owner','operator','leader','checkin'], text(ctx.request.payload.activityId, 'activityId', 100)) : ctx.actor(tx));
  const filters: Record<string, unknown> = { clubId: ctx.clubId };
  if (staff) filters.activityId = ctx.request.payload.activityId;
  else {
    filters.memberId = actor.member.id;
    if (ctx.request.payload.activityId) filters.activityId = text(ctx.request.payload.activityId, 'activityId', 100);
  }
  if (ctx.request.payload.state) filters.state = text(ctx.request.payload.state, 'state', 30);
  const rows = await ctx.store.query<Registration>('registrations', filters, { orderBy: 'updatedAt', direction: 'desc', limit: 21, after: parseCursor(ctx.request.payload.cursor) });
  const page = paginated(rows, 'updatedAt');
  return ctx.store.transaction(async (tx) => {
    if (staff) await ctx.staff(tx, ['owner','operator','leader','checkin'], String(filters.activityId)); else await ctx.actor(tx);
    const items = [];
    for (const row of page.items) {
      const activity = await tx.get<Activity>('activities', row.activityId);
      const member = staff ? await tx.get<Membership>('memberships', row.memberId) : actor.member;
      items.push({ ...row, activityTitle: activity?.title ?? '活动', nickname: member?.nickname ?? '车友' });
    }
    return { ...page, items };
  });
}

export async function recordCheckin(ctx: Context) {
  const p = ctx.request.payload;
  requireThat(['departure','return'].includes(String(p.phase)), 'INVALID_INPUT', '核验阶段不正确');
  requireThat(['present','safe_exit','no_show'].includes(String(p.result)), 'INVALID_INPUT', '核验结果不正确');
  const day = p.day === undefined ? shanghaiDay(ctx.now) : text(p.day, '核验日期', 10);
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(day) && day === shanghaiDay(ctx.now), 'INVALID_INPUT', '现场核验须使用当日日期');
  return ctx.store.transaction(async (tx) => {
    await ctx.staff(tx, ['owner','operator','leader','checkin']);
    const registration = await readRegistration(ctx, tx, p.registrationId);
    const actor = await ctx.staff(tx, ['owner','operator','leader','checkin'], registration.activityId);
    const activity = await ctx.activity(tx, registration.activityId);
    const allowedAfterEnd = activity.state === 'ended' && (p.phase === 'return' || p.result === 'no_show');
    requireThat(activity.state === 'in_progress' || allowedAfterEnd, 'STATE_CONFLICT', '活动当前未进行或已停止核验');
    const id = key('checkin', ctx.clubId, activity.id, registration.memberId, String(p.phase), day);
    const previous = await tx.get<Checkin>('checkins', id);
    if (previous) {
      requireThat(previous.result === p.result, 'STATE_CONFLICT', '已有核验结果，变更请联系主理人');
      return registration;
    }
    if (ctx.request.expectedRevision !== undefined) ctx.revision(registration);
    let state: Registration['state'];
    let reason = '';
    if (p.phase === 'departure') {
      const lastDepartureDay = (registration as Registration & { lastDepartureDay?: string }).lastDepartureDay;
      const continuing = registration.state === 'checked_in' && !!lastDepartureDay && day > lastDepartureDay;
      requireThat(registration.state === 'confirmed' || continuing, 'STATE_CONFLICT', '仅确认参加者可出发核验');
      if (continuing) {
        const priorReturn = await tx.get<Checkin>('checkins', key('checkin', ctx.clubId, activity.id, registration.memberId, 'return', lastDepartureDay!));
        requireThat(priorReturn?.result === 'present', 'STATE_CONFLICT', '请先补齐上一天结束核验');
      }
      requireThat(p.result === 'present' || p.result === 'no_show', 'INVALID_INPUT', '出发阶段请记录到场或未到');
      if (p.result === 'present') {
        await checkEligibility(ctx, tx, activity, registration.memberId);
        requireThat(registration.acceptedRuleVersion === activity.ruleVersion, 'RULE_VERSION_CHANGED', '当前规则需重新确认');
        state = 'checked_in';
      } else { state = 'no_show'; reason = text(p.reason, '未到说明', 500); }
    } else {
      requireThat(registration.state === 'checked_in', 'STATE_CONFLICT', '需要有效出发核验后才能记录结束');
      requireThat(p.result !== 'no_show', 'INVALID_INPUT', '结束阶段不能登记未到');
      const lastDepartureDay = (registration as Registration & { lastDepartureDay?: string }).lastDepartureDay;
      requireThat(lastDepartureDay === day, 'STATE_CONFLICT', '需要当日出发核验');
      const plannedDays = Math.round((Date.parse(shanghaiDay(activity.endAt)) - Date.parse(shanghaiDay(activity.startAt))) / 86400000);
      const finalDay = new Date(Date.parse(shanghaiDay(activity.actualStartedAt ?? activity.startAt)) + plannedDays * 86400000).toISOString().slice(0, 10);
      state = p.result === 'safe_exit' ? 'safe_exit' : day < finalDay ? 'checked_in' : 'pending_settlement';
      if (state === 'safe_exit') reason = text(p.reason, '退出原因', 500);
    }
    const checkin: Checkin = { id, clubId: ctx.clubId, activityId: activity.id, memberId: registration.memberId,
      phase: p.phase as 'departure' | 'return', day, result: String(p.result), verifiedBy: actor.user.id, verifiedAt: ctx.now, reason };
    await tx.set('checkins', id, checkin);
    const next: Registration & { lastDepartureDay?: string } = { ...registration, state, revision: registration.revision + 1, updatedAt: ctx.now,
      ...(p.phase === 'departure' && p.result === 'present' ? { lastDepartureDay: day } : {}), ...(reason ? { reason } : {}) };
    await tx.set('registrations', next.id, next);
    await ctx.audit(tx, actor, 'registration', next.id, { from: registration.state, to: state, phase: p.phase, day }, reason);
    return next;
  });
}
