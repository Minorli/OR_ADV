import { sha256 } from '../../../shared/hash';
import { validateAvatarImage } from '../../../shared/avatar-image';
import { MEMBER_MEDIA_VIDEO_MAX_BYTES } from '../../../shared/member-media-types';
import type { MemberMediaPurpose, MemberMediaStorage, MemberMediaStoredFile } from '../../../shared/member-media-types';

const FILES_KEY = 'oradv-member-media-files-v1';
export const DRAFTS_KEY = 'oradv-member-media-drafts-v1';
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
export function allDrafts(): MemberMediaDraft[] {
  const value = wx.getStorageSync(DRAFTS_KEY);
  return Array.isArray(value) ? value.filter(item => item && typeof item.id === 'string' && typeof item.memberId === 'string') : [];
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
