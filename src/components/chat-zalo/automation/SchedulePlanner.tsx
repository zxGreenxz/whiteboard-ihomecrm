// =============================================================================
// SchedulePlanner.tsx — giờ gửi + chế độ từng thứ trong tuần + hai quy tắc động.
//
// Ba thứ ở màn này quyết định "hôm nay có gửi không, và gửi kiểu gì":
//   1. `time`   — giờ hẹn.
//   2. `days`   — chế độ cứng theo thứ: ĐẦY ĐỦ / GỌN / không gửi.
//   3. hai quy tắc động, chạy SAU khi đã tra bảng thứ:
//        • `upgradeOnNewRooms` nâng một ngày GỌN thành ĐẦY ĐỦ khi có phòng mới;
//        • `skipIfUnchanged`   bỏ hẳn lượt khi danh sách y hệt lần trước.
// Thứ tự đó là thứ tự người dùng phải hiểu, nên UI cũng xếp đúng như vậy.
// =============================================================================

import { useMemo } from 'react';
import { Clock, CalendarDays } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { chuanHoaBroadcast } from '../automationConfig';
import type { LichGui, KhoaNgay, CheDoNgay } from '../automationConfig';
import { CHU_MO, VIEN, VIEN_NHAT, NEN_MO, GhiChu, HangCongTac, GioInput } from './uiChung';

interface Props {
  value: LichGui;
  onChange: (v: LichGui) => void;
}

/** Xếp theo tuần Việt Nam (Thứ 2 trước), khác `KHOA_NGAY` vốn xếp theo
 *  `Date.getDay()` với Chủ nhật đứng đầu. Chỉ là thứ tự HIỂN THỊ. */
const THU_TU_HIEN_THI: readonly KhoaNgay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const TEN_NGAY: Record<KhoaNgay, string> = {
  mon: 'Thứ 2', tue: 'Thứ 3', wed: 'Thứ 4', thu: 'Thứ 5',
  fri: 'Thứ 6', sat: 'Thứ 7', sun: 'Chủ nhật',
};

const TEN_CHE_DO: Record<CheDoNgay, string> = {
  full: 'ĐẦY ĐỦ — link + ảnh bảng + chi tiết từng phòng',
  compact: 'GỌN — link + ảnh bảng',
  off: 'Không gửi',
};

const TEN_NGAN: Record<CheDoNgay, string> = { full: 'ĐẦY ĐỦ', compact: 'GỌN', off: 'Không gửi' };

const MAU_CHE_DO: Record<CheDoNgay, string> = {
  full: 'hsl(224 76% 46%)',
  compact: 'hsl(215 25% 35%)',
  off: 'hsl(210 10% 62%)',
};

export default function SchedulePlanner({ value, onChange }: Props) {
  // Không tin `value`: bản ghi cũ có thể thiếu khoá, hoặc DB bị sửa tay. Nhét
  // qua `chuanHoaBroadcast` rồi lấy nhánh `schedule` là dùng ĐÚNG bộ luật mà
  // worker dùng, thay vì viết lại một bộ mặc định thứ hai ở đây.
  const v = useMemo(() => chuanHoaBroadcast({ schedule: value }).schedule, [value]);

  const doiNgay = (k: KhoaNgay, che: CheDoNgay) => onChange({ ...v, days: { ...v.days, [k]: che } });

  const soLuotTuan = THU_TU_HIEN_THI.filter((k) => v.days[k] !== 'off').length;
  const soDayDu = THU_TU_HIEN_THI.filter((k) => v.days[k] === 'full').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Giờ gửi */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Clock size={15} style={{ color: CHU_MO, flex: 'none' }} />
        <label htmlFor="lich-gio" style={{ fontSize: 12.5, fontWeight: 600 }}>Giờ gửi hằng ngày</label>
        <GioInput id="lich-gio" value={v.time} macDinh="08:30" onChange={(t) => onChange({ ...v, time: t })} />
        <span style={{ fontSize: 11, color: CHU_MO }}>
          Giờ máy chủ. Lượt gửi vẫn phải nằm trong khung giờ cho phép ở khối Chống spam.
        </span>
      </div>

      {/* Bảng 7 thứ */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
          <CalendarDays size={15} style={{ color: CHU_MO }} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Chế độ theo thứ</span>
          <span style={{ fontSize: 11, color: CHU_MO }}>
            — {soLuotTuan}/7 ngày có gửi ({soDayDu} ngày đầy đủ)
          </span>
        </div>

        <div style={{ border: `1px solid ${VIEN}`, borderRadius: 10, overflow: 'hidden' }}>
          {THU_TU_HIEN_THI.map((k, i) => (
            <div
              key={k}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 11px',
                borderTop: i === 0 ? 'none' : `1px solid ${VIEN_NHAT}`,
                background: v.days[k] === 'off' ? NEN_MO : 'transparent',
              }}
            >
              <span style={{ width: 68, flex: 'none', fontSize: 12.5, fontWeight: 600 }}>{TEN_NGAY[k]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Select value={v.days[k]} onValueChange={(x) => doiNgay(k, x as CheDoNgay)}>
                  <SelectTrigger style={{ height: 32, fontSize: 12.5 }} aria-label={`Chế độ ${TEN_NGAY[k]}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">{TEN_CHE_DO.full}</SelectItem>
                    <SelectItem value="compact">{TEN_CHE_DO.compact}</SelectItem>
                    <SelectItem value="off">{TEN_CHE_DO.off}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <span style={{ width: 74, flex: 'none', textAlign: 'right', fontSize: 10.5, fontWeight: 700, color: MAU_CHE_DO[v.days[k]] }}>
                {TEN_NGAN[v.days[k]]}
              </span>
            </div>
          ))}
        </div>

        {soLuotTuan === 0 && (
          <GhiChu canhBao>
            Cả 7 ngày đều “Không gửi” — bản tin định kỳ sẽ không bao giờ chạy, kể cả khi tính năng đang bật.
          </GhiChu>
        )}
      </div>

      {/* Hai quy tắc động */}
      <div style={{ border: `1px solid ${VIEN}`, borderRadius: 10, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 13 }}>
        <HangCongTac
          nhan="Có phòng trống MỚI thì nâng thành ĐẦY ĐỦ"
          moTa={
            <>
              Ngày đang đặt <b>GỌN</b> mà danh sách xuất hiện phòng chưa từng chào sẽ tự chuyển sang <b>ĐẦY ĐỦ</b>,
              tức có thêm chi tiết và ảnh từng phòng. Tốn thêm nhịp gửi, đổi lại phòng mới được nhìn thấy ngay
              thay vì chờ tới ngày đầy đủ kế tiếp. Ngày đang “Không gửi” <b>không</b> bị nâng.
            </>
          }
        >
          <Switch checked={v.upgradeOnNewRooms} onCheckedChange={(x) => onChange({ ...v, upgradeOnNewRooms: x })} />
        </HangCongTac>

        <div style={{ height: 1, background: VIEN_NHAT }} />

        <HangCongTac
          nhan="Danh sách không đổi thì bỏ lượt"
          moTa={
            <>
              Danh sách phòng trống y hệt lần gửi trước thì bỏ hẳn lượt hôm đó, ghi vào nhật ký với chế độ
              <b> skipped</b>. Đây là thứ giữ cho nhóm sale không nhận đúng một bảng lặp lại mỗi sáng —
              cách nhanh nhất để bị tắt thông báo hoặc bị đá khỏi nhóm. Tắt đi thì ngày nào cũng gửi, dù không có gì mới.
            </>
          }
        >
          <Switch checked={v.skipIfUnchanged} onCheckedChange={(x) => onChange({ ...v, skipIfUnchanged: x })} />
        </HangCongTac>
      </div>
    </div>
  );
}
