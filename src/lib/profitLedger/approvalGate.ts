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

/** Số dư theo dấu: dương = công ty còn phải trả; âm = người nhận đang tạm ứng. */
export function ledgerBalanceText(balance: number, kind: LedgerPayoutDetail['subject']['kind']): string {
  if (kind === 'MANAGER') return balance >= 0 ? `còn lại ${formatVND(balance)}` : `đã chi quá ${formatVND(-balance)}`;
  return balance >= 0 ? `còn phải trả ${formatVND(balance)}` : `đang tạm ứng ${formatVND(-balance)}`;
}

export interface LedgerApprovalNoteView {
  title: string;
  /** Dòng "Lúc lập …"; null với phiếu lập trước sổ tổng (không có dòng sổ). */
  atCreate: string | null;
  /** Dòng "Bây giờ …" (không tính chính phiếu này). */
  now: string;
  /** Lưu ý thêm (người giữ sổ tự tạm ứng, sổ chi cố định…). */
  notes: string[];
}

export function ledgerApprovalNoteView(detail: LedgerPayoutDetail): LedgerApprovalNoteView {
  const kind = detail.subject.kind;
  const manager = kind === 'MANAGER';
  const name = detail.subject.name;
  const splitLabel = manager ? 'vượt' : 'tạm ứng';
  const at = detail.at_create;
  const notes: string[] = [];
  if (at && at.maker_kind === 'CUSTODIAN_ADVANCE' && at.payee_is_maker) {
    notes.push('Người giữ sổ tự lập phiếu tạm ứng cho chính mình — người duyệt phải là chủ khác.');
  }
  if (detail.voucher.account_name) {
    notes.push(`Chỉ chi được từ sổ đã chọn lúc lập: ${detail.voucher.account_name}.`);
  }
  return {
    title: manager ? `Lương điều hành · ${name}` : `Chi lợi nhuận cổ đông · ${name}`,
    atCreate: at
      ? `Lúc lập: ${ledgerBalanceText(at.balance_before, kind)} · trong số dư ${formatVND(at.within)} · ${splitLabel} ${formatVND(at.advance)}`
      : null,
    now: `Bây giờ (không tính phiếu này): ${ledgerBalanceText(detail.now.balance_excluding_this, kind)} · duyệt thì trong số dư ${formatVND(detail.now.within)} · ${splitLabel} ${formatVND(detail.now.advance)}`,
    notes,
  };
}
