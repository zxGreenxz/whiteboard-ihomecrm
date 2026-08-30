// =============================================================================
// RecipientPicker.tsx — chọn hội thoại nhận tin phòng trống định kỳ.
//
// LUẬT AN TOÀN nằm ngay ở bộ lọc: chỉ NHÓM (`isGroup`) hoặc hội thoại đã được
// người thật đánh dấu sale (`isSalePartner`) mới xuất hiện ở đây. Khách thuê
// đang ở trong phòng không có lý do gì nhận bản tin rao phòng mỗi sáng; gửi
// nhầm một lần là mất uy tín với người trả tiền thuê, và với Zalo thì đó đúng
// là dấu hiệu spam. Bộ lọc này là hàng rào, không phải tiện ích sắp xếp.
// =============================================================================

import { useMemo, useState } from 'react';
import { Search, Users, BadgeCheck, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { tagStyle, avatarStyle } from '../zaloTheme';
import type { ZaloConversation } from '@/components/chat-zalo/types';
import { CHU_MO, VIEN, VIEN_NHAT, NEN_MO, BangCanhBao } from './uiChung';

interface Props {
  conversations: ZaloConversation[];
  value: string[];
  onChange: (ids: string[]) => void;
}

// Dải dấu tổ hợp Unicode (U+0300..U+036F) — thứ mà `normalize('NFD')` tách ra.
// Lọc bằng SỐ HEX chứ không dán ký tự thật vào một regex `[x-y]`: dấu tổ hợp
// không hiển thị được trong editor nên cặp ngoặc trông như rỗng, và nó rất dễ
// bị nuốt khi file đi qua một công cụ chuẩn hoá — lúc đó tìm kiếm hỏng lặng lẽ.
const DAU_TU = 0x0300;
const DAU_DEN = 0x036f;

/** Bỏ dấu để gõ "hoang" vẫn ra "Hoàng". `đ` không phải chữ có dấu tổ hợp nên
 *  phải thay riêng, và phải thay TRƯỚC khi tách NFD. */
const boDau = (s: string) =>
  Array.from(String(s ?? '').toLowerCase().replace(/đ/g, 'd').normalize('NFD'))
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c < DAU_TU || c > DAU_DEN;
    })
    .join('');

export default function RecipientPicker({ conversations, value, onChange }: Props) {
  const [tim, setTim] = useState('');

  const chon = Array.isArray(value) ? value : [];
  const daChon = useMemo(() => new Set(Array.isArray(value) ? value : []), [value]);

  // Chỉ nhóm hoặc sale. Xem đầu file: đây là hàng rào, đừng nới.
  const ungVien = useMemo(
    () => (Array.isArray(conversations) ? conversations : []).filter((c) => c && (c.isGroup || c.isSalePartner)),
    [conversations],
  );

  const loc = useMemo(() => {
    const k = boDau(tim).trim();
    if (!k) return ungVien;
    return ungVien.filter((c) => boDau(c.name).includes(k));
  }, [ungVien, tim]);

  // Id đã chọn nhưng KHÔNG còn trong danh sách ứng viên: hội thoại bị gỡ đánh
  // dấu sale, rời nhóm, hoặc thuộc tài khoản Zalo khác. Worker sẽ bỏ qua chúng
  // trong im lặng — nên phải nói ra ở đây, chứ không tự xoá hộ người dùng.
  const laLac = useMemo(() => {
    const co = new Set(ungVien.map((c) => c.id));
    return [...daChon].filter((id) => !co.has(id));
  }, [ungVien, daChon]);

  const bat = (id: string, on: boolean) => {
    if (on) onChange([...new Set([...chon, id])]);
    else onChange(chon.filter((x) => x !== id));
  };

  const chonHetDangLoc = () => onChange([...new Set([...chon, ...loc.map((c) => c.id)])]);

  return (
    <div>
      {/* Thanh tìm + số đã chọn */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: 9, color: CHU_MO }} />
          <Input
            value={tim}
            onChange={(e) => setTim(e.target.value)}
            placeholder="Tìm theo tên hội thoại…"
            style={{ height: 32, paddingLeft: 29 }}
          />
        </div>
        <span
          style={{
            fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap',
            color: daChon.size ? 'hsl(152 69% 28%)' : CHU_MO,
          }}
        >
          Đã chọn {daChon.size}
        </span>
      </div>

      {ungVien.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 11.5 }}>
          <button
            type="button"
            onClick={chonHetDangLoc}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'hsl(224 76% 46%)', fontWeight: 600 }}
          >
            Chọn tất cả {tim.trim() ? `(${loc.length} kết quả)` : `(${ungVien.length})`}
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={daChon.size === 0}
            style={{
              background: 'none', border: 'none', padding: 0, fontWeight: 600,
              cursor: daChon.size ? 'pointer' : 'default',
              color: daChon.size ? CHU_MO : 'hsl(210 10% 72%)',
            }}
          >
            Bỏ chọn hết
          </button>
        </div>
      )}

      {/* Danh sách */}
      <div style={{ border: `1px solid ${VIEN}`, borderRadius: 10, maxHeight: 260, overflowY: 'auto', background: '#fff' }}>
        {ungVien.length === 0 && (
          <div style={{ padding: '16px 14px', fontSize: 12, lineHeight: 1.6, color: CHU_MO, display: 'flex', gap: 8 }}>
            <Info size={15} style={{ flex: 'none', marginTop: 1 }} />
            <div>
              <div style={{ fontWeight: 600, color: 'hsl(215 25% 30%)' }}>Chưa có hội thoại nào đủ điều kiện nhận.</div>
              Bản tin định kỳ chỉ gửi vào <b>nhóm</b> hoặc hội thoại đã được đánh dấu là sale/môi giới.
              Mở một hội thoại → cột phải → tab <b>Thông tin</b> → bật <b>“Là sale/môi giới”</b>, rồi quay lại đây.
            </div>
          </div>
        )}

        {ungVien.length > 0 && loc.length === 0 && (
          <div style={{ padding: 14, fontSize: 12, color: CHU_MO }}>Không có hội thoại nào khớp “{tim}”.</div>
        )}

        {loc.map((c, i) => {
          const on = daChon.has(c.id);
          return (
            <label
              key={c.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px', cursor: 'pointer',
                borderTop: i === 0 ? 'none' : `1px solid ${VIEN_NHAT}`,
                background: on ? 'hsl(152 40% 97%)' : 'transparent',
              }}
            >
              <Checkbox checked={on} onCheckedChange={(v) => bat(c.id, v === true)} />
              <span style={avatarStyle(c.tone, 30, 11)}>{c.initials}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </span>
                <span style={{ display: 'block', fontSize: 10.5, color: CHU_MO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.headerSub || c.sub || c.phone || ''}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 4, flex: 'none' }}>
                {c.isGroup && (
                  <span style={tagStyle('info', { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10 })}>
                    <Users size={10} />NHÓM
                  </span>
                )}
                {c.isSalePartner && (
                  <span style={tagStyle('success', { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10 })}>
                    <BadgeCheck size={10} />SALE
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      {laLac.length > 0 && (
        <div style={{ marginTop: 9 }}>
          <BangCanhBao>
            Có <b>{laLac.length}</b> người nhận đã lưu nhưng không còn trong danh sách trên (bị gỡ đánh dấu sale,
            rời nhóm, hoặc thuộc tài khoản Zalo khác). Worker sẽ bỏ qua họ.{' '}
            <button
              type="button"
              onClick={() => onChange(chon.filter((id) => !laLac.includes(id)))}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 700, textDecoration: 'underline', color: 'inherit' }}
            >
              Gỡ khỏi danh sách
            </button>
          </BangCanhBao>
        </div>
      )}

      <p style={{ fontSize: 11, color: CHU_MO, margin: '9px 0 0', lineHeight: 1.5, background: NEN_MO, padding: '7px 9px', borderRadius: 8 }}>
        Mỗi người nhận là một lượt gửi riêng, cách nhau đúng bằng “giãn nhịp giữa người nhận” ở khối Chống spam.
        Chọn càng nhiều thì một lượt broadcast càng kéo dài.
      </p>
    </div>
  );
}
