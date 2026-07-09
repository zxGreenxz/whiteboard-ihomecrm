// =============================================================================
// feeCategories.ts — REGISTRY hạng mục phí cho trang "Đóng tiền Tập trung theo Kỳ".
//
// Nguồn sự thật DUY NHẤT cho UI: mỗi hạng mục khai báo hành vi (family, đa kỳ,
// hạn chế, thang máy…). UI chỉ ĐỌC registry, không hardcode.
//
// ĐỒNG BỘ 3 NƠI (đổi 1 phải đổi cả 3):
//   • feeCategories.ts (file này) — matcher `feeTypeMatches`
//   • fixedExpenseCategories.ts — FIXED_EXPENSE_CATEGORIES (Báo cáo Lợi Nhuận)
//   • SQL: resolve_fixed_expense_type / fee_type_matches / get_period_fee_status
// Test parity: src/lib/feeCategories.test.ts
// =============================================================================

import { nrm } from '@/lib/fixedExpenseCategories';

export type FeeFamily = 'EN' | 'GRID' | 'COMMISSION' | 'MAINTENANCE_BATCH';
export type FeeGroup = 'Phí theo tòa' | 'Hoa hồng' | 'Bảo trì';

export interface FeeCategory {
  key: string;                 // registry key ('dien_nuoc','internet',…)
  label: string;               // nhãn hiển thị
  group: FeeGroup;             // nhóm trong ô chọn loại phí
  sub: string;                 // mô tả phụ (dưới tiêu đề)
  family: FeeFamily;
  /** Key icon (map sang lucide/custom trong UI — giữ registry pure). */
  icon: string;
  accent: string;              // màu nhấn (hex)
  multiPeriod: boolean;        // GRID: cho chọn khoảng kỳ (accrual)
  providerConfig: boolean;     // có ô mã NCC + số tiền mặc định theo tòa
  restricted: boolean;         // quan_ly: hạng mục hạn chế
  elevatorGated: boolean;      // chỉ tòa có has_elevator
  /** Key gửi cho RPC pay_period_fee/get_period_fee_status (GRID). */
  serverKey: string;
  canonicalTypeName: string;
  canonicalCategory: string;
  subtypes?: { key: string; label: string; canonicalTypeName: string; canonicalCategory: string }[];
}

// Thứ tự = thứ tự hiển thị trong ô chọn + bảng Tổng quan.
export const FEE_CATEGORIES: FeeCategory[] = [
  {
    key: 'dien_nuoc', label: 'Điện & Nước', group: 'Phí theo tòa',
    sub: 'chi cho EVN / cấp nước theo từng tòa', family: 'EN', icon: 'plug', accent: '#d98c1f',
    multiPeriod: false, providerConfig: true, restricted: false, elevatorGated: false,
    serverKey: 'dien_nuoc', canonicalTypeName: 'Đóng tiền điện', canonicalCategory: 'Điện',
  },
  {
    // providerConfig=false → lưới gọn 1 cột Ghi chú (không có mã NCC riêng).
    key: 'tien_nha', label: 'Tiền nhà', group: 'Phí theo tòa',
    sub: 'chi trả chủ tòa theo kỳ', family: 'GRID', icon: 'home', accent: '#1f7a52',
    multiPeriod: false, providerConfig: false, restricted: false, elevatorGated: false,
    serverKey: 'tien_nha', canonicalTypeName: 'Tiền nhà', canonicalCategory: 'Tiền nhà',
  },
  {
    key: 'internet', label: 'Internet', group: 'Phí theo tòa',
    sub: 'thường trả trước theo quý / năm', family: 'GRID', icon: 'wifi', accent: '#2f74d0',
    multiPeriod: true, providerConfig: true, restricted: false, elevatorGated: false,
    serverKey: 'internet', canonicalTypeName: 'Internet', canonicalCategory: 'Internet',
  },
  {
    key: 'quan_ly', label: 'Quản Lý', group: 'Phí theo tòa',
    sub: 'hạng mục hạn chế', family: 'GRID', icon: 'briefcase', accent: '#7c5cc4',
    multiPeriod: false, providerConfig: false, restricted: true, elevatorGated: false,
    serverKey: 'quan_ly', canonicalTypeName: 'Quản Lý', canonicalCategory: 'Quản Lý',
  },
  {
    key: 've_sinh', label: 'Vệ sinh định kỳ', group: 'Phí theo tòa',
    sub: 'vệ sinh tòa nhà định kỳ', family: 'GRID', icon: 'sparkles', accent: '#1f9d57',
    multiPeriod: false, providerConfig: false, restricted: false, elevatorGated: false,
    serverKey: 've_sinh', canonicalTypeName: 'Vệ sinh tòa nhà định kỳ', canonicalCategory: 'Vệ sinh',
  },
  {
    key: 'cong_an', label: 'Công An', group: 'Phí theo tòa',
    sub: 'thường trả trước nhiều kỳ', family: 'GRID', icon: 'shield', accent: '#c0392b',
    multiPeriod: true, providerConfig: true, restricted: false, elevatorGated: false,
    serverKey: 'cong_an', canonicalTypeName: 'Công an', canonicalCategory: 'Công an',
  },
  {
    key: 'rac', label: 'Rác', group: 'Phí theo tòa',
    sub: 'thu gom rác định kỳ', family: 'GRID', icon: 'trash', accent: '#8a6111',
    multiPeriod: true, providerConfig: true, restricted: false, elevatorGated: false,
    serverKey: 'rac', canonicalTypeName: 'Tiền rác', canonicalCategory: 'Rác',
  },
  {
    key: 'thang_may', label: 'Thang máy', group: 'Phí theo tòa',
    sub: 'chỉ tòa có thang máy', family: 'GRID', icon: 'elevator', accent: '#2b5aa0',
    multiPeriod: true, providerConfig: true, restricted: false, elevatorGated: true,
    serverKey: 'thang_may', canonicalTypeName: 'Bảo trì thang máy', canonicalCategory: 'Bảo Trì Thang Máy',
  },
  {
    key: 'hoa_hong', label: 'Hoa hồng môi giới', group: 'Hoa hồng',
    sub: 'theo hợp đồng ký trong kỳ', family: 'COMMISSION', icon: 'percent', accent: '#c97a10',
    multiPeriod: false, providerConfig: false, restricted: false, elevatorGated: false,
    serverKey: 'hoa_hong', canonicalTypeName: 'Hoa hồng môi giới', canonicalCategory: 'Hoa hồng',
  },
  {
    key: 'bao_tri', label: 'Bảo trì máy lạnh / máy giặt', group: 'Bảo trì',
    sub: 'phiếu tổng theo nhà cung cấp', family: 'MAINTENANCE_BATCH', icon: 'wrench', accent: '#1a6645',
    multiPeriod: false, providerConfig: false, restricted: false, elevatorGated: false,
    serverKey: 'bao_tri', canonicalTypeName: 'Bảo trì máy lạnh', canonicalCategory: 'Bảo Trì',
    subtypes: [
      { key: 'ml', label: 'Máy lạnh', canonicalTypeName: 'Bảo trì máy lạnh', canonicalCategory: 'Bảo Trì' },
      { key: 'mg', label: 'Máy giặt', canonicalTypeName: 'Bảo trì máy giặt', canonicalCategory: 'Bảo Trì' },
    ],
  },
];

export const FEE_GROUPS: FeeGroup[] = ['Phí theo tòa', 'Hoa hồng', 'Bảo trì'];

export const feeCategoryOf = (key: string): FeeCategory | undefined =>
  FEE_CATEGORIES.find((c) => c.key === key);

/** GRID server keys (dùng cho get_period_fee_status / Tổng quan). */
export const GRID_SERVER_KEYS = ['tien_nha', 'dien', 'nuoc', 'internet', 'quan_ly', 've_sinh', 'cong_an', 'rac', 'thang_may'];

// Server key của các hạng mục HẠN CHẾ — suy từ registry (đừng hardcode 'quan_ly'
// ở component: thêm hạng mục restricted mới là tự ăn theo).
export const RESTRICTED_SERVER_KEYS = FEE_CATEGORIES.filter((c) => c.restricted).map((c) => c.serverKey);

/** GRID keys hiển thị theo quyền xem hạng mục hạn chế. */
export const gridKeysFor = (canRestricted: boolean): string[] =>
  canRestricted ? GRID_SERVER_KEYS : GRID_SERVER_KEYS.filter((k) => !RESTRICTED_SERVER_KEYS.includes(k));

// Matcher: khớp 1 income_expense_type (category + name RAW) với 1 registry GRID
// server key. PORT TỪ SQL fee_type_matches + FIXED_EXPENSE_CATEGORIES (nrm).
export const feeTypeMatches = (
  serverKey: string,
  category: string | null | undefined,
  name: string | null | undefined,
): boolean => {
  const c = nrm(category);
  const n = nrm(name);
  switch (serverKey) {
    case 'internet': return c === 'internet' || n.includes('internet');
    case 'rac': return n.includes('rac');
    case 'cong_an': return c === 'ca' || n.includes('cong an');
    case 've_sinh': return (c === 've sinh' || n.includes('ve sinh toa nha')) && !n.includes('rac');
    case 'thang_may': return n.includes('thang may');
    case 'dien': return c === 'dien' || n.includes('tien dien');
    case 'nuoc': return c === 'nuoc' || n.includes('tien nuoc');
    case 'tien_nha': return c === 'tien nha' || n.includes('tien nha');
    case 'quan_ly': return n.includes('quan ly');
    default: return false;
  }
};
