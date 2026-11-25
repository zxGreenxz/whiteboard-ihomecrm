import { ConfirmedDepositIncome, findOwnDepositIncome } from '@/lib/depositIncomeRpc';
import { supabase } from "@/integrations/supabase/client";
import { financialPending, type FinancialPendingRecord, type PendingReconciliation } from "@/lib/financialPending";
import { runFinancialPending } from "@/lib/financialPendingAction";
import { isCanonicalCreateEligible, prepareIncomeExpenseCreate } from "./mutations";
import type { CreateIncomeExpenseInput } from "./types";

// Lập phiếu Thu/Chi từ form, có đối chiếu sau một lần chưa rõ kết quả (đợt 3 plan sửa khoá vĩnh viễn).
//
// Mã yêu cầu của dấu (UUID) đi lên máy chủ theo hai đường, đọc thân hàm production 24/11/2026:
//   - create_income_expense_v1 nhận nó làm khoá `ie-create-<mã>`: claim canonical_write_operations là chốt tuyến tính
//     (ON CONFLICT chờ lệnh cũ còn chạy), cùng nội dung trả lại phiếu cũ, khác nội dung trả 23505 (cách B);
//   - ie_compat_insert_v2 (phiếu lặp, dòng thiếu kỳ, ảnh không https, hoặc đường chính rơi sang) nhận nó làm mã
//     phiếu `p_row.id`: khoá chính chặn phiếu thứ hai, và phép đối chiếu tra đúng phiếu theo mã (cách D).
// Dấu ghi trước bản này không mang hai mã đó nên chỉ tra gần đúng (cùng người tạo, loại, toà, phòng, sau giờ kẹt).

/** Dấu mang mã yêu cầu đã gửi lên máy chủ theo hai đường trên. */
const KEYED = "request-key-v1";
/** Lệch giờ trình duyệt ↔ máy chủ chấp nhận khi tra phiếu "tạo sau giờ kẹt". Lệch rộng chỉ làm báo "có thể đã lập" nhiều hơn. */
const CLOCK_SKEW_MS = 60 * 60_000;

export interface VoucherFormCreateContext {
  userId: string;
  organizationId: string;
  create: (input: CreateIncomeExpenseInput) => Promise<unknown>;
}

/** Phạm vi dấu của một lần lập phiếu: loại × toà × phòng. Đổi một trong ba thì là lượt khác, không thấy dấu cũ. */
export const voucherFormCreateKey = (data: Pick<CreateIncomeExpenseInput, "type" | "building_id" | "room_id">) =>
  [data.type, data.building_id, data.room_id ?? ""].join(":");

/**
 * Lần lập trước ở phạm vi `stuckKey` chưa rõ kết quả mà người dùng đã đổi loại, toà hoặc phòng: lượt mới không thấy dấu cũ
 * nên không được đối chiếu, có thể ra phiếu thứ hai cho cùng một khoản tiền. Còn dấu đó thì trả câu báo để chặn.
 */
export function pendingCreateElsewhere(ctx: Pick<VoucherFormCreateContext, "userId" | "organizationId">, stuckKey: string | null, data: Pick<CreateIncomeExpenseInput, "type" | "building_id" | "room_id">): string | null {
  if (!stuckKey || stuckKey === voucherFormCreateKey(data) || !ctx.userId || !ctx.organizationId) return null;
  let pending: FinancialPendingRecord | null;
  try { pending = financialPending.read({ namespace: "voucher-form-create", userId: ctx.userId, organizationId: ctx.organizationId, businessKey: stuckKey }); }
  catch { pending = null; }
  if (!pending) return null;
  return "Lần lập phiếu trước chưa rõ kết quả mà loại phiếu, toà hoặc phòng đã đổi. Chọn lại đúng như lần trước rồi bấm Lưu để hệ thống đối chiếu (nếu lần trước chưa ghi, phiếu sẽ được lập theo lựa chọn cũ); chọn nhầm thì kiểm tra danh sách phiếu trước, rồi đóng và mở lại form để lập cho chỗ khác.";
}

/** Chữ ký nhỏ của các hạng mục (mã loại, sắp xếp): đổi hạng mục giữa hai lần thì đường ghi của máy chủ có thể đã khác. */
const itemsSignature = (data: CreateIncomeExpenseInput) =>
  [...new Set(data.items.map((item) => item.income_expense_type_id))].sort().join(",").slice(0, 400);

interface VoucherRow { id: string; code: string | null }

async function readVoucherById(id: string): Promise<VoucherRow | null> {
  const { data, error } = await supabase.from("income_expenses").select("id, code").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? (data as VoucherRow) : null;
}

/** Phiếu của chính người này, cùng loại, toà, phòng, tạo sau giờ kẹt. Gần đúng: có thể là một phiếu KHÁC giống hệt. */
async function findRecentCandidates(data: CreateIncomeExpenseInput, pending: FinancialPendingRecord): Promise<VoucherRow[]> {
  const since = new Date(Date.parse(pending.startedAt) - CLOCK_SKEW_MS).toISOString();
  let query = supabase.from("income_expenses").select("id, code, created_at")
    .eq("user_id", pending.userId).eq("type", data.type).eq("building_id", data.building_id);
  query = data.room_id ? query.eq("room_id", data.room_id) : query.is("room_id", null);
  // Mới nhất trước: phiếu của lần kẹt nằm gần giờ kẹt, không bị đẩy ra ngoài 5 dòng bởi các phiếu cũ trong cửa sổ.
  const { data: rows, error } = await query.gte("created_at", since).order("created_at", { ascending: false }).limit(5);
  if (error) throw error;
  if (!Array.isArray(rows)) throw new TypeError("Chưa đọc được danh sách phiếu để đối chiếu.");
  return rows as VoucherRow[];
}

const maybeWritten = (rows: VoucherRow[]): PendingReconciliation<{ id: string }> => {
  const codes = rows.map((row) => row.code || row.id);
  return {
    outcome: "already-written",
    message: `Có thể phiếu đã được lập ở lần gửi trước (mã ${codes.join(", ")}). Kiểm tra danh sách phiếu trước khi lập lại.`,
    recordIds: codes,
  };
};

export async function createVoucherFromForm(data: CreateIncomeExpenseInput, ctx: VoucherFormCreateContext): Promise<{ id: string }> {
  // Phiên và hạng mục đọc TRƯỚC khi ghi dấu: hỏng ở đây thì chưa có gì được ghi, báo lỗi ngay, không để lại dấu.
  const prepared = await prepareIncomeExpenseCreate(data);
  const canonical = isCanonicalCreateEligible(data);
  const items = itemsSignature(data);
  let resend = false;
  const receipt=await runFinancialPending<{id:string} | ConfirmedDepositIncome>({ namespace: "voucher-form-create", userId: ctx.userId, organizationId: ctx.organizationId, businessKey: voucherFormCreateKey(data) }, async (progress) => {
    // Cả hai đường ghi (create_income_expense_v1 / ie_compat_insert_v2) trả về phiếu có id.
    const created = (await ctx.create({
      ...data,
      idempotency_key: `ie-create-${progress.requestKey}`,
      voucher_id: progress.requestKey,
      resend,
      prepared,
    })) as { id?: string } | null | undefined;
    if (!created?.id) throw new TypeError("Chưa xác nhận mã phiếu vừa tạo");
    progress.recordCompleted([created.id]);
    return { id: created.id };
  }, undefined, {
    operation: "lập phiếu thu/chi",
    meta: { dedupe: KEYED, canonical, items, deposit: data.deposit_terms !== undefined },
    reconcile: async (pending) => {
      if (pending.completedIds.length) {
        return { outcome: "already-written", message: "Phiếu đã được lập ở lần gửi trước.", recordIds: pending.completedIds };
      }
      if (pending.meta?.dedupe !== KEYED || !pending.requestKey) {
        // Dấu cũ: mã yêu cầu của nó chưa từng lên máy chủ. Thấy phiếu giống thì chỉ báo "có thể đã lập", không gửi;
        // không thấy thì lõi chỉ cho gửi lại khi lần trước đã quá 2 phút.
        const rows = await findRecentCandidates(data, pending);
        if (rows.length) return maybeWritten(rows);
        resend = true;
        return { outcome: "not-written" };
      }
      if (pending.meta.deposit === true) {
        const id=await findOwnDepositIncome(ctx.organizationId,`ie-create-${pending.requestKey}`);
        if (id) return {result:new ConfirmedDepositIncome(id)};
      }
      // Đường compat của lần trước dùng đúng mã này làm mã phiếu: tra thẳng.
      const exact = await readVoucherById(pending.requestKey);
      if (exact) {
        return { outcome: "already-written", message: `Phiếu ${exact.code || exact.id} đã được lập ở lần gửi trước. Mở danh sách phiếu để kiểm tra trước khi lập thêm.`, recordIds: [exact.code || exact.id] };
      }
      resend = true;
      // Đường ghi có thể đã khác giữa hai lần: điều kiện phía trình duyệt đổi (bật/tắt phiếu lặp…), hoặc hạng mục đổi
      // (hạng mục chỉ-hệ-thống làm đường chính trả 0A000 TRƯỚC bước claim rồi rơi sang compat). Máy chủ không chống trùng
      // chéo đường, nên không gửi ngay; lần trước đi đường chính thì phiếu mang mã do máy chủ sinh, chỉ tra gần đúng được.
      if (pending.meta.canonical !== canonical || pending.meta.items !== items) {
        if (pending.meta.canonical === true) {
          const rows = await findRecentCandidates(data, pending);
          if (rows.length) return maybeWritten(rows);
        }
        return { outcome: "not-written" };
      }
      // Cùng đường: gửi lại cùng mã. Máy chủ chờ lệnh cũ còn chạy rồi trả phiếu cũ hoặc báo mã đã dùng.
      return { outcome: "not-written", serverDedupesRequestKey: true };
    },
  });
  if (receipt instanceof ConfirmedDepositIncome) throw receipt;
  return receipt;
}
