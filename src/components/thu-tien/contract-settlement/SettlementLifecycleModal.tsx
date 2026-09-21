// =============================================================================
// SettlementLifecycleModal — hồ sơ một khoản chi, theo bản thiết kế 03.
//
// Ba phần: đầu phiếu · DÒNG THỜI GIAN VÒNG ĐỜI HỢP ĐỒNG · hai cột nội dung.
//
// ⚠ MỌI NÚT TIỀN TÁC ĐỘNG ĐÚNG `voucherId` ĐANG MỞ. Không bao giờ chuyển sang
// phiếu khác chỉ vì cùng phòng hay cùng hợp đồng.
//
// Modal này ĐỌC và PHÁT LỆNH, không tự chọn writer — mọi lệnh đi qua
// `useSettlementActions`, và hộp thoại ghi sổ dùng nguyên
// `IncomeExpensePostingDialog` của Thu chi, KHÔNG sửa dialog đó.
//
// ── "Xác nhận & Chuyển Chờ Duyệt" làm gì ───────────────────────────────────
// KHÔNG lập phiếu — phiếu đã có sẵn từ Thu chi rồi. Nút này chỉ gỡ các vướng
// mắc mà màn này gỡ được (điền tên/ngân hàng/số tài khoản, đóng yêu cầu bổ
// sung). Gỡ hết blocker thì dòng TỰ chuyển sang làn Chờ duyệt, vì làn được suy
// ra chứ không lưu ở đâu. Lệch căn cứ thì phải sửa phiếu bên Thu chi.
// =============================================================================

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import IncomeExpensePostingDialog from '@/components/income-expenses/IncomeExpensePostingDialog';
import type { PostFinanceExecutionInput } from '@/lib/incomeExpensePostingValidation';
import { useCustodianCashbooksV2 } from '@/hooks/income-expenses/financeV2Mutations';
import { useAccounts } from '@/hooks/useAccounts';
import { useIncomeExpenseSupplements } from '@/hooks/income-expenses/supplements';
import { formatSupplementAuthor } from '@/lib/incomeExpenseSupplement';
import { useContractLifecycle } from '@/hooks/useContractLifecycle';
import {
  KIND_LABEL, STATUS_STYLE, fmtMoney, fmtNgay, isBlocker,
  type SettlementRow, type ViewStatus,
} from '@/lib/contractSettlement';
import type { useSettlementActions } from '@/hooks/useSettlementActions';
import { NHAN_VUONG_MAC, moTaCanCu } from './nhan';

type Actions = ReturnType<typeof useSettlementActions>;

interface Props {
  row: SettlementRow;
  view: ViewStatus;
  actions: Actions;
  onClose: () => void;
}

/** Khoá idempotency ổn định trong MỘT lần mở hộp thoại. */
const khoaMoi = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `cs-${Math.random().toString(36).slice(2)}`;

export function SettlementLifecycleModal({ row, view, actions, onClose }: Props) {
  const kha = actions.availabilityOf(row);
  const [lyDo, setLyDo] = useState('');
  const [chuoiTuChoi, setChuoiTuChoi] = useState(false);
  const [daDoiChieu, setDaDoiChieu] = useState(false);
  const [nguoiNhan, setNguoiNhan] = useState(row.recipientName ?? '');
  const [nganHang, setNganHang] = useState('');
  const [soTk, setSoTk] = useState(row.bankAccount ?? '');
  const [postingMode, setPostingMode] =
    useState<'APPROVE_AND_POST' | 'POST_APPROVED' | null>(null);
  const [khoaGhiChu] = useState(khoaMoi);

  const supplements = useIncomeExpenseSupplements(row.voucherId, true);
  const vongDoi = useContractLifecycle(row.contractId);
  const { data: soCustodian = [] } = useCustodianCashbooksV2(!!postingMode);
  const { data: moiSo = [] } = useAccounts({ enabled: !!postingMode });

  /**
   * ⚠ `list_cashbooks_for_expense_v2()` KHÔNG nhận tham số tổ chức — nó trả mọi
   * sổ CUSTODIAN qua mọi membership đang hoạt động, và chỉ có id + name. Người
   * nhiều tổ chức sẽ thấy sổ của org khác, bấm vào thì writer từ chối. Giao với
   * `useAccounts` (có organization_id + is_virtual) để lọc theo org CỦA PHIẾU.
   */
  const soDungOrg = useMemo(() => {
    const hopLe = new Set(
      (moiSo as { id: string; organization_id?: string; is_virtual?: boolean }[])
        .filter((a) => a.organization_id === row.organizationId && !a.is_virtual)
        .map((a) => a.id),
    );
    return soCustodian.filter((b) => hopLe.has(b.id));
  }, [moiSo, soCustodian, row.organizationId]);

  const st = STATUS_STYLE[view];
  const chay = async (fn: () => Promise<void>) => {
    try { await fn(); } catch { /* hook đã toast */ }
  };

  // ── Vướng mắc còn chặn, sau khi trừ những thứ nút bên dưới gỡ được ────────
  const blocker = row.issues.filter((i) => isBlocker(i, row));
  const doiNguoiNhan =
    nguoiNhan.trim() !== (row.recipientName ?? '').trim()
    || soTk.trim() !== (row.bankAccount ?? '').trim()
    || nganHang.trim() !== '';
  /** Blocker mà màn này KHÔNG gỡ được — phải sửa phiếu bên Thu chi. */
  const blockerNgoaiTam = blocker.filter(
    (i) => i !== 'MISSING_RECIPIENT' && i !== 'MISSING_BANK' && i !== 'SUPPLEMENT_PENDING',
  );

  const xacNhanChuyenLan = () => chay(async () => {
    if (doiNguoiNhan) {
      await actions.editRecipient({
        voucherId: row.voucherId,
        payerName: nguoiNhan.trim() || null,
        ...(nganHang.trim() ? { bankName: nganHang.trim() } : {}),
        bankAccount: soTk.trim() || null,
      });
    }
    if (row.supplementPending && kha.markSupplementDone) {
      await actions.markSupplementDone({
        voucherId: row.voucherId,
        noiDung: lyDo.trim() || 'Đã đối chiếu, đủ dữ kiện',
        idempotencyKey: khoaGhiChu,
      });
      await supplements.refetch();
    }
    toast.success(
      blockerNgoaiTam.length
        ? 'Đã lưu. Phiếu vẫn ở Cần rà soát vì còn vướng ngoài tầm màn này.'
        : 'Đã xác nhận. Phiếu chuyển sang Chờ duyệt.',
    );
    setLyDo('');
  });

  const ghiChuBoSung = (xong: boolean) => chay(async () => {
    const f = xong ? actions.markSupplementDone : actions.requestSupplement;
    await f({ voucherId: row.voucherId, noiDung: lyDo, idempotencyKey: khoaGhiChu });
    setLyDo('');
    await supplements.refetch();
  });

  // ── Dòng thời gian ────────────────────────────────────────────────────────
  const v = vongDoi.data;
  const daThanhLy = !!v?.terminatedAt;
  const buoc: { h: string; val: string; m: string; m2?: string; m2c?: string }[] = v ? [
    {
      h: 'Ký hợp đồng', val: fmtNgay(v.signedDate),
      m: `Thời hạn: ${fmtNgay(v.startDate)} – ${fmtNgay(v.endDate)}`,
    },
    {
      h: 'Cọc đã đóng · thực thu', val: fmtMoney(v.depositPaid),
      // Hiện cả số cam kết khi hai số lệch — "đã ký nhưng chưa nộp đủ cọc" là
      // thông tin phải thấy trước khi duyệt chi.
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
          m2: view === 'paid' ? `Đã hoàn: ${fmtMoney(row.amount)}` : `Còn hoàn: ${fmtMoney(row.amount)}`,
          m2c: view === 'paid' ? 'var(--c-paid)' : 'var(--c-partial)',
        }
      : {
          h: 'Đến hôm nay', val: 'Đang thuê', m: 'Chưa thanh lý',
          m2: `Còn nợ: ${fmtMoney(v.outstandingDebt ?? 0)}`,
          m2c: 'var(--c-paid)',
        },
  ] : [];

  // ⚠ PHẢI dựng qua portal ra document.body.
  //
  // `.tt-stage` của trang Thanh toán là `position: fixed; z-index: 0` — tức một
  // STACKING CONTEXT. Modal nằm trong đó thì z-index bao nhiêu cũng chỉ có tác
  // dụng BÊN TRONG context ấy. Đã dính thật khi thử tay: nút trong modal bị
  // `.ptt-m-ovrow` của khung điện thoại chắn pointer event. Đừng chữa bằng cách
  // nâng z-index — nâng bao nhiêu cũng vô ích.
  return createPortal(
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>

        {/* ── Đầu phiếu ──────────────────────────────────────────────────── */}
        <div className="cs-m-head">
          <div style={{ minWidth: 0 }}>
            <div className="cs-m-code">
              {row.voucherCode ?? 'Chưa có mã'} · {row.contractNumber ?? 'Chưa gắn hợp đồng'}
            </div>
            <h2 className="cs-m-title">
              {KIND_LABEL[row.kind]} <span className="sl">/</span>{' '}
              <span className="mono">{row.buildingName} · {row.roomName ?? '—'}</span>
            </h2>
            <div className="cs-m-meta">
              <span className="cs-tag" style={{ background: st.bg, color: st.fg }}>{st.nhan}</span>
              <span>Khách: <b>{row.customerName}</b></span>
              <span>Người nhận: <b>{row.recipientName ?? '—'}</b></span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexShrink: 0 }}>
            <div className="cs-m-amt">
              <div className="cap">Số tiền trên phiếu</div>
              <div className="val">{fmtMoney(row.amount)}</div>
            </div>
            <button type="button" className="cs-x" onClick={onClose} aria-label="Đóng">×</button>
          </div>
        </div>

        {/* ── Vòng đời hợp đồng ──────────────────────────────────────────── */}
        <div className="cs-life">
          <div className="cs-life-top">
            <b>Vòng đời hợp đồng của phòng</b>
            <span>
              {vongDoi.isLoading ? 'Đang tra hợp đồng…'
                : vongDoi.isError ? 'Không đọc được hợp đồng — số liệu bên dưới chưa đầy đủ.'
                : !row.contractId ? 'Phiếu chưa gắn hợp đồng nên không dựng được vòng đời.'
                : 'Số liệu đọc thẳng từ hợp đồng và hoá đơn'}
            </span>
          </div>
          {v && (
            <div className="cs-lane target">
              <div className="cs-lane-head">
                <span className="cs-role">Hợp đồng của phiếu</span>
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

        {/* ── Hai cột ────────────────────────────────────────────────────── */}
        <div className="cs-body">
          <div className="cs-notes">
            <h3>Đối chiếu căn cứ</h3>
            <div className="cs-headlines">
              <div><span>Biến động</span> <b>{row.eventLabel}</b></div>
              <div><span>Ngày phiếu</span> <b>{fmtNgay(row.eventDate)}</b></div>
              <div><span>Nguồn</span> <b>{row.origin === 'reservation' ? 'Giữ chỗ' : 'Hợp đồng'}</b></div>
            </div>

            <div className="cs-sheet">
              <div className="cs-sheet-t">Số trên phiếu so với căn cứ</div>
              <div className="cs-kv"><span className="k">Số trên phiếu</span><span className="v">{fmtMoney(row.amount)}</span></div>
              <div className="cs-kv"><span className="k">Số theo căn cứ</span><span className="v">{moTaCanCu(row.basis)}</span></div>
              {row.basis.kind === 'mismatch' && (
                <div className="cs-kv strong top">
                  <span className="k">Chênh lệch</span>
                  <span className="v" style={{ color: 'var(--c-unpaid)' }}>
                    {fmtMoney(Math.abs(row.amount - row.basis.amount))}
                  </span>
                </div>
              )}
              <div className="cs-total">
                <span>
                  <b>{view === 'paid' ? 'Đã chi' : 'Còn phải chi'}</b>
                  <span className="sub">
                    {view === 'paid'
                      ? `${fmtNgay(row.paidDate)} · ${row.bookName ?? 'sổ không rõ'}`
                      : 'Chưa ghi sổ'}
                  </span>
                </span>
                <b className="val">{fmtMoney(row.amount)}</b>
              </div>
            </div>

            {row.basis.kind === 'mismatch' && (
              <div className="cs-warnbox" style={{ marginTop: 12 }}>
                Căn cứ hoa hồng đọc theo <b>bậc hiện hành</b>, không phải bậc tại ngày ký — đối
                chiếu lại với sale trước khi duyệt. Muốn sửa số tiền thì phải sửa phiếu bên Thu chi.
              </div>
            )}

            {row.issues.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>Vướng mắc</h3>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {row.issues.map((i) => {
                    const chan = isBlocker(i, row);
                    return (
                      <span key={i} className="cs-tag" style={{
                        background: chan ? 'var(--c-unpaid-bg)' : 'var(--line-2)',
                        color: chan ? 'var(--c-unpaid)' : 'var(--ink-2)',
                      }}>
                        {NHAN_VUONG_MAC.vuong[i].nhan}{chan ? '' : ' · cảnh báo'}
                      </span>
                    );
                  })}
                </div>
                <div className="cs-note-s" style={{ marginTop: 8 }}>
                  Chỉ thẻ đỏ mới giữ phiếu ở làn Cần rà soát. Thẻ xám là ghi chú, không chặn duyệt.
                </div>
              </>
            )}

            <h3 style={{ marginTop: 16 }}>Lịch sử bổ sung</h3>
            {supplements.isLoading ? (
              <div className="cs-note-s">Đang tải…</div>
            ) : supplements.isError ? (
              <div className="cs-note-s" style={{ color: 'var(--c-unpaid)' }}>
                Không đọc được ghi chú bổ sung. Chưa kết luận được là phiếu không có yêu cầu nào.
              </div>
            ) : (supplements.data ?? []).length === 0 ? (
              <div className="cs-note-s">Chưa có ghi chú bổ sung nào.</div>
            ) : (
              (supplements.data ?? []).map((s) => (
                <div key={s.id} className="cs-log">
                  <div style={{ whiteSpace: 'pre-line' }}>{s.note}</div>
                  <span>{formatSupplementAuthor(s)}</span>
                </div>
              ))
            )}
          </div>

          {/* ── Cột phải ─────────────────────────────────────────────────── */}
          <div className="cs-side">
            <div>
              <h4>Người nhận tiền</h4>
              {kha.editRecipient ? (
                <div style={{ display: 'grid', gap: 7 }}>
                  <input className="cs-in" value={nguoiNhan} placeholder="Tên người nhận"
                    onChange={(e) => setNguoiNhan(e.target.value)} />
                  <input className="cs-in" value={nganHang} placeholder="Ngân hàng — để trống là giữ nguyên"
                    onChange={(e) => setNganHang(e.target.value)} />
                  <input className="cs-in mono" value={soTk} placeholder="Số tài khoản"
                    onChange={(e) => setSoTk(e.target.value)} />
                  <div className="cs-note-s">
                    Hai người cùng sửa sẽ ghi đè nhau — đường ghi này chưa có khoá phiên bản.
                  </div>
                </div>
              ) : (
                <>
                  <div className="cs-side-kv"><span className="k">Tên</span><span>{row.recipientName ?? '—'}</span></div>
                  <div className="cs-side-kv"><span className="k">Ngân hàng</span><span>{row.bankName || '—'}</span></div>
                  <div className="cs-side-kv">
                    <span className="k">Số tài khoản</span>
                    <span style={{ fontFamily: 'var(--mono)' }}>{row.bankAccount || '—'}</span>
                  </div>
                  <div className="cs-note-s" style={{ marginTop: 6 }}>
                    {row.status === 'pending'
                      ? 'Cần quyền sửa phiếu thu chi để đổi thông tin này.'
                      : 'Phiếu đã duyệt — không sửa được trục tiền.'}
                  </div>
                </>
              )}
            </div>

            <div>
              <h4>Chứng từ</h4>
              {view === 'paid' ? (
                <div className="cs-proof">
                  <div>{row.bookName ?? 'Sổ không rõ'}</div>
                  <div className="val">{fmtMoney(row.amount)}</div>
                  <div>Chi ngày {fmtNgay(row.paidDate)}</div>
                </div>
              ) : (
                <div className="cs-note-s">
                  Chưa có chứng từ chi. Bổ sung khi ghi nhận đã trả tiền.
                </div>
              )}
            </div>

            {/* ── Nút ──────────────────────────────────────────────────── */}
            <div className="cs-acts">
              {view === 'review' && (
                <>
                  {blockerNgoaiTam.length > 0 && (
                    <div className="cs-warnbox">
                      Còn vướng ngoài tầm màn này:{' '}
                      {blockerNgoaiTam.map((i) => NHAN_VUONG_MAC.vuong[i].nhan).join(' · ')}.
                      Phải sửa phiếu bên Thu chi thì dòng mới sang được Chờ duyệt.
                    </div>
                  )}
                  {row.supplementPending && (
                    <textarea className="cs-ta" rows={2} value={lyDo}
                      onChange={(e) => setLyDo(e.target.value)} placeholder="Đã bổ sung gì…" />
                  )}
                  <label className="cs-note-s" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={daDoiChieu} style={{ marginTop: 3, accentColor: 'var(--brand)' }}
                      onChange={() => setDaDoiChieu((c) => !c)} />
                    Tôi đã đối chiếu thông tin người nhận và căn cứ của khoản chi này.
                  </label>
                  <button type="button" className="cs-btn primary"
                    disabled={actions.isBusy || !daDoiChieu || (!doiNguoiNhan && !row.supplementPending)}
                    onClick={xacNhanChuyenLan}>
                    Xác nhận &amp; Chuyển Chờ Duyệt
                  </button>
                  <div className="cs-note-s">
                    Không lập phiếu mới — phiếu đã có sẵn bên Thu chi và vẫn là phiếu Chờ duyệt.
                    Nút này chỉ lưu thông tin còn thiếu; hết vướng thì dòng tự sang làn Chờ duyệt.
                  </div>
                </>
              )}

              {view === 'pending' && (
                <>
                  {kha.approveAndPost && (
                    <button type="button" className="cs-btn primary" disabled={actions.isBusy}
                      onClick={() => setPostingMode('APPROVE_AND_POST')}>
                      Duyệt &amp; Chi {fmtMoney(row.amount)}
                    </button>
                  )}
                  <div className="pair">
                    <button type="button" className="cs-btn sm"
                      disabled={actions.isBusy || !kha.requestSupplement || !lyDo.trim()}
                      onClick={() => ghiChuBoSung(false)}>
                      Cần bổ sung
                    </button>
                    {kha.approve && (
                      <button type="button" className="cs-btn ghost sm" disabled={actions.isBusy}
                        onClick={() => chay(async () => { await actions.approve(row); onClose(); })}>
                        Duyệt Chờ Chi
                      </button>
                    )}
                  </div>
                  {kha.requestSupplement && (
                    <textarea className="cs-ta" rows={2} value={lyDo}
                      onChange={(e) => setLyDo(e.target.value)} placeholder="Cần bổ sung gì…" />
                  )}
                  <div className="cs-note-s">
                    <b>Duyệt &amp; Chi</b>: duyệt rồi ghi sổ ngay. <b>Duyệt Chờ Chi</b>: chuyển Chờ
                    chi, số dư chưa đổi. <b>Cần bổ sung</b>: ghi chú rồi đưa phiếu về Cần rà soát —
                    với Thu chi phiếu vẫn nguyên trạng thái Chờ duyệt.
                  </div>
                </>
              )}

              {view === 'approved' && (
                <>
                  {kha.post ? (
                    <button type="button" className="cs-btn primary" disabled={actions.isBusy}
                      onClick={() => setPostingMode('POST_APPROVED')}>
                      Ghi nhận chi {fmtMoney(row.amount)}
                    </button>
                  ) : (
                    <div className="cs-note-s">Không đủ quyền ghi sổ cho tổ chức của phiếu này.</div>
                  )}
                  <div className="cs-note-s">
                    Đã duyệt. Chi một lần đủ số tiền phiếu, sau đó đính chứng từ.
                  </div>
                </>
              )}

              {view === 'paid' && (
                <div className="cs-donebox">
                  Đã chi đủ ngày {fmtNgay(row.paidDate)}. Không có nút chi lại.
                </div>
              )}
              {view === 'noncash' && (
                <div className="cs-cancelbox">
                  <b>Đã duyệt nhưng không ghi quỹ.</b> Phiếu ghi trên sổ ảo, tiền chưa rời két —
                  đừng đọc thành đã trả cho khách.
                </div>
              )}
              {view === 'cancelled' && (
                <div className="cs-cancelbox"><b>Đã từ chối.</b> Phiếu không còn trong danh sách cần xử lý.</div>
              )}

              {view !== 'paid' && view !== 'cancelled' && (
                !chuoiTuChoi ? (
                  <button type="button" className="cs-btn danger sm"
                    disabled={actions.isBusy || !kha.cancel}
                    title={kha.cancelReason ?? undefined}
                    onClick={() => setChuoiTuChoi(true)}>
                    Từ chối phiếu
                  </button>
                ) : (
                  <>
                    <textarea className="cs-ta" rows={2} value={lyDo}
                      onChange={(e) => setLyDo(e.target.value)}
                      placeholder="Lý do từ chối (tối thiểu 8 ký tự)…" />
                    <div className="pair">
                      <button type="button" className="cs-btn sm"
                        onClick={() => { setChuoiTuChoi(false); setLyDo(''); }}>
                        Quay lại
                      </button>
                      <button type="button" className="cs-btn danger sm"
                        disabled={actions.isBusy || lyDo.trim().length < 8}
                        onClick={() => chay(async () => {
                          await actions.cancel(row, lyDo.trim());
                          toast.success('Đã từ chối phiếu.');
                          onClose();
                        })}>
                        Xác nhận
                      </button>
                    </div>
                  </>
                )
              )}
              {kha.cancelReason && <div className="cs-note-s">Không huỷ được: {kha.cancelReason}</div>}
            </div>
          </div>
        </div>

        <div className="cs-m-foot">
          Chỉ duyệt và chi đúng phiếu đang mở. Hợp đồng trong dòng thời gian dùng để đối chiếu.
        </div>
      </div>

      {postingMode && (
        <IncomeExpensePostingDialog
          open
          onOpenChange={(o) => { if (!o) setPostingMode(null); }}
          mode={postingMode}
          voucher={{
            subjectKind: 'VOUCHER',
            subjectId: row.voucherId,
            type: 'EXPENSE',
            approvedTotal: row.amount,
            name: row.voucherCode ?? undefined,
            defaultCashbookId: null,
          }}
          capability={{ isCustodian: soDungOrg.length > 0, canApprove: kha.approve || kha.approveAndPost }}
          cashbookOptions={soDungOrg}
          /* Thu chi truyền 0 ở cả ba chỗ và KHÔNG có cột DB nào tương ứng —
             giữ y hệt, không bịa ra trường để đọc. */
          expectedExecutionRevision={0}
          expectedApprovalVersion={row.approvalVersion}
          expectedPostingVersion={row.postingVersion}
          isSubmitting={actions.isBusy}
          onSubmit={(input: PostFinanceExecutionInput) => chay(async () => {
            if (postingMode === 'APPROVE_AND_POST') await actions.approveAndPost(input);
            else await actions.post(input);
            setPostingMode(null);
            onClose();
          })}
        />
      )}
    </div>,
    document.body,
  );
}
