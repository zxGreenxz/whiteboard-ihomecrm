// =============================================================================
// ContractLifecycleBand — dải "Vòng đời hợp đồng của phòng".
//
// Dùng CHUNG cho hồ sơ khoản chi và hồ sơ biến động. Tách ra vì hai màn phải
// hiện y hệt một dòng thời gian; để hai bản sao là mời lệch số.
//
// Bốn mốc, theo bản thiết kế 03:
//   Ký hợp đồng · Cọc đã đóng (THỰC THU) · Tiền thuê/phí đã đóng · Thanh lý
// =============================================================================

import { useContractLifecycle } from '@/hooks/useContractLifecycle';
import { fmtMoney, fmtNgay } from '@/lib/contractSettlement';

interface Props {
  contractId: string | null;
  /** Dòng nhấn thêm ở mốc thanh lý — hồ sơ khoản chi dùng để nói còn/đã hoàn. */
  ghiChuHoan?: { text: string; mau: string } | null;
  hint?: string;
}

export function ContractLifecycleBand({ contractId, ghiChuHoan, hint }: Props) {
  const q = useContractLifecycle(contractId);
  const v = q.data;
  const daThanhLy = !!v?.terminatedAt;

  const buoc: { h: string; val: string; m: string; m2?: string; m2c?: string }[] = v ? [
    {
      h: 'Ký hợp đồng', val: fmtNgay(v.signedDate),
      m: `Thời hạn: ${fmtNgay(v.startDate)} – ${fmtNgay(v.endDate)}`,
    },
    {
      h: 'Cọc đã đóng · thực thu', val: fmtMoney(v.depositPaid),
      // ⚠ `deposit_paid`, KHÔNG phải `total_deposit`. Đo thật 21/09/2026 có hợp
      // đồng cam kết 4.000.000 mà thực thu 0 — hiện số cam kết là nói dối.
      m: v.depositPaid === v.depositTotal
        ? 'Đã nộp đủ theo hợp đồng'
        : `Cam kết ${fmtMoney(v.depositTotal)} · còn thiếu ${fmtMoney(v.depositTotal - v.depositPaid)}`,
      m2c: v.depositPaid < v.depositTotal ? 'var(--c-partial)' : undefined,
    },
    {
      h: 'Tiền thuê / phí đã đóng', val: fmtMoney(v.invoicePaid),
      m: `Không gồm cọc · giá thuê ${fmtMoney(v.rentPrice)}/tháng`,
    },
    daThanhLy
      ? {
          h: `${v.terminationType === 'FORFEIT' ? 'Bỏ cọc' : 'Thanh lý'} · ${fmtNgay(v.terminatedAt)}`,
          val: `Quyết toán hoàn ${fmtMoney(v.refundAmount ?? 0)}`,
          m: `Nợ sau quyết toán: ${fmtMoney(v.outstandingDebt ?? 0)}`,
          m2: ghiChuHoan?.text, m2c: ghiChuHoan?.mau,
        }
      : {
          h: 'Đến hôm nay', val: 'Đang thuê', m: 'Chưa thanh lý',
          m2: `Còn nợ: ${fmtMoney(v.outstandingDebt ?? 0)}`,
          m2c: Number(v.outstandingDebt) > 0 ? 'var(--c-unpaid)' : 'var(--c-paid)',
        },
  ] : [];

  return (
    <div className="cs-life">
      <div className="cs-life-top">
        <b>Vòng đời hợp đồng của phòng</b>
        <span>
          {q.isLoading ? 'Đang tra hợp đồng…'
            : q.isError ? 'Không đọc được hợp đồng — số liệu bên dưới chưa đầy đủ.'
            : !contractId ? 'Chưa gắn hợp đồng nên không dựng được vòng đời.'
            : !v ? 'Không tìm thấy hợp đồng.'
            : hint ?? 'Số liệu đọc thẳng từ hợp đồng và hoá đơn'}
        </span>
      </div>
      {v && (
        <div className="cs-lane target">
          <div className="cs-lane-head">
            <span className="cs-role">Hợp đồng liên quan</span>
            <b>{v.contractNumber ?? '—'}</b>
            <span style={{ color: 'var(--ink-2)' }}>{v.customer}</span>
            <span className="cs-lane-gap" />
            <span className="cs-tag" style={{
              background: daThanhLy ? 'var(--line-2)' : 'var(--brand-50)',
              color: daThanhLy ? 'var(--ink-2)' : 'var(--brand)',
            }}>
              {daThanhLy ? 'Đã thanh lý' : 'Đang thuê'}
            </span>
          </div>
          <div className="cs-steps">
            {buoc.map((b) => (
              <div className="cs-step" key={b.h}>
                <div className="cs-step-h">{b.h}</div>
                <div className="cs-step-v">{b.val}</div>
                <div className="cs-step-m">{b.m}</div>
                {b.m2 && <div className="cs-step-m2" style={{ color: b.m2c }}>{b.m2}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
