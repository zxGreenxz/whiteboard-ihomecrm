// Lớp LUẬT chọn hạng mục chi cho "Báo chi nhanh" — chạy TRƯỚC AI, chỉ chốt khi chắc.
//
// Đo trên 414 câu chi thật (fixture __tests__/fixtures/cau-chi-that-2026-10.json, 03/10/2026):
// chọn 293 câu (71%; 1 câu chỉ gợi ý), sai 0; đo đầu-cuối qua suggestCategory (gồm cụm phí) khoá 292, sai 0 —
// đo trên chính bộ câu dùng để viết luật, nên có thêm bộ câu phủ định
// (khoản chi thật không được rơi vào mục dòng tiền); phần còn lại mới gọi AI.
// Ưu tiên ĐÚNG hơn PHỦ: không chắc ⇒ trả null để AI (hoặc người dùng) chọn.
//   1. Luật chủ công ty đặt (03/10/2026), neo theo `rule_key` của hạng mục (migration
//      20261003151608_danh_muc_chi_du_lieu) — tên hạng mục đổi được mà luật không gãy.
//      Luật về dòng tiền (hoàn cọc, trả khách, nội bộ) xét trước luật vệ sinh.
//   2. Cụm "hay nói" lấy từ cột `keywords` (chủ công ty sửa ở trang cài đặt hạng mục). Chỉ dùng cụm
//      ≥ 2 chữ hoặc từ riêng không thể nhầm (bTaskee, PCCC, camera…) và chỉ chốt khi đúng MỘT hạng
//      mục khớp.
// So CÓ DẤU: bỏ dấu làm "tủ" thành "tu" khớp nhầm "vật tư", "nệm" thành "nem" khớp "nem nướng".
// Bản không dấu chỉ dùng cho cụm ≥ 2 chữ và chỉ khi CẢ CÂU gõ không dấu ("tien nha").

import type { CategoryRef } from "./categorySuggest";

/** Chữ thường, NFC, bỏ dấu câu, bọc khoảng trắng hai đầu để so " cụm " theo ranh giới từ. */
export const accentedText = (s: string): string =>
  ` ${s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}/ ]+/gu, " ").replace(/\s+/g, " ").trim()} `;

/** Như trên nhưng bỏ dấu (đ ⇒ d). */
export const bareText = (s: string): string =>
  accentedText(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");

/** Từ đơn đủ riêng để tự chốt (so không dấu, chữ thường). */
const DISTINCT = new Set([
  "btaskee", "pccc", "camera", "wifi", "modem", "decor", "internet", "evn", "fpt", "viettel", "grab", "lalamove",
  "ship", "remote", "silicon", "hhmg", "cakv", "pql",
]);

interface OwnerRule {
  ruleKey: string;
  /** Mẫu trên câu CÓ dấu (accentedText). */
  accented: RegExp;
  /** Mẫu trên câu KHÔNG dấu (bareText) — chỉ dùng khi cả câu gõ không dấu. */
  bare?: RegExp;
  /** Cụm loại trừ (viết có dấu; so cả bản không dấu khi câu gõ không dấu — xem `excluded`). */
  not?: readonly string[];
}

/**
 * Hạng mục dòng tiền chỉ KHOÁ CỨNG khi câu có neo chắc chắn; khớp mà thiếu neo thì chỉ là gợi ý YẾU
 * (thẻ vẫn gọi AI, AI được thay). Review lượt 3 PR #118: danh sách loại trừ người ngoài không bao giờ đủ
 * ("bàn giao tiền cho đội xây dựng", "chi hộ chị Hoa tiền đổ rác", "trả cọc lắp camera").
 */
const STRONG: Readonly<
  Record<string, { accented: RegExp; bare: RegExp; canonical?: RegExp; weakIf?: RegExp; weakIfBare?: RegExp }>
> = {
  noi_bo: {
    // Neo sổ sách. "kết sổ điện nước", "kết sổ tiền rác" là khoản chi ⇒ hạ xuống gợi ý (weakIf).
    accented: / kết tiền (resident|sổ|quỹ) | kết sổ | bàn giao (tiền )?về sổ /,
    bare: / ket tien (resident|so|quy) | ket so | ban giao (tien )?ve so /,
    weakIf: / tiền (điện|nước|rác|internet|mạng|nhà)| điện nước | rác | công an | internet /,
    weakIfBare: / tien (dien|nuoc|rac|internet|mang|nha)| dien nuoc | rac | cong an | internet /,
    // Đúng mẫu chủ hay ghi, CẢ CÂU chỉ có vậy: "bàn giao (tiền) (mã toà) (cho) <người> <tên> (mã/số)" hoặc
    // "(chuyển|chi|đóng) tiền X dùm/hộ <người> <tên>" ⇒ luôn khoá (review lượt 4: câu chuẩn không mất khoá).
    canonical: new RegExp(
      "^ bàn giao (tiền )?(\\S*\\d\\S* )*(cho )?(a|anh|chị|c|em) \\p{L}+ (\\S*\\d\\S* )*$" +
        "|^ (chuyển|chi|đóng) tiền \\S+ (dùm|giùm|hộ) (a|anh|chị|c|em) \\p{L}+ $",
      "u",
    ),
  },
  bo_sung_hoan_coc: {
    // "khách" của khách thuê — không phải "khách sạn", "khách hàng"; mã phòng-toà ("402-1392qt"), "phòng 302";
    // "thanh lý hđ/hợp đồng" (không phải "thanh lý máy giặt cũ"). "hợp đồng" đứng riêng KHÔNG là neo
    // ("trả cọc hợp đồng thuê kho").
    accented: / khách(?! sạn| hàng)| thanh lý (hđ|hợp đồng)| phòng \d{3}| \d{3,4} \d{2,4}[a-zđ]+ /u,
    bare: / khach(?! san| hang)| thanh ly (hd|hop dong)| phong \d{3}| \d{3,4} \d{2,4}[a-z]+ /,
  },
};

function strongFor(ruleKey: string | null | undefined, a: string, b: string, noAccent: boolean): boolean {
  const s = ruleKey ? STRONG[ruleKey] : undefined;
  if (!s) return true;
  if (s.canonical?.test(a)) return true;
  const anchored = s.accented.test(a) || (noAccent && s.bare.test(b));
  const weakened = (s.weakIf?.test(a) ?? false) || (noAccent && (s.weakIfBare?.test(b) ?? false));
  return anchored && !weakened;
}

// Thứ tự = ưu tiên. Dòng tiền trước, vệ sinh sau cùng (câu hoàn cọc có chữ "vệ sinh phòng").
// Luật dòng tiền neo CHẶT (review PR #118, hai lượt): "Chuyển tiền nội bộ" ép dòng INTERNAL — chốt nhầm
// một khoản chi thật vào đây là khoản đó biến khỏi KQKD. Vì thế:
//   - "ứng … cho <người>" KHÔNG tự chốt nội bộ: thợ, lao công, bảo vệ thường gọi bằng tên/việc ("ứng cho
//     chú Định làm thang") nên không phân biệt được với ứng cho người trong công ty ⇒ để AI/người dùng chọn;
//   - bàn giao / chi hộ có loại trừ theo người ngoài và theo việc làm (bài kiểm câu phủ định).
const HON = "(a|anh|chị|c|em|cô|chú)";
/** Người ngoài công ty / việc làm thuê — câu có các cụm này không phải chuyển tiền nội bộ hay hoàn cọc khách. */
// "chủ"/"làm" đơn lẻ KHÔNG nằm đây: "chủ/sếp lấy tiền" là nội bộ, "chủ nhật"; bản không dấu "lam" trùng tên "Lâm".
const NGUOI_NGOAI = [
  "thợ", "chủ nhà", "căn hộ", "hộ khẩu", "evn", "dọn", "sửa", "sơn", "bảo vệ", "lao công", "điện lạnh",
  "máy bơm", "ship", "thầu", "xây dựng", "công ty", "nhà cung cấp", "điện lực", "cấp nước",
];
const OWNER_RULES: readonly OwnerRule[] = [
  {
    ruleKey: "bo_sung_hoan_coc",
    accented: / (hoàn|trả|trả lại) cọc | bổ sung hoàn cọc /,
    bare: / hoan coc | tra lai coc /,
    not: [
      "chủ nhà", "thợ", "cọc nhà", "thuê nhà", "thi công", "lắp", "công tơ", "bình", "xe", "khách sạn", "homestay",
      "mặt bằng", "kho", "khách hàng", "đối tác",
    ],
  },
  {
    ruleKey: "tra_tien_thua_khach",
    accented: / thối tiền | khách đóng dư | đóng dư tiền phòng | tiền phòng \d+ ngày | hoàn (lại )?(\d+ ngày )?tiền phòng | tiền phòng thừa /,
    bare: / thoi tien | khach dong du /,
    not: ["ship", "thợ"],
  },
  {
    ruleKey: "noi_bo",
    accented: new RegExp(
      ` kết tiền (resident|sổ|quỹ) | kết sổ | bàn giao (tiền|về sổ|${HON}) | (chuyển|chi|đóng) (tiền \\S+ )?(dùm|giùm|hộ) ${HON} `,
    ),
    bare: / ket tien (resident|so|quy) | ket so | ban giao (tien|ve so|a|anh|chi) | (chuyen|chi|dong) (tien \S+ )?(dum|gium) (a|anh|chi|c|em|co|chu) /,
    not: NGUOI_NGOAI,
  },
  {
    ruleKey: "camera_wifi_van_tay",
    accented: / camera | wifi | wi fi | modem | cục phát | vân tay | lưu điện | thẻ từ | thẻ nhớ /,
    bare: / camera | wifi | modem | van tay | luu dien | the tu /,
    not: ["tiền wifi", "tiền mạng", "cước"],
  },
  { ruleKey: "pccc", accented: / pccc | chữa cháy | thoát hiểm /, bare: / pccc / },
  // "CAP15", "CA 111 6,7" (mã toà 3–4 số), "tiền CA T5" là cách ghi tiền công an; "cap 6 tháng",
  // "ca 2 bảo vệ", "tiền ca t9 bảo vệ", "ca phe" thì không.
  {
    ruleKey: "cong_an",
    accented: / công an | cakv | cap\d+ |^ ca \d{3,4} | tiền ca t\d/,
    bare: / cong an | cakv /,
    not: ["bảo vệ", "trực"],
  },
  { ruleKey: "tam_tru_giay_to", accented: / tạm trú | tiếp dân | người nước ngoài | gpkd /, bare: / tam tru | tiep dan | nguoi nuoc ngoai / },
  {
    ruleKey: "don_ve_sinh",
    accented: / vệ sinh | btaskee | dọn phòng | dọn dẹp | lau hành lang /,
    bare: / btaskee /,
    // Thiết bị / vật tư phòng tắm không phải lượt dọn.
    not: [
      "máy lạnh", "máy giặt", "bồn nước", "ống nước", "ống đồng", "giấy vệ sinh", "nhà vệ sinh", "phòng vệ sinh",
      "vòi xịt", "xịt vệ sinh", "thiết bị vệ sinh", "bồn cầu", "toilet",
    ],
  },
];

/** Cụm "hay nói" khớp nhầm hay gặp ⇒ không tính cho hạng mục đó. */
const PHRASE_NOT: Readonly<Record<string, readonly string[]>> = {
  dien: ["điện lạnh"],
  // "trả cọc thuê nhà mới" là tiền cọc thu hồi được, không phải tiền nhà tháng.
  tien_nha: ["hợp đồng thuê nhà", "dùm", "giùm", "hộ", "cọc"],
  noi_that_decor: ["rác"],
  dien_lanh: ["mua máy", "mua tủ"],
  // "mua keo dán nút nhấn thang máy" là vật tư, không phải phí bảo trì thang máy hằng tháng.
  thang_may: ["mua"],
};

/** Loại trừ cho cụm "hay nói" của một mục = loại trừ riêng của cụm + loại trừ của luật chủ đặt cùng mục. */
function phraseNot(ruleKey: string): readonly string[] {
  return [...(PHRASE_NOT[ruleKey] ?? []), ...(OWNER_RULES.find((r) => r.ruleKey === ruleKey)?.not ?? [])];
}

/**
 * Câu chứa một cụm loại trừ. Câu có dấu so bản có dấu; câu gõ KHÔNG dấu so cả bản bỏ dấu của cụm —
 * không thì "ban giao tien nha cho chu nha" lọt qua loại trừ "chủ nhà" (review lượt 2).
 */
function excluded(list: readonly string[] | undefined, a: string, b: string, noAccent: boolean): boolean {
  return (list ?? []).some((p) => a.includes(accentedText(p)) || (noAccent && b.includes(bareText(p))));
}

interface Phrase {
  ref: CategoryRef;
  accented: string;
  bare: string | null;
}

function phrasesOf(rows: readonly CategoryRef[]): Phrase[] {
  const out: Phrase[] = [];
  for (const ref of rows) {
    for (const kw of ref.keywords ?? []) {
      const a = accentedText(kw);
      const words = a.trim().split(" ").filter(Boolean);
      if (words.length === 0) continue;
      const b = bareText(kw);
      if (words.length >= 2) out.push({ ref, accented: a, bare: b });
      else if (DISTINCT.has(b.trim())) out.push({ ref, accented: a, bare: null });
    }
  }
  return out;
}

/** Kết quả lớp luật: hạng mục + có được KHOÁ CỨNG không (xem STRONG). */
export interface RuleMatch {
  ref: CategoryRef;
  strong: boolean;
}

/**
 * Hạng mục chọn bằng luật, hoặc null khi không chắc. `rows` phải là danh sách đã lọc dùng được
 * (usableExpenseCategories) — luật trỏ tới mục không có trong danh sách thì bỏ qua. `strong=false` ⇒ chỉ
 * là gợi ý: thẻ không khoá ô hạng mục, AI được thay.
 */
export function ruleMatch(rows: readonly CategoryRef[], text: string): RuleMatch | null {
  if (!text.trim()) return null;
  const a = accentedText(text);
  const b = bareText(text);
  // So không dấu CHỈ khi cả câu gõ không dấu: câu có dấu mà so bản bỏ dấu thì "trà cốc" thành "tra coc".
  const noAccent = a === b;
  const byKey = new Map(rows.filter((r) => r.rule_key).map((r) => [r.rule_key as string, r]));

  for (const rule of OWNER_RULES) {
    const hit = rule.accented.test(a) || (noAccent && rule.bare ? rule.bare.test(b) : false);
    if (!hit || excluded(rule.not, a, b, noAccent)) continue;
    const ref = byKey.get(rule.ruleKey);
    if (ref) return { ref, strong: strongFor(rule.ruleKey, a, b, noAccent) };
  }

  const matched = new Map<string, CategoryRef>();
  for (const p of phrasesOf(rows)) {
    const hit = a.includes(p.accented) || (noAccent && p.bare !== null && b.includes(p.bare));
    if (!hit) continue;
    if (p.ref.rule_key && excluded(phraseNot(p.ref.rule_key), a, b, noAccent)) continue;
    matched.set(p.ref.id, p.ref);
  }
  if (matched.size !== 1) return null;
  const ref = [...matched.values()][0];
  return { ref, strong: strongFor(ref.rule_key, a, b, noAccent) };
}

/**
 * Câu có cụm loại trừ của mục `ruleKey` (loại trừ cụm + loại trừ luật cùng mục). Đường cụm phí cố định của
 * categorySuggest dùng để không khoá "in giấy hợp đồng thuê nhà" vào Tiền nhà (review lượt 4).
 */
export function blockedFor(ruleKey: string, text: string): boolean {
  const a = accentedText(text);
  const b = bareText(text);
  return excluded(phraseNot(ruleKey), a, b, a === b);
}

/** Như ruleMatch nhưng chỉ trả hạng mục (đo độ đúng của lớp luật, không quan tâm khoá cứng/yếu). */
export function ruleCategory(rows: readonly CategoryRef[], text: string): CategoryRef | null {
  return ruleMatch(rows, text)?.ref ?? null;
}
