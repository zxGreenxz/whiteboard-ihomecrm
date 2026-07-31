/**
 * Tầng dữ liệu cho sự kiện trao thưởng + vòng xoay may mắn (/quayso).
 *
 * - Trang PUBLIC (sale, không đăng nhập) gọi RPC bằng FETCH THUẦN, không qua
 *   supabase-js: client supabase chờ navigator.locks của module auth trước mọi
 *   request — trong webview in-app (Zalo/Messenger iOS) lock này có thể deadlock
 *   sau suspend/restore → request treo vĩnh viễn. Cùng án lệ với
 *   PublicContractInvoicePage. Nhớ header `Content-Profile: public` vì PostgREST
 *   của dự án expose schema `api` mặc định.
 * - Trang ADMIN (trong app đã đăng nhập) đi qua supabase-js như mọi hook khác.
 * - Không đọc/ghi thẳng bảng: RLS bật không policy, RPC là cổng duy nhất.
 */

import { supabase } from '@/integrations/supabase/client';

/* ─────────────────────────────── Kiểu dữ liệu ─────────────────────────────── */

export interface LuckyTeamPublic {
  id: string;
  name: string;
  deals: number;
  topRank: number | null;
  topPrizeAmount: number | null;
  inWheel: boolean;
  checkedIn: boolean;
  checkedInAt: string | null;
  isMine: boolean;
  /** Hồ sơ nhận thưởng — server CHỈ trả cho chính đội đang xem. */
  payoutAccount: string | null;
  payoutBank: string | null;
  payoutHolder: string | null;
  proofName: string | null;
  hasProof: boolean;
}

export interface LuckyEventPublic {
  id: string;
  title: string;
  prizeLabel: string;
  prizeAmount: number;
  drawAt: string | null;
  status: 'open' | 'drawn' | 'closed';
  drawnAt: string | null;
  winnerTeamId: string | null;
  serverNow: string;
}

export interface LuckyPublicState {
  ok: boolean;
  reason?: string;
  event?: LuckyEventPublic;
  teams?: LuckyTeamPublic[];
}

export interface LuckyTeamAdmin
  extends Omit<LuckyTeamPublic, 'isMine' | 'hasProof' | 'proofName'> {
  code: string;
  proofPath: string | null;
  proofName: string | null;
  proofUploadedAt: string | null;
}

export interface LuckyEventAdmin extends LuckyEventPublic {
  createdAt: string;
  teams: LuckyTeamAdmin[];
}

export interface LuckyAdminState {
  ok: boolean;
  organizationId: string;
  events: LuckyEventAdmin[];
}

/* ─────────────────────────── RPC public (fetch thuần) ─────────────────────── */

async function publicRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/${fn}`;
  const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  // AbortSignal.timeout chưa có trên iOS cũ → tự dựng bằng AbortController.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Profile': 'public',
        apikey,
        Authorization: `Bearer ${apikey}`,
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC ${fn} ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchLuckyPublicState(eventId: string | null, code: string | null) {
  return publicRpc<LuckyPublicState>('lucky_public_state_v1', {
    p_event: eventId,
    p_code: code || null,
  });
}

export function luckyCheckin(code: string) {
  return publicRpc<LuckyPublicState>('lucky_checkin_v1', { p_code: code });
}

export function luckyDraw(eventId: string) {
  return publicRpc<LuckyPublicState>('lucky_draw_v1', { p_event: eventId });
}

export interface LuckyPayoutInput {
  payoutAccount?: string;
  payoutBank?: string;
  payoutHolder?: string;
  proofPath?: string;
  proofName?: string;
}

export function luckySavePayout(code: string, p: LuckyPayoutInput) {
  return publicRpc<LuckyPublicState>('lucky_save_payout_v1', { p_code: code, p });
}

export const PROOF_BUCKET = 'lucky-proofs';
export const PROOF_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Upload giấy cọc lên bucket private `lucky-proofs`.
 *
 * Dùng REST storage bằng fetch thuần với anon key — KHÔNG qua supabase-js, cùng
 * lý do như các RPC public (deadlock navigator.locks trong webview Zalo/iOS).
 * Anon chỉ có quyền INSERT nên không đọc chéo được file đội khác.
 * Đường dẫn: <eventId>/<uuid>.<ext> — policy INSERT bắt thư mục gốc là sự kiện
 * còn mở, và RPC lưu path cũng kiểm lại tiền tố này.
 */
export async function uploadLuckyProof(
  eventId: string,
  file: File,
): Promise<{ path: string; name: string }> {
  if (file.size > PROOF_MAX_BYTES) {
    throw new Error('Ảnh lớn hơn 10MB — chụp lại nhỏ hơn giúp mình nhé.');
  }
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = `${eventId}/${rand}.${ext}`;

  const url = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/${PROOF_BUCKET}/${path}`;
  const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey,
        Authorization: `Bearer ${apikey}`,
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': 'false',
        'cache-control': '3600',
      },
      body: file,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Upload lỗi ${res.status}`);
    return { path, name: file.name };
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────── RPC admin (supabase-js) ──────────────────────── */

// Cùng kiểu nới lỏng như callRpc của useOrganizationAuthorization: các RPC mới
// chưa có trong generated types (types.ts đang treo regen vì drift network_*).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (name: string, args?: Record<string, unknown>) => (supabase as any).rpc(name, args);

export async function adminRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(name, args);
  if (error) throw error;
  return data as T;
}

export const luckyAdminApi = {
  get: () => adminRpc<LuckyAdminState>('lucky_admin_get_v1'),
  upsertEvent: (p: {
    id?: string;
    title?: string;
    prizeLabel?: string;
    prizeAmount?: number;
    drawAt?: string | null;
    status?: 'open' | 'closed';
  }) => adminRpc<{ ok: boolean; eventId: string }>('lucky_admin_upsert_event_v1', { p }),
  addTeam: (p: {
    eventId: string;
    name: string;
    deals?: number;
    topRank?: number | null;
    topPrize?: number | null;
    inWheel?: boolean;
  }) =>
    adminRpc<{ ok: boolean; teamId: string; code: string }>('lucky_admin_add_team_v1', {
      p_event: p.eventId,
      p_name: p.name,
      p_deals: p.deals ?? 1,
      p_top_rank: p.topRank ?? null,
      p_top_prize: p.topPrize ?? null,
      p_in_wheel: p.inWheel ?? true,
    }),
  updateTeam: (
    teamId: string,
    p: {
      name?: string;
      deals?: number;
      topRank?: number | null;
      topPrizeAmount?: number | null;
      inWheel?: boolean;
      checkedIn?: boolean;
      regenCode?: boolean;
    },
  ) => adminRpc<{ ok: boolean; teamId: string; code: string }>('lucky_admin_update_team_v1', { p_team: teamId, p }),
  deleteTeam: (teamId: string) =>
    adminRpc<{ ok: boolean }>('lucky_admin_delete_team_v1', { p_team: teamId }),
  forceDraw: (eventId: string) =>
    adminRpc<LuckyPublicState>('lucky_admin_force_draw_v1', { p_event: eventId }),
  resetDraw: (eventId: string) =>
    adminRpc<{ ok: boolean }>('lucky_admin_reset_draw_v1', { p_event: eventId }),
};

/* ──────────────────────────────── Tiện ích ────────────────────────────────── */

const VND = new Intl.NumberFormat('vi-VN');
export const formatVnd = (n: number) => `${VND.format(n)}đ`;

/** Link công khai của sự kiện — đưa cho sale / dán vào group. */
export const luckyPublicUrl = (eventId: string) =>
  `${window.location.origin}/quayso?e=${eventId}`;

/** Lệch giờ server-client (ms): serverNow của payload trừ Date.now() lúc nhận. */
export function serverClockOffset(serverNowIso: string): number {
  return new Date(serverNowIso).getTime() - Date.now();
}
