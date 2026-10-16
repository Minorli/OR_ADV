import { requireThat } from './errors';

export const AVATAR_MAX_BYTES = 65_536;
export const AVATAR_REQUEST_LIMIT = 131_072;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export interface AvatarImage { bytes: Uint8Array; extension: 'jpg' | 'png'; width: number; height: number }

/** Portable validation for both the native mock runtime and the cloud service. */
export function validateAvatarImage(value: unknown): AvatarImage {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(AVATAR_MAX_BYTES / 3) * 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'INVALID_INPUT', '请重新选择有效头像图片');
  const encoded = value as string;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const size = encoded.length / 4 * 3 - padding;
  requireThat(size > 0 && size <= AVATAR_MAX_BYTES, 'INVALID_INPUT', '头像压缩后不能超过64KB');
  if (padding) {
    const last = alphabet.indexOf(encoded[encoded.length - padding - 1]);
    requireThat((last & (padding === 2 ? 15 : 3)) === 0, 'INVALID_INPUT', '头像编码不正确');
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (let index = 0; index < encoded.length; index += 4) {
    const bits = alphabet.indexOf(encoded[index]) << 18 | alphabet.indexOf(encoded[index + 1]) << 12
      | Math.max(0, alphabet.indexOf(encoded[index + 2])) << 6 | Math.max(0, alphabet.indexOf(encoded[index + 3]));
    for (const shift of [16, 8, 0]) if (offset < size) bytes[offset++] = bits >>> shift & 255;
  }
  const view = new DataView(bytes.buffer);
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((part, index) => bytes[index] === part);
  let width = 0, height = 0;
  if (png) {
    requireThat(size >= 57 && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452, 'INVALID_INPUT', 'PNG头像格式不正确');
    width = view.getUint32(16); height = view.getUint32(20);
    let chunk = 8, hasData = false, ended = false;
    while (chunk + 12 <= size) {
      const length = view.getUint32(chunk), type = view.getUint32(chunk + 4);
      requireThat(length <= size - chunk - 12, 'INVALID_INPUT', 'PNG头像数据不完整');
      if (type === 0x49444154) hasData ||= length > 0;
      if (type === 0x49454e44) { ended = length === 0 && chunk + 12 === size; break; }
      requireThat(type !== 0x49484452 || chunk === 8, 'INVALID_INPUT', 'PNG头像格式不正确');
      chunk += length + 12;
    }
    requireThat(hasData && ended && bytes[26] === 0 && bytes[27] === 0 && bytes[28] <= 1, 'INVALID_INPUT', 'PNG头像数据不完整');
  } else {
    requireThat(size > 10 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[size - 2] === 0xff && bytes[size - 1] === 0xd9, 'INVALID_INPUT', '请选择JPEG或PNG头像');
    let cursor = 2, hasScan = false;
    while (cursor < size - 2) {
      requireThat(bytes[cursor++] === 0xff, 'INVALID_INPUT', 'JPEG头像格式不正确');
      while (bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      requireThat(cursor + 2 <= size && marker !== 0xd8 && marker !== 0xd9 && marker !== 0, 'INVALID_INPUT', 'JPEG头像数据不完整');
      const length = view.getUint16(cursor);
      requireThat(length >= 2 && cursor + length <= size - 2, 'INVALID_INPUT', 'JPEG头像数据不完整');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        requireThat(length >= 8 && width === 0 && bytes[cursor + 2] === 8, 'INVALID_INPUT', 'JPEG头像格式不正确');
        height = view.getUint16(cursor + 3); width = view.getUint16(cursor + 5);
      }
      if (marker === 0xda) { hasScan = true; break; }
      cursor += length;
    }
    requireThat(hasScan && width > 0, 'INVALID_INPUT', 'JPEG头像数据不完整');
  }
  requireThat(width > 0 && height > 0 && width <= 1024 && height <= 1024, 'INVALID_INPUT', '头像尺寸须在1024像素以内');
  return { bytes, extension: png ? 'png' : 'jpg', width, height };
}
