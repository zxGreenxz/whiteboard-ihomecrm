// Finance V2 — validation THUẦN cho Posting dialog dùng chung (plan §12.3).
//
// Additive: KHÔNG đụng writer/schema/component cũ. Đây là lớp validate phía
// client cho MÀN GHI TIỀN THẬT (POST) — đúng ba trường người dùng nhập ở phase
// đầu (§12.3):
//   1. ngày Thu/Chi   (postedOn, yyyy-MM-dd)
//   2. sổ quỹ         (cashbookId, uuid — chỉ sổ actor đang là CUSTODIAN)
//   3. hình ảnh/chứng từ (evidenceIds — manual Thu/Chi bắt buộc >= 1, §2.2/§6.3)
//
// Số tiền là read-only = tổng đã duyệt, NGOẠI TRỪ MULTI_TRANCHE salary
// (subjectKind='SALARY_AUTHORIZATION') cho nhập amount tối đa remaining
// authorized amount (§6.10). Với subject 'VOUCHER' amount bị TẪ CHỐI — server
// suy từ voucher total, client gửi amount là sai contract.
//
// NGUYÊN TẮC: file này KHÔNG gọi API, KHÔNG import supabase. Chỉ suy luận thuần
// để test property/unit và để dialog dựng zodResolver.

import { z } from 'zod';
import { formatVND } from '@/lib/utils';

// --- Kiểu đối tượng posting ---

/**
 * Đối tượng của một posting event (§6.2):
 *   - 'VOUCHER'              : Phiếu thu/chi thủ công (kể cả child ONE_SHOT salary).
 *   - 'SALARY_AUTHORIZATION' : quyết toán lương MULTI_TRANCHE — mỗi đợt chi là 1
 *                              tranche append-only, cho nhập amount tối đa remaining.
 */
export type PostingSubjectKind = 'VOUCHER' | 'SALARY_AUTHORIZATION';

/**
 * Input đầy đủ gửi tới RPC ghi tiền thật (post/approve-and-post). Dialog assemble
 * từ ba trường người dùng + metadata do server cấp (versions, idempotency key).
 * Client KHÔNG tự INSERT posting; đây chỉ là payload của primitive private.
 */
export interface PostFinanceExecutionInput {
  subjectKind: PostingSubjectKind;
  /** VOUCHER: id phiếu; SALARY_AUTHORIZATION: id salary_cash_authorization. */
  subjectId: string;
  /** Sổ quỹ nhận/chi — phải là sổ actor đang giữ (CUSTODIAN). */
  cashbookId: string;
  /** Ngày tiền thật (posted_on), yyyy-MM-dd. */
  postedOn: string;
  /** Chứng từ đã finalize; manual Thu/Chi cần >= 1. */
  evidenceIds: string[];
  /** CHỈ MULTI_TRANCHE salary: số tiền đợt chi, >0 và <= remaining. */
  amount?: number;
  /** CAS: revision hàng đợi phân sổ/execution mà client đang thấy. */
  expectedExecutionRevision: number;
  /** CAS: approval_version kỳ vọng. */
  expectedApprovalVersion: number;
  /** CAS: posting_version kỳ vọng. */
  expectedPostingVersion: number;
  /** Idempotency key do server/dialog cấp — chống double-post khi retry. */
  idempotencyKey: string;
}

// --- Field keys + kết quả validate ---

export type PostFinanceExecutionField =
  | 'subjectId'
  | 'cashbookId'
  | 'postedOn'
  | 'evidenceIds'
  | 'amount'
  | 'idempotencyKey'
  | 'expectedExecutionRevision'
  | 'expectedApprovalVersion'
  | 'expectedPostingVersion';

export type PostFinanceExecutionErrors = Partial<
  Record<PostFinanceExecutionField, string>
>;

export interface PostFinanceExecutionValidationResult {
  ok: boolean;
  errors: PostFinanceExecutionErrors;
}

/**
 * Ngữ cảnh để suy quy tắc phụ thuộc dữ liệu server:
 *   - requireEvidence : manual Thu/Chi bắt buộc >= 1 chứng từ (mặc định true).
 *                       System writer đã có SYSTEM_REFERENCE thì truyền false.
 *   - remainingAmount : trần còn lại của MULTI_TRANCHE salary (ceiling - đã chi).
 *                       Bắt buộc khi subjectKind='SALARY_AUTHORIZATION'.
 */
export interface PostFinanceExecutionValidationContext {
  requireEvidence?: boolean;
  remainingAmount?: number;
}

// --- Helpers thuần ---

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse yyyy-MM-dd về Date (UTC) hoặc null nếu KHÔNG phải ngày lịch hợp lệ. */
export function parseIsoDate(value: string): Date | null {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return null;
  const [y, m, d] = value.split('-').map((s) => Number(s));
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Bắt ngày tràn (vd 2026-02-30 → 03-02); phải khớp lại từng thành phần.
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

/** true nếu chuỗi là ngày yyyy-MM-dd hợp lệ. */
export function isValidIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

/** true nếu chuỗi là UUID (bất kể version/variant nibble). */
export function isUuid(value: string): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Đếm evidence id thực (bỏ chuỗi rỗng/space). */
function countEvidence(ids: readonly string[] | null | undefined): number {
  if (!Array.isArray(ids)) return 0;
  return ids.filter((e) => typeof e === 'string' && e.trim() !== '').length;
}

// --- Validator thuần cho input đầy đủ ---

/**
 * Validate toàn bộ `PostFinanceExecutionInput` theo §12.3/§6.2/§6.10.
 *
 * Trả `{ ok, errors }` với `errors` keyed theo field để dialog map ra
 * `setError`. Không throw, không side-effect.
 */
export function validatePostFinanceExecutionInput(
  input: PostFinanceExecutionInput,
  ctx: PostFinanceExecutionValidationContext = {},
): PostFinanceExecutionValidationResult {
  const errors: PostFinanceExecutionErrors = {};
  const requireEvidence = ctx.requireEvidence ?? true;
  const isSalaryTranche = input.subjectKind === 'SALARY_AUTHORIZATION';

  // 1. subjectId — luôn cần uuid hợp lệ.
  if (!input.subjectId) {
    errors.subjectId = 'Thiếu định danh đối tượng phiếu';
  } else if (!isUuid(input.subjectId)) {
    errors.subjectId = 'Định danh đối tượng không hợp lệ';
  }

  // 2. Sổ quỹ.
  if (!input.cashbookId) {
    errors.cashbookId = 'Vui lòng chọn sổ quỹ';
  } else if (!isUuid(input.cashbookId)) {
    errors.cashbookId = 'Sổ quỹ không hợp lệ';
  }

  // 3. Ngày Thu/Chi.
  if (!input.postedOn) {
    errors.postedOn = 'Vui lòng chọn ngày';
  } else if (!isValidIsoDate(input.postedOn)) {
    errors.postedOn = 'Ngày không hợp lệ (yyyy-MM-dd)';
  }

  // 4. Chứng từ — manual Thu/Chi bắt buộc >= 1.
  if (requireEvidence && countEvidence(input.evidenceIds) < 1) {
    errors.evidenceIds = 'Phiếu Thu/Chi thủ công cần ít nhất 1 chứng từ';
  }

  // 5. Số tiền.
  if (isSalaryTranche) {
    // MULTI_TRANCHE salary: cho nhập, phải >0 và <= remaining.
    if (input.amount == null || Number.isNaN(input.amount)) {
      errors.amount = 'Vui lòng nhập số tiền đợt chi';
    } else if (!(input.amount > 0)) {
      errors.amount = 'Số tiền phải lớn hơn 0';
    } else if (ctx.remainingAmount == null) {
      errors.amount = 'Thiếu hạn mức còn lại của quyết toán lương';
    } else if (input.amount > ctx.remainingAmount) {
      errors.amount = `Số tiền vượt hạn mức còn lại (${formatVND(ctx.remainingAmount)})`;
    }
  } else {
    // VOUCHER: số tiền read-only = tổng đã duyệt. Gửi amount là sai contract.
    if (input.amount != null) {
      errors.amount = 'Số tiền cố định bằng tổng đã duyệt, không được nhập';
    }
  }

  // 6. Idempotency key.
  if (!input.idempotencyKey || input.idempotencyKey.trim() === '') {
    errors.idempotencyKey = 'Thiếu idempotency key';
  }

  // 7. Version CAS — số nguyên không âm.
  const versionFields: PostFinanceExecutionField[] = [
    'expectedExecutionRevision',
    'expectedApprovalVersion',
    'expectedPostingVersion',
  ];
  for (const key of versionFields) {
    const v = input[key as keyof PostFinanceExecutionInput] as unknown;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      errors[key] = 'Thiếu hoặc sai số phiên bản';
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

// --- Zod schema cho form (ba trường người dùng + amount tùy chọn) ---

/** Giá trị form của Posting dialog. */
export interface IncomeExpensePostingFormValues {
  postedOn: string;
  cashbookId: string;
  evidenceIds: string[];
  amount?: number;
}

/** Tùy chọn dựng schema — dialog suy từ subjectKind + capability nguồn. */
export interface IncomeExpensePostingSchemaOptions {
  /** Manual Thu/Chi → true (bắt buộc >= 1 chứng từ). */
  requireEvidence: boolean;
  /** MULTI_TRANCHE salary → true (hiện + validate ô số tiền). */
  allowAmount: boolean;
  /** Trần còn lại; bắt buộc khi allowAmount. */
  remainingAmount?: number;
}

/**
 * Dựng zod schema cho react-hook-form theo ngữ cảnh phiếu. Trả về `ZodType` cho
 * `zodResolver`. Field amount chỉ xuất hiện khi `allowAmount` (MULTI_TRANCHE).
 */
export function buildIncomeExpensePostingSchema(
  opts: IncomeExpensePostingSchemaOptions,
): z.ZodType<IncomeExpensePostingFormValues> {
  const postedOn = z
    .string({ required_error: 'Vui lòng chọn ngày' })
    .min(1, 'Vui lòng chọn ngày')
    .refine(isValidIsoDate, 'Ngày không hợp lệ (yyyy-MM-dd)');

  const cashbookId = z
    .string({ required_error: 'Vui lòng chọn sổ quỹ' })
    .min(1, 'Vui lòng chọn sổ quỹ')
    .refine(isUuid, 'Sổ quỹ không hợp lệ');

  const evidenceIds = opts.requireEvidence
    ? z
        .array(z.string().min(1))
        .min(1, 'Phiếu Thu/Chi thủ công cần ít nhất 1 chứng từ')
    : z.array(z.string().min(1));

  if (opts.allowAmount) {
    const remaining = opts.remainingAmount;
    const amount = z
      .number({
        required_error: 'Vui lòng nhập số tiền đợt chi',
        invalid_type_error: 'Số tiền không hợp lệ',
      })
      .positive('Số tiền phải lớn hơn 0')
      .refine(
        (v) => remaining == null || v <= remaining,
        remaining == null
          ? 'Thiếu hạn mức còn lại của quyết toán lương'
          : `Số tiền vượt hạn mức còn lại (${formatVND(remaining)})`,
      );
    return z.object({
      postedOn,
      cashbookId,
      evidenceIds,
      amount,
    }) as z.ZodType<IncomeExpensePostingFormValues>;
  }

  return z.object({
    postedOn,
    cashbookId,
    evidenceIds,
    // VOUCHER: không có ô số tiền; giữ optional/undefined để form đồng nhất.
    amount: z.undefined().optional(),
  }) as z.ZodType<IncomeExpensePostingFormValues>;
}
