import { Context } from './context';
import { DomainError, requireThat, text } from './errors';
import { key } from './models';
import { sha256 } from './hash';
import { validateAvatarImage } from './avatar-image';
import type { Transaction } from './store';
import type { MemberMediaAsset, MemberMediaKind, MemberMediaPurpose, MemberMediaStorage, MemberMediaStoredFile, MemberMediaSummary } from './member-media-types';
import { MEMBER_MEDIA_VIDEO_MAX_BYTES } from './member-media-types';
import { PUBLIC_CONTENT_ROLES } from './permissions';
import type { ActivityStory } from './history-content-types';
export type { MemberMediaSummary, MemberMediaStorage } from './member-media-types';

function storage(ctx: Context): MemberMediaStorage {
  const provider = (ctx.options as { memberMediaStorage?: MemberMediaStorage }).memberMediaStorage;
  if (!provider || !['cloud', 'local'].includes(provider.mode)) throw new DomainError('TEMPORARY_FAILURE', '资料存储暂不可用，请保留原文件后重试', true);
  return provider;
}
function purpose(value: unknown): MemberMediaPurpose {
  requireThat(['dossier', 'skill', 'club_public'].includes(String(value)), 'INVALID_INPUT', '请选择资料用途');
  return value as MemberMediaPurpose;
}
function summary(row: MemberMediaAsset): MemberMediaSummary {
  requireThat(row.status === 'ready' && row.fileId && Number.isSafeInteger(row.bytes) && row.bytes! > 0 && row.mimeType,
    'STATE_CONFLICT', '资料尚未保存完成，请重试');
  return { id: row.id, kind: row.kind, purpose: row.purpose, storageMode: row.storageMode, label: row.label,
    bytes: row.bytes!, mimeType: row.mimeType!, createdAt: row.createdAt };
}
async function own(ctx: Context, tx: Transaction, id: string): Promise<MemberMediaAsset> {
  const actor = await ctx.actor(tx), row = await tx.get<MemberMediaAsset>('member_media', id);
  requireThat(row?.clubId === ctx.clubId && row.memberId === actor.member.id && row.userId === actor.user.id,
    'FORBIDDEN', '无法访问这份资料');
  return row;
}
async function cleanup(ctx: Context, provider: MemberMediaStorage, fileId: string) {
  try { await provider.remove(fileId); }
  catch { ctx.options.log?.({ action: 'media.cleanup', code: 'PRIVATE_FILE_CLEANUP_PENDING' }); }
}
function storedFile(value: MemberMediaStoredFile, kind: MemberMediaKind, imageBytes?: number): void {
  requireThat(value && typeof value.fileId === 'string' && value.fileId.length > 0 && value.fileId.length <= 2000
    && Number.isSafeInteger(value.bytes) && value.bytes > 0, 'TEMPORARY_FAILURE', '资料未能保存，请保留原文件后重试');
  requireThat(kind === 'image' ? value.bytes === imageBytes && ['image/jpeg', 'image/png'].includes(value.mimeType)
    : value.bytes <= MEMBER_MEDIA_VIDEO_MAX_BYTES && ['video/mp4', 'video/quicktime'].includes(value.mimeType),
  'INVALID_INPUT', kind === 'video' ? '请选择8MB以内的MP4或MOV短片' : '图片内容无法保存，请重新选择');
}

async function save(ctx: Context, kind: MemberMediaKind): Promise<MemberMediaSummary> {
  const p = ctx.request.payload;
  requireThat(Object.keys(p).every(field => ['purpose', 'label', 'rightsAcknowledged', kind === 'image' ? 'imageBase64' : 'sourcePath'].includes(field)), 'INVALID_INPUT', '包含不支持的资料字段');
  const use = purpose(p.purpose), label = p.label === undefined ? (kind === 'image' ? '资料图片' : '练习短片') : text(p.label, '资料名称', 80);
  requireThat(kind !== 'video' || use === 'skill', 'INVALID_INPUT', '短片仅用于技能练习提交');
  const image = kind === 'image' ? validateAvatarImage(p.imageBase64) : undefined;
  const source = kind === 'image' ? p.imageBase64 as string : text(p.sourcePath, '本机短片', 1000);
  const provider = storage(ctx);
  const digest = sha256(JSON.stringify([kind, use, label, source, p.rightsAcknowledged === true]));
  const initial = await ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx);
    if (use === 'club_public') {
      await ctx.staff(tx, PUBLIC_CONTENT_ROLES);
      requireThat(p.rightsAcknowledged === true, 'INVALID_INPUT', '请确认拥有图片的公开使用权');
    }
    if (kind === 'video' && (provider.mode !== 'local' || !provider.saveVideo)) {
      throw new DomainError('MEDIA_VIDEO_UNAVAILABLE', '云端短片上传暂未开通，原片请保留在本机，稍后重试', true);
    }
    const id = key('media', ctx.clubId, actor.member.id, ctx.request.requestId);
    const previous = await tx.get<MemberMediaAsset>('member_media', id);
    if (previous) {
      requireThat(previous.memberId === actor.member.id && previous.userId === actor.user.id && previous.clubId === ctx.clubId
        && previous.requestDigest === digest && previous.storageMode === provider.mode, 'STATE_CONFLICT', '本次保存内容已改变，请重新提交');
      requireThat(previous.status !== 'cancelled', 'STATE_CONFLICT', '这份资料已取消，请重新选择');
      return previous;
    }
    const row: MemberMediaAsset = { id, clubId: ctx.clubId, memberId: actor.member.id, userId: actor.user.id, kind, purpose: use,
      label, storageMode: provider.mode, status: 'uploading', requestDigest: digest, bindings: [], rightsAcknowledged: use === 'club_public',
      revision: 1, createdAt: ctx.now, updatedAt: ctx.now };
    await tx.set('member_media', id, row);
    return row;
  });
  if (initial.status === 'ready') return summary(initial);
  let file: MemberMediaStoredFile;
  try {
    file = kind === 'image' ? await provider.saveImage(initial.memberId, initial.id, source, use) : await provider.saveVideo!(initial.memberId, initial.id, source);
    storedFile(file, kind, image?.bytes.length);
    if (image) requireThat(file.mimeType === (image.extension === 'png' ? 'image/png' : 'image/jpeg'), 'INVALID_INPUT', '图片格式不一致');
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('TEMPORARY_FAILURE', '资料保存未完成，原文件已保留，请重试', true);
  }
  // A failed transaction can have an unknown commit result. Keep its private file;
  // an identical request retry reads the committed asset instead of deleting it.
  let result: { row: MemberMediaAsset; discarded: boolean };
  try {
    result = await ctx.store.transaction(async tx => {
      if (use === 'club_public') await ctx.staff(tx, PUBLIC_CONTENT_ROLES);
      const row = await own(ctx, tx, initial.id);
      if (row.status === 'ready') return { row, discarded: row.fileId !== file.fileId };
      requireThat(row.status === 'uploading' && row.requestDigest === digest, 'STATE_CONFLICT', '资料已取消或更新，请重新选择');
      const updated: MemberMediaAsset = { ...row, status: 'ready', fileId: file.fileId, bytes: file.bytes, mimeType: file.mimeType,
        revision: row.revision + 1, updatedAt: ctx.now };
      await tx.set('member_media', row.id, updated);
      await ctx.audit(tx, await ctx.actor(tx), 'member_media', row.id, { kind, purpose: use, bytes: file.bytes, storageMode: provider.mode });
      return { row: updated, discarded: false };
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('TEMPORARY_FAILURE', '资料保存结果尚未确认，请保留原文件后重试', true);
  }
  if (result.discarded) await cleanup(ctx, provider, file.fileId);
  return summary(result.row);
}
export const saveMemberMediaImage = (ctx: Context) => save(ctx, 'image');
export const saveMemberMediaVideo = (ctx: Context) => save(ctx, 'video');

export async function requireOwnedMemberMedia(tx: Transaction, clubId: string, memberId: string, assetIds: unknown, use: MemberMediaPurpose): Promise<MemberMediaSummary[]> {
  requireThat(Array.isArray(assetIds) && assetIds.length <= 20 && new Set(assetIds).size === assetIds.length
    && assetIds.every(id => typeof id === 'string' && /^media_[a-f0-9]{64}$/.test(id)), 'INVALID_INPUT', '资料编号不正确');
  return Promise.all((assetIds as string[]).map(async id => {
    const row = await tx.get<MemberMediaAsset>('member_media', id);
    requireThat(row?.clubId === clubId && row.memberId === memberId && row.purpose === use && row.status === 'ready', 'FORBIDDEN', '资料不存在、未保存或不属于本人');
    return summary(row);
  }));
}
export async function bindOwnedMemberMedia(tx: Transaction, clubId: string, memberId: string, assetIds: unknown, use: MemberMediaPurpose, bindingId: string): Promise<MemberMediaSummary[]> {
  const result = await requireOwnedMemberMedia(tx, clubId, memberId, assetIds, use);
  requireThat(typeof bindingId === 'string' && /^[A-Za-z0-9_:-]{1,180}$/.test(bindingId), 'INVALID_INPUT', '资料引用不正确');
  for (const asset of result) {
    const row = (await tx.get<MemberMediaAsset>('member_media', asset.id))!;
    if (!row.bindings.includes(bindingId)) {
      requireThat(row.bindings.length < 100, 'STATE_CONFLICT', '资料引用过多，请重新选择');
      await tx.set('member_media', row.id, { ...row, bindings: [...row.bindings, bindingId], revision: row.revision + 1 });
    }
  }
  return result;
}
/** Editors may retain another author's image only in the story that already uses it. */
export async function bindPublicStoryMedia(tx: Transaction, clubId: string, memberId: string, assetIds: unknown, bindingId: string, previousIds: readonly string[]): Promise<MemberMediaSummary[]> {
  requireThat(Array.isArray(assetIds) && assetIds.length <= 12 && new Set(assetIds).size === assetIds.length
    && assetIds.every(id => typeof id === 'string' && /^media_[a-f0-9]{64}$/.test(id)), 'INVALID_INPUT', '活动图片编号不正确');
  const result: MemberMediaSummary[] = [];
  for (const id of assetIds) {
    const row = await tx.get<MemberMediaAsset>('member_media', id);
    requireThat(row?.clubId === clubId && row.status === 'ready' && row.kind === 'image' && row.purpose === 'club_public' && row.rightsAcknowledged
      && (row.memberId === memberId || previousIds.includes(id) && row.bindings.includes(bindingId)), 'FORBIDDEN', '仅能选用本人公开图片或保留本场已授权图片');
    if (!row.bindings.includes(bindingId)) {
      requireThat(row.bindings.length < 100, 'STATE_CONFLICT', '资料引用过多，请重新选择');
      await tx.set('member_media', id, { ...row, bindings: [...row.bindings, bindingId], revision: row.revision + 1 });
    }
    result.push(summary(row));
  }
  return result;
}
async function readOtherMedia(ctx: Context, tx: Transaction, asset: MemberMediaAsset) {
  if (asset.purpose !== 'club_public') {
    await ctx.staff(tx, ['owner']);
    requireThat(['dossier', 'skill'].includes(asset.purpose) && asset.bindings.length > 0, 'FORBIDDEN', '仅可核对已提交资料');
    return;
  }
  await ctx.staff(tx, PUBLIC_CONTENT_ROLES);
  const bindingId = ctx.request.payload.bindingId;
  requireThat(typeof bindingId === 'string' && /^activity_story_[a-f0-9]{64}$/.test(bindingId) && asset.bindings.includes(bindingId)
    && asset.kind === 'image' && asset.rightsAcknowledged, 'FORBIDDEN', '仅可管理本场已授权的公开图片');
  const story = await tx.get<ActivityStory>('activity_stories', bindingId);
  requireThat(story?.clubId === ctx.clubId && story.photoAssetIds.includes(asset.id), 'FORBIDDEN', '活动图片已移除或更新');
}
export async function getMemberMediaUrl(ctx: Context): Promise<{ asset: MemberMediaSummary; url: string }> {
  requireThat(Object.keys(ctx.request.payload).every(field => ['assetId', 'bindingId'].includes(field)), 'INVALID_INPUT', '包含不支持的资料字段');
  const id = text(ctx.request.payload.assetId, '资料编号', 100), provider = storage(ctx);
  const row = await ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx), asset = await tx.get<MemberMediaAsset>('member_media', id);
    requireThat(asset?.clubId === ctx.clubId && asset.status === 'ready' && asset.storageMode === provider.mode, 'FORBIDDEN', '无法访问这份资料');
    if (asset.memberId !== actor.member.id) {
      await readOtherMedia(ctx, tx, asset);
    }
    return asset;
  });
  let url: string;
  try { url = await provider.url(row.fileId!); }
  catch { throw new DomainError('TEMPORARY_FAILURE', '资料暂时无法打开，请重试', true); }
  await ctx.store.transaction(async tx => {
    const actor = await ctx.actor(tx), current = await tx.get<MemberMediaAsset>('member_media', row.id);
    requireThat(current?.status === 'ready' && current.fileId === row.fileId && current.purpose === row.purpose, 'FORBIDDEN', '资料已取消或更新');
    if (current.memberId !== actor.member.id) await readOtherMedia(ctx, tx, current);
  });
  return { asset: summary(row), url };
}
export async function cancelMemberMedia(ctx: Context): Promise<{ cancelled: true }> {
  requireThat(Object.keys(ctx.request.payload).every(field => field === 'assetId'), 'INVALID_INPUT', '包含不支持的资料字段');
  const id = text(ctx.request.payload.assetId, '资料编号', 100), provider = storage(ctx);
  const row = await ctx.store.transaction(async tx => {
    const row = await own(ctx, tx, id);
    requireThat(row.bindings.length === 0, 'STATE_CONFLICT', '资料已用于提交记录，无法取消');
    if (row.status !== 'cancelled') await tx.set('member_media', id, { ...row, status: 'cancelled', revision: row.revision + 1, updatedAt: ctx.now });
    return row;
  });
  if (row.fileId) await cleanup(ctx, provider, row.fileId);
  return { cancelled: true };
}
