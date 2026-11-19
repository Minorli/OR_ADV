import { sha256 } from '../../../shared/hash';
import { validateAvatarImage } from '../../../shared/avatar-image';

const MAX_BYTES = 64 * 1024;
const FILES_KEY = 'oradv-beta-avatar-files-v3';
const FILE_ID = /^oradv-mock-avatar-v3\/([a-f0-9]{64})\/([a-z0-9]+-[a-z0-9]+)\.(jpg|png)$/;
export interface AvatarDraft { imageBase64: string; previewUrl: string }
export class AvatarError extends Error {}

function readBase64(fs: WechatMiniprogram.FileSystemManager, filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => fs.readFile({
    filePath, encoding: 'base64',
    success: result => typeof result.data === 'string' ? resolve(result.data) : reject(new AvatarError('无法读取头像，请重新选择')),
    fail: reject,
  }));
}

/** Native avatar choice stays a draft until the profile save succeeds. */
export async function prepareAvatar(path: string): Promise<AvatarDraft> {
  try {
    const original = await wx.getImageInfo({ src: path });
    if (!(original.width > 0 && original.height > 0)) throw new AvatarError('无法读取这张头像，请重新选择');
    const fs = wx.getFileSystemManager();
    let oversized = false;
    let formatFailed = false;
    for (const [maximum, quality] of [[256, 80], [256, 60], [192, 45], [160, 35]] as const) {
      const ratio = Math.min(1, maximum / Math.max(original.width, original.height));
      const compressed = await wx.compressImage({
        src: path, quality,
        compressedWidth: Math.max(1, Math.round(original.width * ratio)),
        compressedHeight: Math.max(1, Math.round(original.height * ratio)),
      });
      const stat = fs.statSync(compressed.tempFilePath);
      if (Array.isArray(stat) || stat.size <= 0) throw new AvatarError('无法读取头像，请重新选择');
      if (stat.size > MAX_BYTES) { oversized = true; continue; }
      const imageBase64 = await readBase64(fs, compressed.tempFilePath);
      try {
        validateAvatarImage(imageBase64);
        return { imageBase64, previewUrl: compressed.tempFilePath };
      } catch {
        formatFailed = true;
      }
    }
    if (oversized) throw new AvatarError('头像仍然过大，请换一张较简单的图片');
    if (formatFailed) throw new AvatarError('请使用较新版微信，选择 JPG 或 PNG 头像后重试');
    throw new AvatarError('头像内容无法保存，请重新选择');
  } catch (error) {
    if (error instanceof AvatarError) throw error;
    throw new AvatarError('头像处理未完成，请重新选择后重试');
  }
}

function registeredFiles(): Record<string, true> {
  const value = wx.getStorageSync(FILES_KEY);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function localPath(fileId: string): string {
  const match = FILE_ID.exec(fileId);
  if (!match) throw new AvatarError('头像标识无效');
  return `${wx.env.USER_DATA_PATH}/oradv-mock-avatars-v3/${match[1]}-${match[2]}.${match[3]}`;
}
function missing(error: unknown): boolean {
  const reason = error as { errMsg?: string; message?: string };
  return /no such file|not exist|ENOENT/i.test(reason?.errMsg || reason?.message || '');
}
function removeLocal(fileId: string): void {
  const files = registeredFiles();
  if (!files[fileId] || !FILE_ID.test(fileId)) return;
  try { wx.getFileSystemManager().unlinkSync(localPath(fileId)); }
  catch (error) { if (!missing(error)) throw new AvatarError('本地头像未能清理，请重试'); }
  const { [fileId]: removed, ...remaining } = files;
  wx.setStorageSync(FILES_KEY, remaining);
}

/** Only the mock service uses these private, app-owned files. */
export function createMockAvatarStorage() {
  return {
    async save(memberId: string, imageBase64: string): Promise<string> {
      const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
      const fileId = `oradv-mock-avatar-v3/${sha256(memberId)}/${token}.${imageBase64.startsWith('/9j/') ? 'jpg' : 'png'}`;
      const fs = wx.getFileSystemManager();
      const directory = `${wx.env.USER_DATA_PATH}/oradv-mock-avatars-v3`;
      try { fs.accessSync(directory); }
      catch (error) { if (!missing(error)) throw error; fs.mkdirSync(directory, true); }
      fs.writeFileSync(localPath(fileId), imageBase64, 'base64');
      wx.setStorageSync(FILES_KEY, { ...registeredFiles(), [fileId]: true });
      return fileId;
    },
    async url(fileId: string): Promise<string> {
      if (!registeredFiles()[fileId]) throw new AvatarError('头像已失效，请重新选择');
      const path = localPath(fileId);
      wx.getFileSystemManager().accessSync(path);
      return path;
    },
    async remove(fileId: string): Promise<void> { removeLocal(fileId); },
  };
}
export function clearMockAvatarFiles(): void {
  for (const fileId of Object.keys(registeredFiles())) removeLocal(fileId);
  wx.removeStorageSync(FILES_KEY);
}
