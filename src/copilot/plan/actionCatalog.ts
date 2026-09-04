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
  /**
   * G5-C2 (nhóm A — phân quyền). `true` khi registry mang `pin_always=true`:
   * hành động này KHÔNG BAO GIỜ được uỷ quyền đứng phủ, kể cả nếu cột
   * `grantable` sau này đổi nghĩa — một hàng rào THỨ HAI, độc lập với
   * `grantable`. Vắng mặt (undefined) tương đương `false`.
   */
  pinAlways?: boolean;
  /**
   * G5-C2 (nhóm B — hiệu ứng ngoài). `true` khi registry mang
   * `verify_kind='external_effect'`: bước sẽ dừng ở `UNKNOWN_EFFECT` (không
   * `DONE`) ngay sau khi thực thi, chờ `copilot_plan_reconcile_step_v1` đối
   * soát trạng thái THẬT (Zalo/Network Center) trước khi kế hoạch được coi
   * là xong. Vắng mặt (undefined) tương đương `false`.
   */
  externalEffect?: boolean;
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

/**
 * G5-C2 (nhóm A — phân quyền) — bốn action `direct_l5_v1` KHÔNG BAO GIỜ được
 * uỷ quyền đứng phủ (`grantable=false` + `pin_always=true` ở registry, xem
 * migration `20260903212600`). PIN step-up bắt buộc mỗi lần, không có
 * đường tắt nào.
 */
export const SCHEMA_MEMBER_CAP_QUYEN = z.object({
  membership_id: z.string().uuid().describe('ID hồ sơ thành viên cần sửa phân quyền'),
  expected_version: z
    .number()
    .int()
    .describe('Phiên bản hồ sơ đang đọc — chống ghi đè thay đổi của người khác'),
  role_bindings: z
    .array(
      z.object({
        role_id: z.string().uuid(),
        scope_ids: z.array(z.string().uuid()).optional(),
      }),
    )
    .nullable()
    .optional()
    .describe('Danh sách vai trò MỚI sẽ thay thế toàn bộ vai trò hiện có; bỏ trống = không đổi vai trò'),
  overrides: z
    .array(
      z.object({
        permission_key: z.string(),
        effect: z.enum(['ALLOW', 'DENY']).optional(),
        reason: z.string().min(1),
        scope_mode: z.enum(['ORGANIZATION', 'SCOPED']).optional(),
        scope_ids: z.array(z.string().uuid()).optional(),
        expires_at: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional()
    .describe('Danh sách ngoại lệ quyền MỚI sẽ thay thế toàn bộ ngoại lệ hiện có; bỏ trống = không đổi'),
  reason: z.string().min(1).describe('Lý do thay đổi phân quyền — bắt buộc'),
});

export const SCHEMA_ROLE_CAP_NHAT = z.object({
  role_id: z.string().uuid().nullable().optional().describe('ID vai trò cần sửa; bỏ trống = TẠO vai trò mới'),
  name: z.string().min(1).optional().describe('Tên vai trò (bắt buộc khi tạo mới)'),
  permissions: z
    .array(
      z.object({
        permission_key: z.string(),
        effect: z.enum(['ALLOW', 'DENY']).optional(),
      }),
    )
    .nullable()
    .optional()
    .describe('Danh sách quyền MỚI của vai trò — thay thế toàn bộ danh sách cũ'),
  expected_version: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('Phiên bản đang đọc — bắt buộc khi SỬA, bỏ trống khi TẠO mới'),
  reason: z.string().nullable().optional().describe('Lý do thay đổi (tuỳ chọn)'),
});

export const SCHEMA_MEMBER_MOI = z.object({
  email: z.string().email().describe('Email người được mời'),
  member_type: z
    .enum(['OWNER', 'STAFF', 'SHAREHOLDER', 'PARTNER', 'SERVICE'])
    .describe('Loại thành viên'),
  role_id: z.string().uuid().nullable().optional().describe('Vai trò gán sẵn cho lời mời (tuỳ chọn)'),
  scope_ids: z.array(z.string().uuid()).optional().describe('Phạm vi gán kèm vai trò (tuỳ chọn)'),
  expires_days: z.number().int().min(1).max(30).optional().describe('Số ngày lời mời còn hiệu lực (1-30, mặc định 7)'),
});

export const SCHEMA_MEMBER_TRANG_THAI = z.object({
  user_id: z.string().uuid().describe('ID người dùng cần đổi trạng thái thành viên'),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']).describe('Trạng thái mới'),
  reason: z.string().nullable().optional().describe('Lý do đổi trạng thái (tuỳ chọn)'),
});

/**
 * G5-C2 (nhóm B — hiệu ứng ngoài) — ba action `direct_l5_v1` mang
 * `verify_kind='external_effect'`: bước dừng ở `UNKNOWN_EFFECT` cho tới khi
 * `copilot_plan_reconcile_step_v1` đối soát trạng thái thật (xem migration
 * `20260903212610`).
 */
export const SCHEMA_ZALO_PHAT_SONG = z.object({
  conversation_id: z.string().uuid().describe('ID hội thoại Zalo nhận tin'),
  body: z.string().min(1).describe('Nội dung tin nhắn'),
});

export const SCHEMA_ZALO_THU_HOI_TIN = z.object({
  message_id: z.string().uuid().describe('ID tin nhắn (do chính bạn gửi) cần thu hồi'),
});

export const SCHEMA_NETWORK_THUC_THI = z.object({
  device_id: z.string().uuid().describe('ID thiết bị MikroTik'),
  action_type: z
    .enum(['FLUSH_DNS_CACHE', 'RENEW_DHCP_LEASE', 'CYCLE_ACCESS_PORT', 'REBOOT_ROUTER'])
    .describe('Loại lệnh'),
  reason: z.string().min(8).max(1000).describe('Lý do thực thi lệnh (8-1000 ký tự)'),
  parameters: z
    .object({
      interfaceId: z.string().uuid().optional(),
      durationSeconds: z.number().int().min(5).max(30).optional(),
    })
    .optional()
    .describe('Tham số riêng của CYCLE_ACCESS_PORT; các lệnh khác để trống'),
  confirmation: z
    .string()
    .optional()
    .describe('Tên định danh router hiện tại — bắt buộc khi action_type là CYCLE_ACCESS_PORT/REBOOT_ROUTER'),
});

/**
 * G5-C3 (nhóm C — tài chính còn lại) — chín action `direct_l5_v1` bọc RPC L5
 * có sẵn (duyệt hàng loạt, gia hạn/nhượng/chuyển phòng hợp đồng, hoàn cọc
 * thanh lý, chốt sổ quỹ, chi lương, khoá bảng lương, xoá hàng loạt chỉ số).
 * Hai action bulk (`invoice_ids`/`ids`) giới hạn TỐI ĐA 50 phần tử — khớp cap
 * `bulk_too_large` (22023) mà migration wrapper đã ghim.
 */
export const SCHEMA_INVOICE_DUYET_HANG_LOAT = z.object({
  invoice_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(50)
    .describe('Danh sách ID hoá đơn (DRAFT) cần duyệt cùng lúc, tối đa 50'),
});

export const SCHEMA_CONTRACT_GIA_HAN = z.object({
  contract_id: z.string().uuid().describe('ID hợp đồng cần gia hạn'),
  new_end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Ngày kết thúc mới (YYYY-MM-DD), phải sau ngày kết thúc hiện tại'),
  new_rent_price: z.number().positive().nullable().optional().describe('Giá thuê mới (0 < giá ≤ 10× giá hiện tại); bỏ trống = giữ nguyên'),
  new_deposit: z.number().nonnegative().nullable().optional().describe('Tiền cọc mới (0 ≤ cọc ≤ 10× cọc hiện tại); bỏ trống = giữ nguyên'),
  notes: z.string().max(2000).nullable().optional().describe('Ghi chú kèm gia hạn; bỏ trống = không ghi chú'),
});

export const SCHEMA_CONTRACT_CHUYEN_NHUONG = z.object({
  contract_id: z.string().uuid().describe('ID hợp đồng cần nhượng'),
  new_customer_id: z.string().uuid().describe('ID khách hàng mới nhận nhượng (cùng tổ chức)'),
  new_rent_price: z.number().positive().nullable().optional().describe('Giá thuê mới; bỏ trống = giữ nguyên'),
  new_deposit: z.number().nonnegative().nullable().optional().describe('Tiền cọc mới; bỏ trống = giữ nguyên'),
  transfer_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .describe('Ngày nhượng; bỏ trống = hôm nay'),
  notes: z.string().max(2000).nullable().optional().describe('Ghi chú kèm nhượng; bỏ trống = không ghi chú'),
});

export const SCHEMA_ROOM_CHUYEN_PHONG = z.object({
  contract_id: z.string().uuid().describe('ID hợp đồng cần chuyển phòng'),
  new_room_id: z.string().uuid().describe('ID phòng mới (cùng toà với phòng hiện tại)'),
  new_rent_price: z.number().positive().nullable().optional().describe('Giá thuê mới; bỏ trống = giữ nguyên'),
  transfer_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .describe('Ngày chuyển phòng; bỏ trống = hôm nay'),
  notes: z.string().max(2000).nullable().optional().describe('Ghi chú kèm chuyển phòng; bỏ trống = không ghi chú'),
});

export const SCHEMA_METER_READING_XOA_HANG_LOAT = z.object({
  ids: z
    .array(z.string().uuid())
    .min(1)
    .max(50)
    .describe('Danh sách ID chỉ số công tơ cần xoá mềm cùng lúc, tối đa 50'),
});

export const SCHEMA_TERMINATION_HOAN_COC = z.object({
  obligation_id: z.string().uuid().describe('ID nghĩa vụ hoàn cọc thanh lý'),
  account_id: z.string().uuid().nullable().optional().describe('Sổ quỹ THẬT (không ảo) sẽ chi hoàn; bỏ trống = chưa gán sổ quỹ'),
  force: z
    .boolean()
    .optional()
    .describe('Ép sinh phiếu dù nghĩa vụ đang cảnh báo — CHỈ chủ tổ chức/super admin mới ép được (RPC gốc tự kiểm)'),
  force_reason: z
    .string()
    .min(8)
    .max(1000)
    .nullable()
    .optional()
    .describe('Lý do ép — bắt buộc khi force=true và nghĩa vụ đang cảnh báo'),
});

export const SCHEMA_CASHBOOK_CHOT_SO = z.object({
  request_id: z.string().uuid().describe('ID đề nghị chốt sổ & bàn giao quỹ (đang PENDING)'),
  counted_balance: z.number().describe('Số tiền ĐÃ ĐẾM — phải khớp CHÍNH XÁC số người đề nghị đã khai'),
});

export const SCHEMA_SALARY_CHI_LUONG = z.object({
  staff_id: z.string().uuid().describe('ID nhân viên/quản lý nhận lương'),
  period_month: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Kỳ lương (ngày đầu tháng, YYYY-MM-DD)'),
  take_home: z.number().positive().describe('Số tiền thực nhận (VND)'),
  account_id: z.string().uuid().describe('Sổ quỹ sẽ chi lương'),
  voucher_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .describe('Ngày lập phiếu; bỏ trống = hôm nay'),
  note: z.string().max(2000).nullable().optional().describe('Ghi chú kèm phiếu chi lương'),
  // Fix round 1 (review, F1 HIGH): rent-offset (rent_invoice_id/rent_amount) đã
  // BỊ GỠ khỏi action này — nhánh đó trong RPC gốc tự tạo một phiếu THU đã
  // APPROVED (tác dụng phụ tiền THẬT mà preview cũ không hề nói tới). Wrapper
  // v1 luôn truyền NULL cho cả hai. Muốn cấn trừ tiền phòng thì làm trên giao
  // diện thường.
});

/** Một dòng bảng kê công việc lồng trong `managers[]` của `salary.khoa_thang`. */
const SCHEMA_SALARY_LEDGER_ITEM = z.object({
  item_type: z.string().describe('Loại dòng kê (bắt buộc)'),
  source_id: z.string().uuid().nullable().optional(),
  occurred_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  day_label: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  place: z.string().nullable().optional(),
  job_type_name: z.string().nullable().optional(),
  is_repair: z.boolean().nullable().optional(),
  is_contract: z.boolean().nullable().optional(),
  base_amount: z.number().nullable().optional(),
  weekend_amount: z.number().nullable().optional(),
  after_amount: z.number().nullable().optional(),
  cash_amount: z.number().nullable().optional(),
  has_photo: z.boolean().nullable().optional(),
  bonus_amount: z.number().nullable().optional(),
  reason: z.string().nullable().optional(),
});

/** Một quản lý trong `managers[]` của `salary.khoa_thang` — mirror `lock_salary_month_v1`. */
const SCHEMA_SALARY_MANAGER = z.object({
  staff_id: z.string().uuid().describe('ID quản lý cần chốt khoá'),
  base_salary: z.number().nonnegative().optional(),
  work_bonus: z.number().nonnegative().optional(),
  contract_bonus: z.number().nonnegative().optional(),
  commission_total: z.number().nonnegative().optional(),
  investment_profit: z.number().nonnegative().optional(),
  adjustments_total: z.number().optional(),
  advances_total: z.number().nonnegative().optional(),
  room_rent: z.number().nonnegative().optional(),
  gross_total: z.number().nonnegative().optional(),
  take_home: z.number().nonnegative().optional(),
  paid: z.number().nonnegative().optional(),
  commission_voucher_ids: z
    .array(z.string().uuid())
    .optional()
    .describe('Danh sách phiếu hoa hồng UNAPPROVED sẽ được duyệt kèm khi chốt'),
  ledger: z.array(SCHEMA_SALARY_LEDGER_ITEM).optional().describe('Bảng kê công việc chốt kèm tháng này'),
});

export const SCHEMA_SALARY_KHOA_THANG = z.object({
  period_month: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Kỳ lương cần chốt khoá (ngày đầu tháng, YYYY-MM-DD)'),
  managers: z
    .array(SCHEMA_SALARY_MANAGER)
    .min(1)
    .max(50)
    .describe('Danh sách quản lý cần chốt khoá cùng lúc, tối đa 50 — mọi người phải cùng tổ chức với người đầu tiên'),
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
  // ───────────────────────────────────────────────────────────────────────
  // G5-C2 (đợt 2) — NHÓM A: bốn action `direct_l5_v1` phân quyền. Registry
  // `grantable=false` + `pin_always=true` (CHECK ở DB) — không bao giờ được
  // uỷ quyền đứng phủ, kể cả nếu `grantable` sau này đổi nghĩa.
  // ───────────────────────────────────────────────────────────────────────
  'member.update_authorization': {
    actionId: 'member.update_authorization',
    version: 1,
    labelVi: 'Sửa phân quyền thành viên',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'users', action: 'edit' },
    inputSchema: SCHEMA_MEMBER_CAP_QUYEN,
    previewFields: ['trang_thai_hien_tai', 'hau_qua', 'canh_bao'],
    previewRpc: 'copilot_preview_member_cap_quyen_v1',
    executeRpc: 'copilot_execute_member_cap_quyen_v1',
    pinAlways: true,
  },
  'role.upsert': {
    actionId: 'role.upsert',
    version: 1,
    labelVi: 'Tạo/sửa vai trò',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'users', action: 'edit' },
    inputSchema: SCHEMA_ROLE_CAP_NHAT,
    previewFields: ['ten_phieu', 'trang_thai_hien_tai', 'hau_qua', 'canh_bao'],
    previewRpc: 'copilot_preview_role_cap_nhat_v1',
    executeRpc: 'copilot_execute_role_cap_nhat_v1',
    pinAlways: true,
  },
  'member.invite': {
    actionId: 'member.invite',
    version: 1,
    labelVi: 'Mời thành viên',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'users', action: 'create' },
    inputSchema: SCHEMA_MEMBER_MOI,
    previewFields: ['so_dien_thoai', 'loai_phieu', 'trang_thai_hien_tai', 'hau_qua', 'canh_bao'],
    previewRpc: 'copilot_preview_member_moi_v1',
    executeRpc: 'copilot_execute_member_moi_v1',
    pinAlways: true,
  },
  'member.set_status': {
    actionId: 'member.set_status',
    version: 1,
    labelVi: 'Đổi trạng thái thành viên',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'users', action: 'edit' },
    inputSchema: SCHEMA_MEMBER_TRANG_THAI,
    previewFields: ['so_dien_thoai', 'trang_thai_hien_tai', 'hau_qua', 'canh_bao'],
    previewRpc: 'copilot_preview_member_trang_thai_v1',
    executeRpc: 'copilot_execute_member_trang_thai_v1',
    pinAlways: true,
  },
  // ───────────────────────────────────────────────────────────────────────
  // G5-C2 (đợt 2) — NHÓM B: ba action `direct_l5_v1` mang hiệu ứng NGOÀI hệ
  // (Zalo/Network Center). Registry `verify_kind='external_effect'` — bước
  // dừng ở `UNKNOWN_EFFECT` ngay sau khi thực thi, `KeHoachCard` phải hiện
  // badge "hiệu ứng ngoài — đang đối soát" và `planClient` phải tự gọi
  // `copilot_plan_reconcile_step_v1` cho tới khi biết kết quả thật.
  // ───────────────────────────────────────────────────────────────────────
  'zalo.broadcast': {
    actionId: 'zalo.broadcast',
    version: 1,
    labelVi: 'Gửi tin Zalo',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'chat_zalo', action: 'send' },
    inputSchema: SCHEMA_ZALO_PHAT_SONG,
    previewFields: ['ten_khach_hang', 'trang_thai_hien_tai', 'hau_qua', 'canh_bao'],
    previewRpc: 'copilot_preview_zalo_phat_song_v1',
    executeRpc: 'copilot_execute_zalo_phat_song_v1',
    externalEffect: true,
  },
  'zalo.recall_message': {
    actionId: 'zalo.recall_message',
    version: 1,
    labelVi: 'Thu hồi tin Zalo',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'chat_zalo', action: 'send' },
    inputSchema: SCHEMA_ZALO_THU_HOI_TIN,
    previewFields: ['trang_thai_hien_tai', 'hau_qua', 'canh_bao'],
    previewRpc: 'copilot_preview_zalo_thu_hoi_tin_v1',
    executeRpc: 'copilot_execute_zalo_thu_hoi_tin_v1',
    externalEffect: true,
  },
  'network.execute_action': {
    actionId: 'network.execute_action',
    version: 1,
    labelVi: 'Thực thi lệnh Network Center',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'network_center', action: 'execute' },
    inputSchema: SCHEMA_NETWORK_THUC_THI,
    previewFields: ['toa_nha', 'trang_thai_hien_tai', 'hau_qua', 'canh_bao'],
    previewRpc: 'copilot_preview_network_thuc_thi_v1',
    executeRpc: 'copilot_execute_network_thuc_thi_v1',
    externalEffect: true,
  },
  // ───────────────────────────────────────────────────────────────────────
  // G5-C3 (nhóm C — tài chính còn lại) — CHÍN action `direct_l5_v1` bọc RPC L5
  // CÓ SẴN (duyệt hàng loạt hoá đơn, gia hạn/nhượng/chuyển phòng hợp đồng,
  // hoàn cọc thanh lý, chốt sổ quỹ, chi lương, khoá bảng lương, xoá hàng loạt
  // chỉ số công tơ). Cùng khuôn với G5-C đợt 1: đường vào DUY NHẤT là một bước
  // trong kế hoạch (`lap_ke_hoach`), KHÔNG tool đơn lẻ nào.
  // ───────────────────────────────────────────────────────────────────────
  'invoice.duyet_hang_loat': {
    actionId: 'invoice.duyet_hang_loat',
    version: 1,
    labelVi: 'Duyệt hàng loạt hoá đơn',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    // RPC gốc (`bulk_approve_invoices_v1`) gác bằng `can_edit_invoice_building_v1`
    // — CÙNG khoá thật như `invoice.duyet` (G5-C đợt 1): `invoices.edit`, KHÔNG
    // phải `invoices.approve`.
    permission: { module: 'invoices', action: 'edit' },
    inputSchema: SCHEMA_INVOICE_DUYET_HANG_LOAT,
    previewFields: ['toa_nha', 'so_tien', 'hau_qua'],
    previewRpc: 'copilot_preview_invoice_duyet_hang_loat_v1',
    executeRpc: 'copilot_execute_invoice_duyet_hang_loat_v1',
  },
  'contract.gia_han': {
    actionId: 'contract.gia_han',
    version: 1,
    labelVi: 'Gia hạn hợp đồng',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'contracts', action: 'edit' },
    inputSchema: SCHEMA_CONTRACT_GIA_HAN,
    previewFields: ['toa_nha', 'so_hop_dong', 'trang_thai_hien_tai', 'so_tien', 'gia_thue_hien_tai', 'gia_thue_moi', 'coc_hien_tai', 'coc_moi', 'hau_qua'],
    previewRpc: 'copilot_preview_contract_gia_han_v1',
    executeRpc: 'copilot_execute_contract_gia_han_v1',
  },
  'contract.chuyen_nhuong': {
    actionId: 'contract.chuyen_nhuong',
    version: 1,
    labelVi: 'Nhượng hợp đồng cho khách hàng khác',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'contracts', action: 'edit' },
    inputSchema: SCHEMA_CONTRACT_CHUYEN_NHUONG,
    previewFields: ['toa_nha', 'so_hop_dong', 'ten_khach_hang', 'so_dien_thoai', 'so_tien', 'gia_thue_hien_tai', 'gia_thue_moi', 'coc_hien_tai', 'coc_moi', 'hau_qua'],
    previewRpc: 'copilot_preview_contract_chuyen_nhuong_v1',
    executeRpc: 'copilot_execute_contract_chuyen_nhuong_v1',
  },
  'termination.hoan_coc': {
    actionId: 'termination.hoan_coc',
    version: 1,
    labelVi: 'Sinh phiếu hoàn cọc thanh lý',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'income_expenses', action: 'create' },
    inputSchema: SCHEMA_TERMINATION_HOAN_COC,
    previewFields: ['toa_nha', 'so_hop_dong', 'so_tien_hoan_thu', 'trang_thai_hien_tai', 'canh_bao', 'hau_qua'],
    previewRpc: 'copilot_preview_termination_hoan_coc_v1',
    executeRpc: 'copilot_execute_termination_hoan_coc_v1',
  },
  'cashbook.chot_so': {
    actionId: 'cashbook.chot_so',
    version: 1,
    labelVi: 'Xác nhận chốt sổ quỹ & bàn giao',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'cashbooks', action: 'close_confirm' },
    inputSchema: SCHEMA_CASHBOOK_CHOT_SO,
    previewFields: ['so_quy', 'so_tien', 'so_du_he_thong', 'chenh_lech', 'ngay_vao_so', 'hau_qua'],
    previewRpc: 'copilot_preview_cashbook_chot_so_v1',
    executeRpc: 'copilot_execute_cashbook_chot_so_v1',
  },
  'salary.chi_luong': {
    actionId: 'salary.chi_luong',
    version: 1,
    labelVi: 'Nộp hồ sơ chi lương chờ duyệt',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'salary', action: 'distribute' },
    inputSchema: SCHEMA_SALARY_CHI_LUONG,
    previewFields: ['ten_khach_hang', 'so_tien', 'ky_hoa_don', 'so_quy', 'hau_qua'],
    previewRpc: 'copilot_preview_salary_chi_luong_v1',
    executeRpc: 'copilot_execute_salary_chi_luong_v1',
  },
  'salary.khoa_thang': {
    actionId: 'salary.khoa_thang',
    version: 1,
    labelVi: 'Chốt khoá bảng lương tháng',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'salary', action: 'lock' },
    inputSchema: SCHEMA_SALARY_KHOA_THANG,
    previewFields: ['ky_hoa_don', 'so_nhan_vien', 'tong_thuc_nhan', 'phieu_hoa_hong', 'canh_bao', 'hau_qua'],
    previewRpc: 'copilot_preview_salary_khoa_thang_v1',
    executeRpc: 'copilot_execute_salary_khoa_thang_v1',
  },
  'room.chuyen_phong': {
    actionId: 'room.chuyen_phong',
    version: 1,
    labelVi: 'Chuyển phòng cho hợp đồng',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'contracts', action: 'edit' },
    inputSchema: SCHEMA_ROOM_CHUYEN_PHONG,
    previewFields: ['toa_nha', 'so_hop_dong', 'phong', 'so_tien', 'gia_thue_hien_tai', 'gia_thue_moi', 'hau_qua'],
    previewRpc: 'copilot_preview_room_chuyen_phong_v1',
    executeRpc: 'copilot_execute_room_chuyen_phong_v1',
  },
  'meter_reading.xoa_hang_loat': {
    actionId: 'meter_reading.xoa_hang_loat',
    version: 1,
    labelVi: 'Xoá hàng loạt chỉ số công tơ',
    risk: 'L5',
    executorKind: 'direct_l5_v1',
    consentRequired: 'step_up',
    permission: { module: 'meter_readings', action: 'delete' },
    inputSchema: SCHEMA_METER_READING_XOA_HANG_LOAT,
    previewFields: ['toa_nha', 'canh_bao', 'hau_qua'],
    previewRpc: 'copilot_preview_meter_reading_xoa_hang_loat_v1',
    executeRpc: 'copilot_execute_meter_reading_xoa_hang_loat_v1',
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
  // G5-C3 fix round 1 (review F3/F4/F2) — hiện CẢ HAI giá trị (hiện tại +
  // đề nghị) thay vì chỉ số cuối cùng, và tổng tiền server-side.
  gia_thue_hien_tai: 'Giá thuê hiện tại',
  gia_thue_moi: 'Giá thuê mới',
  coc_hien_tai: 'Cọc hiện tại',
  coc_moi: 'Cọc mới',
  so_du_he_thong: 'Số dư hệ thống',
  chenh_lech: 'Chênh lệch (đếm được − sổ sách)',
  tong_thuc_nhan: 'Tổng thực nhận',
  so_nhan_vien: 'Số nhân viên',
  phieu_hoa_hong: 'Phiếu hoa hồng',
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
