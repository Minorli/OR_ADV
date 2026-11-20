import { requireThat } from './errors';
import type { MemberMediaMime } from './member-media-types';

const VALID_TOP_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'styp']);

export function validateVideoHeader(headBytes: Uint8Array, totalBytes: number, maxBytes: number): { mimeType: Extract<MemberMediaMime, 'video/mp4' | 'video/quicktime'> } {
  requireThat(Number.isSafeInteger(totalBytes) && totalBytes >= 16 && totalBytes <= maxBytes,
    'INVALID_INPUT', `视频大小需在 ${Math.round(maxBytes / (1024 * 1024))}MB 以内`);
  requireThat(headBytes && headBytes.byteLength >= 12, 'INVALID_INPUT', '视频文件头不完整，请重新选择 MP4 或 MOV 视频');
  const view = new DataView(headBytes.buffer, headBytes.byteOffset, headBytes.byteLength);
  const firstBoxSize = view.getUint32(0, false);
  const boxType = String.fromCharCode(headBytes[4], headBytes[5], headBytes[6], headBytes[7]);
  requireThat((firstBoxSize === 1 || firstBoxSize === 0 || firstBoxSize >= 8) && VALID_TOP_BOXES.has(boxType),
    'INVALID_INPUT', '不支持的视频格式，请选择标准 MP4 或 MOV 视频');
  const majorBrand = boxType === 'ftyp' ? String.fromCharCode(headBytes[8], headBytes[9], headBytes[10], headBytes[11]) : '';
  const mimeType = majorBrand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  return { mimeType };
}
