// Mirror TypeScript của `app_private.copilot_action_registry` (migration G2-A
// `20260903043956_copilot_action_registry_policy_ledger_v1.sql`).
//
// VÌ SAO CÓ MỘT BẢN SAO Ở CLIENT
//   Sổ đăng ký hành động sống trên server: nó quyết định RPC nào được gọi, mức
//   rủi ro nào, cần kiểu đồng ý nào. Nhưng client vẫn phải biết TÊN của hành
//   động trước khi gọi bất cứ thứ gì — để dựng khoá rollout `action:<id>`, để
//   trang admin hiện đúng công tắc, và (từ G3) để dựng kế hoạch nhiều bước.
//   Không có bản sao thì mỗi chỗ cần một chuỗi lại tự gõ lại chuỗi đó.
//
//   Bản sao nào cũng có nguy cơ lệch bản gốc, nên cái giá phải trả nằm ở
//   `__tests__/actionCatalog.test.ts`: nó đọc THẲNG file migration, bóc mọi
//   dòng seed và so từng trường. Lệch một trường là đỏ, và mirror khai một
//   hành động không có trong seed cũng đỏ.
//
// TUYỆT ĐỐI KHÔNG DÙNG KHOÁ `name:` TRONG FILE NÀY
//   `scripts/check-copilot-tool-inventory.mjs` và
//   `scripts/check-copilot-forbidden-actions.mjs` cùng quét `src/copilot/plan`
//   và cùng coi MỌI `name: '...'` là một khai báo tool. Một entry catalog mang
//   khoá `name` sẽ được đếm vào bảng tool trong tài liệu — tức tài liệu kể một
//   con số tool mà registry không có. Nhãn hiển thị ở đây là `labelVi`.
import * as z from 'zod/v4';

import type { ActionKey } from '@/lib/permissions';

/**
 * Mức rủi ro theo thang của plan Copilot: L3 đọc-ghi nhẹ, L4 ghi nháp có xác
 * nhận, L5 ghi thẳng. L6 (deploy/secret/sql) KHÔNG có mặt ở đây và không bao
 * giờ được có — xem `tooling/copilot-action-policy.json`.
 */
export type MucRuiRo = 'L3' | 'L4' | 'L5';

/**
 * Cách hành động được thực thi:
 *   - `nonce_abi_v1`  — server phát nonce ở bước xem trước, giao diện tiêu nonce
 *                       sau một cú bấm thật (đường của phiếu thu/chi hôm nay).
 *   - `maker_submit_v1` — người tạo đề xuất, người khác duyệt.
 *   - `direct_l5_v1`  — ghi thẳng, chỉ mở khi policy cho phép L5.
 */
export type KieuThucThi = 'nonce_abi_v1' | 'maker_submit_v1' | 'direct_l5_v1';

/** Kiểu đồng ý bắt buộc trước khi thực thi. */
export type KieuDongY = 'click' | 'step_up';

export interface ActionCatalogEntry {
  actionId: string;
  version: number;
  labelVi: string;
  risk: MucRuiRo;
  executorKind: KieuThucThi;
  consentRequired: KieuDongY;
  permission: { module: string; action: ActionKey };
  inputSchema: z.ZodTypeAny;
  /** Tên trường trong khối `preview` mà RPC xem trước trả về. */
  previewFields: readonly string[];
  previewRpc: string;
  executeRpc: string;
}

/**
 * Input của `tao_phieu_thu_chi_nhap` — MỘT bản, dùng chung giữa tool và catalog.
 *
 * Chuyển từ `writeTools.ts` sang đây (không đổi một chữ nào trong nội dung
 * schema). Để hai bản song song là mời chúng lệch nhau: tool nhận một hình
 * dạng, catalog quảng cáo một hình dạng khác, và không gì bắt được chênh lệch
 * đó vì chẳng bên nào đọc bên kia.
 *
 * Đặt ở `plan/` chứ không phải `tools/` là có chủ ý: `featureFlags.ts` đọc
 * catalog để dựng contract rollout, còn `tools/registry.ts` đọc `featureFlags`.
 * Nếu catalog đi mượn schema từ `tools/writeTools.ts` thì vòng import khép kín
 * (featureFlags → catalog → writeTools → registry → featureFlags) và
 * `COPILOT_ROLLOUT_ACTION_CONTRACTS` — tính ở thời điểm nạp module — có thể đọc
 * phải `undefined`.
 */
export const SCHEMA_TAO_PHIEU_THU_CHI = z.object({
  loai: z.enum(['thu', 'chi']).describe('thu = phiếu THU, chi = phiếu CHI'),
  so_tien: z.number().positive().describe('Số tiền VND'),
  ten_phieu: z.string().min(3).describe('Tên/mô tả phiếu, vd "Chi mua bóng đèn toà X"'),
  toa_nha: z.string().min(1).describe('Tên toà nhà (khớp gần đúng)'),
  hang_muc: z.string().min(1).describe('Tên hạng mục thu/chi, vd "Vệ sinh", "Điện"'),
  ngay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('CHỈ truyền khi người dùng NÓI RÕ ngày cụ thể; bỏ trống = hệ thống tự lấy hôm nay'),
});

/**
 * Sổ hành động — khoá là `action_id` của server, không phải tên tool.
 *
 * Một hành động ở đây KHÔNG tự động sống: `copilot_feature_flags` có một hàng
 * `('action', <action_id>)` riêng và hàng đó đang `disabled` trên production.
 * Thêm một dòng vào bảng này mà quên seed cờ tương ứng nghĩa là dựng một công
 * tắc mà `set_copilot_feature_flag_v2` từ chối bật (`unknown_rollout_contract`).
 */
export const ACTION_CATALOG = {
  'income_expense.create_draft': {
    actionId: 'income_expense.create_draft',
    version: 1,
    labelVi: 'Tạo phiếu thu/chi nháp',
    risk: 'L4',
    executorKind: 'nonce_abi_v1',
    consentRequired: 'click',
    permission: { module: 'income_expenses', action: 'create' },
    inputSchema: SCHEMA_TAO_PHIEU_THU_CHI,
    previewFields: [
      'loai',
      'so_tien',
      'ten_phieu',
      'toa_nha',
      'hang_muc',
      'ngay',
      'trang_thai',
    ],
    previewRpc: 'copilot_preview_income_expense_v1',
    executeRpc: 'copilot_execute_income_expense_v1',
  },
} as const satisfies Record<string, ActionCatalogEntry>;

export type ActionId = keyof typeof ACTION_CATALOG;

/** `permission_key` như server ghi trong sổ đăng ký: `<module>.<action>`. */
export function khoaQuyenHanhDong(entry: ActionCatalogEntry): string {
  return `${entry.permission.module}.${entry.permission.action}`;
}

/**
 * Khoá rollout của một hành động.
 *
 * `copilotAvailability()` gắn tiền tố `page:` cho mọi khoá TRẦN, nên một khoá
 * hành động truyền vào dưới dạng `income_expense.create_draft` sẽ đi đọc trạng
 * thái của `page:income_expense.create_draft` — một hàng không tồn tại, tức
 * luôn `disabled`, và triệu chứng là "tool biến mất mà cờ vẫn đang bật". Hàm
 * này là chỗ DUY NHẤT được dựng chuỗi đó.
 */
export function khoaRolloutHanhDong(actionId: string): string {
  return `action:${actionId}`;
}
