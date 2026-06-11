import { normalizeVietnamese } from "@/lib/utils";

// =============================================================
// VietQR Quicklink/Deeplink — mở app ngân hàng tới màn hình
// chuyển tiền với thông tin người nhận điền sẵn.
//
// Format: https://dl.vietqr.io/pay?app=<appId>&ba=<stk>@<bankCode>&am=<số tiền>&tn=<nội dung>&bn=<tên người nhận>
// - `app`  = app ngân hàng NGƯỜI CHUYỂN muốn mở (danh sách VIETQR_BANK_APPS,
//            nguồn: https://api.vietqr.io/v2/android-app-deeplinks).
// - `ba`   = tài khoản NGƯỜI NHẬN dạng <số tk>@<mã bank> (RECIPIENT_BANKS).
// - Mức độ tự điền sẵn tuỳ app ngân hàng hỗ trợ; các app lớn (VCB, MB,
//   VietinBank, BIDV, ACB, TCB...) đều đã hỗ trợ.
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
  { code: "icb", shortName: "VietinBank", aliases: ["vietinbank", "viettinbank", "vietin", "viettin", "congthuong", "ipay", "icb"] },
  { code: "vcb", shortName: "Vietcombank", aliases: ["vietcombank", "ngoaithuong", "vcb"] },
  { code: "bidv", shortName: "BIDV", aliases: ["bidv", "dautuvaphattrien"] },
  { code: "vba", shortName: "Agribank", aliases: ["agribank", "nongnghiep", "vba"] },
  { code: "mb", shortName: "MB Bank", aliases: ["mbbank", "quandoi", "mb"] },
  { code: "tcb", shortName: "Techcombank", aliases: ["techcombank", "kythuong", "tcb"] },
  { code: "acb", shortName: "ACB", aliases: ["achau", "acb"] },
  { code: "vpb", shortName: "VPBank", aliases: ["vpbank", "thinhvuong", "vpb"] },
  { code: "tpb", shortName: "TPBank", aliases: ["tpbank", "tienphong", "tpb"] },
  { code: "stb", shortName: "Sacombank", aliases: ["sacombank", "saigonthuongtin", "stb"] },
  { code: "hdb", shortName: "HDBank", aliases: ["hdbank", "hdb"] },
  { code: "vib", shortName: "VIB", aliases: ["myvib", "vib"] },
  { code: "shb", shortName: "SHB", aliases: ["saigonhanoi", "shb"] },
  { code: "eib", shortName: "Eximbank", aliases: ["eximbank", "eib"] },
  { code: "msb", shortName: "MSB", aliases: ["maritime", "hanghai", "msb"] },
  { code: "scb", shortName: "SCB", aliases: ["scb"] },
  { code: "seab", shortName: "SeABank", aliases: ["seabank", "dongnama", "seab"] },
  { code: "ocb", shortName: "OCB", aliases: ["phuongdong", "ocb"] },
  { code: "nab", shortName: "Nam Á Bank", aliases: ["namabank", "nama", "nab"] },
  { code: "lpb", shortName: "LPBank", aliases: ["lpbank", "lienviet", "locphat", "buudien", "lpb"] },
  { code: "klb", shortName: "KienlongBank", aliases: ["kienlong", "klb"] },
  { code: "ncb", shortName: "NCB", aliases: ["quocdan", "ncb"] },
  { code: "abb", shortName: "ABBANK", aliases: ["abbank", "anbinh", "abb"] },
  { code: "bvb", shortName: "BaoViet Bank", aliases: ["baoviet", "bvb"] },
  { code: "vab", shortName: "VietABank", aliases: ["vietabank", "vieta", "vab"] },
  { code: "pvcb", shortName: "PVcomBank", aliases: ["pvcombank", "daichung", "pvcb"] },
  { code: "bab", shortName: "BacABank", aliases: ["bacabank", "baca", "bab"] },
  { code: "pgb", shortName: "PGBank", aliases: ["pgbank", "pgb"] },
  // cake/timo/momo đứng trước vccb: "Timo by Ban Viet Bank" phải ra Timo, không phải Bản Việt
  { code: "cake", shortName: "CAKE", aliases: ["cake"] },
  { code: "timo", shortName: "Timo", aliases: ["timo"] },
  { code: "momo", shortName: "MoMo", aliases: ["momo"] },
  { code: "vccb", shortName: "BVBank (Bản Việt)", aliases: ["banviet", "vietcapital", "bvbank", "vccb"] },
  { code: "sgicb", shortName: "SaigonBank", aliases: ["saigonbank", "saigoncongthuong", "sgicb"] },
  { code: "vietbank", shortName: "Vietbank", aliases: ["vietbank", "vietnamthuongtin"] },
  { code: "coopbank", shortName: "Co-opBank", aliases: ["coopbank", "hoptacxa"] },
  { code: "shbvn", shortName: "Shinhan Bank", aliases: ["shinhan"] },
  { code: "wvn", shortName: "Woori Bank", aliases: ["woori", "wvn"] },
  { code: "vikki", shortName: "Vikki (Đông Á)", aliases: ["vikki", "dongabank", "donga"] },
  { code: "mbv", shortName: "MBV (OceanBank)", aliases: ["oceanbank", "daiduong", "mbv"] },
  { code: "cbb", shortName: "CBBank", aliases: ["cbbank", "xaydung", "cbb"] },
  { code: "gpb", shortName: "GPBank", aliases: ["gpbank", "gpb"] },
  { code: "kbank", shortName: "KBank", aliases: ["kbank", "kasikorn"] },
  { code: "hlbvn", shortName: "Hong Leong", aliases: ["hongleong"] },
  { code: "cimb", shortName: "CIMB", aliases: ["cimb", "octo"] },
  { code: "ivb", shortName: "Indovina", aliases: ["indovina", "ivb"] },
  { code: "uob", shortName: "UOB", aliases: ["unitedoverseas", "uob"] },
  { code: "scvn", shortName: "Standard Chartered", aliases: ["standardchartered"] },
  { code: "pbvn", shortName: "Public Bank", aliases: ["publicbank"] },
  { code: "hsbc", shortName: "HSBC", aliases: ["hsbc"] },
  { code: "citibank", shortName: "Citibank", aliases: ["citibank", "citi"] },
  { code: "vrb", shortName: "Việt - Nga (VRB)", aliases: ["vietnga", "vrb"] },
  { code: "ubank", shortName: "Ubank", aliases: ["ubank"] },
  { code: "vtlmoney", shortName: "Viettel Money", aliases: ["viettelmoney", "viettelpay"] },
  { code: "vnptmoney", shortName: "VNPT Money", aliases: ["vnptmoney"] },
  { code: "vbsp", shortName: "NH Chính sách XH", aliases: ["chinhsach", "vbsp"] },
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
