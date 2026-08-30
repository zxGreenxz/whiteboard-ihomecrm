// =============================================================================
// AutoReplyFields.tsx — cấu hình tự động trả lời tin của sale.
//
// HAI DANH SÁCH TỪ KHOÁ KHÔNG ĐỐI XỨNG, và đó là chủ ý của hợp đồng:
//   • `keywords` rỗng   → auto-reply không bao giờ kích hoạt. Hợp lệ (tắt mềm),
//     `chuanHoaAutoReply` giữ nguyên mảng rỗng.
//   • `blockedKeywords` rỗng → hàm chuẩn hoá NẠP LẠI danh sách chặn mặc định.
//     Người dùng xoá sạch nó không có nghĩa là họ muốn máy tự trả lời về cọc
//     và hợp đồng — một câu sai về tiền là chuyện pháp lý, không phải chuyện
//     chăm sóc khách hàng.
//
// Hệ quả cho UI: không được dùng thẳng kết quả `chuanHoaAutoReply` làm nguồn
// hiển thị cho `blockedKeywords`. Nếu dùng, người dùng xoá chip cuối cùng sẽ
// thấy 8 chip mặc định nhảy ngược về ngay dưới tay mình. Ta giữ mảng người dùng
// đang sửa (kể cả rỗng) và nói thẳng điều gì sẽ xảy ra lúc lưu.
// =============================================================================

import { useMemo, useState } from 'react';
import { X, Plus, ShieldBan, KeyRound, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { chuanHoaAutoReply, MAC_DINH_AUTO_REPLY } from '../automationConfig';
import type { CauHinhAutoReply } from '../automationConfig';
import { CHU_MO, VIEN, VIEN_NHAT, NEN_MO, GhiChu, HangCongTac, TruongNhap, SoNguyenInput, BangCanhBao } from './uiChung';

interface Props {
  value: CauHinhAutoReply;
  onChange: (v: CauHinhAutoReply) => void;
}

/** Chuẩn hoá một mảng từ khoá đúng như hợp đồng: cắt khoảng trắng, hạ chữ
 *  thường, bỏ rỗng, khử trùng lặp. Viết ra đây để chip hiển thị và chuỗi lưu
 *  xuống DB luôn là một. */
const locKhoa = (ds: unknown): string[] => {
  if (!Array.isArray(ds)) return [];
  return [...new Set(ds.map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean))];
};

export default function AutoReplyFields({ value, onChange }: Props) {
  const [themKich, setThemKich] = useState('');
  const [themChan, setThemChan] = useState('');

  const v: CauHinhAutoReply = useMemo(() => {
    const c = chuanHoaAutoReply(value);
    const raw = (value || {}) as Record<string, unknown>;
    // Xem đầu file: mảng người dùng đang sửa thắng kết quả chuẩn hoá, để việc
    // xoá chip cuối cùng không bị "hoàn tác" ngay trước mắt họ.
    return {
      ...c,
      keywords: Array.isArray(raw.keywords) ? locKhoa(raw.keywords) : c.keywords,
      blockedKeywords: Array.isArray(raw.blockedKeywords) ? locKhoa(raw.blockedKeywords) : c.blockedKeywords,
    };
  }, [value]);

  const them = (truong: 'keywords' | 'blockedKeywords', tho: string, xoaO: () => void) => {
    const k = tho.trim().toLowerCase();
    if (!k) return;
    if (v[truong].includes(k)) { xoaO(); return; }
    onChange({ ...v, [truong]: [...v[truong], k] });
    xoaO();
  };

  const xoa = (truong: 'keywords' | 'blockedKeywords', k: string) =>
    onChange({ ...v, [truong]: v[truong].filter((x) => x !== k) });

  const chip = (truong: 'keywords' | 'blockedKeywords', k: string, chan: boolean) => (
    <span
      key={k}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600,
        background: chan ? 'hsl(0 86% 96%)' : 'hsl(210 20% 95%)',
        color: chan ? 'hsl(0 70% 40%)' : 'hsl(215 25% 32%)',
        border: `1px solid ${chan ? 'hsl(0 70% 90%)' : VIEN}`,
        borderRadius: 7, padding: '3px 5px 3px 9px',
      }}
    >
      {k}
      <button
        type="button"
        onClick={() => xoa(truong, k)}
        title={`Xoá từ khoá "${k}"`}
        style={{ display: 'flex', border: 'none', background: 'none', padding: 1, cursor: 'pointer', color: 'inherit', opacity: 0.7 }}
      >
        <X size={12} />
      </button>
    </span>
  );

  const oThem = (
    truong: 'keywords' | 'blockedKeywords',
    tho: string,
    setTho: (s: string) => void,
    goiY: string,
  ) => (
    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
      <Input
        value={tho}
        onChange={(e) => setTho(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); them(truong, tho, () => setTho('')); }
        }}
        placeholder={goiY}
        style={{ height: 30, fontSize: 12, maxWidth: 260 }}
      />
      <button
        type="button"
        onClick={() => them(truong, tho, () => setTho(''))}
        disabled={!tho.trim()}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600,
          border: `1px solid ${VIEN}`, borderRadius: 7, padding: '0 10px', background: '#fff',
          color: tho.trim() ? 'hsl(215 25% 30%)' : 'hsl(210 10% 70%)',
          cursor: tho.trim() ? 'pointer' : 'default',
        }}
      >
        <Plus size={12} />Thêm
      </button>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
      <p style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11.5, color: CHU_MO, lineHeight: 1.55, margin: 0, background: NEN_MO, padding: '9px 11px', borderRadius: 9 }}>
        <Info size={14} style={{ flex: 'none', marginTop: 2 }} />
        <span>
          Máy <b>chỉ</b> trả lời những hội thoại đã được đánh dấu là <b>sale/môi giới</b>. Tin của khách thuê,
          của nhóm, hay của người lạ đều không bao giờ được trả lời tự động — dù có khớp từ khoá.
        </span>
      </p>

      {/* Từ khoá kích hoạt */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
          <KeyRound size={14} style={{ color: 'hsl(152 69% 31%)' }} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Từ khoá kích hoạt</span>
          <span style={{ fontSize: 11, color: CHU_MO }}>({v.keywords.length})</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {v.keywords.map((k) => chip('keywords', k, false))}
          {v.keywords.length === 0 && (
            <span style={{ fontSize: 11.5, color: CHU_MO, fontStyle: 'italic' }}>Chưa có từ khoá nào.</span>
          )}
        </div>
        {oThem('keywords', themKich, setThemKich, 'vd: còn phòng không')}
        <GhiChu canhBao={v.keywords.length === 0}>
          {v.keywords.length === 0
            ? 'Danh sách rỗng — tính năng sẽ không bao giờ kích hoạt, kể cả khi công tắc đang bật. Đây là cách tắt mềm hợp lệ.'
            : 'Khớp khi tin nhắn CHỨA từ khoá (không phân biệt hoa thường). Từ khoá càng ngắn càng dễ khớp nhầm — "giá" khớp cả "giá điện tháng này sao anh".'}
        </GhiChu>
      </div>

      <div style={{ height: 1, background: VIEN_NHAT }} />

      {/* Từ khoá chặn */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
          <ShieldBan size={14} style={{ color: 'hsl(0 70% 45%)' }} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Từ khoá CHẶN — máy im lặng, để người thật xử lý</span>
          <span style={{ fontSize: 11, color: CHU_MO }}>({v.blockedKeywords.length})</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {v.blockedKeywords.map((k) => chip('blockedKeywords', k, true))}
          {v.blockedKeywords.length === 0 && (
            <span style={{ fontSize: 11.5, color: CHU_MO, fontStyle: 'italic' }}>Danh sách trống.</span>
          )}
        </div>
        {oThem('blockedKeywords', themChan, setThemChan, 'vd: đặt cọc')}
        <GhiChu>
          Tin chạm một trong những từ này thì máy <b>KHÔNG</b> trả lời, dù có khớp từ khoá kích hoạt. Đây là ràng buộc
          an toàn, không phải tuỳ chọn cho vui: một câu sai về cọc, hợp đồng hay thanh toán là chuyện pháp lý,
          và người hứng hậu quả là chủ nhà chứ không phải phần mềm.
        </GhiChu>
        {v.blockedKeywords.length === 0 && (
          <div style={{ marginTop: 8 }}>
            <BangCanhBao tone="danger">
              Danh sách chặn đang trống. Khi lưu, hệ thống sẽ <b>tự nạp lại bộ mặc định</b>
              {' '}({MAC_DINH_AUTO_REPLY.blockedKeywords.join(', ')}) — không có trạng thái “không chặn gì cả”.
            </BangCanhBao>
          </div>
        )}
      </div>

      <div style={{ height: 1, background: VIEN_NHAT }} />

      {/* Lời chào */}
      <TruongNhap
        nhan="Lời chào trước danh sách"
        id="ar-intro"
        ghiChu="Câu mở đầu của tin trả lời tự động. Viết đúng giọng nhân viên thật — người nhận không được cảm thấy đang nói chuyện với máy."
      >
        <Textarea
          id="ar-intro"
          rows={3}
          value={v.replyIntro}
          onChange={(e) => onChange({ ...v, replyIntro: e.target.value })}
          style={{ fontSize: 12.5, lineHeight: 1.55 }}
        />
      </TruongNhap>

      <div style={{ border: `1px solid ${VIEN}`, borderRadius: 10, padding: '11px 12px' }}>
        <HangCongTac
          nhan="Kèm danh sách phòng trống"
          moTa="Tắt thì máy chỉ gửi lời chào — dùng khi muốn báo “đã nhận tin” rồi để nhân viên trả lời tiếp bằng tay."
        >
          <Switch checked={v.includeRoomList} onCheckedChange={(x) => onChange({ ...v, includeRoomList: x })} />
        </HangCongTac>
      </div>

      {/* Nhịp + trần */}
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        <TruongNhap
          nhan="Nghỉ giữa hai lần trả lời cùng một người"
          id="ar-cooldown"
          ghiChu="Trong khoảng này, người đó nhắn thêm bao nhiêu tin cũng không được trả lời tự động lần nữa."
        >
          <SoNguyenInput
            id="ar-cooldown"
            value={v.cooldownMinutes}
            onChange={(n) => onChange({ ...v, cooldownMinutes: n })}
            min={1}
            max={1440}
            macDinh={30}
            donVi="phút"
          />
        </TruongNhap>

        <TruongNhap
          nhan="Trần tin trả lời mỗi ngày"
          id="ar-cap"
          ghiChu="Tính riêng cho auto-reply. Chạm trần thì phần còn lại của ngày để người thật trả lời."
        >
          <SoNguyenInput
            id="ar-cap"
            value={v.dailyCap}
            onChange={(n) => onChange({ ...v, dailyCap: n })}
            min={1}
            max={1000}
            macDinh={50}
            donVi="tin/ngày"
            rong={104}
          />
        </TruongNhap>
      </div>
    </div>
  );
}
