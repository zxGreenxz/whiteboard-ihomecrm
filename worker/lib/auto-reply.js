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
import { gioVietNam } from './automation-scenario.js';
import { docPhongTrong } from './vacant-rooms.js';

/** Trễ trước khi tin trả lời được gửi — người thật không trả lời trong 0 giây. */
const TRE_TU_NHIEN_GIAY = 8;

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
  const trongNgay = rooms.filter((r) => r.status === 'free');
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
  if (sapTrong.length) phan.push(`SẮP TRỐNG (${sapTrong.length}):\n${sapTrong.map((r) => dong(r, r.availDate ? ` — trống ${r.availDate}` : '')).join('\n')}`);
  if (pass.length) phan.push(`KHÁCH PASS PHÒNG (${pass.length}):\n${pass.map((r) => dong(r)).join('\n')}`);
  if (!phan.length) return 'Hiện bên em chưa có phòng trống nào ạ. Anh/chị để lại nhu cầu, có phòng em báo ngay.';
  if (link) phan.push(`Bảng đầy đủ: ${link}`);
  return phan.join('\n\n');
}

/** Hội thoại này được trả lời tự động lần cuối lúc nào. */
async function lanTraLoiCuoi(conversationId) {
  const { data } = await sb.from('zalo_automation_runs')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('kind', 'auto_reply').eq('mode', 'reply')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data?.created_at ? Date.parse(data.created_at) : null;
}

/** Số tin auto-reply đã gửi hôm nay (giờ VN) trong công ty. */
async function daTraLoiHomNay(orgId, ngayVN) {
  const dau = new Date(`${ngayVN}T00:00:00+07:00`).toISOString();
  const { count } = await sb.from('zalo_automation_runs')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId).eq('kind', 'auto_reply').eq('mode', 'reply')
    .gte('created_at', dau);
  return count || 0;
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
 */
export async function xuLyTinDen({ accountId, conv, body }) {
  try {
    if (!conv?.id) return;
    if (!conv.is_sale_partner) return;                 // cửa 1 — rẻ nhất, chặn 99% lưu lượng
    const noiDung = String(body || '').trim();
    if (noiDung.length < DAI_TOI_THIEU) return;

    const orgId = conv.organization_id || orgOf(accountId);
    if (!orgId) return;

    const { data: auto } = await sb.from('zalo_automations')
      .select('id, config, enabled')
      .eq('organization_id', orgId).eq('kind', 'auto_reply').maybeSingle();
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

    const cuoi = await lanTraLoiCuoi(conv.id);              // cửa 4
    if (cuoi && Date.now() - cuoi < cfg.cooldownMinutes * 60_000) {
      const conLai = Math.ceil((cfg.cooldownMinutes * 60_000 - (Date.now() - cuoi)) / 60_000);
      await ghiNhatKy({
        organization_id: orgId, account_id: accountId, conversation_id: conv.id,
        kind: 'auto_reply', mode: 'skipped',
        reason: `Vừa trả lời hội thoại này — im lặng thêm ${conLai} phút (chống lặp).`,
      });
      return;
    }

    const t = gioVietNam(new Date());
    const daGui = await daTraLoiHomNay(orgId, t.ngay);
    if (daGui >= cfg.dailyCap) {
      await ghiNhatKy({
        organization_id: orgId, account_id: accountId, conversation_id: conv.id,
        kind: 'auto_reply', mode: 'skipped',
        reason: `Đã chạm trần ${cfg.dailyCap} tin trả lời tự động trong ngày.`,
      });
      return;
    }

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

    const { data: msg, error: eMsg } = await sb.from('zalo_messages').insert({
      user_id: conv.user_id, organization_id: orgId,
      conversation_id: conv.id, account_id: accountId,
      direction: 'out', msg_type: 'text', body: than,
      status: 'pending', sent_at: new Date().toISOString(),
    }).select('id').single();
    if (eMsg) throw new Error(eMsg.message);

    const { error: eJob } = await sb.from('zalo_send_queue').insert({
      user_id: conv.user_id, organization_id: orgId,
      conversation_id: conv.id, account_id: accountId, message_id: msg.id,
      channel: 'personal',
      payload: { body: than, tu_dong: true, auto_reply: true },
      status: 'queued',
      not_before: new Date(Date.now() + TRE_TU_NHIEN_GIAY * 1000).toISOString(),
    });
    if (eJob) throw new Error(eJob.message);

    await ghiNhatKy({
      organization_id: orgId, account_id: accountId, conversation_id: conv.id,
      kind: 'auto_reply', mode: 'reply',
      reason: `Khớp từ khoá "${khop}" — đã gửi danh sách phòng trống.`,
      recipients_count: 1, messages_count: 1,
      detail: { tu_khoa: khop, so_phong: soPhong, tin_den: noiDung.slice(0, 200) },
    });
    log('auto-reply →', conv.id, `(khớp "${khop}")`);
  } catch (e) {
    log('auto-reply lỗi', e?.message || e);
  }
}
