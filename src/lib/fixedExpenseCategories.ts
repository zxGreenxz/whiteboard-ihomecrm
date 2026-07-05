// Danh sách CHUẨN 9 hạng mục chi phí CỐ ĐỊNH hằng tháng của một toà nhà, đúng thứ
// tự nghiệp vụ. Dùng CHUNG cho báo cáo "Phân bổ lợi nhuận" (desktop + mobile) để:
//   1. Sắp các khoản chi cố định lên đầu cột Chi theo đúng thứ tự này.
//   2. Chèn dòng placeholder "chưa có phiếu" (nền vàng nhạt) khi toà/tháng còn
//      thiếu phiếu của hạng mục nào — đánh dấu cho user kiểm tra/tạo bù.
//
// `category` trong DB là TEXT tự do (không enum/seed) nên khớp chủ yếu theo
// CATEGORY đã normalize, có fallback theo TÊN loại thu chi để chịu được loại
// thiếu category. Giữ nguyên logic khớp cũ (trước nằm inline trong
// ProfitDistributionReport.tsx) — chỉ tách ra + bổ sung nhãn hiển thị.

// Bỏ dấu + thường hoá để khớp hạng mục bất kể cách gõ ("Vệ Sinh" ≈ "vệ sinh").
// Giữ NGUYÊN thứ tự với bản gốc trong ProfitDistributionReport để hành vi khớp
// không đổi: toLowerCase TRƯỚC khi thay đ→d (đảo lại sẽ bỏ sót Đ hoa U+0110).
export const nrm = (s: string | null | undefined): string =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .trim();

export interface FixedExpenseCategory {
  key: string;
  /** Nhãn hiển thị của dòng placeholder khi hạng mục còn thiếu phiếu. */
  label: string;
  /** Khớp một dòng chi thuộc hạng mục này (cat, name đã qua nrm). */
  match: (cat: string, name: string) => boolean;
  /** Chỉ cảnh báo thiếu khi toà có cờ has_elevator (dành cho Bảo Trì Thang Máy). */
  requiresElevator?: boolean;
}

// Thứ tự phần tử = thứ tự ưu tiên hiển thị (index = rank; 0 lên đầu).
//   - "Vệ Sinh" ở đây = "Vệ sinh tòa nhà định kỳ" (category "Vệ sinh", loại trừ Rác).
//   - "vệ sinh máy lạnh"/"máy giặt" (category Bảo Trì) KHÔNG lọt nhóm Vệ Sinh.
export const FIXED_EXPENSE_CATEGORIES: FixedExpenseCategory[] = [
  { key: "tien_nha", label: "Tiền nhà", match: (c, n) => c === "tien nha" || n.includes("tien nha") },
  { key: "dien", label: "Điện", match: (c, n) => c === "dien" || n.includes("tien dien") },
  { key: "nuoc", label: "Nước", match: (c, n) => c === "nuoc" || n.includes("tien nuoc") },
  { key: "internet", label: "Internet", match: (c, n) => c === "internet" || n.includes("internet") },
  { key: "quan_ly", label: "Quản Lý", match: (_c, n) => n.includes("quan ly") },
  { key: "ve_sinh", label: "Vệ sinh tòa nhà định kỳ", match: (c, n) => c === "ve sinh" && !n.includes("rac") },
  { key: "cong_an", label: "Công an", match: (c, n) => c === "ca" || n.includes("cong an") },
  { key: "rac", label: "Rác", match: (_c, n) => n.includes("rac") },
  { key: "thang_may", label: "Bảo Trì Thang Máy", match: (_c, n) => n.includes("thang may"), requiresElevator: true },
];

const NO_RANK = FIXED_EXPENSE_CATEGORIES.length;

const matchRank = (c: string, n: string): number => {
  const i = FIXED_EXPENSE_CATEGORIES.findIndex((x) => x.match(c, n));
  return i === -1 ? NO_RANK : i;
};

// Thứ hạng ưu tiên của một dòng chi (0 = lên đầu). Không khớp hạng mục cố định
// nào → xuống cuối (rank = số lượng hạng mục).
//   - ƯU TIÊN khớp theo TRƯỜNG CÓ CẤU TRÚC (category + tên loại) — chính xác nhất.
//     Chỉ khi cả hai KHÔNG khớp mới dò tới MÔ TẢ phiếu (cho phiếu "tự động lập"/
//     không có item mang loại chung "Không có hạng mục" nhưng TÊN PHIẾU nói rõ
//     hạng mục, vd "Tiền nhà (tự động lập)").
//   - Vì cấu trúc thắng mô tả: phiếu tên "đóng tiền ĐIỆN NƯỚC" nhưng loại "Đóng
//     tiền nước" vẫn về đúng nhóm Nước (không bị hút vào Điện do chữ "điện" trong
//     tên). "điện lạnh" ≠ "tiền điện", "vệ sinh máy lạnh" (category Bảo Trì) không
//     lọt nhóm Vệ Sinh.
//   - `fixedRank` != null: dùng thẳng (cho dòng placeholder đã biết vị trí).
export const expenseRankOf = (
  category: string | null | undefined,
  typeName: string | null | undefined,
  description?: string | null,
  fixedRank?: number,
): number => {
  if (fixedRank != null) return fixedRank;
  const c = nrm(category);
  const byStructured = matchRank(c, nrm(typeName));
  if (byStructured < NO_RANK) return byStructured;
  // Fallback: chỉ khi category + tên loại KHÔNG khớp hạng mục cố định nào.
  if (description) return matchRank(c, nrm(description));
  return NO_RANK;
};
