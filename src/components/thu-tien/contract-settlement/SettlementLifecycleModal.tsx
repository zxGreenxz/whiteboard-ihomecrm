// =============================================================================
// SettlementLifecycleModal — xem chi tiết một khoản chi và phát lệnh.
//
// ⚠ MỌI NÚT TIỀN TÁC ĐỘNG ĐÚNG `voucherId` ĐANG MỞ. Không bao giờ chuyển sang
// phiếu khác chỉ vì cùng phòng hay cùng hợp đồng.
//
// Modal này là bề mặt ĐỌC và PHÁT LỆNH. Nó không tự chọn writer — mọi lệnh đi
// qua `useSettlementActions`, và hộp thoại ghi sổ dùng nguyên
// `IncomeExpensePostingDialog` của Thu chi, không sửa dialog đó.
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
import { fmtFull } from '@/lib/collect';
import type { SettlementRow } from '@/lib/contractSettlement';
import type { useSettlementActions } from '@/hooks/useSettlementActions';
import { NHAN_TRANG_THAI, NHAN_VUONG_MAC, moTaCanCu } from './nhan';

type Actions = ReturnType<typeof useSettlementActions>;

interface Props {
  row: SettlementRow;
  actions: Actions;
  onClose: () => void;
}

/** Khoá idempotency ổn định trong MỘT lần mở hộp thoại. */
const khoaMoi = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `cs-${Math.random().toString(36).slice(2)}`;

export function SettlementLifecycleModal({ row, actions, onClose }: Props) {
  const kha = actions.availabilityOf(row);
  const [lyDo, setLyDo] = useState('');
  const [chuoiTuChoi, setChuoiTuChoi] = useState(false);
  const [nguoiNhan, setNguoiNhan] = useState(row.recipientName ?? '');
  const [nganHang, setNganHang] = useState('');
  const [soTk, setSoTk] = useState(row.bankAccount ?? '');
  const [postingMode, setPostingMode] =
    useState<'APPROVE_AND_POST' | 'POST_APPROVED' | null>(null);
  // Khoá sinh MỘT LẦN mỗi lần mở modal: thử lại cùng nội dung không ghi hai dòng.
  const [khoaGhiChu] = useState(khoaMoi);

  const supplements = useIncomeExpenseSupplements(row.voucherId, true);
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

  const tt = NHAN_TRANG_THAI[row.status];

  const chay = async (fn: () => Promise<void>) => {
    try { await fn(); } catch { /* hook đã toast */ }
  };

  const ghiChuBoSung = (xong: boolean) => chay(async () => {
    const f = xong ? actions.markSupplementDone : actions.requestSupplement;
    await f({ voucherId: row.voucherId, noiDung: lyDo, idempotencyKey: khoaGhiChu });
    setLyDo('');
    await supplements.refetch();
  });

  // ⚠ PHẢI dựng qua portal ra document.body.
  //
  // `.tt-stage` của trang Thanh toán là `position: fixed; z-index: 0` — tức một
  // STACKING CONTEXT. Modal nằm trong đó thì z-index bao nhiêu cũng chỉ có tác
  // dụng BÊN TRONG context ấy, không vượt nổi khung điện thoại `.tt-phone-col`
  // vốn mount song song trên desktop. Đã dính thật khi thử tay: bấm nút trong
  // modal bị `.ptt-m-ovrow` của khung điện thoại chắn pointer event.
  //
  // Cùng lớp lỗi với `.cm-stage` của nút Copilot — đừng chữa bằng cách nâng
  // z-index, nâng bao nhiêu cũng vô ích.
  return createPortal(
    <div className="cs-modal-scrim" onClick={onClose}>
      <div className="cs-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="cs-modal-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#8d8678' }}>
              {row.voucherCode ?? 'Chưa có mã'} · {row.contractNumber ?? 'Chưa gắn hợp đồng'}
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 19, fontWeight: 700 }}>
              {NHAN_VUONG_MAC.loai[row.kind]} / {row.buildingName} · {row.roomName ?? '—'}
            </h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 7 }}>
              <span className={`cs-tag ${tt.mau}`}>{tt.nhan}</span>
              <span style={{ fontSize: 12.5, color: '#514c42' }}>
                Người nhận: <b>{row.recipientName ?? '—'}</b>
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexShrink: 0 }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11.5, color: '#8d8678' }}>Số tiền trên phiếu</div>
              <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 22, fontWeight: 700, color: '#1f7a52' }}>
                {fmtFull(row.amount)}
              </div>
            </div>
            <button type="button" className="cs-btn" onClick={onClose} aria-label="Đóng">×</button>
          </div>
        </div>

        <div className="cs-modal-body">
          <div className="cs-modal-left">
            <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 700 }}>Đối chiếu căn cứ</h3>
            <div className="cs-kv"><span>Số trên phiếu</span><b>{fmtFull(row.amount)}</b></div>
            <div className="cs-kv"><span>Số theo căn cứ</span><b>{moTaCanCu(row.basis)}</b></div>
            {row.basis.kind === 'mismatch' && (
              <div className="cs-warn" style={{ marginTop: 10 }}>
                Số đề nghị lệch <b>{fmtFull(Math.abs(row.amount - row.basis.amount))}</b> so với
                căn cứ. Căn cứ hoa hồng đọc theo <b>bậc hiện hành</b>, không phải bậc tại ngày ký —
                đối chiếu lại với sale trước khi duyệt.
              </div>
            )}

            {row.issues.length > 0 && (
              <>
                <h3 style={{ margin: '14px 0 6px', fontSize: 14, fontWeight: 700 }}>Vướng mắc</h3>
                <div className="cs-tags">
                  {row.issues.map((i) => (
                    <span key={i} className={`cs-tag ${NHAN_VUONG_MAC.vuong[i].mau}`}>
                      {NHAN_VUONG_MAC.vuong[i].nhan}
                    </span>
                  ))}
                </div>
              </>
            )}

            <h3 style={{ margin: '14px 0 6px', fontSize: 14, fontWeight: 700 }}>Lịch sử bổ sung</h3>
            {supplements.isLoading ? (
              <div className="cs-note">Đang tải…</div>
            ) : supplements.isError ? (
              <div className="cs-note" style={{ color: '#d6453f' }}>
                Không đọc được ghi chú bổ sung. Chưa kết luận được là phiếu không có yêu cầu nào.
              </div>
            ) : (supplements.data ?? []).length === 0 ? (
              <div className="cs-note">Chưa có ghi chú bổ sung nào.</div>
            ) : (
              (supplements.data ?? []).map((s) => (
                <div key={s.id} style={{ padding: '6px 0', borderBottom: '1px solid #efece4', fontSize: 12 }}>
                  <div style={{ whiteSpace: 'pre-line' }}>{s.note}</div>
                  <div className="cs-sub">{formatSupplementAuthor(s)}</div>
                </div>
              ))
            )}
          </div>

          <div className="cs-modal-right">
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Người nhận tiền</div>
              {kha.editRecipient ? (
                <div style={{ display: 'grid', gap: 7 }}>
                  <label className="cs-field">Tên người nhận
                    <input className="cs-input" value={nguoiNhan}
                      onChange={(e) => setNguoiNhan(e.target.value)} />
                  </label>
                  <label className="cs-field">Ngân hàng
                    <input className="cs-input" value={nganHang} placeholder="Giữ nguyên nếu để trống"
                      onChange={(e) => setNganHang(e.target.value)} />
                  </label>
                  <label className="cs-field">Số tài khoản
                    <input className="cs-input" value={soTk} style={{ fontFamily: "'Space Mono', monospace" }}
                      onChange={(e) => setSoTk(e.target.value)} />
                  </label>
                  <button type="button" className="cs-btn" disabled={actions.isBusy}
                    onClick={() => chay(() => actions.editRecipient({
                      voucherId: row.voucherId,
                      payerName: nguoiNhan.trim() || null,
                      ...(nganHang.trim() ? { bankName: nganHang.trim() } : {}),
                      bankAccount: soTk.trim() || null,
                    }))}>
                    Lưu thông tin người nhận
                  </button>
                  <div className="cs-note">
                    Hai người cùng sửa sẽ ghi đè nhau — đường ghi này chưa có khoá phiên bản.
                  </div>
                </div>
              ) : (
                <>
                  <div className="cs-kv"><span>Tên</span><b>{row.recipientName ?? '—'}</b></div>
                  <div className="cs-kv"><span>Số tài khoản</span>
                    <b style={{ fontFamily: "'Space Mono', monospace" }}>{row.bankAccount || '—'}</b>
                  </div>
                  <div className="cs-note" style={{ marginTop: 6 }}>
                    {row.status === 'pending'
                      ? 'Cần quyền sửa phiếu thu chi để đổi thông tin này.'
                      : 'Phiếu đã duyệt — không sửa được trục tiền.'}
                  </div>
                </>
              )}
            </div>

            <div className="cs-actions">
              {kha.approve && (
                <button type="button" className="cs-btn primary" disabled={actions.isBusy}
                  onClick={() => chay(async () => { await actions.approve(row); onClose(); })}>
                  Duyệt
                </button>
              )}
              {kha.approveAndPost && (
                <button type="button" className="cs-btn" disabled={actions.isBusy}
                  onClick={() => setPostingMode('APPROVE_AND_POST')}>
                  Duyệt &amp; Chi {fmtFull(row.amount)}
                </button>
              )}
              {kha.post && (
                <button type="button" className="cs-btn primary" disabled={actions.isBusy}
                  onClick={() => setPostingMode('POST_APPROVED')}>
                  Chi {fmtFull(row.amount)}
                </button>
              )}

              {(kha.requestSupplement || kha.markSupplementDone) && (
                <>
                  <textarea className="cs-textarea" rows={2} value={lyDo}
                    onChange={(e) => setLyDo(e.target.value)}
                    placeholder={kha.markSupplementDone ? 'Đã bổ sung gì…' : 'Cần bổ sung gì…'} />
                  <button type="button" className="cs-btn" disabled={actions.isBusy || !lyDo.trim()}
                    onClick={() => ghiChuBoSung(kha.markSupplementDone)}>
                    {kha.markSupplementDone ? 'Đã bổ sung xong' : 'Yêu cầu bổ sung'}
                  </button>
                  <div className="cs-note">
                    Ghi chú lưu vĩnh viễn kèm tên người ghi và thời điểm, hiện cả ở chi tiết phiếu
                    bên Thu chi. Phiếu vẫn là phiếu Chờ duyệt — việc này chỉ đổi chỗ nó nằm trên
                    màn hình này. Ai đọc được phiếu đều ghi được ghi chú.
                  </div>
                </>
              )}

              {!chuoiTuChoi ? (
                <button type="button" className="cs-btn danger"
                  disabled={actions.isBusy || !kha.cancel}
                  title={kha.cancelReason ?? undefined}
                  onClick={() => setChuoiTuChoi(true)}>
                  Từ chối phiếu
                </button>
              ) : (
                <>
                  <textarea className="cs-textarea" rows={2} value={lyDo}
                    onChange={(e) => setLyDo(e.target.value)} placeholder="Lý do từ chối (tối thiểu 8 ký tự)…" />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
                    <button type="button" className="cs-btn" onClick={() => { setChuoiTuChoi(false); setLyDo(''); }}>
                      Quay lại
                    </button>
                    <button type="button" className="cs-btn danger"
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
              )}
              {kha.cancelReason && (
                <div className="cs-note">Không huỷ được: {kha.cancelReason}</div>
              )}
            </div>
          </div>
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
