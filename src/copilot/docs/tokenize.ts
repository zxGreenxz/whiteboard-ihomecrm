// Tách từ tiếng Việt cho tìm kiếm tài liệu — hàm THUẦN, không I/O, không quyền.
//
// Tiếng Việt là ngôn ngữ đơn lập: không biến hình, không cần stemmer. Đó là món
// quà lớn nhất cho tìm kiếm từ vựng ở đây — thứ mà tiếng Anh phải đánh đổi bằng
// Porter/Snowball thì ta không phải trả.
//
// Cái KHÓ nằm chỗ khác: người dùng gõ không dấu ("hoa don", "thanh ly"), và
// một âm tiết đơn thì cực kỳ nhập nhằng — "đơn" có trong "đơn giá", "hoá đơn",
// "đơn hàng", "biểu mẫu đơn". Hai vấn đề, hai cách chữa: bỏ dấu để khớp, và
// bigram kề để lấy lại độ chính xác mức-từ mà không cần bộ tách từ tiếng Việt.

/**
 * Bỏ dấu, gấp thường: "Hoá Đơn" → "hoa don".
 *
 * Thứ tự các bước không đổi được:
 *  1. `NFD` tách chữ cái khỏi dấu thanh/dấu mũ. BẮT BUỘC vì corpus lẫn cả NFC
 *     (dựng sẵn) lẫn NFD (tổ hợp) — cùng một chữ "hoá" có thể là hai dãy byte
 *     khác nhau, và bỏ bước này thì một nửa corpus không khớp được.
 *  2. Xoá dấu tổ hợp bằng `\p{Mn}` (nonspacing mark). Cố ý KHÔNG viết dải
 *     `[U+0300-U+036F]` bằng ký tự thô như bản cũ ở `registry.ts:337` — hai ký
 *     tự đó vô hình khi review và một bước re-encode của editor có thể phá âm
 *     thầm, làm mọi truy vấn không dấu ngừng khớp mà không ai thấy gì đổi.
 *  3. `đ → d` RIÊNG: chữ `đ` là một CHỮ CÁI, không phải `d` kèm dấu, nên NFD
 *     không tách nó ra. Thiếu bước này thì "hoa don" không bao giờ khớp
 *     "hoá đơn" — đúng truy vấn phổ biến nhất.
 */
export function boDau(s: string): string {
  return s
    .normalize('NFD')
    .toLowerCase()
    .replace(/\p{Mn}/gu, '')
    .replace(/đ/g, 'd');
}

/** Cắt thành âm tiết, GIỮ NGUYÊN dấu. Chỉ gấp thường. */
export function tachAmTiet(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Cắt thành âm tiết theo mọi thứ không phải chữ/số. Đã bỏ dấu sẵn. */
export function tachTu(s: string): string[] {
  return boDau(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Thêm bigram kề: `['hoa','don']` → `['hoa','don','hoa_don']`.
 *
 * Đây là cách mua độ chính xác mức-từ mà KHÔNG cần word segmenter tiếng Việt.
 * Một chunk nói "hoá đơn" và một chunk nói "đơn giá của hoá chất" có cùng tập
 * âm tiết; chỉ bigram phân biệt được chúng.
 */
export function themBigram(tokens: string[]): string[] {
  const out = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]}_${tokens[i + 1]}`);
  return out;
}

/**
 * Mở rộng truy vấn bằng bảng đồng nghĩa nghiệp vụ.
 *
 * Đây là phần mua được ~phần lớn lợi ích của embedding với giá 30 dòng đọc
 * được, review được, test tất định được. Người dùng hỏi "lấy lại tiền cọc",
 * tài liệu viết "hoàn cọc khi thanh lý" — không có bảng này thì hai câu đó
 * không gặp nhau, dù cùng nghĩa.
 *
 * Chỉ mở rộng TRUY VẤN, không mở rộng tài liệu: mở rộng cả hai phía làm IDF
 * loãng ra và mọi thứ trông giống nhau.
 */
export const DONG_NGHIA: Record<string, string[]> = {
  // Cọc
  coc: ['dat_coc', 'tien_coc', 'giu_cho'],
  giu_cho: ['coc', 'dat_coc'],
  // Kết thúc hợp đồng
  thanh_ly: ['ket_thuc_hop_dong', 'tra_phong', 'roi_phong', 'bo_coc'],
  tra_phong: ['thanh_ly', 'roi_phong'],
  bo_coc: ['thanh_ly', 'forfeit'],
  // Tiền
  cong_no: ['no', 'chua_thu', 'chua_thanh_toan'],
  thu_tien: ['thanh_toan', 'thu'],
  so_quy: ['quy', 'thu_chi', 'doi_soat'],
  hoa_don: ['bill', 'invoice'],
  // Vận hành
  cong_to: ['chi_so', 'dien_nuoc', 'meter'],
  chot_chi_so: ['cong_to', 'ghi_chi_so'],
  lap_day: ['occupancy', 'ty_le_lap_day', 'phong_trong'],
  // Nhân sự
  luong: ['thuong', 'hoa_hong', 'salary'],
  phan_quyen: ['quyen', 'vai_tro', 'permission'],
};

export function moRongDongNghia(tokens: string[]): string[] {
  const out = new Set(tokens);
  for (const t of tokens) for (const d of DONG_NGHIA[t] ?? []) out.add(d);
  return [...out];
}

/**
 * Hư từ tiếng Việt — chỉ lọc khỏi TRUY VẤN, không lọc khỏi tài liệu.
 *
 * Tôi đã định KHÔNG viết bảng này: lý thuyết nói IDF tự dìm hư từ, và một bảng
 * tay là thứ phải bảo trì. Đo trên corpus thật thì lý thuyết đó sai ở tiếng
 * Việt, vì một lý do riêng của ngôn ngữ đơn lập: hư từ GHÉP ĐÔI lại thành cụm
 * HIẾM trong tài liệu kỹ thuật. Số đo ngày 12/08/2026:
 *
 *   "cái này thì sao"        → khớp `nay`, `sao`      → 14,7 điểm
 *   "the nao la duoc"        → khớp bigram `the_nao`  → 18,1 điểm
 *   "của và là được thì mà"  → khớp bigram `thi_ma`   → 29,5 điểm
 *
 * `the_nao` và `thi_ma` có df thấp thật, nên mọi luật dựa trên độ hiếm đều coi
 * chúng là "có sức phân biệt". Độ hiếm đo được sự lạ, không đo được nghĩa.
 *
 * Bảng này ổn định theo thời gian: ngôn ngữ không sinh thêm hư từ. Đó là khác
 * biệt giữa nó và một bảng từ khoá nghiệp vụ — thứ sẽ phải chạy theo sản phẩm.
 */
/**
 * Hư từ, dạng CÓ DẤU. Lọc phải chạy TRƯỚC khi bỏ dấu — đây là điểm mấu chốt.
 *
 * Bản đầu của tôi lọc SAU khi bỏ dấu, và điều đó phá 18 cụm nghiệp vụ trung tâm
 * cùng lúc, vì tiếng Việt bỏ dấu thì hư từ đụng thẳng vào từ có nghĩa:
 *
 *   nợ→no      chỉ số→chi   tài sản/tài chính→tai   báo cáo→bao
 *   phòng TRỐNG→trong       mã hoá đơn→ma           bán hàng→ban
 *   hộ khẩu→ho  cửa hàng→cua  đo điện→do  đầu kỳ→dau  thẻ→the  tủ→tu
 *
 * Hỏi "nợ" hay "phòng trống" mà trả về rỗng thì trợ lý coi như hỏng — nặng hơn
 * nhiều so với việc thỉnh thoảng cho lọt một câu vô nghĩa. Dấu thanh chính là
 * thứ phân biệt "nợ" với "nó", "trống" với "trong"; vứt nó đi rồi mới lọc là tự
 * bỏ mất thông tin cần để lọc đúng.
 */
export const HU_TU_CO_DAU = new Set([
  'cái', 'của', 'và', 'là', 'được', 'thì', 'mà', 'này', 'kia', 'đó', 'ấy',
  'sao', 'nào', 'thế', 'như', 'nhưng', 'những', 'các', 'một', 'có', 'không',
  'cho', 'với', 'từ', 'đến', 'khi', 'nếu', 'hoặc', 'cũng', 'đã', 'sẽ',
  'đang', 'bị', 'bởi', 'tại', 'về', 'ở', 'trong', 'ngoài', 'trên', 'dưới',
  'ai', 'gì', 'đâu', 'bao', 'nhiêu', 'rất', 'quá', 'lắm', 'hơn', 'nhất',
  'tôi', 'bạn', 'mình', 'họ', 'nó', 'hay', 'rồi', 'chỉ', 'còn', 'nên',
]);

/**
 * Hư từ dạng KHÔNG DẤU — chỉ những âm tiết mà bản bỏ dấu KHÔNG đụng từ nghiệp vụ nào.
 *
 * Cần vì người dùng hay gõ không dấu, khi đó bảng có dấu ở trên không khớp gì.
 * Danh sách này cố tình NGẮN và bảo thủ: mỗi mục thêm vào là một cơ hội nuốt
 * nhầm từ có nghĩa. Test `tokenize.test.ts` canh bằng một rổ cụm nghiệp vụ —
 * thêm mục nào làm rơi một cụm trong rổ đó thì test đỏ.
 */
export const HU_TU_KHONG_DAU = new Set([
  'va', 'la', 'thi', 'nay', 'kia', 'ay', 'nhu', 'nhung', 'cac', 'khong',
  'neu', 'hoac', 'cung', 'se', 'boi', 'ngoai', 'tren', 'duoi', 'ai', 'gi',
  'nhieu', 'rat', 'hon', 'nhat', 'minh', 'roi', 'nen', 'sao', 'duoc',
  // Hai mục dưới là ĐÁNH ĐỔI có ý thức, không phải bỏ sót:
  //   'nao' — đụng "não", không phải từ nghiệp vụ ở đây.
  //   'the' — đụng "thẻ" và "thể". Người gõ "the tu" (thẻ từ) sẽ mất một âm
  //     tiết, nhưng "thế nào" là cụm hỏi phổ biến hơn nhiều bậc, và "the" đứng
  //     một mình gần như luôn là hư từ. Ai gõ có dấu thì cả hai đều đúng.
  'nao', 'the',
]);

/**
 * Bỏ hư từ. Nhận âm tiết CÓ DẤU, trả về âm tiết có dấu đã lọc.
 *
 * Một âm tiết bị bỏ khi: nó là hư từ có dấu, HOẶC (người dùng gõ không dấu nên
 * bản thân nó đã không dấu) nó nằm trong danh sách không dấu bảo thủ.
 */
export function boHuTu(amTiet: string[]): string[] {
  return amTiet.filter((t) => {
    if (HU_TU_CO_DAU.has(t)) return false;
    // Chỉ áp bảng không dấu cho âm tiết vốn KHÔNG có dấu; nếu không thì "nợ"
    // (bỏ dấu ra "no") lại bị nuốt đúng như lỗi vừa sửa.
    if (boDau(t) === t && HU_TU_KHONG_DAU.has(t)) return false;
    return true;
  });
}

/**
 * Token của một TRUY VẤN: lọc hư từ trên dạng CÓ DẤU, rồi mới bỏ dấu, ghép
 * bigram và mở rộng đồng nghĩa.
 *
 * Truy vấn chỉ gồm hư từ ⇒ trả rỗng ⇒ không kết quả. Đó là câu trả lời đúng cho
 * "cái này thì sao": thà nói không hiểu, còn hơn đưa một đoạn tài liệu ngẫu
 * nhiên kèm giọng điệu chắc chắn.
 */
export function tokenTruyVan(q: string): string[] {
  const giuLai = boHuTu(tachAmTiet(q)).map(boDau).filter(Boolean);
  return moRongDongNghia(themBigram(giuLai));
}

/** Token của một ĐOẠN tài liệu: âm tiết + bigram (KHÔNG mở rộng đồng nghĩa). */
export function tokenTaiLieu(s: string): string[] {
  return themBigram(tachTu(s));
}
