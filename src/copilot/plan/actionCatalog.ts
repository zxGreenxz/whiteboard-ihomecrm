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
 * Input của `ghi_chu_phieu_thu_chi` — action L3 `income_expense.annotate`.
 *
 * `notes` THAY THẾ toàn bộ ghi chú cũ (`p_note_mode = 'REPLACE'` ở RPC gốc).
 * Không có đường nào để mô hình gắn/gỡ ảnh chứng từ: `annotate_income_expense_v1`
 * nhận hai tham số đính kèm, nhưng RPC bọc luôn truyền NULL cho cả hai. Ảnh là
 * bằng chứng chứng từ, và một mô hình dựng URL ảnh là một đường đưa nội dung
 * ngoài vào sổ.
 */
export const SCHEMA_GHI_CHU_PHIEU_THU_CHI = z.object({
  voucher_id: z.string().uuid().describe('ID phiếu thu/chi cần sửa ghi chú'),
  notes: z
    .string()
    .max(5000)
    .describe('Ghi chú MỚI — thay thế toàn bộ ghi chú hiện có của phiếu'),
});

/**
 * Input của `dat_han_giu_cho` — action L3 `reservation.set_hold_terms`.
 *
 * Cả ba mốc đều nhận `null` với nghĩa "bỏ mốc này"; cả ba cùng `null` là lệnh
 * XOÁ dòng kỳ hạn — hành vi hợp lệ của RPC gốc, không phải lỗi.
 */
export const SCHEMA_HAN_GIU_CHO = z.object({
  income_expense_id: z.string().uuid().describe('ID phiếu THU cọc giữ chỗ'),
  hold_until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .describe('Hạn làm hợp đồng (YYYY-MM-DD); null = bỏ mốc này'),
  topup_due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .describe('Hạn bổ sung cọc (YYYY-MM-DD); null = bỏ mốc này'),
  deposit_target: z
    .number()
    .positive()
    .nullable()
    .optional()
    .describe('Số cọc cần đủ (VND); null = bỏ mốc này'),
});

/**
 * Input của `dat_co_hoi_thoai_zalo` — action L3 `zalo.set_conversation_flags`.
 *
 * `null`/vắng mặt nghĩa là GIỮ NGUYÊN cờ đó (đúng ngữ nghĩa `COALESCE` của RPC
 * gốc). Ba cờ đều là cờ hiển thị: không gửi tin, không đổi nội dung hội thoại.
 */
export const SCHEMA_CO_HOI_THOAI_ZALO = z.object({
  conversation_id: z.string().uuid().describe('ID hội thoại Zalo'),
  pinned: z.boolean().nullable().optional().describe('Ghim hội thoại; bỏ trống = giữ nguyên'),
  muted: z.boolean().nullable().optional().describe('Tắt tiếng; bỏ trống = giữ nguyên'),
  marked_unread: z
    .boolean()
    .nullable()
    .optional()
    .describe('Đánh dấu chưa đọc; bỏ trống = giữ nguyên'),
});

/**
 * Input của `ghi_chi_so_cong_to` — action L4 `meter_reading.create`.
 *
 * `current_reading` là chỉ số ĐỌC ĐƯỢC TRÊN MẶT CÔNG TƠ, không phải lượng tiêu
 * thụ. Lượng tiêu thụ do server tính (mới − trước) và trả trong bản xem trước;
 * mô hình không gửi nó lên, và cũng không có đường nào gửi.
 *
 * KHÔNG có trường ảnh. `create_meter_reading_v1` nhận `p_meter_image_url`,
 * nhưng RPC bọc luôn truyền NULL: ảnh công tơ là bằng chứng đo đếm, và một mô
 * hình dựng URL ảnh là một đường đưa nội dung ngoài vào hồ sơ đo.
 */
export const SCHEMA_GHI_CHI_SO_CONG_TO = z.object({
  meter_id: z.string().uuid().describe('ID công tơ cần ghi chỉ số'),
  reading_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Ngày chốt chỉ số (YYYY-MM-DD)'),
  current_reading: z
    .number()
    .nonnegative()
    .describe('Chỉ số MỚI đọc trên mặt công tơ (không phải lượng tiêu thụ)'),
  notes: z
    .string()
    .max(5000)
    .nullable()
    .optional()
    .describe('Ghi chú kèm bản ghi; bỏ trống = không ghi chú'),
});

/**
 * Input của `tao_phieu_giu_cho` — action L4 `reservation_deposit.create`.
 *
 * Chỉ hai trường. Hạn giữ chỗ (24 giờ) và trạng thái (`PENDING_APPROVAL`) do
 * server quyết, không phải tham số: một mô hình chọn được hạn giữ chỗ là một
 * mô hình chọn được thời điểm phòng mở lại cho người khác.
 */
export const SCHEMA_PHIEU_GIU_CHO = z.object({
  room_id: z.string().uuid().describe('ID phòng cần giữ chỗ'),
  amount: z
    .number()
    .positive()
    .describe('Số tiền cọc giữ chỗ (VND), trong khoảng 10.000 — 500.000.000'),
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
  'income_expense.annotate': {
    actionId: 'income_expense.annotate',
    version: 1,
    labelVi: 'Sửa ghi chú phiếu thu/chi',
    risk: 'L3',
    executorKind: 'nonce_abi_v1',
    consentRequired: 'click',
    permission: { module: 'income_expenses', action: 'edit' },
    inputSchema: SCHEMA_GHI_CHU_PHIEU_THU_CHI,
    previewFields: ['ma_phieu', 'ten_phieu', 'ghi_chu_cu', 'ghi_chu_moi'],
    previewRpc: 'copilot_preview_income_expense_annotate_v1',
    executeRpc: 'copilot_execute_income_expense_annotate_v1',
  },
  'reservation.set_hold_terms': {
    actionId: 'reservation.set_hold_terms',
    version: 1,
    labelVi: 'Đặt kỳ hạn giữ chỗ cho phiếu cọc',
    risk: 'L3',
    executorKind: 'nonce_abi_v1',
    consentRequired: 'click',
    permission: { module: 'deposits', action: 'edit' },
    inputSchema: SCHEMA_HAN_GIU_CHO,
    previewFields: [
      'ma_phieu',
      'ten_phieu',
      'han_lam_hop_dong_cu',
      'han_lam_hop_dong_moi',
      'han_bo_sung_coc_cu',
      'han_bo_sung_coc_moi',
      'coc_can_du_cu',
      'coc_can_du_moi',
    ],
    previewRpc: 'copilot_preview_reservation_hold_terms_v1',
    executeRpc: 'copilot_execute_reservation_hold_terms_v1',
  },
  'zalo.set_conversation_flags': {
    actionId: 'zalo.set_conversation_flags',
    version: 1,
    labelVi: 'Đặt cờ hội thoại Zalo (ghim / tắt tiếng / chưa đọc)',
    risk: 'L3',
    executorKind: 'nonce_abi_v1',
    consentRequired: 'click',
    // `chat_zalo.view`, KHÔNG phải một khoá "edit" nghe hợp lý hơn.
    // `zalo_set_conversation_flags` tự gác bằng `zalo_can('view', org)`, và
    // module `chat_zalo` không có khoá `edit` nào trong `permission_definitions`
    // (đo trên production 03/09/2026: chỉ có view/send/manage_automation/
    // manage_templates). Khai một khoá không tồn tại sẽ làm cổng hỏi
    // `authorized_scope_v3` về một quyền không ai có — action chết vĩnh viễn
    // kèm thông điệp `not_permitted` sai sự thật.
    permission: { module: 'chat_zalo', action: 'view' },
    inputSchema: SCHEMA_CO_HOI_THOAI_ZALO,
    previewFields: [
      'ten_hoi_thoai',
      'ghim_cu',
      'ghim_moi',
      'tat_tieng_cu',
      'tat_tieng_moi',
      'chua_doc_cu',
      'chua_doc_moi',
    ],
    previewRpc: 'copilot_preview_zalo_conversation_flags_v1',
    executeRpc: 'copilot_execute_zalo_conversation_flags_v1',
  },
  'meter_reading.create': {
    actionId: 'meter_reading.create',
    version: 1,
    labelVi: 'Ghi chỉ số công tơ',
    risk: 'L4',
    executorKind: 'nonce_abi_v1',
    consentRequired: 'click',
    permission: { module: 'meter_readings', action: 'create' },
    inputSchema: SCHEMA_GHI_CHI_SO_CONG_TO,
    previewFields: [
      'toa_nha',
      'phong',
      'cong_to',
      'chi_so_truoc',
      'chi_so_moi',
      'tieu_thu',
      'ngay_ghi',
      'ghi_chu',
      // Trường này KHÔNG thừa dù nghe như một hằng số. Ba đường ghi kia ra bản
      // CHỜ DUYỆT; đường này ghi thẳng ở trạng thái đã duyệt. Người bấm mang
      // theo giả định của những lần trước, nên thẻ phải nói ra sự khác biệt.
      'trang_thai',
      'canh_bao',
    ],
    previewRpc: 'copilot_preview_meter_reading_v1',
    executeRpc: 'copilot_execute_meter_reading_v1',
  },
  'reservation_deposit.create': {
    actionId: 'reservation_deposit.create',
    version: 1,
    labelVi: 'Tạo phiếu giữ chỗ chờ duyệt',
    risk: 'L4',
    executorKind: 'nonce_abi_v1',
    consentRequired: 'click',
    permission: { module: 'deposits', action: 'create' },
    inputSchema: SCHEMA_PHIEU_GIU_CHO,
    previewFields: ['toa_nha', 'phong', 'so_tien', 'han_giu_cho', 'trang_thai', 'canh_bao'],
    previewRpc: 'copilot_preview_reservation_deposit_v1',
    executeRpc: 'copilot_execute_reservation_deposit_v1',
  },
} as const satisfies Record<string, ActionCatalogEntry>;

export type ActionId = keyof typeof ACTION_CATALOG;

/**
 * Nhãn tiếng Việt của từng trường trong khối `preview` mà RPC xem trước trả về.
 *
 * MỘT bản, dùng chung giữa chuỗi tool gửi cho mô hình và thẻ xác nhận trên giao
 * diện. Hai bản là hai cách gọi tên cùng một con số, và người dùng đọc bản nào
 * cũng phải ra cùng một thứ với thứ họ sắp bấm.
 *
 * Trường thiếu nhãn sẽ hiện bằng chính tên khoá — xấu nhưng đúng, và
 * `writeTools.test.ts` bắt cứng việc thiếu để nó không sống lâu.
 */
export const NHAN_TRUONG_XEM_TRUOC: Readonly<Record<string, string>> = {
  loai: 'Loại phiếu',
  so_tien: 'Số tiền',
  ten_phieu: 'Tên phiếu',
  toa_nha: 'Toà',
  hang_muc: 'Hạng mục',
  ngay: 'Ngày',
  trang_thai: 'Trạng thái sau khi tạo',
  ma_phieu: 'Mã phiếu',
  ghi_chu_cu: 'Ghi chú hiện tại',
  ghi_chu_moi: 'Ghi chú mới',
  han_lam_hop_dong_cu: 'Hạn làm hợp đồng (hiện tại)',
  han_lam_hop_dong_moi: 'Hạn làm hợp đồng (mới)',
  han_bo_sung_coc_cu: 'Hạn bổ sung cọc (hiện tại)',
  han_bo_sung_coc_moi: 'Hạn bổ sung cọc (mới)',
  coc_can_du_cu: 'Cọc cần đủ (hiện tại)',
  coc_can_du_moi: 'Cọc cần đủ (mới)',
  ten_hoi_thoai: 'Hội thoại',
  ghim_cu: 'Ghim (hiện tại)',
  ghim_moi: 'Ghim (mới)',
  tat_tieng_cu: 'Tắt tiếng (hiện tại)',
  tat_tieng_moi: 'Tắt tiếng (mới)',
  chua_doc_cu: 'Đánh dấu chưa đọc (hiện tại)',
  chua_doc_moi: 'Đánh dấu chưa đọc (mới)',
  phong: 'Phòng',
  cong_to: 'Công tơ',
  chi_so_truoc: 'Chỉ số kỳ trước',
  chi_so_moi: 'Chỉ số mới',
  tieu_thu: 'Tiêu thụ (mới − trước)',
  ngay_ghi: 'Ngày chốt',
  ghi_chu: 'Ghi chú',
  han_giu_cho: 'Hạn giữ chỗ',
  // Cảnh báo là một trường XEM TRƯỚC như mọi trường khác, không phải một dòng
  // phụ chú: người bấm phải thấy nó ngay trong bảng, cùng chỗ với con số.
  canh_bao: 'Cảnh báo',
};

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
 *
 * Tham số là `ActionId`, không phải `string` (G2-B review). Kiểu rộng cho phép
 * gõ nhầm một id không tồn tại — `khoaRolloutHanhDong('income_expense.anotate')`
 * biên dịch sạch, trả `action:income_expense.anotate`, và tool mang khoá đó thì
 * KHÔNG BAO GIỜ bật được: `copilotAvailability` không thấy khoá nên trả
 * `disabled`, còn `set_copilot_feature_flag_v2` từ chối một contract không có
 * hàng. Triệu chứng là "bật cờ rồi mà tool vẫn mất", và không có gì trong hệ
 * chỉ vào chỗ gõ sai.
 */
export function khoaRolloutHanhDong(actionId: ActionId): string {
  return `action:${actionId}`;
}
