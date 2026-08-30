// =============================================================================
// AntiSpamFields.tsx — năm cái phanh của broadcast.
//
// ĐỌC TRƯỚC KHI CHỈNH: kết nối Zalo ở đây đi qua `zca-js`, một thư viện dựng
// trên API KHÔNG CHÍNH THỨC. Không có hạn mức được công bố, không có cảnh báo
// trước, và không có đường khiếu nại — Zalo chỉ việc khoá nick. Nick bị khoá
// thì mất luôn cả lịch sử chat với khách, không chỉ mất tính năng tự động.
//
// Vì vậy các ô ở đây không phải "tuỳ chọn hiệu năng". Chúng là khoảng cách an
// toàn. `chuanHoaBroadcast` kẹp cứng mọi giá trị (30..3600 · 5..600 · 1..30 ·
// 1..2000) nên gõ gì ngoài khoảng cũng bị ép về; UI chỉ việc nói rõ vì sao.
// =============================================================================

import { useMemo } from 'react';
import { ShieldAlert } from 'lucide-react';
import { chuanHoaBroadcast } from '../automationConfig';
import type { ChongSpam } from '../automationConfig';
import { CHU_MO, VIEN_NHAT, TruongNhap, SoNguyenInput, GioInput, BangCanhBao } from './uiChung';

interface Props {
  value: ChongSpam;
  onChange: (v: ChongSpam) => void;
}

export default function AntiSpamFields({ value, onChange }: Props) {
  // Cùng một hàm chuẩn hoá với worker — không viết lại khoảng kẹp ở đây, vì hai
  // bộ số song song là cách chắc chắn để chúng lệch nhau sau vài lần sửa.
  const v = useMemo(() => chuanHoaBroadcast({ antiSpam: value }).antiSpam, [value]);

  const doiGio = (k: 'from' | 'to', t: string) => onChange({ ...v, allowedHours: { ...v.allowedHours, [k]: t } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
      <BangCanhBao tone="danger">
        <b>Đây là phanh giữ nick Zalo, không phải tuỳ chọn tốc độ.</b> Kết nối dùng thư viện không chính thức
        (<code style={{ fontFamily: "'Space Mono', ui-monospace, monospace" }}>zca-js</code>): gửi dày là dấu hiệu bot,
        và Zalo khoá nick không báo trước — mất luôn lịch sử chat với khách. Nới các số dưới đây thì phải chấp nhận rủi ro đó.
      </BangCanhBao>

      {/* Khung giờ */}
      <TruongNhap
        nhan="Khung giờ được phép gửi"
        ghiChu="Mọi lượt tự động (định kỳ, bổ sung, trả lời) đều bị chặn ngoài khung này. Đặt sát giờ hành chính để tin trông giống người thật gửi — 3 giờ sáng thì chỉ có máy."
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <GioInput value={v.allowedHours.from} macDinh="08:00" onChange={(t) => doiGio('from', t)} />
          <span style={{ fontSize: 12, color: CHU_MO }}>đến</span>
          <GioInput value={v.allowedHours.to} macDinh="20:00" onChange={(t) => doiGio('to', t)} />
        </span>
      </TruongNhap>

      <div style={{ height: 1, background: VIEN_NHAT }} />

      {/* Giãn nhịp giữa người nhận */}
      <TruongNhap
        nhan="Giãn nhịp giữa hai người nhận"
        id="as-gap-nguoi"
        ghiChu="Sau khi gửi xong cho một người, chờ bấy nhiêu giây rồi mới sang người kế. Số này nhân với số người nhận ra tổng thời gian một lượt broadcast — 10 người × 180 giây là nửa tiếng."
      >
        <SoNguyenInput
          id="as-gap-nguoi"
          value={v.gapBetweenRecipientsSec}
          onChange={(n) => onChange({ ...v, gapBetweenRecipientsSec: n })}
          min={30}
          max={3600}
          macDinh={180}
          donVi="giây"
        />
      </TruongNhap>

      {/* Giãn nhịp giữa các tin phòng */}
      <TruongNhap
        nhan="Giãn nhịp giữa các tin chi tiết phòng"
        id="as-gap-phong"
        ghiChu="Khoảng nghỉ giữa hai tin phòng trong CÙNG một hội thoại. Đây là chỗ dễ trông giống bot nhất: năm tin liên tiếp trong vài giây là mẫu hành vi máy rõ nhất."
      >
        <SoNguyenInput
          id="as-gap-phong"
          value={v.gapBetweenRoomMsgsSec}
          onChange={(n) => onChange({ ...v, gapBetweenRoomMsgsSec: n })}
          min={5}
          max={600}
          macDinh={20}
          donVi="giây"
        />
      </TruongNhap>

      {/* Trần số phòng chi tiết */}
      <TruongNhap
        nhan="Tối đa số phòng gửi chi tiết mỗi lượt"
        id="as-max-phong"
        ghiChu="Còn 40 phòng trống cũng chỉ gửi chi tiết bấy nhiêu phòng đầu; phần còn lại nằm ở ảnh bảng và link tổng. Trần này chỉ áp cho khối “chi tiết + ảnh từng phòng”."
      >
        <SoNguyenInput
          id="as-max-phong"
          value={v.maxRoomsPerRun}
          onChange={(n) => onChange({ ...v, maxRoomsPerRun: n })}
          min={1}
          max={30}
          macDinh={5}
          donVi="phòng"
        />
      </TruongNhap>

      {/* Trần ngày */}
      <TruongNhap
        nhan="Trần tổng số tin tự động mỗi ngày"
        id="as-tran-ngay"
        canhBao
        ghiChu="Chốt chặn cuối cùng, tính CHUNG cho định kỳ + bổ sung. Chạm trần thì mọi lượt còn lại trong ngày dừng và ghi nhật ký. Đây là thứ giữ cho một cấu hình sai không kịp đốt hết nick trước khi có người phát hiện."
      >
        <SoNguyenInput
          id="as-tran-ngay"
          value={v.dailyCap}
          onChange={(n) => onChange({ ...v, dailyCap: n })}
          min={1}
          max={2000}
          macDinh={120}
          donVi="tin/ngày"
          rong={110}
        />
      </TruongNhap>

      <p style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11, color: CHU_MO, lineHeight: 1.5, margin: 0 }}>
        <ShieldAlert size={13} style={{ flex: 'none', marginTop: 2 }} />
        <span>
          Giá trị ngoài khoảng in trong ngoặc sẽ bị ép về đầu gần nhất ngay khi rời ô — cùng luật mà worker áp
          lúc đọc cấu hình, nên thứ bạn thấy ở đây đúng là thứ sẽ chạy.
        </span>
      </p>
    </div>
  );
}
