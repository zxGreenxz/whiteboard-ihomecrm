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
 * Input của `nop_ho_so` — action L5 `income_expense.nop_ho_so`.
 *
 * HAI HÌNH DẠNG, KHÔNG PHẢI MỘT SCHEMA CÓ HAI TRƯỜNG TUỲ CHỌN. Đúng một trong
 * hai phải có mặt, và một payload mang cả hai là mơ hồ: server sẽ ưu tiên
 * `$ref_step` và lặng lẽ bỏ qua `voucher_id`, tức người dùng nộp một phiếu khác
 * với phiếu họ nghĩ. `z.union` từ chối luôn ở client.
 *
 *   `{ $ref_step: n }`   — nộp thực thể mà BƯỚC n của cùng kế hoạch vừa tạo ra.
 *                          Id chưa tồn tại lúc lập kế hoạch, nên nó chỉ có thể
 *                          là một tham chiếu; server giải nó từ
 *                          `outcome.entity_id` của bước n sau khi bước đó DONE.
 *   `{ voucher_id }`     — nộp một phiếu nháp CÓ SẴN của chính người thao tác.
 *
 * KHÔNG có trường nào chọn người duyệt, mức duyệt, hay "tự duyệt luôn". Bộ luật
 * duyệt của tổ chức quyết định tất cả, và nếu nó tự hạch toán (`AUTO_POST`) thì
 * `copilot_plan_submit_voucher_v1` ném `copilot_auto_post_forbidden` và cuộn
 * ngược — đường này chỉ NỘP.
 */
/**
 * Input của tám hành động L5 `direct_l5_v1` (G5-C, đợt 1) — bọc RPC L5 có sẵn
 * (duyệt/vào sổ/xoá mềm). MỖI schema chỉ mang đúng khoá thực thể cần để tra
 * hàng — không trường nào chọn kết quả (trạng thái sau khi ghi do RPC gốc
 * quyết, không phải tham số).
 *
 * `organization_id` KHÔNG có mặt: nó luôn được bind bởi `chotToChuc`, giống
 * mọi schema khác trong file này.
 */
export const SCHEMA_IE_DUYET = z.object({
  income_expense_id: z.string().uuid().describe('ID phiếu thu/chi cần duyệt'),
});

export const SCHEMA_IE_VAO_SO = z.object({
  income_expense_id: z.string().uuid().describe('ID phiếu thu/chi'),
  cashbook_id: z.string().uuid().describe('ID sổ quỹ sẽ vào sổ'),
  posted_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Ngày vào sổ (YYYY-MM-DD)'),
});

export const SCHEMA_INVOICE_DUYET = z.object({
  invoice_id: z.string().uuid().describe('ID hoá đơn cần duyệt'),
});

export const SCHEMA_INVOICE_XOA_MEM = z.object({
  invoice_id: z.string().uuid().describe('ID hoá đơn cần xoá mềm'),
});

export const SCHEMA_METER_READING_DUYET = z.object({
  meter_reading_id: z.string().uuid().describe('ID chỉ số công tơ cần duyệt'),
});

export const SCHEMA_CONTRACT_DUYET_THANH_LY = z.object({
  termination_id: z.string().uuid().describe('ID yêu cầu thanh lý hợp đồng cần duyệt'),
  note: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe('Ghi chú kèm quyết định duyệt; bỏ trống = không ghi chú'),
});

export const SCHEMA_CUSTOMER_XOA_MEM = z.object({
  customer_id: z.string().uuid().describe('ID khách hàng cần xoá mềm'),
});

export const SCHEMA_NOP_HO_SO = z.union([
  z.object({
    $ref_step: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe('Số thứ tự bước TRƯỚC trong cùng kế hoạch đã tạo ra phiếu cần nộp'),
  }),
  z.object({
    voucher_id: z
      .string()
      .uuid()
      .describe('ID phiếu thu/chi nháp có sẵn (của chính bạn, chưa duyệt, chưa hạch toán)'),
  }),
]);

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
  // HÀNH ĐỘNG DUY NHẤT KHÔNG ĐI ĐƯỜNG `nonce_abi_v1`, và cũng là hành động L5
  // duy nhất của Mức 2.
  //
  //   Nó KHÔNG có tool. `taoToolGhiTuCatalog` chỉ dựng tool cho các dòng trong
  //   `TOOL_GHI`, và `writeToolsHanhDong.test.ts` bắt cứng rằng mọi tool sinh từ
  //   factory phải là L3/L4 + `nonce_abi_v1` + `click`. Đường vào của hành động
  //   này là một BƯỚC trong kế hoạch thực thi (`copilot_plan_create_v1`), tức
  //   nó luôn đi kèm một lần bấm duyệt cấp kế hoạch của người thật.
  //
  //   `previewRpc`/`executeRpc` cùng trỏ `copilot_plan_submit_voucher_v1` vì
  //   `maker_submit_v1` không có cặp preview/execute: máy kế hoạch rẽ theo
  //   `executorKind` rồi gọi thẳng helper. Hai trường này là MÔ TẢ (và phải
  //   khớp từng ký tự với hàng seed — `actionCatalog.test.ts` so cả hai), không
  //   phải thứ client dùng để gọi RPC.
  'income_expense.nop_ho_so': {
    actionId: 'income_expense.nop_ho_so',
    version: 1,
    labelVi: 'Nộp phiếu thu/chi vào hộp chờ duyệt',
    risk: 'L5',
    executorKind: 'maker_submit_v1',
    // `click`, không phải `step_up`: thứ người dùng đồng ý là NỘP hồ sơ cho một
    // con người khác duyệt, không phải chi tiền. Người duyệt vẫn phải là người
    // khác — `decide_financial_voucher` chặn chính người nộp (maker-checker).
    consentRequired: 'click',
    // Quyền TẠO, không phải quyền duyệt: helper chỉ nộp được phiếu do chính
    // người thao tác tạo ra. Đòi `income_expenses.approve` ở đây là bước đầu
    // tiên trên con đường mà cả kiến trúc L5 dựng ra để chặn.
    permission: { module: 'income_expenses', action: 'create' },
    inputSchema: SCHEMA_NOP_HO_SO,
    previewFields: ['loai', 'nguon', 'phieu', 'so_tien', 'trang_thai'],
    previewRpc: 'copilot_plan_submit_voucher_v1',
    executeRpc: 'copilot_plan_submit_voucher_v1',
  },
  // ───────────────────────────────────────────────────────────────────────
  // G5-C (đợt 1) — TÁM hành động L5 `direct_l5_v1`: bọc RPC L5 CÓ SẴN
  // (duyệt/vào sổ/xoá mềm phiếu thu-chi, hoá đơn, chỉ số công tơ, thanh lý
  // hợp đồng, khách hàng). KHÔNG có tool đơn lẻ nào cho các dòng này — chúng
  // KHÔNG nằm trong `TOOL_GHI` (`writeTools.ts`), nên factory
  // `taoToolGhiTuCatalog` không bao giờ dựng tool cho chúng. Đường vào DUY
  // NHẤT là một bước trong kế hoạch (`lap_ke_hoach`), đúng như
  // `income_expense.nop_ho_so` ở trên — PIN step-up là điều kiện để kế hoạch
  // được `copilot_plan_approve_v1` duyệt trước khi bất kỳ bước L5 nào chạy.
  //
  // `previewRpc`/`executeRpc` ở đây là hai RPC THẬT, KHÁC `nop_ho_so`: máy kế
  // hoạch (`copilot_plan_execute_step_v1`, nhánh `direct_l5_v1`) gọi
  // `preview_rpc` để lấy nonce MỚI rồi gọi `execute_rpc` với nonce đó — cùng
  // khuôn với `nonce_abi_v1`, chỉ khác một dòng `set_config` đánh dấu ngữ
  // cảnh kế hoạch trước khi gọi `execute_rpc` (execute RPC tự chối
  // `l5_requires_plan` nếu bị gọi ngoài khuôn này).
  'income_expense.duyet': {
    actionId: 'income_expense.duyet',
    version: 1,
    labelVi: 'Duyệt phiếu thu/chi',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'income_expenses', action: 'approve' },
    inputSchema: SCHEMA_IE_DUYET,
    previewFields: ['toa_nha', 'loai_phieu', 'ten_phieu', 'so_tien', 'trang_thai_hien_tai', 'hau_qua', 'canh_bao'],
    previewRpc: 'copilot_preview_ie_duyet_v1',
    executeRpc: 'copilot_execute_ie_duyet_v1',
  },
  'income_expense.duyet_vao_so': {
    actionId: 'income_expense.duyet_vao_so',
    version: 1,
    labelVi: 'Duyệt và vào sổ phiếu thu/chi',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'income_expenses', action: 'approve' },
    inputSchema: SCHEMA_IE_VAO_SO,
    previewFields: ['toa_nha', 'loai_phieu', 'ten_phieu', 'so_tien', 'so_quy', 'ngay_vao_so', 'hau_qua'],
    previewRpc: 'copilot_preview_ie_duyet_vao_so_v1',
    executeRpc: 'copilot_execute_ie_duyet_vao_so_v1',
  },
  'income_expense.vao_so': {
    actionId: 'income_expense.vao_so',
    version: 1,
    labelVi: 'Vào sổ phiếu thu/chi đã duyệt',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'income_expenses', action: 'approve' },
    inputSchema: SCHEMA_IE_VAO_SO,
    previewFields: ['toa_nha', 'loai_phieu', 'ten_phieu', 'so_tien', 'so_quy', 'ngay_vao_so', 'hau_qua'],
    previewRpc: 'copilot_preview_ie_vao_so_v1',
    executeRpc: 'copilot_execute_ie_vao_so_v1',
  },
  'invoice.duyet': {
    actionId: 'invoice.duyet',
    version: 1,
    labelVi: 'Duyệt hoá đơn',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    // RPC gốc (`approve_invoice_v1`) gác bằng `can_edit_invoice_building_v1`,
    // tức khoá THẬT là `invoices.edit` — KHÔNG phải `invoices.approve` (khoá
    // đó tồn tại trong `permission_definitions` nhưng RPC không đọc nó).
    permission: { module: 'invoices', action: 'edit' },
    inputSchema: SCHEMA_INVOICE_DUYET,
    previewFields: ['toa_nha', 'so_hoa_don', 'ky_hoa_don', 'so_tien', 'trang_thai_hien_tai', 'hau_qua', 'canh_bao'],
    previewRpc: 'copilot_preview_invoice_duyet_v1',
    executeRpc: 'copilot_execute_invoice_duyet_v1',
  },
  'invoice.xoa_mem': {
    actionId: 'invoice.xoa_mem',
    version: 1,
    labelVi: 'Xoá mềm hoá đơn',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'invoices', action: 'edit' },
    inputSchema: SCHEMA_INVOICE_XOA_MEM,
    previewFields: ['toa_nha', 'so_hoa_don', 'ky_hoa_don', 'so_tien', 'trang_thai_hien_tai', 'hau_qua'],
    previewRpc: 'copilot_preview_invoice_xoa_mem_v1',
    executeRpc: 'copilot_execute_invoice_xoa_mem_v1',
  },
  'meter_reading.duyet': {
    actionId: 'meter_reading.duyet',
    version: 1,
    labelVi: 'Duyệt chỉ số công tơ',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'meter_readings', action: 'edit' },
    inputSchema: SCHEMA_METER_READING_DUYET,
    previewFields: [
      'toa_nha',
      'ma_chi_so',
      'ky_ghi_so',
      'chi_so_truoc',
      'chi_so_moi',
      'trang_thai_hien_tai',
      'hau_qua',
      'canh_bao',
    ],
    previewRpc: 'copilot_preview_meter_reading_duyet_v1',
    executeRpc: 'copilot_execute_meter_reading_duyet_v1',
  },
  'contract.duyet_thanh_ly': {
    actionId: 'contract.duyet_thanh_ly',
    version: 1,
    labelVi: 'Duyệt thanh lý hợp đồng',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'contracts', action: 'edit' },
    inputSchema: SCHEMA_CONTRACT_DUYET_THANH_LY,
    previewFields: [
      'toa_nha',
      'phong',
      'so_hop_dong',
      'so_tien_hoan_thu',
      'trang_thai_hien_tai',
      'hau_qua',
      'canh_bao',
    ],
    previewRpc: 'copilot_preview_contract_duyet_thanh_ly_v1',
    executeRpc: 'copilot_execute_contract_duyet_thanh_ly_v1',
  },
  'customer.xoa_mem': {
    actionId: 'customer.xoa_mem',
    version: 1,
    labelVi: 'Xoá mềm khách hàng',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    // RPC gốc (`soft_delete_customer`) KHÔNG dùng `authorized_scope_v3` —
    // quyền thật là `(user_id = actor OR is_super_admin())` ngay trên hàng.
    // `customers.delete` ở đây là bộ lọc SỚM tại cổng hành động, CHẶT HƠN RPC
    // gốc (an toàn, không nới rộng) — xem chú thích trong migration.
    permission: { module: 'customers', action: 'delete' },
    inputSchema: SCHEMA_CUSTOMER_XOA_MEM,
    previewFields: ['ten_khach_hang', 'so_dien_thoai', 'trang_thai_hien_tai', 'hau_qua'],
    previewRpc: 'copilot_preview_customer_xoa_mem_v1',
    executeRpc: 'copilot_execute_customer_xoa_mem_v1',
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
  // Hai trường của bước nộp hồ sơ. `nguon` chỉ có mặt khi bước nộp một thực thể
  // do BƯỚC TRƯỚC trong cùng kế hoạch tạo ra — người bấm phải thấy nó nộp cái gì.
  nguon: 'Nguồn',
  phieu: 'Phiếu',
  // Cảnh báo là một trường XEM TRƯỚC như mọi trường khác, không phải một dòng
  // phụ chú: người bấm phải thấy nó ngay trong bảng, cùng chỗ với con số.
  canh_bao: 'Cảnh báo',
  // G5-C (đợt 1) — tám hành động L5 `direct_l5_v1`.
  hau_qua: 'Hậu quả',
  trang_thai_hien_tai: 'Trạng thái hiện tại',
  loai_phieu: 'Loại phiếu',
  so_quy: 'Sổ quỹ',
  ngay_vao_so: 'Ngày vào sổ',
  so_hoa_don: 'Số hoá đơn',
  ky_hoa_don: 'Kỳ hoá đơn',
  ma_chi_so: 'Mã chỉ số',
  ky_ghi_so: 'Kỳ ghi sổ',
  so_hop_dong: 'Số hợp đồng',
  so_tien_hoan_thu: 'Số tiền hoàn/thu thêm khi thanh lý',
  ten_khach_hang: 'Tên khách hàng',
  so_dien_thoai: 'Số điện thoại',
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
