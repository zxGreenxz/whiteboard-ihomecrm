import { RefreshCw, TriangleAlert, Unplug } from 'lucide-react';
import { canhBaoKetNoi } from '@/lib/zaloContent';
import type { ZaloAccount } from './types';

const pad = (n: number) => String(n).padStart(2, '0');
function gioNgay(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

interface Props {
  /** undefined = chưa đọc được nhịp tim worker */
  status: { online: boolean; heartbeatAt: string | null } | undefined;
  accounts: readonly ZaloAccount[];
  onReconnect: (accountId: string) => void;
}

/**
 * Băng cảnh báo đầu danh sách hội thoại. 05/09–10/10/2026 worker Zalo dừng mà web vẫn hiện chấm
 * xanh "Đang kết nối", không ai biết tin mới không còn về CRM. Băng này đọc nhịp tim thật.
 */
export default function ZaloWorkerBanner({ status, accounts, onReconnect }: Props) {
  const canhBao = canhBaoKetNoi(status, accounts);
  if (!canhBao) return null;

  if (canhBao.loai === 'worker') {
    return (
      <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 12px', background: 'hsl(0 85% 97%)', borderBottom: '1px solid hsl(0 70% 88%)', color: 'hsl(0 60% 32%)', fontSize: 12, lineHeight: 1.45 }}>
        <Unplug size={15} style={{ flex: 'none', marginTop: 1 }} />
        <span>
          <b>Zalo đang mất kết nối{canhBao.tu ? ` từ ${gioNgay(canhBao.tu)}` : ''}.</b>{' '}
          Tin mới chưa về CRM; tin bạn gửi sẽ đi khi kết nối lại.
        </span>
      </div>
    );
  }

  return (
    <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '9px 12px', background: 'hsl(40 95% 95%)', borderBottom: '1px solid hsl(38 80% 82%)', color: 'hsl(30 60% 28%)', fontSize: 12, lineHeight: 1.45 }}>
      <TriangleAlert size={15} style={{ flex: 'none' }} />
      <span style={{ flex: 1, minWidth: 0 }} title={canhBao.loi || undefined}>
        <b>Phiên Zalo của {canhBao.ten || 'tài khoản'} cần quét QR lại.</b>
      </span>
      <button
        onClick={() => onReconnect(canhBao.accountId)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none', border: '1px solid hsl(38 70% 70%)', background: '#fff', color: 'hsl(30 60% 28%)', borderRadius: 7, padding: '4px 8px', fontWeight: 700, fontSize: 11.5, cursor: 'pointer' }}
      >
        <RefreshCw size={12} />Kết nối lại
      </button>
    </div>
  );
}
