// =============================================================================
// RunLog.tsx — nhật ký các lượt tự động hoá đã chạy (CHỈ ĐỌC).
//
// Worker là bên ghi bảng `zalo_automation_runs`; web chỉ đọc. Cột quan trọng
// nhất ở đây là `reason` và nó được hiện NGUYÊN VĂN, không dịch, không rút gọn:
// khi một sáng nào đó sale hỏi "sao hôm nay không thấy tin", câu trả lời nằm
// đúng trong chuỗi worker đã ghi (`danh sách không đổi`, `ngoài khung giờ`,
// `chạm trần ngày`, một mã lỗi Zalo…). Diễn giải lại chuỗi đó ở tầng UI chỉ tạo
// thêm một chỗ để nói sai.
// =============================================================================

import { Loader2, History } from 'lucide-react';
import { tagStyle } from '../zaloTheme';
import { mono } from '../infoCards';
import type { TagKey } from '@/components/chat-zalo/types';
import type { ZaloAutomationRun } from '@/hooks/useZaloChat';
import { CHU_MO, VIEN, VIEN_NHAT, NEN_MO } from './uiChung';

interface Props {
  runs: ZaloAutomationRun[];
  loading?: boolean;
}

/** Nhãn + tông badge cho từng chế độ. Tông lấy từ bảng TAG của Chat Zalo để
 *  màu ở đây khớp badge ở mọi chỗ khác trong trang. */
const CHE_DO: Record<string, { ten: string; tone: TagKey; mo?: boolean }> = {
  full: { ten: 'ĐẦY ĐỦ', tone: 'info' },
  compact: { ten: 'GỌN', tone: 'neutral' },
  event: { ten: 'BỔ SUNG', tone: 'purple' },
  reply: { ten: 'TRẢ LỜI', tone: 'success' },
  skipped: { ten: 'BỎ LƯỢT', tone: 'warning' },
  off: { ten: 'ĐANG TẮT', tone: 'neutral', mo: true },
  failed: { ten: 'LỖI', tone: 'danger' },
};

/** Loại lượt chạy. `event` là bản tin bổ sung giữa ngày, khác lượt định kỳ —
 *  phân biệt được hai thứ này là điều kiện để đọc hiểu cột "số tin". */
function tenLoai(r: ZaloAutomationRun): string {
  if (r.kind === 'auto_reply') return 'Trả lời';
  return r.mode === 'event' ? 'Bổ sung' : 'Định kỳ';
}

function gioPhut(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

const O_TIEU_DE = {
  textAlign: 'left' as const,
  padding: '7px 10px',
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '.04em',
  textTransform: 'uppercase' as const,
  color: CHU_MO,
  whiteSpace: 'nowrap' as const,
};

const O = { padding: '8px 10px', fontSize: 12, verticalAlign: 'top' as const };

export default function RunLog({ runs, loading }: Props) {
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 12px', fontSize: 12, color: CHU_MO }}>
        <Loader2 size={14} className="animate-spin" />
        Đang tải nhật ký…
      </div>
    );
  }

  const ds = Array.isArray(runs) ? runs : [];

  if (ds.length === 0) {
    return (
      <div style={{ border: `1px dashed ${VIEN}`, borderRadius: 10, padding: '20px 16px', textAlign: 'center' }}>
        <History size={22} style={{ color: 'hsl(210 10% 70%)' }} />
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 7 }}>Chưa có lần chạy nào</div>
        <p style={{ fontSize: 11.5, color: CHU_MO, margin: '5px auto 0', lineHeight: 1.55, maxWidth: 420 }}>
          Nhật ký ghi lại mọi lượt tự động: gửi thật, bỏ lượt vì danh sách không đổi, hay dừng vì chạm trần ngày.
          Bật tự động hoá và chọn người nhận, dòng đầu tiên sẽ xuất hiện sau lượt gửi kế tiếp.
        </p>
      </div>
    );
  }

  return (
    // Bảng 6 cột không vừa cột phải của trang chat — cho cuộn ngang trong khung
    // riêng thay vì để cả trang trôi ngang.
    <div style={{ border: `1px solid ${VIEN}`, borderRadius: 10, overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: NEN_MO }}>
            <th style={O_TIEU_DE}>Thời gian</th>
            <th style={O_TIEU_DE}>Loại</th>
            <th style={O_TIEU_DE}>Chế độ</th>
            <th style={{ ...O_TIEU_DE, textAlign: 'right' }}>Người nhận</th>
            <th style={{ ...O_TIEU_DE, textAlign: 'right' }}>Số tin</th>
            <th style={{ ...O_TIEU_DE, width: '45%' }}>Lý do</th>
          </tr>
        </thead>
        <tbody>
          {ds.map((r) => {
            const c = CHE_DO[r.mode] || { ten: String(r.mode || '—').toUpperCase(), tone: 'neutral' as TagKey };
            return (
              <tr key={r.id} style={{ borderTop: `1px solid ${VIEN_NHAT}` }}>
                <td style={{ ...O, whiteSpace: 'nowrap', ...mono({ fontSize: 11.5, color: CHU_MO }) }}>
                  {gioPhut(r.createdAt)}
                </td>
                <td style={{ ...O, whiteSpace: 'nowrap', fontWeight: 600 }}>{tenLoai(r)}</td>
                <td style={O}>
                  <span style={tagStyle(c.tone, { fontSize: 10, opacity: c.mo ? 0.65 : 1 })}>{c.ten}</span>
                </td>
                <td style={{ ...O, textAlign: 'right', ...mono({ fontSize: 12 }) }}>{r.recipientsCount ?? 0}</td>
                <td style={{ ...O, textAlign: 'right', ...mono({ fontSize: 12 }) }}>{r.messagesCount ?? 0}</td>
                <td style={{ ...O, color: r.mode === 'failed' ? 'hsl(0 70% 42%)' : CHU_MO, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {r.reason || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
