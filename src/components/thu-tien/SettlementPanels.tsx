import { useState } from 'react';
import { Wallet, HandCoins, PiggyBank, SearchCheck } from 'lucide-react';
import { TerminationRefundDialog } from '@/components/contracts/TerminationRefundDialog';
import {
  useTerminationRefundQueue, useSaleBonusVouchers,
  useDepositLedger, useDepositLedgerSummary,
} from '@/hooks/useThanhToanLedgers';

/**
 * Ba SỔ THEO DÕI của trang Thanh toán: chi thanh lý · thưởng Sale · cọc đã thu.
 * Dùng chung bộ class "ptt-" và "ud-" sẵn có của trang để khớp giao diện.
 */

const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN') + 'đ';
const fmtDate = (s: string | null) => {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

// ── 1. HÀNG ĐỢI CHI THANH LÝ ─────────────────────────────────────────────────

export function TerminationRefundQueueSection({ period }: { period: string }) {
  const q = useTerminationRefundQueue(period);
  const [openTerm, setOpenTerm] = useState<string | null>(null);
  const rows = q.data ?? [];

  const posted = rows.filter((r) => r.refundVoucherStatus === 'POSTED');
  const pending = rows.filter((r) => r.refundVoucherStatus === 'PENDING');
  // QUYẾT ĐỊNH GHI LẠI (audit 27/08 F7): `refundAmount` là cột GENERATED của hồ
  // sơ — KHÔNG phải số phải trả. Ở đây nó chỉ làm TRIAGE ("hồ sơ nói phải hoàn
  // mà chưa thấy phiếu → đáng bấm Kiểm tra"), và bảng đặt nó cạnh cột "Phiếu
  // hoàn thật" với tiêu đề nói rõ nguồn. Số phải trả THẬT do
  // preview_termination_refund_v1 tính trong dialog, đối chiếu cọc thật đã vào
  // két — không con số nào ở màn này được dùng để ghi tiền.
  const none = rows.filter((r) => r.refundVoucherStatus === null && r.refundAmount > 0);
  const owes = rows.filter((r) => r.refundAmount <= 0 && r.refundVoucherStatus === null);

  return (
    <div className="ptt-scroll">
      <div className="ptt-comm-stats">
        <div className="ptt-comm-card"><div className="ptt-ov-lbl">Hồ sơ thanh lý kỳ này</div><div className="ptt-comm-num">{rows.length}</div><div className="ptt-ov-sub">theo ngày thanh lý</div></div>
        <div className="ptt-comm-card green"><div className="ptt-ov-lbl">Đã chi hoàn (vào sổ)</div><div className="ptt-comm-num green">{fmt(posted.reduce((s, r) => s + (r.refundVoucherAmount ?? 0), 0))}</div><div className="ptt-ov-sub">{posted.length} phiếu đã vào sổ quỹ</div></div>
        <div className="ptt-comm-card amber"><div className="ptt-ov-lbl">Phiếu hoàn chờ duyệt</div><div className="ptt-comm-num amber">{fmt(pending.reduce((s, r) => s + (r.refundVoucherAmount ?? 0), 0))}</div><div className="ptt-ov-sub">{pending.length} phiếu chờ duyệt</div></div>
        <div className="ptt-comm-card red"><div className="ptt-ov-lbl">Chưa có phiếu hoàn</div><div className="ptt-comm-num red">{none.length}</div><div className="ptt-ov-sub">{owes.length > 0 ? `+ ${owes.length} hồ sơ khách còn nợ (không hoàn)` : 'hồ sơ có số hoàn dương'}</div></div>
      </div>

      <div className="ud-body">
        {q.isLoading ? (
          <div className="ud-empty">⏳ Đang tải…</div>
        ) : q.isError ? (
          <div className="ud-empty">Không đọc được: {q.error instanceof Error ? q.error.message : '?'}</div>
        ) : rows.length === 0 ? (
          <div className="ud-empty">📄 Không có hồ sơ thanh lý nào trong kỳ. Đổi kỳ ở góc phải trên để xem tháng khác.</div>
        ) : (
          <div className="ud-tablewrap">
            <table className="ud-table">
              <thead><tr><th>Hợp đồng</th><th>Toà · Phòng</th><th>Ngày thanh lý</th><th className="num">Cọc trên hồ sơ</th><th className="num">Số hoàn (hồ sơ)</th><th className="num">Phiếu hoàn thật</th><th className="act">Thao tác</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.terminationId}>
                    <td className="ud-mono2">{r.contractNumber ?? '—'}</td>
                    <td>{r.buildingName} · {r.roomName}</td>
                    <td className="ud-mono2">{fmtDate(r.terminationDate)}</td>
                    <td className="num"><span className="ud-mono">{fmt(r.totalDeposit)}</span></td>
                    <td className="num">
                      <span className={'ud-mono' + (r.refundAmount < 0 ? ' text-red-600' : '')}>
                        {r.refundAmount < 0 ? `Khách nợ ${fmt(-r.refundAmount)}` : fmt(r.refundAmount)}
                      </span>
                    </td>
                    <td className="num">
                      {r.refundVoucherCode ? (
                        <span className={'ud-mono' + (r.refundVoucherStatus === 'POSTED' ? ' paid' : '')}>
                          {r.refundVoucherCode} · {fmt(r.refundVoucherAmount ?? 0)}
                          {r.refundVoucherStatus === 'PENDING' && <span className="ptt-badge-draft" style={{ marginLeft: 6 }}>CHỜ DUYỆT</span>}
                        </span>
                      ) : <span className="ud-mono">—</span>}
                    </td>
                    <td className="act">
                      <button type="button" className="ptt-comm-pay" onClick={() => setOpenTerm(r.terminationId)}>
                        <SearchCheck /> Kiểm tra
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="ptt-note mx" style={{ marginTop: 10 }}>
          <Wallet />
          <span>
            Nút <b>Kiểm tra</b> đối chiếu số hoàn trên hồ sơ với <b>cọc thật đã vào két</b> trước
            khi sinh phiếu. Phiếu hoàn luôn ra ở trạng thái <b>chờ duyệt</b> — tiền chỉ rời két khi
            có người duyệt. Số khớp thì ai cũng tạo được; lệch thì chỉ chủ tổ chức ép được kèm lý do.
          </span>
        </p>
      </div>

      <TerminationRefundDialog terminationId={openTerm} onOpenChange={(v) => !v && setOpenTerm(null)} />
    </div>
  );
}

// ── 2. THƯỞNG SALE ───────────────────────────────────────────────────────────

export function SaleBonusSection({ period }: { period: string }) {
  const q = useSaleBonusVouchers(period);
  const rows = q.data ?? [];
  const paid = rows.filter((r) => r.postingStatus === 'POSTED');
  const waiting = rows.filter((r) => r.approvalStatus !== 'APPROVED');

  return (
    <div className="ptt-scroll">
      <div className="ptt-comm-stats">
        <div className="ptt-comm-card"><div className="ptt-ov-lbl">Phiếu thưởng kỳ này</div><div className="ptt-comm-num">{rows.length}</div><div className="ptt-ov-sub">tổng {fmt(rows.reduce((s, r) => s + r.amount, 0))}</div></div>
        <div className="ptt-comm-card green"><div className="ptt-ov-lbl">Đã chi (vào sổ)</div><div className="ptt-comm-num green">{fmt(paid.reduce((s, r) => s + r.amount, 0))}</div><div className="ptt-ov-sub">{paid.length} phiếu</div></div>
        <div className="ptt-comm-card amber"><div className="ptt-ov-lbl">Chờ duyệt</div><div className="ptt-comm-num amber">{fmt(waiting.reduce((s, r) => s + r.amount, 0))}</div><div className="ptt-ov-sub">{waiting.length} phiếu — duyệt ở trang Thu chi</div></div>
        <div className="ptt-comm-card"><div className="ptt-ov-lbl">Từ phiếu cọc</div><div className="ptt-comm-num">{rows.filter((r) => r.fromDeposit).length}</div><div className="ptt-ov-sub">thưởng trước khi ký hợp đồng</div></div>
      </div>

      <div className="ud-body">
        {q.isLoading ? (
          <div className="ud-empty">⏳ Đang tải…</div>
        ) : rows.length === 0 ? (
          <div className="ud-empty">📄 Kỳ này chưa có phiếu thưởng Sale nào.</div>
        ) : (
          <div className="ud-tablewrap">
            <table className="ud-table">
              <thead><tr><th>Phiếu</th><th>Toà · Phòng</th><th>Hợp đồng</th><th>Ngày</th><th className="num">Số tiền</th><th className="ctr">Nguồn</th><th className="ctr">Trạng thái</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="ud-mono2">{r.code ?? '—'}</td>
                    <td>{r.buildingName}{r.roomName ? ` · ${r.roomName}` : ''}</td>
                    <td className="ud-mono2">{r.contractNumber ?? <span title="Chưa gắn hợp đồng — sẽ tự nối khi ký">chưa ký HĐ</span>}</td>
                    <td className="ud-mono2">{fmtDate(r.voucherDate)}</td>
                    <td className="num"><span className={'ud-mono' + (r.postingStatus === 'POSTED' ? ' paid' : '')}>{fmt(r.amount)}</span></td>
                    <td className="ctr">{r.fromDeposit ? <span className="ptt-tier">phiếu cọc</span> : <span className="ptt-tier">ký HĐ</span>}</td>
                    <td className="ctr">
                      {r.postingStatus === 'POSTED' ? <span className="ptt-comm-paid">Đã chi</span>
                        : r.approvalStatus === 'APPROVED' ? <span className="ptt-tier">Đã duyệt</span>
                        : <span className="ptt-badge-draft">CHỜ DUYỆT</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="ptt-note mx" style={{ marginTop: 10 }}>
          <HandCoins />
          <span>
            Phiếu thưởng được tạo ở <b>form tạo phiếu cọc</b> (mục "Thưởng nóng Sale") hoặc ở
            <b> màn ký hợp đồng</b>. Mỗi thương vụ chỉ thưởng một lần — đã thưởng từ phiếu cọc thì
            khi ký hợp đồng ô thưởng tự tô xám.
          </span>
        </p>
      </div>
    </div>
  );
}

// ── 3. CỌC ĐÃ THU ────────────────────────────────────────────────────────────

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
