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
import { uploadFile, getPublicUrl, sanitizeStorageFileName } from '@/lib/storage';
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

async function uploadOne(accountId: string, conversationId: string, a: OutgoingAttachment) {
  const key = `${accountId}/${conversationId}/${Date.now()}_${sanitizeStorageFileName(a.file.name || 'file.bin')}`;
  await uploadFile(BUCKET, key, a.file);
  return {
    bucket: BUCKET,
    path: key,
    url: getPublicUrl(BUCKET, key),
    filename: a.file.name || 'file.bin',
    mime: a.file.type || 'application/octet-stream',
    size: a.file.size,
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    ...(a.durationMs ? { duration_ms: Math.round(a.durationMs) } : {}),
  };
}

export function useSendZaloMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      conversationId: string;
      accountId: string;
      kind: 'image' | 'file' | 'voice';
      attachments: OutgoingAttachment[];
      caption?: string;
    }): Promise<ZaloMessage[]> => {
      if (!v.attachments.length) throw new Error('Chưa chọn tệp nào');
      if (v.kind === 'image' && v.attachments.length > MAX_ALBUM) throw new Error(`Tối đa ${MAX_ALBUM} ảnh mỗi lần gửi`);
      for (const a of v.attachments) {
        if (a.file.size > MAX_MEDIA_BYTES) throw new Error(`Tệp "${a.file.name}" vượt 25MB`);
      }
      const media = [];
      for (const a of v.attachments) media.push(await uploadOne(v.accountId, v.conversationId, a));
      const { data, error } = await supabase.rpc('zalo_send_media', {
        p_conversation_id: v.conversationId,
        p_kind: v.kind,
        p_media: media,
        p_caption: v.caption?.trim() || undefined,
        p_cli_msg_id: crypto.randomUUID(),
      });
      if (error) throw error;
      return (Array.isArray(data) ? data : []).map(mapMsg);
    },
    onSuccess: (_rows, v) => {
      qc.invalidateQueries({ queryKey: QK.messages(v.conversationId) });
      qc.invalidateQueries({ queryKey: QK.conversations });
    },
    onError: (e: Error) => {
      toast.error(e?.message || 'Không gửi được media');
      console.error('zalo_send_media', e);
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
    onError: (e: Error) => { toast.error(e?.message || 'Không gửi được sticker'); },
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
      if (!jobId) return [];
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { data: job } = await supabase
          .from('zalo_send_queue')
          .select('status, result, last_error')
          .eq('id', jobId)
          .maybeSingle();
        if (job?.status === 'sent') return (job.result as unknown as StickerItem[]) || [];
        if (job?.status === 'failed') throw new Error(job.last_error || 'Không tìm được sticker');
      }
      throw new Error('Tìm sticker quá lâu — worker có đang chạy không?');
    },
    onError: (e: Error) => { toast.error(e?.message || 'Không tìm được sticker'); },
  });
}
