import { DomainError, requireThat, text } from './errors';

export function validatePublicVideoUrl(value: unknown): string {
  if (value === '' || value === undefined || value === null) return '';
  const url = text(value, '视频链接', 1500);
  const match = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?(\/[A-Za-z0-9_~!$&'()*+,;=:@%./-]+\.mp4)$/i.exec(url);
  requireThat(match && !/[\s\\?#]/.test(url), 'INVALID_INPUT', '请填写无查询参数的公开HTTPS直连MP4地址');
  const host = match[1].toLowerCase(), labels = host.split('.');
  requireThat(labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && /^[a-z]{2,63}$/.test(labels[labels.length - 1]) && !/\.(?:localhost|local|internal|test|invalid)$/.test(host), 'INVALID_INPUT', '请使用公开域名的HTTPS视频地址');
  requireThat(!/%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i.test(match[2]) && !match[2].split('/').some(part => part === '..' || part === '.'), 'INVALID_INPUT', '视频地址格式不正确');
  let decoded: string;
  try { decoded = decodeURIComponent(match[2]); } catch { throw new DomainError('INVALID_INPUT', '视频地址编码不正确'); }
  requireThat(!decoded.split('/').some(part => part === '..' || part === '.'), 'INVALID_INPUT', '视频地址格式不正确');
  return url;
}
