// Dịch lỗi của sổ tổng lợi nhuận ra câu tiếng Việt cho người dùng.
//
// RẼ NHÁNH THEO MÃ, KHÔNG THEO HTTP. Qua PostgREST: 55000 ⇒ HTTP 500 (mọi lỗi trạng thái — route tắt,
// đóng băng, tháng đã chốt…), 22023 ⇒ 400, 42501 ⇒ 403, 23505 và PT409 ⇒ 409. Vì vậy "500" KHÔNG có
// nghĩa là sập và không được coi là "thử lại". Ta đọc `error.code` (SQLSTATE) + mã máy ở đầu
// `error.message` (`PROFIT_LEDGER_…:` / `SALARY_PROFIT_…:` / `PROFIT_MANAGER_LEDGER_…:`) và
// `error.details` (JSON khi có số liệu).
//
// Câu cho người dùng: ngắn, không lộ tên kỹ thuật (route, RPC, SHADOW…).

import { extractCode } from '@/lib/contracts/errors';
import { periodBlockMessage } from '@/lib/cashbookClosing';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { workflowFeedbackDescription } from '@/lib/financialWorkflowError';
import { formatVND } from '@/lib/utils';
import { voucherFailureMessage, voucherOutcomeUnknown } from '@/lib/voucherFeedback';
import { ProfitLedgerPayloadError } from './readPrimitives';

export type ProfitLedgerOperation =
  | 'read' | 'preview' | 'payout' | 'cancel' | 'marker' | 'resolve' | 'manager_payout'
  | 'approve' | 'salary_freeze' | 'salary_quote';

/** Bốn lệnh ghi đi qua khoá chống gửi trùng + đối chiếu của lớp dữ liệu: E5 chi · E6 huỷ · E9 mốc · E16 xác nhận lương. */
export type ProfitLedgerWriteOperation = Extract<ProfitLedgerOperation, 'payout' | 'cancel' | 'marker' | 'resolve'>;

const OPERATION_LABEL: Readonly<Record<ProfitLedgerOperation, string>> = {
  read: 'tải sổ lợi nhuận',
  preview: 'tính số dư lợi nhuận',
  payout: 'lập phiếu chi lợi nhuận',
  cancel: 'huỷ phiếu chi',
  marker: 'đặt mốc đã trả đủ',
  resolve: 'xác nhận phần lợi nhuận trong phiếu lương',
  manager_payout: 'lập phiếu lương điều hành',
  approve: 'duyệt phiếu chi lợi nhuận',
  salary_freeze: 'chốt phần lợi nhuận trong lương',
  salary_quote: 'ghi trước phần lợi nhuận trong phiếu lương',
};

export type ProfitLedgerErrorKind =
  /** 22023 PROFIT_LEDGER_ADVANCE_CONFIRM — vượt số còn phải trả, cần tick tạm ứng (detail {balance, within, advance}). */
  | 'ADVANCE_CONFIRM'
  /** 22023 PROFIT_MANAGER_LEDGER_OVERDRAW — lương điều hành vượt số còn lại (detail {balance, amount, over}). */
  | 'MANAGER_OVERDRAW'
  /** 22023 PROFIT_LEDGER_MARKER_ERASES_ADVANCE — mốc xoá dấu tạm ứng, cần tick (detail {advance_erased,…}). */
  | 'MARKER_ERASES_ADVANCE'
  /** 22023 SALARY_PROFIT_SETTLED_BY_MARKER — kỳ lương nằm trong mốc đã trả đủ (detail {marker_through}). */
  | 'SALARY_SETTLED_BY_MARKER'
  /** 55000 PROFIT_LEDGER_SALARY_REVIEW_PENDING — còn phiếu lương cần chủ xem lại (detail {count, suggested}). */
  | 'SALARY_REVIEW_PENDING'
  /** 55000 PROFIT_LEDGER_ROUTE_OFF — sổ tổng chưa mở cho thao tác này. */
  | 'ROUTE_OFF'
  /** 55000 PROFIT_LEDGER_FROZEN — sổ tổng đóng băng (huỷ vẫn được). */
  | 'FROZEN'
  /** 55000 cài đặt công ty chưa đủ (hạng mục chưa bắt buộc duyệt, luật duyệt, chưa có toà ảo). */
  | 'CONFIG'
  /** 55000/42501 phiếu sổ tổng đã khoá: chỉ huỷ có lý do được. */
  | 'LEDGER_LOCKED'
  /** Tháng lợi nhuận / sổ quỹ đã chốt, phiên bàn giao còn sống. */
  | 'PERIOD_LOCKED'
  /** PT409 PROFIT_LEDGER_MARKER_CHANGED — mốc vừa bị người khác đổi: tải lại E8. */
  | 'MARKER_CONFLICT'
  /** PT409 PROFIT_LEDGER_CANCEL_STATE_CHANGED — phiếu vừa đổi trạng thái (detail {expected, actual}). */
  | 'CANCEL_STATE_CHANGED'
  /** PT409 SALARY_PROFIT_QUOTE_CHANGED — số lợi nhuận / tạm ứng của tháng vừa đổi: tải lại bảng lương. */
  | 'SALARY_QUOTE_CHANGED'
  /** Dữ liệu khác vừa đổi (PT409 khác, dòng lương đã được xác nhận…): tải lại. */
  | 'STALE'
  /** 40P01 / 40001 / 55P03 / lệnh cùng khoá đang dở: hệ thống bận, thử lại. */
  | 'BUSY'
  /** 42501. */
  | 'FORBIDDEN'
  /** 23505 — khoá chống gửi trùng đã dùng với nội dung khác (lỗi lập trình). */
  | 'KEY_REUSED'
  /** 22023 / 23502 khác — đầu vào sai. */
  | 'VALIDATION'
  /** P0002. */
  | 'NOT_FOUND'
  /** Lỗi hệ thống: sổ lệch, dữ liệu hỏng, payload sai hợp đồng. */
  | 'SYSTEM'
  /** Không biết lệnh ghi đã chạy hay chưa (mất mạng, biên nhận hỏng): khoá gửi lại, đối chiếu. */
  | 'UNKNOWN_OUTCOME'
  /**
   * Đối chiếu một lần gửi chưa rõ kết quả bằng khoá cũ ⇒ 23505 "khoá đã dùng" của chính lệnh: lần đó ĐÃ ghi.
   * Dấu chờ đã xoá, nội dung vừa nhập CHƯA gửi; tải lại để xem — bấm lại là một lệnh mới (khoá mới).
   */
  | 'PRIOR_WRITTEN'
  | 'OTHER';

export interface ProfitLedgerErrorInfo {
  kind: ProfitLedgerErrorKind;
  /** Mã máy ở đầu MESSAGE (vd 'PROFIT_LEDGER_ADVANCE_CONFIRM'), null khi không có. */
  code: string | null;
  /** SQLSTATE hoặc mã PostgREST. */
  sqlstate: string | null;
  /** Câu tiếng Việt cho người dùng. */
  message: string;
  /** DETAIL JSON của máy chủ khi có. */
  detail?: Record<string, unknown>;
  /** Nên tải lại dữ liệu rồi để người dùng xem lại trước khi bấm tiếp. */
  reload: boolean;
}

const MACHINE_CODE = /^((?:PROFIT_LEDGER|SALARY_PROFIT|PROFIT_MANAGER_LEDGER|PROFIT_PAYOUT)_[A-Z0-9_]+)\s*:\s*/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseDetail(details: unknown): Record<string, unknown> | undefined {
  if (details && typeof details === 'object' && !Array.isArray(details)) return details as Record<string, unknown>;
  if (typeof details !== 'string' || !details.trim().startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    // DETAIL không phải JSON hợp lệ: không có số liệu để ghép vào câu báo; câu báo vẫn dựa trên mã lỗi.
    parsed = undefined;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

/** Số trong DETAIL (có thể là chuỗi numeric) — không đọc được thì bỏ khỏi câu, không bịa 0. */
function detailNumber(detail: Record<string, unknown> | undefined, key: string): number | null {
  const value = detail?.[key];
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const money = (n: number | null): string | null => (n === null ? null : formatVND(n));

function monthLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})/.exec(value);
  return m ? `${m[2]}/${m[1]}` : null;
}

const CANCEL_STATE_LABEL: Readonly<Record<string, string>> = {
  PENDING: 'đang chờ duyệt',
  APPROVED_UNPOSTED: 'đã duyệt, chưa chi tiền',
  POSTED: 'đã chi tiền',
  CANCELLED: 'đã huỷ',
};

/** Câu tiếng Việt thô của máy chủ chỉ dùng khi nó là câu cho người (có dấu, không tên kỹ thuật). */
function readableServerText(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 300) return null;
  if (/idempotency|_key|_id\b|uuid|sqlstate|function|relation|column|null value|violat/i.test(t)) return null;
  if (!/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(t)) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function withDetail(info: Omit<ProfitLedgerErrorInfo, 'detail'>, detail: Record<string, unknown> | undefined): ProfitLedgerErrorInfo {
  return detail ? { ...info, detail } : info;
}

function routeOffMessage(op: ProfitLedgerOperation): string {
  switch (op) {
    case 'payout': return 'Sổ tổng đang xem thử — chưa chi lợi nhuận cổ đông được.';
    case 'marker': return 'Sổ tổng chưa mở phần đặt mốc đã trả đủ.';
    case 'resolve': return 'Sổ tổng chưa mở phần xác nhận lợi nhuận trong phiếu lương.';
    case 'approve': return 'Sổ tổng chưa bật — chưa duyệt hay chi phiếu này được (vẫn huỷ được).';
    case 'manager_payout': return 'Chi lương điều hành chưa bật ở công ty này.';
    default: return 'Sổ tổng lợi nhuận chưa mở cho thao tác này.';
  }
}

const LOCKED_MESSAGES: Readonly<Record<string, string>> = {
  PROFIT_LEDGER_CANCEL_ONLY: 'Phiếu chi theo sổ tổng chỉ bỏ được bằng nút Huỷ (ghi lý do).',
  PROFIT_LEDGER_LOCKED: 'Phiếu chi theo sổ tổng đã khoá, không sửa được. Muốn bỏ phiếu thì dùng Huỷ có lý do.',
  PROFIT_LEDGER_ACCOUNT_LOCKED: 'Phiếu này chỉ chi được từ sổ quỹ đã chọn lúc lập.',
  PROFIT_LEDGER_ITEMS_LOCKED: 'Dòng hạng mục của phiếu chi theo sổ tổng đã khoá.',
  PROFIT_LEDGER_NO_DELETE: 'Phiếu chi theo sổ tổng không xoá được — dùng Huỷ có lý do.',
  PROFIT_LEDGER_V2_ONLY: 'Duyệt hoặc chi phiếu này ở màn Chờ duyệt.',
  PROFIT_LEDGER_REPOST: 'Phiếu đã đảo không chi lại được — lập phiếu mới.',
  PROFIT_LEDGER_VOUCHER_DEAD: 'Phiếu đã bị từ chối hoặc rút — chỉ còn Huỷ.',
  PROFIT_LEDGER_NO_PENDING_REQUEST: 'Phiếu không còn yêu cầu duyệt đang chờ.',
  PROFIT_LEDGER_IN_HANDOVER: 'Phiếu đang nằm trong phiên bàn giao tiền mặt — huỷ phiên bàn giao trước rồi mới huỷ phiếu.',
  PROFIT_LEDGER_SUBJECT_GONE: 'Người nhận đã bị xoá hoặc ngưng — phiếu chỉ còn Huỷ.',
  PROFIT_LEDGER_CREATE_ONLY: 'Phiếu chi theo sổ tổng chỉ lập được bằng hộp Chi lợi nhuận, ở trạng thái chờ duyệt.',
  PROFIT_LEDGER_SALARY_VOUCHER_DEAD: 'Phiếu lương đã huỷ hoặc bị từ chối — không cần xác nhận nữa.',
};

const FORBIDDEN_MESSAGES: Readonly<Record<string, string>> = {
  PROFIT_LEDGER_FORBIDDEN: 'Bạn không có quyền xem sổ lợi nhuận này.',
  PROFIT_LEDGER_ADVANCE_SELF_ONLY: 'Quyền tạm ứng chỉ chi cho chính mình.',
  PROFIT_LEDGER_ADVANCE_CASHBOOK: 'Quyền tạm ứng chỉ chi từ sổ quỹ bạn đang giữ.',
  PROFIT_LEDGER_MAKER_SELF_APPROVE: 'Người lập phiếu không tự duyệt được — cần một chủ khác duyệt.',
  PROFIT_LEDGER_PAYEE_SELF_APPROVE: 'Người nhận tiền không tự duyệt được — cần một chủ khác duyệt.',
  PROFIT_LEDGER_APPROVE_FORBIDDEN: 'Bạn không có quyền duyệt khoản này.',
  PROFIT_LEDGER_PAYEE_SELF_POST: 'Người nhận tiền không tự chi khoản này — cần người giữ sổ khác chi.',
  PROFIT_LEDGER_CANCEL_FORBIDDEN: 'Bạn không có quyền huỷ phiếu này (người lập chỉ tự huỷ được phiếu còn chờ duyệt).',
  PROFIT_LEDGER_CANCEL_PAYEE: 'Người nhận tiền không tự huỷ phiếu đã duyệt hoặc đã chi cho mình — cần một chủ khác huỷ.',
  PROFIT_LEDGER_CANCEL_CUSTODIAN: 'Huỷ phiếu đã chi phải do người đang giữ đúng sổ quỹ của phiếu (tiền đảo về sổ đó).',
  PROFIT_LEDGER_NOT_MEMBER: 'Bạn không còn là thành viên công ty của phiếu.',
  PROFIT_LEDGER_ACTOR_REQUIRED: 'Phiên đăng nhập đã hết — đăng nhập lại rồi thử.',
  PROFIT_LEDGER_SALARY_SELF_RESOLVE: 'Không tự xác nhận dòng lương của chính mình — cần một chủ khác.',
  SALARY_PROFIT_DENIED: 'Bạn không có quyền với phần lợi nhuận trong lương của nhân viên này.',
  PROFIT_PAYOUT_CHAIN_WRITER_REQUIRED: 'Phiếu chi lợi nhuận chỉ lập được qua hộp Chi lợi nhuận.',
};

const SYSTEM_MESSAGES: Readonly<Record<string, string>> = {
  PROFIT_LEDGER_ENTRIES_DRIFT: 'Sổ chi tiết chưa cộng ra đúng số dư — chưa hiện sổ. Báo bộ phận kỹ thuật.',
  PROFIT_LEDGER_MARKER_MISMATCH: 'Số dư sau khi đặt mốc khác số xem trước — chưa đặt mốc. Báo bộ phận kỹ thuật.',
  PROFIT_LEDGER_NO_PAYOUT_ROW: 'Phiếu thiếu dòng sổ tổng — báo quản trị.',
  PROFIT_LEDGER_VOUCHER_MISMATCH: 'Phiếu không còn khớp dòng sổ lúc lập — báo quản trị.',
  PROFIT_LEDGER_POSTING_MISSING: 'Phiếu đã chi nhưng không thấy bút toán gốc — báo quản trị trước khi huỷ.',
  PROFIT_LEDGER_REVERSAL_UNBALANCED: 'Bút toán đảo không triệt tiêu — chưa huỷ. Báo quản trị.',
  PROFIT_LEDGER_CONTEXT: 'Lệnh ghi sổ tổng sai ngữ cảnh — báo quản trị.',
  PROFIT_LEDGER_SHAREHOLDER_AMBIGUOUS: 'Tài khoản của bạn đang gắn với nhiều cổ đông trong công ty này — nhờ chủ công ty gộp lại trước khi xem.',
  PROFIT_LEDGER_SALARY_VOUCHER_CONFLICT: 'Phiếu lương đang gắn với cổ đông khác — báo quản trị.',
};

const NOT_FOUND_MESSAGES: Readonly<Record<string, string>> = {
  PROFIT_LEDGER_SUBJECT_NOT_FOUND: 'Không tìm thấy cổ đông / người nhận trong công ty này.',
  PROFIT_LEDGER_VOUCHER_NOT_FOUND: 'Phiếu không còn tồn tại.',
  PROFIT_LEDGER_SALARY_LINE_NOT_FOUND: 'Không tìm thấy dòng phiếu lương cần xác nhận.',
};

function classifyCoded(
  code: string,
  sqlstate: string | null,
  serverText: string,
  detail: Record<string, unknown> | undefined,
  op: ProfitLedgerOperation,
): ProfitLedgerErrorInfo | null {
  const base = { code, sqlstate, reload: false } as const;
  switch (code) {
    case 'PROFIT_LEDGER_ADVANCE_CONFIRM': {
      const balance = money(detailNumber(detail, 'balance'));
      const advance = money(detailNumber(detail, 'advance'));
      const message = balance && advance
        ? `Số tiền vượt số còn phải trả ${balance}. Phần vượt ${advance} là tạm ứng lợi nhuận — tick xác nhận tạm ứng và ghi lý do rồi gửi lại.`
        : 'Số tiền vượt số còn phải trả — phần vượt là tạm ứng lợi nhuận. Tick xác nhận tạm ứng và ghi lý do rồi gửi lại.';
      return withDetail({ ...base, kind: 'ADVANCE_CONFIRM', message }, detail);
    }
    case 'PROFIT_MANAGER_LEDGER_OVERDRAW': {
      const balance = money(detailNumber(detail, 'balance'));
      const over = money(detailNumber(detail, 'over'));
      const message = balance && over
        ? `Vượt lương điều hành còn lại ${balance} (dư ${over}). Không chi quá số còn lại.`
        : 'Số tiền vượt lương điều hành còn lại. Không chi quá số còn lại.';
      return withDetail({ ...base, kind: 'MANAGER_OVERDRAW', message }, detail);
    }
    case 'PROFIT_LEDGER_MARKER_ERASES_ADVANCE': {
      const erased = money(detailNumber(detail, 'advance_erased'));
      const message = erased
        ? `Mốc này loại các phiếu có phần tạm ứng tổng ${erased}. Tick xác nhận riêng rồi gửi lại.`
        : 'Mốc này xoá dấu một khoản tạm ứng. Tick xác nhận riêng rồi gửi lại.';
      return withDetail({ ...base, kind: 'MARKER_ERASES_ADVANCE', message }, detail);
    }
    case 'SALARY_PROFIT_SETTLED_BY_MARKER': {
      const through = monthLabel(detail?.marker_through);
      const message = through
        ? `Tháng lương này nằm trong mốc "đã trả đủ đến hết ${through}" — phần lợi nhuận đã trả, không trả lại qua lương.`
        : 'Tháng lương này nằm trong mốc "đã trả đủ" — phần lợi nhuận đã trả, không trả lại qua lương.';
      return withDetail({ ...base, kind: 'SALARY_SETTLED_BY_MARKER', message }, detail);
    }
    case 'PROFIT_LEDGER_SALARY_REVIEW_PENDING': {
      const n = detailNumber(detail, 'count');
      const message = n
        ? `Cổ đông còn ${n} phiếu lương cần chủ xem lại phần lợi nhuận. Xác nhận phần lương trước rồi mới chi.`
        : 'Cổ đông còn phiếu lương cần chủ xem lại phần lợi nhuận. Xác nhận phần lương trước rồi mới chi.';
      return withDetail({ ...base, kind: 'SALARY_REVIEW_PENDING', message }, detail);
    }
    case 'PROFIT_LEDGER_ROUTE_OFF':
      return withDetail({ ...base, kind: 'ROUTE_OFF', message: routeOffMessage(op) }, detail);
    case 'PROFIT_LEDGER_FROZEN':
      return withDetail({ ...base, kind: 'FROZEN', message: 'Sổ tổng đang đóng băng — chỉ huỷ được, chưa chi hay duyệt được.' }, detail);
    case 'PROFIT_LEDGER_TYPE_NOT_FORCED':
      return withDetail({ ...base, kind: 'CONFIG', message: 'Hạng mục "Chia lợi nhuận cổ đông" phải bật "Bắt buộc duyệt" mới lập được phiếu. Báo chủ công ty kiểm tra.' }, detail);
    case 'PROFIT_LEDGER_REQUEST_NOT_PENDING':
      return withDetail({ ...base, kind: 'CONFIG', message: 'Luật duyệt của công ty không đưa phiếu này vào hàng chờ duyệt — chưa lập phiếu. Báo chủ công ty kiểm tra luật duyệt.' }, detail);
    case 'PROFIT_LEDGER_PROFIT_MONTH_LOCKED':
    case 'PROFIT_LEDGER_CASHBOOK_CLOSED':
      return withDetail({ ...base, kind: 'PERIOD_LOCKED', message: readableServerText(serverText) ?? 'Kỳ của phiếu đã chốt — chọn ngày chi khác.' }, detail);
    case 'PROFIT_LEDGER_MARKER_CHANGED':
      return withDetail({ ...base, kind: 'MARKER_CONFLICT', reload: true, message: 'Mốc vừa được người khác đổi — đã tải lại. Xem trước lần nữa rồi bấm lại.' }, detail);
    case 'PROFIT_LEDGER_CANCEL_STATE_CHANGED': {
      const actual = typeof detail?.actual === 'string' ? CANCEL_STATE_LABEL[detail.actual] : undefined;
      const message = actual
        ? `Phiếu vừa đổi trạng thái (bây giờ: ${actual}). Xem lại rồi quyết định có huỷ không.`
        : 'Phiếu vừa đổi trạng thái. Xem lại rồi quyết định có huỷ không.';
      return withDetail({ ...base, kind: 'CANCEL_STATE_CHANGED', reload: true, message }, detail);
    }
    case 'SALARY_PROFIT_QUOTE_CHANGED':
      return withDetail({ ...base, kind: 'SALARY_QUOTE_CHANGED', reload: true, message: 'Số lợi nhuận hoặc tạm ứng của tháng vừa đổi — tải lại bảng lương rồi làm lại.' }, detail);
    case 'PROFIT_LEDGER_SALARY_LINE_STATE':
      return withDetail({ ...base, kind: 'STALE', reload: true, message: 'Dòng phiếu lương này không còn chờ xác nhận (có thể người khác vừa xác nhận) — tải lại.' }, detail);
    case 'SALARY_PROFIT_OPERATION_PENDING':
      return withDetail({ ...base, kind: 'BUSY', message: 'Lệnh trước còn đang chạy — chờ một lát rồi thử lại.' }, detail);
    case 'PROFIT_LEDGER_IDEMPOTENCY_REUSED':
    case 'SALARY_PROFIT_IDEMPOTENCY_CONFLICT':
      return withDetail({ ...base, kind: 'KEY_REUSED', message: 'Lần gửi này trùng mã với một lần gửi khác nội dung — đóng hộp rồi làm lại.' }, detail);
    case 'PROFIT_LEDGER_IDEMPOTENCY_KEY':
    case 'SALARY_PROFIT_BAD_KEY':
      return withDetail({ ...base, kind: 'VALIDATION', message: 'Mã chống gửi trùng không hợp lệ — đóng hộp rồi làm lại.' }, detail);
    case 'PROFIT_LEDGER_MARKER_MONTH':
      return withDetail({ ...base, kind: 'VALIDATION', message: 'Chỉ đặt mốc cho tháng đã qua (trước tháng hiện tại).' }, detail);
    case 'PROFIT_LEDGER_CANCEL_REASON':
      return withDetail({ ...base, kind: 'VALIDATION', message: 'Lý do huỷ phải từ 8 đến 1000 ký tự.' }, detail);
    case 'PROFIT_LEDGER_BAD_REASON':
    case 'PROFIT_LEDGER_REASON':
      return withDetail({ ...base, kind: 'VALIDATION', message: 'Lý do phải từ 8 đến 1000 ký tự.' }, detail);
    case 'PROFIT_LEDGER_SALARY_RESOLVE_RANGE': {
      const min = money(detailNumber(detail, 'min_investment'));
      const max = money(detailNumber(detail, 'max_investment'));
      const maxOffset = money(detailNumber(detail, 'max_offset'));
      const message = min && max && maxOffset
        ? `Số xác nhận nằm ngoài phần còn lại của tháng: phần đầu tư từ ${min} đến ${max}, trừ tạm ứng tối đa ${maxOffset}, và không vượt tiền phiếu.`
        : 'Số xác nhận nằm ngoài phần còn lại của tháng hoặc vượt tiền phiếu.';
      return withDetail({ ...base, kind: 'VALIDATION', message }, detail);
    }
    case 'PROFIT_LEDGER_NOT_LEDGER_VOUCHER':
      return withDetail({ ...base, kind: 'VALIDATION', message: 'Phiếu này không phải phiếu chi theo sổ tổng — dùng lệnh huỷ thường.' }, detail);
    default:
      break;
  }
  if (LOCKED_MESSAGES[code]) return withDetail({ ...base, kind: 'LEDGER_LOCKED', message: LOCKED_MESSAGES[code]! }, detail);
  if (FORBIDDEN_MESSAGES[code]) return withDetail({ ...base, kind: 'FORBIDDEN', message: FORBIDDEN_MESSAGES[code]! }, detail);
  if (SYSTEM_MESSAGES[code]) return withDetail({ ...base, kind: 'SYSTEM', message: SYSTEM_MESSAGES[code]! }, detail);
  if (NOT_FOUND_MESSAGES[code]) return withDetail({ ...base, kind: 'NOT_FOUND', message: NOT_FOUND_MESSAGES[code]! }, detail);
  // Mã mới chưa có câu riêng: theo SQLSTATE, giữ câu tiếng Việt của máy chủ nếu đọc được.
  return null;
}

function classifyBySqlstate(
  sqlstate: string | null,
  code: string | null,
  rawMessage: string,
  serverText: string,
  detail: Record<string, unknown> | undefined,
  op: ProfitLedgerOperation,
  error: unknown,
): ProfitLedgerErrorInfo {
  const base = { code, sqlstate, reload: false } as const;
  const readable = readableServerText(serverText);
  const label = OPERATION_LABEL[op];
  if (sqlstate === '40P01' || sqlstate === '40001' || sqlstate === '55P03') {
    return withDetail({ ...base, kind: 'BUSY', message: 'Hệ thống đang bận — thử lại sau giây lát.' }, detail);
  }
  if (sqlstate === '42501' || sqlstate === 'PGRST301') {
    return withDetail({ ...base, kind: 'FORBIDDEN', message: readable ?? `Bạn không có quyền ${label}.` }, detail);
  }
  if (sqlstate === '23505' || /idempotency_key đã dùng/i.test(rawMessage)) {
    return withDetail({ ...base, kind: 'KEY_REUSED', message: 'Lần gửi này trùng mã với một lần gửi khác nội dung — đóng hộp rồi làm lại.' }, detail);
  }
  if (/idempotency_key/i.test(rawMessage)) {
    return withDetail({ ...base, kind: 'VALIDATION', message: 'Mã chống gửi trùng không hợp lệ — đóng hộp rồi làm lại.' }, detail);
  }
  if (sqlstate === '22023' || sqlstate === '23502' || sqlstate === '22P02' || sqlstate === '23514') {
    return withDetail({ ...base, kind: 'VALIDATION', message: readable ?? `Thông tin nhập chưa hợp lệ — chưa ${label}.` }, detail);
  }
  if (sqlstate === 'P0002') {
    return withDetail({ ...base, kind: 'NOT_FOUND', message: readable ?? 'Không tìm thấy dữ liệu cần xử lý — tải lại.' }, detail);
  }
  if (sqlstate === 'PT409') {
    return withDetail({ ...base, kind: 'STALE', reload: true, message: 'Dữ liệu vừa được người khác thay đổi — tải lại rồi xem lại trước khi làm tiếp.' }, detail);
  }
  if (sqlstate === 'XX000') {
    return withDetail({ ...base, kind: 'SYSTEM', message: 'Số liệu sổ lợi nhuận đang lệch — báo bộ phận kỹ thuật.' }, detail);
  }
  if (sqlstate === '55000') {
    if (/chưa có toà ảo|has no steps|REQUIRE_APPROVAL/i.test(rawMessage)) {
      return withDetail({ ...base, kind: 'CONFIG', message: readable ?? 'Cài đặt duyệt của công ty chưa đủ để lập phiếu này. Báo chủ công ty kiểm tra.' }, detail);
    }
    if (/chưa bật/i.test(rawMessage)) {
      return withDetail({ ...base, kind: 'ROUTE_OFF', message: routeOffMessage(op) }, detail);
    }
  }
  return withDetail({ ...base, kind: 'OTHER', message: readable ?? voucherFailureMessage(error, label) }, detail);
}

/**
 * Câu 23505 "khoá chống gửi trùng đã dùng với nội dung khác" của ĐÚNG từng lệnh (thân hàm Đợt 1):
 * E5 và E9 (qua `profit_ledger_tao_set_marker_v1`) không có mã máy; E6 `PROFIT_LEDGER_IDEMPOTENCY_REUSED`;
 * E16 `SALARY_PROFIT_IDEMPOTENCY_CONFLICT`. 23505 khác (trùng khoá duy nhất của một bảng…) không khớp.
 */
const IDEMPOTENCY_CONFLICT: Readonly<Record<ProfitLedgerWriteOperation, RegExp>> = {
  payout: /^idempotency_key đã dùng với nội dung khác$/,
  marker: /^idempotency_key đã dùng với nội dung khác$/,
  cancel: /^PROFIT_LEDGER_IDEMPOTENCY_REUSED\s*:/,
  resolve: /^SALARY_PROFIT_IDEMPOTENCY_CONFLICT\s*:/,
};

/**
 * Lỗi máy chủ là "khoá đã dùng với nội dung khác" của CHÍNH lệnh `op`. Dòng chống gửi trùng ghi trong
 * cùng giao dịch với lệnh (lỗi ⇒ lùi cả dòng) nên chỉ còn khi lần gửi mang khoá đó ĐÃ ghi xong: gửi lại
 * ĐÚNG khoá của một lần chưa rõ kết quả mà gặp lỗi này ⇒ lần đó đã ghi.
 */
export function isLedgerIdempotencyConflict(error: unknown, op: ProfitLedgerWriteOperation): boolean {
  if (extractCode(error) !== '23505') return false;
  const message = record(error).message;
  return typeof message === 'string' && IDEMPOTENCY_CONFLICT[op].test(message.normalize('NFC').trim());
}

/** Lượt đối chiếu chứng minh lần gửi trước ĐÃ ghi (isLedgerIdempotencyConflict); dấu chờ đã xoá, lần sau khoá mới. */
export class ProfitLedgerPriorWrittenError extends Error {
  readonly operation: ProfitLedgerWriteOperation;

  constructor(operation: ProfitLedgerWriteOperation) {
    super('Yêu cầu trước đó đã được ghi; tải lại để xem. Nội dung vừa nhập chưa được gửi.');
    this.name = 'ProfitLedgerPriorWrittenError';
    this.operation = operation;
  }
}

/**
 * Phân loại + câu cho người dùng của một lỗi sổ tổng.
 * `op` chỉ đổi câu chữ (vd route tắt ở hộp chi khác ở hộp mốc); cách phân loại không đổi.
 */
export function profitLedgerErrorMessage(error: unknown, op: ProfitLedgerOperation): ProfitLedgerErrorInfo {
  const label = OPERATION_LABEL[op];
  const readOnly = op === 'read' || op === 'preview';

  if (error instanceof ProfitLedgerPriorWrittenError) {
    return { kind: 'PRIOR_WRITTEN', code: null, sqlstate: '23505', reload: true, message: error.message };
  }
  if (error instanceof FinancialWorkflowError) {
    if (error.outcome !== 'failure') {
      return { kind: 'UNKNOWN_OUTCOME', code: null, sqlstate: null, reload: true, message: workflowFeedbackDescription(error) };
    }
    // Từ chối đã chắc chắn: phân loại theo lỗi gốc nếu có, không thì giữ câu của luồng.
    if (error.cause && typeof error.cause === 'object' && extractCode(error.cause)) return profitLedgerErrorMessage(error.cause, op);
    return { kind: 'OTHER', code: null, sqlstate: null, reload: false, message: error.message };
  }
  if (error instanceof ProfitLedgerPayloadError) {
    return readOnly
      ? { kind: 'SYSTEM', code: null, sqlstate: null, reload: true, message: error.message }
      : {
          kind: 'UNKNOWN_OUTCOME', code: null, sqlstate: null, reload: true,
          message: `Chưa đọc được kết quả ${label}. Tải lại để kiểm tra trước khi làm tiếp; đừng lập lại.`,
        };
  }

  const row = record(error);
  const sqlstate = extractCode(error);
  const rawMessage = typeof row.message === 'string' ? row.message : '';
  const match = MACHINE_CODE.exec(rawMessage);
  const code = match ? match[1]! : null;
  const serverText = match ? rawMessage.slice(match[0].length) : rawMessage;
  const detail = parseDetail(row.details);

  if (!sqlstate && voucherOutcomeUnknown(error)) {
    return readOnly
      ? { kind: 'OTHER', code: null, sqlstate: null, reload: true, message: 'Mất kết nối — chưa tải được số liệu. Thử tải lại.' }
      : {
          kind: 'UNKNOWN_OUTCOME', code: null, sqlstate: null, reload: true,
          message: `Chưa xác nhận được kết quả ${label}. Tải lại để kiểm tra trước khi làm tiếp; đừng lập lại.`,
        };
  }

  const period = periodBlockMessage(rawMessage);
  if (period) return withDetail({ kind: 'PERIOD_LOCKED', code, sqlstate, reload: false, message: period }, detail);

  if (code) {
    const coded = classifyCoded(code, sqlstate, serverText, detail, op);
    if (coded) return coded;
  }
  return classifyBySqlstate(sqlstate, code, rawMessage, serverText, detail, op, error);
}

/** Lỗi đọc E3 khi người xem không phải cổ đông có quyền xem — màn hình ẩn khối, không báo lỗi. */
export function isProfitLedgerForbidden(error: unknown): boolean {
  if (extractCode(error) !== '42501') return false;
  const message = record(error).message;
  return typeof message === 'string' && message.startsWith('PROFIT_LEDGER_FORBIDDEN');
}
