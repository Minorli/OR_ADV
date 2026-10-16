import { randomUUID } from 'node:crypto';
import type { AvatarStorage } from '../../shared/models';
import { validateAvatarImage } from '../../shared/avatar-image';

interface FileStatus { fileID: string; status: number }
export interface AvatarCloudSdk {
  uploadFile(options: { cloudPath: string; fileContent: Buffer }): Promise<{ fileID: string; statusCode: number }>;
  getTempFileURL(options: { fileList: { fileID: string; maxAge: number }[] }): Promise<{ fileList: (FileStatus & { tempFileURL: string })[] }> | void;
  deleteFile(options: { fileList: string[] }): Promise<{ fileList: FileStatus[] }> | void;
}

function ownNamespace(fileId: string): void {
  if (!/^cloud:\/\/[^/]+\/member-avatars\/member_[a-f0-9]{64}\/[a-f0-9-]{36}\.(jpg|png)$/.test(fileId)) {
    throw new Error('Invalid private avatar reference');
  }
}

/** SDK access stays server-side; no client storage rules are relaxed. */
export function createAvatarStorage(sdk: AvatarCloudSdk): AvatarStorage {
  return {
    save: async (memberId, imageBase64) => {
      if (!/^member_[a-f0-9]{64}$/.test(memberId)) throw new Error('Invalid avatar member reference');
      const image = validateAvatarImage(imageBase64);
      const cloudPath = `member-avatars/${memberId}/${randomUUID()}.${image.extension}`;
      const result = await sdk.uploadFile({ cloudPath, fileContent: Buffer.from(image.bytes) });
      if (!result || typeof result.fileID !== 'string' || !result.fileID.endsWith('/' + cloudPath)
        || result.statusCode < 200 || result.statusCode >= 300) throw new Error('Avatar upload unavailable');
      ownNamespace(result.fileID);
      return result.fileID;
    },
    url: async fileId => {
      ownNamespace(fileId);
      const result = await sdk.getTempFileURL({ fileList: [{ fileID: fileId, maxAge: 300 }] });
      const file = result?.fileList?.find(item => item.fileID === fileId);
      if (!file || file.status !== 0 || typeof file.tempFileURL !== 'string'
        || !/^https:\/\/[^/\s]+\//.test(file.tempFileURL)) throw new Error('Avatar preview unavailable');
      return file.tempFileURL;
    },
    remove: async fileId => {
      ownNamespace(fileId);
      const result = await sdk.deleteFile({ fileList: [fileId] });
      if (!result?.fileList?.some(file => file.fileID === fileId && file.status === 0)) throw new Error('Avatar cleanup unavailable');
    },
  };
}
