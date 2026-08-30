// =============================================================================
// uiChung.tsx — mẩu giao diện dùng chung cho màn cài đặt tự động hoá.
//
// Vì sao có file này: năm component trong thư mục `automation/` đều cần đúng ba
// thứ — thẻ khối có tiêu đề, dòng giải thích hậu quả, và ô nhập số biết tự kẹp
// giá trị. Chép năm bản của cùng ba thứ đó là cách chắc chắn nhất để chúng lệch
// nhau (khoảng kẹp ở màn này khác màn kia, chữ giải thích ở đây nói một đằng ở
// kia nói một nẻo). Gom về một chỗ thì sửa một lần là xong.
//
// Nhịp thị giác bám theo `AutomationPanel.tsx` / `InfoPanel.tsx`: style inline,
// viền mảnh hsl(210 20% 90%), bo 12, chữ 11–13.5px.
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { EMERALD } from '../zaloTheme';
import { soNguyen, gioHopLe } from '../automationConfig';

export const VIEN = 'hsl(210 20% 90%)';
export const VIEN_NHAT = 'hsl(210 20% 94%)';
export const CHU_MO = 'hsl(210 10% 45%)';
export const NEN_MO = 'hsl(210 20% 97%)';
export const CAM = 'hsl(17 88% 38%)';

/* ------------------------------------------------------------------- khối */

interface KhoiProps {
  icon?: ReactNode;
  tieuDe: string;
  /** Một câu nói rõ khối này quyết định điều gì. */
  moTa?: ReactNode;
  /** Góc phải tiêu đề — thường là công tắc bật/tắt của riêng khối. */
  phai?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}

/** Thẻ viền mảnh có tiêu đề — đơn vị bố cục của cả màn cài đặt. */
export function KhoiCaiDat({ icon, tieuDe, moTa, phai, children, style }: KhoiProps) {
  return (
    <section style={{ border: `1px solid ${VIEN}`, borderRadius: 12, padding: '13px 14px', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {icon ? <span style={{ display: 'flex', color: EMERALD, flex: 'none' }}>{icon}</span> : null}
          <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0 }}>{tieuDe}</h3>
        </div>
        {phai}
      </div>
      {moTa ? (
        <p style={{ fontSize: 11.5, color: CHU_MO, margin: '5px 0 0', lineHeight: 1.55 }}>{moTa}</p>
      ) : null}
      <div style={{ marginTop: 11 }}>{children}</div>
    </section>
  );
}

/* --------------------------------------------------------------- ghi chú */

/** Dòng giải thích HẬU QUẢ dưới một điều khiển.
 *
 *  Không phải trang trí. Người dùng ở màn này đang chỉnh phanh của một API
 *  không chính thức (zca-js): mỗi ô đều có thể biến broadcast thành hành vi
 *  giống bot. Ai chỉnh phải đọc được ngay mình vừa đánh đổi cái gì. */
export function GhiChu({ children, canhBao }: { children: ReactNode; canhBao?: boolean }) {
  return (
    <p
      style={{
        fontSize: 11, lineHeight: 1.5, margin: '5px 0 0',
        color: canhBao ? CAM : CHU_MO, display: 'flex', gap: 5, alignItems: 'flex-start',
      }}
    >
      {canhBao ? <AlertTriangle size={12} style={{ flex: 'none', marginTop: 2 }} /> : null}
      <span>{children}</span>
    </p>
  );
}

/** Băng cảnh báo cả khối (vd: chưa chọn người nhận → broadcast sẽ không chạy). */
export function BangCanhBao({ children, tone = 'warning' }: { children: ReactNode; tone?: 'warning' | 'danger' | 'info' }) {
  const mau =
    tone === 'danger' ? { bg: 'hsl(0 86% 96%)', fg: 'hsl(0 70% 40%)', vien: 'hsl(0 70% 88%)' }
      : tone === 'info' ? { bg: 'hsl(214 95% 96%)', fg: 'hsl(224 76% 42%)', vien: 'hsl(214 60% 88%)' }
        : { bg: 'hsl(55 97% 93%)', fg: 'hsl(32 81% 29%)', vien: 'hsl(45 80% 82%)' };
  return (
    <div
      style={{
        display: 'flex', gap: 8, alignItems: 'flex-start',
        background: mau.bg, color: mau.fg, border: `1px solid ${mau.vien}`,
        borderRadius: 10, padding: '9px 11px', fontSize: 11.5, lineHeight: 1.55, fontWeight: 500,
      }}
    >
      <AlertTriangle size={14} style={{ flex: 'none', marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------- trường */

interface TruongProps {
  nhan: ReactNode;
  id?: string;
  children: ReactNode;
  ghiChu?: ReactNode;
  canhBao?: boolean;
  style?: CSSProperties;
}

/** Một trường: nhãn → điều khiển → ghi chú hậu quả. */
export function TruongNhap({ nhan, id, children, ghiChu, canhBao, style }: TruongProps) {
  return (
    <div style={style}>
      <label
        htmlFor={id}
        style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: 'hsl(215 25% 30%)', marginBottom: 5 }}
      >
        {nhan}
      </label>
      {children}
      {ghiChu ? <GhiChu canhBao={canhBao}>{ghiChu}</GhiChu> : null}
    </div>
  );
}

/** Hàng công tắc: nhãn + mô tả bên trái, `children` (Switch) bên phải. */
export function HangCongTac({ nhan, moTa, children }: { nhan: ReactNode; moTa?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{nhan}</div>
        {moTa ? <p style={{ fontSize: 11, color: CHU_MO, margin: '3px 0 0', lineHeight: 1.5 }}>{moTa}</p> : null}
      </div>
      <div style={{ flex: 'none', paddingTop: 2 }}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------- ô nhập số kẹp */

interface SoProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  macDinh: number;
  donVi?: string;
  id?: string;
  /** Rộng ô số (px). Mặc định 96 — vừa cho 4 chữ số. */
  rong?: number;
}

/** Ô nhập số nguyên có kẹp khoảng, CHỐT KHI RỜI Ô chứ không kẹp từng phím.
 *
 *  Vì sao không kẹp ngay khi gõ: khoảng hợp lệ của "giãn nhịp giữa người nhận"
 *  là 30..3600. Kẹp từng phím thì người gõ "180" vừa bấm "1" đã bị nhảy thành
 *  "30", ký tự sau nối vào thành "301" — không ai gõ nổi. Nên giữ chuỗi thô
 *  trong lúc gõ, `soNguyen()` chốt lại khi blur hoặc Enter.
 *
 *  Bấm nút Lưu vẫn an toàn: mousedown làm ô mất focus → blur chạy và chốt giá
 *  trị TRƯỚC khi sự kiện click tới nút. Và dù có lọt, cha vẫn `chuanHoa*` một
 *  lần nữa trước khi ghi DB. */
export function SoNguyenInput({ value, onChange, min, max, macDinh, donVi, id, rong = 96 }: SoProps) {
  const [tho, setTho] = useState<string>(String(value ?? macDinh));
  // Nhớ giá trị đã đẩy lên cha: chỉ đồng bộ lại ô khi cha đổi THẬT (nạp dữ liệu
  // về, bấm khôi phục mặc định). Đồng bộ vô điều kiện sẽ nuốt ký tự đang gõ dở
  // mỗi lần cha render lại vì một lý do khác.
  const daDay = useRef<number>(value);

  useEffect(() => {
    if (value !== daDay.current) {
      daDay.current = value;
      setTho(String(value ?? macDinh));
    }
  }, [value, macDinh]);

  const chot = () => {
    const n = soNguyen(tho, value ?? macDinh, min, max);
    daDay.current = n;
    setTho(String(n));
    if (n !== value) onChange(n);
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={tho}
        onChange={(e) => setTho(e.target.value)}
        onBlur={chot}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); chot(); } }}
        style={{ width: rong, height: 32 }}
      />
      {donVi ? <span style={{ fontSize: 11.5, color: CHU_MO, whiteSpace: 'nowrap' }}>{donVi}</span> : null}
      <span style={{ fontSize: 10.5, color: 'hsl(210 10% 60%)', whiteSpace: 'nowrap' }}>
        ({min}–{max})
      </span>
    </span>
  );
}

/* ---------------------------------------------------------- ô nhập giờ */

/** Ô giờ "HH:MM". Xoá trắng thì GIỮ giá trị cũ — không có trạng thái "không
 *  có giờ" trong hợp đồng, để trống sẽ thành giờ mặc định lúc lưu và người dùng
 *  không hiểu vì sao. */
export function GioInput({ value, onChange, macDinh, id }: { value: string; onChange: (v: string) => void; macDinh: string; id?: string }) {
  return (
    <Input
      id={id}
      type="time"
      value={gioHopLe(value, macDinh)}
      onChange={(e) => { const v = e.target.value; if (v) onChange(gioHopLe(v, macDinh)); }}
      style={{ width: 116, height: 32 }}
    />
  );
}
