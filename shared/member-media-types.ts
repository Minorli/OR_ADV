export type MemberMediaPurpose = 'dossier' | 'skill' | 'club_public';
export type MemberMediaKind = 'image' | 'video';
export type MemberMediaMime = 'image/jpeg' | 'image/png' | 'video/mp4' | 'video/quicktime';
export const MEMBER_MEDIA_VIDEO_MAX_BYTES = 8 * 1024 * 1024;

/** A private immutable file; providers must inspect actual bytes before returning. */
export interface MemberMediaStoredFile { fileId: string; bytes: number; mimeType: MemberMediaMime }
export interface MemberMediaStorage {
  readonly mode: 'cloud' | 'local';
  saveImage(memberId: string, assetId: string, imageBase64: string, purpose?: MemberMediaPurpose): Promise<MemberMediaStoredFile>;
  /** Local demonstration only. Cloud video needs a separately verified bounded upload capability. */
  saveVideo?(memberId: string, assetId: string, sourcePath: string): Promise<MemberMediaStoredFile>;
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
  fileId?: string; bytes?: number; mimeType?: MemberMediaMime;
  bindings: string[]; rightsAcknowledged: boolean;
  revision: number; createdAt: string; updatedAt: string;
}
