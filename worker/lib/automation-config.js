// =============================================================================
// automation-config.js — HỢP ĐỒNG cấu hình tự động hoá Zalo (phía worker).
//
// `zalo_automations.config` là jsonb tự do, do web ghi và worker đọc. Không có
// kiểu nào ép hai đầu khớp nhau, nên chỗ duy nhất giữ chúng khớp là cặp file:
//   • file này                                  (worker đọc)
//   • src/components/chat-zalo/automationConfig.ts (web ghi)
// Hai bản PHẢI cùng giá trị mặc định. Đó là điều kiện được canh bằng test
// worker/__tests__/automation-config.test.js — sửa một bên mà quên bên kia thì
// test đỏ, chứ không phải tới lúc worker im lặng gửi sai mới biết.
//
// Nguyên tắc đọc config: KHÔNG tin gì cả. Web có thể ghi thiếu khoá (bản cũ),
// ghi sai kiểu, hoặc người dùng sửa tay trong DB. `chuanHoa*` ép mọi thứ về
// đúng kiểu + kẹp trong khoảng an toàn rồi mới trả ra — engine phía sau chỉ làm
// việc với dữ liệu đã sạch.
// =============================================================================

/** Thứ trong tuần, 0 = Chủ nhật (khớp Date.getDay()). */
export const KHOA_NGAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Ba chế độ một ngày có thể được cài. */
export const CHE_DO_NGAY = ['full', 'compact', 'off'];

/** Ba khối nội dung của tin broadcast, theo thứ tự mặc định. */
export const KHOI_MAC_DINH = ['link', 'table_image', 'room_details'];
const KHOI_HOP_LE = new Set(KHOI_MAC_DINH);

export const MAC_DINH_BROADCAST = {
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

export const MAC_DINH_AUTO_REPLY = {
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

const laObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Ép về số nguyên trong [min,max]; giá trị rác → mặc định. */
export function soNguyen(v, macDinh, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return macDinh;
  return Math.min(max, Math.max(min, n));
}

/** "HH:MM" hợp lệ → giữ; khác → mặc định. Chấp cả "8:5" → "08:05". */
export function gioHopLe(v, macDinh) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v ?? '').trim());
  if (!m) return macDinh;
  const h = Number(m[1]);
  const p = Number(m[2]);
  if (h > 23 || p > 59) return macDinh;
  return `${String(h).padStart(2, '0')}:${String(p).padStart(2, '0')}`;
}

/** "HH:MM" → số phút từ 00:00. */
export function phutTrongNgay(hhmm) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(hhmm ?? ''));
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

const chuoiSach = (v, macDinh) => {
  const s = typeof v === 'string' ? v : '';
  return s.trim() ? s : macDinh;
};

const mangChuoi = (v, macDinh) => {
  if (!Array.isArray(v)) return [...macDinh];
  const ra = v.map((x) => String(x ?? '').trim()).filter(Boolean);
  return ra;
};

/* ------------------------------------------------------------ chuẩn hoá */

export function chuanHoaBroadcast(raw) {
  const c = laObject(raw) ? raw : {};
  const s = laObject(c.schedule) ? c.schedule : {};
  const t = laObject(c.template) ? c.template : {};
  const a = laObject(c.antiSpam) ? c.antiSpam : {};
  const e = laObject(c.eventDriven) ? c.eventDriven : {};
  const gio = laObject(a.allowedHours) ? a.allowedHours : {};

  const days = {};
  for (const k of KHOA_NGAY) {
    const v = laObject(s.days) ? s.days[k] : undefined;
    days[k] = CHE_DO_NGAY.includes(v) ? v : MAC_DINH_BROADCAST.schedule.days[k];
  }

  // Khối: giữ đúng thứ tự người dùng xếp, bỏ khối lạ, bỏ trùng. Danh sách rỗng
  // là lựa chọn HỢP LỆ (tắt hết) — không âm thầm dựng lại mặc định, vì khi đó
  // engine sẽ gửi thứ người dùng vừa tắt đi.
  const blocks = [];
  if (Array.isArray(t.blocks)) {
    for (const b of t.blocks) {
      const k = String(b ?? '').trim();
      if (KHOI_HOP_LE.has(k) && !blocks.includes(k)) blocks.push(k);
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

export function chuanHoaAutoReply(raw) {
  const c = laObject(raw) ? raw : {};
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
