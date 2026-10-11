// =============================================================================
// auto-reply.js — TỰ ĐỘNG TRẢ LỜI sale/môi giới nhắn đến.
//
// Kích hoạt từ inbound.js ngay sau khi một tin ĐẾN được ghi vào DB. Bốn cửa
// phải qua hết mới trả lời, theo thứ tự rẻ-trước-đắt-sau:
//   1. hội thoại có cờ `is_sale_partner` (bật tay) — cửa quan trọng nhất;
//   2. tin KHÔNG chạm danh sách chặn (cọc, hợp đồng, thanh toán, khiếu nại);
//   3. tin CÓ khớp một từ khoá kích hoạt;
//   4. còn trong cooldown thì im, và chưa chạm trần tin/ngày.
//
// Vì sao là "khớp từ khoá rồi trả lời bằng dữ liệu sống" chứ không phải để mô
// hình ngôn ngữ tự viết: `docs/zalo/PLAN.md` ghi NO-GO cho AI auto-send trên tài
// khoản Zalo cá nhân. Nội dung ở đây do người dùng soạn trước cộng số liệu lấy
// thẳng từ CSDL, nên biết trước 100% máy sẽ nói gì — điều không thể bảo đảm với
// văn bản do mô hình sinh tại chỗ. Câu hỏi lạ thì máy IM LẶNG để người thật trả
// lời, im lặng là hành vi mặc định an toàn.
//
// Cửa 2 đặt TRƯỚC cửa 3 có chủ ý: tin "còn phòng nào cho cọc trước không" khớp
// cả hai danh sách, và trong tình huống đó thứ đúng là im lặng.
// =============================================================================
import { sb, log, orgOf } from './ctx.js';
import { chuanHoaAutoReply } from './automation-config.js';
import { docPhongTrong } from './vacant-rooms.js';

/** Tin quá ngắn (["ok","hi"]) không mang câu hỏi nào để trả lời. */
const DAI_TOI_THIEU = 2;

/**
 * Tìm từ khoá khớp trong nội dung tin.
 * So sánh không dấu-nhạy-cảm-hoa-thường; giữ nguyên tiếng Việt có dấu vì từ
 * khoá do người dùng gõ bằng tiếng Việt có dấu.
 */
export function timTuKhoa(noiDung, danhSach) {
  const s = String(noiDung || '').toLowerCase();
  return danhSach.find((k) => k && s.includes(k)) || null;
}

/** Danh sách phòng dạng text gọn cho tin trả lời. */
export function soanDanhSachPhong(rooms, link) {
  const trongNgay = rooms.filter((r) => r.status === 'free' && r.saleFact?.kind !== 'preparing');
  const dangChuanBi = rooms.filter((r) => r.status === 'free' && r.saleFact?.kind === 'preparing');
  const sapTrong = rooms.filter((r) => r.status === 'soon');
  const pass = rooms.filter((r) => r.status === 'pass');

  const dong = (r, kem) => {
    const gia = r.price > 0 ? `${(Math.round(r.price * 1000) * 1000).toLocaleString('vi-VN')}đ` : 'giá liên hệ';
    const dt = r.area > 0 ? `, ${r.area}m²` : '';
    const loai = r.type ? `, ${r.type}` : '';
    return `• P.${r.code} — ${r.buildingAddr || r.buildingName}: ${gia}${dt}${loai}${kem || ''}`;
  };

  const phan = [];
  if (trongNgay.length) phan.push(`TRỐNG NGAY (${trongNgay.length}):\n${trongNgay.map((r) => dong(r)).join('\n')}`);
  if (dangChuanBi.length) phan.push(`PHÒNG TRỐNG ĐANG CHUẨN BỊ (${dangChuanBi.length}):\n${dangChuanBi.map(r => dong(r, ` — ${r.saleFact.label}`)).join('\n')}`);
  if (sapTrong.length) phan.push(`SẮP TRỐNG (${sapTrong.length}):\n${sapTrong.map((r) => dong(r, r.saleFact ? ` — ${r.saleFact.label}` : r.availDate ? ` — trống ${r.availDate}` : '')).join('\n')}`);
  if (pass.length) phan.push(`KHÁCH PASS PHÒNG (${pass.length}):\n${pass.map((r) => dong(r)).join('\n')}`);
  if (!phan.length) return 'Hiện bên em chưa có phòng trống nào ạ. Anh/chị để lại nhu cầu, có phòng em báo ngay.';
  if (link) phan.push(`Bảng đầy đủ: ${link}`);
  return phan.join('\n\n');
}

async function ghiNhatKy(row) {
  const { error } = await sb.from('zalo_automation_runs').insert(row);
  if (error) log('auto-reply: ghi nhật ký lỗi', error.message);
}

/**
 * Xử lý một tin ĐẾN. Gọi fire-and-forget từ inbound.js — mọi lỗi nuốt tại chỗ,
 * đường nhận tin KHÔNG được hỏng vì tính năng phụ này.
 *
 * @param {object} p
 * @param {string} p.accountId
 * @param {object} p.conv     dòng zalo_conversations (cần id, account_id, organization_id, is_sale_partner)
 * @param {string} p.body     nội dung tin đến
 * @param {string} p.zaloMsgId mã tin đến đã lưu, dùng chống xử lý trùng
 */
export async function xuLyTinDen({ accountId, conv, body, zaloMsgId }) {
  try {
    if (!conv?.id) return;
    if (!conv.is_sale_partner) return;                 // cửa 1 — rẻ nhất, chặn 99% lưu lượng
    if (!String(zaloMsgId || '').trim()) return;        // không gửi nếu thiếu khóa chống trùng
    const noiDung = String(body || '').trim();
    if (noiDung.length < DAI_TOI_THIEU) return;

    const orgId = conv.organization_id || orgOf(accountId);
    if (!orgId) return;

    const { data: auto, error: configError } = await sb.from('zalo_automations')
      .select('id, config, enabled')
      .eq('organization_id', orgId).eq('kind', 'auto_reply').maybeSingle();
    if (configError) throw new Error(configError.message);
    if (!auto?.enabled) return;

    const cfg = chuanHoaAutoReply(auto.config);

    const chan = timTuKhoa(noiDung, cfg.blockedKeywords);   // cửa 2
    if (chan) {
      await ghiNhatKy({
        organization_id: orgId, account_id: accountId, conversation_id: conv.id,
        kind: 'auto_reply', mode: 'skipped',
        reason: `Tin nhắc đến "${chan}" — chuyện tiền/hợp đồng để người thật trả lời.`,
      });
      return;
    }

    const khop = timTuKhoa(noiDung, cfg.keywords);          // cửa 3
    if (!khop) return;                                      // không khớp: im lặng, không cần ghi sổ

    // Cửa 4 được kiểm trong cùng transaction xếp hàng tại DB. Đọc cooldown/cap
    // rồi insert riêng ở worker có thể cho hai tin đến đồng thời vượt giới hạn.

    // Nội dung: lời chào người dùng soạn + số liệu lấy thẳng từ CSDL lúc này.
    let than = cfg.replyIntro;
    let soPhong = 0;
    if (cfg.includeRoomList) {
      const { rooms } = await docPhongTrong(orgId);
      soPhong = rooms.length;
      // Link tổng lấy từ cấu hình broadcast — người dùng chỉ phải khai một chỗ.
      const { data: bc } = await sb.from('zalo_automations')
        .select('config').eq('organization_id', orgId).eq('kind', 'broadcast_vacant').maybeSingle();
      const link = typeof bc?.config?.template?.shareUrl === 'string' ? bc.config.template.shareUrl.trim() : '';
      than = `${cfg.replyIntro}\n\n${soanDanhSachPhong(rooms, link)}`;
    }

    const { data: result, error } = await sb.rpc('zalo_enqueue_auto_reply_v1', {
      p_conversation_id: conv.id,
      p_body: than,
      p_source_zalo_msg_id: String(zaloMsgId),
      p_detail: { tu_khoa: khop, so_phong: soPhong },
    });
    if (error) throw new Error(error.message);
    if (!['queued', 'skipped'].includes(result?.status)) throw new Error('Kết quả xếp hàng tự động không xác định');
    log('auto-reply', result.status, conv.id, result.reused ? '(nguồn đã xếp hàng)' : result.reason || '');
  } catch (e) {
    log('auto-reply lỗi', e?.message || e);
  }
}
