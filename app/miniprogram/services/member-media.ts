import { call, currentMember, isMock, runtime } from '../services/api';
import { validateAvatarImage } from '../../../shared/avatar-image';
import { canManagePublicContent } from '../../../shared/permissions';
import { validateVideoHeader } from '../../../shared/video-container';
import { CLOUD_PUBLIC_VIDEO_MAX_BYTES, CLOUD_SKILL_VIDEO_MAX_BYTES, CLOUD_VIDEO_CHUNK_BYTES, maxCloudVideoBytes, MEMBER_MEDIA_VIDEO_MAX_BYTES } from '../../../shared/member-media-types';
import type { MemberMediaPurpose, MemberMediaSummary } from '../../../shared/member-media-types';
import { allDrafts, clearMockMemberMediaFiles, createLocalMemberMediaStorage, createMockMemberMediaStorage, DRAFTS_KEY, MemberMediaError } from './member-media-local';
import type { MemberMediaDraft } from './member-media-local';

export { clearMockMemberMediaFiles, createLocalMemberMediaStorage, createMockMemberMediaStorage, MemberMediaError };
export type { MemberMediaDraft };

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes: Uint8Array): string {
  const wxApi = typeof wx !== 'undefined' ? (wx as unknown as { arrayBufferToBase64?: (buf: ArrayBuffer) => string }) : undefined;
  if (typeof wxApi?.arrayBufferToBase64 === 'function') {
    const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return wxApi.arrayBufferToBase64(exact as ArrayBuffer);
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63]
      + (i + 1 < bytes.length ? B64_CHARS[(n >> 6) & 63] : '=')
      + (i + 2 < bytes.length ? B64_CHARS[n & 63] : '=');
  }
  return out;
}

async function maybeCompressVideo(sourcePath: string, initialSize: number, maxBytes: number): Promise<{ filePath: string; size: number }> {
  const wxApi = typeof wx !== 'undefined'
    ? (wx as unknown as { compressVideo?: (opts: { src: string; quality: 'low' | 'medium' | 'high' }) => Promise<{ tempFilePath?: string }> })
    : undefined;
  if (typeof wxApi?.compressVideo !== 'function' || initialSize <= 4 * 1024 * 1024) {
    return { filePath: sourcePath, size: initialSize };
  }
  try {
    const quality = initialSize > maxBytes ? 'medium' : 'high';
    const compressed = await wxApi.compressVideo({ src: sourcePath, quality });
    if (compressed?.tempFilePath) {
      const stat = wx.getFileSystemManager().statSync(compressed.tempFilePath);
      if (!Array.isArray(stat) && stat.size > 0 && stat.size < initialSize) {
        return { filePath: compressed.tempFilePath, size: stat.size };
      }
    }
  } catch { /* Fall back to original compressed tempFilePath when platform skips re-encoding. */ }
  return { filePath: sourcePath, size: initialSize };
}

async function uploadCloudVideo(memberId: string, localPath: string, purpose: 'skill' | 'club_public', label: string, rightsAcknowledged: boolean): Promise<{ assetId: string; previewUrl: string }> {
  const raw = wx.getFileSystemManager().readFileSync(localPath) as ArrayBuffer | Uint8Array;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const { mimeType } = validateVideoHeader(bytes.subarray(0, Math.min(32, bytes.byteLength)), bytes.byteLength, maxCloudVideoBytes(purpose));
  await activeMember(memberId);
  const session = await call<{ assetId: string; uploadUrl?: string; maxChunkBytes: number; ready?: MemberMediaSummary }>('media.video.begin', {
    purpose,
    label,
    bytes: bytes.byteLength,
    mimeType,
    ...(rightsAcknowledged ? { rightsAcknowledged: true } : {}),
  });
  await activeMember(memberId);
  let asset = session.ready;
  if (!asset) {
    let directPutOk = false;
    const wxApi = typeof wx !== 'undefined' ? (wx as unknown as { request?: typeof wx.request }) : undefined;
    if (session.uploadUrl && typeof wxApi?.request === 'function') {
      try {
        const exactBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const status = await new Promise<number>((resolve, reject) => {
          wxApi.request!({
            url: session.uploadUrl!,
            method: 'PUT',
            header: { 'Content-Type': mimeType },
            data: exactBuffer as ArrayBuffer,
            timeout: 60000,
            success: res => resolve(res.statusCode),
            fail: reject,
          });
        });
        directPutOk = status >= 200 && status < 300;
      } catch {
        directPutOk = false;
      }
    }
    let totalChunks: number | undefined;
    if (!directPutOk) {
      const chunkSize = Math.max(64 * 1024, Math.min(session.maxChunkBytes || CLOUD_VIDEO_CHUNK_BYTES, CLOUD_VIDEO_CHUNK_BYTES));
      totalChunks = Math.ceil(bytes.byteLength / chunkSize);
      for (let index = 0; index < totalChunks; index++) {
        await activeMember(memberId);
        const slice = bytes.subarray(index * chunkSize, Math.min(bytes.byteLength, (index + 1) * chunkSize));
        await call('media.video.chunk', { assetId: session.assetId, index, totalChunks, chunkBase64: bytesToBase64(slice) });
      }
    }
    await activeMember(memberId);
    asset = await call<MemberMediaSummary>('media.video.complete', {
      assetId: session.assetId,
      ...(totalChunks !== undefined ? { totalChunks } : {}),
    });
  }
  await activeMember(memberId);
  const preview = await resolveMemberMedia(asset.id);
  await activeMember(memberId);
  return { assetId: asset.id, previewUrl: preview.url };
}

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
    if (draft.kind === 'video' && !isMock) {
      const uploaded = await uploadCloudVideo(member.id, draft.localPath, draft.purpose === 'club_public' ? 'club_public' : 'skill', draft.label, draft.rightsAcknowledged === true);
      wx.setStorageSync(DRAFTS_KEY, allDrafts().filter(item => item.id !== draft.id));
      try { wx.getFileSystemManager().removeSavedFile({ filePath: draft.localPath, success: () => {}, fail: () => {} }); } catch { /* Best-effort local quota cleanup. */ }
      return uploaded;
    }
    let payload: Record<string, unknown> = { purpose: draft.purpose, label: draft.label };
    if (draft.kind === 'image') {
      const imageBase64 = wx.getFileSystemManager().readFileSync(draft.localPath, 'base64');
      validateAvatarImage(imageBase64);
      payload = { ...payload, imageBase64, rightsAcknowledged: draft.rightsAcknowledged === true };
    } else payload = { ...payload, sourcePath: draft.localPath, ...(draft.rightsAcknowledged ? { rightsAcknowledged: true } : {}) };
    await activeMember(member.id);
    const asset = await call<MemberMediaSummary>(draft.kind === 'image' ? 'media.image.save' : 'media.video.save', payload);
    await activeMember(member.id);
    const preview = await resolveMemberMedia(asset.id);
    await activeMember(member.id);
    wx.setStorageSync(DRAFTS_KEY, allDrafts().filter(item => item.id !== draft.id));
    if (!isMock) {
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
  const maxBytes = isMock ? MEMBER_MEDIA_VIDEO_MAX_BYTES : CLOUD_SKILL_VIDEO_MAX_BYTES;
  const maxMb = Math.round(maxBytes / (1024 * 1024));
  const choice = await wx.chooseMedia({ count: 1, mediaType: ['video'], sourceType: ['album', 'camera'], maxDuration: 60, sizeType: ['compressed'] });
  const source = choice.tempFiles[0];
  if (!source?.tempFilePath) throw new MemberMediaError('CANCELLED', '未选择短片');
  const rawStat = wx.getFileSystemManager().statSync(source.tempFilePath);
  if (Array.isArray(rawStat) || rawStat.size <= 0) throw new MemberMediaError('INVALID_INPUT', `请选择${maxMb}MB以内的短片`);
  const prepared = await maybeCompressVideo(source.tempFilePath, rawStat.size, maxBytes);
  if (prepared.size <= 0 || prepared.size > maxBytes) throw new MemberMediaError('INVALID_INPUT', `请选择${maxMb}MB以内的短片`);
  const info = await wx.getVideoInfo({ src: prepared.filePath });
  if (!(info.duration > 0 && info.duration <= 60)) throw new MemberMediaError('INVALID_INPUT', '请选择60秒以内的短片');
  await activeMember(member.id);
  if (!isMock && prepared.size > MEMBER_MEDIA_VIDEO_MAX_BYTES) {
    return uploadCloudVideo(member.id, prepared.filePath, purpose, label, false);
  }
  // saveFile persists an actual selected file before a cloud-capability error.
  const draft = await keepDraft(member.id, purpose, 'video', label, prepared.filePath);
  return retryMemberMediaDraft(draft.id);
}
export async function chooseAndUploadAdminDemoVideo(label: string): Promise<{ assetId: string; previewUrl: string }> {
  const member = await currentMember();
  if (!member) throw new MemberMediaError('UNAUTHENTICATED', '请先登录后上传示范视频');
  if (!canManagePublicContent(member)) throw new MemberMediaError('FORBIDDEN', '没有公开示范内容管理权限');
  const maxBytes = isMock ? MEMBER_MEDIA_VIDEO_MAX_BYTES : CLOUD_PUBLIC_VIDEO_MAX_BYTES;
  const maxMb = Math.round(maxBytes / (1024 * 1024));
  const choice = await wx.chooseMedia({ count: 1, mediaType: ['video'], sourceType: ['album', 'camera'], maxDuration: 180, sizeType: ['compressed'] });
  const source = choice.tempFiles[0];
  if (!source?.tempFilePath) throw new MemberMediaError('CANCELLED', '未选择示范视频');
  const rawStat = wx.getFileSystemManager().statSync(source.tempFilePath);
  if (Array.isArray(rawStat) || rawStat.size <= 0) throw new MemberMediaError('INVALID_INPUT', `请选择${maxMb}MB以内的示范视频`);
  const prepared = await maybeCompressVideo(source.tempFilePath, rawStat.size, maxBytes);
  if (prepared.size <= 0 || prepared.size > maxBytes) throw new MemberMediaError('INVALID_INPUT', `请选择${maxMb}MB以内的示范视频`);
  const info = await wx.getVideoInfo({ src: prepared.filePath });
  if (!(info.duration > 0 && info.duration <= 180)) throw new MemberMediaError('INVALID_INPUT', '请选择3分钟（180秒）以内的示范视频');
  await activeMember(member.id);
  if (isMock) {
    const draft = await keepDraft(member.id, 'club_public', 'video', label, prepared.filePath, true);
    return retryMemberMediaDraft(draft.id);
  }
  return uploadCloudVideo(member.id, prepared.filePath, 'club_public', label, true);
}
