// =============================================================================
// TemplateBuilder.tsx — nội dung tin broadcast: khối nào, thứ tự nào, chữ gì.
//
// ĐIỂM DỄ HIỂU SAI NHẤT: `template.blocks` chỉ chứa các khối ĐANG BẬT, và thứ
// tự trong mảng CHÍNH LÀ thứ tự gửi. Không có cờ `enabled` riêng cho từng khối
// — tắt một khối nghĩa là rút nó khỏi mảng. Mảng rỗng là lựa chọn hợp lệ
// (`chuanHoaBroadcast` cố ý không dựng lại mặc định cho mảng rỗng), nên UI phải
// nói thẳng rằng lúc đó tin sẽ trống chứ không âm thầm gửi mặc định.
//
// Khối `room_details` CHỈ chạy ở chế độ ĐẦY ĐỦ. Bật nó lên không làm ngày GỌN
// gửi chi tiết — muốn vậy phải đổi chế độ ngày ở khối Lịch gửi.
// =============================================================================

import { useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowDown, ArrowUp, Link2, Table, ListTree, Zap } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { chuanHoaBroadcast, KHOI_MAC_DINH } from '../automationConfig';
import type { MauTin, GuiTheoSuKien, KhoiTin } from '../automationConfig';
import { CHU_MO, VIEN, VIEN_NHAT, NEN_MO, GhiChu, HangCongTac, TruongNhap, SoNguyenInput } from './uiChung';

interface Props {
  value: MauTin;
  onChange: (v: MauTin) => void;
  eventDriven: GuiTheoSuKien;
  onEventDrivenChange: (v: GuiTheoSuKien) => void;
}

const MO_TA_KHOI: Record<KhoiTin, { ten: string; icon: ReactNode; moTa: string; chiDayDu?: boolean }> = {
  link: {
    ten: 'Lời mở đầu + link tổng',
    icon: <Link2 size={14} />,
    moTa: 'Một tin chữ: lời chào và đường dẫn tới bảng phòng trống luôn mới nhất. Rẻ nhất về số tin.',
  },
  table_image: {
    ten: 'Ảnh bảng danh sách',
    icon: <Table size={14} />,
    moTa: 'Một tấm ảnh chụp bảng phòng trống — sale xem ngay trong khung chat, không phải mở link.',
  },
  room_details: {
    ten: 'Chi tiết + ảnh từng phòng',
    icon: <ListTree size={14} />,
    moTa: 'Mỗi phòng một tin riêng kèm ảnh. Tốn nhịp nhất, và bị chặn bởi trần "số phòng gửi chi tiết mỗi lượt".',
    chiDayDu: true,
  },
};

const BIEN_INTRO = ['{ngay}', '{so_phong}', '{link}', '{hotline}'];
const BIEN_PHONG = [
  '{ma_phong}', '{dia_chi}', '{toa}', '{gia}', '{dien_tich}',
  '{loai_phong}', '{noi_that}', '{tinh_trang}', '{khuyen_mai}', '{hotline}',
];

export default function TemplateBuilder({ value, onChange, eventDriven, onEventDrivenChange }: Props) {
  // Chuẩn hoá qua đúng hàm mà worker dùng — xem `automationConfig.ts`.
  const v = useMemo(() => chuanHoaBroadcast({ template: value }).template, [value]);
  const ev = useMemo(() => chuanHoaBroadcast({ eventDriven }).eventDriven, [eventDriven]);

  const refIntro = useRef<HTMLTextAreaElement>(null);
  const refPhong = useRef<HTMLTextAreaElement>(null);

  // Khối đang bật (đúng thứ tự gửi) rồi tới khối đang tắt. Khối tắt xếp cuối vì
  // chúng không có vị trí — vị trí chỉ tồn tại khi nằm trong mảng `blocks`.
  const dangBat = v.blocks;
  const dangTat = KHOI_MAC_DINH.filter((k) => !dangBat.includes(k));
  const hienThi: KhoiTin[] = [...dangBat, ...dangTat];

  const batKhoi = (k: KhoiTin, on: boolean) => {
    // Bật lại thì nối vào CUỐI: khối đã rút khỏi mảng không còn vị trí cũ để về.
    if (on) onChange({ ...v, blocks: [...dangBat, k] });
    else onChange({ ...v, blocks: dangBat.filter((x) => x !== k) });
  };

  const doiCho = (k: KhoiTin, huong: -1 | 1) => {
    const i = dangBat.indexOf(k);
    const j = i + huong;
    if (i < 0 || j < 0 || j >= dangBat.length) return;
    const moi = [...dangBat];
    // `j` đã được chặn trong khoảng hợp lệ ở dòng trên, nhưng dưới
    // `noUncheckedIndexedAccess` thì `moi[j]` vẫn khai `KhoiTin | undefined`.
    // Gán qua biến có kiểm thay vì ép kiểu — ép kiểu ở đây sẽ biến một lỗi chỉ
    // số thành `undefined` lọt vào mảng blocks rồi worker đọc ra khối rỗng.
    const phanTuDich = moi[j];
    if (phanTuDich === undefined) return;
    moi[i] = phanTuDich;
    moi[j] = k;
    onChange({ ...v, blocks: moi });
  };

  /** Chèn biến vào đúng vị trí con trỏ của ô đang sửa. */
  const chenBien = (o: 'intro' | 'phong', bien: string) => {
    const el = o === 'intro' ? refIntro.current : refPhong.current;
    const cu = o === 'intro' ? v.introText : v.roomTemplate;
    const ghi = (s: string) => (o === 'intro' ? onChange({ ...v, introText: s }) : onChange({ ...v, roomTemplate: s }));
    if (!el) { ghi(cu + bien); return; }
    const dau = el.selectionStart ?? cu.length;
    const cuoi = el.selectionEnd ?? dau;
    ghi(cu.slice(0, dau) + bien + cu.slice(cuoi));
    // Trả con trỏ về sau chuỗi vừa chèn — nếu không, mỗi lần bấm biến thứ hai
    // người dùng lại phải đi tìm chỗ cũ.
    requestAnimationFrame(() => {
      const p = dau + bien.length;
      el.focus();
      el.setSelectionRange(p, p);
    });
  };

  const chipBien = (o: 'intro' | 'phong', ds: string[]) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
      <span style={{ fontSize: 10.5, color: CHU_MO, alignSelf: 'center', marginRight: 2 }}>Chèn biến:</span>
      {ds.map((b) => (
        <button
          key={b}
          type="button"
          // Chặn mousedown để ô chữ KHÔNG mất focus — mất focus là mất vị trí
          // con trỏ, và biến sẽ rơi xuống cuối thay vì chỗ người dùng đang gõ.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => chenBien(o, b)}
          style={{
            fontFamily: "'Space Mono', ui-monospace, monospace", fontSize: 10.5, fontWeight: 600,
            background: 'hsl(210 20% 95%)', color: 'hsl(215 25% 32%)', border: `1px solid ${VIEN}`,
            borderRadius: 6, padding: '2px 7px', cursor: 'pointer',
          }}
        >
          {b}
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Khối nội dung + thứ tự */}
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Khối nội dung &amp; thứ tự gửi</div>
        <div style={{ border: `1px solid ${VIEN}`, borderRadius: 10, overflow: 'hidden' }}>
          {hienThi.map((k, i) => {
            const on = dangBat.includes(k);
            const viTri = dangBat.indexOf(k);
            const m = MO_TA_KHOI[k];
            return (
              <div
                key={k}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 11px',
                  borderTop: i === 0 ? 'none' : `1px solid ${VIEN_NHAT}`,
                  background: on ? 'transparent' : NEN_MO,
                }}
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={(x) => batKhoi(k, x === true)}
                  aria-label={m.ten}
                  style={{ marginTop: 2 }}
                />
                <span style={{ color: on ? 'hsl(152 69% 31%)' : 'hsl(210 10% 65%)', flex: 'none', marginTop: 1 }}>{m.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {on && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'hsl(152 69% 38%)', borderRadius: 5, padding: '1px 5px' }}>
                        {viTri + 1}
                      </span>
                    )}
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: on ? 'inherit' : CHU_MO }}>{m.ten}</span>
                    {m.chiDayDu && (
                      <span style={{ fontSize: 9.5, fontWeight: 700, color: 'hsl(224 76% 46%)', background: 'hsl(214 95% 94%)', borderRadius: 5, padding: '1px 5px' }}>
                        CHỈ Ở CHẾ ĐỘ ĐẦY ĐỦ
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: 11, color: CHU_MO, margin: '3px 0 0', lineHeight: 1.5 }}>{m.moTa}</p>
                </div>
                <div style={{ display: 'flex', gap: 2, flex: 'none' }}>
                  <button
                    type="button"
                    disabled={!on || viTri <= 0}
                    onClick={() => doiCho(k, -1)}
                    title="Lên trước"
                    style={nutMuiTen(!on || viTri <= 0)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    disabled={!on || viTri < 0 || viTri >= dangBat.length - 1}
                    onClick={() => doiCho(k, 1)}
                    title="Xuống sau"
                    style={nutMuiTen(!on || viTri < 0 || viTri >= dangBat.length - 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {dangBat.length === 0 && (
          <GhiChu canhBao>
            Không khối nào được bật — mỗi lượt gửi sẽ không có nội dung nào. Đây là cấu hình hợp lệ (dùng để tạm dừng
            nội dung mà vẫn giữ lịch), nhưng gần như chắc chắn không phải điều bạn muốn.
          </GhiChu>
        )}
      </div>

      {/* Lời mở đầu */}
      <TruongNhap
        nhan="Lời mở đầu (khối “link”)"
        id="mau-intro"
        ghiChu="Xuống dòng được. Biến chưa có dữ liệu sẽ được thay bằng chuỗi rỗng, không báo lỗi."
      >
        <Textarea
          id="mau-intro"
          ref={refIntro}
          rows={3}
          value={v.introText}
          onChange={(e) => onChange({ ...v, introText: e.target.value })}
          style={{ fontSize: 12.5, lineHeight: 1.55 }}
        />
        {chipBien('intro', BIEN_INTRO)}
      </TruongNhap>

      {/* Link tổng */}
      <TruongNhap
        nhan="Link tổng (thay cho biến {link})"
        id="mau-link"
        ghiChu="Đường dẫn tới bảng phòng trống công khai. Để trống thì biến {link} biến mất khỏi tin."
      >
        <Input
          id="mau-link"
          value={v.shareUrl}
          placeholder="https://…"
          onChange={(e) => onChange({ ...v, shareUrl: e.target.value })}
          style={{ height: 32, fontSize: 12.5 }}
        />
      </TruongNhap>

      {/* Mẫu tin chi tiết phòng */}
      <TruongNhap
        nhan="Mẫu tin chi tiết phòng (khối “chi tiết + ảnh từng phòng”)"
        id="mau-phong"
        ghiChu="Mẫu này lặp lại cho TỪNG phòng, mỗi phòng một tin. Viết dài thì mỗi lượt gửi cũng dài ra bấy nhiêu lần."
      >
        <Textarea
          id="mau-phong"
          ref={refPhong}
          rows={5}
          value={v.roomTemplate}
          onChange={(e) => onChange({ ...v, roomTemplate: e.target.value })}
          style={{ fontSize: 12.5, lineHeight: 1.55 }}
        />
        {chipBien('phong', BIEN_PHONG)}
      </TruongNhap>

      {/* Gửi bổ sung theo sự kiện */}
      <div style={{ border: `1px solid ${VIEN}`, borderRadius: 10, padding: '11px 12px' }}>
        <HangCongTac
          nhan={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Zap size={14} style={{ color: 'hsl(273 67% 45%)' }} />
              Gửi bổ sung khi có phòng mới trong ngày
            </span>
          }
          moTa={
            <>
              Phòng vừa trống giữa ngày sẽ được gửi ngay thay vì chờ tới lượt định kỳ hôm sau.
              Nhật ký ghi các lượt này với chế độ <b>event</b>.
            </>
          }
        >
          <Switch checked={ev.enabled} onCheckedChange={(x) => onEventDrivenChange({ ...ev, enabled: x })} />
        </HangCongTac>

        {ev.enabled && (
          <div style={{ marginTop: 11, paddingTop: 11, borderTop: `1px solid ${VIEN_NHAT}` }}>
            <TruongNhap
              nhan="Gom sự kiện trong"
              id="ev-debounce"
              ghiChu="Nhiều phòng trống trong cùng khoảng này sẽ gộp vào MỘT tin. Đặt quá ngắn thì trả một hợp đồng có 3 phòng sẽ thành 3 tin liên tiếp — đúng dấu hiệu bot."
            >
              <SoNguyenInput
                id="ev-debounce"
                value={ev.debounceMinutes}
                onChange={(n) => onEventDrivenChange({ ...ev, debounceMinutes: n })}
                min={5}
                max={720}
                macDinh={45}
                donVi="phút"
              />
            </TruongNhap>
          </div>
        )}
      </div>
    </div>
  );
}

/** Nút mũi tên đổi thứ tự — style dùng lại cho cả lên và xuống. */
function nutMuiTen(tat: boolean): CSSProperties {
  return {
    width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: `1px solid ${tat ? VIEN_NHAT : VIEN}`, borderRadius: 6, background: '#fff',
    color: tat ? 'hsl(210 10% 78%)' : 'hsl(215 25% 35%)',
    cursor: tat ? 'default' : 'pointer', padding: 0,
  };
}
