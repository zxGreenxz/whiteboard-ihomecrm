import type { ZaloMessage } from './types';

const MEDIA_KINDS = new Set<ZaloMessage['type']>(['image', 'video', 'voice', 'file']);

/** The server rechecks access and source data; this explains unavailable UI actions. */
export function forwardMediaIssue(messages: ZaloMessage[]): string | null {
  if (!messages.length) return 'Chọn ảnh, video, ghi âm hoặc tệp muốn chuyển tiếp.';
  if (messages.length > 12) return 'Mỗi lần chuyển tiếp tối đa 12 ảnh trong một album.';
  if (messages.some(message => !MEDIA_KINDS.has(message.type))) return 'Chỉ chuyển tiếp ảnh, video, ghi âm hoặc tệp ở đây.';
  if (messages.length > 1 && messages.some(message => message.type !== 'image')) return 'Chỉ album ảnh được chuyển tiếp nhiều tệp cùng lúc.';
  if (messages.some(message => message.tick === 'pending' || message.tick === 'failed')) return 'Tin đang chờ hoặc gửi lỗi chưa thể chuyển tiếp. Hãy kiểm tra trạng thái tin gốc.';
  if (messages.some(message => !message.id?.trim())) return 'Tin chưa được lưu nên chưa thể chuyển tiếp.';
  if (new Set(messages.map(message => message.id)).size !== messages.length) return 'Album có ảnh trùng. Hãy mở lại tin gốc rồi chọn chuyển tiếp.';
  if (messages.some(message => !message.mediaUrl?.trim())) return 'Tin thiếu tệp nguồn nên chưa thể chuyển tiếp.';
  return null;
}

export function forwardMediaName(message: ZaloMessage): string {
  const filename = message.mediaMeta?.filename;
  return typeof filename === 'string' && filename.trim() ? filename : message.label || forwardMediaKind(message);
}

export function forwardMediaKind(message: ZaloMessage): string {
  return ({ image: 'Ảnh', video: 'Video', voice: 'Ghi âm', file: 'Tệp', sticker: 'Sticker', sys: 'Tin hệ thống' } as const)[message.type ?? 'sys'];
}

export function forwardMediaCaption(messages: ZaloMessage[]): string | undefined {
  const captions = messages.map(message => message.text?.trim())
    .filter((text): text is string => !!text && !/^\[(Hình ảnh|Video|Ghi âm|Tệp|File)\]$/i.test(text));
  return [...new Set(captions)].join('\n') || undefined;
}
