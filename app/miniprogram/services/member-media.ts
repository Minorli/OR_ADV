import { call, currentMember, isMock, runtime } from '../services/api';
import { validateAvatarImage } from '../../../shared/avatar-image';
import { MEMBER_MEDIA_VIDEO_MAX_BYTES } from '../../../shared/member-media-types';
import type { MemberMediaPurpose, MemberMediaSummary } from '../../../shared/member-media-types';
import { allDrafts, clearMockMemberMediaFiles, createLocalMemberMediaStorage, createMockMemberMediaStorage, DRAFTS_KEY, MemberMediaError } from './member-media-local';
import type { MemberMediaDraft } from './member-media-local';

export { clearMockMemberMediaFiles, createLocalMemberMediaStorage, createMockMemberMediaStorage, MemberMediaError };
export type { MemberMediaDraft };

async function activeMember(id: string) {
  if ((await currentMember())?.id !== id) throw new MemberMediaError('STALE_IDENTITY', '当前身份已改变，请重新打开资料页面');
}
export const resolveMemberMedia = (assetId: string) => call<{ asset: MemberMediaSummary; url: string }>('media.get', { assetId });
export async function chooseAndUploadMemberImage(purpose: MemberMediaPurpose, label: string, rightsAcknowledged = false, sourceType: ('album' | 'camera')[] = ['album', 'camera']): Promise<{ assetId: string; previewUrl: string }> {
  const member = await currentMember();
  if (!member) throw new MemberMediaError('UNAUTHENTICATED', '请先登录后选择图片');
  const choice = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType, sizeType: ['compressed'] });
  const original = choice.tempFiles[0]?.tempFilePath;
  if (!original) throw new MemberMediaError('CANCELLED', '未选择图片');
  const info = await wx.getImageInfo({ src: original });
  if (!(info.width > 0 && info.height > 0)) throw new MemberMediaError('INVALID_INPUT', '无法读取这张图片，请重新选择');
  const fs = wx.getFileSystemManager();
  let compressedPath = '';
  for (const [maximum, quality] of [[1024, 65], [768, 60], [512, 55], [256, 45], [192, 40]]) {
    const ratio = Math.min(1, maximum / Math.max(info.width, info.height));
    const image = await wx.compressImage({ src: original, quality, compressedWidth: Math.max(1, Math.round(info.width * ratio)), compressedHeight: Math.max(1, Math.round(info.height * ratio)) });
    const stat = fs.statSync(image.tempFilePath);
    if (Array.isArray(stat) || stat.size <= 0) throw new MemberMediaError('INVALID_INPUT', '无法读取压缩后的图片');
    if (stat.size <= 65_536) {
      try { validateAvatarImage(fs.readFileSync(image.tempFilePath, 'base64')); compressedPath = image.tempFilePath; break; }
      catch { /* Keep stepping down if dimensions still exceed bounds. */ }
    }
  }
  if (!compressedPath) throw new MemberMediaError('INVALID_INPUT', '图片压缩后仍超过64KB，请换一张较简单的图片');
  await activeMember(member.id);
  const draft = await keepDraft(member.id, purpose, 'image', label, compressedPath, rightsAcknowledged);
  return retryMemberMediaDraft(draft.id);
}
type DraftScope = { scope: 'mock' } | { scope: 'cloud'; appId: string; envId: string };
function currentDraftScope(): DraftScope {
  if (isMock) return { scope: 'mock' };
  if (!/^wx[a-fA-F0-9]{16}$/.test(runtime.appId) || !/^[a-zA-Z0-9_-]{5,100}$/.test(runtime.envId)) {
    throw new MemberMediaError('MEDIA_ENVIRONMENT_REQUIRED', '当前云环境配置不完整，本机草稿未上传，请重新打开小程序');
  }
  return { scope: 'cloud', appId: runtime.appId, envId: runtime.envId };
}
function matchesScope(draft: MemberMediaDraft, scope: DraftScope): boolean {
  return draft.scope === scope.scope && (scope.scope === 'mock' || draft.appId === scope.appId && draft.envId === scope.envId);
}
/** Checking for absence exposes no draft contents and needs no cloud identity. */
export function hasMemberMediaDrafts(): boolean {
  const scope = currentDraftScope();
  return allDrafts().some(item => matchesScope(item, scope));
}
export async function memberMediaDrafts(): Promise<MemberMediaDraft[]> {
  const scope = currentDraftScope();
  const candidates = allDrafts().filter(item => matchesScope(item, scope));
  if (!candidates.length) return [];
  const member = await currentMember();
  return member ? candidates.filter(item => item.memberId === member.id) : [];
}
export async function discardMemberMediaDraft(draftId: string): Promise<void> {
  const scope = currentDraftScope();
  const member = await currentMember(), draft = allDrafts().find(item => item.id === draftId && item.memberId === member?.id && matchesScope(item, scope));
  if (!member || !draft) throw new MemberMediaError('FORBIDDEN', '无法访问这份本机草稿');
  try {
    await new Promise<void>((resolve, reject) => wx.getFileSystemManager().removeSavedFile({ filePath: draft.localPath,
      success: () => resolve(), fail: reject }));
    wx.setStorageSync(DRAFTS_KEY, allDrafts().filter(item => item.id !== draftId));
  } catch { throw new MemberMediaError('LOCAL_DRAFT_DELETE_FAILED', '本机草稿未能删除，请重试', draftId); }
}
async function keepDraft(memberId: string, purpose: MemberMediaPurpose, kind: 'image' | 'video', label: string, sourcePath: string, rightsAcknowledged = false): Promise<MemberMediaDraft> {
  const prior = allDrafts(), scope = currentDraftScope();
  if (prior.filter(item => item.memberId === memberId && matchesScope(item, scope)).length >= 8) throw new MemberMediaError('LOCAL_DRAFT_LIMIT', '当前环境已保留8份资料，请先处理已有草稿');
  const savedFilePath = await new Promise<string>((resolve, reject) => wx.getFileSystemManager().saveFile({ tempFilePath: sourcePath,
    success: result => resolve(result.savedFilePath), fail: reject }));
  const draft: MemberMediaDraft = { id: `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, memberId,
    purpose, kind, label, localPath: savedFilePath, rightsAcknowledged, ...scope, createdAt: new Date().toISOString() };
  wx.setStorageSync(DRAFTS_KEY, [...allDrafts(), draft]);
  return draft;
}
export async function retryMemberMediaDraft(draftId: string): Promise<{ assetId: string; previewUrl: string }> {
  const scope = currentDraftScope();
  const member = await currentMember(), draft = allDrafts().find(item => item.id === draftId && item.memberId === member?.id && matchesScope(item, scope));
  if (!member || !draft) throw new MemberMediaError('FORBIDDEN', '无法访问这份本机草稿');
  try {
    if (draft.kind === 'video' && !isMock) throw new MemberMediaError('MEDIA_VIDEO_UNAVAILABLE', '短片已保留为本机草稿。云端上传暂未开通，尚未提交审核');
    let payload: Record<string, unknown> = { purpose: draft.purpose, label: draft.label };
    if (draft.kind === 'image') {
      const imageBase64 = wx.getFileSystemManager().readFileSync(draft.localPath, 'base64');
      validateAvatarImage(imageBase64);
      payload = { ...payload, imageBase64, rightsAcknowledged: draft.rightsAcknowledged === true };
    } else payload = { ...payload, sourcePath: draft.localPath };
    await activeMember(member.id);
    const asset = await call<MemberMediaSummary>(draft.kind === 'image' ? 'media.image.save' : 'media.video.save', payload);
    await activeMember(member.id);
    const preview = await resolveMemberMedia(asset.id);
    await activeMember(member.id);
    wx.setStorageSync(DRAFTS_KEY, allDrafts().filter(item => item.id !== draft.id));
    if (!isMock && draft.kind === 'image') {
      try { wx.getFileSystemManager().removeSavedFile({ filePath: draft.localPath, success: () => {}, fail: () => {} }); } catch { /* Best-effort local quota cleanup. */ }
    }
    return { assetId: asset.id, previewUrl: preview.url };
  } catch (error) {
    const detail = error as { code?: string; message?: string };
    throw new MemberMediaError(typeof detail?.code === 'string' ? detail.code : 'MEDIA_SAVE_PENDING',
      typeof detail?.code === 'string' && detail.message ? detail.message : '资料尚未保存完成，本机草稿已保留，请重试', draft.id);
  }
}
export async function chooseAndUploadMemberVideo(purpose: 'skill', label: string): Promise<{ assetId: string; previewUrl: string }> {
  const member = await currentMember();
  if (!member) throw new MemberMediaError('UNAUTHENTICATED', '请先登录后选择短片');
  const choice = await wx.chooseMedia({ count: 1, mediaType: ['video'], sourceType: ['album', 'camera'], maxDuration: 60, sizeType: ['compressed'] });
  const source = choice.tempFiles[0];
  if (!source?.tempFilePath) throw new MemberMediaError('CANCELLED', '未选择短片');
  const stat = wx.getFileSystemManager().statSync(source.tempFilePath);
  if (Array.isArray(stat) || stat.size <= 0 || stat.size > MEMBER_MEDIA_VIDEO_MAX_BYTES) throw new MemberMediaError('INVALID_INPUT', '请选择8MB以内的短片');
  const info = await wx.getVideoInfo({ src: source.tempFilePath });
  if (!(info.duration > 0 && info.duration <= 60)) throw new MemberMediaError('INVALID_INPUT', '请选择60秒以内的短片');
  await activeMember(member.id);
  // saveFile persists an actual selected file before a cloud-capability error.
  const draft = await keepDraft(member.id, purpose, 'video', label, source.tempFilePath);
  return retryMemberMediaDraft(draft.id);
}
