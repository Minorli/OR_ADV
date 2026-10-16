import { call, currentMember, isMock, runtime } from '../services/api';
import { sha256 } from '../../../shared/hash';
import { validateAvatarImage } from '../../../shared/avatar-image';
import { MEMBER_MEDIA_VIDEO_MAX_BYTES } from '../../../shared/member-media-types';
import type { MemberMediaPurpose, MemberMediaStorage, MemberMediaStoredFile, MemberMediaSummary } from '../../../shared/member-media-types';

const FILES_KEY = 'oradv-member-media-files-v1';
const DRAFTS_KEY = 'oradv-member-media-drafts-v1';
const PREFIX = 'oradv-member-media-v1';
const FILE_ID = /^oradv-member-media-v1\/member_[a-f0-9]{64}\/media_[a-f0-9]{64}\/[a-z0-9-]+\.(jpg|png|mp4|mov)$/;
interface LocalRecord extends MemberMediaStoredFile { memberId: string }
export interface MemberMediaDraft { id: string; memberId: string; purpose: MemberMediaPurpose; kind: 'image' | 'video'; label: string; localPath: string; createdAt: string; scope: 'mock' | 'cloud'; appId?: string; envId?: string; rightsAcknowledged?: boolean }
export class MemberMediaError extends Error { constructor(public readonly code: string, message: string, public readonly draftId?: string) { super(message); } }
function records(): Record<string, LocalRecord> {
  const value = wx.getStorageSync(FILES_KEY);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function localPath(fileId: string): string {
  if (!FILE_ID.test(fileId)) throw new MemberMediaError('INVALID_INPUT', '资料文件标识不正确');
  return `${wx.env.USER_DATA_PATH}/${PREFIX}/${sha256(fileId)}.${fileId.split('.').pop()}`;
}
function directory() {
  const fs = wx.getFileSystemManager(), dir = `${wx.env.USER_DATA_PATH}/${PREFIX}`;
  try { fs.accessSync(dir); }
  catch (error) {
    if (!/ENOENT|no such file|not exist/i.test(String((error as { message?: string; errMsg?: string })?.message || (error as { errMsg?: string })?.errMsg))) throw error;
    fs.mkdirSync(dir, true);
  }
  return fs;
}
function identity(memberId: string, assetId: string) {
  if (!/^member_[a-f0-9]{64}$/.test(memberId) || !/^media_[a-f0-9]{64}$/.test(assetId)) throw new MemberMediaError('INVALID_INPUT', '资料身份不正确');
}
function videoMime(bytes: Uint8Array): 'video/mp4' | 'video/quicktime' {
  if (bytes.length < 32 || bytes.length > MEMBER_MEDIA_VIDEO_MAX_BYTES) throw new MemberMediaError('INVALID_INPUT', '请选择8MB以内的MP4或MOV短片');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let cursor = 0, hasType = false, hasMovie = false, hasData = false, quicktime = false;
  while (cursor + 8 <= bytes.length) {
    const length = view.getUint32(cursor), type = word(cursor + 4);
    if (length < 8 || length > bytes.length - cursor) throw new MemberMediaError('INVALID_INPUT', '短片内容不完整，请重新选择');
    if (type === 'ftyp') {
      if (cursor !== 0 || length < 16) throw new MemberMediaError('INVALID_INPUT', '短片格式无法识别');
      const brand = word(cursor + 8);
      if (!['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'qt  '].includes(brand)) throw new MemberMediaError('INVALID_INPUT', '请选择MP4或MOV短片');
      hasType = true; quicktime = brand === 'qt  ';
    }
    hasMovie ||= type === 'moov' && length > 8;
    hasData ||= type === 'mdat' && length > 8;
    cursor += length;
  }
  if (cursor !== bytes.length || !hasType || !hasMovie || !hasData) throw new MemberMediaError('INVALID_INPUT', '短片内容不完整，请重新选择');
  return quicktime ? 'video/quicktime' : 'video/mp4';
}
function saveRecord(memberId: string, assetId: string, extension: string, content: string | ArrayBuffer, bytes: number, mimeType: MemberMediaStoredFile['mimeType']): LocalRecord {
  identity(memberId, assetId);
  const fileId = `${PREFIX}/${memberId}/${assetId}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.${extension}`;
  const fs = directory(), destination = localPath(fileId);
  if (typeof content === 'string') fs.writeFileSync(destination, content, 'base64');
  else fs.writeFileSync(destination, content);
  const record: LocalRecord = { fileId, memberId, bytes, mimeType };
  // Registry persistence precedes any successful domain result. A full disk must
  // never turn a selected temp file into a claimed uploaded asset.
  wx.setStorageSync(FILES_KEY, { ...records(), [fileId]: record });
  return record;
}

/** App-owned persistent files for device-local demonstration, never cloud evidence. */
export function createLocalMemberMediaStorage(): MemberMediaStorage {
  return {
    mode: 'local',
    async saveImage(memberId, assetId, imageBase64) {
      const image = validateAvatarImage(imageBase64);
      return saveRecord(memberId, assetId, image.extension, imageBase64, image.bytes.length, image.extension === 'png' ? 'image/png' : 'image/jpeg');
    },
    async saveVideo(memberId, assetId, sourcePath) {
      identity(memberId, assetId);
      const fs = wx.getFileSystemManager(), stat = fs.statSync(sourcePath);
      if (Array.isArray(stat) || stat.size <= 0 || stat.size > MEMBER_MEDIA_VIDEO_MAX_BYTES) throw new MemberMediaError('INVALID_INPUT', '请选择8MB以内的短片');
      const content = fs.readFileSync(sourcePath);
      if (!(content instanceof ArrayBuffer) || content.byteLength !== stat.size) throw new MemberMediaError('INVALID_INPUT', '短片内容无法读取');
      const mimeType = videoMime(new Uint8Array(content));
      const info = await wx.getVideoInfo({ src: sourcePath });
      if (!(info.duration > 0 && info.duration <= 60 && info.width > 0 && info.height > 0)) throw new MemberMediaError('INVALID_INPUT', '请选择60秒以内的有效短片');
      return saveRecord(memberId, assetId, mimeType === 'video/mp4' ? 'mp4' : 'mov', content, stat.size, mimeType);
    },
    async url(fileId) {
      const record = records()[fileId];
      if (!record || record.fileId !== fileId) throw new MemberMediaError('MEDIA_MISSING', '本机资料文件不存在，请重新选择');
      const path = localPath(fileId), stat = wx.getFileSystemManager().statSync(path);
      if (Array.isArray(stat) || stat.size !== record.bytes) throw new MemberMediaError('MEDIA_MISSING', '本机资料文件已改变，请重新选择');
      return path;
    },
    async remove(fileId) {
      if (!records()[fileId]) return;
      wx.getFileSystemManager().unlinkSync(localPath(fileId));
      const { [fileId]: removed, ...remaining } = records();
      wx.setStorageSync(FILES_KEY, remaining);
    },
  };
}
export const createMockMemberMediaStorage = createLocalMemberMediaStorage;
export function clearMockMemberMediaFiles(): void {
  for (const fileId of Object.keys(records())) {
    if (!FILE_ID.test(fileId)) continue;
    try { wx.getFileSystemManager().unlinkSync(localPath(fileId)); }
    catch (error) { if (!/ENOENT|no such file|not exist/i.test(String((error as { message?: string })?.message))) throw error; }
  }
  wx.removeStorageSync(FILES_KEY);
  for (const draft of allDrafts().filter(item => item.scope === 'mock')) {
    try { wx.getFileSystemManager().unlinkSync(draft.localPath); }
    catch (error) { if (!/ENOENT|no such file|not exist/i.test(String((error as { message?: string })?.message))) throw error; }
    wx.setStorageSync(DRAFTS_KEY, allDrafts().filter(item => item.id !== draft.id));
  }
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
  for (const [maximum, quality] of [[1024, 65], [768, 60], [512, 55], [256, 45]]) {
    const ratio = Math.min(1, maximum / Math.max(info.width, info.height));
    const image = await wx.compressImage({ src: original, quality, compressedWidth: Math.max(1, Math.round(info.width * ratio)), compressedHeight: Math.max(1, Math.round(info.height * ratio)) });
    const stat = fs.statSync(image.tempFilePath);
    if (Array.isArray(stat) || stat.size <= 0) throw new MemberMediaError('INVALID_INPUT', '无法读取压缩后的图片');
    if (stat.size <= 65_536) { validateAvatarImage(fs.readFileSync(image.tempFilePath, 'base64')); compressedPath = image.tempFilePath; break; }
  }
  if (!compressedPath) throw new MemberMediaError('INVALID_INPUT', '图片压缩后仍超过64KB，请换一张较简单的图片');
  await activeMember(member.id);
  const draft = await keepDraft(member.id, purpose, 'image', label, compressedPath, rightsAcknowledged);
  return retryMemberMediaDraft(draft.id);
}
function allDrafts(): MemberMediaDraft[] {
  const value = wx.getStorageSync(DRAFTS_KEY);
  return Array.isArray(value) ? value.filter(item => item && typeof item.id === 'string' && typeof item.memberId === 'string') : [];
}
type DraftScope = { scope: 'mock' } | { scope: 'cloud'; appId: string; envId: string };
function currentDraftScope(): DraftScope {
  if (isMock) return { scope: 'mock' };
  // Read at call time: api.ts also imports this provider during initialization.
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
