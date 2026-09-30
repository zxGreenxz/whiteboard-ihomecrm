import { useRef } from 'react';
import { notifyActionError } from '@/lib/actionFeedback';
// Gửi media (ảnh/file/voice/sticker) từ web — bucket private `zalo-media`.
//
// Luồng: upload từng tệp lên Supabase Storage (đường `uploadFile` chung của
// repo — tự nén ảnh, tự route R2 nếu sau này bucket vào r2Config) → RPC
// `zalo_send_media` ghi N dòng message pending + 1 job → worker tải bytes và
// gửi qua zca. media_url lưu URL TỰ HOST nên reload vẫn render được (bài học
// WEB2 §13.12). KHÔNG cast `as any` — RPC đã có trong generated types.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { uploadFileDetailed, sanitizeStorageFileName } from '@/lib/storage';
import { QK, mapMsg } from '@/hooks/useZaloChat';
import type { ZaloMessage } from '@/components/chat-zalo/types';

const BUCKET = 'zalo-media';
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_ALBUM = 12;

export interface OutgoingAttachment {
  file: File;
  width?: number;
  height?: number;
  durationMs?: number;
}

/** Tên file mang đuôi của file THẬT trong kho (ảnh nén đổi .jpeg/.png → .jpg/.webp). */
function withStoredExtension(name: string, storedPath: string): string {
  const ext = /\.[^./]+$/.exec(storedPath)?.[0];
  if (!ext) return name;
  return /\.[^./]+$/.test(name) ? name.replace(/\.[^./]+$/, ext) : name + ext;
}

async function uploadOne(accountId: string, conversationId: string, a: OutgoingAttachment) {
  const key = `${accountId}/${conversationId}/${Date.now()}_${sanitizeStorageFileName(a.file.name || 'file.bin')}`;
  // Nén ảnh có thể đổi đuôi key: worker tải ĐÚNG `path` của job (worker/lib/media.js),
  // nên job phải mang đường dẫn/định dạng/cỡ của file thật, không phải key tự tính.
  const stored = await uploadFileDetailed(BUCKET, key, a.file);
  return {
    bucket: BUCKET,
    path: stored.path,
    url: stored.url,
    filename: withStoredExtension(a.file.name || 'file.bin', stored.path),
    mime: stored.type || a.file.type || 'application/octet-stream',
    size: stored.size,
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    ...(a.durationMs ? { duration_ms: Math.round(a.durationMs) } : {}),
  };
}

type MediaInput = { conversationId: string; accountId: string; kind: 'image' | 'file' | 'voice'; attachments: OutgoingAttachment[]; caption?: string };
type UploadedMedia = Awaited<ReturnType<typeof uploadOne>>;
class MediaValidationError extends Error {}
export class ZaloMediaSendError extends Error {
  constructor(public readonly uploaded: UploadedMedia[], public readonly outcomeUnknown: boolean, public readonly clientMessageId: string, message: string, public readonly cause?: unknown) { super(message); this.name = 'ZaloMediaSendError'; }
}
/** Retains completed upload steps. Queue requests with unknown outcomes are never submitted twice. */
export function createZaloMediaSender() {
  let batch: { conversationId: string; files: File[]; uploaded: UploadedMedia[]; clientMessageId: string; unknown?: ZaloMediaSendError } | null = null;
  return async (v: MediaInput): Promise<ZaloMessage[]> => {
    if (!v.attachments.length) throw new MediaValidationError('Chưa chọn tệp nào.');
    if (v.kind === 'image' && v.attachments.length > MAX_ALBUM) throw new MediaValidationError(`Tối đa ${MAX_ALBUM} ảnh mỗi lần gửi.`);
    for (const a of v.attachments) if (a.file.size > MAX_MEDIA_BYTES) throw new MediaValidationError(`Tệp “${a.file.name}” vượt 25MB. Chọn tệp nhỏ hơn.`);
    // A length mismatch short-circuits before comparing each matching attachment index.
    if (!batch || batch.conversationId !== v.conversationId || batch.files.length !== v.attachments.length || batch.files.some((file,index) => file !== v.attachments[index]!.file)) {
      batch = {conversationId:v.conversationId,files:v.attachments.map(a=>a.file),uploaded:[],clientMessageId:crypto.randomUUID()};
    }
    const pendingBatch = batch;
    if (pendingBatch.unknown) throw pendingBatch.unknown;
    while (pendingBatch.uploaded.length < v.attachments.length) {
      // The while condition proves this attachment index is within the input array.
      const attachment = v.attachments[pendingBatch.uploaded.length]!;
      try { pendingBatch.uploaded.push(await uploadOne(v.accountId,v.conversationId,attachment)); }
      catch (cause) { throw new ZaloMediaSendError([...pendingBatch.uploaded],false,pendingBatch.clientMessageId,`Đã tải ${pendingBatch.uploaded.length}/${v.attachments.length} tệp. Chưa tải được “${attachment.file.name}”; chưa gửi yêu cầu Zalo. Các tệp đã tải được giữ để tiếp tục phần còn lại.`,cause); }
    }
    try {
      const {data,error} = await supabase.rpc('zalo_send_media',{p_conversation_id:v.conversationId,p_kind:v.kind,p_media:pendingBatch.uploaded,p_caption:v.caption?.trim() || undefined,p_cli_msg_id:pendingBatch.clientMessageId});
      if (error) throw error;
      if (!Array.isArray(data) || data.length !== v.attachments.length || data.some(row=>!row || typeof row.id !== 'string')) throw new Error('Unconfirmed media queue response');
      const rows=data.map(mapMsg); batch=null; return rows;
    } catch (cause) {
      pendingBatch.unknown=new ZaloMediaSendError([...pendingBatch.uploaded],true,pendingBatch.clientMessageId,`Đã tải ${pendingBatch.uploaded.length} tệp, nhưng chưa xác nhận được kết quả tiếp nhận tin Zalo. Giữ bản soạn và kiểm tra cuộc trò chuyện trước khi gửi thêm.`,cause);
      throw pendingBatch.unknown;
    }
  };
}
export function useSendZaloMedia() {
  const qc = useQueryClient();
  const sender = useRef<ReturnType<typeof createZaloMediaSender> | null>(null);
  if (!sender.current) sender.current=createZaloMediaSender();
  return useMutation({
    mutationFn: sender.current,
    onSuccess: (_rows,v) => { qc.invalidateQueries({queryKey:QK.messages(v.conversationId)});qc.invalidateQueries({queryKey:QK.conversations}); },
    onError: (error: Error) => {
      if (error instanceof MediaValidationError) toast.error(error.message);
      else if (error instanceof ZaloMediaSendError) toast.warning(error.message);
      else notifyActionError(error,'Chưa xác nhận được kết quả gửi tệp Zalo');
    },
  });
}

export interface StickerItem { id: number; cateId: number; type: number; url?: string | null; text?: string | null }

export function useSendZaloSticker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { conversationId: string; sticker: StickerItem }) => {
      const { data, error } = await supabase.rpc('zalo_send_media', {
        p_conversation_id: v.conversationId,
        p_kind: 'sticker',
        p_media: [],
        p_sticker: { id: v.sticker.id, cateId: v.sticker.cateId, type: v.sticker.type },
        p_cli_msg_id: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) });
      qc.invalidateQueries({ queryKey: QK.conversations });
    },
    onError: (e: Error) => { notifyActionError(e, 'Không gửi được sticker'); },
  });
}

// Tìm sticker: RPC tạo job async → poll dòng queue theo id (RLS org cho đọc).
// KHÔNG thêm channel realtime — poll ngắn có trần là đủ cho picker.
export function useStickerSearch() {
  return useMutation({
    mutationFn: async (v: { accountId: string; keyword: string }): Promise<StickerItem[]> => {
      const { data, error } = await supabase.rpc('zalo_sticker_search', {
        p_account_id: v.accountId, p_keyword: v.keyword,
      });
      if (error) throw error;
      const jobId = (data as { job_id?: string } | null)?.job_id;
      if (!jobId) throw new Error('Unconfirmed sticker search request');
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { data: job, error: jobError } = await supabase
          .from('zalo_send_queue')
          .select('status, result, last_error')
          .eq('id', jobId)
          .maybeSingle();
        if (jobError) throw jobError;
        if (job?.status === 'sent') return (job.result as unknown as StickerItem[]) || [];
        if (job?.status === 'failed') throw new Error(job.last_error || 'Không tìm được sticker');
      }
      throw new Error('Tìm sticker quá lâu — worker có đang chạy không?');
    },
    onError: (e: Error) => { notifyActionError(e, 'Không tìm được sticker'); },
  });
}
