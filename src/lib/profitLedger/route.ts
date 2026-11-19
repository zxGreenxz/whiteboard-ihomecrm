// Công tắc sổ tổng lợi nhuận cổ đông (`shareholder_profit.ledger_payout.v1`) → hành vi giao diện.
//
// Máy chủ trả `route` = app_private.evaluate_feature_route(...) ∈ LEGACY | SHADOW | CANONICAL | FROZEN
// (không có CANARY). Chuỗi lạ ⇒ LEGACY: đóng an toàn — không mở nút chi/duyệt nào chỉ vì
// máy chủ trả một giá trị giao diện chưa biết. Máy chủ vẫn là chốt cuối (E5/E9/E16/F1 tự chặn).

export const PROFIT_LEDGER_ROUTES = ['LEGACY', 'SHADOW', 'CANONICAL', 'FROZEN'] as const;
export type ProfitLedgerRoute = (typeof PROFIT_LEDGER_ROUTES)[number];

export function readProfitLedgerRoute(value: unknown): ProfitLedgerRoute {
  return typeof value === 'string' && (PROFIT_LEDGER_ROUTES as readonly string[]).includes(value)
    ? (value as ProfitLedgerRoute)
    : 'LEGACY';
}

export interface ProfitLedgerRouteState {
  route: ProfitLedgerRoute;
  /** Lập phiếu chi lợi nhuận cổ đông (E5), kể cả tạm ứng của người giữ sổ. */
  canPayShareholder: boolean;
  /** Huỷ phiếu chi theo sổ tổng (E6) — chạy ở mọi route. */
  canCancel: boolean;
  /** Đặt / gỡ mốc "đã trả đủ đến hết tháng X" (E9: SHADOW hoặc CANONICAL). */
  canSetMarker: boolean;
  /** Lập phiếu lương điều hành (manager_salary_payout_v1: FROZEN thì dừng). */
  canPayManager: boolean;
  /** Xác nhận phần lợi nhuận của phiếu lương cần xem lại (E16: SHADOW hoặc CANONICAL). */
  canResolveSalary: boolean;
  /** Duyệt / chi phiếu sổ tổng (F1 chỉ nhận CANONICAL). */
  canApprove: boolean;
  /** Số sổ tổng là số dùng thật (E3.ready): mọi route trừ LEGACY. */
  ledgerReady: boolean;
  /** Câu báo đầu trang cho người dùng; null khi sổ tổng chạy thật. */
  banner: string | null;
}

export const PROFIT_LEDGER_BANNERS = {
  LEGACY: 'Sổ tổng đang xem thử — chưa chi lợi nhuận cổ đông được',
  SHADOW: 'Đang đặt mốc đã trả đủ — chưa mở chi',
  FROZEN: 'Sổ tổng đang đóng băng — chỉ huỷ được, chưa chi hay duyệt được',
} as const;

const ROUTE_STATES: Readonly<Record<ProfitLedgerRoute, Omit<ProfitLedgerRouteState, 'route'>>> = {
  LEGACY: {
    canPayShareholder: false, canCancel: true, canSetMarker: false, canPayManager: true,
    canResolveSalary: false, canApprove: false, ledgerReady: false, banner: PROFIT_LEDGER_BANNERS.LEGACY,
  },
  SHADOW: {
    canPayShareholder: false, canCancel: true, canSetMarker: true, canPayManager: true,
    canResolveSalary: true, canApprove: false, ledgerReady: true, banner: PROFIT_LEDGER_BANNERS.SHADOW,
  },
  CANONICAL: {
    canPayShareholder: true, canCancel: true, canSetMarker: true, canPayManager: true,
    canResolveSalary: true, canApprove: true, ledgerReady: true, banner: null,
  },
  FROZEN: {
    canPayShareholder: false, canCancel: true, canSetMarker: false, canPayManager: false,
    canResolveSalary: false, canApprove: false, ledgerReady: true, banner: PROFIT_LEDGER_BANNERS.FROZEN,
  },
};

/** Bảng hành vi theo route. Nhận cả chuỗi thô: chuỗi lạ đi nhánh LEGACY. */
export function profitLedgerRouteState(route: unknown): ProfitLedgerRouteState {
  const known = readProfitLedgerRoute(route);
  return { route: known, ...ROUTE_STATES[known] };
}
