// Màn Chờ duyệt (D2.9): người duyệt phiếu chi theo sổ tổng thấy số dư sổ tổng LÚC LẬP và BÂY GIỜ (E7),
// và biết trước khi nào máy chủ sẽ từ chối lệnh duyệt (chốt F1 — d1_chan_interface §2.1, §7).
// Chỉ là lớp hiển thị: máy chủ vẫn là chốt cuối (người lập / người nhận tự duyệt, thiếu quyền, phiếu lương
// cần xem lại… chỉ máy chủ biết — câu báo đi qua profitLedgerErrorMessage).

import { formatVND } from '@/lib/utils';
import type { LedgerPayoutDetail } from './ledgerReaders';
import { profitLedgerRouteState } from './route';

export interface LedgerApprovalGate {
  /** Lý do khoá nút Duyệt (và Duyệt và Chi); null = cho bấm. */
  blockReason: string | null;
  /** Sổ quỹ ghi trên phiếu lúc lập — "Duyệt và Chi" chỉ được chi từ sổ này (ACCOUNT_LOCKED). */
  accountId: string | null;
}

/** Thứ tự xét khớp thứ tự chốt duyệt của máy chủ: route → phiếu còn chờ / còn sống → người nhận → vượt số. */
export function ledgerApprovalGate(detail: LedgerPayoutDetail): LedgerApprovalGate {
  const accountId = detail.voucher.account_id;
  const route = profitLedgerRouteState(detail.route);
  if (!route.canApprove) {
    return {
      accountId,
      blockReason: route.route === 'FROZEN'
        ? 'Sổ tổng đang đóng băng — chưa duyệt hay chi được phiếu này (vẫn từ chối hoặc huỷ được).'
        : 'Sổ tổng chưa bật — chưa duyệt hay chi được phiếu này (vẫn từ chối hoặc huỷ được).',
    };
  }
  if (detail.voucher.approval_status !== 'UNAPPROVED') {
    return { accountId, blockReason: 'Phiếu không còn chờ duyệt — tải lại danh sách.' };
  }
  if (!detail.voucher.is_live) {
    return { accountId, blockReason: 'Phiếu đã bị từ chối hoặc rút — chỉ còn Huỷ.' };
  }
  if (detail.subject.is_deleted) {
    return { accountId, blockReason: 'Người nhận đã bị xoá — phiếu chỉ còn Huỷ.' };
  }
  if (detail.subject.kind === 'MANAGER' && detail.now.advance > 0) {
    return {
      accountId,
      blockReason: `Phiếu vượt lương điều hành còn lại (dư ${formatVND(detail.now.advance)}) — duyệt sẽ bị từ chối. Từ chối hoặc huỷ rồi lập lại đúng số.`,
    };
  }
  return { accountId, blockReason: null };
}

/**
 * Số dư ròng theo dấu.
 *   Lương điều hành: dương = còn lại; âm = đã chi quá.
 *   Cổ đông: số dư ròng = lợi nhuận chưa chi − tạm ứng (đang có + chờ duyệt). Dương = lợi nhuận chưa chi còn
 *   lại sau khi trừ tạm ứng; âm = tạm ứng đang vượt lợi nhuận chưa chi.
 */
export function ledgerBalanceText(balance: number, kind: LedgerPayoutDetail['subject']['kind']): string {
  if (kind === 'MANAGER') return balance >= 0 ? `còn lại ${formatVND(balance)}` : `đã chi quá ${formatVND(-balance)}`;
  return balance >= 0
    ? `lợi nhuận chưa chi sau khi trừ tạm ứng ${formatVND(balance)}`
    : `tạm ứng đang vượt lợi nhuận chưa chi ${formatVND(-balance)}`;
}

export interface LedgerApprovalNoteView {
  title: string;
  /** Dòng "Lúc lập …"; null với phiếu lập trước sổ tổng (không có dòng sổ). */
  atCreate: string | null;
  /** Dòng "Bây giờ …" (không tính chính phiếu này). */
  now: string;
  /** Lưu ý thêm (người giữ sổ tự tạm ứng / lập hộ, phiếu của lần chốt, sổ chi cố định…). */
  notes: string[];
}

/** Phần của một khoản `amount` vượt số dư ròng `balance` (số dư âm ⇒ vượt cả khoản). */
const overBalance = (amount: number, balance: number): number => amount - Math.min(amount, Math.max(balance, 0));

/**
 * Câu cho người duyệt một phiếu chi theo sổ tổng. Ba loại phiếu của CỔ ĐÔNG (theo dòng sổ lúc lập):
 *   · phiếu TẠM ỨNG (người giữ sổ tự ứng hoặc lập hộ; cả số tiền là tạm ứng): nói "tạm ứng X", vượt lợi nhuận
 *     chưa chi bao nhiêu thì nói rõ;
 *   · phiếu CHI LỢI NHUẬN do chủ lập (phiếu tiền của một lần chốt chi theo tháng): số tiền đã khấu trừ tạm ứng;
 *   · phiếu cũ lập bằng lệnh chi nhập tay (có tách "trong số dư / tạm ứng"): giữ nguyên cách nói lúc lập.
 */
export function ledgerApprovalNoteView(detail: LedgerPayoutDetail): LedgerApprovalNoteView {
  const kind = detail.subject.kind;
  const name = detail.subject.name;
  const at = detail.at_create;
  const { now } = detail;
  const notes: string[] = [];
  const accountNote = detail.voucher.account_name ? `Chỉ chi được từ sổ đã chọn lúc lập: ${detail.voucher.account_name}.` : null;
  const nowHead = `Bây giờ (không tính phiếu này): ${ledgerBalanceText(now.balance_excluding_this, kind)}`;

  if (kind === 'MANAGER') {
    if (accountNote) notes.push(accountNote);
    return {
      title: `Lương điều hành · ${name}`,
      atCreate: at
        ? `Lúc lập: ${ledgerBalanceText(at.balance_before, kind)} · trong số dư ${formatVND(at.within)} · vượt ${formatVND(at.advance)}`
        : null,
      now: `${nowHead} · duyệt thì trong số dư ${formatVND(now.within)} · vượt ${formatVND(now.advance)}`,
      notes,
    };
  }

  // Phiếu tạm ứng: người giữ sổ lập (cho mình hoặc lập hộ) và cả số tiền là tạm ứng.
  const isAdvance = !!at && at.maker_kind !== 'OWNER' && at.within === 0;
  if (at?.maker_kind === 'CUSTODIAN_ADVANCE' && at.payee_is_maker) {
    notes.push('Người giữ sổ tự lập phiếu tạm ứng cho chính mình — người duyệt phải là chủ khác.');
  }
  if (at?.maker_kind === 'CUSTODIAN_FOR_PAYEE') {
    notes.push('Người giữ sổ lập phiếu tạm ứng cho cổ đông — người duyệt là chủ, khác người lập và người nhận.');
  }

  if (isAdvance && at) {
    const overAtCreate = overBalance(at.advance, at.balance_before);
    notes.push('Tạm ứng cộng dồn; được khấu trừ khi chủ chốt chi lợi nhuận.');
    if (accountNote) notes.push(accountNote);
    return {
      title: `Tạm ứng lợi nhuận · ${name}`,
      atCreate: `Lúc lập: ${ledgerBalanceText(at.balance_before, kind)} · tạm ứng ${formatVND(at.advance)}`
        + (overAtCreate > 0 ? ` · vượt lợi nhuận chưa chi ${formatVND(overAtCreate)}` : ''),
      now: `${nowHead} · duyệt thì tạm ứng ${formatVND(detail.voucher.amount)}`
        + (now.advance > 0 ? ` · vượt lợi nhuận chưa chi ${formatVND(now.advance)}` : ' · không vượt lợi nhuận chưa chi'),
      notes,
    };
  }

  const legacySplit = !!at && at.advance > 0;
  if (at?.maker_kind === 'OWNER' && !legacySplit) {
    notes.push('Phiếu chi lợi nhuận do chủ lập. Phiếu sinh từ hộp chốt chi lợi nhuận thì số tiền này là phần còn lại sau khi đã khấu trừ tạm ứng đã duyệt.');
  }
  if (accountNote) notes.push(accountNote);
  return {
    title: `Chi lợi nhuận cổ đông · ${name}`,
    atCreate: at
      ? legacySplit
        ? `Lúc lập: ${ledgerBalanceText(at.balance_before, kind)} · trong số dư ${formatVND(at.within)} · tạm ứng ${formatVND(at.advance)}`
        : `Lúc lập: ${ledgerBalanceText(at.balance_before, kind)} · chi lợi nhuận ${formatVND(at.within)}`
      : null,
    now: nowHead + (now.advance > 0 ? ` · duyệt thì vượt lợi nhuận chưa chi ${formatVND(now.advance)}` : ' · duyệt thì không vượt lợi nhuận chưa chi'),
    notes,
  };
}
