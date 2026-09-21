// =============================================================================
// MovementLifecycleModal — hồ sơ MỘT biến động (ký mới · gia hạn · thanh lý ·
// bỏ cọc · giữ chỗ), theo bản thiết kế 03.
//
// ⚠ THUẦN ĐỌC, CÓ CHỦ Ý. Không một nút tiền nào ở đây. Thiết kế nói rõ:
// "Hồ sơ biến động chỉ để đối chiếu. Mọi thao tác duyệt và chi thực hiện trong
// hồ sơ khoản chi." Bấm một khoản chi liên quan sẽ MỞ hồ sơ phiếu đó — nơi duy
// nhất có nút, và nơi đó gọi xuống đúng hàm của Thu chi.
// =============================================================================

import { createPortal } from 'react-dom';
import { useContractLifecycle } from '@/hooks/useContractLifecycle';
import { ContractLifecycleBand } from './ContractLifecycleBand';
import { MOVEMENT_LABEL, type MovementRow } from '@/hooks/useContractMovements';
import {
  KIND_LABEL, STATUS_STYLE, fmtMoney, fmtNgay, viewStatusOf,
  type SettlementRow,
} from '@/lib/contractSettlement';

interface Props {
  ev: MovementRow;
  /** Khoản chi cùng hợp đồng với biến động này. */
  lienQuan: SettlementRow[];
  onMoPhieu: (voucherId: string) => void;
  onClose: () => void;
}

export function MovementLifecycleModal({ ev, lienQuan, onMoPhieu, onClose }: Props) {
  const vd = useContractLifecycle(ev.contractId);
  const v = vd.data;

  const tong = lienQuan.reduce((s, r) => s + r.amount, 0);
  const daChi = lienQuan
    .filter((r) => viewStatusOf(r) === 'paid')
    .reduce((s, r) => s + r.amount, 0);

  // Portal ra document.body vì `.tt-stage` là stacking context — xem chú thích
  // dài ở SettlementLifecycleModal, cùng một lý do.
  return createPortal(
    <div className="cs-scrim" onClick={onClose}>
      <div className="cs-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>

        <div className="cs-m-head">
          <div style={{ minWidth: 0 }}>
            <div className="cs-m-code">{ev.source}</div>
            <h2 className="cs-m-title">
              {MOVEMENT_LABEL[ev.type]} <span className="sl">/</span>{' '}
              <span className="mono">{ev.buildingName} · {ev.roomName ?? '—'}</span>
            </h2>
            <div className="cs-m-meta">
              <span className="cs-tag" style={{ background: 'var(--line-2)', color: 'var(--ink-2)' }}>
                {ev.origin === 'reservation' ? 'Giữ chỗ' : 'Hợp đồng'}
              </span>
              <span>Khách: <b>{ev.customer}</b></span>
              <span>Ngày phát sinh: <b>{fmtNgay(ev.date)}</b></span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexShrink: 0 }}>
            <div className="cs-m-amt">
              <div className="cap">{lienQuan.length ? 'Chi phát sinh từ biến động' : 'Không phát sinh chi'}</div>
              <div className="val">{fmtMoney(tong)}</div>
            </div>
            <button type="button" className="cs-x" onClick={onClose} aria-label="Đóng">×</button>
          </div>
        </div>

        <ContractLifecycleBand contractId={ev.contractId} />

        <div className="cs-body">
          <div className="cs-notes">
            <h3>Ghi chú biến động {MOVEMENT_LABEL[ev.type].toLowerCase()}</h3>
            <div className="cs-headlines">
              <div><span>Biến động</span> <b>{MOVEMENT_LABEL[ev.type]} · {fmtNgay(ev.date)}</b></div>
              <div><span>Nguồn</span> <b>{ev.source} · {ev.origin === 'reservation' ? 'Giữ chỗ' : 'Hợp đồng'}</b></div>
              <div><span>Phòng · khách</span> <b>{ev.buildingName}/{ev.roomName ?? '—'} · {ev.customer}</b></div>
              {ev.staffName && <div><span>Người phụ trách</span> <b>{ev.staffName}</b></div>}
              <div><span>Mô tả</span> <b>{ev.description}</b></div>
            </div>

            <div className="cs-sheet">
              <div className="cs-sheet-t">Số liệu hợp đồng tại thời điểm biến động</div>
              {v ? (
                <>
                  <div className="cs-kv"><span className="k">Cọc thực thu</span><span className="v">{fmtMoney(v.depositPaid)}</span></div>
                  <div className="cs-kv"><span className="k">Giá phòng</span><span className="v">{fmtMoney(v.rentPrice)}/tháng</span></div>
                  <div className="cs-kv"><span className="k">Tiền thuê / phí đã thu</span><span className="v">{fmtMoney(v.invoicePaid)}</span></div>
                  <div className="cs-kv"><span className="k">Nợ còn lại</span><span className="v">{fmtMoney(v.outstandingDebt ?? 0)}</span></div>
                  <div className="cs-kv strong top">
                    <span className="k">Tình trạng</span>
                    <span className="v">
                      {v.terminatedAt ? `Đã thanh lý ${fmtNgay(v.terminatedAt)}` : 'Đang hiệu lực'}
                    </span>
                  </div>
                </>
              ) : (
                <div className="cs-note-s">
                  {vd.isLoading ? 'Đang tra hợp đồng…'
                    : vd.isError ? 'Không đọc được hợp đồng.'
                    : 'Biến động này chưa gắn hợp đồng.'}
                </div>
              )}

              <div className="cs-total" style={lienQuan.length ? undefined : {
                background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--ink-2)',
              }}>
                <span>
                  <b>{lienQuan.length ? 'Khoản chi phát sinh' : 'Không phát sinh khoản chi'}</b>
                  <span className="sub">
                    {lienQuan.length
                      ? `${lienQuan.length} phiếu · đã chi ${fmtMoney(daChi)}`
                      : 'Biến động này không kéo theo phiếu chi nào'}
                  </span>
                </span>
                <b className="val">{fmtMoney(tong)}</b>
              </div>
            </div>

            <div className="cs-payout">
              <div><div className="k">Đã chi</div><b>{fmtMoney(daChi)}</b></div>
              <div>
                <div className="k">Còn phải chi</div>
                <b style={{ color: tong - daChi ? 'var(--c-partial)' : 'var(--c-paid)' }}>
                  {fmtMoney(tong - daChi)}
                </b>
              </div>
              <div><div className="k">Số phiếu</div><b>{lienQuan.length}</b></div>
            </div>
          </div>

          <div className="cs-side">
            <div>
              <h4>Khoản chi phát sinh</h4>
              {lienQuan.length === 0 ? (
                <div className="cs-note-s">Biến động này không kéo theo phiếu chi nào.</div>
              ) : (
                lienQuan.map((r) => {
                  const st = STATUS_STYLE[viewStatusOf(r)];
                  return (
                    <button type="button" key={r.key} className="cs-cellbtn"
                      style={{
                        display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%',
                        padding: '10px 0', borderBottom: '1px solid var(--line-2)', fontSize: 12,
                      }}
                      onClick={() => onMoPhieu(r.voucherId)}>
                      <span>
                        <b style={{ fontWeight: 600 }}>{KIND_LABEL[r.kind]}</b>
                        <span style={{ display: 'block', color: 'var(--ink-3)', fontSize: 11.5 }}>
                          {r.recipientName ?? 'Chưa có người nhận'} · {st.nhan}
                        </span>
                      </span>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {fmtMoney(r.amount)}
                      </span>
                    </button>
                  );
                })
              )}
              <div className="cs-note-s" style={{ marginTop: 8 }}>
                Bấm một khoản để mở hồ sơ phiếu chi tương ứng.
              </div>
            </div>

            {ev.staffName && (
              <div>
                <h4>Người phụ trách</h4>
                <div style={{ fontSize: 12 }}>{ev.staffName}</div>
              </div>
            )}

            <div className="cs-acts">
              <div className="cs-note-s">
                Hồ sơ biến động chỉ để đối chiếu. Mọi thao tác duyệt và chi thực hiện trong hồ sơ
                khoản chi.
              </div>
            </div>
          </div>
        </div>

        <div className="cs-m-foot">
          Số liệu đọc thẳng từ hợp đồng, hoá đơn và bản ghi thanh lý. Trang này không sửa gì.
        </div>
      </div>
    </div>,
    document.body,
  );
}
