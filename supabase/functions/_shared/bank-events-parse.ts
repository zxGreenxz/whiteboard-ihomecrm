/**
 * Tách tóm tắt biến động số dư từ SMS / thông báo app / email của ngân hàng Việt Nam.
 *
 * Thuần hàm, không I/O, không thư viện ngoài. Bộ tách đi theo kiểu tổng quát "nhãn + số tiền"
 * thay vì khớp cứng mẫu từng ngân hàng, để tin lạ vẫn tách được.
 *
 * Mọi so khớp chạy trên bản "gấp" (chữ thường, bỏ dấu, đ→d) dài đúng bằng bản NFC gốc,
 * nên chỉ số tìm thấy trên bản gấp dùng thẳng để cắt nội dung (giữ dấu) từ bản gốc.
 */

export type BankDirection = 'in' | 'out';
export interface BankSummary {
  direction: BankDirection | null; // 'in' tiền vào (ghi có), 'out' tiền ra (ghi nợ)
  amount: number | null;           // số nguyên VND, luôn dương
  balance: number | null;          // số dư sau giao dịch nếu tin có, số nguyên VND (có thể âm)
  account: string | null;          // CHỈ 4 số cuối dạng '••5847'
  description: string | null;      // nội dung chuyển khoản, gọn khoảng trắng, tối đa 300 ký tự
  bank: string | null;             // tên ngắn của ngân hàng
  transactedAt: string | null;     // ISO 8601 với offset +07:00
}

// [tên ngắn, bí danh (đã gấp), tên miền email, package Android (khớp đúng hoặc làm tiền tố trước '.')]
type Bank = readonly [string, readonly string[], readonly string[], readonly string[]];
const BANKS: readonly Bank[] = [
  ['Vietcombank', ['vietcombank', 'vcb', 'vcb digibank'], ['vietcombank.com.vn', 'vcb.com.vn'], ['com.vcb']],
  ['Techcombank', ['techcombank', 'tcb'], ['techcombank.com.vn', 'techcombank.com'], ['vn.com.techcombank']],
  ['MB', ['mbbank', 'mb bank', 'mb'], ['mbbank.com.vn', 'mb.com.vn'], ['com.mbmobile', 'vn.com.mbbank']],
  ['ACB', ['acb'], ['acb.com.vn'], ['mobile.acb.com.vn', 'com.acb']],
  ['BIDV', ['bidv'], ['bidv.com.vn'], ['com.vnpay.bidv', 'com.bidv']],
  ['VietinBank', ['vietinbank', 'vietin bank'], ['vietinbank.vn', 'vietinbank.com.vn'], ['com.vietinbank']],
  ['TPBank', ['tpbank', 'tp bank', 'tpb'], ['tpb.vn', 'tpbank.com.vn', 'tpbank.vn'], ['com.tpb']],
  ['Agribank', ['agribank'], ['agribank.com.vn'], ['com.vnpay.agribank3g', 'com.vnpay.agribank']],
  ['VPBank', ['vpbank', 'vp bank', 'vpb', 'vpbank neo'], ['vpbank.com.vn'], ['com.vnpay.vpbankonline', 'com.vpbank']],
  ['Sacombank', ['sacombank'], ['sacombank.com', 'sacombank.com.vn'], ['com.sacombank']],
  ['VIB', ['vib', 'myvib'], ['vib.com.vn'], ['com.vib', 'vn.com.vib']],
  ['HDBank', ['hdbank'], ['hdbank.com.vn'], ['com.vnpay.hdbank', 'vn.hdbank', 'com.hdbank']],
  ['SHB', ['shb'], ['shb.com.vn'], ['vn.shb', 'com.shb']],
  ['MSB', ['msb', 'maritime bank'], ['msb.com.vn'], ['vn.com.msb', 'com.msb']],
  ['OCB', ['ocb', 'ocb omni'], ['ocb.com.vn'], ['vn.com.ocb', 'com.ocb']],
  ['SeABank', ['seabank'], ['seabank.com.vn'], ['vn.com.seabank', 'com.seabank']],
  ['Timo', ['timo'], ['timo.vn'], ['vn.timo', 'io.lifestyle.plus']],
  ['Cake', ['cake', 'cake by vpbank'], ['cake.vn'], ['xyz.be.cake']],
  ['Eximbank', ['eximbank'], ['eximbank.com.vn'], ['com.vnpay.eximbank', 'com.eximbank']],
  ['LPBank', ['lpbank', 'lienvietpostbank', 'lpb'], ['lpbank.com.vn', 'lienvietpostbank.com.vn'], ['com.lienviet', 'vn.lpbank', 'com.lpbank']],
  ['Nam A Bank', ['nam a bank', 'namabank'], ['namabank.com.vn'], ['com.namabank']],
  ['BAOVIET Bank', ['baoviet bank', 'baovietbank'], ['baovietbank.vn'], ['com.baovietbank']],
  ['PVcomBank', ['pvcombank'], ['pvcombank.com.vn'], ['com.pvcombank']],
  ['KienlongBank', ['kienlongbank', 'kienlong bank', 'klb'], ['kienlongbank.com', 'kienlongbank.com.vn'], ['com.kienlongbank']],
  ['ABBANK', ['abbank'], ['abbank.vn', 'abbank.com.vn'], ['com.abbank']],
  ['Bac A Bank', ['bac a bank', 'bacabank'], ['baca-bank.vn', 'bacabank.com.vn'], ['com.bacabank']],
  ['Viet Capital Bank', ['viet capital bank', 'vietcapitalbank', 'bvbank'], ['vietcapitalbank.com.vn', 'bvbank.net.vn'], ['com.vietcapital', 'com.bvbank']],
  ['Saigonbank', ['saigonbank'], ['saigonbank.com.vn'], ['com.saigonbank']],
  ['NCB', ['ncb'], ['ncb-bank.vn'], ['com.ncb']],
  ['VietABank', ['vietabank', 'viet a bank'], ['vietabank.com.vn'], ['com.vietabank']],
  ['PGBank', ['pgbank'], ['pgbank.com.vn'], ['com.pgbank']],
  ['GPBank', ['gpbank'], ['gpbank.com.vn'], ['com.gpbank']],
  ['Vikki', ['vikki', 'vikki bank', 'dong a bank', 'dongabank'], ['vikkibank.vn', 'dongabank.com.vn'], ['vn.vikki', 'com.vikki']],
  ['UOB', ['uob'], ['uob.com.vn'], ['com.uob']],
  ['Shinhan', ['shinhan', 'shinhan bank'], ['shinhan.com.vn'], ['com.shinhan']],
  ['Woori', ['woori', 'woori bank'], ['woori.com.vn', 'wooribank.com.vn'], ['com.woori']],
  ['Standard Chartered', ['standard chartered'], ['sc.com'], []],
  ['HSBC', ['hsbc'], ['hsbc.com.vn'], ['com.hsbc']],
  ['Public Bank', ['public bank', 'publicbank'], ['publicbank.com.vn'], ['com.publicbank']],
  ['CIMB', ['cimb'], ['cimb.com.vn'], ['com.cimb']],
];

const MAX_TEXT = 3000;  // tin biến động nằm ở đầu; phần sau (chân trang email) chỉ làm chậm
const MAX_LABELS = 20;  // số nhãn nội dung tối đa xét trong một tin
const LB = '(?<![a-z0-9])';
const rx = (source: string, flags = '') => new RegExp(source, flags);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const ALIASES = BANKS.flatMap(([name, aliases]) =>
  aliases.map((alias) => ({ name, length: alias.length, re: rx(`${LB}${alias.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![a-z0-9])`) })));

// --- Nhãn đứng ngay trước một con số (bản gấp; neo ở cuối cửa sổ phía trước số) ---
const TAIL = '\\s*(?:\\(vnd\\))?\\s*[:=]?\\s*$';
const FOREIGN = 'usd|eur|jpy|gbp|aud|sgd|cny|krw|thb|hkd|cad|chf';
const NUMBER = /([+-]\s?)?(\d[\d.,]*\d|\d)/g;
const UNIT_AFTER = /^\s?(?:vnd|dong|d)(?![a-z0-9])/;
const UNIT_BEFORE = /(?<![a-z])vnd\)?\s?:?\s?$/;
const FOREIGN_AFTER = rx(`^\\s?(?:${FOREIGN})(?![a-z])`);
const FOREIGN_BEFORE = rx(`(?:${LB}(?:${FOREIGN})|[$€£¥])\\s?$`);
const REF_LABEL = rx(`${LB}(?:so gd|ma gd|so giao dich|ma giao dich|so ct|so chung tu|(?:so|ma) tham chieu|so but toan|so lenh|ref|trace|ma kh|ma khach hang|hotline|sdt|(?:so )?dien thoai|tel|fax|otp|ma otp|ma xac (?:thuc|nhan))\\s*[:.#]?\\s*$`);
// "Biến động số dư\n+500.000đ": tiêu đề kết thúc bằng "số dư" không phải nhãn số dư.
const BALANCE_LABEL = rx(`${LB}(?<!(?:bien dong|thong bao|bao) )(?:sdc|sdkd|sd|so du)(?:\\s+(?:cuoi(?: ky)?|hien tai|kha dung|moi|sau (?:gd|giao dich)))?${TAIL}|${LB}(?:available\\s+)?balance${TAIL}`);
const ACCOUNT_LABEL = rx(`${LB}(?:so tk|stk|tk|so tai khoan|tai khoan|account)\\s*[:.]?\\s*$`);
const AMOUNT_LABEL = rx(`${LB}(?:so tien(?:\\s+(?:gd|giao dich|thay doi|ghi co|ghi no|thanh toan|chuyen|nhan))?|ps|phat sinh|gd|giao dich|ghi co|ghi no|bao co|bao no|bien dong|amount|credit|debit|tien vao|tien ra)${TAIL}`);

// --- Tài khoản ---
// TK của bên kia ("TK nhận", "TK thụ hưởng", "đến TK"…) không phải tài khoản của chủ tin.
const ACCOUNT_AT = rx(`${LB}(?<!(?:den|toi|sang|cho) )(?:so tk|stk|tk|so tai khoan|tai khoan|account|acct)(?![a-z])(?!\\s+(?:nhan|thu huong|doi ung|ben nhan)(?![a-z]))`, 'g');
const ACCOUNT_TOKEN = /^[\s:.#]*(?:[a-z]{2,6}\s*:?\s*)?([0-9x*•][0-9x*•.]*[0-9x*•])(?![a-z0-9])/;
const MASKED_ACCOUNT = /(?<![a-z0-9])\d{0,12}[x*•]{2,}\d{4,}(?![a-z0-9])/g;
const COUNTERPARTY_BEFORE = /(?:nhan|thu huong|doi ung|den|toi|sang|cho)(?: (?:so tk|stk|tk|tai khoan))?\s*:?\s*$/;

// --- Nội dung ---
const DESC_LABEL = /(?<![a-z0-9])(noi dung(?: (?:giao dich|chuyen tien|chuyen khoan|ck))?|nd(?: (?:gd|ck|chuyen tien|chuyen khoan))?|dien giai|mo ta|description|remark|gd|ref)(?![a-z0-9])[ \t]*(:)?/g;
const NEED_COLON = new Set(['noi dung', 'nd', 'nd gd', 'nd ck', 'dien giai', 'mo ta', 'description', 'remark', 'gd']);
const DESC_STOP = /[\s.,;]\s{0,3}(?:sdc?|so du(?: (?:cuoi|hien tai|kha dung))?|balance)\s*[:.]?\s*[+-]?\s?\d|[\s.,;]\s{0,3}(?:vao )?luc\s*:?\s*\d|[\s.,;]\s{0,3}(?:thoi gian|ngay gd|ngay giao dich|ma gd|so gd|ma giao dich|so tham chieu|so but toan)\s*:|\s\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}[\s,;]+\d{1,2}[:h]\d{2}/;
const FIELD_START = /^(?:sdc?|so du|so tk|stk|tk|tai khoan|so tien|thoi gian|ngay|loai|ma|so gd|phi|vao luc|luc|time|date|balance|amount|ref|nd|noi dung|cam on|xin cam on|tran trong|kinh gui|quy khach|hotline|vui long|luu y|chi tiet|lien he|day la)(?![a-z])|^\d{1,2}[/.:h-]\d{1,2}|^[^:\n]{1,25}:\s/;

// --- Chiều, loại tin ---
// Từ khoá chiều ngay trước số tiền, chia hai bậc; "người nhận", "TK nhận"… là bên kia nên không tính.
const NOT_PAYEE = '(?<!(?:nguoi|khoan|tk|hang|vi|ben) )';
const IN_STRONG = rx(`${LB}(?:ghi co|bao co|credit|tien vao|so du tang|tang so du|${NOT_PAYEE}(?:da )?nhan(?: duoc)? (?:thanh toan|tien|chuyen khoan|ck))(?![a-z])`, 'g');
const OUT_STRONG = rx(`${LB}(?:ghi no|bao no|debit|tien ra|so du giam|giam so du)(?![a-z])`, 'g');
const IN_WEAK = rx(`${LB}(?:nhan duoc|da nhan|${NOT_PAYEE}nhan|cong(?! ty)|tang|hoan tien)(?![a-z])`, 'g');
const OUT_WEAK = rx(`${LB}(?:tru(?! so)|giam(?! doc)|(?<!dia )chi(?! (?:tiet|nhanh))|thanh toan|rut tien|chuyen di|da chuyen)(?![a-z])`, 'g');
// "NGUYEN VAN A đã chuyển 500.000đ cho bạn": người khác chuyển cho chủ tin ⇒ tiền vào.
const TO_YOU = /chuyen(?: tien| khoan)?[^\n]{0,80}?cho (?:ban(?! be)|quy khach|qk)(?![a-z])/;
const STRONG_IN = rx(`${LB}(?:ghi co|bao co|tien vao|so du tang|tang so du|da nhan|nhan duoc)(?![a-z])`);
const STRONG_OUT = rx(`${LB}(?:ghi no|bao no|tien ra|so du giam|giam so du|da tru|bi tru)(?![a-z])`);
const STRONG_TX = rx(`${LB}(?:bien dong so du|ghi co|ghi no|bao co|bao no|so du (?:tk|tai khoan)|thay doi so du|so du thay doi|tien vao|tien ra)(?![a-z])`);
// "pin" chỉ tính khi có mã số theo sau, để "MUA PIN DIEN THOAI" không bị coi là OTP.
const OTP_WORDS = 'otp|ma xac (?:thuc|nhan)|ma bao mat|mat khau|passcode|pin(?=[^\\d\\n]{0,10}\\d{4,8}(?!\\d))';
const OTP_RE = rx(`${LB}(?:${OTP_WORDS}|ma kich hoat|verification code|one[- ]time)(?![a-z])`);
const OTP_CODE = rx(`${LB}(?:${OTP_WORDS})[^\\d\\n]{0,30}(\\d{4,8})(?!\\d)|(?<!\\d)(\\d{4,8})\\s+(?:la\\s+)?(?:ma\\s+)?(?:otp|xac thuc|bao mat|passcode)`, 'g');
const PROMO_RE = rx(`${LB}(?:khuyen mai|uu dai|giam gia|qua tang|voucher|mien phi|dang ky ngay|quang cao|cashback|hoan tien|tri an|chuong trinh)(?![a-z])`);

// --- Thời gian ---
const DATE_TIME = /(?<![\d.,/])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)[\s,;]+(?:(?:vao )?luc\s+)?(\d{1,2})[:h](\d{2})(?::(\d{2}))?(?!\d)/;
const TIME_DATE = /(?<![\d.,/:])(\d{1,2})[:h](\d{2})(?::(\d{2}))?p?[\s,;]+(?:ngay\s+)?(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/;
const ISO_DATE_TIME = /(?<!\d)(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::(\d{2}))?(?!\d)/;

interface Money {
  start: number; end: number; value: number; sign: string;
  unit: boolean; label: boolean; grouped: boolean; balance: boolean; weak: boolean;
}
type Region = readonly [number, number];

/** Chữ thường + bỏ dấu, giữ nguyên độ dài từng ký tự để chỉ số khớp với bản NFC. */
function fold(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0);
    const f = ch === 'đ' || ch === 'Đ' ? 'd'
      : cp === 0x2212 ? '-' // dấu trừ toán học
      : cp === 0xa0 ? ' '   // khoảng trắng không ngắt dòng
      : ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    out += f.length === ch.length ? f : ch;
  }
  return out;
}

function bankByAlias(text: string): string | null {
  const f = fold(text.slice(0, 200));
  let best: { at: number; length: number; name: string } | null = null;
  for (const { name, length, re } of ALIASES) {
    const at = re.exec(f)?.index;
    if (at !== undefined && (!best || at < best.at || (at === best.at && length > best.length))) best = { at, length, name };
  }
  return best?.name ?? null;
}

function bankByPackage(packageName: string): string | null {
  const p = packageName.trim().toLowerCase();
  if (!p) return null;
  for (const [name, , , packages] of BANKS) if (packages.some((q) => p === q || p.startsWith(`${q}.`))) return name;
  return bankByAlias(p.replace(/[._]/g, ' '));
}

function bankByDomain(from: string): string | null {
  const domain = /@([a-z0-9.-]+)/i.exec(from.slice(0, 320))?.[1].toLowerCase();
  if (!domain) return null;
  for (const [name, , domains] of BANKS) if (domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return name;
  return null;
}

function parseNumber(raw: string): { value: number; grouped: boolean } | null {
  let m = /^(\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.exec(raw) ?? /^(\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.exec(raw);
  const grouped = m !== null;
  m ??= /^(\d+)(?:[.,]\d{1,2})?$/.exec(raw);
  if (!m) return null;
  const digits = m[1].replace(/[.,]/g, '');
  if (digits.length > 13) return null; // dài hơn thế là số tài khoản / tham chiếu, không phải tiền
  const value = Number(digits);
  return value > 0 ? { value, grouped } : null;
}

/** Mọi con số trông như tiền VND, kèm vai trò (số dư / số tiền) và bằng chứng. */
function scanMoney(f: string): Money[] {
  const found: Money[] = [];
  for (const m of f.matchAll(NUMBER)) {
    const start = m.index ?? 0, signText = m[1] ?? '', digits = m[2];
    let end = start + signText.length + digits.length;
    const prev = f[start - 1] ?? '', prev2 = f[start - 2] ?? '';
    // Số dính chữ/ký hiệu là một phần mã (FT…, MBVCB.…, xxxx5847) hoặc ngày giờ.
    if (/[a-z0-9_*•/@#%&]/.test(prev) || (prev === ':' && /\d/.test(prev2)) || (prev === '.' && /[a-z0-9]/.test(prev2))) continue;
    const after = f.slice(end, end + 8);
    if (/^[/:-]\d|^[*•_@]/.test(after) || FOREIGN_AFTER.test(after)) continue;
    const unitAfter = UNIT_AFTER.exec(after);
    if (!unitAfter && /^[a-z]/.test(after)) continue;
    const parsed = parseNumber(digits);
    if (!parsed) continue;
    const before = f.slice(Math.max(0, start - 50), start);
    if (FOREIGN_BEFORE.test(before) || REF_LABEL.test(before)) continue;
    const balance = BALANCE_LABEL.test(before);
    if (!balance && ACCOUNT_LABEL.test(before)) continue;
    const label = !balance && AMOUNT_LABEL.test(before);
    const unit = unitAfter !== null || UNIT_BEFORE.test(before);
    const sign = signText.trim();
    const strong = balance || label || (sign !== '' && (parsed.grouped || unit || digits.length >= 4));
    if (!strong && !unit) continue;
    if (unitAfter) end += unitAfter[0].length;
    found.push({ start, end, value: parsed.value, sign, unit, label, grouped: parsed.grouped, balance, weak: !strong });
  }
  return found;
}

const inside = (regions: readonly Region[], at: number) => regions.some(([a, b]) => at >= a && at < b);

function pickAmount(money: readonly Money[], regions: readonly Region[], context: boolean): Money | null {
  let best: Money | null = null, bestScore = -Infinity;
  for (const c of money) {
    // Số chỉ có đơn vị (không dấu, không nhãn) chỉ tính khi tin đã có dấu hiệu giao dịch khác.
    if (c.balance || (c.weak && !context)) continue;
    const score = (c.label ? 4 : 0) + (c.sign ? 3 : 0) + (c.unit ? 2 : 0) + (c.grouped ? 1 : 0) - (inside(regions, c.start) ? 5 : 0);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

function findAccount(f: string): string | null {
  for (const m of f.matchAll(ACCOUNT_AT)) {
    const from = (m.index ?? 0) + m[0].length;
    const token = ACCOUNT_TOKEN.exec(f.slice(from, from + 40))?.[1];
    if (!token) continue;
    // Nhãn đầu tiên có chuỗi số là tài khoản của chủ tin; thiếu 4 số cuối thì thôi, không đoán sang TK khác.
    const tail = /(\d{4,})$/.exec(token)?.[1];
    return tail ? `••${tail.slice(-4)}` : null;
  }
  for (const m of f.matchAll(MASKED_ACCOUNT)) {
    const at = m.index ?? 0;
    if (!COUNTERPARTY_BEFORE.test(f.slice(Math.max(0, at - 30), at))) return `••${m[0].slice(-4)}`;
  }
  return null;
}

function otpCodes(f: string): Set<string> {
  return new Set([...f.matchAll(OTP_CODE)].map((m) => m[1] ?? m[2] ?? '').filter(Boolean));
}

/** Gọn khoảng trắng, tối đa 300 ký tự, bỏ phần OTP. */
function tidy(raw: string, codes: ReadonlySet<string>): string | null {
  // Cắt độ dài trước mọi regex khác để chi phí luôn bị chặn trên.
  let v = Array.from(raw.replace(/\s+/g, ' ').trim()).slice(0, 300).join('');
  const fv = fold(v);
  const hit = OTP_RE.exec(fv);
  if (hit) {
    // Cắt từ đầu câu chứa từ khoá OTP để mã không lọt vào nội dung.
    const cut = Math.max(...['.', ';', '!', '?', ','].map((p) => fv.lastIndexOf(p, hit.index)));
    v = cut > 0 ? v.slice(0, cut) : '';
  }
  v = v.replace(/^[\s:.,;|–-]+|[\s:.,;|–-]+$/g, '');
  if ((v.match(/\d+/g) ?? []).some((run) => codes.has(run))) return null;
  return /[\p{L}\p{N}]/u.test(v) ? v : null;
}

/** Cuối trường nội dung: xuống dòng, '|', hoặc nhãn trường kế (SD/Số dư/lúc/thời gian/ngày giờ…). */
function fieldEnd(f: string, from: number): number {
  let end = f.indexOf('\n', from);
  if (end < 0) end = f.length;
  const pipe = f.indexOf('|', from);
  if (pipe >= 0 && pipe < end) end = pipe;
  const stop = DESC_STOP.exec(f.slice(from, end));
  return stop ? from + stop.index : end;
}

function labelledDescription(t: string, f: string, codes: ReadonlySet<string>, regions: Region[]): string | null {
  let best: { rank: number; value: string } | null = null, seen = 0;
  for (const m of f.matchAll(DESC_LABEL)) {
    if (++seen > MAX_LABELS) break; // chặn chi phí bậc hai khi tin lặp nhãn hàng nghìn lần
    const label = m[1], at = m.index ?? 0;
    let from = at + m[0].length;
    let lineEnd = f.indexOf('\n', from);
    if (lineEnd < 0) lineEnd = f.length;
    const rest = f.slice(from, lineEnd);
    // Bảng email chuyển sang văn bản: nhãn đứng một mình trên dòng hoặc cách giá trị bằng tab.
    const alone = rest.trim() === '' && f.slice(f.lastIndexOf('\n', at - 1) + 1, at).trim() === '';
    if (NEED_COLON.has(label) && !m[2] && !rest.startsWith('\t') && !alone) continue;
    if (label === 'gd' && /(?:ma|so|loai|ngay|tien|gian|phi)\s*$/.test(f.slice(Math.max(0, at - 8), at))) continue;
    if (rest.trim() === '') {
      if (lineEnd >= f.length) continue;
      from = lineEnd + 1;
    }
    const end = fieldEnd(f, from);
    // "GD: +1,000,000VND" (MB) là số tiền; "GD: NGUYEN VAN A…" (ACB) là nội dung.
    if (label === 'gd' && /^\s*(?:[+-]|\d[\d.,]*\s*(?:vnd|dong|d)?(?:[\s|;]|$))/.test(f.slice(from, end))) continue;
    const value = tidy(t.slice(from, end), codes);
    if (!value) continue;
    regions.push([from, end]);
    const rank = label === 'ref' ? 2 : label === 'gd' ? 1 : 0;
    if (!best || rank < best.rank) best = { rank, value };
  }
  return best?.value ?? null;
}

function fallbackDescription(t: string, f: string, amount: Money, balance: Money | undefined, codes: ReadonlySet<string>): string | null {
  // Nội dung trong ngoặc ngay sau số tiền (kiểu Agribank).
  const paren = /^\s*\(([^()\n]{2,})\)/.exec(f.slice(amount.end));
  if (paren && !/^\s*(?:vnd|usd)\s*$/.test(paren[1])) {
    const from = amount.end + paren[0].indexOf('(') + 1;
    const v = tidy(t.slice(from, from + paren[1].length), codes);
    if (v) return v;
  }
  // Dòng không nhãn đầu tiên sau dòng số tiền (kiểu email ACB): bỏ qua tối đa 2 dòng trường
  // (ngày giờ / số dư / nhãn khác), dừng ở dòng trống để không lấy nhầm chân trang.
  for (let n = 0, nl = f.indexOf('\n', amount.end); n < 3 && nl >= 0; n++) {
    const from = nl + 1;
    nl = f.indexOf('\n', from);
    if (f.slice(from, nl < 0 ? f.length : nl).trim() === '') break;
    const end = fieldEnd(f, from), line = f.slice(from, end).trim();
    if (!line || FIELD_START.test(line)) continue;
    const v = tidy(t.slice(from, end), codes);
    if (v) return v;
    break;
  }
  // Nội dung không nhãn nằm ngay sau số dư trên cùng dòng.
  if (balance) {
    const end = fieldEnd(f, balance.end);
    const rest = f.slice(balance.end, end).replace(/^[\s.,;:-]+/, '');
    if (/[a-z]{2}/.test(rest) && !FIELD_START.test(rest)) return tidy(t.slice(balance.end, end), codes);
  }
  return null;
}

/** Có khớp bắt đầu trong [from, to) không; chạy trên cả văn bản để lookbehind ("người nhận") thấy đủ ngữ cảnh. */
function hasMatch(re: RegExp, text: string, from: number, to: number): boolean {
  re.lastIndex = from;
  const m = re.exec(text);
  return m !== null && m.index < to;
}

function direction(plain: string, amount: Money): BankDirection | null {
  if (amount.sign === '+') return 'in';
  if (amount.sign === '-') return 'out';
  const from = Math.max(0, amount.start - 60), to = amount.start;
  // Mỗi bậc (mạnh rồi yếu): chỉ một phía có từ khoá thì theo phía đó; cả hai phía ⇒ không đoán.
  const tiers: [boolean, boolean][] = [
    [hasMatch(IN_STRONG, plain, from, to) || TO_YOU.test(plain.slice(from, amount.end + 40)), hasMatch(OUT_STRONG, plain, from, to)],
    [hasMatch(IN_WEAK, plain, from, to), hasMatch(OUT_WEAK, plain, from, to)],
  ];
  for (const [i, o] of tiers) {
    if (i !== o) return i ? 'in' : 'out';
    if (i) return null;
  }
  const si = STRONG_IN.test(plain), so = STRONG_OUT.test(plain);
  return si === so ? null : si ? 'in' : 'out';
}

function timestamp(f: string): string | null {
  const found: { at: number; parts: (string | undefined)[] }[] = [];
  const a = DATE_TIME.exec(f), b = TIME_DATE.exec(f), c = ISO_DATE_TIME.exec(f);
  if (a) found.push({ at: a.index, parts: [a[1], a[2], a[3], a[4], a[5], a[6]] });
  if (b) found.push({ at: b.index, parts: [b[4], b[5], b[6], b[1], b[2], b[3]] });
  if (c) found.push({ at: c.index, parts: [c[3], c[2], c[1], c[4], c[5], c[6]] });
  if (found.length === 0) return null;
  const first = found.reduce((best, x) => (x.at < best.at ? x : best));
  const [d, mo, y, h, mi, s] = first.parts.map((p) => Number(p ?? 0));
  const year = y < 100 ? 2000 + y : y;
  const lastDay = new Date(Date.UTC(year, mo, 0)).getUTCDate();
  if (year < 2000 || year > 2099 || mo < 1 || mo > 12 || d < 1 || d > lastDay || h > 23 || mi > 59 || s > 59) return null;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}+07:00`;
}

/** Gọn khoảng trắng ngang và dòng trống liên tiếp, rồi giữ MAX_TEXT ký tự đầu (không cắt đôi cặp surrogate). */
function clip(text: string): string {
  const t = text.replace(/[^\S\n\t]+/g, ' ').replace(/\n\s*\n/g, '\n\n');
  if (t.length <= MAX_TEXT) return t;
  const c = t.charCodeAt(MAX_TEXT - 1);
  return t.slice(0, c >= 0xd800 && c <= 0xdbff ? MAX_TEXT - 1 : MAX_TEXT);
}

/** payload là JSON đã giải mã của một sự kiện. Trả null nếu KHÔNG phải tin biến động số dư. */
export function summarizeBankPayload(payload: Record<string, unknown>): BankSummary | null {
  // Không bao giờ ném, kể cả với payload lạ (Proxy, getter…): lỗi coi như không phải tin biến động.
  try {
    return summarize(payload);
  } catch {
    return null;
  }
}

function summarize(payload: Record<string, unknown>): BankSummary | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const event = str(payload.event), body = str(payload.body);
  let parts: string[], findBank: () => string | null;
  if (event === 'sms.received') {
    parts = [body];
    findBank = () => bankByAlias(str(payload.sender)) ?? bankByAlias(body.slice(0, 80));
  } else if (event === 'notification.received') {
    parts = [str(payload.title), body];
    findBank = () => bankByPackage(str(payload.packageName)) ?? bankByAlias(str(payload.appName))
      ?? bankByAlias(str(payload.title)) ?? bankByAlias(body.slice(0, 80));
  } else if (event === 'email.received') {
    parts = [str(payload.subject), body];
    findBank = () => bankByDomain(str(payload.from)) ?? bankByAlias(str(payload.from))
      ?? bankByAlias(str(payload.subject)) ?? bankByAlias(body.slice(0, 200));
  } else return null; // gateway.test, heartbeat, sự kiện lạ

  const t = clip(parts.filter((p) => p.trim() !== '').join('\n').normalize('NFC'));
  const f = fold(t);
  const codes = otpCodes(f);
  const regions: Region[] = [];
  const labelled = labelledDescription(t, f, codes, regions);
  const plain = regions.reduce((s, [a, b]) => s.slice(0, a) + ' '.repeat(b - a) + s.slice(b), f);

  const account = findAccount(f);
  const money = scanMoney(f);
  const balance = money.find((c) => c.balance);
  const strongTx = STRONG_TX.test(plain);
  const amount = pickAmount(money, regions, account !== null || balance !== undefined || strongTx);
  if (!amount) return null;
  if (OTP_RE.test(f) && !amount.sign && !balance && !strongTx) return null;
  if (PROMO_RE.test(plain) && account === null && !balance && !strongTx) return null;

  return {
    direction: direction(plain, amount),
    amount: amount.value,
    balance: balance ? (balance.sign === '-' ? -balance.value : balance.value) : null,
    account,
    description: labelled ?? fallbackDescription(t, f, amount, balance, codes),
    bank: findBank(),
    transactedAt: timestamp(f),
  };
}
