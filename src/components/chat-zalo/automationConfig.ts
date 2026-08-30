// =============================================================================
// automationConfig.ts — HỢP ĐỒNG cấu hình tự động hoá Zalo (phía web).
//
// ĐÂY LÀ MỘT NỬA CỦA MỘT CẶP. Nửa kia là `worker/lib/automation-config.js`.
//   • web (file này)  GHI  `zalo_automations.config`
//   • worker          ĐỌC  `zalo_automations.config`
// Cột đó là `jsonb` tự do: không kiểu nào, không constraint nào ép hai đầu khớp
// nhau. Chỗ duy nhất giữ chúng khớp là kỷ luật giữ hai file này cùng giá trị —
// nên nó được canh bằng test, không bằng lời hứa:
//   `src/components/chat-zalo/__tests__/automationConfig.test.ts` nạp CẢ HAI
//   module rồi so từng mặc định và từng kết quả chuẩn hoá. Sửa một bên mà quên
//   bên kia thì test đỏ ngay, chứ không phải tới lúc worker im lặng gửi sai
//   giờ / sai nhịp / sai khối nội dung mới biết.
//
// SỬA Ở ĐÂY THÌ SỬA LUÔN BÊN KIA. Cả hai chiều đều đúng: đổi mặc định bên worker
// mà quên bên này thì form web ghi đè giá trị cũ lên DB ngay lần lưu đầu tiên.
//
// Nguyên tắc đọc config giống hệt bản worker: KHÔNG TIN GÌ CẢ. Bản ghi cũ thiếu
// khoá, người dùng sửa tay trong DB, hay một phiên bản web cũ ghi sai kiểu — tất
// cả đều là đầu vào hợp lệ của `chuanHoa*`. Hàm đó ép về đúng kiểu + kẹp trong
// khoảng an toàn rồi mới trả ra; phần UI phía sau chỉ làm việc với dữ liệu sạch.
// =============================================================================

/* ------------------------------------------------------------------ kiểu */

/** Thứ trong tuần, 0 = Chủ nhật (khớp `Date.getDay()`). */
export type KhoaNgay = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

/** Ba chế độ một ngày có thể được cài: bảng đầy đủ · bảng gọn · không gửi. */
export type CheDoNgay = 'full' | 'compact' | 'off';

/** Ba khối nội dung của tin broadcast. */
export type KhoiTin = 'link' | 'table_image' | 'room_details';

/** Lịch theo thứ: mỗi ngày trong tuần một chế độ. */
export type LichNgay = Record<KhoaNgay, CheDoNgay>;

/** Khung giờ được phép gửi, "HH:MM" 24h. */
export interface KhungGio {
  from: string;
  to: string;
}

export interface LichGui {
  /** Giờ hẹn gửi trong ngày, "HH:MM". */
  time: string;
  days: LichNgay;
  /** Có phòng mới thì nâng ngày `compact` lên `full`. */
  upgradeOnNewRooms: boolean;
  /** Danh sách phòng y hệt lần trước thì bỏ lượt. */
  skipIfUnchanged: boolean;
}

export interface GuiTheoSuKien {
  enabled: boolean;
  /** Gom sự kiện "có phòng mới" trong bấy nhiêu phút rồi mới gửi một tin. */
  debounceMinutes: number;
}

export interface MauTin {
  /** Giữ đúng thứ tự người dùng xếp. Rỗng = tắt hết, là lựa chọn HỢP LỆ. */
  blocks: KhoiTin[];
  introText: string;
  roomTemplate: string;
  shareUrl: string;
}

export interface ChongSpam {
  allowedHours: KhungGio;
  gapBetweenRecipientsSec: number;
  gapBetweenRoomMsgsSec: number;
  maxRoomsPerRun: number;
  dailyCap: number;
}

export interface CauHinhBroadcast {
  /** Thread id Zalo nhận tin. Đã khử trùng lặp. */
  recipients: string[];
  schedule: LichGui;
  eventDriven: GuiTheoSuKien;
  template: MauTin;
  antiSpam: ChongSpam;
}

export interface CauHinhAutoReply {
  keywords: string[];
  blockedKeywords: string[];
  replyIntro: string;
  includeRoomList: boolean;
  cooldownMinutes: number;
  dailyCap: number;
}

/* ------------------------------------------------------------------ hằng */

export const KHOA_NGAY: readonly KhoaNgay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const CHE_DO_NGAY: readonly CheDoNgay[] = ['full', 'compact', 'off'];

/** Ba khối nội dung của tin broadcast, theo thứ tự mặc định. */
export const KHOI_MAC_DINH: readonly KhoiTin[] = ['link', 'table_image', 'room_details'];
const KHOI_HOP_LE: ReadonlySet<string> = new Set<string>(KHOI_MAC_DINH);

export const MAC_DINH_BROADCAST: CauHinhBroadcast = {
  recipients: [],
  schedule: {
    time: '08:30',
    days: { mon: 'full', tue: 'compact', wed: 'compact', thu: 'compact', fri: 'compact', sat: 'compact', sun: 'off' },
    upgradeOnNewRooms: true,
    skipIfUnchanged: true,
  },
  eventDriven: { enabled: true, debounceMinutes: 45 },
  template: {
    blocks: [...KHOI_MAC_DINH],
    introText: 'iHome cập nhật phòng trống {ngay} — hiện có {so_phong} phòng còn chào được.\nBảng đầy đủ (luôn mới nhất): {link}',
    roomTemplate: 'PHÒNG {ma_phong} — {dia_chi}\nGiá {gia}đ/tháng · {dien_tich} · {loai_phong}\nNội thất: {noi_that}\nTình trạng: {tinh_trang}\nXem phòng liên hệ: {hotline}',
    shareUrl: '',
  },
  antiSpam: {
    allowedHours: { from: '08:00', to: '20:00' },
    gapBetweenRecipientsSec: 180,
    gapBetweenRoomMsgsSec: 20,
    maxRoomsPerRun: 5,
    dailyCap: 120,
  },
};

export const MAC_DINH_AUTO_REPLY: CauHinhAutoReply = {
  keywords: ['phòng', 'giá', 'trống', 'còn ko', 'còn không', 'xem phòng'],
  // Tiền, hợp đồng, tranh chấp: máy KHÔNG tự trả lời. Một câu sai về cọc hay
  // hợp đồng là chuyện pháp lý, không phải chuyện chăm sóc khách hàng — những
  // tin này để người thật xử lý, dù có khớp từ khoá bên trên.
  blockedKeywords: ['cọc', 'chuyển khoản', 'hợp đồng', 'thanh toán', 'hoá đơn', 'hóa đơn', 'khiếu nại', 'hoàn tiền'],
  replyIntro: 'Dạ chào anh/chị, em gửi danh sách phòng trống mới nhất bên iHome ạ:',
  includeRoomList: true,
  cooldownMinutes: 30,
  dailyCap: 50,
};

/* ---------------------------------------------------------------- helpers */

const laObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const laCheDoNgay = (v: unknown): v is CheDoNgay =>
  typeof v === 'string' && (CHE_DO_NGAY as readonly string[]).includes(v);

const laKhoiTin = (v: string): v is KhoiTin => KHOI_HOP_LE.has(v);

/** Ép về số nguyên trong [min,max]; giá trị rác → mặc định. */
export function soNguyen(v: unknown, macDinh: number, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return macDinh;
  return Math.min(max, Math.max(min, n));
}

/** "HH:MM" hợp lệ → giữ; khác → mặc định. Chấp cả "8:5" → "08:05". */
export function gioHopLe(v: unknown, macDinh: string): string {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v ?? '').trim());
  if (!m) return macDinh;
  const h = Number(m[1]);
  const p = Number(m[2]);
  if (h > 23 || p > 59) return macDinh;
  return `${String(h).padStart(2, '0')}:${String(p).padStart(2, '0')}`;
}

/** "HH:MM" → số phút từ 00:00. */
export function phutTrongNgay(hhmm: unknown): number {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(hhmm ?? ''));
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

const chuoiSach = (v: unknown, macDinh: string): string => {
  const s = typeof v === 'string' ? v : '';
  return s.trim() ? s : macDinh;
};

const mangChuoi = (v: unknown, macDinh: readonly string[]): string[] => {
  if (!Array.isArray(v)) return [...macDinh];
  const ra = v.map((x) => String(x ?? '').trim()).filter(Boolean);
  return ra;
};

/* ------------------------------------------------------------ chuẩn hoá */

export function chuanHoaBroadcast(raw: unknown): CauHinhBroadcast {
  const c: Record<string, unknown> = laObject(raw) ? raw : {};
  const s: Record<string, unknown> = laObject(c.schedule) ? c.schedule : {};
  const t: Record<string, unknown> = laObject(c.template) ? c.template : {};
  const a: Record<string, unknown> = laObject(c.antiSpam) ? c.antiSpam : {};
  const e: Record<string, unknown> = laObject(c.eventDriven) ? c.eventDriven : {};
  const gio: Record<string, unknown> = laObject(a.allowedHours) ? a.allowedHours : {};
  const ngay: Record<string, unknown> = laObject(s.days) ? s.days : {};

  // Bắt đầu từ mặc định rồi chỉ ghi đè ngày nào hợp lệ — cùng kết quả với vòng
  // lặp `days[k] = hợp lệ ? v : mặc định[k]` bên worker, chỉ khác cách viết.
  const days: LichNgay = { ...MAC_DINH_BROADCAST.schedule.days };
  for (const k of KHOA_NGAY) {
    const v = ngay[k];
    if (laCheDoNgay(v)) days[k] = v;
  }

  // Khối: giữ đúng thứ tự người dùng xếp, bỏ khối lạ, bỏ trùng. Danh sách rỗng
  // là lựa chọn HỢP LỆ (tắt hết) — không âm thầm dựng lại mặc định, vì khi đó
  // engine sẽ gửi thứ người dùng vừa tắt đi.
  const blocks: KhoiTin[] = [];
  const blocksRaw = t.blocks;
  if (Array.isArray(blocksRaw)) {
    for (const b of blocksRaw) {
      const k = String(b ?? '').trim();
      if (laKhoiTin(k) && !blocks.includes(k)) blocks.push(k);
    }
  } else {
    blocks.push(...KHOI_MAC_DINH);
  }

  return {
    recipients: [...new Set(mangChuoi(c.recipients, []))],
    schedule: {
      time: gioHopLe(s.time, MAC_DINH_BROADCAST.schedule.time),
      days,
      upgradeOnNewRooms: s.upgradeOnNewRooms !== false,
      skipIfUnchanged: s.skipIfUnchanged !== false,
    },
    eventDriven: {
      enabled: e.enabled !== false,
      debounceMinutes: soNguyen(e.debounceMinutes, MAC_DINH_BROADCAST.eventDriven.debounceMinutes, 5, 720),
    },
    template: {
      blocks,
      introText: chuoiSach(t.introText, MAC_DINH_BROADCAST.template.introText),
      roomTemplate: chuoiSach(t.roomTemplate, MAC_DINH_BROADCAST.template.roomTemplate),
      shareUrl: typeof t.shareUrl === 'string' ? t.shareUrl.trim() : '',
    },
    antiSpam: {
      allowedHours: {
        from: gioHopLe(gio.from, MAC_DINH_BROADCAST.antiSpam.allowedHours.from),
        to: gioHopLe(gio.to, MAC_DINH_BROADCAST.antiSpam.allowedHours.to),
      },
      // Trần trên là phanh cứng, không phải gợi ý: người dùng gõ nhầm 0 vào ô
      // "giãn nhịp" sẽ biến broadcast thành một tràng tin liên tiếp — đúng dấu
      // hiệu bot mà Zalo khoá nick.
      gapBetweenRecipientsSec: soNguyen(a.gapBetweenRecipientsSec, MAC_DINH_BROADCAST.antiSpam.gapBetweenRecipientsSec, 30, 3600),
      gapBetweenRoomMsgsSec: soNguyen(a.gapBetweenRoomMsgsSec, MAC_DINH_BROADCAST.antiSpam.gapBetweenRoomMsgsSec, 5, 600),
      maxRoomsPerRun: soNguyen(a.maxRoomsPerRun, MAC_DINH_BROADCAST.antiSpam.maxRoomsPerRun, 1, 30),
      dailyCap: soNguyen(a.dailyCap, MAC_DINH_BROADCAST.antiSpam.dailyCap, 1, 2000),
    },
  };
}

export function chuanHoaAutoReply(raw: unknown): CauHinhAutoReply {
  const c: Record<string, unknown> = laObject(raw) ? raw : {};
  const kw = mangChuoi(c.keywords, MAC_DINH_AUTO_REPLY.keywords).map((s) => s.toLowerCase());
  const blocked = mangChuoi(c.blockedKeywords, MAC_DINH_AUTO_REPLY.blockedKeywords).map((s) => s.toLowerCase());
  return {
    // Không từ khoá nào = auto-reply không kích hoạt bao giờ. Đó là trạng thái
    // hợp lệ (tắt mềm), không phải lý do để nhét lại danh sách mặc định.
    keywords: [...new Set(kw)],
    // Danh sách chặn thì NGƯỢC LẠI: rỗng thì lấy lại mặc định. Người dùng xoá
    // sạch nó không có nghĩa là họ muốn máy tự trả lời về cọc và hợp đồng.
    blockedKeywords: blocked.length ? [...new Set(blocked)] : [...MAC_DINH_AUTO_REPLY.blockedKeywords],
    replyIntro: chuoiSach(c.replyIntro, MAC_DINH_AUTO_REPLY.replyIntro),
    includeRoomList: c.includeRoomList !== false,
    cooldownMinutes: soNguyen(c.cooldownMinutes, MAC_DINH_AUTO_REPLY.cooldownMinutes, 1, 1440),
    dailyCap: soNguyen(c.dailyCap, MAC_DINH_AUTO_REPLY.dailyCap, 1, 1000),
  };
}
