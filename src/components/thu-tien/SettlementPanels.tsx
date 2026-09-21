import { PiggyBank } from 'lucide-react';
import { useDepositLedger, useDepositLedgerSummary } from '@/hooks/useThanhToanLedgers';

/**
 * Sổ cọc đã thu còn nằm trong trang Thanh toán. Hoàn khách, hoa hồng và thưởng
 * Sale đã chuyển sang ContractSettlementWorkspace và máy phiếu dùng chung.
 */

const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN') + 'đ';
const fmtDate = (s: string | null) => {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

// ── CỌC ĐÃ THU ───────────────────────────────────────────────────────────────

export function DepositLedgerSection({ period }: { period: string }) {
  const q = useDepositLedger(period);
  const sum = useDepositLedgerSummary(q.data);
  const rows = q.data ?? [];

  return (
    <div className="ptt-scroll">
      <div className="ptt-comm-stats">
        <div className="ptt-comm-card"><div className="ptt-ov-lbl">Phiếu cọc kỳ này</div><div className="ptt-comm-num">{sum.total}</div><div className="ptt-ov-sub">theo ngày phiếu</div></div>
        <div className="ptt-comm-card green"><div className="ptt-ov-lbl">Tiền THẬT vào két</div><div className="ptt-comm-num green">{fmt(sum.posted)}</div><div className="ptt-ov-sub">{sum.postedN} phiếu đã vào sổ quỹ</div></div>
        <div className="ptt-comm-card"><div className="ptt-ov-lbl">Ghi nhận sổ ảo</div><div className="ptt-comm-num">{fmt(sum.virtual)}</div><div className="ptt-ov-sub">{sum.virtualN} phiếu — chưa từng vào két</div></div>
        <div className="ptt-comm-card amber"><div className="ptt-ov-lbl">Chờ duyệt</div><div className="ptt-comm-num amber">{fmt(sum.pending)}</div><div className="ptt-ov-sub">{sum.pendingN} phiếu</div></div>
      </div>

      <div className="ud-body">
        {q.isLoading ? (
          <div className="ud-empty">⏳ Đang tải…</div>
        ) : rows.length === 0 ? (
          <div className="ud-empty">📄 Kỳ này không có phiếu thu cọc nào.</div>
        ) : (
          <div className="ud-tablewrap">
            <table className="ud-table">
              <thead><tr><th>Phiếu</th><th>Toà · Phòng</th><th>Hợp đồng</th><th>Ngày</th><th className="num">Số tiền</th><th>Sổ quỹ</th><th className="ctr">Két thật?</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="ud-mono2">{r.code ?? '—'}</td>
                    <td>{r.buildingName}{r.roomName ? ` · ${r.roomName}` : ''}</td>
                    <td className="ud-mono2">{r.contractNumber ?? 'cọc giữ chỗ'}</td>
                    <td className="ud-mono2">{fmtDate(r.voucherDate)}</td>
                    <td className="num"><span className={'ud-mono' + (r.postingStatus === 'POSTED' ? ' paid' : '')}>{fmt(r.amount)}</span></td>
                    <td>{r.accountName ?? '—'}</td>
                    <td className="ctr">
                      {r.postingStatus === 'POSTED' ? <span className="ptt-comm-paid">Đã vào két</span>
                        : r.postingStatus === 'NOT_APPLICABLE' ? <span className="ptt-tier" title="Chỉ ghi nhận trên sổ ảo — tiền chưa từng vào két">sổ ảo</span>
                        : <span className="ptt-badge-draft">CHỜ DUYỆT</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="ptt-note mx" style={{ marginTop: 10 }}>
          <PiggyBank />
          <span>
            <b>Két thật</b> = tiền đã vào sổ quỹ. <b>Sổ ảo</b> = mới ghi nhận trên giấy, chưa cầm
            tiền — hoàn cọc cho nhóm này là chi một khoản chưa hề thu, nên nút Kiểm tra bên Chi
            thanh lý sẽ chặn lại hỏi chủ.
          </span>
        </p>
      </div>
    </div>
  );
}
