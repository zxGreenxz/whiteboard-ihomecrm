// Sự thật ĐO ĐƯỢC về `page-agent` đang cài — đọc từ bundle, không đọc từ tài liệu.
//
// VÌ SAO ĐỌC BUNDLE THAY VÌ TIN README
//   Cả hàng rào UI-control dựa trên ba câu hỏi mà chỉ mã nguồn trả lời được:
//   whitelist có phải bộ lọc không, tool nào mang chỉ số phần tử, và thư viện có
//   cần `eval` không. Đoán sai bất kỳ câu nào thì hàng rào dựng lên sai chỗ —
//   và nó vẫn trông như đang hoạt động.
//
//   Đây cũng là lý do các hằng số dưới đây được kiểm bằng test đọc bundle thật:
//   nâng phiên bản mà semantics đổi thì test đỏ TRƯỚC khi ai đó tin nhầm.
//
// BA SỰ THẬT ĐÃ ĐO (page-agent 1.11.0, đo 14/08/2026)
//
//   1. `interactiveWhitelist` là ADDITIVE, KHÔNG phải bộ lọc.
//      Thân hàm `isInteractiveElement`:
//          if (interactiveBlacklist.includes(element)) return false;
//          if (interactiveWhitelist.includes(element)) return true;
//          … heuristic bình thường chạy tiếp …
//      Phần tử KHÔNG nằm trong whitelist vẫn đi qua heuristic và vẫn có thể
//      tương tác được. Nên "chỉ cho phép các control an toàn" KHÔNG làm được
//      bằng whitelist; muốn mặc-định-từ-chối phải liệt kê phần bù vào blacklist.
//
//   2. Phần bù đó KHÔNG dựng nổi từ mã ứng dụng.
//      Bộ duyệt DOM của thư viện đi vào open shadow root và same-origin iframe;
//      `document.querySelectorAll('*')` thì không. Một blacklist dựng từ light
//      DOM sẽ bỏ sót đúng những chỗ khó thấy nhất.
//
//      ⇒ Kết luận: đường khả thi là VÔ HIỆU HOÁ các tool mang chỉ số và thay
//        bằng tool ngữ nghĩa tự giải phần tử ngay trước khi thao tác.
//
//   3. `eval` chỉ nằm trong `PageController.executeJavascript`.
//      Đo được đúng MỘT lần gọi `eval(` trong toàn bộ bundle page-controller, và
//      nó nằm trong thân method đó. Không có `eval` lúc nạp module.
//
//      ⇒ Hệ quả trái với giả định trước đây: CSP production KHÔNG cần
//        `'unsafe-eval'`, miễn là `execute_javascript` không bao giờ được gọi —
//        mà ta đã tắt nó bằng `customTools: { execute_javascript: null }`.
//        Một method không được gọi thì `eval` trong thân nó không bao giờ chạy.

/** Phiên bản đã đo. Đổi số này mà không đo lại là nói dối có chữ ký. */
export const PHIEN_BAN_DA_DO = '1.11.0';

/**
 * Tool MANG CHỈ SỐ phần tử — phải vô hiệu hoá hết.
 *
 * Chúng nhận một số nguyên trỏ vào bảng phần tử tương tác mà thư viện tự dựng.
 * Vấn đề không phải là mô hình chọn nhầm số: vấn đề là BẢNG đó chứa mọi thứ
 * heuristic cho là tương tác được, tức là toàn bộ giao diện. Một tool nhận chỉ
 * số vào bảng đó là một tool chạm được mọi nút trên màn hình.
 */
export const TOOL_MANG_CHI_SO = [
  'click_element_by_index',
  'input_text',
  'select_dropdown_option',
] as const;

/** Tool chạy mã tuỳ ý — nguồn `eval` duy nhất, và phải luôn tắt. */
export const TOOL_CHAY_MA = 'execute_javascript' as const;

export interface SuThatPageAgent {
  /** Whitelist có hoạt động như BỘ LỌC (chỉ cho phép thứ trong danh sách) không. */
  whitelistLaBoLoc: boolean;
  /** Blacklist có được ưu tiên trước whitelist không. */
  blacklistThangWhitelist: boolean;
  /** Bộ duyệt có đi vào open shadow root không. */
  duyetShadowRoot: boolean;
  /** Bộ duyệt có đi vào same-origin iframe không. */
  duyetIframe: boolean;
  /** `eval` có nằm NGOÀI `executeJavascript` không (nếu có thì CSP buộc phải nới). */
  evalNgoaiExecuteJavascript: boolean;
}

/**
 * Sự thật đã đo, dạng dữ liệu để nơi khác quyết định dựa vào.
 *
 * Test `pageAgentCompatibility.test.ts` đọc bundle thật và đối chiếu với đúng
 * object này — nên nó không phải một lời khai, nó là một khẳng định có người canh.
 */
export const SU_THAT_DA_DO: SuThatPageAgent = {
  whitelistLaBoLoc: false,
  blacklistThangWhitelist: true,
  duyetShadowRoot: true,
  duyetIframe: true,
  evalNgoaiExecuteJavascript: false,
};

/**
 * Đường đi đã chọn cho hàng rào UI-control.
 *
 * `semantic_tools`: tắt hết tool mang chỉ số, thay bằng tool ngữ nghĩa nhận ID
 * control ổn định. Chọn đường này vì sự thật (1) và (2) ở trên khoá đường còn
 * lại: whitelist không lọc được, và phần bù không dựng nổi từ mã ứng dụng.
 */
export const DUONG_DA_CHON = 'semantic_tools' as const;

/**
 * CSP production có buộc phải nới `'unsafe-eval'` không.
 *
 * `false` vì `eval` chỉ nằm trong thân `executeJavascript`, và tool đó luôn tắt.
 * Nếu một bản nâng cấp đưa `eval` ra ngoài, test sẽ đỏ và giá trị này phải đổi
 * TRƯỚC khi ai đó thêm CSP rồi ngạc nhiên vì Copilot chết.
 */
export const CSP_CAN_UNSAFE_EVAL = false;
