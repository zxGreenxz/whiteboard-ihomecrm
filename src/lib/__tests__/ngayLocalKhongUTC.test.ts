import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { todayISO } from "../collect";

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

  it("KHÔNG bao giờ rơi về ngày UTC khi máy ở múi giờ dương và đang là đầu ngày", () => {
    vi.useFakeTimers();
    vi.setSystemTime(KHOANH_GIO_HONG);

    // Điều kiện chỉ đúng ở múi giờ DƯƠNG; ở UTC và múi giờ âm thì hai giá trị
    // trùng nhau hoặc lệch theo chiều ngược lại, nên bỏ qua thay vì khẳng định sai.
    if (new Date().getTimezoneOffset() >= 0) return;

    expect(todayISO()).not.toBe(new Date().toISOString().slice(0, 10));
  });
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
