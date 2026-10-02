// Hàm máy chủ của trang "Báo chi nhanh" (/chi-tieu). Tách khỏi llm-proxy để Copilot không đổi một byte.
//
//   POST …/quick-entry/audio/transcriptions  { format, data (base64), language? }  ⇒ { text }
//   POST …/quick-entry/chat/completions      { messages, max_tokens? } (OpenAI)  ⇒ phản hồi OpenAI
//                                             + header x-quick-entry-model / -index / -attempts
//
// Chủ chốt 01/10/2026: CHÉP GIỌNG qua OpenRouter (khoá riêng `QUICK_ENTRY_OPENROUTER_KEY`), ĐỌC chữ/ảnh
// qua 9router (`QUICK_ENTRY_NINEROUTER_BASE_URL/_KEY`, thiếu thì dùng NINEROUTER_* của Copilot). Mỗi
// đường đi theo CHUỖI mô hình: lỗi tạm thời (mạng, hết giờ, 408/409/425/429/5xx, mô hình không có) ⇒
// thử mô hình kế; lỗi thuộc tài khoản (401/402) thì mô hình nào cũng hỏng nên dừng ngay. Thiếu cấu
// hình của đường nào thì CHỈ đường đó tắt.
//
// Cụm từ ưu tiên: chép giọng bằng google/chirp-3 thì gửi kèm mã/tên toà, tên thường gọi của toà, tên phòng
// và tên hạng mục chi mà trang dò được cho NGƯỜI DÙNG (đọc bằng JWT của họ) — xem docCumTu, dungCumTu.
//
// KHÔNG cần migration:
//   - quyền   = get_my_permissions_v2(p_org) gọi bằng JWT của chính người dùng — cùng nguồn giao diện đọc;
//               cần income_expenses.create HOẶC personal_finance.create ở công ty đang chọn;
//   - sổ phí  = ai_usage_logs, feature 'quick_entry', mỗi lần gọi mô hình một dòng (service role);
//   - trần    = số LƯỢT (task) trong ngày giờ VN đếm trên chính bảng đó (QUICK_ENTRY_DAILY_CALLS),
//               đếm SAU khi giữ chỗ bằng một dòng 'pending' (gọi song song không cùng lọt trần);
//   - công tắc = QUICK_ENTRY_MODE: off (mặc định) | pilot (chỉ người có Copilot) | all.
// Dòng sổ phí này cũng nằm trong tổng token/USD/ngày mà reserve_ai_usage của Copilot cộng theo người
// dùng (hàm đó không lọc feature) — người dùng nhiều Báo chi nhanh có thể chạm trần Copilot sớm hơn.
//
// Không lưu, không ghi log nội dung âm thanh hay chữ của người dùng.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-copilot-feature, x-task-id, x-organization-id, x-quick-entry-skip",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-quick-entry-model, x-quick-entry-index, x-quick-entry-attempts, x-quick-entry-hints",
};

/** Xếp hạng chép giọng tiếng Việt (đo 01/10/2026: 16 câu báo chi × 2 giọng × sạch/ồn SNR 10 dB, chấm bằng
 *  bộ đọc số tiền của trang): chirp-3 64/64 > nova-3 62 = whisper-1 62 > gemini-3.5-transcribe 60 >
 *  whisper-large-v3 59. gpt-4o-transcribe đúng 32/32 khi sạch nhưng 0/32 khi ồn — BỊA câu tiếng khác dù
 *  language=vi và vẫn trả 200 (chuỗi không dự phòng được) ⇒ không nằm trong danh sách cho chọn. */
export const STT_CHOICES = [
  "google/chirp-3",
  "deepgram/nova-3",
  "openai/whisper-1",
  "google/gemini-3.5-transcribe",
  "openai/whisper-large-v3",
];
export const STT_MODELS_MAC_DINH = ["google/chirp-3", "deepgram/nova-3", "openai/whisper-1"];
/** Mô hình ĐỌC người dùng được chọn trên trang (9router) + mức suy nghĩ (hậu tố "(mức)"; rỗng = tự
 *  động). Đo 01/10/2026 bằng prompt thật: mọi tổ hợp đọc đúng tiền 3/3; Astra không nhận "minimal" (400);
 *  mức cao chậm (Sol/Astra max ~15–17 s một câu ngắn). */
export const READ_MODEL_CHOICES = ["cx/gpt-6.1-sol", "cx/gpt-6-astra", "cx/gpt-6-sol", "cx/gpt-6-luna", "cx/gpt-5.6-luna"];
export const READ_EFFORTS = ["", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const READ_UNSUPPORTED = ["cx/gpt-6-astra(minimal)"];
/** 9router, đo 01/10/2026 bằng prompt thật: cx/gpt-6-luna(low) đọc đúng chữ + bill có giảm giá, ~5 s.
 *  ag/* trả nội dung RỖNG với khuôn JSON nên không đưa vào chuỗi. */
export const READ_MODELS_MAC_DINH = ["cx/gpt-6-luna(low)", "cx/gpt-5.6-luna(low)"];
export const LUOT_NGAY_MAC_DINH = 150;
/** Âm thanh tối đa (560 KB) hoặc ảnh bill đã nén (≤360 KB) sau base64 + JSON vẫn dưới trần này. */
export const TRAN_BODY_BYTES = 768 * 1024;
/** Byte âm thanh THÔ. Client gợi ý 48 kbps (30 giây ≈ 180 KB) nhưng trình duyệt được phép bỏ qua gợi ý:
 *  30 giây ở 128 kbps = 480 KB + vỏ mp4 vẫn phải lọt. Client dùng đúng số này (MAX_AUDIO_BYTES). */
export const TRAN_AM_THANH_BYTES = 560_000;
/** Trần token trả lời. Mức suy nghĩ cao (xhigh/max/ultra) tính cả token suy nghĩ vào đây — 1500 có thể
 *  cạn trước khi ra JSON (trả rỗng ⇒ rơi sang dự phòng). 9router tính theo thuê bao nên trần cao không tốn. */
export const TRAN_MAX_TOKENS = 4000;
/** Tổng ký tự chữ gửi AI đọc. Prompt thật tối đa ~18k (150 hạng mục + mã toà + câu người dùng) — trần
 *  này chặn việc dùng hàm làm proxy LLM đa dụng với prompt tuỳ ý. */
export const TRAN_CHU_KY_TU = 32_000;
/** Trần MỘT lần thử: đường đọc rộng hơn vì người dùng có thể chọn mức suy nghĩ cao + ảnh bill. */
export const MOI_LAN_MS: Record<"stt" | "read", number> = { stt: 25_000, read: 35_000 };
/** Ngân sách cả lượt theo đường — chừa ≥10 s dưới thời gian client chờ (chép giọng 45 s, đọc 60 s) cho
 *  tải lên, kiểm quyền, giữ chỗ và ghi sổ; vượt thì client bỏ mà lượt vẫn bị tính. */
export const NGAN_SACH_MS: Record<"stt" | "read", number> = { stt: 35_000, read: 50_000 };
const TOI_THIEU_MS = 3_000;

/** Thời gian cho lần thử kế: kẹp theo ngân sách còn lại; còn dưới mức tối thiểu ⇒ 0 (không thử nữa). */
export function thoiGianLanThu(nganSach: number, daQua: number, moiLan = MOI_LAN_MS.stt): number {
  const con = nganSach - daQua;
  return con >= TOI_THIEU_MS ? Math.min(moiLan, con) : 0;
}

/**
 * Mô hình người dùng chọn trên trang — CHỈ nhận id trong danh sách cho phép của đường đó (không thì ai có
 * JWT cũng gọi được mô hình tuỳ ý bằng khoá của công ty). Ngoài danh sách ⇒ null (dùng chuỗi mặc định).
 */
export function moHinhDuocChon(route: "stt" | "read", raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (route === "stt") return STT_CHOICES.includes(raw) ? raw : null;
  const m = /^([^()]+)(?:\(([a-z]+)\))?$/.exec(raw);
  if (!m) return null;
  const [, base, muc = ""] = m;
  if (!READ_MODEL_CHOICES.includes(base) || !READ_EFFORTS.includes(muc)) return null;
  return READ_UNSUPPORTED.includes(raw) ? null : raw;
}
export const OPENROUTER = "https://openrouter.ai/api/v1";

/** Định dạng client gửi ⇒ định dạng OpenRouter nhận (iPhone ghi ra mp4 = AAC, OpenRouter gọi là m4a). */
export const DINH_DANG_AM_THANH: Record<string, string> = {
  webm: "webm",
  ogg: "ogg",
  wav: "wav",
  mp3: "mp3",
  m4a: "m4a",
  mp4: "m4a",
  aac: "aac",
};

// ---------------------------------------------------------------------------------------------------
// Cụm từ ưu tiên cho máy chép giọng (Google speech adaptation).
//
// Đo 02/10/2026 qua OpenRouter (hàm thăm dò tạm trên project TEST, khoá QUICK_ENTRY_OPENROUTER_KEY):
//   - OpenRouter CHỈ chuyển tiếp `provider.options["google-vertex"].config` vào RecognitionConfig của Google;
//     `adaptation` đặt thẳng trong options, khoá "google", dạng snake_case và `prompt` đều bị bỏ im lặng
//     (giá trị sai vẫn trả 200). Dạng đúng: config.adaptation.phraseSets[].inlinePhraseSet.phrases[].value.
//   - 1.000 cụm ⇒ 200, 1.001 cụm ⇒ 400 (tài liệu Google ghi 1.200 — sai với đường này).
//   - Tác dụng (giọng máy, 5 câu): "1392 cute" ⇒ "1392QT", "bắn form … 80 DS3" ⇒ "bắn foam … 80DS3",
//     "Madrid"/"Berlin" ⇒ đúng tên phòng; boost 10/20 ra y hệt không boost ⇒ không gửi boost.
// Chỉ chirp-3 nhận (nova-3/whisper không có đường này) — mô hình khác gửi đúng payload cũ.

export const MO_HINH_CUM_TU = "google/chirp-3";
/** Dưới trần 1.000 đo được của Google — chừa chỗ, và quá trần là cả lượt chép bị từ chối. */
export const TRAN_CUM_TU = 900;
/** Trần độ dài một cụm của Google speech adaptation. */
export const TRAN_KY_TU_CUM = 100;
/** Đọc nguồn cụm từ không được kéo dài lượt chép giọng: quá hạn thì chép không có gợi ý. */
const HAN_DOC_CUM_TU_MS = 3_000;

export interface NguonCumTu {
  buildings: Array<{ id?: unknown; name?: unknown; code?: unknown }>;
  /** Bảng building_common_names: tên thường gọi của toà ("Lê Văn Thọ", "một lẻ hai Lê Văn Thọ"). */
  commonNames: Array<{ building_id?: unknown; name?: unknown }>;
  rooms: Array<{ name?: unknown }>;
  categories: Array<{ name?: unknown }>;
}

/** Từ chỉ số khi ĐỌC số nhà — giữ dấu, vì "Bà" trong "Hai Bà Trưng" không phải số. */
const TU_SO = new Set([
  "không", "một", "mốt", "hai", "ba", "bốn", "tư", "năm", "lăm", "nhăm", "sáu", "bảy", "tám", "chín",
  "mười", "mươi", "trăm", "nghìn", "ngàn", "lẻ", "linh",
]);

/**
 * Tên mở đầu bằng cách ĐỌC một số ("một lẻ hai Lê Văn Thọ", "mười lăm KV") = từ hai từ chỉ số liền nhau.
 * Một từ chỉ số đứng đầu là tên đường bình thường: "Hai Bà Trưng", "Ba Tháng Hai", "Nam Kỳ Khởi Nghĩa".
 */
function moDauBangSoDoc(ten: string): boolean {
  const tu = ten.toLowerCase().split(" ");
  let n = 0;
  while (n < tu.length && TU_SO.has(tu[n])) n += 1;
  return n >= 2;
}

/** Chuẩn một cụm: NFC, gộp khoảng trắng, bỏ ký tự điều khiển; ngoài 2…100 ký tự ⇒ null. */
export function chuanCum(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length >= 2 && s.length <= TRAN_KY_TU_CUM ? s : null;
}

/** Bí danh trong `buildings.code` (cách nhau dấu phẩy) có chữ cái; "1392qt" ⇒ "1392QT" (dạng mã in hoa). */
function maToa(code: unknown): string[] {
  if (typeof code !== "string") return [];
  return code
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s))
    .map((s) => (/^\d+[a-z][a-z0-9]*$/i.test(s) ? s.toUpperCase() : s));
}

/** Số nhà của toà lấy từ mã/tên ("102LVT", "45/3 Trần Thái Tông", "111") — để ghép "102 Lê Văn Thọ". */
function soNha(b: NguonCumTu["buildings"][number]): string[] {
  const out = new Set<string>();
  const nguon = [...(typeof b.code === "string" ? b.code.split(",") : []), typeof b.name === "string" ? b.name : ""];
  for (const s of nguon) {
    const m = /^\s*(?:toà|tòa|toa|nhà|nha)?\s*([1-9]\d{0,3})(?!\d)/i.exec(s);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * Danh sách cụm từ ưu tiên, theo thứ tự quan trọng: mã + tên toà, tên thường gọi (kèm "số nhà + tên" khi
 * tên chưa có số), hạng mục chi, phòng. Bỏ trùng không phân biệt hoa/thường; cắt ở TRAN_CUM_TU.
 * Thuần — nguồn thiếu/sai kiểu thì bỏ qua phần đó.
 */
export function dungCumTu(src: NguonCumTu): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const them = (raw: unknown) => {
    const c = chuanCum(raw);
    if (!c || out.length >= TRAN_CUM_TU) return;
    const key = c.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  const soCuaToa = new Map<string, string[]>();
  for (const b of src.buildings) {
    for (const m of maToa(b.code)) them(m);
    if (typeof b.name === "string" && /\p{L}/u.test(b.name)) them(b.name);
    if (typeof b.id === "string") soCuaToa.set(b.id, soNha(b));
  }
  // Đọc được danh sách toà ⇒ chỉ lấy tên của toà trong đó (toà còn sống, dùng được trên trang). Không đọc
  // được (lỗi/quá hạn) ⇒ vẫn gửi tên thường gọi (RLS đã lọc theo quyền xem), chỉ thiếu cụm ghép số nhà.
  const coDsToa = soCuaToa.size > 0;
  for (const n of src.commonNames) {
    const so = soCuaToa.get(String(n.building_id));
    const ten = chuanCum(n.name);
    if (!ten || (coDsToa && !so)) continue;
    them(ten);
    // "Lê Văn Thọ" của toà 102LVT ⇒ thêm "102 Lê Văn Thọ"; tên đã mở đầu bằng số (chữ số hay lời đọc) thì thôi.
    if (/^\d/.test(ten) || moDauBangSoDoc(ten)) continue;
    for (const s of so ?? []) them(`${s} ${ten}`);
  }
  for (const c of src.categories) them(c.name);
  for (const r of src.rooms) {
    const ten = typeof r.name === "string" ? r.name.trim() : "";
    if (!ten) continue;
    // "P204" đã là cách gọi phòng; "301", "MADRID 3" ⇒ "phòng 301", "phòng MADRID 3".
    them(/^(p|ph|phòng)\s*\d/i.test(ten) ? ten : `phòng ${ten}`);
  }
  return out;
}

/**
 * Đọc nguồn cụm từ bằng JWT CỦA NGƯỜI DÙNG, theo những gì trang Báo chi nhanh dò được:
 *   - toà = RPC ie_form_buildings (cùng nguồn ô chọn của trang — gồm toà quản lý VÀ toà được chi nhờ
 *     income_expenses.all_buildings; đã bỏ toà xoá mềm). RPC không trả cột công ty nên không lọc được theo
 *     công ty — y như trang;
 *   - phòng = bảng rooms qua RLS, lọc công ty. KHÔNG dùng ie_form_rooms: đo trên TEST 02/10/2026 RPC đó mất
 *     1,9–2,8 s (kiểm quyền từng dòng) — sát hạn 3 s — còn bảng ~0,16 s. Đổi lại người được chi mọi toà mà chỉ
 *     quản lý vài toà thì thiếu phòng của toà còn lại (joey: 103/286 phòng);
 *   - tên thường gọi (RLS can_access_building), hạng mục chi (bỏ system_only; bỏ hạng mục hạn chế khi người
 *     dùng thiếu restricted_create — như categorySuggest.ts): lọc đúng công ty đang chọn.
 * Mỗi nguồn lỗi (mạng, quá 3 s, bảng chưa có) ⇒ nguồn đó rỗng, các nguồn khác vẫn dùng; gợi ý không bao giờ
 * chặn chép giọng. Trần dòng của PostgREST (mặc định 1.000) đủ cho dữ liệu hiện tại (~300 phòng, ~90 hạng mục).
 */
export async function docCumTu(
  f: typeof fetch,
  supabaseUrl: string,
  apikey: string,
  token: string,
  org: string,
  opts: { boHanChe: boolean },
): Promise<string[]> {
  const headers = { Authorization: `Bearer ${token}`, apikey, "Accept-Profile": "public", "Content-Profile": "public", "Content-Type": "application/json" };
  const doc = async (path: string, rpc = false): Promise<Array<Record<string, unknown>>> => {
    try {
      const r = await f(`${supabaseUrl}/rest/v1/${path}`, {
        method: rpc ? "POST" : "GET",
        headers,
        body: rpc ? "{}" : undefined,
        signal: AbortSignal.timeout(HAN_DOC_CUM_TU_MS),
      });
      if (!r.ok) return [];
      const rows = (await r.json()) as unknown;
      return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  };
  const [buildings, commonNames, rooms, categories] = await Promise.all([
    doc(`rpc/ie_form_buildings?select=id,name,code&order=name`, true),
    doc(`building_common_names?select=building_id,name&organization_id=eq.${org}&order=created_at`),
    doc(`rooms?select=name&organization_id=eq.${org}&deleted_at=is.null&order=name`),
    doc(
      `income_expense_types?select=name&organization_id=eq.${org}&type=eq.expense&system_only=is.false` +
        `${opts.boHanChe ? "&is_restricted=is.false" : ""}&order=name`,
    ),
  ]);
  return dungCumTu({ buildings, commonNames, rooms, categories });
}

/** Phần payload gửi cụm từ cho Google qua OpenRouter (chỉ dạng này được chuyển tiếp — xem đo đạc ở trên). */
export function goiYGoogle(cumTu: readonly string[]): Record<string, unknown> {
  return {
    provider: {
      options: {
        "google-vertex": {
          config: { adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: cumTu.map((value) => ({ value })) } }] } },
        },
      },
    },
  };
}

type Route = "stt" | "read";
type Perms = Record<string, unknown> | null;

export interface PhuThuoc {
  getEnv?: (key: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  newId?: () => string;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", ...extra } });

/** Mã lỗi khớp `classifyAiError` của client (src/lib/quickEntry/errors.ts). */
const loi = (status: number, code: string, message: string) => json(status, { error: { code, message } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function docOrganizationId(headers: Headers): string | null {
  const raw = (headers.get("x-organization-id") ?? "").trim().toLowerCase();
  return UUID_RE.test(raw) ? raw : null;
}

const dsChuoi = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * "Có quyền này ở đâu đó trong công ty không" — chép đúng `canUse(perms, module, action)` không truyền toà
 * của giao diện (src/lib/permissionPages.ts): sentinel __superadmin; boolean (v1); object (v2) = org_wide
 * hoặc có ít nhất một toà/sổ; vắng khoá = không có quyền.
 */
export function coQuyen(perms: Perms, module: string, action: string): boolean {
  if (!perms || typeof perms !== "object") return false;
  if (perms.__superadmin) return true;
  const mod = perms[module];
  const raw = mod && typeof mod === "object" ? (mod as Record<string, unknown>)[action] : undefined;
  if (typeof raw === "boolean") return raw;
  if (!raw || typeof raw !== "object") return false;
  const scope = raw as { org_wide?: unknown; building_ids?: unknown; cashbook_ids?: unknown };
  if (scope.org_wide === true) return true;
  return dsChuoi(scope.building_ids).length > 0 || dsChuoi(scope.cashbook_ids).length > 0;
}

/** 00:00 hôm nay theo giờ Việt Nam (UTC+7), dạng ISO UTC. */
export function dauNgayVN(nowMs: number): string {
  const vn = nowMs + 7 * 3600_000;
  const midnightVn = vn - (vn % 86_400_000);
  return new Date(midnightVn - 7 * 3600_000).toISOString();
}

export function chuoiMoHinh(raw: string | undefined, macDinh: string[]): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:()-]+$/.test(s));
  return list.length ? [...new Set(list)].slice(0, 5) : macDinh;
}

/**
 * Lỗi upstream nào đáng thử mô hình kế. 401/402 KHÔNG có trong danh sách: đó là chuyện của khoá/tài
 * khoản (sai khoá, hết tiền) ⇒ mô hình nào cũng hỏng, thử tiếp chỉ đốt thời gian người dùng.
 */
export function nenThuMoHinhKe(status: number): boolean {
  return status === 0 || status === 400 || status === 403 || status === 404 || status === 408 || status === 409 ||
    status === 425 || status === 429 || status >= 500;
}

interface KetQuaGoi {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  cost: number;
  tokens: { prompt: number; completion: number; total: number };
}

const so = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

async function goiNhaCungCap(
  f: typeof fetch,
  base: string,
  key: string,
  path: string,
  payload: unknown,
  timeoutMs: number,
): Promise<KetQuaGoi> {
  let res: Response;
  try {
    res = await f(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: 0, body: null, cost: 0, tokens: { prompt: 0, completion: 0, total: 0 } };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const usage = (body?.usage ?? {}) as Record<string, unknown>;
  const prompt = so(usage.prompt_tokens ?? usage.input_tokens);
  const completion = so(usage.completion_tokens ?? usage.output_tokens);
  return {
    ok: res.ok,
    status: res.status,
    body,
    cost: so(usage.cost),
    tokens: { prompt, completion, total: so(usage.total_tokens) || prompt + completion },
  };
}

// ---------------------------------------------------------------------------------------------------
// Kiểm đầu vào từng route. Chỉ chuyển tiếp những khoá cần — khoá lạ của client không tới upstream.

type DauVao =
  | { ok: true; payload: (model: string, cumTu?: readonly string[]) => Record<string, unknown> }
  | { ok: false; res: Response };

export function dauVaoNhanGiong(body: Record<string, unknown>): DauVao {
  const fmt = DINH_DANG_AM_THANH[String(body.format ?? "").toLowerCase()];
  if (!fmt) return { ok: false, res: loi(400, "bad_request", "Định dạng âm thanh không hỗ trợ.") };
  const data = body.data;
  if (typeof data !== "string" || data.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(data)) {
    return { ok: false, res: loi(400, "bad_request", "Âm thanh phải là base64.") };
  }
  // Byte thô = 3/4 độ dài base64 trừ ký tự đệm "=" (không trừ thì bản ghi đúng trần bị báo quá dài).
  const dem = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (Math.floor((data.length * 3) / 4) - dem > TRAN_AM_THANH_BYTES) {
    return { ok: false, res: loi(413, "payload_too_large", "Đoạn ghi âm quá dài.") };
  }
  const lang = typeof body.language === "string" && /^[a-z]{2}$/.test(body.language) ? body.language : "vi";
  return {
    ok: true,
    payload: (model, cumTu = []) => ({
      model,
      language: lang,
      input_audio: { data, format: fmt },
      // Người gọi (vòng thử mô hình trong xuLy) chỉ truyền cụm từ cho chirp-3.
      ...(cumTu.length > 0 ? goiYGoogle(cumTu) : {}),
    }),
  };
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export function dauVaoDocChu(body: Record<string, unknown>): DauVao {
  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) {
    return { ok: false, res: loi(400, "bad_request", "messages không hợp lệ.") };
  }
  let anh = 0;
  const messages: Array<{ role: "system" | "user"; content: string | Part[] }> = [];
  for (const m of raw) {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if (role !== "system" && role !== "user") return { ok: false, res: loi(400, "bad_request", "Vai tin nhắn không hợp lệ.") };
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) return { ok: false, res: loi(400, "bad_request", "Nội dung tin nhắn không hợp lệ.") };
    const parts: Part[] = [];
    for (const p of content) {
      const t = (p as { type?: unknown })?.type;
      if (t === "text" && typeof (p as { text?: unknown }).text === "string") {
        parts.push({ type: "text", text: (p as { text: string }).text });
      } else if (t === "image_url") {
        const url = (p as { image_url?: { url?: unknown } }).image_url?.url;
        if (typeof url !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/.test(url)) {
          return { ok: false, res: loi(400, "bad_request", "Ảnh phải là data URL png/jpeg/webp.") };
        }
        anh += 1;
        parts.push({ type: "image_url", image_url: { url } });
      } else {
        return { ok: false, res: loi(400, "bad_request", "Phần nội dung không hợp lệ.") };
      }
    }
    messages.push({ role, content: parts });
  }
  if (anh > 1) return { ok: false, res: loi(400, "too_many_images", "Mỗi lần chỉ gửi một ảnh.") };
  const soKyTu = messages.reduce(
    (n, m) =>
      n + (typeof m.content === "string" ? m.content.length : m.content.reduce((k, p) => k + (p.type === "text" ? p.text.length : 0), 0)),
    0,
  );
  if (soKyTu > TRAN_CHU_KY_TU) return { ok: false, res: loi(400, "bad_request", "Nội dung gửi AI quá dài.") };
  const max = Number(body.max_tokens);
  const maxTokens = Number.isInteger(max) && max > 0 ? Math.min(max, TRAN_MAX_TOKENS) : TRAN_MAX_TOKENS;
  return {
    ok: true,
    payload: (model) => ({
      model,
      messages,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      stream: false,
    }),
  };
}

// ---------------------------------------------------------------------------------------------------

export async function xuLy(req: Request, deps: PhuThuoc = {}): Promise<Response> {
  const env = deps.getEnv ?? ((k: string) => Deno.env.get(k));
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return loi(405, "method_not_allowed", "Chỉ nhận POST.");
  const path = new URL(req.url).pathname;
  const route: Route | null = path.endsWith("/audio/transcriptions") ? "stt" : path.endsWith("/chat/completions") ? "read" : null;
  if (!route) return loi(404, "not_found", "Không có đường này.");
  const khai = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(khai) && khai > TRAN_BODY_BYTES) return loi(413, "payload_too_large", "Gói gửi lên quá lớn.");

  // Công tắc và cấu hình nhà cung cấp CỦA ĐƯỜNG NÀY trước mọi truy vấn: tắt là tắt, không tốn một
  // lượt gọi database nào; thiếu khoá 9router không làm tắt chép giọng và ngược lại.
  const mode = (env("QUICK_ENTRY_MODE") ?? "off").trim();
  const ncc = route === "stt"
    ? { ten: "openrouter", base: OPENROUTER, key: (env("QUICK_ENTRY_OPENROUTER_KEY") ?? "").trim() }
    : {
      ten: "9router",
      base: (env("QUICK_ENTRY_NINEROUTER_BASE_URL") || env("NINEROUTER_BASE_URL") || "").trim().replace(/\/+$/, ""),
      key: (env("QUICK_ENTRY_NINEROUTER_KEY") || env("NINEROUTER_API_KEY") || "").trim(),
    };
  if ((mode !== "pilot" && mode !== "all") || !ncc.key || !/^https:\/\//.test(ncc.base)) {
    return loi(403, "quick_entry_disabled", "AI của Báo chi nhanh đang tắt. Bạn vẫn nhập tay được.");
  }

  const supabaseUrl = env("SUPABASE_URL") ?? "";
  const service = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apikey = env("SUPABASE_ANON_KEY") || service;
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return loi(401, "unauthorized", "Thiếu phiên đăng nhập.");

  let userId: string | null = null;
  try {
    const r = await f(`${supabaseUrl}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey } });
    const u = r.ok ? ((await r.json()) as { id?: unknown }) : null;
    userId = typeof u?.id === "string" ? u.id : null;
  } catch {
    userId = null;
  }
  if (!userId) return loi(401, "unauthorized", "Phiên đăng nhập không hợp lệ.");

  const org = docOrganizationId(req.headers);
  if (!org) return loi(400, "organization_required", "Chưa chọn công ty.");

  // Quyền đọc bằng JWT CỦA NGƯỜI DÙNG: cùng hàm, cùng kết quả giao diện đang thấy.
  let perms: Perms = null;
  try {
    const r = await f(`${supabaseUrl}/rest/v1/rpc/get_my_permissions_v2`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey, "Content-Type": "application/json", "Content-Profile": "public" },
      body: JSON.stringify({ p_org: org }),
    });
    perms = r.ok ? ((await r.json()) as Perms) : null;
  } catch {
    perms = null;
  }
  if (!coQuyen(perms, "income_expenses", "create") && !coQuyen(perms, "personal_finance", "create")) {
    return loi(403, "not_permitted", "Tài khoản chưa có quyền lập phiếu chi hay ghi Ví cá nhân.");
  }

  const svc = { Authorization: `Bearer ${service}`, apikey: service };
  if (mode === "pilot" && !perms?.__superadmin) {
    let entitled = false;
    try {
      const r = await f(
        `${supabaseUrl}/rest/v1/ai_copilot_entitlements?select=chat_enabled&user_id=eq.${userId}&limit=1`,
        { headers: { ...svc, "Accept-Profile": "public" } },
      );
      const rows = r.ok ? ((await r.json()) as Array<{ chat_enabled?: unknown }>) : [];
      entitled = rows[0]?.chat_enabled === true;
    } catch {
      entitled = false;
    }
    if (!entitled) return loi(403, "not_entitled", "Giai đoạn thử: AI chỉ mở cho tài khoản có Copilot.");
  }

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > TRAN_BODY_BYTES) return loi(413, "payload_too_large", "Gói gửi lên quá lớn.");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    body = parsed as Record<string, unknown>;
  } catch {
    return loi(400, "invalid_json", "Thân yêu cầu không phải JSON.");
  }

  const dauVao = route === "stt" ? dauVaoNhanGiong(body) : dauVaoDocChu(body);
  if (!dauVao.ok) return dauVao.res;

  const macDinh = route === "stt"
    ? chuoiMoHinh(env("QUICK_ENTRY_STT_MODELS"), STT_MODELS_MAC_DINH)
    : chuoiMoHinh(env("QUICK_ENTRY_READ_MODELS"), READ_MODELS_MAC_DINH);
  // Người dùng chọn mô hình trên trang (để tự so sánh) ⇒ thử nó TRƯỚC, hỏng thì tới chuỗi mặc định.
  // QUICK_ENTRY_CHOICES=off: vận hành ép mọi người về chuỗi biến môi trường (một mô hình đang trả chữ sai mà
  // vẫn 200 — kiểu lỗi chuỗi dự phòng không tự bắt được) mà không phải deploy lại web.
  const choChon = (env("QUICK_ENTRY_CHOICES") ?? "").trim().toLowerCase() !== "off";
  const chon = choChon ? moHinhDuocChon(route, body.model) : null;
  const models = chon ? [chon, ...macDinh.filter((m) => m !== chon)] : macDinh;
  const skipRaw = Number(req.headers.get("x-quick-entry-skip") ?? 0);
  const skip = route === "read" && Number.isInteger(skipRaw) ? Math.min(Math.max(skipRaw, 0), models.length - 1) : 0;
  // Cụm từ ưu tiên: bắt đầu đọc NGAY (song song với bước giữ chỗ/đếm trần bên dưới), chỉ chờ kết quả ngay
  // trước lần gọi chirp-3 đầu tiên — người chọn nova-3 không phải chờ. Chỉ khi chuỗi có chirp-3 và người dùng
  // lập được phiếu chi công ty (người chỉ có Ví cá nhân không đụng dữ liệu công ty — như trang).
  // QUICK_ENTRY_STT_HINTS=off: vận hành tắt gợi ý mà không phải deploy lại (gợi ý làm chép tệ đi chẳng hạn).
  const goiYBat = route === "stt" && models.includes(MO_HINH_CUM_TU) && coQuyen(perms, "income_expenses", "create") &&
    (env("QUICK_ENTRY_STT_HINTS") ?? "").trim().toLowerCase() !== "off";
  const cumTuSan: Promise<string[]> | null = goiYBat
    ? docCumTu(f, supabaseUrl, apikey, token, org, { boHanChe: !coQuyen(perms, "income_expenses", "restricted_create") })
    : null;
  const taskId = `qe:${newId()}`;
  const logUrl = `${supabaseUrl}/rest/v1/ai_usage_logs`;
  const ghi = { ...svc, "Content-Type": "application/json", "Content-Profile": "public" };

  // GIỮ CHỖ trước khi gọi nhà cung cấp: ghi dòng 'pending' của lượt này rồi mới đếm, nên các lượt chạy
  // song song thấy dòng của nhau và không cùng lọt trần. Không ghi được ⇒ không gọi (trần không bị lách,
  // vd super admin gửi công ty không tồn tại làm hỏng khoá ngoại).
  let reservedId: string | null = null;
  try {
    const r = await f(`${logUrl}?select=id`, {
      method: "POST",
      headers: { ...ghi, Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: userId,
        organization_id: org,
        provider: ncc.ten,
        model: models[skip],
        feature: "quick_entry",
        task_id: taskId,
        status: "pending",
      }),
    });
    const rows = r.ok ? ((await r.json()) as Array<{ id?: unknown }>) : [];
    reservedId = typeof rows[0]?.id === "string" ? rows[0].id : null;
  } catch {
    reservedId = null;
  }
  if (!reservedId) return loi(503, "quick_entry_unavailable", "Chưa ghi được sổ dùng AI — thử lại sau, hoặc nhập tay.");
  const reservedFilter = `id=eq.${encodeURIComponent(reservedId)}`;

  // Trần LƯỢT/ngày: đếm task khác nhau (mỗi lượt có thể thử nhiều mô hình), ĐÃ GỒM dòng vừa giữ chỗ.
  // Vượt trần hoặc không đọc được ⇒ trả chỗ (xoá dòng của mình) rồi chặn.
  const cap = Number(env("QUICK_ENTRY_DAILY_CALLS") ?? LUOT_NGAY_MAC_DINH);
  let used = Number.POSITIVE_INFINITY;
  try {
    const r = await f(
      `${logUrl}?select=task_id&user_id=eq.${userId}&feature=eq.quick_entry` +
        `&created_at=gte.${encodeURIComponent(dauNgayVN(now()))}&limit=5000`,
      { headers: { ...svc, "Accept-Profile": "public" } },
    );
    if (r.ok) {
      const rows = (await r.json()) as Array<{ task_id?: unknown }>;
      used = new Set(rows.map((x) => String(x.task_id ?? ""))).size;
    }
  } catch {
    used = Number.POSITIVE_INFINITY;
  }
  if (!(Number.isFinite(cap) && cap > 0) || used > cap) {
    try {
      await f(`${logUrl}?${reservedFilter}`, { method: "DELETE", headers: { ...ghi, Prefer: "return=minimal" } });
    } catch (e) {
      console.error("quick-entry: trả chỗ ai_usage_logs lỗi", String(e).slice(0, 200));
    }
    return loi(429, "quick_entry_daily_cap", "Hôm nay đã dùng hết lượt AI. Bạn vẫn nhập tay được.");
  }

  const batDau = now();
  let attempts = 0;
  let boGoiY = false;
  let cumTu: string[] | null = null;

  for (let i = skip; i < models.length; i += 1) {
    const dungGoiY = models[i] === MO_HINH_CUM_TU && !boGoiY && cumTuSan !== null;
    // Chờ đọc cụm từ (≤3 s) nằm TRONG ngân sách lượt: thời gian lần thử tính sau khi chờ xong.
    if (dungGoiY && cumTu === null && cumTuSan) cumTu = await cumTuSan;
    const han = thoiGianLanThu(NGAN_SACH_MS[route], now() - batDau, MOI_LAN_MS[route]);
    if (han === 0) break;
    attempts += 1;
    const t0 = now();
    const goiY = dungGoiY ? cumTu ?? [] : [];
    const r = await goiNhaCungCap(
      f,
      ncc.base,
      ncc.key,
      route === "stt" ? "/audio/transcriptions" : "/chat/completions",
      dauVao.payload(models[i], goiY),
      han,
    );
    const text = route === "stt"
      ? String(r.body?.text ?? "").trim()
      : String(((r.body?.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content) ?? "").trim();
    const thanhCong = r.ok && text.length > 0;

    // Sổ phí: một dòng mỗi lần gọi mô hình — lần đầu điền vào dòng giữ chỗ, lần sau thêm dòng mới cùng
    // task. Ghi hỏng không làm hỏng câu trả lời (dòng giữ chỗ vẫn tính lượt).
    const ketQua = {
      provider: ncc.ten,
      model: models[i],
      prompt_tokens: Math.round(r.tokens.prompt),
      completion_tokens: Math.round(r.tokens.completion),
      total_tokens: Math.round(r.tokens.total),
      cost_usd: Number(r.cost.toFixed(6)),
      latency_ms: Math.round(now() - t0),
      status: thanhCong ? "ok" : "upstream_error",
      error_detail: thanhCong ? null : `${route}:${r.status}${goiY.length > 0 ? `:cum_tu=${goiY.length}` : ""}`,
    };
    try {
      const res = attempts === 1
        ? await f(`${logUrl}?${reservedFilter}`, { method: "PATCH", headers: { ...ghi, Prefer: "return=minimal" }, body: JSON.stringify(ketQua) })
        : await f(logUrl, {
          method: "POST",
          headers: { ...ghi, Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: userId, organization_id: org, feature: "quick_entry", task_id: taskId, ...ketQua }),
        });
      if (!res.ok) console.error("quick-entry: ghi ai_usage_logs bị từ chối", res.status);
    } catch (e) {
      console.error("quick-entry: ghi ai_usage_logs lỗi", String(e).slice(0, 200));
    }

    const meta = {
      "x-quick-entry-model": models[i],
      "x-quick-entry-index": String(i),
      "x-quick-entry-attempts": String(attempts),
      "x-quick-entry-hints": String(goiY.length),
    };
    if (thanhCong) {
      if (route === "stt") return json(200, { text }, meta);
      return json(200, { model: models[i], choices: [{ index: 0, message: { role: "assistant", content: text } }] }, meta);
    }
    // Google từ chối BỘ CỤM TỪ (400) ⇒ thử lại chính mô hình đó một lần không kèm cụm từ trước khi tụt
    // xuống mô hình kém hơn: một tên toà/hạng mục lạ không được làm mất mô hình chép tốt nhất.
    if (goiY.length > 0 && r.status === 400) {
      boGoiY = true;
      i -= 1;
      continue;
    }
    if (r.ok || nenThuMoHinhKe(r.status)) continue;
    break;
  }
  return loi(502, "quick_entry_all_failed", "Các mô hình AI đều đang lỗi. Thử lại sau, hoặc nhập tay.");
}

if (import.meta.main) Deno.serve((req) => xuLy(req));
