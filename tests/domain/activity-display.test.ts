import test from 'node:test';
import assert from 'node:assert/strict';
import { activityDisplayFields, ACTIVITY_COVER_KEYS } from '../../shared/activity-display';
import { createDemoStore, DEMO_IDENTITIES } from '../../shared/demo';
import { createService } from '../../shared/service';
import { emptyClubContent } from '../../shared/club-content';
import type { Activity } from '../../shared/types';

const NOW = '2026-10-16T12:00:00.000Z';
const display = { coverKey: 'v2-1', distanceKm: 280, itinerary: [{ dayLabel: 'D1', title: '集合至练习区', description: '根据现场条件分组。' }] };
function setup() {
  const store = createDemoStore(NOW); let n = 0;
  const service = createService(store, { now: () => NOW, id: () => `display-${++n}` });
  const call = (action: string, payload: Record<string, unknown>, revision?: number, identity = DEMO_IDENTITIES.owner) => service.handle({ action, payload, expectedRevision: revision, clubId: 'oradv', requestId: `display-request-${++n}` }, identity);
  return { store, call };
}
function data(response: any): any { assert(response.ok, JSON.stringify(response)); return response.data; }

test('activity display accepts only packaged covers and bounded route metadata, never storage paths or extra itinerary fields', () => {
  for (const coverKey of ACTIVITY_COVER_KEYS) assert.equal(activityDisplayFields({ ...display, coverKey }).coverKey, coverKey);
  assert.deepEqual(activityDisplayFields({}), { coverKey: null, distanceKm: null, itinerary: [] });
  for (const patch of [{ coverKey: 'https://files.example.test/private.jpg' }, { coverKey: '/assets/covers/dunes.jpg' }, { coverKey: 'cloud://private' },
    { distanceKm: -1 }, { distanceKm: 0 }, { distanceKm: 100001 }, { distanceKm: 1.5 }, { itinerary: new Array(31).fill(display.itinerary[0]) },
    { itinerary: [{ ...display.itinerary[0], memberId: 'private' }] }, { itinerary: [{ dayLabel: 'D1', title: '' }] }]) assert.throws(() => activityDisplayFields({ ...display, ...patch }));
});

test('drafts persist explicit display metadata while published edits leave all operational rules and points unchanged', async () => {
  const env = setup(), original = env.store.snapshot().activities['intro-ride'] as Activity & { updatedAt: string };
  const draft = data(await env.call('staff.activity.save', { title: '有路线资料的活动', description: original.description, location: original.location, difficulty: original.difficulty,
    startAt: original.startAt, endAt: original.endAt, applicationClosesAt: original.applicationClosesAt, capacity: 10, minGrowthPoints: 0, requiredQualifications: [], requiresReview: false,
    pointsRule: { growth: 10, annual: 10 }, safetyNotice: original.safetyNotice, equipment: original.equipment, ...display }));
  assert.equal(draft.coverKey, display.coverKey); assert.equal(draft.distanceKm, 280); assert.deepEqual(draft.itinerary, display.itinerary);
  const before = env.store.snapshot(), edited = data(await env.call('staff.activity.content.save', { activityId: original.id, title: original.title, description: original.description, reason: '核对公开路线资料', ...display }, original.revision));
  const stored = env.store.snapshot().activities[original.id] as Activity;
  assert.deepEqual({ ...stored, coverKey: undefined, distanceKm: undefined, itinerary: undefined, revision: original.revision, updatedAt: original.updatedAt },
    { ...original, coverKey: undefined, distanceKm: undefined, itinerary: undefined, updatedAt: original.updatedAt });
  assert.deepEqual(edited.pointsRule, original.pointsRule); assert.deepEqual(env.store.snapshot().member_stats, before.member_stats); assert.deepEqual(env.store.snapshot().points_ledger, before.points_ledger);
  const failed = await env.call('staff.activity.content.save', { activityId: original.id, title: original.title, description: original.description, reason: '不允许规则混入', ...display, capacity: 999 }, stored.revision);
  assert(!failed.ok); assert.equal(failed.error.code, 'INVALID_INPUT');
});

test('public core display extras need publication rights and never copy private avatars or grant staff roles', async () => {
  const env = setup(), before = env.store.snapshot();
  const person = { name: '公开昵称', duty: '主理人', introduction: '', responsibilities: ['路线沟通'], avatarText: '北', experience: '由本人核定的公开经历', distanceKm: 62000, serviceText: '' };
  const content = { ...emptyClubContent('core'), people: [person] };
  const denied = await env.call('staff.club.content.save', { section: 'core', content, status: 'published', rightsAcknowledged: false }, 0); assert(!denied.ok);
  data(await env.call('staff.club.content.save', { section: 'core', content, status: 'published', rightsAcknowledged: true }, 0));
  assert.deepEqual(data(await env.call('club.content.get', { section: 'core' })).people[0], person);
  assert.deepEqual(env.store.snapshot().staff_roles, before.staff_roles); assert.deepEqual(env.store.snapshot().memberships, before.memberships);
  for (const change of [{ avatarFileId: 'private' }, { avatarUrl: 'https://private.example.test/secret' }, { distanceKm: -1 }, { avatarText: '名字太长' }]) {
    const invalid = await env.call('staff.club.content.save', { section: 'core', content: { ...content, people: [{ ...person, ...change }] }, status: 'draft' }, 1);
    assert(!invalid.ok); assert.equal(invalid.error.code, 'INVALID_INPUT');
  }
});
