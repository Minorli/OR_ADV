import { demoSnapshot, DEMO_IDENTITIES } from './demo';
import { MemoryStore } from './memory-store';
import { completionIdFor, key, memberIdFor, registrationIdFor, shanghaiDay, shanghaiYear, statsIdFor, userIdFor, yearRevisionIdFor } from './models';
import type { Audit, Checkin, MemberStats, Membership, PublicRanking, Qualification, RecommendationProjection, SettlementJob, StaffRole, User } from './models';
import type { Activity, ActivityBriefing, LedgerEntry, Registration } from './types';
import type { StoreSnapshot } from './store';
import { effectiveMemberKind, recommendationSortKey } from './member-identity';

const DAY = 86400000;
const HOUR = 3600000;
const iso = (value: number) => new Date(value).toISOString();

/** Local, fictional examples. Cloud entry points must never import this factory. */
export function showcaseSnapshot(referenceNow = new Date().toISOString()): StoreSnapshot {
  const time = Date.parse(referenceNow);
  if (!Number.isFinite(time)) throw new Error('Invalid showcase reference time');
  const now = iso(time), today = Date.parse(`${shanghaiDay(now)}T00:00:00+08:00`);
  const seed = demoSnapshot(now);
  for (const name of ['registrations', 'activity_briefings', 'checkins', 'points_ledger', 'member_stats', 'public_rankings', 'public_recommendations', 'qualifications', 'settlement_jobs', 'audit_logs']) seed[name] = {};
  function put<T extends { id: string }>(collection: string, value: T): T {
    seed[collection][value.id] = value;
    return value;
  }
  const names = ['阿川', '老周', '山石', '小满', '北山', '阿岳', '老麦', '木木', '阿森', '小鹿', '大河', '青禾', '小路', '阿野', '松风', '石头', '晴川', '小满月', '溪谷', '南坡', '阿洛', '小白', '岩松', '远山'];
  const members: Membership[] = [];
  const identities = Object.values(DEMO_IDENTITIES);
  for (let index = 0; index < names.length; index++) {
    const identity = identities[index] ?? { appId: 'demo-app', openId: `fictional-showcase-${index}` };
    const userId = userIdFor(identity), id = memberIdFor('oradv', userId);
    const existing = seed.memberships[id] as Membership | undefined;
    put<User>('users', { id: userId, clubId: 'oradv', appId: identity.appId, wxOpenId: identity.openId, status: 'active',
      consentVersions: { privacy: 1, terms: 1 }, createdAt: iso(time - 120 * DAY), updatedAt: now });
    const founder = [1, 6, 7, 21].includes(index);
    const recommendationOptIn = index === 1 || (index >= 6 && index % 4 !== 0);
    const rankingOptIn = index === 1 || (index >= 6 && index !== 7 && index % 3 !== 0);
    const member = put<Membership>('memberships', { ...existing, id, clubId: 'oradv', userId,
      nickname: `${names[index]}（演示）`, publicId: existing?.publicId ?? key('public', 'showcase', index),
      rankingOptIn, rankingConsentVersion: rankingOptIn ? 1 : 0,
      recommendationOptIn, recommendationConsentVersion: recommendationOptIn ? 1 : 0,
      recommendationPriority: index === 1 ? 900 : index === 6 ? 300 : 10,
      memberKind: founder ? 'founder' : 'regular', memberKindVersion: founder ? 1 : 0,
      memberKindExpiresAt: index === 21 ? iso(time - DAY) : null, revision: 1,
      ...(index === 20 ? { kindRequestStatus: 'pending', kindRequestedAt: iso(time - HOUR), kindRequestReason: '演示：申请按既有成员资料核对身份' } : {}),
      createdAt: iso(time - 120 * DAY), updatedAt: now });
    members.push(member);
  }
  const owner = members[2].userId;
  function audit(targetType: string, targetId: string, createdAt: string, summary: Record<string, unknown>) {
    const id = key('demo_audit', targetType, targetId, Object.keys(seed.audit_logs).length);
    put<Audit>('audit_logs', { id, clubId: 'oradv', actorId: owner, action: 'demo.seed', targetType, targetId,
      requestId: id, traceId: 'fictional-showcase', summary: { fixtureOnly: true, ...summary }, reason: '仅为本机演示构造的历史记录', createdAt });
  }
  const base = seed.activities['intro-ride'] as Activity;
  function activity(id: string, title: string, state: Activity['state'], days: number, capacity: number, growth = 100): Activity {
    const start = today + days * DAY + 9 * HOUR;
    const value = put<Activity>('activities', { ...base, id, title: `${title} · 演示`, state,
      description: '本机虚构活动，用于体验报名、同行与成长记录。真实活动线下收费，具体安排由组织方说明；食宿交通自理。',
      location: '虚构训练区域（演示，请勿前往）', startAt: iso(start), endAt: iso(start + 5 * HOUR),
      applicationClosesAt: iso(start - DAY), capacity, reservedSeats: 0, waitlistCount: 0, nextQueueSeq: 0,
      minGrowthPoints: 0, requiredQualifications: [], pointsRule: { growth, annual: growth },
      actualStartedAt: ['ended', 'settled'].includes(state) ? iso(start) : null,
      actualCompletedAt: ['ended', 'settled'].includes(state) ? iso(start + 5 * HOUR) : null,
      safetyNotice: '演示资料不构成真实出行安排。积分不代替技能核验，人员情况以领队现场核对为准。',
      equipment: '合规车辆、全盔、护具、骑行靴、饮水和个人补给。', fixtureOnly: true });
    audit('activity', id, iso(Math.min(start - 10 * DAY, time)), { state });
    return value;
  }
  activity('intro-ride', '非铺装入门体验', 'published', 7, 12);
  put('activities', { ...activity('advanced-ride', '进阶控车训练', 'published', 14, 10, 180), minGrowthPoints: 100, requiredQualifications: ['advanced_offroad'], difficulty: '进阶' });
  activity('draft-ride', '下一期山地训练草稿', 'draft', 28, 16, 180);
  activity('day-trip', '近郊林道同行', 'published', 3, 12, 120);
  activity('full-ride', '碎石转弯小班', 'published', 10, 4, 160);
  const departureTime = Math.max(today, time - 90 * 60000);
  put('activities', { ...activity('ongoing-ride', '今日非铺装练习', 'in_progress', 0, 8),
    startAt: iso(departureTime), endAt: iso(today + DAY - 1), actualStartedAt: iso(departureTime),
    applicationClosesAt: iso(today - DAY) });
  activity('settlement-ride', '林道基础复训', 'ended', -1, 8, 150);
  const recentHistory = activity('history-ride', '基础控车练习', 'settled', -3, 20, 120);
  // Keep one completion in the displayed year, including New Year's midnight.
  // Its ride may start in the previous year; rewards follow actual completion.
  const latestEnd = Math.max(Date.parse(recentHistory.endAt), Date.parse(`${shanghaiYear(now)}-01-01T00:00:00+08:00`));
  put('activities', { ...recentHistory, startAt: iso(latestEnd - 5 * HOUR), endAt: iso(latestEnd),
    actualStartedAt: iso(latestEnd - 5 * HOUR), actualCompletedAt: iso(latestEnd), applicationClosesAt: iso(latestEnd - 2 * DAY) });
  activity('history-training', '砂石路面训练', 'settled', -21, 20, 180);
  activity('history-trail', '山谷路线同行', 'settled', -45, 20, 260);
  activity('cancelled-ride', '天气调整取消场次', 'cancelled', 5, 10, 120);
  for (const row of Object.values(seed.staff_roles) as StaffRole[]) {
    if (row.activityIds) put('staff_roles', { ...row, activityIds: ['intro-ride', 'day-trip', 'ongoing-ride', 'settlement-ride', 'full-ride', 'history-ride', 'history-training', 'history-trail'] });
  }
  function register(activityId: string, index: number, state: Registration['state']): Registration {
    const activity = seed.activities[activityId] as Activity, member = members[index];
    const confirmed = ['confirmed', 'checked_in', 'pending_settlement', 'completed', 'safe_exit', 'no_show'].includes(state);
    const kind = effectiveMemberKind(member, now);
    const createdAt = iso(Math.min(time - 2 * DAY, Date.parse(activity.startAt) - 7 * DAY));
    const registration = put<Registration>('registrations', {
      id: registrationIdFor('oradv', activityId, member.id), clubId: 'oradv', activityId, memberId: member.id,
      state, seatState: ['waitlisted', 'pending_review'].includes(state) ? 'none' : ['cancelled', 'rejected'].includes(state) ? 'released' : 'held',
      reviewDecision: state === 'rejected' ? 'rejected' : confirmed ? 'approved' : 'pending',
      queueSeq: activity.nextQueueSeq + 1, attempt: 1, revision: confirmed ? 2 : 1, acceptedRuleVersion: activity.ruleVersion,
      holdExpiresAt: null, settlementId: null, createdAt, updatedAt: createdAt,
      memberKindAtApplication: kind, memberKindVersionAtApplication: member.memberKindVersion ?? 0,
      confirmationPath: kind === 'founder' ? 'founder_direct' : 'staff_manual',
      ...(confirmed ? { memberKindAtConfirmation: kind, memberKindVersionAtConfirmation: member.memberKindVersion ?? 0,
        confirmedAt: createdAt, confirmedBy: kind === 'founder' ? 'system_founder' : owner } : {}),
      ...(['cancelled', 'rejected'].includes(state) ? { reason: state === 'cancelled' ? '演示：个人安排变化，主动取消' : '演示：装备条件未满足，核对后未通过' } : {}),
    });
    put('activities', { ...activity, nextQueueSeq: registration.queueSeq,
      reservedSeats: activity.reservedSeats + (registration.seatState === 'held' ? 1 : 0),
      waitlistCount: (activity.waitlistCount ?? 0) + (state === 'waitlisted' ? 1 : 0) });
    audit('registration', registration.id, createdAt, { state, seatState: registration.seatState });
    return registration;
  }
  for (const [index, state] of [[6, 'confirmed'], [8, 'confirmed'], [9, 'pending_confirmation'], [10, 'pending_confirmation'], [11, 'confirmed'], [12, 'cancelled'], [13, 'rejected']] as const) register('intro-ride', index, state);
  for (const index of [0, 1, 6, 8, 9, 10]) register('day-trip', index, 'confirmed');
  for (const index of [14, 15]) register('day-trip', index, 'pending_confirmation');
  register('advanced-ride', 0, 'pending_confirmation'); register('advanced-ride', 8, 'confirmed'); register('advanced-ride', 9, 'pending_confirmation');
  for (const index of [6, 7, 8]) register('full-ride', index, 'confirmed');
  register('full-ride', 9, 'pending_confirmation');
  for (const index of [0, 10, 11]) register('full-ride', index, 'waitlisted');
  for (const [index, state] of [[0, 'checked_in'], [1, 'checked_in'], [8, 'pending_settlement'], [9, 'safe_exit'], [10, 'no_show'], [11, 'confirmed']] as const) register('ongoing-ride', index, state);
  for (const index of [0, 6, 8, 12]) register('settlement-ride', index, 'pending_settlement');
  register('settlement-ride', 13, 'safe_exit'); register('settlement-ride', 14, 'no_show');
  for (const index of [0, 1, 2, 6, 8, 9, 10, 11, 12, 13, 14, 15]) register('history-ride', index, 'completed');
  for (const index of [0, 2, 3, 6, 8, 9, 10, 12, 14, 16, 18, 20, 22, 23]) register('history-training', index, 'completed');
  for (const index of [0, 2, 4, 5, 8, 9, 11, 13, 15, 17, 19, 21]) register('history-trail', index, 'completed');
  for (const index of [0, 1, 8]) register('cancelled-ride', index, 'confirmed');

  function checkin(registration: Registration, phase: Checkin['phase'], result: string, verifiedAt: string) {
    const day = shanghaiDay(verifiedAt), reason = result === 'safe_exit' ? '演示：检查车辆后退出，人员已安全回场' : result === 'no_show' ? '演示：出发前核对为未到场' : '';
    const id = key('checkin', 'oradv', registration.activityId, registration.memberId, phase, day);
    put<Checkin>('checkins', { id, clubId: 'oradv', activityId: registration.activityId, memberId: registration.memberId,
      phase, day, result, verifiedBy: members[5].userId, verifiedAt, reason });
    const current = seed.registrations[registration.id] as Registration;
    put('registrations', { ...current, ...(phase === 'departure' && result === 'present' ? { lastDepartureDay: day } : {}),
      ...(phase === 'return' ? { lastReturnDay: day } : {}), ...(reason ? { reason } : {}), revision: current.revision + 1, updatedAt: verifiedAt });
    audit('checkin', id, verifiedAt, { phase, day, result });
  }
  for (const row of Object.values(seed.registrations) as Registration[]) {
    if (!['checked_in', 'pending_settlement', 'completed', 'safe_exit', 'no_show'].includes(row.state)) continue;
    const activity = seed.activities[row.activityId] as Activity;
    const ongoing = activity.state === 'in_progress';
    const start = ongoing ? departureTime : Date.parse(activity.startAt) + 5 * 60000;
    const end = ongoing ? Math.max(start, time - 5 * 60000) : Date.parse(activity.endAt);
    checkin(row, 'departure', row.state === 'no_show' ? 'no_show' : 'present', iso(start));
    if (['pending_settlement', 'completed', 'safe_exit'].includes(row.state)) {
      if (shanghaiDay(iso(start)) !== shanghaiDay(iso(end))) {
        const lastDayStart = Date.parse(`${shanghaiDay(iso(end))}T00:00:00+08:00`);
        checkin(row, 'return', 'present', iso(lastDayStart - 1));
        checkin(row, 'departure', 'present', iso(lastDayStart));
      }
      checkin(row, 'return', row.state === 'safe_exit' ? 'safe_exit' : 'present', iso(end));
    }
  }
  for (const row of Object.values(seed.registrations) as Registration[]) {
    if (row.state !== 'completed') continue;
    const activity = seed.activities[row.activityId] as Activity;
    const id = completionIdFor(activity, row);
    put<LedgerEntry>('points_ledger', { id, clubId: 'oradv', memberId: row.memberId, activityId: row.activityId,
      awardType: 'completion', businessKey: id, growthDelta: activity.pointsRule.growth, annualDelta: activity.pointsRule.annual,
      completedCountDelta: 1, year: shanghaiYear(activity.actualCompletedAt!), effectiveAt: activity.actualCompletedAt!, ruleVersion: activity.ruleVersion,
      relatedEntryId: null, actorId: owner, reason: '演示：完成出发与回场核验后的结算' });
    put('registrations', { ...row, settlementId: id, revision: row.revision + 1, updatedAt: activity.actualCompletedAt! });
    audit('points_ledger', id, activity.actualCompletedAt!, { growthDelta: activity.pointsRule.growth });
  }
  const corrected = seed.registrations[registrationIdFor('oradv', 'history-training', members[23].id)] as Registration;
  const original = seed.points_ledger[corrected.settlementId!] as LedgerEntry;
  const reversalId = key('reversal', original.id);
  put<LedgerEntry>('points_ledger', { ...original, id: reversalId, businessKey: reversalId, awardType: 'reversal',
    growthDelta: -original.growthDelta, annualDelta: -original.annualDelta, completedCountDelta: -1,
    relatedEntryId: original.id, reason: '演示：核对记录后更正本次完成奖励' });
  put('registrations', { ...corrected, completionVoided: true, voidedAt: now, updatedAt: now, revision: corrected.revision + 1, reason: '演示：完成记录已更正' });
  audit('points_ledger', reversalId, now, { relatedEntryId: original.id, growthDelta: -original.growthDelta });
  const years = new Set([shanghaiYear(now)]);
  for (const row of Object.values(seed.points_ledger) as LedgerEntry[]) {
    years.add(row.year);
    for (const year of [null, row.year]) {
      const id = statsIdFor('oradv', row.memberId, year), previous = seed.member_stats[id] as MemberStats | undefined;
      put<MemberStats>('member_stats', { id, clubId: 'oradv', memberId: row.memberId, scope: year === null ? 'growth' : 'year', year,
        points: (previous?.points ?? 0) + (year === null ? row.growthDelta : row.annualDelta),
        completedCount: (previous?.completedCount ?? 0) + row.completedCountDelta, revision: (previous?.revision ?? 0) + 1 });
    }
  }
  for (const year of years) {
    const id = yearRevisionIdFor('oradv', year);
    put('member_stats', { id, clubId: 'oradv', kind: 'year_guard', year, revision: Object.values(seed.points_ledger).filter(row => (row as LedgerEntry).year === year).length });
  }
  for (const member of members) {
    const growth = seed.member_stats[statsIdFor('oradv', member.id, null)] as MemberStats | undefined;
    for (const metric of ['growth', 'completed_count', 'annual']) {
      for (const year of metric === 'annual' ? [...years] : [null]) {
        const annual = year === null ? undefined : seed.member_stats[statsIdFor('oradv', member.id, year)] as MemberStats | undefined;
        const id = key('ranking', 'oradv', member.id, metric, year ?? 'all');
        put<PublicRanking & { visible: boolean }>('public_rankings', { id, clubId: 'oradv', memberId: member.id,
          memberPublicId: member.publicId, nickname: member.nickname, metric, year,
          score: metric === 'growth' ? growth?.points ?? 0 : metric === 'annual' ? annual?.points ?? 0 : growth?.completedCount ?? 0,
          completedCount: growth?.completedCount ?? 0, consentVersion: member.rankingConsentVersion, visible: member.rankingOptIn });
      }
    }
    const id = key('recommendation', 'oradv', member.id);
    put<RecommendationProjection>('public_recommendations', { id, clubId: 'oradv', memberId: member.id,
      sortKey: recommendationSortKey(member, now), visible: member.recommendationOptIn === true, consentVersion: member.recommendationConsentVersion ?? 0 });
  }
  for (const [index, decision, expiresAt] of [[0, 'approved', iso(time + 90 * DAY)], [8, 'approved', iso(time + 90 * DAY)], [9, 'approved', null],
    [10, 'pending', null], [11, 'rejected', null], [12, 'approved', iso(time - DAY)]] as const) {
    const id = key('qualification', 'oradv', members[index].id, 'advanced_offroad');
    put<Qualification>('qualifications', { id, clubId: 'oradv', memberId: members[index].id, type: 'advanced_offroad', decision, expiresAt,
      revision: 1, ...(decision === 'pending' ? {} : { reviewedAt: iso(time - 10 * DAY), reviewedBy: owner }),
      reason: decision === 'pending' ? '演示：等待领队核对' : '演示：依据虚构技能核验记录填写' });
  }
  for (const activityId of ['intro-ride', 'day-trip', 'full-ride', 'ongoing-ride', 'settlement-ride', 'history-ride']) {
    const activity = seed.activities[activityId] as Activity;
    const id = key('briefing', 'oradv', activityId);
    put<ActivityBriefing>('activity_briefings', { id, clubId: 'oradv', activityId, meetingPoint: `演示集合点 ${activityId}（虚构，请勿前往）`,
      meetingTime: iso(Date.parse(activity.startAt) - 30 * 60000), contactName: '北山（演示领队）', contactMethod: 'other',
      contactValue: '演示联络入口，不对应真实账号或电话',
      checklist: ['检查轮胎、制动与油量', '带齐头盔、护具和骑行靴', '准备饮水、随身食品与个人药品', '确认集合安排及返程计划', '阅读本场风险说明'],
      notes: '仅供确认参加者体验资料查看和个人准备。清单勾选不代替现场核验；遇到问题先停止并联系本场负责人。',
      revision: 1, updatedAt: iso(Math.min(time, Date.parse(activity.startAt) - DAY)) });
  }
  for (const activityId of ['history-ride', 'history-training', 'history-trail']) {
    const id = key('settlement', 'oradv', activityId, 1);
    put<SettlementJob>('settlement_jobs', { id, clubId: 'oradv', activityId, ruleVersion: 1, status: 'completed',
      successCount: Object.values(seed.registrations).filter(row => (row as Registration).activityId === activityId && (row as Registration).state === 'completed').length,
      failureCount: 0, failures: [] });
  }
  return seed;
}

export function createShowcaseStore(referenceNow?: string): MemoryStore {
  return new MemoryStore(showcaseSnapshot(referenceNow), referenceNow ? () => referenceNow : undefined);
}
