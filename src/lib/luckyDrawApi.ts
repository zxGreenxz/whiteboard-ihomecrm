import { parseLuckyState, parseLuckyAdminState, PublicRequestError } from './publicFeedback';
import { z } from 'zod';
import { persistentFinancialWorkflow } from './persistentFinancialWorkflow';
import { FinancialWorkflowError, FinancialWorkflowGuard, RepeatableWriteUnknownError, type PendingReconciliation } from './financialWorkflow';
import { financialPending, formatPendingTime, isAttemptRunning } from './financialPending';
import { getSessionUser } from './authSession';
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

import type { PostgrestError } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

/* ─────────────────────────────── Kiểu dữ liệu ─────────────────────────────── */

export interface LuckyTeamPublic {
  id: string;
  name: string;
  /**
   * Mã sale sở hữu tấm vé (vd `1392QT`). Một sale có thể ôm nhiều vé — đó chính
   * là ý nghĩa của "càng nhiều vé cơ hội càng cao". CHỈ dùng để gom nhóm khi
   * cộng sổ và hiển thị; phép bốc luôn chạy trên VÉ, không trên người.
   */
  sale: string | null;
  deals: number;
  topRank: number | null;
  topPrizeAmount: number | null;
  inWheel: boolean;
  checkedIn: boolean;
  checkedInAt: string | null;
  isMine: boolean | null;
  /** Hồ sơ nhận thưởng — server CHỈ trả cho chính đội đang xem. */
  payoutAccount: string | null;
  payoutBank: string | null;
  payoutHolder: string | null;
  proofs: LuckyProof[];
  proofCount: number;
}

export interface LuckyProof {
  path: string;
  name: string;
  at?: string;
}

/**
 * Trò chơi dùng để CÔNG BỐ kết quả. Chủ giải chọn lúc tổ chức (cột
 * `lucky_events.game`). Đây thuần là cách diễn lại — đội trúng vẫn do
 * `lucky_draw_v1` chốt một lần trên server, không trò nào đụng được vào.
 * Thêm trò mới: nới CHECK ở migration, thêm nhánh ở đây và ở hai trang công khai.
 */
export type LuckyGame = 'wheel' | 'race';

export const LUCKY_GAMES: { value: LuckyGame; label: string; hint: string }[] = [
  { value: 'wheel', label: '🎡 Vòng xoay may mắn', hint: 'Bánh xe quay, kim dừng ở đội trúng.' },
  { value: 'race', label: '🏇 Đua thú', hint: 'Mỗi đội một con thú, con của đội trúng về nhất.' },
];

/** Sự kiện cũ tạo trước khi có cột `game` → coi như vòng xoay. */
export function luckyGameOf(g: string | null | undefined): LuckyGame {
  return g === 'race' ? 'race' : 'wheel';
}

export interface LuckyEventPublic {
  id: string;
  /** Đường dẫn ngắn: /quayso/<slug>. */
  slug: string | null;
  title: string;
  prizeLabel: string;
  prizeAmount: number;
  drawAt: string | null;
  status: 'open' | 'drawn' | 'closed';
  drawnAt: string | null;
  winnerTeamId: string | null;
  /** Trò chơi công bố kết quả. Sự kiện cũ có thể thiếu → dùng `luckyGameOf`. */
  game: LuckyGame | null;
  /** Độ dài một lượt đua (giây), 8–45. Thiếu → mặc định 20. */
  raceSeconds: number | null;
  serverNow: string;
}

/**
 * Một LƯỢT đua. Sự kiện có thể chia nhiều lượt, mỗi lượt trao `winnersCount`
 * suất cùng mệnh giá. Đua xong lượt này mới sang lượt sau.
 *
 * Mỗi lượt bốc lại từ TOÀN BỘ vé đã điểm danh — vé trúng lượt trước vẫn có cửa,
 * vì thể lệ là "1 người trúng được nhiều giải". Trong cùng một lượt thì các suất
 * chắc chắn khác vé nhau (server ràng buộc bằng UNIQUE).
 */
export interface LuckyRoundPublic {
  id: string;
  /** Thứ tự lượt, bắt đầu từ 1. Cũng là khoá idempotent khi gọi chốt kết quả. */
  ordinal: number;
  label: string;
  amount: number;
  winnersCount: number;
  status: 'pending' | 'drawn';
  drawnAt: string | null;
  winners: LuckyRoundWinner[];
}

export interface LuckyRoundWinner {
  teamId: string;
  /** Thứ hạng trong lượt, bắt đầu từ 1. */
  position: number;
  amount: number;
}

export interface LuckyPublicState {
  ok: boolean;
  reason?: string;
  event?: LuckyEventPublic;
  teams?: LuckyTeamPublic[];
  /** Rỗng = sự kiện một giải kiểu cũ (dùng `event.winnerTeamId`). */
  rounds?: LuckyRoundPublic[];
}

export interface LuckyTeamAdmin
  extends Omit<LuckyTeamPublic, 'isMine' | 'proofCount'> {
  code: string;
  proofUploadedAt: string | null;
}

export interface LuckyEventAdmin extends LuckyEventPublic {
  createdAt: string;
  teams: LuckyTeamAdmin[];
  rounds: LuckyRoundPublic[];
}

/** Một dòng trong bảng thể lệ ở trang quản trị. */
export interface LuckyRoundInput {
  label?: string;
  amount: number;
  winnersCount: number;
}

export interface LuckyAdminState {
  ok: boolean;
  organizationId: string;
  events: LuckyEventAdmin[];
}

/* ─────────────────────────── RPC public (fetch thuần) ─────────────────────── */

async function publicRpc(fn: string, args: Record<string, unknown>): Promise<LuckyPublicState> {
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
    if (!res.ok) throw new PublicRequestError(res.status);
    return parseLuckyState(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

export function fetchLuckyPublicState(
  eventId: string | null,
  code: string | null,
  slug: string | null = null,
) {
  return publicRpc('lucky_public_state_v1', {
    p_event: eventId,
    p_code: code || null,
    p_slug: slug || null,
  });
}

export function luckyCheckin(code: string) {
  return publicRpc('lucky_checkin_v1', { p_code: code });
}

/** Kết quả của một lệnh quay. `replayed`: lần bấm trước đã quay xong, lần này chỉ đọc lại kết quả đó (không gửi lệnh quay). */
export type LuckyDrawResult = LuckyPublicState & { replayed?: boolean };

/**
 * Quay công khai (đợt 9, cách C). Thân hàm production `lucky_draw_v1` (md5 baefd8cc, đọc 26/11/2026) khoá dòng sự kiện
 * `FOR UPDATE` RỒI MỚI xét trạng thái; đã quay thì trả lại đúng kết quả cũ, không bốc lại. Lần gửi trước chưa rõ kết quả
 * (dấu `lucky-public-draw`, khoá = mã sự kiện): đọc trạng thái công khai — đã quay ⇒ nhận kết quả đó, không gửi lệnh quay;
 * chưa quay ⇒ gửi lại ngay (lệnh cũ có còn chạy thì máy chủ cũng chỉ quay một lần); đọc hỏng ⇒ chưa kết luận, giữ dấu và
 * lần mở trang sau đọc lại. Người xem ẩn danh không thấy hộp cảnh báo (`silent`), nên dấu không bao giờ được kẹt ở «chưa
 * kết luận» khi đọc được trạng thái.
 */
const publicDrawGuard = new FinancialWorkflowGuard({ scope: async businessKey => ({
  namespace: 'lucky-public-draw', userId: 'public-viewer', organizationId: 'public-event', businessKey,
}) });
export function luckyDraw(eventId: string): Promise<LuckyDrawResult> {
  const intent: DrawIntent = { eventId, ordinal: null };
  return publicDrawGuard.run<LuckyDrawResult>(eventId, 'xác nhận kết quả quay', async () => {
    const result = await publicRpc('lucky_draw_v1', { p_event: eventId });
    if (!result.ok && result.reason && knownDrawRefusals.has(result.reason)) return result;
    if (!confirmsDraw(result, intent)) throw invalidReceipt();
    return result;
  }, async () => drawVerdict(await fetchLuckyPublicState(eventId, null), intent));
}

/**
 * CHỐT LƯỢT LÀ VIỆC CỦA QUẢN TRỊ — xem `luckyAdminApi.drawRound`.
 *
 * Từ 23/08/2026 `lucky_draw_round_v1` KHÔNG còn cấp quyền cho `anon`. Bản
 * public cũ đã bị gỡ khỏi đây để không ai vô tình gọi lại: nó chỉ trả 401.
 *
 * Vì sao đổi: link màn chiếu vốn công khai, nên khi hàm còn mở cho anon thì một
 * người cầm link có thể bấm liên tiếp và ĐỐT SẠCH cả 3 lượt trước khi chủ giải
 * kịp giới thiệu lượt nào. Với sự kiện MỘT giải thì án lệ 20260731130000 chấp
 * nhận được (chốt một lần rồi khoá, ai bấm cũng thế); với nhiều lượt thì không.
 * "Giao diện người xem không có nút" không phải hàng rào — RPC gọi thẳng được.
 */

/** Lượt đầu tiên chưa quay; null = đã xong hết (hoặc sự kiện không chia lượt). */
export function nextPendingRound(rounds: LuckyRoundPublic[] | undefined): LuckyRoundPublic | null {
  if (!rounds?.length) return null;
  return [...rounds].sort((a, b) => a.ordinal - b.ordinal)
    .find((r) => r.status !== 'drawn') ?? null;
}

/** Tổng tiền của cả sự kiện chia lượt. */
export function totalRoundsPrize(rounds: LuckyRoundPublic[] | undefined): number {
  return (rounds ?? []).reduce((s, r) => s + r.amount * r.winnersCount, 0);
}

/**
 * Cộng sổ theo SALE, không theo vé: một sale ôm nhiều vé trúng thì gộp lại thành
 * một dòng. Vé không khai sale thì đứng tên chính nó.
 */
export function tallyBySale(
  rounds: LuckyRoundPublic[] | undefined,
  teams: LuckyTeamPublic[],
): { sale: string; total: number }[] {
  const ten = new Map(teams.map((t) => [t.id, t.sale?.trim() || t.name]));
  const m = new Map<string, number>();
  for (const r of rounds ?? []) {
    for (const w of r.winners) {
      const k = ten.get(w.teamId) ?? '—';
      m.set(k, (m.get(k) ?? 0) + w.amount);
    }
  }
  return [...m.entries()]
    .map(([sale, total]) => ({ sale, total }))
    .sort((a, b) => b.total - a.total || a.sale.localeCompare(b.sale));
}

export interface LuckyPayoutInput {
  payoutAccount?: string;
  payoutBank?: string;
  payoutHolder?: string;
  /** NGUYÊN danh sách giấy cọc (thay thế toàn bộ) — thêm/bớt đều gửi cả list. */
  proofs?: LuckyProof[];
}

/** Tối đa 10 tấm giấy cọc mỗi đội (server cũng cắt ở 10). */
export const PROOF_MAX_FILES = 10;

export function luckySavePayout(code: string, p: LuckyPayoutInput) {
  return publicRpc('lucky_save_payout_v1', { p_code: code, p });
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
 *
 * Đợt 9 (mẫu PR #478): MỖI LẦN TẢI LÀ MỘT ĐƯỜNG DẪN MỚI (`x-upsert: false`) và đường dẫn chỉ vào danh sách giấy cọc của đội
 * khi tải xong (biên nhận dương) rồi được `lucky_save_payout_v1` lưu. Lần tải chưa rõ kết quả nhiều nhất để lại một tệp
 * mồ côi chưa gắn vào đội nào (bucket private, anon không đọc được), nên tải lại luôn an toàn: không còn ghi dấu «đã lên
 * kế hoạch tải» trước khi gửi.
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
  const proof = { path, name: file.name };

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
    if (!res.ok) throw new PublicRequestError(res.status);
    return proof;
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────── RPC admin (supabase-js) ──────────────────────── */

/**
 * Nhận một THUNK, không nhận (tên hàm, args) — cùng lý do như `callRpc` ở
 * useOrganizationAuthorization: supabase-js phân giải overload bằng kiểu điều
 * kiện trên TÊN HÀM, nên tên phải là literal ngay tại chỗ gọi `supabase.rpc()`.
 *
 * Comment cũ ở đây nói cả 7 hàm `lucky_admin_*_v1` "chưa có trong generated
 * types (types.ts đang treo regen vì drift network_*)". Đã kiểm lại: cả 7 đều
 * có đủ Args/Returns trong types.ts, và cái drift network_* kia đã xử xong bằng
 * types:normalize. Lời giải thích đó nay chỉ còn tác dụng hợp thức hoá việc né
 * kiểm tra kiểu, nên thay bằng mô tả đúng.
 *
 * Lấy lại được: tên hàm, tên tham số, kiểu tham số — đều được đối chiếu thật.
 * KHÔNG lấy lại được: `as T` vẫn là khẳng định về hình dạng trả về (các hàm này
 * khai `RETURNS json`), và thiếu tham số bắt buộc vẫn lọt. Đừng đọc helper này
 * như một bảo đảm toàn phần.
 */
export async function adminRpc(
  run: () => PromiseLike<{ data: unknown; error: PostgrestError | null }>,
): Promise<unknown> {
  const { data, error } = await run();
  if (error) throw error;
  if (!data || typeof data !== "object" || typeof (data as { ok?: unknown }).ok !== "boolean") throw new PublicRequestError(0, "invalid-response");
  return data;
}

/*
 * Thao tác quản trị Quay số (đợt 9). Bản trước giữ MỘT dấu chung `lucky-admin` (khoá = mã sự kiện) cho cả 9 thao tác:
 * điểm danh hay sửa đội chưa rõ kết quả cũng khoá nút quay, và hàm đối chiếu chỉ hiểu lệnh quay nên dấu kẹt mãi.
 *
 * - Lệnh QUAY (mở lượt, quay ngay) giữ dấu riêng, khoá `draw:<sự kiện>`, cách C. Thân hàm production `lucky_draw_round_v1`
 *   (md5 a847eb2d) và `lucky_admin_force_draw_v1` (01f0d93a), đọc 26/11/2026: khoá dòng sự kiện `FOR UPDATE` TRƯỚC khi xét
 *   lượt / sự kiện đã quay chưa; đã quay thì trả lại kết quả cũ, không bốc lại (`lucky_round_winners` còn duy nhất (lượt,
 *   đội) và (lượt, thứ hạng)). Lần bấm sau một lần chưa rõ đọc trạng thái NGOÀI vùng giữ dấu: đã quay ⇒ nhận đúng kết quả
 *   đó, không gửi; chưa quay ⇒ gửi lại ngay; đọc hỏng ⇒ không gửi gì.
 * - Bảy thao tác còn lại ghi lặp lại được (đặt giá trị theo mã, hoặc thay cả bộ trong một giao dịch): không ghi dấu, chưa rõ
 *   thì báo và cho bấm lại. Thêm đội: máy chủ có duy nhất (sự kiện, tên) `lucky_event_teams_event_id_name_key`. Tạo sự
 *   kiện: hàm máy chủ tự sinh mã nên trình duyệt gửi kèm một đường dẫn ngắn ngẫu nhiên, duy nhất toàn hệ thống
 *   (`lucky_events_slug_key`), nhớ theo tab cho tới khi tạo xong.
 * - Dấu chung bản trước (khoá = mã sự kiện, hoặc `new-event`) không còn chặn gì; gỡ sau lần ghi thành công kế tiếp.
 */
const adminWriteGuard = persistentFinancialWorkflow('lucky-admin', { scope: 'actor' });
const drawKey = (eventId: string) => 'draw:' + eventId;
const drawScope = (userId: string, eventId: string) => ({ namespace: 'lucky-admin', userId, organizationId: 'actor-scope', businessKey: drawKey(eventId) });
type DrawIntent = { eventId: string; ordinal: number | null };
/** Ý định quay của BẢN TRƯỚC, lưu riêng theo mã yêu cầu. Bản này lưu lượt vào `meta` của dấu; khoá cũ chỉ còn được gỡ. */
const legacyDrawIntentKey = (requestKey: string) => 'ihome:lucky-draw-intent:v1:' + requestKey;
/** Gỡ dấu chung `lucky-admin` bản trước của đúng khoá (mã sự kiện / `new-event`) sau một lần ghi thành công; không ném lỗi. */
async function forgetLegacyAdmin(businessKey: string): Promise<void> {
  try {
    const { settleLegacyPending } = await import('./legacyPendingExit');
    await settleLegacyPending({ namespace: 'lucky-admin', businessKey }, async pending => {
      try { localStorage.removeItem(legacyDrawIntentKey(pending.requestKey ?? pending.attemptId)); }
      catch { /* Ý định quay cũ chỉ còn là một khoá thừa, không chặn gì. */ }
      return true;
    }, { organizationId: 'actor-scope' });
  } catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần ghi sau gỡ lại. */ }
}
/**
 * Ghi lặp lại được: không giữ dấu. Lời từ chối rõ đi nguyên; chưa rõ (mạng, 5xx, biên nhận hay bản đọc lại sai dạng) ⇒
 * `RepeatableWriteUnknownError`, form không khoá, bấm lại cho cùng kết quả. `advice` thay câu dặn mặc định.
 */
async function repeatable<T>(operation: string, task: () => Promise<T>, advice?: string): Promise<T> {
  const { repeatableWrite } = await import('./recordWriteOutcome');
  try {
    return await repeatableWrite(operation, async () => {
      try { return await task(); }
      catch (error) {
        if (error instanceof PublicRequestError) throw new FinancialWorkflowError(`Chưa xác nhận được kết quả ${operation}.`, 'unknown', [], error);
        throw error;
      }
    });
  } catch (error) {
    if (advice && error instanceof RepeatableWriteUnknownError) throw new RepeatableWriteUnknownError(operation, error.cause, error.completed, advice);
    throw error;
  }
}
const getAdminState = async () => parseLuckyAdminState(await adminRpc(() => supabase.rpc('lucky_admin_get_v1')));
const invalidReceipt = () => new PublicRequestError(0, 'invalid-response');
function checkedReceipt<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  if (value && typeof value === 'object' && 'ok' in value && value.ok === false &&
      'reason' in value && typeof value.reason === 'string' && ['not_found', 'forbidden', 'closed'].includes(value.reason)) {
    throw new FinancialWorkflowError(value.reason === 'forbidden' ? 'Bạn không có quyền quản trị sự kiện này.' : value.reason === 'closed' ? 'Sự kiện đã đóng. Tải lại trạng thái trước khi tiếp tục.' : 'Đội hoặc sự kiện không còn tồn tại. Tải lại danh sách trước khi tiếp tục.', 'failure', []);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw invalidReceipt();
  return result.data;
}
const teamReceipt = z.object({ ok: z.literal(true), teamId: z.string().min(1), code: z.string().regex(/^\d{6,8}$/) });
const ackReceipt = z.object({ ok: z.literal(true) });
async function requireAdminEvent(eventId: string) {
  const source = await getAdminState();
  const event = source.events.find(e => e.id === eventId);
  if (!event) throw new FinancialWorkflowError('Sự kiện không còn trong danh sách bạn được quản lý. Tải lại danh sách trước khi tiếp tục.', 'failure', []);
  return { source, event };
}
async function requireAdminTeam(teamId: string) {
  const source = await getAdminState();
  const event = source.events.find(e => e.teams.some(t => t.id === teamId));
  if (!event) throw new FinancialWorkflowError('Đội không còn trong danh sách bạn được quản lý. Tải lại danh sách trước khi tiếp tục.', 'failure', []);
  return { source, event };
}
function publicFromAdmin(event: LuckyEventAdmin): LuckyPublicState {
  return { ok: true, event, rounds: event.rounds, teams: event.teams.map(t => ({ ...t, isMine: null, proofCount: t.proofs.length })) };
}
function confirmsDraw(state: LuckyPublicState, intent: DrawIntent): boolean {
  if (!state.ok || state.event?.id !== intent.eventId) return false;
  if (intent.ordinal !== null) {
    const round = state.rounds?.find(r => r.ordinal === intent.ordinal);
    return !!round && round.status === 'drawn' && !!round.drawnAt && round.winners.length > 0;
  }
  return state.event.status === 'drawn' && !!state.event.drawnAt && !!state.event.winnerTeamId;
}
const knownDrawRefusals = new Set(['forbidden', 'not_found', 'closed', 'not_time', 'round_not_found', 'previous_round_pending', 'no_checked_in_teams']);
/** Lượt / sự kiện của lệnh quay đã «đã quay» trên máy chủ (kể cả khi đội trúng đã bị xoá sau đó). */
function drawReached(state: LuckyPublicState, intent: DrawIntent): boolean {
  if (!state.ok || state.event?.id !== intent.eventId) return false;
  if (intent.ordinal === null) return state.event.status === 'drawn';
  return state.rounds?.some(r => r.ordinal === intent.ordinal && r.status === 'drawn') ?? false;
}
/**
 * Kết luận cho dấu của một lệnh quay chưa rõ, từ trạng thái vừa đọc được (đọc hỏng thì nơi gọi ném lỗi, lõi giữ dấu).
 * Đã quay ⇒ nhận đúng kết quả đó, không gửi lệnh quay. Chưa quay, hoặc sự kiện không còn (máy chủ sẽ từ chối rõ) ⇒ gửi lại
 * ngay: hàm quay khoá dòng sự kiện rồi mới xét «đã quay», nên gửi lại sớm (kể cả khi lệnh cũ còn đang chạy) cũng không quay
 * hai lần. Cờ `serverDedupesRequestKey` ở đây nghĩa là «máy chủ tự chống quay trùng», không phải máy chủ nhận mã yêu cầu.
 */
function drawVerdict(state: LuckyPublicState, intent: DrawIntent): PendingReconciliation<LuckyDrawResult> {
  if (state.ok && state.event?.id !== intent.eventId) return null;
  if (drawReached(state, intent)) return { result: { ...state, replayed: true } };
  return { outcome: 'not-written', serverDedupesRequestKey: true };
}
async function runAdminDraw(intent: DrawIntent, run: () => PromiseLike<{ data: unknown; error: PostgrestError | null }>): Promise<LuckyDrawResult> {
  // Đọc trạng thái TRƯỚC khi ghi dấu (ngoài vùng giữ dấu): hàm đối chiếu dùng bản đọc này nếu còn dấu của lần bấm trước.
  // Đọc hỏng ⇒ dừng ở đây, không gửi lệnh quay nào.
  const before = publicFromAdmin((await requireAdminEvent(intent.eventId)).event);
  const operation = intent.ordinal === null ? 'quay sự kiện' : `chốt lượt quay ${intent.ordinal}`;
  const result = await adminWriteGuard.run<LuckyDrawResult>(drawKey(intent.eventId), operation, async () => {
    const state = parseLuckyState(await adminRpc(run));
    if (!state.ok) {
      if (!state.reason || !knownDrawRefusals.has(state.reason)) throw invalidReceipt();
      return state; // Các nhánh SQL này trả về trước khi ghi.
    }
    if (!confirmsDraw(state, intent)) throw invalidReceipt();
    return state;
  }, async () => drawVerdict(before, intent), undefined, { meta: { ordinal: intent.ordinal } });
  await forgetLegacyAdmin(intent.eventId);
  return result;
}
/** Sự kiện đang mở và không còn kết quả quay nào: đích của «đặt lại kết quả». */
const drawCleared = (e: LuckyEventAdmin) => e.status === 'open' && e.drawnAt === null && e.winnerTeamId === null &&
  e.rounds.every(r => r.status === 'pending' && r.drawnAt === null && r.winners.length === 0);
const refused = (value: unknown, reason: string) => !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false && (value as { reason?: unknown }).reason === reason;
const eventReceipt = z.object({ ok: z.literal(true), eventId: z.string().min(1), slug: z.string().nullable(), game: z.enum(['wheel', 'race']) });
type LuckyEventInput = {
  id?: string; title?: string; slug?: string; prizeLabel?: string; prizeAmount?: number;
  drawAt?: string | null; status?: 'open' | 'closed'; game?: LuckyGame; raceSeconds?: number;
};
type LuckyEventSaved = z.infer<typeof eventReceipt> & { replayed?: boolean };
/** Đường dẫn ngắn do tab này sinh cho sự kiện mới đang chờ tạo (một sự kiện mới mỗi tổ chức), giữ tới khi tạo xong. */
let pendingNewEvent: { organizationId: string; slug: string } | null = null;
async function createEvent(p: LuckyEventInput): Promise<LuckyEventSaved> {
  const { organizationId } = await getAdminState();
  const own = !p.slug?.trim();
  if (own && pendingNewEvent?.organizationId !== organizationId) {
    pendingNewEvent = { organizationId, slug: 'qs-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10) };
  }
  const slug = own ? pendingNewEvent!.slug : p.slug!.trim().toLowerCase();
  try {
    const result = await repeatable('tạo sự kiện quay số', async () => {
      const result = checkedReceipt(eventReceipt, await adminRpc(() => supabase.rpc('lucky_admin_upsert_event_v1', { p: { ...p, slug } })));
      if (result.slug !== slug) throw invalidReceipt();
      return result;
    });
    if (own) pendingNewEvent = null;
    await forgetLegacyAdmin('new-event');
    return result;
  } catch (error) {
    if (!own || !error || typeof error !== 'object' || (error as { code?: unknown }).code !== '23505') throw error;
    // Đường dẫn ngẫu nhiên do chính tab này sinh đã có sự kiện của tổ chức mình: lần bấm trước đã tạo. Không tạo thêm.
    const source = await repeatable('kiểm tra sự kiện vừa tạo', getAdminState);
    pendingNewEvent = null;
    const created = source.events.find(e => e.slug === slug);
    if (!created) throw error;
    await forgetLegacyAdmin('new-event');
    return { ok: true, eventId: created.id, slug: created.slug, game: luckyGameOf(created.game), replayed: true };
  }
}

/** Kết luận của «Tải lại trạng thái» cho một lệnh quay chưa rõ kết quả. */
export type LuckyDrawReconciliation =
  | { outcome: 'none' }
  | { outcome: 'drawn'; ordinal: number | null; state: LuckyPublicState }
  | { outcome: 'not-drawn'; ordinal: number | null }
  /** Dấu thiếu lượt (hỏng dạng): không biết lần trước quay lượt nào; gửi lại vẫn an toàn nên vẫn gỡ dấu. */
  | { outcome: 'unknown-intent' };

export const luckyAdminApi = {
  get: getAdminState,
  upsertEvent: async (p: LuckyEventInput): Promise<LuckyEventSaved> => {
    if (!p.id) return createEvent(p);
    const id = p.id;
    await requireAdminEvent(id);
    // Sửa theo mã: đặt giá trị tuyệt đối (thân hàm production 11dd61e8), chạy lại cho cùng kết quả.
    const result = await repeatable('lưu sự kiện quay số', async () => {
      const result = checkedReceipt(eventReceipt, await adminRpc(() => supabase.rpc('lucky_admin_upsert_event_v1', { p })));
      if (result.eventId !== id) throw invalidReceipt();
      return result;
    });
    await forgetLegacyAdmin(id);
    return result;
  },
  drawRound: (eventId: string, ordinal: number) => runAdminDraw({ eventId, ordinal }, () => supabase.rpc('lucky_draw_round_v1', { p_event: eventId, p_ordinal: ordinal })),
  setRounds: async (eventId: string, rounds: LuckyRoundInput[]) => {
    const before = await requireAdminEvent(eventId);
    // Xoá rồi chèn lại cả bộ lượt trong MỘT hàm (một giao dịch, 9906fdf5), từ chối khi đã quay: chạy lại cho cùng kết quả.
    const result = await repeatable('lưu thể lệ quay số', async () => {
      const result = checkedReceipt(z.object({ ok: z.literal(true), rounds: z.number().int().nonnegative() }), await adminRpc(() => supabase.rpc('lucky_admin_set_rounds_v1', {
        p_event: eventId, p_rounds: rounds.map(r => ({ label: r.label ?? '', amount: r.amount, winnersCount: r.winnersCount })),
      })));
      const after = await requireAdminEvent(eventId);
      // The equal-length check short-circuits before indexing the submitted round array.
      if (result.rounds !== rounds.length || after.source.organizationId !== before.source.organizationId ||
          after.event.rounds.length !== rounds.length || after.event.rounds.some((r, i) => r.ordinal !== i + 1 || r.amount !== rounds[i]!.amount || r.winnersCount !== rounds[i]!.winnersCount || (rounds[i]!.label?.trim() && r.label !== rounds[i]!.label?.trim()))) throw invalidReceipt();
      return result;
    });
    await forgetLegacyAdmin(eventId);
    return result;
  },
  addTeam: async (p: { eventId: string; name: string; deals?: number; topRank?: number | null; topPrize?: number | null; inWheel?: boolean; sale?: string | null }) => {
    const name = p.name.trim();
    const { event } = await requireAdminEvent(p.eventId);
    // Duy nhất (sự kiện, tên) trên máy chủ: gửi lại không thêm đội thứ hai. Tên đã có thì báo trước, kèm mã điểm danh.
    const existing = event.teams.find(t => t.name === name);
    if (existing) {
      throw new FinancialWorkflowError(`Sự kiện đã có đội ${name} (mã điểm danh ${existing.code}). Nếu vừa bấm thêm mà chưa nhận được kết quả thì đội này có thể đã được thêm ở lần bấm trước; xem lại đội trong danh sách thay vì thêm lần nữa.`, 'failure', []);
    }
    const result = await repeatable('thêm đội tham gia', async () => checkedReceipt(teamReceipt, await adminRpc(() => supabase.rpc('lucky_admin_add_team_v1', {
      p_event: p.eventId, p_name: name, p_deals: p.deals ?? 1, p_top_rank: p.topRank ?? undefined,
      p_top_prize: p.topPrize ?? undefined, p_in_wheel: p.inWheel ?? true, p_sale: p.sale ?? undefined,
    }))));
    await forgetLegacyAdmin(p.eventId);
    return result;
  },
  updateTeam: async (teamId: string, p: { name?: string; sale?: string | null; deals?: number; topRank?: number | null; topPrizeAmount?: number | null; inWheel?: boolean; checkedIn?: boolean; regenCode?: boolean }) => {
    const { event } = await requireAdminTeam(teamId);
    const priorCode = event.teams.find(t => t.id === teamId)?.code;
    // Thân hàm 45d1f552: mọi trường là đặt giá trị tuyệt đối; điểm danh giữ giờ điểm danh đầu tiên. Riêng cấp lại mã KHÔNG
    // lặp lại được (mỗi lần một mã mới): chưa rõ thì đọc lại mã hiện tại thay vì mời bấm lại.
    const operation = p.regenCode ? 'cấp lại mã điểm danh' : Object.keys(p).length === 1 && p.checkedIn !== undefined ? 'điểm danh đội' : 'cập nhật đội tham gia';
    try {
      const result = await repeatable(operation, async () => {
        const result = checkedReceipt(teamReceipt, await adminRpc(() => supabase.rpc('lucky_admin_update_team_v1', { p_team: teamId, p })));
        if (result.teamId !== teamId) throw invalidReceipt();
        return result;
      });
      await forgetLegacyAdmin(event.id);
      return result;
    } catch (error) {
      if (!p.regenCode || !(error instanceof RepeatableWriteUnknownError)) throw error;
      let current: string | undefined;
      try { current = (await requireAdminTeam(teamId)).event.teams.find(t => t.id === teamId)?.code; }
      catch (readError) { throw new RepeatableWriteUnknownError(operation, readError, [], 'Mã cũ có thể đã hết hiệu lực. Tải lại danh sách để xem mã hiện tại trước khi gửi cho đội.'); }
      if (current && current !== priorCode) return { ok: true as const, teamId, code: current };
      throw new RepeatableWriteUnknownError(operation, error, [], 'Mã điểm danh hiện tại vẫn là mã cũ. Tải lại danh sách sau ít giây trước khi gửi mã cho đội; bấm cấp lại nếu vẫn cần mã mới.');
    }
  },
  /** `eventId`: sự kiện của đội lúc bấm. Có nó thì đội đã không còn trong sự kiện nghĩa là đã xoá (không gửi lệnh nữa). */
  deleteTeam: async (teamId: string, eventId?: string) => {
    const source = await getAdminState();
    const event = source.events.find(e => eventId ? e.id === eventId : e.teams.some(t => t.id === teamId));
    if (!event) throw new FinancialWorkflowError('Đội không còn trong danh sách bạn được quản lý. Tải lại danh sách trước khi tiếp tục.', 'failure', []);
    if (!event.teams.some(t => t.id === teamId)) {
      await forgetLegacyAdmin(event.id);
      return { ok: true as const, alreadyDeleted: true };
    }
    const result = await repeatable('xoá đội tham gia', async () => {
      const value = await adminRpc(() => supabase.rpc('lucky_admin_delete_team_v1', { p_team: teamId }));
      // Thân hàm 1ec42d37: không thấy đội ⇒ `not_found`. Đó là lần xoá trước đã tới (hoặc người khác vừa xoá): xác nhận
      // bằng bản đọc lại bên dưới, không coi là lời từ chối.
      const gone = refused(value, 'not_found');
      if (!gone) checkedReceipt(ackReceipt, value);
      const after = await requireAdminEvent(event.id);
      if (after.source.organizationId !== source.organizationId || after.event.teams.some(t => t.id === teamId)) throw invalidReceipt();
      return { ok: true as const, alreadyDeleted: gone };
    }, 'Đội có thể đã bị xoá. Bấm xoá lại để kiểm tra: đội đã xoá thì báo đã xoá, không xoá gì thêm.');
    await forgetLegacyAdmin(event.id);
    return result;
  },
  forceDraw: (eventId: string) => runAdminDraw({ eventId, ordinal: null }, () => supabase.rpc('lucky_admin_force_draw_v1', { p_event: eventId })),
  /**
   * Đặt lại kết quả (thân hàm 97a61cd3: xoá người trúng, đặt mọi lượt và sự kiện về «đang mở»). Đọc trạng thái trước:
   * đã sạch ⇒ báo đã huỷ, không gửi. `expectedDrawnAt` (giờ quay của kết quả người bấm đang xem): kết quả trên máy chủ đã
   * khác thì không huỷ, để một lần bấm lại không xoá mất một kết quả mới mà người chơi đã thấy.
   */
  resetDraw: async (eventId: string, expectedDrawnAt?: string | null) => {
    const before = await requireAdminEvent(eventId);
    if (drawCleared(before.event)) {
      await forgetLegacyAdmin(eventId);
      return { ok: true as const, alreadyReset: true };
    }
    if (expectedDrawnAt !== undefined && before.event.drawnAt !== expectedDrawnAt) {
      throw new FinancialWorkflowError(`Kết quả quay trên máy chủ đã khác kết quả đang hiện${before.event.drawnAt ? ` (quay lúc ${formatPendingTime(before.event.drawnAt)})` : ''}. Tải lại trạng thái trước khi huỷ.`, 'failure', []);
    }
    const result = await repeatable('đặt lại kết quả quay số', async () => {
      checkedReceipt(ackReceipt, await adminRpc(() => supabase.rpc('lucky_admin_reset_draw_v1', { p_event: eventId })));
      const after = await requireAdminEvent(eventId);
      if (after.source.organizationId !== before.source.organizationId) throw invalidReceipt();
      if (drawCleared(after.event)) return { ok: true as const, alreadyReset: false };
      // Biên nhận dương nghĩa là máy chủ đã huỷ; kết quả mới (giờ quay khác) có sau đó, thường vì giờ mở thưởng đã qua nên
      // trang người xem tự quay. Không mời bấm huỷ lần nữa: lần đó sẽ xoá kết quả mới mà người chơi có thể đã thấy.
      if (after.event.drawnAt && after.event.drawnAt !== before.event.drawnAt) {
        throw new FinancialWorkflowError(`Đã huỷ kết quả cũ, nhưng sự kiện vừa được quay lại lúc ${formatPendingTime(after.event.drawnAt)} (giờ mở thưởng đã qua nên trang người xem tự quay). Đổi giờ mở thưởng rồi tải lại trạng thái trước khi huỷ tiếp.`, 'failure', []);
      }
      throw invalidReceipt();
    }, 'Kết quả cũ có thể đã bị huỷ. Bấm huỷ lại để kiểm tra: đã huỷ thì báo, không huỷ thêm lần nào.');
    await forgetLegacyAdmin(eventId);
    return result;
  },
  /** Còn dấu của một lệnh QUAY chưa rõ kết quả cho sự kiện này. Chỉ lệnh quay giữ dấu; dấu chung bản trước không tính. */
  hasPendingAction: async (eventId: string) => {
    const user = await getSessionUser();
    if (!user) return false;
    return !!financialPending.read(drawScope(user.id, eventId));
  },
  /**
   * «Tải lại trạng thái» cho lệnh quay chưa rõ: chỉ ĐỌC trạng thái rồi kết luận, không gửi lệnh quay. Lượt đó đã quay ⇒
   * `drawn`; chưa quay ⇒ `not-drawn` (bấm quay lại là an toàn: hàm quay khoá sự kiện rồi mới xét «đã quay»); cả hai đều gỡ
   * dấu. Không còn dấu ⇒ `none`. Lệnh còn đang chạy trong tab, hoặc đọc hỏng ⇒ ném lỗi, giữ dấu.
   */
  reconcileDraw: async (eventId: string): Promise<LuckyDrawReconciliation> => {
    const user = await getSessionUser();
    if (!user) throw new FinancialWorkflowError('Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục.', 'failure', []);
    const scope = drawScope(user.id, eventId);
    const pending = financialPending.read(scope);
    if (!pending) return { outcome: 'none' };
    if (isAttemptRunning(pending.attemptId)) throw new FinancialWorkflowError('Lệnh quay của lần bấm trước vẫn đang chờ máy chủ trả lời. Thử lại sau ít giây.', 'unknown', []);
    const state = publicFromAdmin((await requireAdminEvent(eventId)).event);
    const ordinal = pending.meta?.ordinal;
    const known = ordinal === null || typeof ordinal === 'number';
    const intent: DrawIntent = { eventId, ordinal: typeof ordinal === 'number' ? ordinal : null };
    const verdict: LuckyDrawReconciliation = !known ? { outcome: 'unknown-intent' }
      : drawReached(state, intent) ? { outcome: 'drawn', ordinal: intent.ordinal, state }
        : { outcome: 'not-drawn', ordinal: intent.ordinal };
    if (!financialPending.clearConfirmed(scope, pending.attemptId)) {
      throw new FinancialWorkflowError('Yêu cầu quay vừa thay đổi ở nơi khác. Bấm «Tải lại trạng thái» lần nữa.', 'unknown', []);
    }
    return verdict;
  },
};

/* ──────────────────────────────── Tiện ích ────────────────────────────────── */

const VND = new Intl.NumberFormat('vi-VN');
export const formatVnd = (n: number) => `${VND.format(n)}đ`;

/** Link công khai của sự kiện — đưa cho sale / dán vào group.
 *  Ưu tiên slug cho gọn; chưa có slug thì lui về ?e=<uuid>. */
export const luckyPublicUrl = (eventIdOrSlug: string, slug?: string | null) =>
  slug
    ? `${window.location.origin}/quayso/${slug}`
    : `${window.location.origin}/quayso?e=${eventIdOrSlug}`;

/** Lệch giờ server-client (ms): serverNow của payload trừ Date.now() lúc nhận. */
export function serverClockOffset(serverNowIso: string): number {
  return new Date(serverNowIso).getTime() - Date.now();
}
