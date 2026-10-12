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

/** Nhịp chạy engine. Lịch tính theo phút nên 60s là đủ mịn. */
export const AUTOMATION_MS = 60_000;

const BUCKET = 'zalo-media';

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
async function xepMotTin({ conv, khiNao, body, anh, requestKey }) {
  try {
    // One transaction reserves quota and creates both rows. Retrying the same
    // logical run after a lost response reuses its message/job, never resends it.
    const { data, error } = await sb.rpc('zalo_enqueue_broadcast_v1', {
      p_conversation_id: conv.id,
      p_body: body || '',
      p_not_before: khiNao.toISOString(),
      p_request_key: requestKey,
      p_attachment: anh ? (Array.isArray(anh) ? anh.map(refAnh) : refAnh(anh)) : null,
    });
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
  const { error } = await sb.from('zalo_automations')
    .update({ stats, updated_at: new Date().toISOString() }).eq('id', autoId);
  if (error) log('automation: lưu sổ lỗi', error.message);
}

/* --------------------------------------------------------- dựng & gửi lô */

/**
 * Xếp hàng một lô tin cho toàn bộ người nhận.
 * @returns {Promise<{soTin:number, soNguoiNhan:number}>}
 */
async function xepLo({ convs, config, khoi, anhBang, vanBanMoDau, tinPhong, tranConLai, runKey, now }) {
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
      if (await xepMotTin({ conv, khiNao, requestKey, ...content })) {
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
 */
export async function guiLo({ convs, config, phong, accountId, orgId, now, day, chiChiTiet, tranConLai, runKey }) {
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
    convs, config, khoi, anhBang, vanBanMoDau, tinPhong, tranConLai, runKey, now,
  });

  const boSot = khoi.includes('room_details') ? Math.max(0, phong.rooms.length - tinPhong.length) : 0;
  if (boSot > 0) {
    // Cắt bớt mà im lặng thì người dùng đọc nhật ký sẽ tưởng đã gửi đủ.
    log(`automation: bỏ ${boSot} phòng khỏi phần chi tiết (trần ${config.antiSpam.maxRoomsPerRun}/lượt)`);
  }
  return { ...ketQua, anhBang, soPhongChiTiet: tinPhong.length, boSot };
}

/* ------------------------------------------------------------------- tick */

let dangChay = false;

/** Gọi định kỳ từ index.js. Tự bỏ qua nếu lượt trước chưa xong. */
export async function tickTuDongHoa(orgFilter = []) {
  if (dangChay) return;
  dangChay = true;
  const now = new Date();
  try {
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
