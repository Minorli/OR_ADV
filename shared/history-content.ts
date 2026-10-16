import { validatePublicVideoUrl as validateHistoryDocumentaryUrl } from './public-video-url';
import { Context } from './context';
import { DomainError, integer, requireThat, text } from './errors';
import { key, registrationIdFor } from './models';
import type { Membership, User } from './models';
import type { Activity, Registration } from './types';
import type { Transaction } from './store';
import { bindPublicStoryMedia } from './member-media';
import { PUBLIC_CONTENT_ROLES } from './permissions';
import type { MemberMediaAsset } from './member-media-types';
import { HISTORY_REVIEW_CONSENT_VERSION } from './history-content-types';
import type { ActivityReview, ActivityStory, HistoryHonor, OwnHistoryReview, PublicActivityReview, PublicHistoryDetail, StaffHistoryReview } from './history-content-types';
export const HISTORY_CONTENT_ACTIONS = ['history.detail', 'history.review.mine', 'history.review.save', 'history.review.withdraw', 'staff.history.get', 'staff.history.save', 'staff.history.reviews', 'staff.history.review'] as const;
// Live author/consent/participation checks plus 12 photos and two honors stay
// below CloudBase's 100 document operations per transaction.
const PUBLIC_REVIEW_PAGE_SIZE = 12;
const storyId = (ctx: Context, activityId: string) => key('activity_story', ctx.clubId, activityId);
const reviewId = (ctx: Context, activityId: string, memberId: string) => key('activity_review', ctx.clubId, activityId, memberId);
function fields(ctx: Context, allowed: string[]) { requireThat(Object.keys(ctx.request.payload).every(field => allowed.includes(field)), 'INVALID_INPUT', '包含不支持的往期资料字段'); }
async function activity(ctx: Context, tx: Transaction): Promise<Activity> {
  const row = await ctx.activity(tx, ctx.request.payload.activityId);
  requireThat(row.state === 'settled', 'ACTIVITY_NOT_FOUND', '这场活动尚未开放往期记录');
  return row;
}
async function participant(ctx: Context, tx: Transaction, activityId: string, memberId: string) {
  const row = await tx.get<Registration>('registrations', registrationIdFor(ctx.clubId, activityId, memberId));
  return !!row && row.clubId === ctx.clubId && row.activityId === activityId && row.memberId === memberId && row.state === 'completed' && !row.completionVoided;
}
function blankStory(ctx: Context, id: string): ActivityStory {
  return { id: storyId(ctx, id), clubId: ctx.clubId, activityId: id, intro: '', photoAssetIds: [], documentaryUrl: '', documentaryTitle: '', videoRightsAcknowledged: false,
    honors: [], published: false, revision: 0, updatedBy: '', createdAt: ctx.now, updatedAt: ctx.now };
}
export { validatePublicVideoUrl as validateHistoryDocumentaryUrl } from './public-video-url';

async function visibleReview(ctx: Context, tx: Transaction, row: ActivityReview | null): Promise<{ row: ActivityReview; member: Membership } | null> {
  if (!row || row.clubId !== ctx.clubId || row.status !== 'approved' || !row.publishConsent || !row.nicknameConsent || row.consentVersion !== HISTORY_REVIEW_CONSENT_VERSION) return null;
  const member = await tx.get<Membership>('memberships', row.memberId), user = await tx.get<User>('users', row.userId);
  if (!member || member.clubId !== ctx.clubId || member.userId !== row.userId || !user || user.status !== 'active' || user.clubId !== ctx.clubId
    || !await participant(ctx, tx, row.activityId, member.id)) return null;
  return { row, member };
}
async function findPublicReview(ctx: Context, activityId: string, publicId: string): Promise<ActivityReview | null> {
  const rows = await ctx.store.query<ActivityReview>('activity_reviews', { clubId: ctx.clubId, activityId, publicId }, { limit: 2 });
  requireThat(rows.length <= 1, 'STATE_CONFLICT', '评价公开标识重复，请联系主理人');
  return rows[0] ?? null;
}
function cursor(ctx: Context): { value: string; id: string } | undefined {
  if (!ctx.request.payload.cursor) return undefined;
  const decoded = text(ctx.request.payload.cursor, '分页位置', 300);
  requireThat(/^\d{4}-\d{2}-\d{2}T[^|]{10,30}\|review_public_[a-f0-9]{64}$/.test(decoded), 'INVALID_INPUT', '分页位置不正确');
  return { value: decoded, id: '~' };
}

export async function historyDetail(ctx: Context, reviewPageSize = PUBLIC_REVIEW_PAGE_SIZE): Promise<PublicHistoryDetail> {
  requireThat(reviewPageSize === 2 || reviewPageSize === PUBLIC_REVIEW_PAGE_SIZE, 'INVALID_INPUT', '评价分页不正确');
  fields(ctx, ['activityId', 'cursor']);
  const initial = await ctx.store.transaction(async tx => { const a = await activity(ctx, tx); return { activity: a, story: await tx.get<ActivityStory>('activity_stories', storyId(ctx, a.id)) }; });
  const candidates = await ctx.store.query<ActivityReview>('activity_reviews', { clubId: ctx.clubId, activityId: initial.activity.id, status: 'approved', publishConsent: true, nicknameConsent: true }, { orderBy: 'publicSort', direction: 'desc', after: cursor(ctx), limit: reviewPageSize + 1 });
  const page = candidates.slice(0, reviewPageSize), honorRows = initial.story?.published ? await Promise.all(initial.story.honors.map(honor => findPublicReview(ctx, initial.activity.id, honor.reviewPublicId))) : [];
  const photoRows = initial.story?.published ? await ctx.store.transaction(async tx => {
    const rows: MemberMediaAsset[] = [];
    for (const id of initial.story!.photoAssetIds) {
      const row = await tx.get<MemberMediaAsset>('member_media', id);
      if (row?.clubId === ctx.clubId && row.status === 'ready' && row.kind === 'image' && row.purpose === 'club_public' && row.rightsAcknowledged
        && row.bindings.includes(initial.story!.id) && row.fileId && (await tx.get<User>('users', row.userId))?.status === 'active') rows.push(row);
    }
    return rows;
  }) : [];
  const provider = ctx.options.memberMediaStorage;
  const urls = await Promise.all(photoRows.map(async row => {
    if (!provider || provider.mode !== row.storageMode) return null;
    try { return { id: row.id, fileId: row.fileId, url: await provider.url(row.fileId!), label: row.label }; }
    catch { return null; }
  }));
  return ctx.store.transaction(async tx => {
    const a = await activity(ctx, tx), current = await tx.get<ActivityStory>('activity_stories', storyId(ctx, a.id));
    const reviews: PublicActivityReview[] = [];
    for (const candidate of page) {
      const value = await visibleReview(ctx, tx, await tx.get<ActivityReview>('activity_reviews', candidate.id));
      if (value && value.row.activityId === a.id) reviews.push({ publicId: value.row.publicId, nickname: value.member.nickname, stars: value.row.stars, comment: value.row.comment, createdAt: value.row.createdAt });
    }
    let story: PublicHistoryDetail['story'] = null;
    if (current?.published && current.revision === initial.story?.revision) {
      const photos: { url: string; label: string }[] = [];
      for (const value of urls) {
        if (!value) continue;
        const row = await tx.get<MemberMediaAsset>('member_media', value.id);
        if (row?.status === 'ready' && row.fileId === value.fileId && current.photoAssetIds.includes(row.id) && row.purpose === 'club_public'
          && row.rightsAcknowledged && row.bindings.includes(current.id) && (await tx.get<User>('users', row.userId))?.status === 'active') photos.push({ url: value.url, label: value.label });
      }
      const honors: { nickname: string; label: string }[] = [];
      for (let index = 0; index < honorRows.length; index++) {
        const value = honorRows[index] && await visibleReview(ctx, tx, await tx.get<ActivityReview>('activity_reviews', honorRows[index]!.id));
        if (value?.row.honorConsent && value.row.activityId === a.id && current.honors[index]?.reviewPublicId === value.row.publicId) honors.push({ nickname: value.member.nickname, label: current.honors[index].label });
      }
      story = { intro: current.intro, photos, photoCount: photos.length, documentary: current.documentaryUrl && current.videoRightsAcknowledged ? { url: validateHistoryDocumentaryUrl(current.documentaryUrl), title: current.documentaryTitle } : null, honors };
    }
    return { activity: { id: a.id, title: a.title, description: a.description, location: a.location, difficulty: a.difficulty, startAt: a.startAt, endAt: a.endAt, actualCompletedAt: a.actualCompletedAt,
      ...(a.coverKey !== undefined ? { coverKey: a.coverKey } : {}), ...(a.distanceKm !== undefined ? { distanceKm: a.distanceKm } : {}), ...(a.itinerary !== undefined ? { itinerary: a.itinerary } : {}), fixtureOnly: a.fixtureOnly ?? false }, story,
      reviews: { items: reviews, nextCursor: candidates.length > reviewPageSize && page.length ? page[page.length - 1].publicSort : null } };
  });
}

export async function ownHistoryReview(ctx: Context): Promise<OwnHistoryReview> {
  fields(ctx, ['activityId']);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx), a = await activity(ctx, tx), row = await tx.get<ActivityReview>('activity_reviews', reviewId(ctx, a.id, actor.member.id));
    return { eligible: await participant(ctx, tx, a.id, actor.member.id), review: row, revision: row?.revision ?? 0 };
  });
}
export async function saveHistoryReview(ctx: Context): Promise<OwnHistoryReview> {
  fields(ctx, ['activityId', 'stars', 'comment', 'publishConsent', 'nicknameConsent', 'honorConsent', 'consentVersion']);
  const p = ctx.request.payload, stars = integer(p.stars, '星级', 1), comment = text(p.comment, '同行评价', 800);
  requireThat(stars <= 5, 'INVALID_INPUT', '星级须在1至5之间');
  requireThat(p.publishConsent === true && p.nicknameConsent === true && typeof p.honorConsent === 'boolean'
    && p.consentVersion === HISTORY_REVIEW_CONSENT_VERSION, 'CONSENT_REQUIRED', '请确认公开评价与昵称的说明，并单独选择荣誉展示');
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx), a = await activity(ctx, tx);
    requireThat(await participant(ctx, tx, a.id, actor.member.id), 'FORBIDDEN', '仅完整参加且记录有效的车友可评价');
    const id = reviewId(ctx, a.id, actor.member.id), prior = await tx.get<ActivityReview>('activity_reviews', id);
    ctx.revision(prior ?? { revision: 0 });
    const publicId = prior?.publicId ?? key('review_public', ctx.id());
    const row: ActivityReview = { id, clubId: ctx.clubId, activityId: a.id, memberId: actor.member.id, userId: actor.user.id, publicId,
      stars, comment, publishConsent: true, nicknameConsent: true, honorConsent: p.honorConsent as boolean, consentVersion: HISTORY_REVIEW_CONSENT_VERSION,
      status: 'pending', reason: '', reviewedAt: null, reviewedBy: null, publicSort: `${ctx.now}|${publicId}`, revision: (prior?.revision ?? 0) + 1, createdAt: prior?.createdAt ?? ctx.now, updatedAt: ctx.now };
    await tx.set('activity_reviews', id, row); await ctx.audit(tx, actor, 'activity_review', id, { status: 'pending', revision: row.revision });
    return { eligible: true, review: row, revision: row.revision };
  });
}
export async function withdrawHistoryReview(ctx: Context): Promise<OwnHistoryReview> {
  fields(ctx, ['activityId']);
  return ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx), a = await activity(ctx, tx), id = reviewId(ctx, a.id, actor.member.id), prior = await tx.get<ActivityReview>('activity_reviews', id);
    requireThat(prior?.memberId === actor.member.id, 'STATE_CONFLICT', '尚无可撤回的评价'); ctx.revision(prior);
    const row: ActivityReview = { ...prior, status: 'withdrawn', publishConsent: false, nicknameConsent: false, honorConsent: false, revision: prior.revision + 1, updatedAt: ctx.now };
    await tx.set('activity_reviews', id, row); await ctx.audit(tx, actor, 'activity_review', id, { status: row.status, revision: row.revision });
    return { eligible: await participant(ctx, tx, a.id, actor.member.id), review: row, revision: row.revision };
  });
}
export async function staffHistoryGet(ctx: Context): Promise<ActivityStory> {
  fields(ctx, ['activityId']);
  return ctx.store.transaction(async tx => { await ctx.staff(tx, PUBLIC_CONTENT_ROLES); const a = await activity(ctx, tx); return await tx.get<ActivityStory>('activity_stories', storyId(ctx, a.id)) ?? blankStory(ctx, a.id); });
}
export async function staffHistorySave(ctx: Context): Promise<ActivityStory> {
  fields(ctx, ['activityId', 'intro', 'photoAssetIds', 'documentaryUrl', 'documentaryTitle', 'published', 'videoRightsAcknowledged', 'reason', 'honors']);
  const p = ctx.request.payload, id = text(p.activityId, '活动编号', 100), video = validateHistoryDocumentaryUrl(p.documentaryUrl);
  requireThat(typeof p.published === 'boolean' && typeof p.videoRightsAcknowledged === 'boolean', 'INVALID_INPUT', '请确认发布与影片使用权选项');
  requireThat(!video || p.videoRightsAcknowledged === true, 'CONSENT_REQUIRED', '请确认纪录片为可公开播放的授权影片');
  const intro = p.intro === '' ? '' : text(p.intro, '活动回顾', 4000), reason = text(p.reason, '修改说明', 500);
  const title = video ? text(p.documentaryTitle, '纪录片名称', 80) : '';
  requireThat(Array.isArray(p.photoAssetIds) && p.photoAssetIds.length <= 12 && Array.isArray(p.honors) && p.honors.length <= 2, 'INVALID_INPUT', '最多发布12张图片与2个荣誉标签');
  const honors: HistoryHonor[] = p.honors.map(value => {
    requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['reviewPublicId', 'label'].includes(key)), 'INVALID_INPUT', '荣誉标签格式不正确');
    return { reviewPublicId: text(value.reviewPublicId, '评价标识', 100), label: text(value.label, '荣誉名称', 30) };
  });
  await ctx.store.transaction(tx => ctx.staff(tx, PUBLIC_CONTENT_ROLES));
  const honorRows = await Promise.all(honors.map(honor => findPublicReview(ctx, id, honor.reviewPublicId)));
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, PUBLIC_CONTENT_ROLES), a = await activity(ctx, tx), previous = await tx.get<ActivityStory>('activity_stories', storyId(ctx, a.id));
    ctx.revision(previous ?? { revision: 0 });
    const assets = await bindPublicStoryMedia(tx, ctx.clubId, actor.member.id, p.photoAssetIds, storyId(ctx, a.id), previous?.photoAssetIds ?? []);
    if (p.published === true) for (const row of honorRows) {
      const live = row && await visibleReview(ctx, tx, await tx.get<ActivityReview>('activity_reviews', row.id));
      requireThat(live?.row.honorConsent && live.row.activityId === a.id, 'CONSENT_REQUIRED', '荣誉需选择同意展示的已发布评价作者');
    }
    const row: ActivityStory = { ...(previous ?? blankStory(ctx, a.id)), intro, photoAssetIds: assets.map(asset => asset.id), documentaryUrl: video,
      documentaryTitle: title, videoRightsAcknowledged: p.videoRightsAcknowledged as boolean, honors, published: p.published as boolean,
      revision: (previous?.revision ?? 0) + 1, updatedBy: actor.user.id, updatedAt: ctx.now };
    await tx.set('activity_stories', row.id, row); await ctx.audit(tx, actor, 'activity_story', row.id, { published: row.published, photoCount: row.photoAssetIds.length, revision: row.revision }, reason);
    return row;
  });
}
export async function staffHistoryReviews(ctx: Context): Promise<{ items: StaffHistoryReview[]; nextCursor: string | null }> {
  fields(ctx, ['activityId', 'cursor']);
  const id = await ctx.store.transaction(async tx => { await ctx.staff(tx, PUBLIC_CONTENT_ROLES); return (await activity(ctx, tx)).id; });
  const after = ctx.request.payload.cursor ? { value: text(ctx.request.payload.cursor, '分页位置', 100), id: text(ctx.request.payload.cursor, '分页位置', 100) } : undefined;
  const rows = await ctx.store.query<ActivityReview>('activity_reviews', { clubId: ctx.clubId, activityId: id }, { limit: 21, after });
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, PUBLIC_CONTENT_ROLES), owner = (await ctx.roles(tx, actor)).some(role => role.role === 'owner');
    const items: StaffHistoryReview[] = [];
    for (const candidate of rows.slice(0, 20)) {
      const row = await tx.get<ActivityReview>('activity_reviews', candidate.id);
      if (!row || row.clubId !== ctx.clubId || row.activityId !== id) continue;
      const member = owner ? await tx.get<Membership>('memberships', row.memberId) : await consentingSubmission(ctx, tx, row);
      if (!owner && !member) continue;
      items.push({ id: row.id, publicId: row.publicId, nickname: member?.nickname ?? '已离开的车友', stars: row.stars, comment: row.comment, honorConsent: row.honorConsent, status: row.status, revision: row.revision, reason: row.reason });
    }
    return { items, nextCursor: rows.length > 20 ? rows[19].id : null };
  });
}
async function consentingSubmission(ctx: Context, tx: Transaction, row: ActivityReview): Promise<Membership | null> {
  if (row.status === 'withdrawn' || !row.publishConsent || !row.nicknameConsent || row.consentVersion !== HISTORY_REVIEW_CONSENT_VERSION) return null;
  const member = await tx.get<Membership>('memberships', row.memberId), user = await tx.get<User>('users', row.userId);
  return member?.clubId === ctx.clubId && member.userId === row.userId && user?.status === 'active' && user.clubId === ctx.clubId
    && await participant(ctx, tx, row.activityId, row.memberId) ? member : null;
}
export async function staffHistoryReview(ctx: Context): Promise<StaffHistoryReview> {
  fields(ctx, ['activityId', 'reviewId', 'decision', 'reason']);
  const p = ctx.request.payload, reason = text(p.reason, '核对说明', 500);
  requireThat(['approved', 'rejected'].includes(String(p.decision)), 'INVALID_INPUT', '请选择评价处理结果');
  return ctx.store.transaction(async tx => {
    const actor = await ctx.staff(tx, PUBLIC_CONTENT_ROLES), a = await activity(ctx, tx), row = await tx.get<ActivityReview>('activity_reviews', text(p.reviewId, '评价编号', 100));
    requireThat(row?.clubId === ctx.clubId && row.activityId === a.id && row.status !== 'withdrawn', 'STATE_CONFLICT', '评价已撤回或不可处理'); ctx.revision(row);
    const owner = (await ctx.roles(tx, actor)).some(role => role.role === 'owner');
    if (!owner) requireThat(await consentingSubmission(ctx, tx, row), 'FORBIDDEN', '这条投稿已不再授权内容管理');
    if (p.decision === 'approved') {
      const author = await tx.get<User>('users', row.userId);
      requireThat(author?.status === 'active' && row.publishConsent && row.nicknameConsent && await participant(ctx, tx, a.id, row.memberId), 'CONSENT_REQUIRED', '作者或参加记录已失效，不能发布');
    }
    const updated: ActivityReview = { ...row, status: p.decision as 'approved' | 'rejected', reason, reviewedBy: actor.user.id, reviewedAt: ctx.now, revision: row.revision + 1, updatedAt: ctx.now };
    await tx.set('activity_reviews', row.id, updated); await ctx.audit(tx, actor, 'activity_review', row.id, { status: updated.status, revision: updated.revision }, reason);
    const member = await tx.get<Membership>('memberships', row.memberId);
    return { id: row.id, publicId: row.publicId, nickname: member?.nickname ?? '已离开的车友', stars: row.stars, comment: row.comment, honorConsent: row.honorConsent, status: updated.status, revision: updated.revision, reason };
  });
}
export async function dispatchHistoryContent(ctx: Context): Promise<unknown> {
  switch (ctx.request.action) {
    case 'history.detail': return historyDetail(ctx);
    case 'history.review.mine': return ownHistoryReview(ctx);
    case 'history.review.save': return saveHistoryReview(ctx);
    case 'history.review.withdraw': return withdrawHistoryReview(ctx);
    case 'staff.history.get': return staffHistoryGet(ctx);
    case 'staff.history.save': return staffHistorySave(ctx);
    case 'staff.history.reviews': return staffHistoryReviews(ctx);
    case 'staff.history.review': return staffHistoryReview(ctx);
    default: throw new DomainError('INVALID_INPUT', '未知往期资料操作');
  }
}
