// =============================================================================
// automation-scenario.js — QUYẾT ĐỊNH: hôm nay có gửi không, và gửi chế độ nào.
//
// Toàn bộ file là hàm THUẦN: vào là (thời điểm, cấu hình, sổ trạng thái, danh
// sách phòng) — ra là một quyết định kèm LÝ DO viết bằng tiếng Việt. Không đụng
// mạng, không đụng DB, không đọc đồng hồ. Vì thế nó test được bằng bảng tình
// huống, và người dùng đọc được đúng câu giải thích mà nhật ký hiển thị.
//
// Hai chế độ gửi (chủ dự án chốt 30/08/2026):
//   • GỌN     = link tổng + ảnh bảng danh sách kiểu Excel
//   • ĐẦY ĐỦ  = như trên, CỘNG chi tiết + ảnh từng phòng (mỗi phòng một tin)
// Chế độ của một ngày do người dùng cài theo THỨ; hai quy tắc theo THAY ĐỔI có
// thể ghi đè lên nó:
//   • có phòng trống MỚI so với lần gửi trước → nâng GỌN thành ĐẦY ĐỦ
//   • danh sách y hệt lần trước               → bỏ lượt
//
// Vì sao "bỏ lượt": người nhận bảng y hệt nhau mỗi sáng sẽ tắt thông báo nhóm,
// và một nhóm đã tắt thông báo thì mọi tin sau đó đều vô ích. Im lặng khi không
// có gì mới là cách giữ cho lần có tin thật còn được đọc.
// =============================================================================

import { KHOA_NGAY, phutTrongNgay } from './automation-config.js';

/** Lịch trễ hơn ngần này thì bỏ lượt thay vì gửi muộn (worker vừa bật lại). */
export const TRE_TOI_DA_PHUT = 180;

/**
 * Đọc một mốc thời gian theo múi giờ Việt Nam.
 * Worker có thể chạy trên VPS đặt UTC — mọi so sánh "hôm nay", "mấy giờ" đều
 * phải quy về giờ VN, nếu không lịch 08:30 sẽ nổ lúc 15:30 giờ địa phương.
 * @param {Date} now
 * @returns {{ ngay: string, thu: string, phut: number, gio: string }}
 */
export function gioVietNam(now) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const gio = `${p.hour}:${p.minute}`;
  const banDo = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
  return {
    ngay: `${p.year}-${p.month}-${p.day}`,
    thu: banDo[p.weekday] || KHOA_NGAY[0],
    phut: Number(p.hour) * 60 + Number(p.minute),
    gio,
  };
}

/** Tên thứ để viết vào lý do cho người đọc. */
const TEN_THU = {
  mon: 'Thứ 2', tue: 'Thứ 3', wed: 'Thứ 4', thu: 'Thứ 5',
  fri: 'Thứ 6', sat: 'Thứ 7', sun: 'Chủ nhật',
};

/**
 * Vân tay của danh sách phòng — đổi khi và chỉ khi thứ NGƯỜI NHẬN THẤY đổi.
 * Cố ý chỉ lấy các trường có mặt trong bảng gửi đi (mã, giá, tình trạng, ngày
 * trống): sửa một ghi chú nội bộ không phải là "có thay đổi" đối với người nhận.
 * @param {Array<{id:string,code:string,price:number,status:string,availDate:string|null}>} rooms
 */
export function vanTayDanhSach(rooms) {
  const phan = (rooms || [])
    .map((r) => [r.id, r.code, r.price, r.status, r.availDate || ''].join('|'))
    .sort();
  // FNV-1a 32-bit: đủ phân biệt cho vài trăm phòng, ngắn gọn khi ghi vào jsonb,
  // và không kéo `crypto` vào một file cố ý giữ thuần.
  let h = 0x811c9dc5;
  for (const s of phan) {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${phan.length}:${h.toString(16)}`;
}

/**
 * Đã tới lượt gửi theo lịch chưa?
 * @returns {{ chay: boolean, lyDo: string }}
 */
export function toiLuotTheoLich({ now, config, stats }) {
  const t = gioVietNam(now);
  const s = stats || {};
  const moc = phutTrongNgay(config.schedule.time);

  if (s.lastScheduledDate === t.ngay) {
    return { chay: false, lyDo: `Hôm nay (${t.ngay}) đã chạy lượt theo lịch rồi.` };
  }
  if (t.phut < moc) {
    return { chay: false, lyDo: `Chưa tới giờ gửi (${config.schedule.time}), hiện ${t.gio}.` };
  }
  if (t.phut - moc > TRE_TOI_DA_PHUT) {
    return {
      chay: false,
      lyDo: `Đã quá ${TRE_TOI_DA_PHUT} phút so với giờ hẹn ${config.schedule.time} (hiện ${t.gio}) — bỏ lượt hôm nay thay vì gửi muộn.`,
    };
  }
  return { chay: true, lyDo: `Tới giờ gửi ${config.schedule.time}.` };
}

/**
 * Thời điểm này có nằm trong khung giờ được phép gửi không?
 * Khung qua nửa đêm (vd 20:00→08:00) cũng hiểu đúng.
 */
export function trongKhungGio(now, antiSpam) {
  const t = gioVietNam(now);
  const tu = phutTrongNgay(antiSpam.allowedHours.from);
  const den = phutTrongNgay(antiSpam.allowedHours.to);
  const trong = tu <= den ? t.phut >= tu && t.phut <= den : t.phut >= tu || t.phut <= den;
  return {
    trong,
    lyDo: trong
      ? ''
      : `Ngoài khung giờ cho phép ${antiSpam.allowedHours.from}–${antiSpam.allowedHours.to} (hiện ${t.gio}).`,
  };
}

/**
 * Chọn chế độ cho LƯỢT THEO LỊCH.
 *
 * @param {object} p
 * @param {Date}   p.now
 * @param {object} p.config   đã qua chuanHoaBroadcast
 * @param {object} p.stats    sổ trạng thái trong zalo_automations.stats
 * @param {Array}  p.rooms    phòng còn chào được (đã lọc free/soon/pass)
 * @returns {{ mode:'full'|'compact'|'skipped'|'off', reason:string,
 *            hash:string, roomIds:string[], phongMoi:string[] }}
 */
export function chonCheDo({ now, config, stats, rooms }) {
  const t = gioVietNam(now);
  const s = stats || {};
  const hash = vanTayDanhSach(rooms);
  const roomIds = (rooms || []).map((r) => r.id).filter(Boolean);

  const daBiet = Array.isArray(s.knownRoomIds) ? new Set(s.knownRoomIds) : null;
  // Lần chạy ĐẦU TIÊN chưa có sổ phòng cũ. Khi đó mọi phòng đều "mới" về mặt kỹ
  // thuật — nhưng coi đó là "vừa có phòng mới" rồi nâng cấp thành ĐẦY ĐỦ là gửi
  // một tràng tin ngay lần đầu bật tính năng. Lần đầu chạy đúng chế độ của thứ.
  const phongMoi = daBiet ? roomIds.filter((id) => !daBiet.has(id)) : [];

  const goc = config.schedule.days[t.thu] || 'off';
  const tenThu = TEN_THU[t.thu] || t.thu;

  if (goc === 'off') {
    return { mode: 'off', reason: `${tenThu} được cài "không gửi".`, hash, roomIds, phongMoi };
  }
  if (!rooms || rooms.length === 0) {
    return { mode: 'skipped', reason: 'Không còn phòng nào chào được — không gửi bảng rỗng.', hash, roomIds, phongMoi };
  }

  const doiSoVoiLanTruoc = s.lastRoomsHash && s.lastRoomsHash !== hash;
  const yHetLanTruoc = s.lastRoomsHash && s.lastRoomsHash === hash;

  if (phongMoi.length && config.schedule.upgradeOnNewRooms && goc === 'compact') {
    return {
      mode: 'full',
      reason: `${tenThu} cài GỌN, nhưng có ${phongMoi.length} phòng trống MỚI so với lần gửi trước — nâng thành ĐẦY ĐỦ.`,
      hash, roomIds, phongMoi,
    };
  }
  if (yHetLanTruoc && config.schedule.skipIfUnchanged) {
    return {
      mode: 'skipped',
      reason: 'Danh sách không đổi so với lần gửi trước — bỏ lượt để người nhận không tắt thông báo.',
      hash, roomIds, phongMoi,
    };
  }

  const ten = goc === 'full' ? 'ĐẦY ĐỦ' : 'GỌN';
  const them = doiSoVoiLanTruoc ? ' (danh sách có thay đổi)' : '';
  return { mode: goc, reason: `${tenThu} theo lịch: ${ten}${them}.`, hash, roomIds, phongMoi };
}

/**
 * Lượt BỔ SUNG trong ngày: phòng vừa trống thì gửi riêng chi tiết phòng đó.
 * Gom sự kiện `debounceMinutes` rồi mới gửi — cuối tháng trả phòng hàng loạt,
 * bắn từng cái một sẽ thành súng liên thanh.
 *
 * @returns {{ gui: boolean, reason: string, phongMoi: string[] }}
 */
export function chonLuotBoSung({ now, config, stats, rooms }) {
  const s = stats || {};
  if (!config.eventDriven.enabled) {
    return { gui: false, reason: 'Gửi bổ sung khi có phòng mới đang tắt.', phongMoi: [] };
  }
  const daBiet = Array.isArray(s.knownRoomIds) ? new Set(s.knownRoomIds) : null;
  if (!daBiet) {
    return { gui: false, reason: 'Chưa có mốc so sánh — chờ lượt theo lịch đầu tiên.', phongMoi: [] };
  }
  const phongMoi = (rooms || []).map((r) => r.id).filter((id) => id && !daBiet.has(id));
  if (!phongMoi.length) {
    return { gui: false, reason: 'Không có phòng nào vừa trống.', phongMoi: [] };
  }

  // Đồng hồ gom sự kiện bắt đầu từ lần ĐẦU thấy phòng mới, không phải từ lần
  // thấy gần nhất — nếu không, phòng trống rả rích sẽ đẩy mốc chờ đi mãi và tin
  // bổ sung không bao giờ được gửi.
  const moc = s.pendingSince ? Date.parse(s.pendingSince) : NaN;
  if (!Number.isFinite(moc)) {
    return { gui: false, reason: `Vừa thấy ${phongMoi.length} phòng mới — bắt đầu gom ${config.eventDriven.debounceMinutes} phút.`, phongMoi, batDauGom: true };
  }
  const daCho = (now.getTime() - moc) / 60000;
  if (daCho < config.eventDriven.debounceMinutes) {
    return {
      gui: false,
      reason: `Đang gom sự kiện (${Math.floor(daCho)}/${config.eventDriven.debounceMinutes} phút), có ${phongMoi.length} phòng mới.`,
      phongMoi,
    };
  }
  return { gui: true, reason: `Có ${phongMoi.length} phòng vừa trống — gửi bổ sung chi tiết.`, phongMoi };
}

/**
 * Trần tin/ngày. Sổ đếm tự reset khi sang ngày mới (giờ VN).
 * @returns {{ conLai: number, daGui: number }}
 */
export function conLaiTrongTran(now, config, stats) {
  const t = gioVietNam(now);
  const s = stats || {};
  const daGui = s.sentDate === t.ngay ? Number(s.sentToday) || 0 : 0;
  return { conLai: Math.max(0, config.antiSpam.dailyCap - daGui), daGui };
}
