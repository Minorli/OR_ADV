import { randomUUID } from 'node:crypto';
import { validateAvatarImage } from '../../shared/avatar-image';
import { validateVideoHeader } from '../../shared/video-container';
import type { MemberMediaStorage } from '../../shared/member-media-types';
import { verifyNewImageUpload, type ImageReadbackSdk } from './image-upload';

export interface MemberMediaCloudSdk extends ImageReadbackSdk {
  uploadFile(input: { cloudPath: string; fileContent: Buffer }): Promise<{ fileID: string; statusCode: number }>;
  getTempFileURL(input: { fileList: { fileID: string; maxAge: number }[] }): Promise<{ fileList: { fileID: string; status: number; tempFileURL: string }[] }> | void;
  deleteFile(input: { fileList: string[] }): Promise<{ fileList: { fileID: string; status: number }[] }> | void;
  createSignedUploadUrl?(input: { cloudPath: string; maxAge?: number }): Promise<{ fileID: string; uploadUrl: string }>;
}
const canonical = /^cloud:\/\/[^/]+\/(?:member-evidence\/member_[a-f0-9]{64}\/media_[a-f0-9]{64}\/[a-f0-9-]{36}|club-public-assets\/[a-f0-9-]{36})\.(jpg|png|mp4|mov)$/;
const stagingPattern = /^(member-evidence|club-public-assets)\/_staging\/(member_[a-f0-9]{64})\/(media_[a-f0-9]{64})\/([a-f0-9-]{36})\.(mp4|mov)$/;
function checkFileId(fileId: string) { if (!canonical.test(fileId)) throw new Error('Invalid evidence namespace'); }

/** Only server-held, validated media bytes reach these fresh canonical objects. */
export function createMemberMediaStorage(sdk: MemberMediaCloudSdk, fallbackEnvId?: string): MemberMediaStorage {
  const supportsVideo = typeof sdk.downloadFile === 'function' && (typeof sdk.createSignedUploadUrl === 'function' || Boolean(fallbackEnvId));
  return {
    mode: 'cloud',
    async saveImage(memberId, assetId, imageBase64, purpose = 'dossier') {
      if (!/^member_[a-f0-9]{64}$/.test(memberId) || !/^media_[a-f0-9]{64}$/.test(assetId)) throw new Error('Invalid evidence identity');
      const image = validateAvatarImage(imageBase64);
      const cloudPath = purpose === 'club_public'
        ? `club-public-assets/${randomUUID()}.${image.extension}`
        : `member-evidence/${memberId}/${assetId}/${randomUUID()}.${image.extension}`;
      const result = await sdk.uploadFile({ cloudPath, fileContent: Buffer.from(image.bytes) });
      if (!result || typeof result.fileID !== 'string' || !result.fileID.endsWith('/' + cloudPath)) throw new Error('Evidence upload unavailable');
      checkFileId(result.fileID);
      await verifyNewImageUpload(sdk, result, image.bytes, 'Evidence upload unavailable');
      return { fileId: result.fileID, bytes: image.bytes.length, mimeType: image.extension === 'png' ? 'image/png' : 'image/jpeg' };
    },
    ...(supportsVideo ? {
      async beginVideo(memberId, assetId, purpose, extension) {
        if (!/^member_[a-f0-9]{64}$/.test(memberId) || !/^media_[a-f0-9]{64}$/.test(assetId)) throw new Error('Invalid evidence identity');
        const bucket = purpose === 'club_public' ? 'club-public-assets' : 'member-evidence';
        const storagePrefix = `${bucket}/_staging/${memberId}/${assetId}/${randomUUID()}.${extension}`;
        if (typeof sdk.createSignedUploadUrl === 'function') {
          try {
            const signed = await sdk.createSignedUploadUrl({ cloudPath: storagePrefix, maxAge: 300 });
            return { uploadUrl: signed.uploadUrl, storagePrefix: signed.fileID };
          } catch {
            if (!fallbackEnvId) throw new Error('Signed video upload unavailable');
          }
        }
        return { storagePrefix: `cloud://${fallbackEnvId}/${storagePrefix}` };
      },
      async saveVideoChunk(storagePrefix, index, chunkBytes) {
        const match = /^cloud:\/\/[^/]+\/(.+)$/.exec(storagePrefix);
        if (!match || !stagingPattern.test(match[1])) throw new Error('Invalid video staging path');
        const chunkPath = `${match[1]}.part${String(index).padStart(4, '0')}.bin`;
        await sdk.uploadFile({ cloudPath: chunkPath, fileContent: Buffer.from(chunkBytes) });
      },
      async completeVideo(storagePrefix, expectedBytes, maxBytes, totalChunks) {
        const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(storagePrefix);
        if (!match) throw new Error('Invalid video staging reference');
        const envId = match[1], relPath = match[2];
        const parsed = stagingPattern.exec(relPath);
        if (!parsed) throw new Error('Invalid video staging path');
        if (!(expectedBytes > 0 && expectedBytes <= maxBytes)) throw new Error('Video byte size out of bounds');
        const [, bucket, memberId, assetId, , declaredExt] = parsed;
        const cleanupIds: string[] = [];
        let videoBytes: Buffer;
        if (totalChunks && totalChunks > 0) {
          const partIds = Array.from({ length: totalChunks }, (_, idx) => `cloud://${envId}/${relPath}.part${String(idx).padStart(4, '0')}.bin`);
          cleanupIds.push(...partIds);
          videoBytes = Buffer.allocUnsafe(expectedBytes);
          let offset = 0;
          for (const id of partIds) {
            const downloaded = await sdk.downloadFile!({ fileID: id });
            if (!downloaded || downloaded.statusCode < 200 || downloaded.statusCode >= 300 || !downloaded.fileContent.length) {
              throw new Error('Missing uploaded video chunk');
            }
            if (offset + downloaded.fileContent.length > expectedBytes) {
              throw new Error('Video byte size mismatch');
            }
            downloaded.fileContent.copy(videoBytes, offset);
            offset += downloaded.fileContent.length;
          }
          if (offset !== expectedBytes) throw new Error('Video byte size mismatch');
        } else {
          cleanupIds.push(storagePrefix);
          const downloaded = await sdk.downloadFile!({ fileID: storagePrefix });
          if (!downloaded || downloaded.statusCode < 200 || downloaded.statusCode >= 300 || !downloaded.fileContent.length) {
            throw new Error('Uploaded video not found');
          }
          videoBytes = downloaded.fileContent;
        }
        try {
          if (videoBytes.length !== expectedBytes) throw new Error('Video byte size mismatch');
          const validated = validateVideoHeader(videoBytes.subarray(0, Math.min(64, videoBytes.length)), videoBytes.length, maxBytes);
          const finalExt = validated.mimeType === 'video/quicktime' && declaredExt === 'mov' ? 'mov' : 'mp4';
          const canonicalPath = bucket === 'club-public-assets'
            ? `club-public-assets/${randomUUID()}.${finalExt}`
            : `member-evidence/${memberId}/${assetId}/${randomUUID()}.${finalExt}`;
          const saved = await sdk.uploadFile({ cloudPath: canonicalPath, fileContent: videoBytes });
          if (!saved || typeof saved.fileID !== 'string' || !saved.fileID.endsWith('/' + canonicalPath)) {
            throw new Error('Video freeze upload failed');
          }
          checkFileId(saved.fileID);
          return { fileId: saved.fileID, bytes: videoBytes.length, mimeType: validated.mimeType };
        } finally {
          if (cleanupIds.length) {
            try { await sdk.deleteFile({ fileList: cleanupIds }); } catch { /* Best-effort staging cleanup. */ }
          }
        }
      },
    } : {}),
    async url(fileId) {
      checkFileId(fileId);
      const maxAge = /\.(mp4|mov)$/i.test(fileId) ? 600 : 300;
      const result = await sdk.getTempFileURL({ fileList: [{ fileID: fileId, maxAge }] });
      const file = result?.fileList?.find(item => item.fileID === fileId);
      if (!file || file.status !== 0 || !/^https:\/\/[^/\s]+\//.test(file.tempFileURL)) throw new Error('Evidence preview unavailable');
      return file.tempFileURL;
    },
    async remove(fileId) {
      checkFileId(fileId);
      const result = await sdk.deleteFile({ fileList: [fileId] });
      if (!result?.fileList?.some(item => item.fileID === fileId && item.status === 0)) throw new Error('Evidence cleanup unavailable');
    },
  };
}
