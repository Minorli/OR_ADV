export type MemberMediaPurpose = 'dossier' | 'skill' | 'club_public';
export type MemberMediaKind = 'image' | 'video';
export type MemberMediaMime = 'image/jpeg' | 'image/png' | 'video/mp4' | 'video/quicktime';

/** Local mock sandbox video cap (WeChat savedFile total sandbox is 10 MiB). */
export const MEMBER_MEDIA_VIDEO_MAX_BYTES = 8 * 1024 * 1024;
/** Configurable cloud video cap for rider skill practice submissions (25 MiB). */
export const CLOUD_SKILL_VIDEO_MAX_BYTES = 25 * 1024 * 1024;
/** Configurable cloud video cap for high-privilege admin demonstration videos (50 MiB). */
export const CLOUD_PUBLIC_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** Per-chunk raw byte size when falling back to Cloud Function chunked relay (512 KiB -> ~683 KB Base64 < WeChat 1 MB client callFunction cap). */
export const CLOUD_VIDEO_CHUNK_BYTES = 512 * 1024;

export function maxCloudVideoBytes(purpose: MemberMediaPurpose): number {
  return purpose === 'club_public' ? CLOUD_PUBLIC_VIDEO_MAX_BYTES : CLOUD_SKILL_VIDEO_MAX_BYTES;
}

/** A private immutable file; providers must inspect actual bytes before returning. */
export interface MemberMediaStoredFile { fileId: string; bytes: number; mimeType: MemberMediaMime }
export interface CloudVideoUploadSession { uploadUrl?: string; storagePrefix: string }
export interface MemberMediaStorage {
  readonly mode: 'cloud' | 'local';
  saveImage(memberId: string, assetId: string, imageBase64: string, purpose?: MemberMediaPurpose): Promise<MemberMediaStoredFile>;
  /** Local demonstration video storage. */
  saveVideo?(memberId: string, assetId: string, sourcePath: string): Promise<MemberMediaStoredFile>;
  /** Cloud video direct/chunked upload lifecycle. */
  beginVideo?(memberId: string, assetId: string, purpose: 'skill' | 'club_public', extension: 'mp4' | 'mov'): Promise<CloudVideoUploadSession>;
  saveVideoChunk?(storagePrefix: string, index: number, chunkBytes: Uint8Array): Promise<void>;
  completeVideo?(storagePrefix: string, expectedBytes: number, maxBytes: number, totalChunks?: number): Promise<MemberMediaStoredFile>;
  url(fileId: string): Promise<string>;
  remove(fileId: string): Promise<void>;
}
export interface MemberMediaSummary {
  id: string; kind: MemberMediaKind; purpose: MemberMediaPurpose; storageMode: 'cloud' | 'local';
  label: string; bytes: number; mimeType: MemberMediaMime; createdAt: string;
}
/** Never project this row to clients, public cards or ordinary audit summaries. */
export interface MemberMediaAsset {
  id: string; clubId: string; memberId: string; userId: string;
  kind: MemberMediaKind; purpose: MemberMediaPurpose; storageMode: 'cloud' | 'local';
  label: string; status: 'uploading' | 'ready' | 'cancelled'; requestDigest: string;
  fileId?: string; uploadTarget?: string; expectedBytes?: number; bytes?: number; mimeType?: MemberMediaMime;
  bindings: string[]; rightsAcknowledged: boolean;
  revision: number; createdAt: string; updatedAt: string;
}
