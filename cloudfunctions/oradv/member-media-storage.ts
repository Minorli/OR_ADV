import { randomUUID } from 'node:crypto';
import { validateAvatarImage } from '../../shared/avatar-image';
import type { MemberMediaStorage } from '../../shared/member-media-types';
import { verifyNewImageUpload, type ImageReadbackSdk } from './image-upload';

export interface MemberMediaCloudSdk extends ImageReadbackSdk {
  uploadFile(input: { cloudPath: string; fileContent: Buffer }): Promise<{ fileID: string; statusCode: number }>;
  getTempFileURL(input: { fileList: { fileID: string; maxAge: number }[] }): Promise<{ fileList: { fileID: string; status: number; tempFileURL: string }[] }> | void;
  deleteFile(input: { fileList: string[] }): Promise<{ fileList: { fileID: string; status: number }[] }> | void;
}
const canonical = /^cloud:\/\/[^/]+\/(?:member-evidence\/member_[a-f0-9]{64}\/media_[a-f0-9]{64}\/[a-f0-9-]{36}|club-public-assets\/[a-f0-9-]{36})\.(jpg|png)$/;
function checkFileId(fileId: string) { if (!canonical.test(fileId)) throw new Error('Invalid evidence namespace'); }

/** Only server-held, validated image bytes reach these fresh canonical objects. */
export function createMemberMediaStorage(sdk: MemberMediaCloudSdk): MemberMediaStorage {
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
    // getUploadMetadata's PUT grant does not bind the 8 MiB maximum. Do not
    // expose it. A future video provider must prove exact-path/body-size bounds
    // before offering a staging ticket and must freeze a server-only copy.
    async url(fileId) {
      checkFileId(fileId);
      const result = await sdk.getTempFileURL({ fileList: [{ fileID: fileId, maxAge: 300 }] });
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
