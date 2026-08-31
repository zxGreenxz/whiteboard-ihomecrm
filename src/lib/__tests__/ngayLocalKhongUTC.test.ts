import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { currentMonthVN, todayISO } from "../collect";

/**
 * Khoá lại một lớp lỗi đã cắn thật, không phải một quy ước phong cách.
 *
 * `new Date().toISOString()` LUÔN đổi sang UTC. Cắt 10 ký tự đầu của nó để lấy
 * "hôm nay" nghĩa là lấy ngày theo UTC — nên với người dùng ở UTC+7, trong khoảng
 * 00:00–07:00 giờ VN nó trả về NGÀY HÔM QUA. Bảy tiếng mỗi ngày, và vào ngày 1
 * thì lệch hẳn THÁNG, đúng lúc chốt kỳ hoá đơn / lương / lợi nhuận.
 *
 * Vì sao không test nào bắt được suốt thời gian dài: bất đối xứng môi trường bị
 * ĐẢO so với các lỗi thông thường. Chỗ hỏng là PRODUCTION (trình duyệt người dùng
 * ở VN); chỗ xanh là CI (Ubuntu, TZ=UTC — ở đó local ≡ UTC nên không có gì lệch).
 * Test nào tự tính giá trị kỳ vọng cũng bằng toISOString() thì hai vế luôn bằng
 * nhau. Vì vậy test dưới đây ÉP đồng hồ vào đúng cửa sổ hỏng thay vì tin giờ chạy.
 */

const KHOANH_GIO_HONG = new Date("2026-08-31T18:00:00Z"); // = 01:00 ngày 01/09 giờ VN

afterEach(() => {
  vi.useRealTimers();
});

describe("todayISO — ngày theo giờ local, không phải UTC", () => {
  // Bản thân test này KHÔNG được phụ thuộc múi giờ của máy chạy, nếu không nó
  // lại rơi đúng vào cái bẫy nó đang canh. (Bản đầu tôi viết khoá cứng chuỗi
  // "2026-09-01" — chỉ đúng khi máy ở UTC+7, và gate check-timezone-stability
  // bắt được ngay ở UTC và UTC-11.)
  // Nên chỗ minh hoạ dùng Intl với múi giờ KHAI TƯỜNG MINH: tất định ở mọi máy.
  it("cùng một thời điểm, ngày theo UTC và ngày theo giờ VN lệch hẳn một tháng", () => {
    const vnHomNay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(KHOANH_GIO_HONG);

    expect(KHOANH_GIO_HONG.toISOString().slice(0, 10)).toBe("2026-08-31");
    expect(vnHomNay).toBe("2026-09-01");
  });

  it("todayISO luôn là ngày LOCAL của thời điểm hiện tại", () => {
    vi.useFakeTimers();
    vi.setSystemTime(KHOANH_GIO_HONG);

    const d = new Date();
    const mong = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(todayISO()).toBe(mong);
  });

  // 31/08 (audit /thanh-toan P2-04): kỳ mặc định của /thu-tien + /thanh-toan
  // GHIM múi giờ VN qua Intl — tất định ở MỌI máy chạy test, kể cả CI UTC/UTC-11
  // (khác todayISO vốn cố ý theo local). Đúng khoảnh giờ hỏng: 18:00Z ngày 31/08
  // = 01:00 ngày 01/09 giờ VN ⇒ kỳ phải là 2026-09, dù máy UTC đang ở tháng 8.
  it("currentMonthVN trả kỳ theo giờ VN, không theo giờ máy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(KHOANH_GIO_HONG);

    expect(currentMonthVN()).toBe("2026-09");
    expect(currentMonthVN()).toMatch(/^\d{4}-\d{2}$/);
  });

  // ĐÃ GỠ một test thứ ba ở đây, và lý do đáng ghi lại.
  //
  // Nó viết là:
  //     if (new Date().getTimezoneOffset() >= 0) return;
  //     expect(todayISO()).not.toBe(new Date().toISOString().slice(0, 10));
  //
  // `getTimezoneOffset()` trả số phút SAU UTC, nên UTC ra 0 và điều kiện đó đúng.
  // Trên CI (Ubuntu, TZ=UTC) test thoát ra TRƯỚC assertion duy nhất của nó ⇒ xanh
  // mà không kiểm gì. Đúng lớp lỗi mà chính file này được viết ra để chống, và tôi
  // tự mắc phải trong cùng một ngày.
  //
  // Không viết lại vì nó THỪA: điều nó muốn nói — cùng một thời điểm, ngày theo
  // UTC và ngày theo giờ VN lệch nhau — đã được ca đầu khẳng định TẤT ĐỊNH bằng
  // Intl với múi giờ khai tường minh, chạy đúng ở mọi máy. Thêm một ca phụ thuộc
  // giờ máy chỉ làm giảm độ tin cậy chứ không thêm độ phủ.
});

/**
 * Ratchet: đếm số chỗ CÒN LẤY NGÀY bằng UTC trong các file TIỀN.
 *
 * Không quét cả `src/` vì còn ~40 chỗ ngoài phạm vi tiền chưa rà; đặt ngưỡng cho
 * cả repo bây giờ sẽ hoặc là dối, hoặc chặn mọi thứ. Danh sách dưới đây là các
 * file đã được rà từng dòng và đã sửa — nhiệm vụ của ratchet là giữ chúng KHÔNG
 * quay lại, vì lỗi này không có triệu chứng nào nhìn thấy được.
 */
const FILE_TIEN_DA_RA = [
  "src/components/invoices/GenerateInvoiceDialog.tsx",
  "src/components/invoices/RecordPaymentDialog.tsx",
  "src/components/income-expenses/IncomeExpenseForm.tsx",
  "src/components/income-expenses/IncomeExpenseBatchForm.tsx",
  "src/components/income-expenses/IncomeExpensePostingDialog.tsx",
  "src/components/cashbooks/CashbookForm.tsx",
  "src/components/thu-tien/PeriodFeePanel.tsx",
  "src/hooks/income-expenses/statusMutations.ts",
  "src/hooks/income-expenses/financeV2Mutations.ts",
  "src/hooks/useInvoices.ts",
  "src/copilot/tools/writeTools.ts",
];

// Chỉ khớp dạng CẮT LẤY NGÀY. `new Date().toISOString()` đầy đủ là ĐÚNG cho cột
// timestamp (approved_at, created_at…) — cấm nhầm nó sẽ khiến gate bị vô hiệu hoá.
const CAT_NGAY_UTC = /toISOString\(\)\s*(?:\.split\((['"])T\1\)\[0\]|\.slice\(\s*0\s*,\s*10\s*\))/g;

describe("các file tiền không lấy ngày bằng UTC", () => {
  it.each(FILE_TIEN_DA_RA)("%s", (file) => {
    const src = readFileSync(file, "utf8");
    const hit = src.match(CAT_NGAY_UTC) ?? [];
    expect(
      hit.length,
      `${file} lấy ngày từ toISOString() (giờ UTC). Dùng todayISO() từ @/lib/collect, ` +
        `hoặc format(d, "yyyy-MM-dd") của date-fns nếu là một Date bất kỳ.`,
    ).toBe(0);
  });
});
