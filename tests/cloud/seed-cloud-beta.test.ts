import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildCloudBetaSeed, canonical, TARGET } from '../../scripts/seed-cloud-beta-data';
import { applyCloudBetaSeed, cleanupCloudBetaSeed, type SeedDatabase, type SeedTransaction } from '../../scripts/seed-cloud-beta';
import { MemoryStore } from '../../shared/memory-store';
import { createService } from '../../shared/service';
import { key, memberIdFor, statsIdFor, userIdFor } from '../../shared/models';
import { memberSequenceId } from '../../shared/member-number';
import { bootstrapOwner } from '../../shared/owner-bootstrap';

type Row = Record<string, unknown>;
const EXAMPLE_APP_ID = 'wx0123456789abcdef';
const EXAMPLE_TARGET = { ...TARGET, envId: 'seed-test-environment', appId: EXAMPLE_APP_ID };
const rowKey = (collection: string, id: string) => `${collection}/${id}`;
function database() {
  let state = new Map<string, Row>(), writes = 0, transactions = 0;
  let beforeTransaction: ((index: number) => void) | undefined;
  const db: SeedDatabase = {
    target: EXAMPLE_TARGET,
    get: async (collection, id) => structuredClone(state.get(rowKey(collection, id)) ?? null),
    async transaction<T>(work: (tx: SeedTransaction) => Promise<T>) {
      beforeTransaction?.(++transactions);
      const staged = structuredClone(state); let changes = 0, operations = 0;
      const result = await work({
        get: async (collection, id) => { operations++; return structuredClone(staged.get(rowKey(collection, id)) ?? null); },
        set: async (collection, id, value) => { operations++; changes++; staged.set(rowKey(collection, id), structuredClone(value)); },
        remove: async (collection, id) => { operations++; changes++; staged.delete(rowKey(collection, id)); },
      });
      assert(operations <= 100, 'one atomic group must fit the CloudBase document-operation limit');
      state = staged; writes += changes; return result;
    },
  };
  return { db, state: () => state, put: (collection: string, id: string, row: Row) => state.set(rowKey(collection, id), structuredClone(row)),
    writes: () => writes, before: (value: typeof beforeTransaction) => { beforeTransaction = value; } };
}

test('cloud beta fixture graph is deterministic, unnumbered, coherent and cannot map to real WeChat identities', () => {
  const bundle = buildCloudBetaSeed(), rows = bundle.groups.flatMap(group => group.rows);
  assert.equal(canonical(bundle), canonical(buildCloudBetaSeed()));
  const selected = (collection: string) => rows.filter(row => row.collection === collection).map(row => row.data);
  assert.equal(selected('activities').length, 6); assert.equal(selected('memberships').length, 8);
  assert.equal(selected('activities').filter(row => row.state === 'published').length, 3);
  assert.equal(selected('activities').filter(row => row.state === 'settled').length, 3);
  assert.equal(selected('points_ledger').length, 19); assert.equal(selected('checkins').length, 38);
  assert(rows.every(row => row.data.fixtureOnly === true && row.data.fixtureDataset === bundle.datasetId));
  assert(rows.every(row => !['clubs', 'staff_roles', 'qualifications', 'annual_rewards', 'member_media', 'activity_reviews'].includes(row.collection)));
  for (const member of selected('memberships')) {
    assert.equal(member.memberNumber, undefined);
    const user = selected('users').find(row => row.id === member.userId)!;
    assert.notEqual(user.appId, EXAMPLE_APP_ID);
    assert.notEqual(userIdFor({ appId: EXAMPLE_APP_ID, openId: user.wxOpenId as string }), user.id);
    assert.deepEqual(user.consentVersions, {}, 'no real-person consent is manufactured');
    const ledger = selected('points_ledger').filter(row => row.memberId === member.id);
    const growth = selected('member_stats').find(row => row.id === statsIdFor('oradv', member.id as string, null))!;
    assert.equal(growth.points, ledger.reduce((sum, row) => sum + Number(row.growthDelta), 0));
    assert.equal(growth.completedCount, ledger.length);
  }
  for (const activity of selected('activities')) {
    assert(!/演示|模拟/.test(`${activity.title}${activity.description}`));
    const registrations = selected('registrations').filter(row => row.activityId === activity.id);
    assert.equal(activity.reservedSeats, registrations.filter(row => row.seatState === 'held').length);
    assert.equal(activity.nextQueueSeq, registrations.length);
    if (activity.state === 'settled') for (const registration of registrations) {
      assert(selected('points_ledger').some(row => row.id === registration.settlementId && row.memberId === registration.memberId));
      assert.equal(selected('checkins').filter(row => row.memberId === registration.memberId && row.activityId === activity.id).length, 2);
    }
  }
});

test('insert-only import is idempotent and cleanup preserves real membership, zero/positive number controls and real points', async () => {
  const fixture = database(), bundle = buildCloudBetaSeed();
  const real = { id: 'real-member', memberNumber: 1, untouched: true };
  fixture.put('memberships', 'real-member', real);
  fixture.put('clubs', memberSequenceId('oradv'), { id: memberSequenceId('oradv'), nextNumber: 3, primaryOwnerMemberId: 'real-owner-zero' });
  fixture.put('member_stats', 'real-stats', { id: 'real-stats', points: 75 });
  const initial = canonical([...fixture.state()]);
  const first = await applyCloudBetaSeed(fixture.db, bundle); assert(first.inserted > 0);
  const writes = fixture.writes(); const second = await applyCloudBetaSeed(fixture.db, bundle);
  assert.equal(second.inserted, 0); assert.equal(fixture.writes(), writes);
  assert.deepEqual(fixture.state().get('memberships/real-member'), real);
  const cleaned = await cleanupCloudBetaSeed(fixture.db, bundle); assert.equal(cleaned.deleted, first.inserted);
  assert.equal(canonical([...fixture.state()]), initial);
  assert.equal((await cleanupCloudBetaSeed(fixture.db, bundle)).deleted, 0);
});

test('any modified or foreign row refuses import and all cleanup writes before touching other rows', async () => {
  for (const operation of [applyCloudBetaSeed, cleanupCloudBetaSeed]) {
    const fixture = database(), bundle = buildCloudBetaSeed(); await applyCloudBetaSeed(fixture.db, bundle);
    const row = bundle.groups.find(group => group.id.startsWith('activity:'))!.rows.find(row => row.collection === 'activities')!;
    fixture.put(row.collection, row.id, { ...row.data, revision: Number(row.data.revision) + 1 });
    const writes = fixture.writes();
    await assert.rejects(operation(fixture.db, bundle), /SEED_ROW_CHANGED/); assert.equal(fixture.writes(), writes);
  }
  const fixture = database(), bundle = buildCloudBetaSeed(), row = bundle.groups[0].rows[0];
  fixture.put(row.collection, row.id, { id: row.id, privateRealData: true });
  await assert.rejects(applyCloudBetaSeed(fixture.db, bundle), /SEED_ROW_CHANGED/); assert.equal(fixture.writes(), 0);
});

test('cleanup rechecks hashes atomically and refuses an activity changed after preflight', async () => {
  const fixture = database(), bundle = buildCloudBetaSeed(); await applyCloudBetaSeed(fixture.db, bundle);
  const group = bundle.groups[bundle.groups.length - 1], activity = group.rows.find(row => row.collection === 'activities')!;
  fixture.before(() => { fixture.before(undefined); fixture.put(activity.collection, activity.id, { ...activity.data, revision: Number(activity.data.revision) + 1, reservedSeats: Number(activity.data.reservedSeats) + 1 }); });
  const writes = fixture.writes(); await assert.rejects(cleanupCloudBetaSeed(fixture.db, bundle), /SEED_ROW_CHANGED/);
  assert.equal(fixture.writes(), writes); assert(fixture.state().has(rowKey(activity.collection, activity.id)));
});

test('tampered bundles and granted fictional roles cannot be applied or cleaned', async () => {
  const fixture = database(), bundle = buildCloudBetaSeed(), altered = structuredClone(bundle);
  altered.groups[0].rows[0].data.id = 'real-member';
  await assert.rejects(applyCloudBetaSeed(fixture.db, altered), /SEED_PLAN_CHANGED/); assert.equal(fixture.writes(), 0);
  await applyCloudBetaSeed(fixture.db, bundle);
  const guard = bundle.groups[0].guards[0]; fixture.put(guard.collection, guard.id, { id: guard.id, enabled: true });
  const writes = fixture.writes(); await assert.rejects(cleanupCloudBetaSeed(fixture.db, bundle), /SEED_GUARD_OCCUPIED/); assert.equal(fixture.writes(), writes);
});

test('owner bootstrap followed by a qualification or real employee activity role prevents all automatic cleanup', async () => {
  const fixture = database(), bundle = buildCloudBetaSeed(); await applyCloudBetaSeed(fixture.db, bundle);
  const snapshot: Record<string, Record<string, unknown>> = {};
  for (const [path, row] of fixture.state()) { const slash = path.indexOf('/'); (snapshot[path.slice(0, slash)] ??= {})[path.slice(slash + 1)] = row; }
  const store = new MemoryStore(snapshot, () => bundle.referenceAt), service = createService(store, { now: () => bundle.referenceAt });
  const identities = ['developer', 'owner', 'employee'].map(name => ({ appId: EXAMPLE_APP_ID, openId: `real-seed-guard-${name}` }));
  const members: string[] = [];
  for (const [index, identity] of identities.entries()) {
    const result = await service.handle({ action: 'identity.ensure', clubId: 'oradv', requestId: `guard-login-${index}`, payload: { consentVersions: { privacy: 1, terms: 1 } } }, identity);
    assert(result.ok); members.push((result.data as { id: string }).id);
  }
  assert.equal((store.snapshot().memberships[members[2]] as Row).memberNumber, 3);
  await store.transaction(tx => bootstrapOwner(tx, { clubId: 'oradv', appId: EXAMPLE_APP_ID, memberId: members[1], actorId: 'deployment:seed-test', traceId: 'seed-bootstrap-guard', envId: EXAMPLE_TARGET.envId, now: bundle.referenceAt }));
  const fakeMember = bundle.groups[0].rows.find(row => row.collection === 'memberships')!;
  const future = bundle.groups.flatMap(group => group.rows).find(row => row.collection === 'activities' && row.data.state === 'published')!;
  for (const [action, payload] of [
    ['staff.qualification.review', { memberId: fakeMember.id, type: 'new-arbitrary-type', decision: 'approved', reason: '负责人新增资格核验' }],
    ['staff.roles.assign', { memberId: members[2], role: 'leader', activityIds: [future.id], reason: '真实员工负责本场活动' }],
  ] as const) {
    const result = await service.handle({ action, payload, expectedRevision: 0, clubId: 'oradv', requestId: `seed-guard-${action}` }, identities[1]); assert(result.ok, JSON.stringify(result));
  }
  const after = store.snapshot();
  assert.equal(canonical(after.memberships[fakeMember.id]), canonical(fakeMember.data), 'qualification creation does not change the fixture member');
  assert.equal(canonical(after.activities[future.id]), canonical(future.data), 'real employee role assignment does not change the fixture activity');
  for (const [collection, rows] of Object.entries(after)) for (const [id, row] of Object.entries(rows)) fixture.put(collection, id, row as Row);
  const writes = fixture.writes(), state = canonical([...fixture.state()]);
  await assert.rejects(cleanupCloudBetaSeed(fixture.db, bundle), /SEED_GUARD_OCCUPIED/);
  assert.equal(fixture.writes(), writes); assert.equal(canonical([...fixture.state()]), state);
});

test('an owner bootstrap appearing after cleanup preflight is checked again before any grouped deletion', async () => {
  const fixture = database(), bundle = buildCloudBetaSeed(); await applyCloudBetaSeed(fixture.db, bundle);
  fixture.before(() => { fixture.before(undefined); const id = key('owner-bootstrap', 'oradv'); fixture.put('schema_migrations', id, { id, status: 'closed' }); });
  const writes = fixture.writes(); await assert.rejects(cleanupCloudBetaSeed(fixture.db, bundle), /SEED_GUARD_OCCUPIED/); assert.equal(fixture.writes(), writes);
});

test('public activity/history/ranking queries work while new real registrations and points remain independent', async () => {
  const bundle = buildCloudBetaSeed(), snapshot: Record<string, Record<string, unknown>> = {};
  for (const row of bundle.groups.flatMap(group => group.rows)) (snapshot[row.collection] ??= {})[row.id] = row.data;
  const identity = { appId: EXAMPLE_APP_ID, openId: 'real-test-user' }, userId = userIdFor(identity), memberId = memberIdFor('oradv', userId);
  snapshot.users[userId] = { id: userId, clubId: 'oradv', appId: identity.appId, wxOpenId: identity.openId, status: 'active', consentVersions: {}, createdAt: bundle.referenceAt, updatedAt: bundle.referenceAt };
  snapshot.memberships[memberId] = { id: memberId, clubId: 'oradv', userId, nickname: '真实测试成员', memberNumber: 1, publicId: 'real-public-id', rankingOptIn: false, rankingConsentVersion: 0, revision: 1 };
  snapshot.clubs = { oradv: { id: 'oradv', clubId: 'oradv', name: 'OriginalRally原始拉力', contactName: '已配置组织方', contactMethod: 'wechat', contactValue: 'configured-test-contact', contactInstructions: '联系组织方核对', revision: 1 } };
  const store = new MemoryStore(snapshot), service = createService(store, { now: () => bundle.referenceAt }); let n = 0;
  const call = (action: string, payload = {}) => service.handle({ action, payload, clubId: 'oradv', requestId: `seed-test-${++n}` }, identity);
  const activities = await call('activity.list'); assert.equal(activities.ok, true); if (activities.ok) assert.equal((activities.data as { items: unknown[] }).items.length, 6);
  const ranking = await call('ranking.list'); assert.equal(ranking.ok, true); if (ranking.ok) assert.equal((ranking.data as { items: unknown[] }).items.length, 8);
  for (const row of bundle.groups.flatMap(group => group.rows).filter(row => row.collection === 'activities' && row.data.state === 'settled')) {
    const history = await call('history.detail', { activityId: row.id }); assert.equal(history.ok, true); if (history.ok) {
      const detail = history.data as { story: { photoCount: number; honors: unknown[]; documentary: unknown }; reviews: { items: unknown[] } };
      assert.equal(detail.story.photoCount, 0); assert.deepEqual(detail.story.honors, []); assert.equal(detail.story.documentary, null); assert.deepEqual(detail.reviews.items, []);
    }
  }
  const future = bundle.groups.flatMap(group => group.rows).find(row => row.collection === 'activities' && row.data.state === 'published')!;
  const applied = await call('registration.apply', { activityId: future.id, acceptedRuleVersion: 1 }); assert.equal(applied.ok, true);
  if (applied.ok) assert.equal((applied.data as { state: string }).state, 'pending_confirmation');
  assert.equal(store.snapshot().member_stats[statsIdFor('oradv', memberId, null)], undefined);
  assert.equal(Object.values(store.snapshot().points_ledger).some((row: any) => row.memberId === memberId), false);
});

test('CLI defaults to a credential-free plan and rejects production or arbitrary targets before execution', () => {
  for (const args of [[], ['apply'], ['cleanup']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-cloud-beta.ts', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).remote, 'NOT_RUN');
  }
  for (const args of [['--env', 'production'], ['--env-id', 'another-env'], ['--app-id', 'wx1111111111111111']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-cloud-beta.ts', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /SEED_TARGET_REQUIRED/);
  }
});
