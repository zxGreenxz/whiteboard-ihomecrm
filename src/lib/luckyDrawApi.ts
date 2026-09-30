import { parseLuckyState, parseLuckyAdminState, PublicRequestError } from './publicFeedback';
import { z } from 'zod';
import { persistentFinancialWorkflow } from './persistentFinancialWorkflow';
import { FinancialWorkflowError, FinancialWorkflowGuard } from './financialWorkflow';
import { financialPending, FinancialPendingStorageError } from './financialPending';
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

const publicDrawGuard = new FinancialWorkflowGuard({ scope: async businessKey => ({
  namespace: 'lucky-public-draw', userId: 'public-viewer', organizationId: 'public-event', businessKey,
}) });
export function luckyDraw(eventId: string) {
  const intent: DrawIntent = { eventId, ordinal: null };
  return publicDrawGuard.run(eventId, 'xác nhận kết quả quay', async () => {
    const result = await publicRpc('lucky_draw_v1', { p_event: eventId });
    if (!result.ok && result.reason && knownDrawRefusals.has(result.reason)) return result;
    if (!confirmsDraw(result, intent)) throw invalidReceipt();
    return result;
  }, async () => {
    const result = await fetchLuckyPublicState(eventId, null);
    return confirmsDraw(result, intent) ? { result } : null;
  });
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
 */
export async function uploadLuckyProof(
  eventId: string,
  file: File,
  lifecycle?: { onPlanned?: (proof: LuckyProof) => void; onRejected?: (proof: LuckyProof) => void },
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
  // Record the object identity before sending: a lost response must not create a new upload.
  lifecycle?.onPlanned?.(proof);

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
    if (!res.ok) {
      if ([400, 401, 403, 404, 410, 413, 415, 422].includes(res.status)) lifecycle?.onRejected?.(proof);
      throw new PublicRequestError(res.status);
    }
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

const adminWriteGuard = persistentFinancialWorkflow('lucky-admin', { scope: 'actor' });
const drawIntentKey = (requestKey: string) => 'ihome:lucky-draw-intent:v1:' + requestKey;
type DrawIntent = { eventId: string; ordinal: number | null };
function rememberDraw(requestKey: string, intent: DrawIntent) {
  try { localStorage.setItem(drawIntentKey(requestKey), JSON.stringify(intent)); }
  catch { throw new FinancialPendingStorageError(); }
}
function readDraw(requestKey: string): DrawIntent | null {
  try {
    const raw = localStorage.getItem(drawIntentKey(requestKey));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    const result = z.object({ eventId: z.string().min(1), ordinal: z.number().int().positive().nullable() }).safeParse(value);
    if (!result.success) throw new FinancialPendingStorageError();
    return {eventId:result.data.eventId,ordinal:result.data.ordinal};
  } catch (error) { if (error instanceof FinancialPendingStorageError) throw error; throw new FinancialPendingStorageError(); }
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
async function reconcileDrawReceipt(requestKey: string, expected: DrawIntent): Promise<{ result: LuckyPublicState } | null> {
  const intent = readDraw(requestKey);
  if (!intent || intent.eventId !== expected.eventId || intent.ordinal !== expected.ordinal) return null;
  const { event } = await requireAdminEvent(intent.eventId);
  const state = publicFromAdmin(event);
  return confirmsDraw(state, intent) ? { result: state } : null;
}
async function runAdminDraw(intent: DrawIntent, run: () => PromiseLike<{ data: unknown; error: PostgrestError | null }>) {
  await requireAdminEvent(intent.eventId);
  return adminWriteGuard.run(intent.eventId, intent.ordinal === null ? 'quay sự kiện' : 'chốt lượt quay', async progress => {
    rememberDraw(progress.requestKey, intent);
    const state = parseLuckyState(await adminRpc(run));
    if (!state.ok) {
      if (!state.reason || !knownDrawRefusals.has(state.reason)) throw invalidReceipt();
      return state; // These SQL branches return before the writer.
    }
    if (!confirmsDraw(state, intent)) throw invalidReceipt();
    progress.completed.push({ id: intent.eventId, label: 'Đã xác nhận kết quả quay' });
    return state;
  }, pending => reconcileDrawReceipt(pending.requestKey ?? pending.attemptId, intent));
}

export const luckyAdminApi = {
  get: getAdminState,
  upsertEvent: async (p: {
    id?: string; title?: string; slug?: string; prizeLabel?: string; prizeAmount?: number;
    drawAt?: string | null; status?: 'open' | 'closed'; game?: LuckyGame; raceSeconds?: number;
  }) => {
    if (p.id) await requireAdminEvent(p.id); else await getAdminState();
    return adminWriteGuard.run(p.id ?? 'new-event', 'lưu sự kiện quay số', async progress => {
      const value = await adminRpc(() => supabase.rpc('lucky_admin_upsert_event_v1', { p }));
      const result = checkedReceipt(z.object({ ok: z.literal(true), eventId: z.string().min(1), slug: z.string().nullable(), game: z.enum(['wheel', 'race']) }), value);
      progress.completed.push({ id: result.eventId, label: 'Đã nhận mã sự kiện' });
      if (p.id && result.eventId !== p.id) throw invalidReceipt();
      return result;
    });
  },
  drawRound: (eventId: string, ordinal: number) => runAdminDraw({ eventId, ordinal }, () => supabase.rpc('lucky_draw_round_v1', { p_event: eventId, p_ordinal: ordinal })),
  setRounds: async (eventId: string, rounds: LuckyRoundInput[]) => {
    const before = await requireAdminEvent(eventId);
    return adminWriteGuard.run(eventId, 'lưu thể lệ quay số', async progress => {
      const result = checkedReceipt(z.object({ ok: z.literal(true), rounds: z.number().int().nonnegative() }), await adminRpc(() => supabase.rpc('lucky_admin_set_rounds_v1', {
        p_event: eventId, p_rounds: rounds.map(r => ({ label: r.label ?? '', amount: r.amount, winnersCount: r.winnersCount })),
      })));
      progress.completed.push({ id: eventId, label: 'Đã tiếp nhận yêu cầu lưu thể lệ' });
      const after = await requireAdminEvent(eventId);
      // The equal-length check short-circuits before indexing the submitted round array.
      if (result.rounds !== rounds.length || after.source.organizationId !== before.source.organizationId ||
          after.event.rounds.length !== rounds.length || after.event.rounds.some((r, i) => r.ordinal !== i + 1 || r.amount !== rounds[i]!.amount || r.winnersCount !== rounds[i]!.winnersCount || (rounds[i]!.label?.trim() && r.label !== rounds[i]!.label?.trim()))) throw invalidReceipt();
      return result;
    });
  },
  addTeam: async (p: { eventId: string; name: string; deals?: number; topRank?: number | null; topPrize?: number | null; inWheel?: boolean; sale?: string | null }) => {
    await requireAdminEvent(p.eventId);
    return adminWriteGuard.run(p.eventId, 'thêm đội tham gia', async progress => {
      const result = checkedReceipt(teamReceipt, await adminRpc(() => supabase.rpc('lucky_admin_add_team_v1', {
        p_event: p.eventId, p_name: p.name, p_deals: p.deals ?? 1, p_top_rank: p.topRank ?? undefined,
        p_top_prize: p.topPrize ?? undefined, p_in_wheel: p.inWheel ?? true, p_sale: p.sale ?? undefined,
      })));
      progress.completed.push({ id: result.teamId, label: 'Đã tạo đội tham gia' }); return result;
    });
  },
  updateTeam: async (teamId: string, p: { name?: string; sale?: string | null; deals?: number; topRank?: number | null; topPrizeAmount?: number | null; inWheel?: boolean; checkedIn?: boolean; regenCode?: boolean }) => {
    const { event } = await requireAdminTeam(teamId);
    return adminWriteGuard.run(event.id, 'cập nhật đội tham gia', async progress => {
      const result = checkedReceipt(teamReceipt, await adminRpc(() => supabase.rpc('lucky_admin_update_team_v1', { p_team: teamId, p })));
      progress.completed.push({ id: result.teamId, label: 'Đã nhận kết quả cập nhật đội' });
      if (result.teamId !== teamId) throw invalidReceipt(); return result;
    });
  },
  deleteTeam: async (teamId: string) => {
    const before = await requireAdminTeam(teamId);
    return adminWriteGuard.run(before.event.id, 'xóa đội tham gia', async progress => {
      const result = checkedReceipt(ackReceipt, await adminRpc(() => supabase.rpc('lucky_admin_delete_team_v1', { p_team: teamId })));
      progress.completed.push({ id: teamId, label: 'Đã tiếp nhận yêu cầu xóa đội' });
      const after = await requireAdminEvent(before.event.id);
      if (after.source.organizationId !== before.source.organizationId || after.event.teams.some(t => t.id === teamId)) throw invalidReceipt();
      return result;
    });
  },
  forceDraw: (eventId: string) => runAdminDraw({ eventId, ordinal: null }, () => supabase.rpc('lucky_admin_force_draw_v1', { p_event: eventId })),
  resetDraw: async (eventId: string) => {
    const before = await requireAdminEvent(eventId);
    return adminWriteGuard.run(eventId, 'đặt lại kết quả quay số', async progress => {
      const result = checkedReceipt(ackReceipt, await adminRpc(() => supabase.rpc('lucky_admin_reset_draw_v1', { p_event: eventId })));
      progress.completed.push({ id: eventId, label: 'Đã tiếp nhận yêu cầu đặt lại kết quả' });
      const after = await requireAdminEvent(eventId); const e = after.event;
      if (after.source.organizationId !== before.source.organizationId || e.status !== 'open' || e.drawnAt !== null || e.winnerTeamId !== null || e.rounds.some(r => r.status !== 'pending' || r.drawnAt !== null || r.winners.length > 0)) throw invalidReceipt();
      return result;
    });
  },
  hasPendingAction: async (eventId: string) => {
    const user = await getSessionUser();
    if (!user) return false;
    return !!financialPending.read({ namespace: 'lucky-admin', userId: user.id, organizationId: 'actor-scope', businessKey: eventId });
  },
  /** Read-only recovery: a generic successful refresh cannot release an unresolved draw. */
  reconcileDraw: async (eventId: string) => {
    const user = await getSessionUser();
    if (!user) throw new FinancialWorkflowError('Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục.', 'failure', []);
    const pending = financialPending.read({ namespace: 'lucky-admin', userId: user.id, organizationId: 'actor-scope', businessKey: eventId });
    if (!pending) return null;
    const intent = readDraw(pending.requestKey ?? pending.attemptId);
    if (!intent || intent.eventId !== eventId) return null;
    return adminWriteGuard.run(eventId, 'đối chiếu kết quả quay', async () => { throw invalidReceipt(); },
      row => reconcileDrawReceipt(row.requestKey ?? row.attemptId, intent));
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
