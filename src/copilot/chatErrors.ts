// Dịch lỗi kỹ thuật của một lượt chat sang câu người dùng làm được gì với nó.
//
// Trước đây panel chỉ nhận ra một nhóm (not_entitled/not_permitted/403); mọi mã
// khác hiện nguyên văn dưới dạng `Lỗi: organization_required`. Đó không phải
// thông báo — đó là đổ lỗi lên người đọc.
import { formatCopilotRolloutError } from './featureFlags';

/**
 * Chưa chọn tổ chức — dùng chung với cửa gửi trong `availabilityGate`.
 *
 * Xuất khẩu chứ không để chuỗi nằm trơ trong bảng bên dưới, vì cửa gửi cần đúng
 * câu này: hai bản sao của cùng một câu sẽ lệch nhau ở lần sửa chữ đầu tiên.
 */
export const THONG_BAO_CHUA_CHON_TO_CHUC = 'Hãy chọn tổ chức trước khi hỏi Copilot.';

const HET_QUYEN_HOAC_HAN_MUC =
  'Tài khoản chưa được cấp quyền dùng AI Copilot hoặc đã hết hạn mức hôm nay.';

/**
 * Mã CHỈ thuộc màn hình quản trị rollout.
 *
 * `formatCopilotRolloutError` cũng nhận `not_permitted`, nhưng câu nó trả về là
 * "Bạn không có quyền thay đổi rollout Copilot" — vô nghĩa với người đang chat,
 * vì ở đường chat `not_permitted` nghĩa là hết hạn mức / chưa được cấp quyền
 * dùng Copilot. Nên chỉ nhường cho nó ba mã dưới đây, không nhường cả hàm.
 */
const MA_ROLLOUT_QUAN_TRI = [
  'copilot_rollout_stale_revision',
  'rollout_evidence_required',
  'invalid_rollout_transition',
] as const;

/** Mã lỗi → câu tiếng Việt kèm hành động sửa được. Khớp theo chuỗi CON vì lỗi
 *  thật thường có đuôi mô tả (`rollout_unavailable: công cụ "..." đã bị tắt`). */
const THEO_MA: readonly [string, string][] = [
  ['organization_required', THONG_BAO_CHUA_CHON_TO_CHUC],
  // 403 của `reserve_ai_usage`: người dùng KHÔNG có membership ACTIVE trên tổ
  // chức đang chọn (và cũng không phải super admin ngoài org sandbox). Khác hẳn
  // `not_permitted` — ở đó tài khoản chưa được cấp quyền Copilot NÓI CHUNG; ở
  // đây quyền Copilot có thể đủ, chỉ sai công ty. Hai cách sửa khác nhau: một
  // bên xin cấp entitlement, một bên đổi ô chọn tổ chức.
  ['organization_forbidden', 'Bạn không có quyền dùng Copilot trong tổ chức đang chọn.'],
  ['organization_mismatch', 'Tổ chức đã đổi, mở lại cuộc trò chuyện.'],
  ['rollout_unavailable', 'Trang/công cụ này chưa được bật cho tổ chức.'],
  // Anh em server-side của `rollout_unavailable`. Từ 03/09/2026 ba RPC miền
  // nhạy cảm (bảng lương, lợi nhuận cổ đông, trung tâm mạng) tự đọc
  // `copilot_feature_flags` và RAISE mã này với ERRCODE 42501. Không có dòng
  // này thì nhánh `/not_permitted|403/` bên dưới sẽ nuốt nó và người dùng đọc
  // "chưa được cấp quyền hoặc hết hạn mức" — hai câu chuyện sai: quyền của họ
  // có thể đủ hoàn toàn, thứ đang tắt là công tắc rollout, và người sửa được
  // là quản trị chứ không phải họ.
  //
  // Phải đứng TRƯỚC mọi mục khớp chuỗi con khác không chứa nó — bảng này khớp
  // theo chuỗi CON và duyệt theo thứ tự.
  [
    'copilot_feature_disabled',
    'Tính năng này đang tắt cho công ty của bạn.',
  ],
  // Hai trần khác nhau, hai câu khác nhau — và `daily_token_quota` phải đứng
  // TRƯỚC `daily_quota` ở đây. Hôm nay hai chuỗi không lồng nhau ("daily_token_
  // quota" không chứa "daily_quota"), nhưng bảng này khớp theo chuỗi CON: một
  // lần đổi tên mã là đủ để câu sau nuốt câu trước mà không ai thấy.
  [
    'daily_token_quota',
    'Hôm nay bạn đã dùng hết hạn mức token Copilot. Thử lại vào ngày mai hoặc liên hệ quản trị.',
  ],
  // Trần USD. Trước đây mã này rơi xuống nhánh phỏng đoán `/…|403/` và người
  // dùng đọc "chưa được cấp quyền HOẶC đã hết hạn mức" — một câu hai vế, không
  // vế nào chắc, nên chẳng ai biết phải đi xin gì.
  [
    'daily_quota',
    'Hôm nay hệ thống đã dùng hết hạn mức chi phí Copilot. Thử lại vào ngày mai hoặc liên hệ quản trị.',
  ],
];

/** Hàm THUẦN — không chạm state, để test được mọi nhánh mà không cần DOM. */
export function dienGiaiLoiChat(msg: string): string {
  if (MA_ROLLOUT_QUAN_TRI.some((ma) => msg.includes(ma))) return formatCopilotRolloutError(msg);
  // Mã CỤ THỂ đứng trước phỏng đoán theo mã HTTP. Từ khi panel ghép `code: message`
  // (`organization_forbidden: HTTP 403`), một chuỗi có thể mang cả hai; `403` là
  // suy đoán từ trạng thái, còn `organization_forbidden` là điều proxy NÓI thẳng.
  // Để nhánh 403 chạy trước thì lỗi sai-công-ty bị dịch thành "hết hạn mức" —
  // đúng cái người dùng không cần biết, và sai cái họ cần làm.
  for (const [ma, cau] of THEO_MA) {
    if (msg.includes(ma)) return cau;
  }
  if (/not_entitled|not_permitted|403/.test(msg)) return HET_QUYEN_HOAC_HAN_MUC;
  // Lỗi lạ hiện nguyên văn: giấu đi thì không ai gỡ được, và người dùng không
  // có gì để chụp màn hình gửi đi.
  return `Lỗi: ${msg}`;
}

// ── Kế hoạch thực thi (G3) ───────────────────────────────────────────────────
//
// VÌ SAO MỘT BẢNG RIÊNG, KHÔNG NỐI VÀO `THEO_MA`
//   Hai bảng trả lời cho hai người đọc khác nhau. `THEO_MA` nói với người đang
//   CHAT ("chọn công ty đi", "hết hạn mức rồi"); bảng này nói với người đang
//   đứng trước một THẺ KẾ HOẠCH có nút Duyệt, và câu đúng ở đó luôn phải trả
//   lời được "kế hoạch của tôi giờ ra sao, tôi lập lại hay chờ?". Trộn hai bảng
//   là để một mã của kế hoạch rơi vào một câu viết cho khung chat, và ngược lại.
//
// MỘT MÃ Ở HAI ĐƯỜNG VỀ
//   `supabase.rpc` không bao giờ ném. Mã lỗi tới đây theo HAI đường: `data
//   .error_code` (nhánh server CHỌN ghi trạng thái rồi RETURN — xem quyết định 4
//   ở đầu migration `20260903100253`) và `error.message` (nhánh RAISE). Hàm này
//   nhận cả hai vì nó khớp theo chuỗi CON, nên nơi gọi không phải tự tách.
const THEO_MA_KE_HOACH: readonly [string, string][] = [
  // — Cửa trước khi lập —
  ['plan_role_not_allowed', 'Vai của bạn không được phép lập kế hoạch nhiều bước.'],
  ['plan_risk_not_allowed', 'Kế hoạch có bước vượt trần rủi ro hiện tại. Quản trị phải nâng trần ở trang AI Copilot trước.'],
  ['plan_step_count', 'Kế hoạch phải có từ 1 đến 8 bước.'],
  ['plan_steps_invalid', 'Danh sách bước không hợp lệ.'],
  ['plan_limit', 'Bạn đang có 3 kế hoạch mở. Hãy chạy xong hoặc huỷ bớt rồi lập kế hoạch mới.'],
  ['client_request_id_reused', 'Mã yêu cầu này đã dùng cho một kế hoạch ở công ty khác. Hãy lập lại.'],
  ['step_preview_failed', 'Không xem trước được một bước — dữ liệu của bước đó không hợp lệ. Sửa bước rồi lập lại kế hoạch.'],
  ['step_ref_incompatible', 'Bước nộp hồ sơ đang trỏ tới một bước không tạo ra phiếu thu/chi.'],
  ['step_ref_invalid', 'Tham chiếu tới bước trước không hợp lệ (phải là một bước ĐỨNG TRƯỚC trong cùng kế hoạch).'],
  ['step_voucher_invalid', 'Phiếu được chọn để nộp không hợp lệ: phải là phiếu nháp của chính bạn, chưa duyệt.'],
  ['executor_not_supported', 'Kiểu thực thi của bước này chưa được hỗ trợ ở phiên bản hiện tại.'],

  // — PIN step-up (G5-A, điểm nối #3) — không phân biệt "chưa đặt" khỏi "sai"
  // theo cùng kỷ luật fail-closed của `copilot_step_up_verify_v1`. Bốn mã dưới
  // đây khớp theo chuỗi CON nên bắt được cả dạng có số đi kèm
  // (`pin_invalid:3`, `pin_locked:45`) lẫn dạng trần.
  ['pin_format', 'Mã PIN phải gồm đúng 4 chữ số.'],
  ['pin_weak', 'Mã PIN này quá dễ đoán — hãy chọn một dãy số khác.'],
  ['pin_not_set', 'Bạn chưa đặt mã PIN xác thực hai lớp. Vào trang quản trị AI Copilot để đặt PIN trước.'],
  ['pin_locked', 'Mã PIN đang bị khoá do nhập sai nhiều lần. Hãy thử lại sau.'],
  ['pin_invalid', 'Mã PIN không đúng.'],
  ['step_up_superadmin_only', 'Chỉ super admin mới đặt/đổi/mở khoá được PIN step-up.'],

  // — Cửa lúc bấm duyệt —
  ['plan_digest_mismatch', 'Nội dung kế hoạch đã đổi so với lúc xem. Hãy lập lại kế hoạch.'],
  ['plan_version_stale', 'Kế hoạch vừa đổi trạng thái ở nơi khác. Tải lại rồi thử lại.'],
  ['plan_expired', 'Kế hoạch đã quá hạn. Hãy lập lại.'],
  ['plan_busy', 'Kế hoạch đang chạy ở nơi khác. Chờ vài giây rồi thử lại.'],
  ['plan_not_draft', 'Kế hoạch này không còn ở trạng thái chờ duyệt.'],
  ['plan_not_approved', 'Kế hoạch chưa được duyệt nên chưa chạy được bước nào.'],
  ['plan_not_cancellable', 'Kế hoạch này không huỷ được nữa.'],
  ['plan_no_pending_step', 'Kế hoạch không còn bước nào đang chờ chạy.'],
  ['plan_not_found', 'Không tìm thấy kế hoạch này.'],
  ['step_up_not_implemented', 'Bước này đòi xác thực hai lớp — cơ chế đó chưa mở ở phiên bản hiện tại.'],
  ['step_up_required', 'Bước này đòi xác thực hai lớp trước khi duyệt.'],
  ['step_not_permitted', 'Một bước đã mất quyền hoặc bị tắt kể từ lúc lập. Kế hoạch dừng lại; hãy lập lại.'],

  // — Cửa lúc chạy từng bước —
  ['registry_changed', 'Sổ đăng ký hành động vừa đổi sau khi kế hoạch được duyệt. Hãy lập lại kế hoạch.'],
  ['policy_changed', 'Chính sách hành động vừa đổi sau khi kế hoạch được duyệt. Hãy lập lại kế hoạch.'],
  ['payload_changed', 'Dữ liệu của bước đã đổi sau khi duyệt. Hãy lập lại kế hoạch.'],
  ['ref_step_unresolved', 'Bước trước chưa tạo ra thực thể để bước này tham chiếu.'],
  ['step_order', 'Các bước phải chạy tuần tự — còn bước trước chưa xong.'],
  ['copilot_auto_post_forbidden', 'Công ty này đang bật tự động hạch toán, nên Copilot không được nộp hồ sơ. Người có quyền tự làm trên giao diện.'],
  ['rule_denied', 'Bộ luật duyệt của công ty từ chối hồ sơ này.'],
  ['copilot_draft_invariant_violation', 'Bản ghi tạo ra không ở trạng thái đã hứa nên đã bị huỷ. Không có gì được ghi.'],
  ['copilot_write_readback_mismatch', 'Hệ thống đọc lại bản ghi vừa tạo và thấy không khớp nên đã huỷ. Không có gì được ghi.'],

  // — Cửa chung của mọi hành động —
  ['copilot_feature_disabled', 'Tính năng kế hoạch đang tắt cho công ty của bạn.'],
  ['copilot_action_disabled', 'Một hành động trong kế hoạch đang bị tắt bởi quản trị.'],
  ['tenant_emergency_denied', 'Công ty này đang trong lệnh cấm khẩn cấp — mọi thao tác ghi bị chặn.'],
  ['copilot_policy_missing', 'Chưa có chính sách hành động trong cơ sở dữ liệu — báo quản trị.'],
  ['organization_mismatch', 'Kế hoạch thuộc công ty khác với công ty đang chọn.'],
  ['organization_required', THONG_BAO_CHUA_CHON_TO_CHUC],
  ['not_permitted', 'Bạn không có quyền thực hiện một bước trong kế hoạch này.'],
  ['entity_not_found', 'Không tìm thấy đối tượng mà một bước trỏ tới.'],
  ['unauthenticated', 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.'],

  // — Kho nonce —
  ['confirmation_contract_mismatch', 'Phiếu đồng ý không thuộc kế hoạch này. Hãy lập lại kế hoạch.'],
  ['confirmation_already_used', 'Kế hoạch này đã được duyệt rồi.'],
  ['confirmation_expired', 'Phiếu đồng ý đã quá hạn (5 phút). Hãy lập lại kế hoạch.'],
  ['confirmation_not_found', 'Không tìm thấy phiếu đồng ý hợp lệ. Hãy lập lại kế hoạch.'],
  ['confirmation_required', 'Thiếu phiếu đồng ý — chỉ giao diện mới mở được cửa này.'],
];

/**
 * Mã lỗi của đường kế hoạch → câu người dùng làm được gì với nó.
 *
 * Hàm THUẦN, khớp theo chuỗi CON và duyệt theo THỨ TỰ bảng: mã dài đứng trước
 * mã ngắn lồng trong nó (`step_up_not_implemented` trước `step_up_required`,
 * `plan_not_draft` trước `plan_not_found`), đúng kỷ luật của `THEO_MA` ở trên.
 * Mã lạ hiện nguyên văn — giấu đi thì người dùng không có gì để chụp gửi đi.
 */
export function dienGiaiLoiKeHoach(msg: string): string {
  const s = String(msg ?? '');
  for (const [ma, cau] of THEO_MA_KE_HOACH) {
    if (s.includes(ma)) return cau;
  }
  return `Lỗi kế hoạch: ${s}`;
}
