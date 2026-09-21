// =============================================================================
// ContractSettlementSection — điểm vào của khu "Hợp đồng & quyết toán".
//
// Bảng chia BỐN KHỐI thay vì một danh sách phẳng, vì mỗi khối làm được việc
// khác nhau:
//   Cần rà soát        — còn vướng, KHÔNG hiện nút Duyệt
//   Chờ duyệt          — sạch, có Duyệt và Duyệt & Chi
//   Đã duyệt · chờ chi — có nút Chi. ⚠ Phiếu này KHÔNG thuộc hai làn pending,
//                        nên đừng dùng laneOf() làm điều kiện hiện nút Chi.
//   Đã xử lý           — đã chi, không ghi quỹ, đã huỷ
// =============================================================================

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { laneOf, sumOnVoucher, type SettlementIssue, type SettlementRow } from '@/lib/contractSettlement';
import { useContractSettlement, type SettlementScope } from '@/hooks/useContractSettlement';
import { useSettlementActions } from '@/hooks/useSettlementActions';
import { fmtFull } from '@/lib/collect';
import { SettlementLifecycleModal } from './SettlementLifecycleModal';
import { NHAN_TRANG_THAI, NHAN_VUONG_MAC } from './nhan';
import './contract-settlement.css';

interface Props {
  buildingIds: string[];
  period: string;
}

/**
 * Tổ chức của phạm vi đang xem, suy từ chính các toà đang hiển thị.
 *
 * `ie_form_buildings` không trả `organization_id`, và khu này cần nó để lọc
 * truy vấn + lọc sổ quỹ theo đúng org của phiếu. Tra một lần, cache theo danh
 * sách toà — rẻ hơn nhiều so với bắt PeriodFeePanel đổi luồng dữ liệu sẵn có.
 */
const useOrgCuaToa = (buildingIds: string[]) =>
  useQuery({
    queryKey: ['contract-settlement', 'org-of-buildings', [...buildingIds].sort()],
    enabled: buildingIds.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from('buildings')
        .select('organization_id')
        .in('id', buildingIds)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.organization_id ?? null;
    },
  });

const CHIP_VUONG: SettlementIssue[] = [
  'MISSING_RECIPIENT', 'MISSING_BANK', 'AMOUNT_MISMATCH',
  'BASIS_UNAVAILABLE', 'SUPPLEMENT_PENDING', 'OLD_PERIOD',
];

export function ContractSettlementSection({ buildingIds, period }: Props) {
  const { data: organizationId } = useOrgCuaToa(buildingIds);
  const [scope, setScope] = useState<SettlementScope>('open');
  const [locVuong, setLocVuong] = useState<SettlementIssue[]>([]);
  const [dangMo, setDangMo] = useState<string | null>(null);

  const { rows, isLoading, isError, error } = useContractSettlement({
    organizationId, buildingIds, period, scope,
  });
  const actions = useSettlementActions(rows);

  const hienThi = useMemo(
    () => (locVuong.length === 0
      ? rows
      : rows.filter((r) => locVuong.every((v) => r.issues.includes(v)))),
    [rows, locVuong],
  );

  const khoi = useMemo(() => {
    const canRaSoat: SettlementRow[] = [];
    const choDuyet: SettlementRow[] = [];
    const choChi: SettlementRow[] = [];
    const daXuLy: SettlementRow[] = [];
    for (const r of hienThi) {
      const lane = laneOf(r);
      if (lane === 'can-ra-soat') canRaSoat.push(r);
      else if (lane === 'cho-duyet') choDuyet.push(r);
      else if (r.status === 'approved') choChi.push(r);
      else daXuLy.push(r);
    }
    return { canRaSoat, choDuyet, choChi, daXuLy };
  }, [hienThi]);

  const demVuong = useMemo(() => {
    const m = new Map<SettlementIssue, number>();
    for (const r of rows) for (const i of r.issues) m.set(i, (m.get(i) ?? 0) + 1);
    return m;
  }, [rows]);

  const row = dangMo ? rows.find((r) => r.voucherId === dangMo) ?? null : null;

  if (isError) {
    return (
      <div className="cs-wrap">
        <div className="cs-block">
          <div className="cs-empty" style={{ color: '#d6453f' }}>
            Không tải được danh sách khoản chi.
            {error instanceof Error ? ` ${error.message}` : ''}
            <div className="cs-note" style={{ marginTop: 6 }}>
              Đây là lỗi tải dữ liệu, <b>không</b> có nghĩa là không còn việc phải xử lý.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const Khoi = ({ tieuDe, moTa, ds, choPhepChi }: {
    tieuDe: string; moTa: string; ds: SettlementRow[]; choPhepChi?: boolean;
  }) => {
    if (ds.length === 0) return null;
    return (
      <div className="cs-block">
        <div className="cs-block-head">
          <span className="cs-block-title">{tieuDe} · {ds.length} khoản</span>
          <span className="cs-block-sub">{moTa}</span>
          <span style={{ flex: 1 }} />
          <span className="cs-block-sub" style={{ fontFamily: "'Space Mono', monospace" }}>
            {fmtFull(sumOnVoucher(ds))}
          </span>
        </div>
        {ds.map((r) => {
          const kha = actions.availabilityOf(r);
          const tt = NHAN_TRANG_THAI[r.status];
          return (
            <div className="cs-row" key={r.key}>
              <div style={{ minWidth: 0 }}>
                <div className="cs-room">{r.buildingName} · {r.roomName ?? '—'}</div>
                <div className="cs-sub">{r.contractNumber ?? 'Chưa xác định liên kết'}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{NHAN_VUONG_MAC.loai[r.kind]}</div>
                <div className="cs-sub">{r.voucherCode ?? 'Chưa có mã'}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{r.recipientName ?? '—'}</div>
                <div className="cs-sub">{r.bankAccount || 'Chưa có số tài khoản'}</div>
              </div>
              <div className="cs-amount">{fmtFull(r.amount)}</div>
              <div style={{ minWidth: 0 }}>
                <span className={`cs-tag ${tt.mau}`}>{tt.nhan}</span>
                {r.issues.length > 0 && (
                  <div className="cs-tags">
                    {r.issues.map((i) => (
                      <span key={i} className={`cs-tag ${NHAN_VUONG_MAC.vuong[i].mau}`}>
                        {NHAN_VUONG_MAC.vuong[i].nhan}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="cs-acts">
                {/* Nút Duyệt CHỈ ở khối Chờ duyệt — khối Cần rà soát chỉ mở được
                    modal để xử lý vướng mắc. */}
                {choPhepChi && kha.approve && (
                  <button type="button" className="cs-btn primary" disabled={actions.isBusy}
                    onClick={() => {
                      // Hook duyệt đã toast lỗi và giữ nguyên trạng thái; ở đây
                      // chỉ chặn unhandled rejection. KHÔNG nuốt thêm gì.
                      void actions.approve(r).catch(() => { /* đã báo ở hook */ });
                    }}>
                    Duyệt
                  </button>
                )}
                {choPhepChi && kha.post && (
                  <button type="button" className="cs-btn primary" onClick={() => setDangMo(r.voucherId)}>
                    Chi
                  </button>
                )}
                <button type="button" className="cs-btn" onClick={() => setDangMo(r.voucherId)}>
                  Xem
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="cs-wrap">
      <div className="cs-stats">
        <div className="cs-stat"><div className="cs-stat-lbl">Cần rà soát</div>
          <div className="cs-stat-num" style={{ color: '#d6453f' }}>{khoi.canRaSoat.length}</div>
          <div className="cs-stat-sub">{fmtFull(sumOnVoucher(khoi.canRaSoat))}</div></div>
        <div className="cs-stat"><div className="cs-stat-lbl">Chờ duyệt</div>
          <div className="cs-stat-num" style={{ color: '#c97a10' }}>{khoi.choDuyet.length}</div>
          <div className="cs-stat-sub">{fmtFull(sumOnVoucher(khoi.choDuyet))}</div></div>
        <div className="cs-stat"><div className="cs-stat-lbl">Đã duyệt · chờ chi</div>
          <div className="cs-stat-num" style={{ color: '#1f7a52' }}>{khoi.choChi.length}</div>
          <div className="cs-stat-sub">{fmtFull(sumOnVoucher(khoi.choChi))}</div></div>
        <div className="cs-stat"><div className="cs-stat-lbl">Đã xử lý</div>
          <div className="cs-stat-num" style={{ color: '#8d8678' }}>{khoi.daXuLy.length}</div>
          {/* ⚠ CỐ Ý không hiện tổng tiền ở đây: khối này trộn "đã chi thật" với
              "không ghi quỹ (sổ ảo)" và "đã huỷ" — cộng lại thành một con số là
              nói dối. Muốn số tiền đã chi thật thì cần đếm theo ngày ghi quỹ. */}
          <div className="cs-stat-sub">gồm cả không ghi quỹ và đã huỷ</div></div>
      </div>

      <div className="cs-filters">
        <button type="button" className={`cs-chip ${scope === 'open' ? 'on' : ''}`}
          onClick={() => setScope('open')}>Việc đang mở · mọi kỳ</button>
        <button type="button" className={`cs-chip ${scope === 'period' ? 'on' : ''}`}
          onClick={() => setScope('period')}>Kỳ {period}</button>
        <span style={{ width: 12 }} />
        {CHIP_VUONG.map((v) => {
          const n = demVuong.get(v) ?? 0;
          if (n === 0) return null;
          const on = locVuong.includes(v);
          return (
            <button type="button" key={v} className={`cs-chip ${on ? 'on' : ''}`}
              onClick={() => setLocVuong((cu) => on ? cu.filter((x) => x !== v) : [...cu, v])}>
              {NHAN_VUONG_MAC.vuong[v].nhan}<span className="cs-chip-n">{n}</span>
            </button>
          );
        })}
      </div>

      {scope === 'open' && (
        <div className="cs-note">
          Đang hiện <b>mọi kỳ</b> — khoản tồn của tháng trước vẫn nằm trong danh sách. Bấm
          “Kỳ {period}” nếu chỉ muốn xem tháng này.
        </div>
      )}

      {isLoading ? (
        <div className="cs-block"><div className="cs-empty">Đang tải khoản chi…</div></div>
      ) : rows.length === 0 ? (
        <div className="cs-block">
          <div className="cs-empty">
            Không còn khoản nào cần xử lý trong phạm vi đang xem.
          </div>
        </div>
      ) : (
        <>
          <Khoi tieuDe="Cần rà soát" ds={khoi.canRaSoat}
            moTa="còn vướng — xử lý xong sẽ tự chuyển sang Chờ duyệt" />
          <Khoi tieuDe="Chờ duyệt" ds={khoi.choDuyet} choPhepChi
            moTa="đã đủ dữ kiện" />
          <Khoi tieuDe="Đã duyệt · chờ chi" ds={khoi.choChi} choPhepChi
            moTa="chọn sổ quỹ và chứng từ khi bấm Chi" />
          <Khoi tieuDe="Đã xử lý" ds={khoi.daXuLy}
            moTa="đã chi · không ghi quỹ · đã huỷ" />
        </>
      )}

      {row && (
        <SettlementLifecycleModal row={row} actions={actions} onClose={() => setDangMo(null)} />
      )}
    </div>
  );
}
