import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../../shared/context';
import { MemoryStore } from '../../shared/memory-store';
import { demoSnapshot, DEMO_IDENTITIES } from '../../shared/demo';
import { key, memberIdFor, registrationIdFor, userIdFor } from '../../shared/models';
import { dispatchHistoryContent, validateHistoryDocumentaryUrl } from '../../shared/history-content';
import type { ActivityReview, ActivityStory, PublicHistoryDetail } from '../../shared/history-content-types';
import type { MemberMediaAsset, MemberMediaStorage } from '../../shared/member-media-types';
import type { Activity, Registration, TrustedIdentity } from '../../shared/types';
import type { Store } from '../../shared/store';

const NOW = '2026-10-18T08:00:00.000Z', ACTIVITY = 'history-one';
const memberId = (who: TrustedIdentity) => memberIdFor('oradv', userIdFor(who));
const consents = { publishConsent: true, nicknameConsent: true, honorConsent: true, consentVersion: 1 };
function registration(who: TrustedIdentity, activityId = ACTIVITY): Registration {
  const member = memberId(who);
  return { id: registrationIdFor('oradv', activityId, member), clubId: 'oradv', activityId, memberId: member, state: 'completed', seatState: 'released', reviewDecision: 'approved',
    queueSeq: 1, attempt: 1, revision: 1, acceptedRuleVersion: 1, holdExpiresAt: null, settlementId: 'test-settlement', createdAt: NOW, updatedAt: NOW };
}
function setup() {
  const snapshot = demoSnapshot(NOW), base = snapshot.activities['intro-ride'] as Activity;
  snapshot.activities[ACTIVITY] = { ...base, id: ACTIVITY, title: '已结算的演示同行', state: 'settled', startAt: '2026-10-10T02:00:00.000Z', endAt: '2026-10-10T06:00:00.000Z', actualCompletedAt: '2026-10-10T06:00:00.000Z' };
  snapshot.registrations = {};
  for (const identity of [DEMO_IDENTITIES.member, DEMO_IDENTITIES.founder]) { const row = registration(identity); snapshot.registrations[row.id] = row; }
  const store = new MemoryStore(snapshot, () => NOW); let serial = 0;
  const media: MemberMediaStorage = { mode: 'local', saveImage: async () => { throw new Error('unused'); }, remove: async () => {}, url: async () => 'https://public.example.com/authorized-public-image.jpg' };
  const call = <T = any>(action: string, payload: Record<string, unknown> = {}, identity: TrustedIdentity | null = DEMO_IDENTITIES.member, expectedRevision?: number) =>
    dispatchHistoryContent(new Context(store, { now: () => NOW, id: () => `generated-${++serial}`, memberMediaStorage: media },
      { action, payload: { activityId: ACTIVITY, ...payload }, expectedRevision, clubId: 'oradv', requestId: `history-${++serial}` }, identity)) as Promise<T>;
  const saveStory = (payload: Record<string, unknown> = {}, expectedRevision = 0, identity = DEMO_IDENTITIES.owner) => call<ActivityStory>('staff.history.save', {
    intro: '这次同行的真实记录', photoAssetIds: [], documentaryUrl: '', documentaryTitle: '', published: true, videoRightsAcknowledged: false, reason: '核对并整理本场资料', honors: [], ...payload }, identity, expectedRevision);
  const saveReview = (payload: Record<string, unknown> = {}, expectedRevision = 0, identity = DEMO_IDENTITIES.member) => call<any>('history.review.save', { stars: 4, comment: '集合清楚，回场核对及时。', ...consents, ...payload }, identity, expectedRevision);
  const approve = (review: ActivityReview) => call('staff.history.review', { reviewId: review.id, decision: 'approved', reason: '核对完整参加与公开意愿' }, DEMO_IDENTITIES.owner, review.revision);
  return { store, call, saveStory, saveReview, approve, media };
}
async function publicPhoto(ctx: ReturnType<typeof setup>, purpose: MemberMediaAsset['purpose'] = 'club_public') {
  const id = key('media', 'history-photo', purpose), owner = memberId(DEMO_IDENTITIES.owner);
  await ctx.store.transaction(tx => tx.set('member_media', id, { id, clubId: 'oradv', memberId: owner, userId: userIdFor(DEMO_IDENTITIES.owner), purpose,
    kind: 'image', status: 'ready', fileId: 'opaque-public-image', bytes: 800, mimeType: 'image/jpeg', label: '山路同行', storageMode: 'local', bindings: [],
    rightsAcknowledged: purpose === 'club_public', requestDigest: 'fixture', revision: 1, createdAt: NOW, updatedAt: NOW }));
  return id;
}

test('only complete nonvoided participants may submit consented reviews; pending text never appears publicly', async () => {
  const ctx = setup();
  await assert.rejects(ctx.saveReview({}, 0, DEMO_IDENTITIES.owner), { code: 'FORBIDDEN' });
  await assert.rejects(ctx.saveReview({ nicknameConsent: false }), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(ctx.saveReview({ memberId: memberId(DEMO_IDENTITIES.owner) }), { code: 'INVALID_INPUT' });
  const own = await ctx.saveReview(); assert.equal(own.review.status, 'pending');
  const detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.deepEqual(detail.reviews.items, []); assert.equal(detail.story, null);
  const mine = await ctx.call<any>('history.review.mine'); assert.equal(mine.review.comment, own.review.comment); assert.equal(mine.eligible, true);
  await ctx.store.transaction(async tx => { const row = registration(DEMO_IDENTITIES.founder); await tx.set('registrations', row.id, { ...row, state: 'safe_exit' }); });
  await assert.rejects(ctx.saveReview({}, 0, DEMO_IDENTITIES.founder), { code: 'FORBIDDEN' });
  await ctx.store.transaction(async tx => { const row = registration(DEMO_IDENTITIES.member); await tx.set('registrations', row.id, { ...row, completionVoided: true }); });
  await assert.rejects(ctx.saveReview({}, own.revision), { code: 'FORBIDDEN' });
});

test('moderation is owner-only and revision-bound; edits return to pending and withdrawal stops public review and honor', async () => {
  const ctx = setup(), own = await ctx.saveReview();
  await assert.rejects(ctx.call('staff.history.review', { reviewId: own.review.id, decision: 'approved', reason: '核对完成' }, DEMO_IDENTITIES.operator, own.revision), { code: 'FORBIDDEN' });
  await assert.rejects(ctx.call('staff.history.review', { reviewId: own.review.id, decision: 'approved', reason: '' }, DEMO_IDENTITIES.owner, own.revision), { code: 'INVALID_INPUT' });
  await ctx.approve(own.review);
  await ctx.saveStory({ honors: [{ reviewPublicId: own.review.publicId, label: '本场协作' }] });
  let detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.equal(detail.reviews.items.length, 1); assert.equal(detail.story!.honors.length, 1);
  assert.equal(detail.reviews.items[0].stars, 4);
  const publicJson = JSON.stringify(detail);
  for (const forbidden of [memberId(DEMO_IDENTITIES.member), userIdFor(DEMO_IDENTITIES.member), own.review.id, 'memberNumber', 'avatarFileId']) assert(!publicJson.includes(forbidden));
  const edited = await ctx.saveReview({ stars: 2, comment: '希望下次更早明确集合时间。' }, own.revision + 1);
  detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.equal(detail.reviews.items.length, 0); assert.equal(detail.story!.honors.length, 0);
  await assert.rejects(ctx.approve(own.review), { code: 'CONFLICT_REFRESH' });
  await ctx.approve(edited.review);
  const withdrawn = await ctx.call<any>('history.review.withdraw', {}, DEMO_IDENTITIES.member, edited.revision + 1); assert.equal(withdrawn.review.status, 'withdrawn');
  detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.deepEqual(detail.reviews.items, []); assert.deepEqual(detail.story!.honors, []);
  await assert.rejects(ctx.approve(withdrawn.review), { code: 'STATE_CONFLICT' });
  const unpublished = await ctx.saveStory({ published: false, honors: [{ reviewPublicId: own.review.publicId, label: '本场协作' }] }, 1);
  assert.equal(unpublished.published, false);
  await assert.rejects(ctx.saveStory({ honors: unpublished.honors }, unpublished.revision), { code: 'CONSENT_REQUIRED' });
});

test('public author names and honors follow current profile, consent, account status and completion validity', async () => {
  const ctx = setup(), own = await ctx.saveReview(); await ctx.approve(own.review);
  await ctx.saveStory({ honors: [{ reviewPublicId: own.review.publicId, label: '本场协作' }] });
  const uid = userIdFor(DEMO_IDENTITIES.member), mid = memberId(DEMO_IDENTITIES.member);
  await ctx.store.transaction(async tx => { const member = (await tx.get<any>('memberships', mid))!; await tx.set('memberships', mid, { ...member, nickname: '后来改的昵称' }); });
  let detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.equal(detail.reviews.items[0].nickname, '后来改的昵称'); assert.equal(detail.story!.honors[0].nickname, '后来改的昵称');
  for (const status of ['disabled', 'deletion_requested', 'deleted']) {
    await ctx.store.transaction(async tx => { const user = (await tx.get<any>('users', uid))!; await tx.set('users', uid, { ...user, status }); });
    detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.deepEqual(detail.reviews.items, []); assert.deepEqual(detail.story!.honors, []);
  }
  await ctx.store.transaction(async tx => { const user = (await tx.get<any>('users', uid))!; await tx.set('users', uid, { ...user, status: 'active' }); const row = registration(DEMO_IDENTITIES.member); await tx.set('registrations', row.id, { ...row, completionVoided: true }); });
  detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.deepEqual(detail.reviews.items, []); assert.deepEqual(detail.story!.honors, []);
});

test('story publishes only verified own public-purpose images, actual gallery counts and approved consenting honors', async () => {
  const ctx = setup(), image = await publicPhoto(ctx), privateImage = await publicPhoto(ctx, 'dossier');
  await assert.rejects(ctx.saveStory({ photoAssetIds: [privateImage] }), { code: 'FORBIDDEN' });
  await assert.rejects(ctx.saveStory({ photoAssetIds: ['cloud://arbitrary/path'] }), { code: 'INVALID_INPUT' });
  await assert.rejects(ctx.saveStory({}, 0, DEMO_IDENTITIES.operator), { code: 'FORBIDDEN' });
  const own = await ctx.saveReview({ honorConsent: false }); await ctx.approve(own.review);
  await assert.rejects(ctx.saveStory({ honors: [{ reviewPublicId: own.review.publicId, label: '本场协作' }] }), { code: 'CONSENT_REQUIRED' });
  const story = await ctx.saveStory({ photoAssetIds: [image], documentaryUrl: 'https://films.example.com/rides/one.mp4', documentaryTitle: '本场短片', videoRightsAcknowledged: true });
  const row = ctx.store.snapshot().member_media[image] as MemberMediaAsset; assert(row.bindings.includes(story.id));
  let detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.equal(detail.story!.photos.length, 1); assert.equal(detail.story!.photoCount, 1); assert.equal(detail.story!.documentary!.title, '本场短片');
  assert(!JSON.stringify(detail).includes(image)); assert(!JSON.stringify(detail).includes(row.fileId!));
  ctx.media.url = async () => { throw new Error('private signed-token'); };
  detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.equal(detail.story!.photoCount, 0); assert.deepEqual(detail.story!.photos, []);
  await ctx.saveStory({ published: false, photoAssetIds: [image] }, story.revision);
  detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null); assert.equal(detail.story, null);
});

test('story edit or asset rights withdrawal during URL signing cannot leak stale published photos', async () => {
  for (const mode of ['unpublish', 'rights']) {
    const ctx = setup(), image = await publicPhoto(ctx), story = await ctx.saveStory({ photoAssetIds: [image] });
    ctx.media.url = async () => {
      await ctx.store.transaction(async tx => {
        if (mode === 'unpublish') await tx.set('activity_stories', story.id, { ...story, published: false, revision: story.revision + 1 });
        else { const row = (await tx.get<any>('member_media', image))!; await tx.set('member_media', image, { ...row, rightsAcknowledged: false }); }
      });
      return 'https://public.example.com/revoked-image.jpg';
    };
    const detail = await ctx.call<PublicHistoryDetail>('history.detail', {}, null);
    if (mode === 'unpublish') assert.equal(detail.story, null); else assert.equal(detail.story!.photoCount, 0);
    assert(!JSON.stringify(detail).includes('revoked-image'));
  }
});

test('documentary links reject credentials, IPs, query secrets, wrong protocols, traversal and fake schemes', () => {
  assert.equal(validateHistoryDocumentaryUrl(''), ''); assert.equal(validateHistoryDocumentaryUrl('https://video.example.com/ride.mp4'), 'https://video.example.com/ride.mp4');
  for (const url of ['http://video.example.com/ride.mp4', 'https://user:password@video.example.com/ride.mp4', 'https://127.0.0.1/ride.mp4', 'https://[::1]/ride.mp4', 'https://video.local/ride.mp4', 'https://video.example.com/ride.mp4?token=secret', 'https://video.example.com/ride.mp4#token', 'https://video.example.com/../secret.mp4', 'https://video.example.com/%2e%2e/secret.mp4', 'https://video.example.com/%GG/secret.mp4', 'https://video.example.com/%2fsecret.mp4', 'javascript:alert(1)', 'https://video.example.com/ride.html']) assert.throws(() => validateHistoryDocumentaryUrl(url), { code: 'INVALID_INPUT' });
});

test('public review pagination is bounded, privacy-safe and continues past hidden authors without duplication', async () => {
  const ctx = setup();
  await ctx.store.transaction(async tx => {
    for (let index = 0; index < 26; index++) {
      const who = { appId: 'fictional-app', openId: `history-${index}` }, uid = userIdFor(who), mid = memberId(who), publicId = key('review_public', index), id = key('activity_review', 'oradv', ACTIVITY, mid);
      await tx.set('users', uid, { id: uid, clubId: 'oradv', status: index === 0 ? 'deleted' : 'active' });
      await tx.set('memberships', mid, { id: mid, clubId: 'oradv', userId: uid, nickname: `演示评价者${index}` });
      const reg = registration(who); await tx.set('registrations', reg.id, reg);
      const row: ActivityReview = { id, clubId: 'oradv', activityId: ACTIVITY, memberId: mid, userId: uid, publicId, stars: 3, comment: `这是一条已确认参加的演示记录${index}`, ...consents,
        status: 'approved', revision: 1, reason: '', reviewedBy: 'trusted-fixture', reviewedAt: NOW, publicSort: `${NOW}|${publicId}`, createdAt: NOW, updatedAt: NOW };
      await tx.set('activity_reviews', id, row);
    }
  });
  const seen: string[] = []; let next: string | null = null, pages = 0;
  do {
    const detail: PublicHistoryDetail = await ctx.call<PublicHistoryDetail>('history.detail', next ? { cursor: next } : {}, null);
    assert(detail.reviews.items.length <= 12); seen.push(...detail.reviews.items.map(row => row.publicId)); next = detail.reviews.nextCursor;
    if (next) { assert(!next.includes('activity_review_')); assert(!next.includes('member_')); }
    assert(++pages <= 3);
  } while (next);
  assert.equal(seen.length, 25); assert.equal(new Set(seen).size, 25);
  await assert.rejects(ctx.call('history.detail', { activityId: 'draft-ride' }, null), { code: 'ACTIVITY_NOT_FOUND' });
  const templateId = await publicPhoto(ctx), template = ctx.store.snapshot().member_media[templateId] as MemberMediaAsset;
  const photoIds = Array.from({ length: 12 }, (_, index) => key('media', 'budget', index));
  await ctx.store.transaction(async tx => { for (const id of photoIds) await tx.set('member_media', id, { ...template, id }); });
  await ctx.saveStory({ photoAssetIds: photoIds, honors: [{ reviewPublicId: key('review_public', 1), label: '本场协作' }, { reviewPublicId: key('review_public', 2), label: '本场互助' }] });
  let maximumReads = 0;
  const bounded: Store = { query: ctx.store.query.bind(ctx.store), transaction: work => ctx.store.transaction(async tx => {
    let reads = 0;
    const result = await work({ get: async <T>(collection: string, id: string) => { assert(++reads <= 100, 'public transaction must fit CloudBase document budget'); return tx.get<T>(collection, id); }, set: async () => { assert.fail('public history must not write data'); } });
    maximumReads = Math.max(maximumReads, reads); return result;
  }) };
  const full = await dispatchHistoryContent(new Context(bounded, { now: () => NOW, memberMediaStorage: ctx.media }, { action: 'history.detail', payload: { activityId: ACTIVITY }, clubId: 'oradv', requestId: 'full-budget' }, null)) as PublicHistoryDetail;
  assert.equal(full.story!.photoCount, 12); assert.equal(full.story!.honors.length, 2); assert(full.reviews.items.length >= 11); assert(maximumReads <= 100);
});

test('withdrawal versus approval has one revision-bound winner and never republishes withdrawn text', async () => {
  const ctx = setup(), own = await ctx.saveReview();
  const results = await Promise.allSettled([ctx.call('history.review.withdraw', {}, DEMO_IDENTITIES.member, own.revision), ctx.approve(own.review)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual((await ctx.call<PublicHistoryDetail>('history.detail', {}, null)).reviews.items, []);
});
