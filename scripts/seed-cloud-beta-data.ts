import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { completionIdFor, key, memberIdFor, registrationIdFor, shanghaiDay, shanghaiYear, statsIdFor, userIdFor } from '../shared/models';
import type { Activity, LedgerEntry, Registration } from '../shared/types';

export const TARGET = Object.freeze({ clubId: 'oradv', region: 'ap-shanghai', purpose: 'test' });
export interface SeedRow { collection: string; id: string; data: Record<string, unknown> }
export interface SeedGuard { collection: string; id: string }
export interface SeedGroup { id: string; rows: SeedRow[]; guards: SeedGuard[] }
export interface SeedBundle { datasetId: string; referenceAt: string; hash: string; groups: SeedGroup[]; guards: SeedGuard[]; globalGuards: SeedGuard[]; manifest: SeedRow }
interface ActivitySpec {
  slug: string; title: string; state: 'published' | 'settled'; startAt: string; endAt: string;
  location: string; difficulty: string; capacity: number; growth: number; annual: number; description: string; story?: string;
  registrations: [number, 'confirmed' | 'pending_confirmation' | 'cancelled' | 'completed'][];
}
interface Specification { datasetId: string; referenceAt: string; memberCreatedAt: string; fixtureAppId: string; provenance: string; members: string[]; activities: ActivitySpec[] }
export function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => [name, sort(content)])) : item;
  return JSON.stringify(sort(value));
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function rowDigest(value: Record<string, unknown>): string {
  const { _id: ignoredId, _openid: ignoredOpenId, ...data } = value;
  return digest(data);
}
function specification(): Specification {
  const input = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/cloud-beta-v1.json'), 'utf8')) as Specification;
  const fail = () => { throw new Error('SEED_SPEC_INVALID'); };
  if (input.datasetId !== 'cloud-beta-20261016-v1' || input.fixtureAppId !== `fixture-${input.datasetId}`
    || !Number.isFinite(Date.parse(input.referenceAt)) || !Number.isFinite(Date.parse(input.memberCreatedAt))
    || !Array.isArray(input.members) || input.members.length !== 8 || new Set(input.members).size !== 8
    || input.members.some(name => typeof name !== 'string' || !name.trim() || name.length > 24)
    || !Array.isArray(input.activities) || input.activities.length !== 6) fail();
  const slugs = new Set<string>();
  for (const activity of input.activities) {
    if (!/^[a-z][a-z-]{2,40}$/.test(activity.slug) || slugs.has(activity.slug) || !['published', 'settled'].includes(activity.state)
      || !Number.isFinite(Date.parse(activity.startAt)) || !Number.isFinite(Date.parse(activity.endAt)) || activity.startAt >= activity.endAt
      || !Number.isInteger(activity.capacity) || activity.capacity < 8 || activity.capacity > 200
      || !Number.isSafeInteger(activity.growth) || activity.growth < 0 || !Number.isSafeInteger(activity.annual) || activity.annual < 0
      || ![activity.title, activity.description, activity.location, activity.difficulty].every(value => typeof value === 'string' && !!value.trim())
      || !Array.isArray(activity.registrations) || new Set(activity.registrations.map(row => row[0])).size !== activity.registrations.length
      || activity.registrations.some(([index, state]) => !Number.isInteger(index) || index < 0 || index > 7 || !['confirmed', 'pending_confirmation', 'cancelled', 'completed'].includes(state))
      || activity.registrations.some(([, state]) => (activity.state === 'settled') !== (state === 'completed'))
      || (activity.state === 'settled' && (!activity.story || Date.parse(activity.endAt) >= Date.parse(input.referenceAt)))) fail();
    slugs.add(activity.slug);
  }
  if (input.activities.filter(row => row.state === 'published').length !== 3) fail();
  return input;
}

/** Separate, explicitly authorized test-cloud fixtures. Never used by a cloud function or the mock factories. */
export function buildCloudBetaSeed(): SeedBundle {
  const spec = specification(), actorId = `fixture:${spec.datasetId}`, reference = Date.parse(spec.referenceAt);
  const groups: SeedGroup[] = [], ids = new Set<string>(), ledgers: LedgerEntry[] = [];
  const add = (group: SeedGroup, collection: string, value: Record<string, unknown>): SeedRow => {
    const id = String(value.id), identity = `${collection}/${id}`;
    if (ids.has(identity)) throw new Error('SEED_DUPLICATE_ROW'); ids.add(identity);
    const data = { createdAt: spec.referenceAt, updatedAt: spec.referenceAt, schemaVersion: 1, ...value,
      fixtureOnly: true, fixtureDataset: spec.datasetId, fixtureVersion: 1, fixtureAddedAt: spec.referenceAt };
    const row = { collection, id, data }; group.rows.push(row); return row;
  };
  const members = spec.members.map((nickname, index) => {
    const identity = { appId: spec.fixtureAppId, openId: `unbound-fixture-${index}` }, userId = userIdFor(identity), id = memberIdFor('oradv', userId);
    const group: SeedGroup = { id: `member:${index}`, rows: [], guards: ['owner', 'operator', 'leader', 'checkin'].map(role => ({ collection: 'staff_roles', id: key('role', 'oradv', userId, role) })) };
    groups.push(group);
    add(group, 'users', { id: userId, clubId: 'oradv', appId: identity.appId, wxOpenId: identity.openId, status: 'active',
      consentVersions: {}, createdAt: spec.memberCreatedAt, fictionalIdentity: true });
    add(group, 'memberships', { id, clubId: 'oradv', userId, nickname, publicId: key('public', spec.datasetId, index),
      rankingOptIn: true, rankingConsentVersion: 1, fictionalOptIn: true, recommendationOptIn: false, recommendationConsentVersion: 0,
      recommendationPriority: 0, memberKind: 'regular', memberKindVersion: 0, memberKindExpiresAt: null, revision: 1, createdAt: spec.memberCreatedAt });
    return { id, userId, nickname, publicId: key('public', spec.datasetId, index), group };
  });
  const activityGroups: { group: SeedGroup; settled: boolean }[] = [];
  for (const definition of spec.activities) {
    const group: SeedGroup = { id: `activity:${definition.slug}`, rows: [], guards: [] }, id = `${spec.datasetId}-${definition.slug}`;
    activityGroups.push({ group, settled: definition.state === 'settled' });
    const startAt = new Date(definition.startAt).toISOString(), endAt = new Date(definition.endAt).toISOString();
    const activity: Activity = { id, clubId: 'oradv', title: definition.title, description: definition.description,
      location: definition.location, difficulty: definition.difficulty, state: definition.state, startAt, endAt,
      applicationClosesAt: new Date(Date.parse(startAt) - 2 * 86400000).toISOString(), capacity: definition.capacity,
      reservedSeats: definition.registrations.filter(([, state]) => state !== 'cancelled').length, waitlistCount: 0,
      minGrowthPoints: 0, requiredQualifications: [], requiresReview: true, ruleVersion: 1, revision: definition.registrations.length + (definition.state === 'settled' ? 5 : 1),
      pointsRule: { growth: definition.growth, annual: definition.annual }, nextQueueSeq: definition.registrations.length,
      actualStartedAt: definition.state === 'settled' ? startAt : null, actualCompletedAt: definition.state === 'settled' ? endAt : null,
      safetyNotice: '非铺装骑行存在摔车、路况及天气风险。按自身能力参加，身体或车辆异常时停止并联系负责人。',
      equipment: '合规车辆、全盔、骑行靴、护甲、护膝、手套、饮水与必要维修补给。', fixtureOnly: true };
    add(group, 'activities', activity as unknown as Record<string, unknown>);
    for (const [index, state] of definition.registrations) {
      const member = members[index], createdAt = new Date(Math.min(reference - 86400000, Date.parse(startAt) - 7 * 86400000)).toISOString();
      const completed = state === 'completed', confirmed = completed || state === 'confirmed';
      const registration: Registration = { id: registrationIdFor('oradv', id, member.id), clubId: 'oradv', activityId: id, memberId: member.id,
        state, seatState: state === 'cancelled' ? 'released' : 'held', reviewDecision: confirmed ? 'approved' : 'pending',
        queueSeq: definition.registrations.findIndex(([person]) => person === index) + 1, attempt: 1, revision: completed ? 5 : confirmed ? 2 : 1,
        acceptedRuleVersion: 1, holdExpiresAt: null, settlementId: null, createdAt, updatedAt: completed ? endAt : createdAt,
        memberKindAtApplication: 'regular', memberKindVersionAtApplication: 0, confirmationPath: 'staff_manual',
        ...(confirmed ? { confirmedAt: createdAt, confirmedBy: actorId, memberKindAtConfirmation: 'regular' as const, memberKindVersionAtConfirmation: 0 } : {}),
        ...(state === 'cancelled' ? { reason: '个人行程调整' } : {}) };
      if (completed) {
        registration.lastDepartureDay = shanghaiDay(startAt); registration.lastReturnDay = shanghaiDay(endAt);
        registration.settlementId = completionIdFor(activity, registration);
        const entry: LedgerEntry = { id: registration.settlementId, businessKey: registration.settlementId, clubId: 'oradv', memberId: member.id,
          activityId: id, awardType: 'completion', growthDelta: definition.growth, annualDelta: definition.annual, completedCountDelta: 1,
          year: shanghaiYear(endAt), effectiveAt: endAt, ruleVersion: 1, relatedEntryId: null, actorId,
          reason: '测试云样例记录，非真实骑行核验' };
        ledgers.push(entry); add(group, 'points_ledger', entry as unknown as Record<string, unknown>);
        for (const [phase, at] of [['departure', startAt], ['return', endAt]] as const) add(group, 'checkins', {
          id: key('checkin', 'oradv', id, member.id, phase, shanghaiDay(at)), clubId: 'oradv', activityId: id, memberId: member.id,
          phase, day: shanghaiDay(at), result: 'present', verifiedBy: actorId, verifiedAt: at, reason: '测试云样例核验记录' });
      }
      add(group, 'registrations', registration as unknown as Record<string, unknown>);
    }
    if (definition.state === 'settled') {
      add(group, 'settlement_jobs', { id: key('settlement', 'oradv', id, 1), clubId: 'oradv', activityId: id, ruleVersion: 1,
        status: 'completed', successCount: definition.registrations.length, failureCount: 0, failures: [] });
      add(group, 'activity_stories', { id: key('activity_story', 'oradv', id), clubId: 'oradv', activityId: id, intro: definition.story,
        photoAssetIds: [], documentaryUrl: '', documentaryTitle: '', videoRightsAcknowledged: false, honors: [], published: true,
        revision: 1, updatedBy: actorId });
    }
    add(group, 'audit_logs', { id: key('fixture_audit', spec.datasetId, id), clubId: 'oradv', actorId, action: 'test_seed.activity',
      targetType: 'activity', targetId: id, requestId: key('fixture_request', spec.datasetId, id), traceId: spec.datasetId,
      summary: { fixtureOnly: true, syntheticParticipants: definition.registrations.length }, reason: spec.provenance });
  }
  for (const member of members) {
    const own = ledgers.filter(row => row.memberId === member.id), year = shanghaiYear(spec.referenceAt), annual = own.filter(row => row.year === year);
    for (const selected of [null, year]) {
      const entries = selected === null ? own : annual;
      add(member.group, 'member_stats', { id: statsIdFor('oradv', member.id, selected), clubId: 'oradv', memberId: member.id,
        scope: selected === null ? 'growth' : 'year', year: selected, points: entries.reduce((sum, row) => sum + (selected === null ? row.growthDelta : row.annualDelta), 0),
        completedCount: entries.length, revision: entries.length });
    }
    for (const metric of ['growth', 'annual', 'completed_count']) add(member.group, 'public_rankings', {
      id: key('ranking', 'oradv', member.id, metric, metric === 'annual' ? year : 'all'), clubId: 'oradv', memberId: member.id,
      memberPublicId: member.publicId, nickname: member.nickname, metric, year: metric === 'annual' ? year : null,
      score: metric === 'completed_count' ? own.length : (metric === 'annual' ? annual : own).reduce((sum, row) => sum + (metric === 'annual' ? row.annualDelta : row.growthDelta), 0),
      completedCount: own.length, consentVersion: 1, visible: true, fictionalOptIn: true });
  }
  groups.push(...activityGroups.filter(row => row.settled).map(row => row.group), ...activityGroups.filter(row => !row.settled).map(row => row.group));
  // All legitimate staff mutations require the atomic owner bootstrap. Once
  // it has happened, external dependencies require manual cleanup review.
  const globalGuards = [{ collection: 'schema_migrations', id: key('owner-bootstrap', 'oradv') }];
  const guards = [...globalGuards, ...groups.flatMap(group => group.guards)], hash = digest({ target: TARGET, groups, guards, globalGuards });
  const manifest: SeedRow = { collection: 'schema_migrations', id: key('cloud_beta_seed', spec.datasetId), data: {
    id: key('cloud_beta_seed', spec.datasetId), clubId: 'oradv', kind: 'cloud_beta_seed', fixtureOnly: true, fixtureDataset: spec.datasetId,
    referenceAt: spec.referenceAt, hash, target: TARGET, provenance: spec.provenance, fictionalIdentities: true, realConsentEvidence: false,
    touchesMemberNumbers: false, realMemberPointsChanged: false, createdAt: spec.referenceAt, updatedAt: spec.referenceAt, schemaVersion: 1,
    groups: groups.map(group => ({ id: group.id, records: group.rows.map(row => ({ collection: row.collection, id: row.id, hash: rowDigest(row.data) })) })), guards, globalGuards,
  } };
  return { datasetId: spec.datasetId, referenceAt: spec.referenceAt, hash, groups, guards, globalGuards, manifest };
}
