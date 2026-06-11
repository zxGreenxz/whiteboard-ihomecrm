import { normalizeVietnamese } from "@/lib/utils";

// =============================================================
// VietQR Quicklink/Deeplink — mở app ngân hàng tới màn hình
// chuyển tiền với thông tin người nhận điền sẵn.
//
// Format: https://dl.vietqr.io/pay?app=<appId>&ba=<stk>@<bankCode>&am=<số tiền>&tn=<nội dung>&bn=<tên người nhận>
// - `app`  = app ngân hàng NGƯỜI CHUYỂN muốn mở (danh sách VIETQR_BANK_APPS,
//            nguồn: https://api.vietqr.io/v2/android-app-deeplinks).
// - `ba`   = tài khoản NGƯỜI NHẬN dạng <số tk>@<mã bank> (RECIPIENT_BANKS).
// - LƯU Ý thực tế: deeplink mới chỉ MỞ ĐƯỢC APP, đa số app bank chưa nhận
//   payload tự điền (VietQR docs xác nhận). Luồng điền sẵn tin cậy là ẢNH
//   VietQR (img.vietqr.io, xem buildVietQRImageUrl): lưu ảnh → mở app →
//   quét QR từ thư viện → app tự điền đủ bank/STK/số tiền/nội dung.
// =============================================================

/** App ngân hàng hỗ trợ mở qua VietQR deeplink (param `app`). */
export interface VietQRBankApp {
  appId: string;
  label: string;
}

/** Thứ tự phổ biến trước — hiển thị grid chọn app trên mobile. */
export const VIETQR_BANK_APPS: VietQRBankApp[] = [
  { appId: "vcb", label: "Vietcombank" },
  { appId: "mb", label: "MB Bank" },
  { appId: "icb", label: "VietinBank iPay" },
  { appId: "bidv", label: "BIDV SmartBanking" },
  { appId: "vba", label: "Agribank" },
  { appId: "tcb", label: "Techcombank" },
  { appId: "acb", label: "ACB One" },
  { appId: "vpb", label: "VPBank NEO" },
  { appId: "tpb", label: "TPBank" },
  { appId: "vib-2", label: "MyVIB" },
  { appId: "shb", label: "SHB" },
  { appId: "hdb", label: "HDBank" },
  { appId: "ocb", label: "OCB OMNI" },
  { appId: "seab", label: "SeAMobile" },
  { appId: "lpb", label: "LPBank (Liên Việt)" },
  { appId: "scb", label: "SCB" },
  { appId: "eib", label: "Eximbank" },
  { appId: "nab", label: "Nam Á Bank" },
  { appId: "cake", label: "CAKE" },
  { appId: "timo", label: "Timo" },
  { appId: "klb", label: "KienlongBank" },
  { appId: "ncb", label: "NCB iziMobile" },
  { appId: "abb", label: "ABBANK" },
  { appId: "bvb", label: "BaoViet Bank" },
  { appId: "vab", label: "VietABank" },
  { appId: "pvcb", label: "PVcomBank" },
  { appId: "vietbank", label: "Vietbank" },
  { appId: "shbvn", label: "Shinhan Bank" },
  { appId: "wvn", label: "Woori Bank" },
  { appId: "sgicb", label: "SaigonBank" },
  { appId: "coopbank", label: "Co-opBank" },
  { appId: "cimb", label: "CIMB (OCTO)" },
  { appId: "pbvn", label: "Public Bank" },
];

/** Ngân hàng nhận tiền — `code` dùng trong param `ba` (<stk>@<code>). */
export interface RecipientBank {
  code: string;
  /** Mã BIN Napas (dùng cho ảnh VietQR img.vietqr.io). */
  bin: string;
  shortName: string;
  /**
   * Alias đã chuẩn hoá (không dấu, lowercase, viết liền).
   * - Alias >= 4 ký tự: khớp substring trên chuỗi viết liền
   *   ("Ngân hàng BIDV CN Trường Sơn" → "nganhangbidvcntruongson" chứa "bidv").
   * - Alias <= 3 ký tự: phải khớp NGUYÊN một token — tránh "scb" ăn nhầm
   *   chuỗi khác, "mb" ăn nhầm "sacombank"...
   */
  aliases: string[];
}

/** Thứ tự = độ ưu tiên khi khớp (bank phổ biến/alias đặc trưng đứng trước). */
export const RECIPIENT_BANKS: RecipientBank[] = [
  // "viettinbank"/"viettin" = lỗi chính tả phổ biến của VietinBank trong dữ liệu thực
  { code: "icb", bin: "970415", shortName: "VietinBank", aliases: ["vietinbank", "viettinbank", "vietin", "viettin", "congthuong", "ipay", "icb"] },
  { code: "vcb", bin: "970436", shortName: "Vietcombank", aliases: ["vietcombank", "ngoaithuong", "vcb"] },
  { code: "bidv", bin: "970418", shortName: "BIDV", aliases: ["bidv", "dautuvaphattrien"] },
  { code: "vba", bin: "970405", shortName: "Agribank", aliases: ["agribank", "nongnghiep", "vba"] },
  { code: "mb", bin: "970422", shortName: "MB Bank", aliases: ["mbbank", "quandoi", "mb"] },
  { code: "tcb", bin: "970407", shortName: "Techcombank", aliases: ["techcombank", "kythuong", "tcb"] },
  { code: "acb", bin: "970416", shortName: "ACB", aliases: ["achau", "acb"] },
  { code: "vpb", bin: "970432", shortName: "VPBank", aliases: ["vpbank", "thinhvuong", "vpb"] },
  { code: "tpb", bin: "970423", shortName: "TPBank", aliases: ["tpbank", "tienphong", "tpb"] },
  { code: "stb", bin: "970403", shortName: "Sacombank", aliases: ["sacombank", "saigonthuongtin", "stb"] },
  { code: "hdb", bin: "970437", shortName: "HDBank", aliases: ["hdbank", "hdb"] },
  { code: "vib", bin: "970441", shortName: "VIB", aliases: ["myvib", "vib"] },
  { code: "shb", bin: "970443", shortName: "SHB", aliases: ["saigonhanoi", "shb"] },
  { code: "eib", bin: "970431", shortName: "Eximbank", aliases: ["eximbank", "eib"] },
  { code: "msb", bin: "970426", shortName: "MSB", aliases: ["maritime", "hanghai", "msb"] },
  { code: "scb", bin: "970429", shortName: "SCB", aliases: ["scb"] },
  { code: "seab", bin: "970440", shortName: "SeABank", aliases: ["seabank", "dongnama", "seab"] },
  { code: "ocb", bin: "970448", shortName: "OCB", aliases: ["phuongdong", "ocb"] },
  { code: "nab", bin: "970428", shortName: "Nam Á Bank", aliases: ["namabank", "nama", "nab"] },
  { code: "lpb", bin: "970449", shortName: "LPBank", aliases: ["lpbank", "lienviet", "locphat", "buudien", "lpb"] },
  { code: "klb", bin: "970452", shortName: "KienlongBank", aliases: ["kienlong", "klb"] },
  { code: "ncb", bin: "970419", shortName: "NCB", aliases: ["quocdan", "ncb"] },
  { code: "abb", bin: "970425", shortName: "ABBANK", aliases: ["abbank", "anbinh", "abb"] },
  { code: "bvb", bin: "970438", shortName: "BaoViet Bank", aliases: ["baoviet", "bvb"] },
  { code: "vab", bin: "970427", shortName: "VietABank", aliases: ["vietabank", "vieta", "vab"] },
  { code: "pvcb", bin: "970412", shortName: "PVcomBank", aliases: ["pvcombank", "daichung", "pvcb"] },
  { code: "bab", bin: "970409", shortName: "BacABank", aliases: ["bacabank", "baca", "bab"] },
  { code: "pgb", bin: "970430", shortName: "PGBank", aliases: ["pgbank", "pgb"] },
  // cake/timo/momo đứng trước vccb: "Timo by Ban Viet Bank" phải ra Timo, không phải Bản Việt
  { code: "cake", bin: "546034", shortName: "CAKE", aliases: ["cake"] },
  { code: "timo", bin: "963388", shortName: "Timo", aliases: ["timo"] },
  { code: "momo", bin: "971025", shortName: "MoMo", aliases: ["momo"] },
  { code: "vccb", bin: "970454", shortName: "BVBank (Bản Việt)", aliases: ["banviet", "vietcapital", "bvbank", "vccb"] },
  { code: "sgicb", bin: "970400", shortName: "SaigonBank", aliases: ["saigonbank", "saigoncongthuong", "sgicb"] },
  { code: "vietbank", bin: "970433", shortName: "Vietbank", aliases: ["vietbank", "vietnamthuongtin"] },
  { code: "coopbank", bin: "970446", shortName: "Co-opBank", aliases: ["coopbank", "hoptacxa"] },
  { code: "shbvn", bin: "970424", shortName: "Shinhan Bank", aliases: ["shinhan"] },
  { code: "wvn", bin: "970457", shortName: "Woori Bank", aliases: ["woori", "wvn"] },
  { code: "vikki", bin: "970406", shortName: "Vikki (Đông Á)", aliases: ["vikki", "dongabank", "donga"] },
  { code: "mbv", bin: "970414", shortName: "MBV (OceanBank)", aliases: ["oceanbank", "daiduong", "mbv"] },
  { code: "cbb", bin: "970444", shortName: "CBBank", aliases: ["cbbank", "xaydung", "cbb"] },
  { code: "gpb", bin: "970408", shortName: "GPBank", aliases: ["gpbank", "gpb"] },
  { code: "kbank", bin: "668888", shortName: "KBank", aliases: ["kbank", "kasikorn"] },
  { code: "hlbvn", bin: "970442", shortName: "Hong Leong", aliases: ["hongleong"] },
  { code: "cimb", bin: "422589", shortName: "CIMB", aliases: ["cimb", "octo"] },
  { code: "ivb", bin: "970434", shortName: "Indovina", aliases: ["indovina", "ivb"] },
  { code: "uob", bin: "970458", shortName: "UOB", aliases: ["unitedoverseas", "uob"] },
  { code: "scvn", bin: "970410", shortName: "Standard Chartered", aliases: ["standardchartered"] },
  { code: "pbvn", bin: "970439", shortName: "Public Bank", aliases: ["publicbank"] },
  { code: "hsbc", bin: "458761", shortName: "HSBC", aliases: ["hsbc"] },
  { code: "citibank", bin: "533948", shortName: "Citibank", aliases: ["citibank", "citi"] },
  { code: "vrb", bin: "970421", shortName: "Việt - Nga (VRB)", aliases: ["vietnga", "vrb"] },
  { code: "ubank", bin: "546035", shortName: "Ubank", aliases: ["ubank"] },
  { code: "vtlmoney", bin: "971005", shortName: "Viettel Money", aliases: ["viettelmoney", "viettelpay"] },
  { code: "vnptmoney", bin: "971011", shortName: "VNPT Money", aliases: ["vnptmoney"] },
  { code: "vbsp", bin: "999888", shortName: "NH Chính sách XH", aliases: ["chinhsach", "vbsp"] },
];

/**
 * Đoán mã ngân hàng nhận từ text tự do user đã gõ khi tạo phiếu
 * ("VIETTINBANK", "Ngân hàng BIDV chi nhánh Trường Sơn", "MB Bank"...).
 * Trả null nếu không nhận diện được — UI sẽ cho chọn tay.
 */
export function matchRecipientBankCode(
  freeText: string | null | undefined
): string | null {
  if (!freeText) return null;
  const norm = normalizeVietnamese(freeText);
  const condensed = norm.replace(/[^a-z0-9]/g, "");
  const tokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
  if (!condensed) return null;

  for (const bank of RECIPIENT_BANKS) {
    for (const alias of bank.aliases) {
      const hit =
        alias.length >= 4
          ? condensed.includes(alias)
          : tokens.includes(alias);
      if (hit) return bank.code;
    }
  }
  return null;
}

/**
 * Nội dung chuyển khoản an toàn: bỏ dấu, chỉ giữ chữ/số/khoảng trắng,
 * cắt 70 ký tự (giới hạn nội dung CK Napas 247).
 */
export function sanitizeTransferText(s: string): string {
  return normalizeVietnamese(s)
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70)
    .trim();
}

export interface VietQRDeeplinkParams {
  /** App ngân hàng người chuyển muốn mở (VIETQR_BANK_APPS.appId). */
  appId: string;
  /** Mã ngân hàng NHẬN (RECIPIENT_BANKS.code). */
  bankCode: string;
  /** Số tài khoản nhận — tự loại khoảng trắng/ký tự lạ. */
  accountNumber: string;
  amount?: number | null;
  /** Nội dung chuyển khoản. */
  note?: string | null;
  /** Tên người nhận (hiển thị đối chiếu trong app). */
  recipientName?: string | null;
}

export function buildVietQRDeeplink(p: VietQRDeeplinkParams): string {
  const account = p.accountNumber.replace(/[^0-9a-zA-Z]/g, "");
  const qs = new URLSearchParams();
  qs.set("app", p.appId);
  qs.set("ba", `${account}@${p.bankCode}`);
  if (p.amount && p.amount > 0) qs.set("am", String(Math.round(p.amount)));
  if (p.note) qs.set("tn", sanitizeTransferText(p.note));
  if (p.recipientName) qs.set("bn", sanitizeTransferText(p.recipientName));
  return `https://dl.vietqr.io/pay?${qs.toString()}`;
}

export interface VietQRImageParams {
  /** Mã BIN Napas của ngân hàng nhận (RECIPIENT_BANKS.bin). */
  bin: string;
  accountNumber: string;
  amount?: number | null;
  /** Nội dung chuyển khoản (addInfo). */
  note?: string | null;
  /** Tên chủ tài khoản nhận. */
  accountName?: string | null;
}

/**
 * Ảnh VietQR động (img.vietqr.io) — quét là app bank tự điền đủ
 * bank/STK/số tiền/nội dung. Template compact2 = QR + logo + số tiền + tên.
 */
export function buildVietQRImageUrl(p: VietQRImageParams): string {
  const account = p.accountNumber.replace(/[^0-9a-zA-Z]/g, "");
  const qs = new URLSearchParams();
  if (p.amount && p.amount > 0) qs.set("amount", String(Math.round(p.amount)));
  if (p.note) qs.set("addInfo", sanitizeTransferText(p.note));
  if (p.accountName) qs.set("accountName", sanitizeTransferText(p.accountName));
  const query = qs.toString();
  return `https://img.vietqr.io/image/${p.bin}-${account}-compact2.png${
    query ? `?${query}` : ""
  }`;
}

/**
 * Tách tên người nhận thật từ ghi chú phiếu chi hoa hồng
 * ("Người nhận: ĐẶNG LỮ ÁI QUYÊN" → "ĐẶNG LỮ ÁI QUYÊN").
 * Phiếu thường không có pattern này → trả null.
 */
export function extractRecipientFromNotes(
  notes: string | null | undefined
): string | null {
  const m = /người nhận:\s*(.+)/i.exec(notes ?? "");
  return m ? m[1].trim() || null : null;
}
