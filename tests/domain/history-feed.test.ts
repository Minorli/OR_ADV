import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../../shared/context';
import { demoSnapshot, DEMO_IDENTITIES } from '../../shared/demo';
import { MemoryStore } from '../../shared/memory-store';
import { historyFeed } from '../../shared/history-feed';
import { dispatchHistoryContent } from '../../shared/history-content';
import { key, memberIdFor, registrationIdFor, userIdFor } from '../../shared/models';
import type { Activity, Registration, TrustedIdentity } from '../../shared/types';
import type { Store } from '../../shared/store';
import type { MemberMediaAsset, MemberMediaStorage } from '../../shared/member-media-types';

const NOW = '2026-10-18T12:00:00.000Z';
function setup(count = 8) {
  const snapshot = demoSnapshot(NOW), base = snapshot.activities['intro-ride'] as Activity; snapshot.activities = {}; snapshot.registrations = {};
  for (let i = 0; i < count; i++) {
    const day = String(i % 28 + 1).padStart(2, '0'), month = i < 2 ? '09' : '10';
    const startAt = `2026-${month}-${day}T02:00:00.000Z`, endAt = `2026-${month}-${day}T08:00:00.000Z`;
    const activity: Activity = { ...base, id: `archive-${i}`, title: `Trail ${i}`, description: `Route account ${i}`, state: 'settled', startAt, endAt, actualCompletedAt: endAt,
      coverKey: 'v2-1', distanceKm: 200 + i, itinerary: [{ dayLabel: 'D1', title: '实际公布的路线分段', description: '' }] };
    snapshot.activities[activity.id] = activity;
    for (const who of [DEMO_IDENTITIES.member, DEMO_IDENTITIES.founder, DEMO_IDENTITIES.operator]) {
      const memberId = memberIdFor('oradv', userIdFor(who)), id = registrationIdFor('oradv', activity.id, memberId);
      const registration: Registration = { id, clubId: 'oradv', activityId: activity.id, memberId, state: 'completed', seatState: 'released', reviewDecision: 'approved', queueSeq: 1,
        attempt: 1, revision: 1, acceptedRuleVersion: 1, holdExpiresAt: null, settlementId: 'actual-test-source', createdAt: NOW, updatedAt: NOW };
      snapshot.registrations[id] = registration;
    }
  }
  const memory = new MemoryStore(snapshot, () => NOW); let n = 0, maxOperations = 0;
  const store: Store = { query: memory.query.bind(memory), transaction: work => memory.transaction(async tx => {
    let operations = 0;
    const count = () => { maxOperations = Math.max(maxOperations, ++operations); assert(operations <= 100, 'CloudBase transaction operation bound'); };
    return work({ get: (collection, id) => { count(); return tx.get(collection, id); }, set: (collection, id, value) => { count(); return tx.set(collection, id, value); } });
  }) };
  const media: MemberMediaStorage = { mode: 'local', saveImage: async () => { throw Error('unused'); }, remove: async () => {}, url: async () => 'https://public.example.test/opaque-asset.jpg' };
  const context = (action: string, payload: Record<string, unknown>, identity: TrustedIdentity | null = null, expectedRevision?: number, backing = store) => new Context(backing,
    { now: () => NOW, id: () => `feed-${++n}`, memberMediaStorage: media }, { action, payload, expectedRevision, clubId: 'oradv', requestId: `feed-request-${++n}` }, identity);
  const feed = (payload: Record<string, unknown> = {}, backing = store) => historyFeed(context('history.feed', payload, null, undefined, backing));
  const action = (action: string, payload: Record<string, unknown>, who = DEMO_IDENTITIES.owner, revision?: number) => dispatchHistoryContent(context(action, payload, who, revision)) as Promise<any>;
  const review = async (who: TrustedIdentity, activityId = 'archive-7') => {
    const own = await action('history.review.save', { activityId, stars: 4, comment: '经本人同意公开的活动评价', publishConsent: true, nicknameConsent: true, honorConsent: true, consentVersion: 1 }, who, 0);
    await action('staff.history.review', { activityId, reviewId: own.review.id, decision: 'approved', reason: '核实有效参加和投稿授权' }, DEMO_IDENTITIES.owner, own.revision);
    return own.review;
  };
  const story = (photoAssetIds: string[] = [], honors: any[] = [], revision = 0) => action('staff.history.save', { activityId: 'archive-7', intro: '公开回顾', photoAssetIds, honors,
    documentaryUrl: '', documentaryTitle: '', videoRightsAcknowledged: false, published: true, reason: '核实回顾和素材公开权利' }, DEMO_IDENTITIES.owner, revision);
  const photo = async (index = 0, purpose: MemberMediaAsset['purpose'] = 'club_public') => {
    const id = key('media', 'feed-photo', index), row: MemberMediaAsset = { id, clubId: 'oradv', userId: userIdFor(DEMO_IDENTITIES.owner), memberId: memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.owner)),
      kind: 'image', purpose, status: 'ready', fileId: `server-only-file-${index}`, bytes: 500, mimeType: 'image/jpeg', label: '公开活动照片', storageMode: 'local', bindings: [], rightsAcknowledged: purpose === 'club_public',
      requestDigest: 'test-source', revision: 1, createdAt: NOW, updatedAt: NOW };
    await memory.transaction(tx => tx.set('member_media', id, row)); return id;
  };
  return { memory, store, context, feed, action, review, story, photo, media, maxOperations: () => maxOperations };
}

test('history feed pages five complete cards newest first, binds filters to cursors and leaves unknown counts honest', async () => {
  const env = setup(); const first = await env.feed(); assert.equal(first.items.length, 5); assert.equal(first.items[0].activity.id, 'archive-7'); assert(first.nextCursor);
  assert(first.items.every(row => row.activity.coverKey === 'v2-1' && row.activity.distanceKm !== undefined && row.story === null && row.reviews.total === 0));
  const second = await env.feed({ cursor: first.nextCursor }); assert.equal(second.items.length, 3); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.activity.id)).size, 8);
  assert.deepEqual((await env.feed({ month: '2026-09' })).items.map(row => row.activity.id), ['archive-1', 'archive-0']);
  assert.equal((await env.feed({ query: 'TRAIL 7' })).items[0].activity.id, 'archive-7');
  assert.deepEqual((await env.feed({ query: '   ' })).items.map(row => row.activity.id), first.items.map(row => row.activity.id));
  await assert.rejects(env.feed({ cursor: first.nextCursor, month: '2026-09' }), { code: 'INVALID_INPUT' });
  await assert.rejects(env.feed({ memberId: 'private-owner' }), { code: 'INVALID_INPUT' });
  await assert.rejects(env.feed({ month: '2026-13' }), { code: 'INVALID_INPUT' });
});

test('history previews never count two rows as all reviews; withdrawal, inactive author and voided participation stop public reads', async () => {
  const env = setup(); const reviews = await Promise.all([env.review(DEMO_IDENTITIES.member), env.review(DEMO_IDENTITIES.founder), env.review(DEMO_IDENTITIES.operator)]);
  let card = (await env.feed()).items[0]; assert.equal(card.reviews.items.length, 2); assert.equal(card.reviews.total, null); assert(card.reviews.nextCursor);
  await env.action('history.review.withdraw', { activityId: 'archive-7' }, DEMO_IDENTITIES.member, reviews[0].revision + 1);
  await env.memory.transaction(async tx => {
    const uid = userIdFor(DEMO_IDENTITIES.founder), user = await tx.get<any>('users', uid); await tx.set('users', uid, { ...user, status: 'disabled' });
    const rid = registrationIdFor('oradv', 'archive-7', memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.operator))), registration = await tx.get<any>('registrations', rid);
    await tx.set('registrations', rid, { ...registration, completionVoided: true });
  });
  card = (await env.feed()).items[0]; assert.deepEqual(card.reviews.items, []); assert.equal(card.reviews.total, 0);
});

test('history cards expose only bound public images and live consenting honors within transaction operation limits', async () => {
  const env = setup(), own = await env.review(DEMO_IDENTITIES.member), other = await env.review(DEMO_IDENTITIES.founder);
  const photos: string[] = []; for (let i = 0; i < 12; i++) photos.push(await env.photo(i));
  await env.story(photos, [{ reviewPublicId: own.publicId, label: '本场协作' }, { reviewPublicId: other.publicId, label: '相互照应' }]);
  const card = (await env.feed()).items[0]; assert.equal(card.story!.photoCount, 12); assert.equal(card.story!.honors.length, 2); assert.equal(card.reviews.total, 2); assert(env.maxOperations() <= 100);
  const serialized = JSON.stringify(card);
  for (const privateValue of [...photos, 'server-only-file-', userIdFor(DEMO_IDENTITIES.member), memberIdFor('oradv', userIdFor(DEMO_IDENTITIES.member)), 'memberNumber', 'avatarFileId']) assert(!serialized.includes(privateValue));
  const privatePhoto = await env.photo(99, 'dossier'); await assert.rejects(env.story([privatePhoto], [], 1), { code: 'FORBIDDEN' });
});

test('story withdrawal while signing drops stale photos and inactive authors never reappear in feed honors', async () => {
  const env = setup(), own = await env.review(DEMO_IDENTITIES.member), photo = await env.photo(), saved = await env.story([photo], [{ reviewPublicId: own.publicId, label: '本场协作' }]);
  let changed = false;
  env.media.url = async () => {
    if (!changed) { changed = true; await env.memory.transaction(async tx => {
      await tx.set('activity_stories', saved.id, { ...saved, published: false, revision: saved.revision + 1 });
      const uid = userIdFor(DEMO_IDENTITIES.member), user = await tx.get<any>('users', uid); await tx.set('users', uid, { ...user, status: 'deletion_requested' });
    }); }
    return 'https://public.example.test/stale-signed-photo.jpg';
  };
  const feed = await env.feed(), card = feed.items[0]; assert.equal(card.story, null); assert.deepEqual(card.reviews.items, []); assert(!JSON.stringify(feed).includes('stale-signed-photo'));
});

test('sparse keyword searches stop after one hundred metadata candidates and expose continuation instead of unbounded scanning', async () => {
  const env = setup(110); let scanned = 0;
  const backing: Store = { transaction: env.store.transaction.bind(env.store), async query<T>(collection: string, filters: Record<string, unknown>, options: any) {
    const rows = await env.store.query<T>(collection, filters, options); if (collection === 'activities') scanned += rows.length; return rows;
  } };
  const before = env.memory.snapshot(), first = await env.feed({ query: 'no-matching-activity' }, backing); assert.deepEqual(first.items, []); assert(first.nextCursor); assert.equal(scanned, 100);
  const second = await env.feed({ query: 'no-matching-activity', cursor: first.nextCursor }, backing); assert.deepEqual(second.items, []); assert.equal(second.nextCursor, null); assert.equal(scanned, 110);
  assert.deepEqual(env.memory.snapshot(), before);
});
