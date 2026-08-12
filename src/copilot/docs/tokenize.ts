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
export const HU_TU = new Set([
  'cai', 'cua', 'va', 'la', 'duoc', 'thi', 'ma', 'nay', 'kia', 'do', 'ay',
  'sao', 'nao', 'the', 'nhu', 'nhung', 'cac', 'mot', 'co', 'khong',
  'cho', 'voi', 'tu', 'den', 'khi', 'neu', 'hoac', 'cung', 'da', 'se',
  'dang', 'bi', 'boi', 'tai', 've', 'o', 'trong', 'ngoai', 'tren', 'duoi',
  'ai', 'gi', 'dau', 'bao', 'nhieu', 'rat', 'qua', 'lam', 'hon', 'nhat',
  'toi', 'ban', 'minh', 'ho', 'no', 'hay', 'roi', 'chi', 'con', 'nen',
]);

/**
 * Bỏ hư từ khỏi token truy vấn.
 *
 * Bigram chỉ bị bỏ khi CẢ HAI vế đều là hư từ: "vào sổ" (`vao_so`) phải giữ,
 * còn "thì mà" (`thi_ma`) thì bỏ. Bỏ mọi bigram có một vế hư từ sẽ cắt mất
 * nhiều cụm nghiệp vụ có giới từ.
 */
export function boHuTu(tokens: string[]): string[] {
  return tokens.filter((t) => {
    const ve = t.split('_');
    return !ve.every((v) => HU_TU.has(v));
  });
}

/**
 * Token của một TRUY VẤN: âm tiết + bigram, bỏ hư từ, rồi mở rộng đồng nghĩa.
 *
 * Truy vấn chỉ gồm hư từ ⇒ trả rỗng ⇒ không kết quả. Đó là câu trả lời đúng cho
 * "cái này thì sao": thà nói không hiểu, còn hơn đưa một đoạn tài liệu ngẫu
 * nhiên kèm giọng điệu chắc chắn.
 */
export function tokenTruyVan(q: string): string[] {
  return moRongDongNghia(boHuTu(themBigram(tachTu(q))));
}

/** Token của một ĐOẠN tài liệu: âm tiết + bigram (KHÔNG mở rộng đồng nghĩa). */
export function tokenTaiLieu(s: string): string[] {
  return themBigram(tachTu(s));
}
