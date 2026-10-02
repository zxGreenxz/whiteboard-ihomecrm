import { useOperationFormFeedback } from '@/hooks/useOperationFormFeedback';
import { QueryRegion, refetchStartedSources, type RegionQuery } from '@/components/errors/QueryRegion';
import { LoadingState, SkeletonBar } from '@/components/loading/LoadingState';
// =============================================
// HandoverSheet — full sheet "Bàn giao tiền mặt" trong khung điện thoại.
// Khuôn sheet/scrim + mount→rAF .show y hệt CollectionReport.
//
// 3 tab:
//  1. Bàn giao  — phiếu thu chưa bàn giao trong SỔ TIỀN MẶT RIÊNG của tôi (chủ
//     công ty cài ở màn "Sổ nhận tiền"; chưa cài thì báo rõ), tick chọn (mặc
//     định tick hết) → chọn người nhận → "Xác nhận giao".
//  2. Phiên chờ — phiên PENDING/đang chờ hủy mà tôi tham gia: người nhận
//     đếm tiền theo danh sách rồi "Xác nhận đã nhận" (chọn sổ nhận);
//     2 bên đều có "Yêu cầu hủy"; yêu cầu hủy cần BÊN KIA xác nhận.
//  3. Lịch sử   — phiên đã nhận / đã hủy gần đây.
// =============================================

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { useAccounts } from '@/hooks/useAccounts';
import { useAuth } from '@/hooks/useAuth';
import { useStaffUsers } from '@/hooks/useStaffUsers';
import {
  useCashHandoverList,
  useConfirmCancelHandover,
  useConfirmHandover,
  useCreateHandover,
  useRejectCancelHandover,
  useRequestCancelHandover,
  useUnhandedVouchers,
  type CashHandover,
} from '@/hooks/useCashHandovers';
import { useReceivingCashbooks } from '@/hooks/useReceivingCashbooks';
import { useOrganization } from '@/contexts/OrganizationContext';
import { fmtFull } from '@/lib/collect';
import {
  fmtDateTime,
  handoverStatusLabel,
  isOpenHandover,
  myRole,
  needsMyAction,
  netSelected,
} from '@/lib/handover';

interface Props {
  show: boolean;
  onClose: () => void;
}

type Tab = 'create' | 'open' | 'history';

const THIEU_SO_TIEN_MAT_RIENG = 'Bạn chưa có sổ tiền mặt riêng — nhờ chủ công ty cài ở Sổ nhận tiền.';

const fmtDate = (d?: string | null) =>
  d ? d.slice(0, 10).split('-').reverse().join('/') : '';

export function HandoverSheet({ show, onClose }: Props) {
  const { data: currentUser } = useAuth();
  const accountsQuery = useAccounts(); const {data:accounts=[]} = accountsQuery;
  const staffQuery = useStaffUsers(); const {data:staffUsers=[]} = staffQuery;
  const feedback = useOperationFormFeedback('xử lý phiên bàn giao');

  const [tab, setTab] = useState<Tab>('create');
  // Mặc định tick HẾT: lưu tập "bỏ tick" để khỏi đồng bộ khi list thay đổi.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [receiverId, setReceiverId] = useState('');
  const [note, setNote] = useState('');
  // Sổ nhận từng phiên (receiver chọn lúc xác nhận).
  const [toAccount, setToAccount] = useState<Record<string, string>>({});
  // Phiên đang mở ô nhập lý do hủy.
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  // Sổ NGUỒN muốn bàn giao ('' = sổ tiền mặt riêng). Cho phép chọn sổ khác
  // (vd sổ chuyển khoản tkHiep) — bàn giao net-sweep chạy cho mọi loại sổ.
  const [sourceAccountId, setSourceAccountId] = useState('');

  // Sổ tiền mặt riêng của TÔI — chủ công ty cài ở màn "Sổ nhận tiền" (máy chủ
  // trả qua get_receiving_cashbooks_v1), thay cho quy ước tên "…Thu" cũ.
  const { selectedOrganizationId } = useOrganization();
  const receiving = useReceivingCashbooks(selectedOrganizationId, null);
  const personalBook = receiving.data?.personalCashBook ?? null;
  const personalLoading = !!selectedOrganizationId && !receiving.data && !receiving.isError;
  const personalError = receiving.isError ? 'Chưa tải được cấu hình sổ nhận tiền. Tải lại để kiểm tra.' : null;

  const myId = currentUser?.id;
  const receivers = useMemo(
    () => staffUsers.filter((u) => u.id !== myId),
    [staffUsers, myId],
  );
  const myAccounts = useMemo(
    () => (accounts as any[]).filter((a) => a.user_id === myId),
    [accounts, myId],
  );
  // Sổ có thể bàn giao: sổ tiền mặt riêng + sổ thu tiền mặt ("…Thu") hoặc sổ
  // ngân hàng ("TK…" / có bank_name) do tôi sở hữu — bỏ sổ "…Thối"/audit khác.
  const sourceBooks = useMemo(() => {
    const owned = myAccounts
      .filter((a) => {
        const n = (a.name ?? '').trim();
        return n.endsWith('Thu') || /^tk/i.test(n) || !!a.bank_name;
      })
      .map((a) => ({ id: String(a.id), name: String(a.name ?? '') }));
    return personalBook
      ? [{ id: personalBook.id, name: personalBook.name }, ...owned.filter((a) => a.id !== personalBook.id)]
      : owned;
  }, [myAccounts, personalBook]);
  // Sổ nhận khi tôi là người NHẬN bàn giao: sổ tiền mặt riêng + các sổ của tôi.
  const receiveBooks = useMemo(() => {
    const owned = myAccounts.map((a) => ({ id: String(a.id), name: String(a.name ?? '') }));
    return personalBook
      ? [{ id: personalBook.id, name: personalBook.name }, ...owned.filter((a) => a.id !== personalBook.id)]
      : owned;
  }, [myAccounts, personalBook]);
  const ownId = personalBook?.id ?? '';
  // Không lặng lẽ rơi sang sổ khác khi chưa có sổ tiền mặt riêng: người dùng
  // phải tự chọn ở ô "Sổ bàn giao".
  const effectiveSource = sourceAccountId || ownId;
  const defaultToAccount = ownId;
  const showSourcePicker = sourceBooks.length > 1 || (!ownId && sourceBooks.length > 0);

  const vouchersQuery = useUnhandedVouchers(effectiveSource);
  const {data:vouchers=[],accountId,isLoading:loadingVouchers} = vouchersQuery;
  const handoversQuery = useCashHandoverList();
  const {data:handovers=[],actionCount} = handoversQuery;
  const catalogBlocked = [accountsQuery,staffQuery,receiving].some(query => query.isError || query.isLoading);

  const createMut = useCreateHandover();
  const confirmMut = useConfirmHandover();
  const requestCancelMut = useRequestCancelHandover();
  const confirmCancelMut = useConfirmCancelHandover();
  const rejectCancelMut = useRejectCancelHandover();

  const selectedIds = useMemo(
    () => vouchers.filter((v) => !unticked.has(v.id)).map((v) => v.id),
    [vouchers, unticked],
  );
  const { gross, expense, net } = netSelected(vouchers, selectedIds);
  const incomeVouchers = useMemo(() => vouchers.filter((v) => v.type !== 'EXPENSE'), [vouchers]);
  const expenseVouchers = useMemo(() => vouchers.filter((v) => v.type === 'EXPENSE'), [vouchers]);

  const openList = useMemo(() => handovers.filter(isOpenHandover), [handovers]);
  const historyList = useMemo(
    () => handovers.filter((h) => !isOpenHandover(h)).slice(0, 20),
    [handovers],
  );

  const toggleVoucher = (id: string) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const busy = feedback.saving || feedback.blocked || catalogBlocked ||
    createMut.isPending || confirmMut.isPending || requestCancelMut.isPending ||
    confirmCancelMut.isPending || rejectCancelMut.isPending;

  const submitCreate = () => feedback.run(async () => {
    const res = await createMut.mutateAsync({ receiverId, voucherIds: selectedIds, note });
    const recvName = receivers.find((r) => r.id === receiverId)?.full_name ?? 'người nhận';
    const bookName = sourceBooks.find(book => book.id === effectiveSource)?.name ?? 'sổ đã chọn';
    toast.success('Đã lập phiên bàn giao ' + res.code + ' từ ' + bookName + ', gồm ' + res.voucher_count + ' phiếu. Đang chờ ' + recvName + ' xác nhận.');
  }, () => {setUnticked(new Set());setNote('');setTab('open');}, {
    receiver: !receiverId ? 'Chọn người nhận bàn giao.' : undefined,
    vouchers: !selectedIds.length ? 'Chọn ít nhất một phiếu để bàn giao.' : net < 0 ? 'Phần chi lớn hơn phần thu. Kiểm tra lại các phiếu được chọn.' : undefined,
  });

  const submitConfirm = (h: CashHandover) => {
    const toId = toAccount[h.id] || defaultToAccount || receiveBooks[0]?.id || '';
    return feedback.run(async () => {
      const res = await confirmMut.mutateAsync({handoverId:h.id,toAccountId:toId});
      const book = receiveBooks.find(item => item.id === toId)?.name ?? 'sổ nhận đã chọn';
      toast.success('Đã xác nhận nhận bàn giao phiên ' + res.code + ' vào sổ ' + book + '.');
    }, () => undefined, {['account_' + h.id]:!toId ? 'Chọn sổ quỹ nhận bàn giao.' : undefined});
  };

  const submitRequestCancel = (h: CashHandover) => feedback.run(async () => {
    await requestCancelMut.mutateAsync({handoverId:h.id,reason:cancelReason});
    toast.success('Đã gửi yêu cầu hủy phiên ' + h.code + '. Đang chờ bên còn lại xác nhận.');
  }, () => {setCancelFor(null);setCancelReason('');}, {reason:!cancelReason.trim() ? 'Nhập lý do hủy phiên bàn giao.' : undefined});

  const submitConfirmCancel = (h: CashHandover) => feedback.run(async () => {
    await confirmCancelMut.mutateAsync({handoverId:h.id});
    toast.success('Đã hủy phiên bàn giao ' + h.code + '. Các phiếu trở về trạng thái chưa bàn giao.');
  }, () => undefined);

  const submitRejectCancel = (h: CashHandover, mine: boolean) => feedback.run(async () => {
    await rejectCancelMut.mutateAsync({handoverId:h.id});
    toast.success((mine ? 'Đã thu hồi yêu cầu hủy phiên ' : 'Đã từ chối yêu cầu hủy phiên ') + h.code + '.');
  }, () => undefined);

  const voucherRow = (v: (typeof vouchers)[number]) => {
    const checked = !unticked.has(v.id);
    const isExp = v.type === 'EXPENSE';
    return (
      <label className={'ho-vrow' + (checked ? '' : ' off') + (isExp ? ' ho-vexp' : '')} key={v.id}>
        <input type="checkbox" checked={checked} onChange={() => toggleVoucher(v.id)} />
        <span className="ho-vmain">
          <span className="ho-vroom">{v.room?.name ?? v.name ?? '—'}</span>
          <span className="ho-vsub">
            {v.building?.name ?? ''} · {fmtDate(v.voucher_date)} · {v.code}
          </span>
        </span>
        <span className="ho-vamt">{isExp ? '−' : ''}{fmtFull(v.total_amount)}</span>
      </label>
    );
  };

  const renderItems = (h: CashHandover) => {
    const items = h.items ?? [];
    const inc = items.filter((it) => it.voucher_type !== 'EXPENSE');
    const exp = items.filter((it) => it.voucher_type === 'EXPENSE');
    return (
      <div className="ho-items">
        <div className="rp-lhead">
          <span>Phòng đã thu</span>
          <span>Số tiền</span>
        </div>
        {inc.map((it) => (
          <div className="rp-row" key={it.voucher_id}>
            <div className="rp-rl">
              <span className="rp-code">{it.room_name ?? '—'}</span>
              <span className="rp-note">{it.building_name ?? ''} · {fmtDate(it.voucher_date)}</span>
            </div>
            <span className="rp-amt">{fmtFull(it.amount)}</span>
          </div>
        ))}
        {exp.length > 0 && (
          <>
            <div className="ho-vgroup">Đã chi từ sổ — trừ vào tiền nộp</div>
            {exp.map((it) => (
              <div className="rp-row" key={it.voucher_id}>
                <div className="rp-rl">
                  <span className="rp-code">{it.room_name ?? it.building_name ?? 'Khoản chi'}</span>
                  <span className="rp-note">{fmtDate(it.voucher_date)}</span>
                </div>
                <span className="rp-amt" style={{ color: 'var(--c-unpaid)' }}>−{fmtFull(it.amount)}</span>
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  const renderCard = (h: CashHandover, withActions: boolean) => {
    const role = myRole(h, myId);
    const waiting = needsMyAction(h, myId);
    const label = handoverStatusLabel(h, myId);
    const iRequestedCancel = h.cancel_requested_by === myId;
    return (
      <div className={'ho-card' + (waiting ? ' attention' : '')} key={h.id}>
        <div className="ho-card-head">
          <span className="ho-code">{h.code}</span>
          <span className={'ho-tag ' + (h.status === 'CONFIRMED' ? 'ok' : h.status === 'CANCELLED' ? 'off' : h.cancel_requested_by ? 'warn' : 'wait')}>
            {label}
          </span>
        </div>
        <div className="ho-line">
          <span className="ho-who">{h.giver_name || 'Người giao'}</span>
          <span className="ho-arrow">→</span>
          <span className="ho-who">{h.receiver_name || 'Người nhận'}</span>
          <span className="ho-sum">{fmtFull(h.total_amount)}</span>
        </div>
        <div className="ho-meta">
          {(h.expense_amount ?? 0) > 0
            ? `thu ${fmtFull(h.gross_amount ?? 0)} − chi ${fmtFull(h.expense_amount ?? 0)} · `
            : ''}
          {h.voucher_count} phiếu · tạo {fmtDate(h.created_at)}
          {h.status === 'CONFIRMED' && h.confirmed_at ? ` · nhận ${fmtDateTime(h.confirmed_at)}` : ''}
          {h.note ? ` · ${h.note}` : ''}
        </div>

        {withActions && renderItems(h)}

        {withActions && h.cancel_requested_by && h.status !== 'CANCELLED' && (
          <div className="ho-cancelbox">
            <b>Lý do hủy:</b> {h.cancel_reason}
            <div className="ho-acts">
              {iRequestedCancel ? (
                <button type="button" className="ho-btn ghost" disabled={busy} onClick={() => submitRejectCancel(h, true)}>
                  Thu hồi yêu cầu
                </button>
              ) : (
                <>
                  <button type="button" className="ho-btn danger" disabled={busy} onClick={() => submitConfirmCancel(h)}>
                    Xác nhận hủy
                  </button>
                  <button type="button" className="ho-btn ghost" disabled={busy} onClick={() => submitRejectCancel(h, false)}>
                    Từ chối
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {withActions && !h.cancel_requested_by && h.status === 'PENDING' && (
          <>
            {role === 'receiver' && (
              <div className="ho-receive">
                <label className="rp-dd">
                  <span className="rp-dd-l">Sổ nhận tiền</span>
                  <div className="rp-dd-sel">
                    <select {...feedback.field("account_" + h.id)}
                      value={toAccount[h.id] ?? (defaultToAccount || receiveBooks[0]?.id || '')}
                      onChange={(e) => setToAccount((m) => ({ ...m, [h.id]: e.target.value }))}
                    >
                      {!receiveBooks.length && <option value="">— Chưa có sổ quỹ —</option>}
                      {receiveBooks.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </div>
                </label>
                {feedback.issue("account_" + h.id)}
                {!personalLoading && !personalBook && (
                  <p className="ho-hint">{personalError || THIEU_SO_TIEN_MAT_RIENG}</p>
                )}
                <button type="button" className="ho-btn primary" disabled={busy} onClick={() => submitConfirm(h)}>
                  ✓ Xác nhận đã nhận {fmtFull(h.total_amount)}
                </button>
              </div>
            )}
            {cancelFor === h.id ? (
              <div className="ho-cancelbox">
                <textarea
                  className="note-input"
                  rows={2}
                  {...feedback.field("reason")} placeholder="Lý do hủy phiên (bắt buộc)…"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                />
                {feedback.issue("reason")}
                <div className="ho-acts">
                  <button type="button" className="ho-btn danger" disabled={busy} onClick={() => submitRequestCancel(h)}>
                    Gửi yêu cầu hủy
                  </button>
                  <button type="button" className="ho-btn ghost" onClick={() => { setCancelFor(null); setCancelReason(''); }}>
                    Đóng
                  </button>
                </div>
              </div>
            ) : (
              <div className="ho-acts">
                <button type="button" className="ho-btn ghost" disabled={busy} onClick={() => { setCancelFor(h.id); setCancelReason(''); }}>
                  Yêu cầu hủy
                </button>
              </div>
            )}
          </>
        )}
        {withActions && !h.cancel_requested_by && h.status === 'CONFIRMED' && (
          <div className="ho-acts">
            <button type="button" className="ho-btn ghost" disabled={busy} onClick={() => { setCancelFor(h.id); setCancelReason(''); }}>
              Yêu cầu hủy
            </button>
            {cancelFor === h.id && (
              <div className="ho-cancelbox" style={{ width: '100%' }}>
                <textarea
                  className="note-input"
                  rows={2}
                  {...feedback.field("reason")} placeholder="Lý do hủy phiên (bắt buộc)…"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                />
                {feedback.issue("reason")}
                <div className="ho-acts">
                  <button type="button" className="ho-btn danger" disabled={busy} onClick={() => submitRequestCancel(h)}>
                    Gửi yêu cầu hủy
                  </button>
                  <button type="button" className="ho-btn ghost" onClick={() => { setCancelFor(null); setCancelReason(''); }}>
                    Đóng
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Lúc chờ dữ liệu: thẻ xám lùi lề như .ho-cards (thân tấm trượt không có lề riêng),
  // không chữ "Đang tải…" — chủ chốt 02/10/2026.
  const choThe = (label: string, queries: readonly RegionQuery[], rows = 3) => (
    <div style={{ padding: '14px 18px 0' }}>
      <LoadingState label={label} variant="list" rows={rows} onRetry={() => refetchStartedSources(queries)} />
    </div>
  );

  return (
    <>
      <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={() => feedback.close(onClose)} />
      <div ref={feedback.root} className={'sheet full' + (show ? ' show' : '')}>
        <div className="rp-topbar">
          <div>
            <div className="rp-title">Bàn giao tiền mặt</div>
            <div className="rp-sub">Nộp số dư (thu − chi) · xác nhận 2 phía để không lộn tiền</div>
          </div>
          <button type="button" className="rp-x" onClick={() => feedback.close(onClose)}>
            <X />
          </button>
        </div>

        {feedback.notice}
        <style>{'.ho-form [aria-invalid="true"],.ho-cancelbox [aria-invalid="true"],.ho-vlist[aria-invalid="true"]{border:1px solid #dc2626!important;outline-color:#dc2626}'}</style>
        <div className="ho-tabs">
          <button type="button" className={'cchip' + (tab === 'create' ? ' on' : '')} onClick={() => setTab('create')}>
            Bàn giao <span className="cnt">{vouchersQuery.isLoading ? <SkeletonBar className="inline-block h-3 align-middle" style={{ width: '0.9rem' }} /> : vouchersQuery.isError ? "—" : vouchers.length}</span>
          </button>
          <button type="button" className={'cchip' + (tab === 'open' ? ' on' : '')} onClick={() => setTab('open')}>
            Phiên chờ <span className="cnt">{handoversQuery.isLoading ? <SkeletonBar className="inline-block h-3 align-middle" style={{ width: '0.9rem' }} /> : handoversQuery.isError ? "—" : openList.length}</span>
            {actionCount > 0 && <span className="ho-dot" />}
          </button>
          <button type="button" className={'cchip' + (tab === 'history' ? ' on' : '')} onClick={() => setTab('history')}>
            Lịch sử
          </button>
        </div>

        <div className="sheet-scroll rp-body">
          {tab === 'create' && (
            <QueryRegion label="phiếu và danh mục bàn giao" queries={[accountsQuery,staffQuery,receiving,...(effectiveSource ? [vouchersQuery] : [])]} loading={choThe("phiếu và danh mục bàn giao", [accountsQuery,staffQuery,receiving,...(effectiveSource ? [vouchersQuery] : [])], 4)}>
              {/* Chọn sổ nguồn — hiện khi tôi có >1 sổ (vd Hiệp: "Hiệp Thu"
                  tiền mặt + "TKHIEP" chuyển khoản), hoặc khi chưa có sổ tiền mặt
                  riêng mà vẫn có sổ khác để chọn. Đổi sổ → tải lại phiếu. */}
              {showSourcePicker && (
                <div className="ho-form" style={{ paddingBottom: 0 }}>
                  <label className="rp-dd">
                    <span className="rp-dd-l">Sổ bàn giao</span>
                    <div className="rp-dd-sel">
                      <select
                        value={effectiveSource}
                        onChange={(e) => { setSourceAccountId(e.target.value); setUnticked(new Set()); }}
                      >
                        {!effectiveSource && <option value="">— Chọn sổ —</option>}
                        {sourceBooks.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                  </label>
                </div>
              )}
              {!accountId && personalLoading ? (
                choThe("sổ tiền mặt riêng", [receiving])
              ) : !accountId ? (
                <div className="c-empty">
                  <div className="e-ic">📒</div>
                  <p>
                    {personalError || THIEU_SO_TIEN_MAT_RIENG}
                    {sourceBooks.length > 0 ? ' Hoặc chọn sổ khác ở ô "Sổ bàn giao" phía trên.' : ''}
                  </p>
                </div>
              ) : loadingVouchers ? (
                choThe("phiếu thu", [vouchersQuery], 4)
              ) : vouchers.length === 0 ? (
                <div className="c-empty">
                  <div className="e-ic">🎉</div>
                  <p>Không còn phiếu thu/chi nào chưa bàn giao trong sổ của bạn.</p>
                </div>
              ) : (
                <>
                  <div className="rp-total">
                    <div className="rp-total-main">
                      <span className="rp-tl">Tiền thực nộp</span>
                      <span className="rp-tv">{fmtFull(net)}</span>
                    </div>
                    <div className="rp-total-sub">
                      Thu {fmtFull(gross)}
                      {expense > 0 ? <> · <span className="neg">Chi {fmtFull(expense)}</span></> : ''}
                      {' · '}{selectedIds.length}/{vouchers.length} phiếu
                    </div>
                  </div>

                  <div className="ho-form">
                    <label className="rp-dd">
                      <span className="rp-dd-l">Người nhận</span>
                      <div className="rp-dd-sel">
                        <select {...feedback.field("receiver")} value={receiverId} onChange={(e) => setReceiverId(e.target.value)}>
                          <option value="">— Chọn người nhận —</option>
                          {receivers.map((u) => (
                            <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                          ))}
                        </select>
                      </div>
                    </label>
                    {feedback.issue("receiver")}
                    <textarea
                      className="note-input"
                      rows={2}
                      placeholder="Ghi chú (không bắt buộc)…"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </div>

                  <div className="ho-vlist" {...feedback.field("vouchers")} tabIndex={-1}>
                    {feedback.issue("vouchers")}
                    {incomeVouchers.map((v) => voucherRow(v))}
                    {expenseVouchers.length > 0 && (
                      <>
                        <div className="ho-vgroup">Đã chi từ sổ — trừ vào tiền nộp</div>
                        {expenseVouchers.map((v) => voucherRow(v))}
                      </>
                    )}
                  </div>

                  <div className="ho-submit">
                    <button
                      type="button"
                      className="ho-btn primary big"
                      disabled={busy || vouchersQuery.isError || vouchersQuery.isLoading}
                      onClick={submitCreate}
                    >
                      Xác nhận giao {fmtFull(net)}
                    </button>
                    {net < 0 ? (
                      <p className="ho-hint" style={{ color: 'var(--c-unpaid)' }}>
                        Phần chi đang lớn hơn phần thu — không thể bàn giao số âm. Bỏ bớt phiếu chi
                        hoặc thêm phiếu thu.
                      </p>
                    ) : (
                      <p className="ho-hint">
                        Tiền vẫn nằm trong sổ của bạn cho tới khi người nhận bấm "Xác nhận đã nhận".
                      </p>
                    )}
                  </div>
                </>
              )}
            </QueryRegion>
          )}

          {tab === 'open' && (<QueryRegion label="phiên bàn giao đang chờ" queries={[handoversQuery,accountsQuery,receiving]} loading={choThe("phiên bàn giao đang chờ", [handoversQuery,accountsQuery,receiving])}>
            {openList.length === 0 ? (
              <div className="c-empty"><div className="e-ic">🤝</div><p>Không có phiên bàn giao nào đang chờ.</p></div>
            ) : (
              <div className="ho-cards">{openList.map((h) => renderCard(h, true))}</div>
            )}</QueryRegion>
          )}

          {tab === 'history' && (<QueryRegion label="lịch sử bàn giao" queries={[handoversQuery,accountsQuery,receiving]} loading={choThe("lịch sử bàn giao", [handoversQuery,accountsQuery,receiving])}>
            {historyList.length === 0 ? (
              <div className="c-empty"><div className="e-ic">🗂️</div><p>Chưa có phiên bàn giao nào hoàn tất.</p></div>
            ) : (
              // Phiên CONFIRMED vẫn cần nút "Yêu cầu hủy" (hủy sau khi đã nhận
              // phải có 2 bên xác nhận) → giữ actions; CANCELLED thì thuần đọc.
              <div className="ho-cards">{historyList.map((h) => renderCard(h, h.status === 'CONFIRMED'))}</div>
            )}</QueryRegion>
          )}

          <div className="rp-foot">
            <button type="button" className="rp-close" onClick={() => feedback.close(onClose)}>Đóng</button>
          </div>
        </div>
      </div>
    </>
  );
}

export default HandoverSheet;
