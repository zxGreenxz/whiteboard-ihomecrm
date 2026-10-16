// =============================================================================
// automation.js — ENGINE broadcast phòng trống định kỳ.
//
// Vòng đời một lượt: đọc cấu hình → hỏi automation-scenario "gửi không, chế độ
// nào" → dựng nội dung → XẾP HÀNG vào zalo_send_queue với `not_before` rải sẵn →
// ghi nhật ký → cập nhật sổ trạng thái.
//
// VÌ SAO ĐI QUA HÀNG ĐỢI thay vì gọi thẳng zca:
//   • `not_before` biến việc rải nhịp thành dữ liệu, không phải một chuỗi
//     setTimeout trong RAM — worker restart giữa chừng thì phần chưa gửi vẫn còn
//     và vẫn đúng giờ, thay vì mất hoặc bắn dồn một cục;
//   • claim nguyên tử của queue.js chống gửi trùng;
//   • tin tự động hiện trong khung chat y như tin người gửi, và lỗi gửi vào
//     đúng chỗ mà mọi lỗi gửi khác đã nằm.
//
// AN TOÀN NICK ZALO là ràng buộc thiết kế, không phải tính năng phụ: zca-js là
// API không chính thức. Ba phanh cứng — khung giờ, giãn nhịp, trần tin/ngày —
// đều kiểm TRƯỚC khi xếp hàng, và trần ngày được trừ dần theo số tin thật sự
// xếp được chứ không phải theo số tin dự định.
// =============================================================================
import { createHash } from 'node:crypto';
import { sb, log, orgOf, sessions } from './ctx.js';
import { chuanHoaBroadcast } from './automation-config.js';
import {
  chonCheDo, chonLuotBoSung, conLaiTrongTran, gioVietNam,
  toiLuotTheoLich, trongKhungGio,
} from './automation-scenario.js';
import { docPhongTrong } from './vacant-rooms.js';
import { buildRoomListTable } from './room-list-table.js';
import { veAnhDanhSach } from './room-list-image.js';
import { chuanBiAnhPhong } from './automation-room-image.js';
import { tickHermesSchedules } from './hermes-schedule.js';
import { INSTANCE_ID } from './lease.js';

/** Nhịp chạy engine. Lịch tính theo phút nên 60s là đủ mịn. */
export const AUTOMATION_MS = 60_000;

const BUCKET = 'zalo-media';

/** Danh sách phòng = trang Sale Phòng; không có link chia sẻ còn hiệu lực ≠ hết phòng. */
const KHONG_CO_TRANG_SALE = 'Công ty chưa có link chia sẻ trang Sale phòng còn hiệu lực nên không có danh sách phòng đang đăng để gửi (không phải hết phòng). Tạo hoặc bật lại link ở trang Sale phòng.';

/* ------------------------------------------------------------------ tiện ích */

/** Tách {bucket, path} từ URL Supabase Storage đã lưu (khớp src/lib/storage.ts). */
export function tachRefStorage(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.startsWith('blob:') || value.startsWith('data:')) return null;
  const m = value.match(/\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/);
  if (!m?.[1] || !m?.[2]) return null;
  return { bucket: m[1], path: decodeURIComponent(m[2]) };
}

/** Thay {khoa} trong mẫu tin. Khoá thiếu → chuỗi rỗng, KHÔNG để lộ dấu ngoặc. */
export function dienMau(mau, gt) {
  return String(mau || '').replace(/\{(\w+)\}/g, (_, k) => {
    const v = gt[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

const dinhDangTien = (trieu) => (trieu > 0 ? (Math.round(trieu * 1000) * 1000).toLocaleString('vi-VN') : 'liên hệ');

const TEN_TRANG_THAI = { free: 'Trống sẵn', soon: 'Sắp trống', pass: 'Khách pass phòng' };

/** Địa chỉ gửi Zalo chỉ giữ số nhà và tên đường đã lưu, không đoán tên đầy đủ. */
export function diaChiSoVaDuong(value) {
  const parts = String(value || '').trim().split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  let address = parts[0] || '';
  // Some records separate the house number and street with a comma.
  if (/^(?:số\s+)?\d[\d/.\-]*\p{L}?$/iu.test(address) && parts[1]
      && !/^(?:phường|xã|quận|huyện|tỉnh|thành phố|khu phố|p\.|q\.|tp\.)\s*/iu.test(parts[1])) {
    address += ` ${parts[1]}`;
  }
  return address.replace(/\s+(?:phường|xã|quận|huyện|tỉnh|thành phố|khu phố|p\.|q\.|tp\.)(?:\s|\d).*$/iu, '').trim();
}

/** Một tin chi tiết phòng (chế độ ĐẦY ĐỦ / lượt bổ sung). */
export function soanTinPhong(room, mau, hotline) {
  const tinhTrang = room.saleFact?.label || (room.status === 'soon' && room.availDate
    ? `Sắp trống ${room.availDate}`
    : (TEN_TRANG_THAI[room.status] || room.status));
  return dienMau(mau, {
    ma_phong: room.code,
    dia_chi: diaChiSoVaDuong(room.buildingAddr || room.buildingName),
    toa: room.buildingName,
    gia: dinhDangTien(room.price),
    dien_tich: room.area > 0 ? `${room.area}m²` : '',
    loai_phong: room.type || '',
    noi_that: room.amenities.join(', ') || room.description || '',
    tinh_trang: tinhTrang,
    khuyen_mai: room.saleNote || '',
    hotline: hotline || '',
  }).replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------- xếp hàng một tin */

/**
 * Chèn 1 dòng zalo_messages (pending) + 1 job zalo_send_queue hẹn giờ.
 * Trả về true nếu xếp được.
 */
async function xepMotTin({ conv, khiNao, body, anh, requestKey, oneshotId }) {
  try {
    // One transaction reserves quota and creates both rows. Retrying the same
    // logical run after a lost response reuses its message/job, never resends it.
    // A one-shot run goes through its own SQL gate (the shot, not the schedule
    // switch/recipient list, is the authority); quota/hours/day checks are shared.
    const tin = {
      p_conversation_id: conv.id,
      p_body: body || '',
      p_not_before: khiNao.toISOString(),
      p_request_key: requestKey,
      p_attachment: anh ? (Array.isArray(anh) ? anh.map(refAnh) : refAnh(anh)) : null,
    };
    const { data, error } = oneshotId
      ? await sb.rpc('zalo_enqueue_broadcast_oneshot_v1', { p_oneshot_id: oneshotId, p_instance_id: INSTANCE_ID, ...tin })
      : await sb.rpc('zalo_enqueue_broadcast_v1', tin);
    if (error) throw new Error(error.message);
    if (data?.status === 'queued') return true;
    if (data?.status === 'skipped') {
      log('automation: không xếp tin', conv.id, data.reason);
      return false;
    }
    throw new Error('Không xác nhận được kết quả xếp tin tự động');
  } catch (e) {
    log('automation: xếp tin lỗi', conv.id, e?.message || e);
    return false;
  }
}

const refAnh = anh => ({ bucket: anh.bucket, path: anh.path, url: anh.url, filename: anh.filename,
  width: anh.width, height: anh.height, mime: anh.mime, size: anh.size });

/* ------------------------------------------------------------ ghi nhật ký */

async function ghiNhatKy(row) {
  const { error } = await sb.from('zalo_automation_runs').insert(row);
  if (error) log('automation: ghi nhật ký lỗi', error.message);
}

async function luuSo(autoId, stats) {
  // Only while still enabled: after an emergency stop the row's updated_at (also
  // stamped by trigger set_zalo_automations_updated_at) must stay at the stop — a
  // later user save is what lifts the stop for one-shots.
  const { error } = await sb.from('zalo_automations')
    .update({ stats, updated_at: new Date().toISOString() }).eq('id', autoId).eq('enabled', true);
  if (error) log('automation: lưu sổ lỗi', error.message);
}

/* --------------------------------------------------------- dựng & gửi lô */

/**
 * Xếp hàng một lô tin cho toàn bộ người nhận.
 * @returns {Promise<{soTin:number, soNguoiNhan:number}>}
 */
async function xepLo({ convs, config, khoi, anhBang, vanBanMoDau, tinPhong, tranConLai, runKey, now, oneshotId }) {
  const gapNguoi = config.antiSpam.gapBetweenRecipientsSec;
  const gapTin = config.antiSpam.gapBetweenRoomMsgsSec;
  const bayGio = Date.now();
  let soTin = 0;
  let soNguoiNhan = 0;
  let soBoQuaKhungGio = 0;
  let soKhongXepDuoc = 0;
  const ngayLuot = gioVietNam(now).ngay;
  const duKien = convs.length * ((khoi.includes('link') && vanBanMoDau ? 1 : 0)
    + (khoi.includes('table_image') ? 1 : 0)
    + (khoi.includes('room_details') ? tinPhong.reduce((sum, t) => sum + t.soTinDuKien, 0) : 0));

  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    // Người nhận thứ i bắt đầu muộn hơn người trước `gapNguoi` giây — cả lô rải
    // đều thay vì bắn dồn, đó là khác biệt giữa "một người đang nhắn tin" và
    // "một con bot" dưới mắt hệ thống chống spam.
    let offset = i * gapNguoi;
    let daGuiChoNguoiNay = false;
    const xep = async (logicalKey, content) => {
      const khiNao = new Date(bayGio + offset * 1000);
      // Identity follows the content's purpose, never its current display
      // position. Room reorder/config reorder during retry cannot swap receipts.
      const requestKey = `${runKey}:${conv.id}:${logicalKey}`;
      offset += gapTin;
      // No stale room broadcast on the next day, even for an overnight window.
      if (gioVietNam(khiNao).ngay !== ngayLuot || !trongKhungGio(khiNao, config.antiSpam).trong) {
        soBoQuaKhungGio++;
        return false;
      }
      if (await xepMotTin({ conv, khiNao, requestKey, oneshotId, ...content })) {
        soTin++; daGuiChoNguoiNay = true;
        return true;
      }
      soKhongXepDuoc++;
      return false;
    };

    for (const k of khoi) {
      if (soTin >= tranConLai) break;

      if (k === 'link' && vanBanMoDau) {
        await xep('link', { body: vanBanMoDau });
      } else if (k === 'table_image') {
        if (anhBang) await xep('table_image', { anh: anhBang });
        else soKhongXepDuoc++;
      } else if (k === 'room_details') {
        for (const t of tinPhong) {
          if (t.loiAnh) { soKhongXepDuoc += t.soTinDuKien; continue; }
          // Reserve room-sized space before starting: never deliberately cut
          // off its photos or final information/separator at a quota boundary.
          if (soTin + t.soTinDuKien > tranConLai) break;
          const messages = [
            ...(t.anh.length ? [{ key: `room:${t.roomId}:album`, anh: t.anh }] : []),
            { key: `room:${t.roomId}`, body: t.body },
          ];
          if (messages.some((_, index) => {
            const due = new Date(bayGio + (offset + index * gapTin) * 1000);
            return gioVietNam(due).ngay !== ngayLuot || !trongKhungGio(due, config.antiSpam).trong;
          })) {
            soBoQuaKhungGio += messages.length;
            offset += messages.length * gapTin;
            continue;
          }
          for (let j = 0; j < messages.length; j++) {
            const { key, ...content } = messages[j];
            if (!await xep(key, content)) {
              soKhongXepDuoc += messages.length - j - 1;
              break;
            }
          }
        }
      }
    }
    if (daGuiChoNguoiNay) soNguoiNhan++;
  }
  return { soTin, soNguoiNhan, soBoQuaKhungGio, soKhongXepDuoc,
    soChuaXep: Math.max(0, duKien - soTin),
    soBoQuaTran: Math.max(0, duKien - soTin - soBoQuaKhungGio - soKhongXepDuoc) };
}

/** Render ảnh bảng + upload lên bucket zalo-media. Trả null nếu không dựng được. */
async function dungAnhBang(buildings, accountId, now) {
  const table = buildRoomListTable(buildings.map(b => ({ ...b, address: diaChiSoVaDuong(b.address || b.name) })));
  if (!table.totalRooms) return null;
  let buf;
  try {
    buf = await veAnhDanhSach(table);
  } catch (e) {
    log('automation: vẽ ảnh bảng lỗi', e?.message || e);
    return null;
  }
  const t = gioVietNam(now);
  // Path bắt đầu bằng account_id — policy đọc của bucket kiểm đúng đoạn đầu này
  // (storage.foldername(name))[1], nên người trong công ty vẫn xem lại được ảnh
  // trong lịch sử chat.
  const filename = `danh-sach-phong-trong-${t.ngay}-${Date.now().toString(36)}.png`;
  const path = `${accountId}/automation/${filename}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, buf, {
    contentType: 'image/png', upsert: true,
  });
  if (error) {
    log('automation: upload ảnh bảng lỗi', error.message);
    return null;
  }
  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
  return { bucket: BUCKET, path, filename, url: pub?.publicUrl || '', soPhong: table.totalRooms };
}

/* -------------------------------------------------------------- một công ty */

async function xuLyMotCongTy(auto, now) {
  const config = chuanHoaBroadcast(auto.config);
  const stats = auto.stats && typeof auto.stats === 'object' ? { ...auto.stats } : {};
  const orgId = auto.organization_id;

  if (!config.recipients.length) return;

  // Người nhận: chỉ hội thoại còn tồn tại, thuộc đúng công ty, và tài khoản Zalo
  // của nó đang có phiên sống. Xếp hàng cho tài khoản đã rớt chỉ tạo ra một đống
  // job failed và một khung chat đầy tin đỏ.
  const { data: convsTho } = await sb.from('zalo_conversations')
    .select('id, user_id, organization_id, account_id, peer_name, thread_type, is_sale_partner')
    .in('id', config.recipients)
    .eq('organization_id', orgId);
  const convs = (convsTho || []).filter((c) => sessions.has(c.account_id));
  if (!convs.length) return;

  const accountId = convs[0].account_id;

  const khung = trongKhungGio(now, config.antiSpam);
  const { conLai } = conLaiTrongTran(now, config, stats);

  let phong;
  try {
    phong = await docPhongTrong(orgId);
  } catch (e) {
    await ghiNhatKy({
      organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant',
      mode: 'failed', reason: `Không đọc được danh sách phòng: ${e?.message || e}`,
    });
    return;
  }

  const t = gioVietNam(now);

  /* ---- Lượt theo lịch ---- */
  const luot = toiLuotTheoLich({ now, config, stats });
  if (luot.chay) {
    const qd = chonCheDo({ now, config, stats, rooms: phong.rooms });
    if (qd.mode === 'skipped' && !phong.rooms.length && phong.trangSale === 0) qd.reason = KHONG_CO_TRANG_SALE;

    // Dù không gửi, vẫn ĐÓNG SỔ ngày hôm nay: nếu không, mỗi phút engine lại
    // xét lại cùng một lượt và nhật ký ngập những dòng giống hệt nhau.
    stats.lastScheduledDate = t.ngay;
    stats.lastRunAt = now.toISOString();

    if (qd.mode === 'off' || qd.mode === 'skipped') {
      stats.knownRoomIds = qd.roomIds;
      stats.lastRoomsHash = qd.hash;
      await luuSo(auto.id, stats);
      await ghiNhatKy({
        organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant',
        mode: qd.mode, reason: qd.reason,
        detail: { so_phong: phong.rooms.length, che_do_cai: config.schedule.days[t.thu] },
      });
      return;
    }

    if (!khung.trong) {
      await luuSo(auto.id, stats);
      await ghiNhatKy({
        organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant',
        mode: 'skipped', reason: khung.lyDo, detail: { che_do_dinh_gui: qd.mode },
      });
      return;
    }
    if (conLai <= 0) {
      await luuSo(auto.id, stats);
      await ghiNhatKy({
        organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant',
        mode: 'skipped',
        reason: `Đã chạm trần ${config.antiSpam.dailyCap} tin tự động trong ngày.`,
      });
      return;
    }

    const ketQua = await guiLo({
      convs, config, phong, accountId, orgId, now,
      runKey: `scheduled:${t.ngay}`,
      day: qd.mode === 'full', tranConLai: conLai,
    });

    if (ketQua.soTin === 0 && ketQua.soKhongXepDuoc > 0) {
      // No positive enqueue receipts: leave lastScheduledDate/knownRoomIds and
      // quota unchanged. Stable keys reconcile a lost response on the next tick.
      await ghiNhatKy({
        organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant',
        mode: 'failed', reason: 'Chưa xác nhận được tin nào được xếp hàng. Lượt chưa hoàn tất; sẽ xét lại trong khung giờ hợp lệ.',
        recipients_count: 0, messages_count: 0,
        detail: { che_do_dinh_gui: qd.mode, retry_pending: true, partial: false,
          khong_xep_duoc: ketQua.soKhongXepDuoc, bo_qua_khung_gio: ketQua.soBoQuaKhungGio },
      });
      return;
    }

    stats.knownRoomIds = qd.roomIds;
    stats.lastRoomsHash = qd.hash;
    stats.pendingSince = null;
    if (qd.mode === 'full') stats.lastFullAt = now.toISOString();
    congSoTin(stats, t.ngay, ketQua.soTin);
    await luuSo(auto.id, stats);

    await ghiNhatKy({
      organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant',
      mode: ketQua.soChuaXep > 0 ? 'failed' : qd.mode,
      reason: ketQua.soChuaXep > 0
        ? `Chỉ xếp hàng được một phần (${ketQua.soTin} tin); còn ${ketQua.soChuaXep} tin chưa xếp. Không tự chạy lại phần còn thiếu.`
        : `Đã xếp hàng ${ketQua.soTin} tin. ${qd.reason}`,
      recipients_count: ketQua.soNguoiNhan, messages_count: ketQua.soTin,
      detail: {
        so_phong: phong.rooms.length,
        phong_moi: qd.phongMoi.length,
        co_anh_bang: !!ketQua.anhBang,
        so_phong_gui_chi_tiet: ketQua.soPhongChiTiet,
        bo_qua_khung_gio: ketQua.soBoQuaKhungGio,
        khong_xep_duoc: ketQua.soKhongXepDuoc,
        bo_qua_tran: ketQua.soBoQuaTran,
        partial: ketQua.soTin > 0 && ketQua.soChuaXep > 0,
        retry_pending: false,
        che_do_dinh_gui: qd.mode,
      },
    });
    return;
  }

  /* ---- Lượt bổ sung: phòng vừa trống trong ngày ---- */
  const bs = chonLuotBoSung({ now, config, stats, rooms: phong.rooms });
  if (bs.batDauGom) {
    stats.pendingSince = now.toISOString();
    await luuSo(auto.id, stats);
    return;
  }
  if (!bs.gui) return;
  if (!khung.trong || conLai <= 0) {
    // Chưa tới giờ được phép gửi thì GIỮ mốc gom: tin bổ sung sẽ đi ngay khi
    // vào khung giờ, chứ không bị nuốt mất.
    return;
  }

  const idMoi = new Set(bs.phongMoi);
  const phongMoi = phong.rooms.filter((r) => idMoi.has(r.id));
  const ketQua = await guiLo({
    convs, config, phong: { ...phong, rooms: phongMoi }, accountId, orgId, now,
    runKey: `event:${t.ngay}:${createHash('sha256').update([...idMoi].sort().join(',')).digest('hex')}`,
    day: true, chiChiTiet: true, tranConLai: conLai,
  });

  if (ketQua.soTin === 0 && ketQua.soKhongXepDuoc > 0) {
    // Preserve pendingSince and knownRoomIds so this same event can be retried.
    await ghiNhatKy({
      organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant',
      mode: 'failed', reason: 'Chưa xác nhận được tin bổ sung nào được xếp hàng. Giữ lượt để xét lại trong khung giờ hợp lệ.',
      recipients_count: 0, messages_count: 0,
      detail: { phong_moi: phongMoi.map(r => r.code), retry_pending: true, partial: false,
        khong_xep_duoc: ketQua.soKhongXepDuoc, bo_qua_khung_gio: ketQua.soBoQuaKhungGio },
    });
    return;
  }

  stats.pendingSince = null;
  stats.knownRoomIds = phong.rooms.map((r) => r.id);
  stats.lastEventAt = now.toISOString();
  congSoTin(stats, t.ngay, ketQua.soTin);
  await luuSo(auto.id, stats);

  await ghiNhatKy({
    organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant',
    mode: ketQua.soChuaXep > 0 ? 'failed' : 'event',
    reason: ketQua.soChuaXep > 0
      ? `Chỉ xếp hàng được một phần lượt bổ sung (${ketQua.soTin} tin); còn ${ketQua.soChuaXep} tin chưa xếp. Không tự chạy lại phần còn thiếu.`
      : `Đã xếp hàng ${ketQua.soTin} tin bổ sung. ${bs.reason}`,
    recipients_count: ketQua.soNguoiNhan, messages_count: ketQua.soTin,
    detail: { phong_moi: phongMoi.map((r) => r.code), bo_qua_khung_gio: ketQua.soBoQuaKhungGio,
      khong_xep_duoc: ketQua.soKhongXepDuoc, bo_qua_tran: ketQua.soBoQuaTran,
      partial: ketQua.soTin > 0 && ketQua.soChuaXep > 0, retry_pending: false },
  });
}

function congSoTin(stats, ngay, them) {
  if (stats.sentDate !== ngay) { stats.sentDate = ngay; stats.sentToday = 0; }
  stats.sentToday = (Number(stats.sentToday) || 0) + them;
}

/**
 * Dựng nội dung theo cấu hình rồi xếp hàng.
 * @param {boolean} p.day        chế độ ĐẦY ĐỦ (kèm chi tiết từng phòng)
 * @param {boolean} p.chiChiTiet lượt bổ sung: chỉ gửi chi tiết phòng mới
 * @param {string}  [p.oneshotId] lượt gửi MỘT LẦN: xếp qua cổng SQL của lượt đó
 */
export async function guiLo({ convs, config, phong, accountId, orgId, now, day, chiChiTiet, tranConLai, runKey, oneshotId }) {
  const khoiCai = config.template.blocks;
  const khoi = chiChiTiet
    ? khoiCai.filter((k) => k === 'room_details')
    : khoiCai.filter((k) => k !== 'room_details' || day);

  let anhBang = null;
  if (khoi.includes('table_image')) {
    anhBang = await dungAnhBang(phong.buildings, accountId, now);
  }

  const t = gioVietNam(now);
  const vanBanMoDau = khoi.includes('link')
    ? dienMau(config.template.introText, {
        ngay: `${t.ngay.slice(8, 10)}/${t.ngay.slice(5, 7)}`,
        so_phong: phong.rooms.length,
        link: config.template.shareUrl || '',
        hotline: phong.hotline || '',
      }).replace(/\n{3,}/g, '\n\n').trim()
    : '';

  let tinPhong = [];
  if (khoi.includes('room_details')) {
    // Prepare once per room, then reuse the account-scoped copy for recipients
    // in this organization. All room photos share one native Zalo album job;
    // information and the separator follow it, before the next room.
    for (const r of phong.rooms.slice(0, config.antiSpam.maxRoomsPerRun)) {
      try {
        const anh = await chuanBiAnhPhong(r, { accountId, orgId });
        if (anh.length > 12) throw new Error('Album vượt giới hạn 12 ảnh của hàng đợi; chưa gửi phòng, không cắt bớt ảnh');
        const body = [soanTinPhong(r, config.template.roomTemplate, phong.hotline),
          ...(!anh.length ? ['Chờ cập nhật ảnh'] : []), '────────────────'].filter(Boolean).join('\n');
        tinPhong.push({ roomId: r.id, body, anh, soTinDuKien: anh.length ? 2 : 1 });
      } catch (e) {
        log('automation: chuẩn bị ảnh phòng lỗi', r.id, e?.message || e);
        tinPhong.push({ roomId: r.id, loiAnh: true,
          soTinDuKien: (r.images || []).some(u => typeof u === 'string' && u.trim()) ? 2 : 1 });
      }
    }
  }

  const ketQua = await xepLo({
    convs, config, khoi, anhBang, vanBanMoDau, tinPhong, tranConLai, runKey, now, oneshotId,
  });

  const boSot = khoi.includes('room_details') ? Math.max(0, phong.rooms.length - tinPhong.length) : 0;
  if (boSot > 0) {
    // Cắt bớt mà im lặng thì người dùng đọc nhật ký sẽ tưởng đã gửi đủ.
    log(`automation: bỏ ${boSot} phòng khỏi phần chi tiết (trần ${config.antiSpam.maxRoomsPerRun}/lượt)`);
  }
  return { ...ketQua, anhBang, soPhongChiTiet: tinPhong.length, boSot };
}

/* ------------------------------------------------- lượt gửi MỘT LẦN (CRM/Hermes) */

// Gửi ngay / hẹn giờ một lần (bảng zalo_automation_oneshots) chạy CHÍNH guiLo ở
// trên: cùng ảnh bảng, tin chi tiết, giãn nhịp, khung giờ, trần ngày. Khác lượt
// theo lịch đúng ba chỗ: không cần công tắc lịch bật, người nhận lấy từ lượt (đã
// kiểm là nhóm sale khi tạo, kiểm lại ở SQL lúc xếp và lúc gửi), và KHÔNG áp
// skipIfUnchanged/knownRoomIds — người dùng chủ động bấm gửi thì gửi.
// runKey `oneshot:<id>` ổn định: chạy lại sau khi worker chết giữa lượt sẽ dùng
// lại tin đã xếp thay vì gửi trùng.

/** Số lượt chiếm tối đa mỗi tick (mỗi lượt có thể mất vài giây vì ảnh). */
const TOI_DA_HEN_GIO_MOI_TICK = 3;

async function chotHenGio(shot, ok, result) {
  const { data, error } = await sb.rpc('zalo_worker_finish_oneshot_v1', {
    p_oneshot_id: shot.id, p_instance_id: INSTANCE_ID, p_ok: ok, p_result: result,
  });
  if (error || data?.ok !== true) {
    log('automation: chốt lượt một lần chưa xác nhận', shot.id, error?.message || data?.reason || 'không rõ');
  }
  return data;
}

async function congTranDinhKy(orgId, ngay, soTin) {
  // Giữ sổ trần của lượt theo lịch khớp với tin vừa xếp, chỉ khi lịch đang bật
  // (lịch tắt thì sổ không dùng). Trigger set_zalo_automations_updated_at vẫn đóng
  // dấu updated_at, nhưng sau dừng khẩn cấp mọi dòng đã tắt nên mốc gỡ dừng không đổi.
  const { data: auto, error } = await sb.from('zalo_automations')
    .select('id, stats').eq('organization_id', orgId).eq('kind', 'broadcast_vacant').maybeSingle();
  if (error || !auto) return;
  const stats = auto.stats && typeof auto.stats === 'object' ? { ...auto.stats } : {};
  congSoTin(stats, ngay, soTin);
  const { error: saveError } = await sb.from('zalo_automations').update({ stats }).eq('id', auto.id).eq('enabled', true);
  if (saveError) log('automation: cộng trần lượt một lần lỗi', saveError.message);
}

async function chayMotHenGio(claim, now) {
  const shot = claim.oneshot;
  const orgId = shot.organization_id;
  const config = chuanHoaBroadcast(claim.config);
  const mode = shot.mode === 'compact' ? 'compact' : 'full';
  const t = gioVietNam(now);
  const nguon = shot.origin === 'hermes' ? 'Hermes' : 'CRM';
  let accountId = null;
  const thatBai = async (code, reason, detail = {}) => {
    await chotHenGio(shot, false, { code, reason, che_do: mode, ...detail });
    await ghiNhatKy({
      organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant', mode: 'failed',
      reason: `Lượt gửi một lần (${nguon}): ${reason}`,
      detail: { oneshot_id: shot.id, luot_mot_lan: true, code, ...detail },
    });
  };

  const nhan = Array.isArray(shot.recipients) ? shot.recipients.map(String) : [];
  const { data: convsTho, error } = await sb.from('zalo_conversations')
    .select('id, user_id, organization_id, account_id, peer_name, thread_type, is_sale_partner')
    .in('id', nhan)
    .eq('organization_id', orgId);
  if (error) return thatBai('khong_doc_duoc_nhom', 'Không đọc được danh sách nhóm nhận.');
  // Giữ thứ tự của lượt; chỉ nhóm sale còn hợp lệ và tài khoản đang có phiên sống.
  const convs = nhan.map(id => (convsTho || []).find(c => c.id === id)).filter(c => c
    && c.organization_id === orgId && c.thread_type === 'group' && c.is_sale_partner && sessions.has(c.account_id));
  if (!convs.length) {
    return thatBai('khong_co_nhom_san_sang', 'Không có nhóm sale nào của lượt này đang có tài khoản Zalo kết nối.');
  }
  accountId = convs[0].account_id;

  const khung = trongKhungGio(now, config.antiSpam);
  if (!khung.trong) return thatBai('ngoai_khung_gio', khung.lyDo);
  const tranConLai = Math.max(0, Math.floor(Number(claim.con_lai) || 0));
  if (tranConLai <= 0) return thatBai('het_tran_ngay', `Đã chạm trần ${config.antiSpam.dailyCap} tin tự động trong ngày.`);

  let phong;
  try {
    phong = await docPhongTrong(orgId);
  } catch (e) {
    return thatBai('khong_doc_duoc_phong', `Không đọc được danh sách phòng: ${e?.message || e}`);
  }
  if (!phong.rooms.length) {
    return phong.trangSale === 0
      ? thatBai('khong_co_trang_sale', KHONG_CO_TRANG_SALE)
      : thatBai('khong_con_phong', 'Không còn phòng nào chào được — không gửi bảng rỗng.');
  }

  const ketQua = await guiLo({
    convs, config, phong, accountId, orgId, now,
    runKey: `oneshot:${shot.id}`, day: mode === 'full', tranConLai, oneshotId: shot.id,
  });
  const detail = {
    oneshot_id: shot.id, luot_mot_lan: true, nguon: shot.origin, che_do: mode,
    so_phong: phong.rooms.length,
    co_anh_bang: !!ketQua.anhBang,
    so_phong_gui_chi_tiet: ketQua.soPhongChiTiet,
    bo_qua_khung_gio: ketQua.soBoQuaKhungGio,
    khong_xep_duoc: ketQua.soKhongXepDuoc,
    bo_qua_tran: ketQua.soBoQuaTran,
    partial: ketQua.soTin > 0 && ketQua.soChuaXep > 0,
  };
  if (ketQua.soTin === 0) {
    return thatBai('khong_xep_duoc', 'Chưa xếp hàng được tin nào (xem nhật ký worker).', detail);
  }
  const reason = ketQua.soChuaXep > 0
    ? `Lượt gửi một lần (${nguon}): chỉ xếp hàng được ${ketQua.soTin} tin; còn ${ketQua.soChuaXep} tin chưa xếp. Không tự chạy lại phần thiếu.`
    : `Lượt gửi một lần (${nguon}): đã xếp hàng ${ketQua.soTin} tin, chế độ ${mode === 'full' ? 'ĐẦY ĐỦ' : 'GỌN'}.`;
  await chotHenGio(shot, true, {
    ...detail, so_tin: ketQua.soTin, so_nguoi_nhan: ketQua.soNguoiNhan, so_chua_xep: ketQua.soChuaXep, reason,
  });
  await congTranDinhKy(orgId, t.ngay, ketQua.soTin);
  await ghiNhatKy({
    organization_id: orgId, account_id: accountId, kind: 'broadcast_vacant',
    mode: ketQua.soChuaXep > 0 ? 'failed' : mode, reason,
    recipients_count: ketQua.soNguoiNhan, messages_count: ketQua.soTin, detail,
  });
}

/** Chiếm và chạy các lượt gửi một lần đã tới hạn. Lỗi không chặn lượt theo lịch. */
async function xuLyHenGio(orgFilter, now) {
  let daChay = 0;
  for (let vong = 0; vong < TOI_DA_HEN_GIO_MOI_TICK * 2 && daChay < TOI_DA_HEN_GIO_MOI_TICK; vong++) {
    const { data, error } = await sb.rpc('zalo_worker_claim_oneshot_v1', {
      p_instance_id: INSTANCE_ID, p_organization_ids: orgFilter.length ? orgFilter : null,
    });
    if (error) { log('automation: chiếm lượt một lần lỗi', error.message); return; }
    if (data?.status === 'expired' && data.oneshot?.id) {
      await ghiNhatKy({
        organization_id: data.oneshot.organization_id, account_id: null, kind: 'broadcast_vacant', mode: 'failed',
        reason: `Lượt gửi một lần: ${data.reason || 'quá hạn'}`,
        detail: { oneshot_id: data.oneshot.id, luot_mot_lan: true, code: data.code || null },
      });
      continue;
    }
    if (data?.status !== 'claimed' || !data.oneshot?.id || !data.oneshot.organization_id) return;
    daChay++;
    try {
      await chayMotHenGio(data, now);
    } catch (e) {
      log('automation: lượt một lần lỗi', data.oneshot.id, e?.message || e);
      await chotHenGio(data.oneshot, false, { code: 'loi_worker', reason: String(e?.message || e).slice(0, 500) });
    }
  }
}

/* ------------------------------------------------------------------- tick */

let dangChay = false;

/** Gọi định kỳ từ index.js. Tự bỏ qua nếu lượt trước chưa xong. */
export async function tickTuDongHoa(orgFilter = []) {
  if (dangChay) return;
  dangChay = true;
  const now = new Date();
  try {
    try { await tickHermesSchedules({ db: sb, instanceId: INSTANCE_ID, organizationIds: orgFilter, log }); }
    catch (error) { log('hermes schedule tick unverified', error?.message || error); }
    // One-shots first: the scheduled pass below then reads the quota book they updated.
    try { await xuLyHenGio(orgFilter, now); }
    catch (error) { log('automation: lượt một lần chưa xác minh', error?.message || error); }
    let q = sb.from('zalo_automations')
      .select('id, organization_id, kind, enabled, config, stats')
      .eq('kind', 'broadcast_vacant').eq('enabled', true);
    if (orgFilter.length) q = q.in('organization_id', orgFilter);
    const { data: rows, error } = await q;
    if (error) { log('automation: đọc cấu hình lỗi', error.message); return; }

    for (const auto of rows || []) {
      try {
        await xuLyMotCongTy(auto, now);
      } catch (e) {
        log('automation: lỗi org', String(auto.organization_id).slice(0, 8), e?.message || e);
        await ghiNhatKy({
          organization_id: auto.organization_id,
          account_id: [...sessions.keys()].find((id) => orgOf(id) === auto.organization_id) || null,
          kind: 'broadcast_vacant', mode: 'failed', reason: String(e?.message || e).slice(0, 500),
        });
      }
    }
  } finally { dangChay = false; }
}
