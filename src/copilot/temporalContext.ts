// Kỳ thời gian TƯƠNG ĐỐI ("tháng này", "quý trước", "từ 01/07 đến 15/07") —
// chuẩn hoá TRƯỚC khi gọi tool, không giao cho mô hình tự tính.
//
// VÌ SAO KHÔNG ĐỂ MÔ HÌNH TỰ TÍNH
//   System prompt đã mang ngày hôm nay dưới dạng câu chữ (`dongHomNay`). Vậy mà
//   đánh giá live 13/08/2026 ca C28 ("doanh thu tháng trước") ghi nhận mô hình
//   NÓI KHÔNG BIẾT NGÀY và hỏi lại người dùng là kỳ nào. Một câu văn trong prompt
//   là gợi ý, không phải hợp đồng: mô hình có thể bỏ qua, đọc sai, hoặc trừ nhầm
//   tháng ở ranh giới năm — và cả ba kiểu hỏng đều trả về một con số trông hợp lý.
//
//   Ở đây kỳ được tính bằng mã, rồi ÉP vào tham số tool. Mô hình vẫn chọn tool và
//   diễn giải kết quả; nó chỉ không còn là nơi làm phép trừ ngày tháng.
//
// GIỜ VIỆT NAM, KHÔNG PHẢI GIỜ MÁY
//   Dùng `vnYmOf` (Intl + Asia/Ho_Chi_Minh) thay `new Date().getMonth()`. CI chạy
//   UTC còn dữ liệu ở UTC+7, nên trong khoảng 00:00–07:00 giờ VN ngày mùng 1,
//   giờ máy vẫn đang ở tháng trước — đúng loại lỗi đã làm màn lương mặc định sai
//   kỳ (audit 2026-07-20).
import { shiftYm } from '@/lib/managerSalary';
import { vnYmOf } from '@/lib/salaryPeriod';

export interface CopilotRequestContext {
  /** "YYYY-MM" hiện tại theo giờ Việt Nam. */
  kyHienTai: string;
  /**
   * "YYYY-MM-DD" hôm nay theo giờ Việt Nam.
   *
   * Cần cho "tuần này/tuần trước": một kỳ tuần KHÔNG suy được từ "YYYY-MM".
   */
  ngayHienTai: string;
  timeZone: string;
  locale: string;
}

/** Kỳ gói gọn trong một tháng, một quý, một năm, một tuần, hay một khoảng tự do. */
export type LoaiKy = 'month' | 'quarter' | 'year' | 'week' | 'range';

export type CopilotResolvedPeriod = {
  kind: LoaiKy;
  /**
   * "YYYY-MM" — CHỈ có khi kỳ nằm gọn trong MỘT tháng.
   *
   * `null` cho quý/năm/tuần/khoảng: nhét đại một tháng vào đó là biến "quý 3"
   * thành "tháng 7" mà không ai thấy. Tool chỉ nhận tham số tháng sẽ được để
   * yên (xem `apDungKyTuongDoi`), tool có `tu`/`den` nhận đủ khoảng.
   */
  month: string | null;
  /** "YYYY-MM-DD" mốc đầu kỳ. */
  startDate: string;
  /** "YYYY-MM-DD" mốc cuối kỳ (bao gồm chính ngày đó). */
  endDate: string;
  /** Nhãn tiếng Việt để NÓI LẠI kỳ đã chốt cho người dùng, vd "quý 3/2026". */
  nhan: string;
} | null;

/**
 * "YYYY-MM-DD" của `d` theo GIỜ VIỆT NAM.
 *
 * Cùng lý do với `vnYmOf`: `d.getDate()` đọc theo giờ máy, và CI chạy UTC nên
 * từ 17:00Z trở đi ngày VN đã sang hôm sau. Một kỳ "tuần này" lệch một ngày ở
 * ranh giới tuần là lệch nguyên bảy ngày dữ liệu.
 */
export function vnNgayOf(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${day}`;
}

export function taoRequestContext(now: Date = new Date()): CopilotRequestContext {
  return {
    kyHienTai: vnYmOf(now),
    ngayHienTai: vnNgayOf(now),
    timeZone: 'Asia/Ho_Chi_Minh',
    locale: 'vi-VN',
  };
}

/** Ngày cuối tháng của "YYYY-MM" — dùng UTC để không lệch theo giờ máy. */
export function ngayCuoiThang(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const hai = (n: number): string => String(n).padStart(2, '0');

/** "YYYY-MM-DD" → mốc UTC. Mọi phép cộng/trừ ngày ở đây đi qua UTC. */
function mocUTC(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoTu(d: Date): string {
  return `${d.getUTCFullYear()}-${hai(d.getUTCMonth() + 1)}-${hai(d.getUTCDate())}`;
}

function themNgay(iso: string, soNgay: number): string {
  const d = mocUTC(iso);
  d.setUTCDate(d.getUTCDate() + soNgay);
  return isoTu(d);
}

const nhanNgay = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

function kyThang(month: string): CopilotResolvedPeriod {
  const [y, m] = month.split('-');
  return {
    kind: 'month',
    month,
    startDate: `${month}-01`,
    endDate: ngayCuoiThang(month),
    nhan: `tháng ${m}/${y}`,
  };
}

function kyQuy(nam: number, quy: number): CopilotResolvedPeriod {
  const thangDau = (quy - 1) * 3 + 1;
  return {
    kind: 'quarter',
    month: null,
    startDate: `${nam}-${hai(thangDau)}-01`,
    endDate: ngayCuoiThang(`${nam}-${hai(thangDau + 2)}`),
    nhan: `quý ${quy}/${nam}`,
  };
}

function kyNam(nam: number): CopilotResolvedPeriod {
  return {
    kind: 'year',
    month: null,
    startDate: `${nam}-01-01`,
    endDate: `${nam}-12-31`,
    nhan: `năm ${nam}`,
  };
}

/** Tuần THỨ HAI → CHỦ NHẬT (nếp Việt Nam), tính từ một ngày bất kỳ trong tuần. */
function kyTuan(ngayTrongTuan: string, dichTuan: number): CopilotResolvedPeriod {
  const thu = mocUTC(ngayTrongTuan).getUTCDay(); // 0 = Chủ nhật
  const lui = (thu + 6) % 7; // Thứ hai = 0
  const dau = themNgay(ngayTrongTuan, -lui + dichTuan * 7);
  const cuoi = themNgay(dau, 6);
  return {
    kind: 'week',
    month: null,
    startDate: dau,
    endDate: cuoi,
    nhan: `tuần ${nhanNgay(dau)} – ${nhanNgay(cuoi)}`,
  };
}

function kyKhoang(tu: string, den: string): CopilotResolvedPeriod {
  const [a, b] = tu <= den ? [tu, den] : [den, tu];
  return {
    kind: 'range',
    month: null,
    startDate: a,
    endDate: b,
    nhan: `${nhanNgay(a)} – ${nhanNgay(b)}`,
  };
}

const quyCua = (thang: number): number => Math.floor((thang - 1) / 3) + 1;

/** Ngày hợp lệ theo lịch thật (31/02 bị loại, không bị cuộn sang 03/03). */
function ngayHopLe(nam: number, thang: number, ngay: number): boolean {
  if (thang < 1 || thang > 12 || ngay < 1 || ngay > 31) return false;
  const d = new Date(Date.UTC(nam, thang - 1, ngay));
  return d.getUTCMonth() === thang - 1 && d.getUTCDate() === ngay;
}

/** "26" → 2026, "2026" → 2026. Hai chữ số hiểu là thế kỷ 21. */
const namDayDu = (raw: string): number => (raw.length === 2 ? 2000 + Number(raw) : Number(raw));

// ── Các mẫu câu ────────────────────────────────────────────────────────
//
// KHỚP THEO VỊ TRÍ TRÁI-SANG-PHẢI, KHÔNG PHẢI THEO THỨ TỰ KHAI BÁO.
//   Bản đầu thử từng mẫu theo thứ tự ưu tiên trên TOÀN BỘ câu, và thứ tự đó
//   quyết định kết quả bất kể cụm nào đứng trước trong câu. Hệ quả đo được
//   (soát 03/09/2026): "doanh thu tháng 7 năm 2024" trả về CẢ NĂM 2024, vì mẫu
//   năm được thử trước mẫu tháng. Con số trả về lớn gấp mười hai lần con số
//   người dùng hỏi, và không có gì đỏ.
//
//   Nay quét như một bộ tách từ: tìm cụm khớp SỚM NHẤT trong câu, giải nghĩa
//   nó, rồi nhảy qua phần đã tiêu thụ và quét tiếp. Thứ tự khai báo chỉ còn là
//   luật phá hoà khi hai mẫu cùng khớp tại CÙNG một vị trí (`tháng 7 năm 2024`
//   khớp `RE_THANG_SO` tại "tháng", nuốt luôn "năm 2024").
//
//   Quét được cả câu cũng là thứ cho phép biết câu có NHIỀU kỳ hay không —
//   xem `soKyRiengBiet`.
//
// Mọi mẫu khớp cả bản CÓ DẤU lẫn KHÔNG DẤU: người gõ nhanh bỏ dấu, và một bộ
// chuẩn hoá chỉ hiểu tiếng Việt có dấu sẽ im lặng bỏ sót đúng nhóm người dùng
// gõ nhiều nhất.

const RE_KHOANG_ISO =
  /t[ừu]\s*(?:ng[àa]y\s*)?(\d{4}-\d{2}-\d{2})\s*(?:đ[ếe]n|t[ớo]i|-|–)\s*(?:ng[àa]y\s*)?(\d{4}-\d{2}-\d{2})/i;
const RE_KHOANG_DMY =
  /t[ừu]\s*(?:ng[àa]y\s*)?(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\s*(?:đ[ếe]n|t[ớo]i|–)\s*(?:ng[àa]y\s*)?(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?/i;
const RE_N_THANG_QUA = /(\d{1,2})\s*th[áa]ng\s*(?:qua|g[âầa]n\s*đ[âaầ]y|g[âầa]n\s*nh[âấầa]t|v[ừu]a\s*qua)/i;
const RE_N_THANG_TRUOC = /(\d{1,2})\s*th[áa]ng\s*tr[ưu][ớoơ]c/i;
// Năm đi kèm nhận cả ba cách viết: "tháng 7/2024", "tháng 7-2024", "tháng 7 năm 2024".
const RE_THANG_SO = /th[áa]ng\s*(\d{1,2})(?:\s*(?:[/\-]|n[ăa]m)\s*(20\d{2}))?/i;
const RE_QUY_NAY = /qu[ýy]\s*(?:n[àa]y|hi[ệe]n\s*t[ạa]i)/i;
const RE_QUY_TRUOC = /qu[ýy]\s*(?:tr[ưu][ớoơ]c|r[ồo]i|v[ừu]a\s*r[ồo]i)/i;
const RE_NAM_CU_THE = /n[ăa]m\s*(20\d{2})\b/i;
const RE_NAM_NAY = /n[ăa]m\s*(?:nay|n[àa]y|hi[ệe]n\s*t[ạa]i)/i;
const RE_NAM_TRUOC = /n[ăa]m\s*(?:ngo[áa]i|tr[ưu][ớoơ]c|r[ồo]i)/i;
const RE_TUAN_NAY = /tu[âầa]n\s*(?:n[àa]y|hi[ệe]n\s*t[ạa]i)/i;
const RE_TUAN_TRUOC = /tu[âầa]n\s*(?:tr[ưu][ớoơ]c|r[ồo]i|v[ừu]a\s*r[ồo]i)/i;
const RE_THANG_NAY = /th[áa]ng\s*(?:n[àa]y|hi[ệe]n\s*t[ạa]i)/i;
const RE_THANG_TRUOC = /th[áa]ng\s*(?:tr[ưu][ớoơ]c|r[ồo]i|v[ừu]a\s*r[ồo]i)/i;

/** Có một con số ngay trước chỗ khớp không ("12 tháng rồi"). */
const CO_SO_DUNG_TRUOC = /\d\s*$/;

interface MauKy {
  re: RegExp;
  /**
   * Điều kiện phụ nhìn phần văn bản NGAY TRƯỚC chỗ khớp. Trả `false` ⇒ bỏ chỗ
   * khớp này và tìm tiếp chỗ sau.
   */
  chan?: (truoc: string) => boolean;
  lay: (m: RegExpExecArray, ctx: CopilotRequestContext) => CopilotResolvedPeriod;
}

/**
 * Bảng mẫu, xếp theo ĐỘ HẸP giảm dần (chỉ dùng để phá hoà khi trùng vị trí).
 *
 * `RE_THANG_SO` đứng TRƯỚC mọi mẫu năm là có chủ ý: xem chú thích lỗi
 * "tháng 7 năm 2024" ở đầu mục này.
 */
const MAU_KY: readonly MauKy[] = [
  { re: RE_KHOANG_ISO, lay: (m) => kyKhoang(m[1], m[2]) },
  {
    re: RE_KHOANG_DMY,
    lay: (m, ctx) => {
      const namHienTai = Number(ctx.kyHienTai.split('-')[0]);
      const n1 = m[3] ? namDayDu(m[3]) : namHienTai;
      const n2 = m[6] ? namDayDu(m[6]) : n1;
      const [d1, m1, d2, m2] = [Number(m[1]), Number(m[2]), Number(m[4]), Number(m[5])];
      if (!ngayHopLe(n1, m1, d1) || !ngayHopLe(n2, m2, d2)) return null;
      return kyKhoang(`${n1}-${hai(m1)}-${hai(d1)}`, `${n2}-${hai(m2)}-${hai(d2)}`);
    },
  },
  {
    re: RE_N_THANG_QUA,
    lay: (m, ctx) => {
      const n = Number(m[1]);
      if (n < 1 || n > 36) return null;
      const dau = shiftYm(ctx.kyHienTai, -(n - 1));
      return {
        kind: 'range',
        // n = 1 thì khoảng đúng bằng một tháng — vẫn ép được vào tool chỉ nhận tháng.
        month: n === 1 ? ctx.kyHienTai : null,
        startDate: `${dau}-01`,
        endDate: ngayCuoiThang(ctx.kyHienTai),
        nhan: `${n} tháng gần nhất (${dau} → ${ctx.kyHienTai})`,
      };
    },
  },
  {
    re: RE_N_THANG_TRUOC,
    lay: (m, ctx) => {
      const n = Number(m[1]);
      return n >= 1 && n <= 36 ? kyThang(shiftYm(ctx.kyHienTai, -n)) : null;
    },
  },
  {
    re: RE_THANG_SO,
    lay: (m, ctx) => {
      const [namHienTai, thangHienTai] = ctx.kyHienTai.split('-').map(Number);
      const thang = Number(m[1]);
      if (thang < 1 || thang > 12) return null;
      const nam = m[2] ? Number(m[2]) : thang > thangHienTai ? namHienTai - 1 : namHienTai;
      return kyThang(`${nam}-${hai(thang)}`);
    },
  },
  {
    re: RE_QUY_NAY,
    lay: (_m, ctx) => {
      const [nam, thang] = ctx.kyHienTai.split('-').map(Number);
      return kyQuy(nam, quyCua(thang));
    },
  },
  {
    re: RE_QUY_TRUOC,
    lay: (_m, ctx) => {
      const [nam, thang] = ctx.kyHienTai.split('-').map(Number);
      const q = quyCua(thang);
      return q === 1 ? kyQuy(nam - 1, 4) : kyQuy(nam, q - 1);
    },
  },
  { re: RE_NAM_CU_THE, lay: (m) => kyNam(Number(m[1])) },
  { re: RE_NAM_NAY, lay: (_m, ctx) => kyNam(Number(ctx.kyHienTai.split('-')[0])) },
  { re: RE_NAM_TRUOC, lay: (_m, ctx) => kyNam(Number(ctx.kyHienTai.split('-')[0]) - 1) },
  { re: RE_TUAN_NAY, lay: (_m, ctx) => kyTuan(ctx.ngayHienTai, 0) },
  { re: RE_TUAN_TRUOC, lay: (_m, ctx) => kyTuan(ctx.ngayHienTai, -1) },
  { re: RE_THANG_NAY, lay: (_m, ctx) => kyThang(ctx.kyHienTai) },
  {
    re: RE_THANG_TRUOC,
    // "khách ở phòng 12 tháng rồi" KHÔNG phải "tháng trước" — đó là một THỜI
    // LƯỢNG. Đo 03/09/2026: câu đó ép mọi tool về kỳ tháng trước. Dùng hàm chặn
    // thay cho lookbehind vì lookbehind độ dài thay đổi vẫn vắng trên Safari cũ,
    // và một SyntaxError lúc nạp module thì giết cả bundle chứ không chỉ tính
    // năng này.
    chan: (truoc) => !CO_SO_DUNG_TRUOC.test(truoc),
    lay: (_m, ctx) => kyThang(shiftYm(ctx.kyHienTai, -1)),
  },
];

/** Chỗ khớp hợp lệ đầu tiên của một mẫu, từ vị trí `tu` trở đi. */
function khopDauTien(mau: MauKy, text: string, tu: number): RegExpExecArray | null {
  let batDau = tu;
  while (batDau <= text.length) {
    const m = mau.re.exec(text.slice(batDau));
    if (!m) return null;
    const viTri = batDau + m.index;
    if (!mau.chan || mau.chan(text.slice(0, viTri))) {
      // Trả về chỉ số theo TOÀN chuỗi, không theo lát cắt.
      const ra = m as RegExpExecArray;
      ra.index = viTri;
      return ra;
    }
    batDau = viTri + Math.max(1, m[0].length);
  }
  return null;
}

/**
 * MỌI kỳ được nhắc trong câu, theo thứ tự xuất hiện.
 *
 * Cụm khớp nhưng vô nghĩa ("tháng 13", "từ 31/02") bị tiêu thụ và bỏ qua chứ
 * không rơi xuống mẫu khác — nếu không, "tháng 13" sẽ trượt xuống mẫu "tháng"
 * chung và trả về một kỳ mà người dùng không hề nói tới.
 */
export function quetKyTrongCau(
  text: string,
  ctx: CopilotRequestContext,
): NonNullable<CopilotResolvedPeriod>[] {
  const ra: NonNullable<CopilotResolvedPeriod>[] = [];
  let i = 0;
  while (i < text.length) {
    let tot: { m: RegExpExecArray; mau: MauKy } | null = null;
    for (const mau of MAU_KY) {
      const m = khopDauTien(mau, text, i);
      if (!m) continue;
      if (!tot || m.index < tot.m.index) tot = { m, mau };
    }
    if (!tot) break;
    const ky = tot.mau.lay(tot.m, ctx);
    if (ky) ra.push(ky);
    i = tot.m.index + Math.max(1, tot.m[0].length);
  }
  return ra;
}

/** Số kỳ KHÁC NHAU trong câu (cùng một kỳ nhắc hai lần vẫn là một). */
export function soKyRiengBiet(ds: readonly NonNullable<CopilotResolvedPeriod>[]): number {
  return new Set(ds.map((k) => `${k.kind}|${k.startDate}|${k.endDate}`)).size;
}

/**
 * Kỳ suy ra từ câu người dùng, hoặc `null` khi câu không nêu kỳ nào.
 *
 * `null` nghĩa là "không có gì để ép", KHÔNG phải "dùng tháng này". Mặc định
 * ngầm về tháng hiện tại sẽ biến một câu hỏi mơ hồ thành một con số tự tin.
 *
 * "THÁNG N" KHÔNG KÈM NĂM THÌ NGHIÊNG VỀ QUÁ KHỨ. Hỏi "tháng 12" vào tháng 2
 * gần như luôn là tháng 12 NĂM NGOÁI; Copilot là bề mặt tra sổ, không phải lịch
 * hẹn. Nên N > tháng hiện tại ⇒ lấy năm trước. Chọn sai vẫn HIỆN RA chứ không
 * âm thầm: kỳ đã chốt được nói lại bằng `nhan` trong system prompt, và mọi ghi
 * đè tham số của mô hình đều báo qua `kyBiThayThe`.
 *
 * Câu nhắc NHIỀU kỳ thì hàm này chỉ trả kỳ ĐẦU TIÊN — người gọi phải hỏi thêm
 * `soKyRiengBiet` trước khi ép nó vào tham số tool.
 */
export function resolveRelativePeriod(
  text: string,
  ctx: CopilotRequestContext,
): CopilotResolvedPeriod {
  return quetKyTrongCau(text, ctx)[0] ?? null;
}

// ── Ép kỳ vào tham số tool ─────────────────────────────────────────────

/** Tên tham số kỳ mà một tool nhận. */
export interface ThamSoKyCuaTool {
  /** Tham số nhận "YYYY-MM". */
  ky?: string;
  /** Cặp tham số nhận "YYYY-MM-DD". Chỉ dùng khi có ĐỦ hai đầu. */
  tu?: string;
  den?: string;
}

/**
 * Tên tham số được coi là "kỳ" khi quét khai báo tool.
 *
 * Danh sách TÊN THAM SỐ, không phải danh sách TOOL — đó là điểm khác so với bản
 * trước. Bản trước là bảng viết tay đúng hai dòng (`doanh_thu_thang`,
 * `tim_hoa_don`); 35 tool thêm vào sau đó, trong đó rất nhiều tool có tham số
 * kỳ, không bao giờ được nối vào bộ chuẩn hoá. Hệ quả: "doanh thu tháng trước"
 * chạy đúng còn "dòng tiền tháng trước" thì không, và không có gì đỏ để ai biết.
 */
export const KHOA_THAM_SO_KY: readonly string[] = ['thang', 'ky'];
export const KHOA_THAM_SO_TU: readonly string[] = ['tu', 'tu_ngay'];
export const KHOA_THAM_SO_DEN: readonly string[] = ['den', 'den_ngay'];

/** Một khai báo tool kiểu OpenAI, rút gọn còn đúng phần bộ quét cần. */
export interface KhaiBaoCoThamSo {
  name: string;
  /** JSON Schema của input (`{ properties: { … } }`). */
  parameters?: unknown;
}

function tenThuocTinh(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== 'object') return [];
  const props = (parameters as { properties?: unknown }).properties;
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props as Record<string, unknown>);
}

/**
 * Quét khai báo tool → tool nào nhận kỳ, qua tham số tên gì.
 *
 * Hàm THUẦN, nhận khai báo qua tham số thay vì import registry: `nghiepVuTools`
 * đã import file này (`ngayCuoiThang`), nên chiều ngược lại là một vòng import.
 */
export function quetThamSoKy(
  khaiBao: readonly KhaiBaoCoThamSo[],
): Record<string, ThamSoKyCuaTool> {
  const ra: Record<string, ThamSoKyCuaTool> = {};
  for (const t of khaiBao) {
    const ten = tenThuocTinh(t.parameters);
    const muc: ThamSoKyCuaTool = {};
    const ky = KHOA_THAM_SO_KY.find((k) => ten.includes(k));
    if (ky) muc.ky = ky;
    const tu = KHOA_THAM_SO_TU.find((k) => ten.includes(k));
    const den = KHOA_THAM_SO_DEN.find((k) => ten.includes(k));
    if (tu && den) {
      muc.tu = tu;
      muc.den = den;
    }
    if (muc.ky || muc.tu) ra[t.name] = muc;
  }
  return ra;
}

export interface KetQuaApKy {
  args: Record<string, unknown>;
  /** Kỳ mô hình tự điền, khi nó khác kỳ chuẩn hoá. */
  kyBiThayThe: string | null;
  /**
   * Câu giải thích khi bộ chuẩn hoá CỐ Ý không ép gì — hôm nay chỉ có một lý
   * do: câu hỏi nhắc nhiều kỳ. Người gọi phải kể lại nó trong kết quả tool.
   */
  ghiChu: string | null;
}

/**
 * Ép kỳ đã chuẩn hoá vào tham số tool.
 *
 * Mô hình điền kỳ KHÁC ⇒ ghi đè và trả `kyBiThayThe` để người gọi nói rõ trong
 * kết quả tool. Im lặng sửa số của mô hình rồi trả lời như không có gì xảy ra
 * là cách nhanh nhất để không ai phát hiện bộ chuẩn hoá này hỏng.
 *
 * KỲ NHIỀU THÁNG (quý/năm/tuần/khoảng) chỉ ép được vào tool có ĐỦ cặp
 * `tu`/`den`. Tool chỉ nhận một tháng thì để NGUYÊN tham số mô hình chọn: nhét
 * tháng đầu quý vào đó sẽ trả về một phần ba dữ liệu dưới nhãn "quý này".
 */
export function apDungKyTuongDoi(
  tenTool: string,
  args: Record<string, unknown>,
  ky: CopilotResolvedPeriod,
  banDo: Record<string, ThamSoKyCuaTool>,
  nhieuKy = false,
): KetQuaApKy {
  const muc = banDo[tenTool];
  if (!muc || !ky) return { args, kyBiThayThe: null, ghiChu: null };

  const daCoChuoi = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const GHI_CHU_NHIEU_KY =
    `Câu hỏi nhắc nhiều kỳ — hệ thống KHÔNG ép kỳ nào, giữ nguyên tham số của mô hình. ` +
    `Kỳ đầu tiên nhận ra là ${ky.nhan}.`;

  if (ky.month && muc.ky) {
    const cu = args[muc.ky];
    // NHIỀU KỲ TRONG MỘT CÂU thì kỳ đầu tiên KHÔNG đại diện cho cả lượt.
    // "so sánh doanh thu tháng 6 và tháng 7" gọi `doanh_thu_thang` hai lần với
    // hai tham số khác nhau; ép cả hai về 2026-06 cho ra một bảng so sánh mà
    // hai cột bằng nhau — sai, mà trông y hệt dữ liệu thật. Chỉ LẤP chỗ mô
    // hình bỏ trống, không bao giờ ghi đè.
    //
    // Kiểm TRƯỚC nhánh "trùng kỳ rồi": ghi chú phải đi kèm MỌI lần gọi mà mô
    // hình tự chọn kỳ, kể cả lần tình cờ trùng kỳ đầu — nếu không, một nửa số
    // dòng kết quả có lời giải thích còn nửa kia không, và người đọc kết luận
    // hai lần gọi được xử lý khác nhau.
    if (nhieuKy && daCoChuoi(cu)) return { args, kyBiThayThe: null, ghiChu: GHI_CHU_NHIEU_KY };
    if (cu === ky.month) return { args, kyBiThayThe: null, ghiChu: null };
    return {
      args: { ...args, [muc.ky]: ky.month },
      kyBiThayThe: nhieuKy ? null : daCoChuoi(cu) ? cu : null,
      ghiChu: nhieuKy ? GHI_CHU_NHIEU_KY : null,
    };
  }

  if (muc.tu && muc.den) {
    const cuTu = args[muc.tu];
    const cuDen = args[muc.den];
    if (nhieuKy && (daCoChuoi(cuTu) || daCoChuoi(cuDen))) {
      return { args, kyBiThayThe: null, ghiChu: GHI_CHU_NHIEU_KY };
    }
    if (cuTu === ky.startDate && cuDen === ky.endDate) {
      return { args, kyBiThayThe: null, ghiChu: null };
    }
    // Tham số THÁNG còn sót lại sẽ THẮNG khoảng ở phía tool (`khoangKy` ưu tiên
    // `ky`), nên với kỳ nhiều tháng phải dọn nó đi — không thì "quý này" lặng lẽ
    // co lại còn một tháng.
    const moi: Record<string, unknown> = { ...args, [muc.tu]: ky.startDate, [muc.den]: ky.endDate };
    if (muc.ky && !ky.month) delete moi[muc.ky];
    const cu = [cuTu, cuDen].filter(daCoChuoi);
    return {
      args: moi,
      kyBiThayThe: nhieuKy ? null : cu.length ? cu.join(' → ') : null,
      ghiChu: nhieuKy ? GHI_CHU_NHIEU_KY : null,
    };
  }

  return { args, kyBiThayThe: null, ghiChu: null };
}
