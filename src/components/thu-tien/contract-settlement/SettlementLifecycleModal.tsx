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
import {
  validatePostFinanceExecutionInput,
  type PostFinanceExecutionInput,
} from '@/lib/incomeExpensePostingValidation';
import {
  useCustodianCashbooksV2, useAttachPostingEvidence, adoptVoucherAttachmentsAsEvidence,
} from '@/hooks/income-expenses/financeV2Mutations';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { useAuth } from '@/hooks/useAuth';
import { buildVietQRImageUrl, matchRecipientBankCode, RECIPIENT_BANKS } from '@/lib/vietqrDeeplink';
import { ChungTuThanhToan } from './ChungTuThanhToan';
import { useAccounts } from '@/hooks/useAccounts';
import { useIncomeExpenseSupplements } from '@/hooks/income-expenses/supplements';
import { formatSupplementAuthor } from '@/lib/incomeExpenseSupplement';
import { ContractLifecycleBand } from './ContractLifecycleBand';
import { SettlementVoucherDetails } from './SettlementVoucherDetails';
import { mocNgayNghiepVu, type LaneSubject } from '@/lib/contractLifecycle';
import { vnTodayISO } from '@/lib/vnDate';
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
  /**
   * Vai của lane đích lấy từ ĐÚNG loại phiếu. `row.kind` có thể là 'unknown'
   * (phiếu thủ công chưa nhận được loại) — khi đó lane mang nhãn trung tính,
   * KHÔNG được mặc định thành "Hợp đồng của phiếu hoàn".
   */
  const vaiLane: LaneSubject = { kind: 'voucher', voucherKind: row.kind };
  /**
   * Mốc ngày NGHIỆP VỤ của hồ sơ: ngày phiếu. Bản lùi dùng `vnTodayISO`, KHÔNG
   * dùng `new Date().toISOString()` — bản UTC trả HÔM QUA trong khoảng
   * 00:00–07:00 giờ Việt Nam.
   */
  const businessDate = mocNgayNghiepVu(row.eventDate, vnTodayISO());
  const [lyDo, setLyDo] = useState('');
  const [chuoiTuChoi, setChuoiTuChoi] = useState(false);
  const [daDoiChieu, setDaDoiChieu] = useState(false);
  const [nguoiNhan, setNguoiNhan] = useState(row.recipientName ?? '');
  const [nganHang, setNganHang] = useState('');
  const [soTk, setSoTk] = useState(row.bankAccount ?? '');
  /** null = chưa mở form chi. Khác null = đang chi, và nhớ sẽ gọi hàm nào. */
  const [dangChi, setDangChi] =
    useState<'APPROVE_AND_POST' | 'POST_APPROVED' | null>(null);
  const [soQuy, setSoQuy] = useState('');
  const [ngayChi, setNgayChi] = useState(() => new Date().toISOString().slice(0, 10));
  const [chungTu, setChungTu] = useState<{ ids: string[]; ten: string } | null>(null);
  const [dangTaiAnh, setDangTaiAnh] = useState(false);
  const [khoaGhiChu] = useState(khoaMoi);
  /** Sinh MỘT LẦN mỗi lần mở form chi — thử lại không ghi sổ hai lần. */
  const [khoaGhiSo, setKhoaGhiSo] = useState(khoaMoi);

  const { data: authUser } = useAuth();
  const dinhChungTu = useAttachPostingEvidence();
  const supplements = useIncomeExpenseSupplements(row.voucherId, true);
  const { data: soCustodian = [] } = useCustodianCashbooksV2(!!dangChi);
  const { data: moiSo = [] } = useAccounts({ enabled: !!dangChi });

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

  /**
   * Ảnh VietQR THẬT, quét được — không phải ô mô phỏng như bản demo thiết kế.
   * Hiện QR giả trên app thật là mời người ta quét nhầm, nên thiếu dữ kiện thì
   * nói thẳng là chưa dựng được QR.
   */
  const qr = useMemo(() => {
    const code = matchRecipientBankCode(row.bankName);
    const bin = RECIPIENT_BANKS.find((b) => b.code === code)?.bin;
    const stk = (row.bankAccount ?? '').trim();
    if (!bin || !stk) return null;
    return buildVietQRImageUrl({
      bin, accountNumber: stk, amount: row.amount,
      note: row.voucherCode ?? undefined, accountName: row.recipientName ?? undefined,
    });
  }, [row.bankName, row.bankAccount, row.amount, row.voucherCode, row.recipientName]);

  const moFormChi = (mode: 'APPROVE_AND_POST' | 'POST_APPROVED') => {
    setDangChi(mode);
    setKhoaGhiSo(khoaMoi());
    setChungTu(null);
    setSoQuy('');
  };

  /** Tải ảnh lên rồi biến nó thành chứng từ đã finalize — ĐÚNG đường Thu chi. */
  const themAnh = async (file: File) => {
    setDangTaiAnh(true);
    try {
      const kq = await dinhChungTu(file, {
        voucherId: row.voucherId,
        userId: authUser?.id ?? '',
        organizationId: row.organizationId,
      });
      // Hook đã toast lý do khi trả null — đừng toast đè lên nó.
      if (kq) setChungTu({ ids: kq.evidenceIds, ten: file.name });
    } finally {
      setDangTaiAnh(false);
    }
  };

  /** Nhận ảnh đã đính sẵn trên phiếu làm chứng từ, khỏi bắt tải lại. */
  const dungAnhCoSan = async () => {
    setDangTaiAnh(true);
    try {
      const kq = await adoptVoucherAttachmentsAsEvidence(row.voucherId);
      if (kq.evidenceIds.length === 0) {
        toast.error('Không dùng được ảnh có sẵn làm chứng từ. Tải ảnh mới lên.');
        return;
      }
      setChungTu({ ids: kq.evidenceIds, ten: `${kq.evidenceIds.length} ảnh có sẵn trên phiếu` });
    } finally {
      setDangTaiAnh(false);
    }
  };

  /**
   * Dựng input y hệt hộp thoại Thu chi. Một chỗ duy nhất tạo ra nó, để form và
   * nút "Xác nhận" không thể lệch nhau về luật.
   */
  const duLieuGhiChi = (): PostFinanceExecutionInput => ({
    subjectKind: 'VOUCHER',
    subjectId: row.voucherId,
    cashbookId: soQuy,
    postedOn: ngayChi,
    evidenceIds: chungTu?.ids ?? [],
    /* Thu chi truyền 0 và KHÔNG có cột DB nào tương ứng — giữ y hệt, không
       bịa ra trường để đọc. */
    expectedExecutionRevision: 0,
    expectedApprovalVersion: row.approvalVersion,
    expectedPostingVersion: row.postingVersion,
    idempotencyKey: khoaGhiSo,
  });

  /**
   * Luật hợp lệ lấy NGUYÊN của Thu chi (`validatePostFinanceExecutionInput`),
   * không tự viết lại — viết lại là mời hai bề mặt lệch luật nhau.
   */
  const kiemTra = validatePostFinanceExecutionInput(duLieuGhiChi());
  const loiDauTien = Object.values(kiemTra.errors)[0] ?? null;

  const ghiChi = () => chay(async () => {
    if (!dangChi || !kiemTra.ok) return;
    const input = duLieuGhiChi();
    if (dangChi === 'APPROVE_AND_POST') await actions.approveAndPost(input);
    else await actions.post(input);
    setDangChi(null);
    onClose();
  });

  const st = STATUS_STYLE[view];
  const chay = async (fn: () => Promise<void>) => {
    try { await fn(); } catch { /* hook đã toast */ }
  };

  // ── Vướng mắc còn chặn, sau khi trừ những thứ nút bên dưới gỡ được ────────
  const blocker = row.issues.filter(isBlocker);
  const doiNguoiNhan =
    nguoiNhan.trim() !== (row.recipientName ?? '').trim()
    || soTk.trim() !== (row.bankAccount ?? '').trim()
    || nganHang.trim() !== '';
  /** Blocker mà màn này KHÔNG gỡ được — phải sửa phiếu bên Thu chi. */
  const blockerNgoaiTam = blocker.filter(
    (i) => i !== 'MISSING_PAYMENT_INFO' && i !== 'SUPPLEMENT_PENDING',
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

        {/* ⚠ `ghiChuHoan` CHỈ dành cho phiếu hoàn. Bản cũ gắn nó cho mọi loại
            nên phiếu hoa hồng cũng hiện "Còn hoàn: <số hoa hồng>" — lấy số hoa
            hồng dán nhãn hoàn, đúng thứ plan §3.2 cấm. Dải tự bỏ qua nếu loại
            không phải hoàn, nhưng không truyền vẫn là rõ ràng hơn. */}
        <ContractLifecycleBand
          organizationId={row.organizationId}
          roomId={row.roomId}
          contractId={row.contractId}
          subject={vaiLane}
          businessDate={businessDate}
          sourceLabel="Phiếu đang xem"
          sourceText={`${row.voucherCode ?? 'Chưa có mã'} · ${KIND_LABEL[row.kind]}`}
          ghiChuHoan={row.kind === 'refund' ? {
            text: view === 'paid' ? `Đã hoàn: ${fmtMoney(row.amount)}` : `Còn hoàn: ${fmtMoney(row.amount)}`,
            mau: view === 'paid' ? 'var(--c-paid)' : 'var(--c-partial)',
          } : null}
        />

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
                    const chan = isBlocker(i);
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

            {/* Bảng quyết toán/căn cứ theo LOẠI phiếu + ghi chú gốc — lấy đúng
                nguồn Thu chi. Đặt TRƯỚC "Lịch sử bổ sung" theo plan §3.2, và
                mục bổ sung ở dưới vẫn là nơi DUY NHẤT dựng lịch sử bổ sung. */}
            <SettlementVoucherDetails row={row} />

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
              <h4>Chứng từ thanh toán</h4>
              {!dangChi && view === 'paid' && (
                <div className="cs-proof" style={{ marginBottom: 8 }}>
                  <div>{row.bookName ?? 'Sổ không rõ'}</div>
                  <div className="val">{fmtMoney(row.amount)}</div>
                  <div>Chi ngày {fmtNgay(row.paidDate)}</div>
                </div>
              )}
              <ChungTuThanhToan attachments={row.attachments} />
              {row.hasAttachment && view !== 'paid' && (
                <div className="cs-note-s" style={{ marginTop: 6, color: 'var(--brand)' }}>
                  Đã có ảnh nên phiếu không còn vướng thông tin thanh toán.
                </div>
              )}
            </div>

            {/* ── Nút ──────────────────────────────────────────────────── */}
            <div className="cs-acts">
              {/* ── Form ghi chi, DỰNG NGAY TẠI ĐÂY theo bản thiết kế 03 ────
                  Không mở hộp thoại của Thu chi nữa. Hàm gọi xuống và hình dạng
                  `PostFinanceExecutionInput` giữ NGUYÊN — chỉ đổi giao diện. */}
              {dangChi && (
                <>
                  <div className="cs-form-t">
                    {dangChi === 'APPROVE_AND_POST' ? 'Duyệt và ghi chi' : 'Ghi nhận chi'}
                  </div>

                  <label className="cs-lb">
                    Sổ chi
                    <select className="cs-in" value={soQuy} onChange={(e) => setSoQuy(e.target.value)}>
                      <option value="">— Chọn sổ quỹ —</option>
                      {soDungOrg.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </label>
                  {soDungOrg.length === 0 && (
                    <div className="cs-note-s" style={{ color: 'var(--c-unpaid)' }}>
                      Bạn không giữ sổ quỹ nào của tổ chức này nên không ghi chi được.
                    </div>
                  )}

                  <label className="cs-lb">
                    Ngày chi
                    <input type="date" className="cs-in mono" value={ngayChi}
                      onChange={(e) => setNgayChi(e.target.value)} />
                  </label>

                  {qr ? (
                    <div className="cs-qr">
                      <img src={qr} alt={`VietQR chuyển khoản cho ${row.recipientName ?? 'người nhận'}`} />
                      <div className="cs-note-s">
                        QR chuyển khoản · {row.recipientName ?? '—'} · {row.bankName}
                      </div>
                    </div>
                  ) : (
                    <div className="cs-note-s">
                      Chưa dựng được QR: cần cả tên ngân hàng nhận dạng được và số tài khoản.
                    </div>
                  )}

                  <div>
                    <div className="cs-lb-t">Ảnh chuyển khoản</div>
                    {chungTu ? (
                      <div className="cs-anh-ok">
                        <span className="cs-anh-oknho" />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span className="cs-anh-okten">{chungTu.ten}</span>
                          <span className="cs-anh-oksub">Đã đính kèm chứng từ chuyển khoản</span>
                        </span>
                        <button type="button" className="cs-anh-okx" aria-label="Bỏ chứng từ"
                          onClick={() => setChungTu(null)}>×</button>
                      </div>
                    ) : (
                      <div className="cs-tai">
                        <div className="cs-note-s">Tải ảnh hoặc dùng ảnh đã đính trên phiếu</div>
                        <div className="pair">
                          <label className={`cs-btn primary sm ${dangTaiAnh ? 'mo' : ''}`}
                            style={{ textAlign: 'center', cursor: dangTaiAnh ? 'wait' : 'pointer' }}>
                            {dangTaiAnh ? 'Đang tải…' : 'Tải ảnh lên'}
                            <input type="file" accept="image/*" style={{ display: 'none' }}
                              disabled={dangTaiAnh}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                // Xoá giá trị để chọn lại CÙNG một file vẫn kích hoạt onChange.
                                e.target.value = '';
                                if (f) void themAnh(f);
                              }} />
                          </label>
                          <button type="button" className="cs-btn sm"
                            disabled={dangTaiAnh || !row.hasAttachment}
                            title={row.hasAttachment ? undefined : 'Phiếu chưa có ảnh nào'}
                            onClick={() => void dungAnhCoSan()}>
                            Dùng ảnh có sẵn
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <button type="button" className="cs-btn primary"
                    disabled={actions.isBusy || dangTaiAnh || !kiemTra.ok}
                    onClick={ghiChi}>
                    Xác nhận đã chi đủ {fmtMoney(row.amount)}
                  </button>
                  {loiDauTien && <div className="cs-note-s">{loiDauTien}</div>}
                  <button type="button" className="cs-btn sm" onClick={() => setDangChi(null)}>
                    Chưa chi, quay lại
                  </button>
                </>
              )}

              {!dangChi && view === 'review' && (
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

              {!dangChi && view === 'pending' && (
                <>
                  {kha.approveAndPost && (
                    <button type="button" className="cs-btn primary" disabled={actions.isBusy}
                      onClick={() => moFormChi('APPROVE_AND_POST')}>
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

              {!dangChi && view === 'approved' && (
                <>
                  {kha.post ? (
                    <button type="button" className="cs-btn primary" disabled={actions.isBusy}
                      onClick={() => moFormChi('POST_APPROVED')}>
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

              {!dangChi && view === 'paid' && (
                <div className="cs-donebox">
                  Đã chi đủ ngày {fmtNgay(row.paidDate)}. Không có nút chi lại.
                </div>
              )}
              {!dangChi && view === 'noncash' && (
                <div className="cs-cancelbox">
                  <b>Đã duyệt nhưng không ghi quỹ.</b> Phiếu ghi trên sổ ảo, tiền chưa rời két —
                  đừng đọc thành đã trả cho khách.
                </div>
              )}
              {!dangChi && view === 'cancelled' && (
                <div className="cs-cancelbox"><b>Đã từ chối.</b> Phiếu không còn trong danh sách cần xử lý.</div>
              )}

              {!dangChi && view !== 'paid' && view !== 'cancelled' && (
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

    </div>,
    document.body,
  );
}
