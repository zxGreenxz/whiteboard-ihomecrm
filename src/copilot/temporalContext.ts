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
// THỨ TỰ LÀ MỘT PHẦN CỦA LUẬT. "3 tháng trước" chứa nguyên cụm "tháng trước";
// nếu mẫu chung chạy trước thì một câu hỏi về tháng 5 sẽ lặng lẽ trả về tháng 7.
// Mẫu nào HẸP HƠN phải đứng trước mẫu bao nó.
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
const RE_QUY_NAY = /qu[ýy]\s*(?:n[àa]y|hi[ệe]n\s*t[ạa]i)/i;
const RE_QUY_TRUOC = /qu[ýy]\s*(?:tr[ưu][ớoơ]c|r[ồo]i|v[ừu]a\s*r[ồo]i)/i;
const RE_NAM_CU_THE = /n[ăa]m\s*(20\d{2})\b/i;
const RE_NAM_NAY = /n[ăa]m\s*(?:nay|n[àa]y|hi[ệe]n\s*t[ạa]i)/i;
const RE_NAM_TRUOC = /n[ăa]m\s*(?:ngo[áa]i|tr[ưu][ớoơ]c|r[ồo]i)/i;
const RE_TUAN_NAY = /tu[âầa]n\s*(?:n[àa]y|hi[ệe]n\s*t[ạa]i)/i;
const RE_TUAN_TRUOC = /tu[âầa]n\s*(?:tr[ưu][ớoơ]c|r[ồo]i|v[ừu]a\s*r[ồo]i)/i;
const RE_THANG_SO = /th[áa]ng\s*(\d{1,2})(?:\s*[/\-]\s*(20\d{2}))?/i;
const RE_THANG_NAY = /th[áa]ng\s*(?:n[àa]y|hi[ệe]n\s*t[ạa]i)/i;
const RE_THANG_TRUOC = /th[áa]ng\s*(?:tr[ưu][ớoơ]c|r[ồo]i|v[ừu]a\s*r[ồo]i)/i;

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
 */
export function resolveRelativePeriod(
  text: string,
  ctx: CopilotRequestContext,
): CopilotResolvedPeriod {
  const [namHienTai, thangHienTai] = ctx.kyHienTai.split('-').map(Number);

  const iso = RE_KHOANG_ISO.exec(text);
  if (iso) return kyKhoang(iso[1], iso[2]);

  const dmy = RE_KHOANG_DMY.exec(text);
  if (dmy) {
    const n1 = dmy[3] ? namDayDu(dmy[3]) : namHienTai;
    const n2 = dmy[6] ? namDayDu(dmy[6]) : n1;
    const d1 = Number(dmy[1]);
    const m1 = Number(dmy[2]);
    const d2 = Number(dmy[4]);
    const m2 = Number(dmy[5]);
    if (ngayHopLe(n1, m1, d1) && ngayHopLe(n2, m2, d2)) {
      return kyKhoang(`${n1}-${hai(m1)}-${hai(d1)}`, `${n2}-${hai(m2)}-${hai(d2)}`);
    }
  }

  const nQua = RE_N_THANG_QUA.exec(text);
  if (nQua) {
    const n = Number(nQua[1]);
    if (n >= 1 && n <= 36) {
      const dau = shiftYm(ctx.kyHienTai, -(n - 1));
      return {
        kind: 'range',
        // n = 1 thì khoảng đúng bằng một tháng — vẫn ép được vào tool chỉ nhận tháng.
        month: n === 1 ? ctx.kyHienTai : null,
        startDate: `${dau}-01`,
        endDate: ngayCuoiThang(ctx.kyHienTai),
        nhan: `${n} tháng gần nhất (${dau} → ${ctx.kyHienTai})`,
      };
    }
  }

  const nTruoc = RE_N_THANG_TRUOC.exec(text);
  if (nTruoc) {
    const n = Number(nTruoc[1]);
    if (n >= 1 && n <= 36) return kyThang(shiftYm(ctx.kyHienTai, -n));
  }

  if (RE_QUY_NAY.test(text)) return kyQuy(namHienTai, quyCua(thangHienTai));
  if (RE_QUY_TRUOC.test(text)) {
    const q = quyCua(thangHienTai);
    return q === 1 ? kyQuy(namHienTai - 1, 4) : kyQuy(namHienTai, q - 1);
  }

  const namCuThe = RE_NAM_CU_THE.exec(text);
  if (namCuThe) return kyNam(Number(namCuThe[1]));
  if (RE_NAM_NAY.test(text)) return kyNam(namHienTai);
  if (RE_NAM_TRUOC.test(text)) return kyNam(namHienTai - 1);

  if (RE_TUAN_NAY.test(text)) return kyTuan(ctx.ngayHienTai, 0);
  if (RE_TUAN_TRUOC.test(text)) return kyTuan(ctx.ngayHienTai, -1);

  const thangSo = RE_THANG_SO.exec(text);
  if (thangSo) {
    const m = Number(thangSo[1]);
    if (m >= 1 && m <= 12) {
      const nam = thangSo[2] ? Number(thangSo[2]) : m > thangHienTai ? namHienTai - 1 : namHienTai;
      return kyThang(`${nam}-${hai(m)}`);
    }
  }

  if (RE_THANG_NAY.test(text)) return kyThang(ctx.kyHienTai);
  if (RE_THANG_TRUOC.test(text)) return kyThang(shiftYm(ctx.kyHienTai, -1));

  return null;
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
): KetQuaApKy {
  const muc = banDo[tenTool];
  if (!muc || !ky) return { args, kyBiThayThe: null };

  if (ky.month && muc.ky) {
    const cu = args[muc.ky];
    if (cu === ky.month) return { args, kyBiThayThe: null };
    return {
      args: { ...args, [muc.ky]: ky.month },
      kyBiThayThe: typeof cu === 'string' && cu ? cu : null,
    };
  }

  if (muc.tu && muc.den) {
    const cuTu = args[muc.tu];
    const cuDen = args[muc.den];
    if (cuTu === ky.startDate && cuDen === ky.endDate) return { args, kyBiThayThe: null };
    // Tham số THÁNG còn sót lại sẽ THẮNG khoảng ở phía tool (`khoangKy` ưu tiên
    // `ky`), nên với kỳ nhiều tháng phải dọn nó đi — không thì "quý này" lặng lẽ
    // co lại còn một tháng.
    const moi: Record<string, unknown> = { ...args, [muc.tu]: ky.startDate, [muc.den]: ky.endDate };
    if (muc.ky && !ky.month) delete moi[muc.ky];
    const cu = [cuTu, cuDen].filter((v): v is string => typeof v === 'string' && v.length > 0);
    return { args: moi, kyBiThayThe: cu.length ? cu.join(' → ') : null };
  }

  return { args, kyBiThayThe: null };
}
