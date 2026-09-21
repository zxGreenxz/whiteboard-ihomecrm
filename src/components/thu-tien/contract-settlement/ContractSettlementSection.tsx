// =============================================================================
// ContractSettlementSection — khu "Hợp đồng & quyết toán" trên /thanh-toan.
//
// Dựng theo bản thiết kế 03 (claude.ai/design, file
// "Thanh toan - Hop dong & quyet toan.dc.html"). Khác bản đầu của tôi ở chỗ:
// MỘT bảng + thẻ số bấm để lọc, chứ không phải bốn khối xếp chồng.
//
// ── ĐÂY LÀ LỚP MẶT, KHÔNG PHẢI NƠI LẬP PHIẾU ───────────────────────────────
// Mọi dòng ở "Cần rà soát" và "Chờ duyệt" đều là phiếu chi UNAPPROVED do trang
// Thu chi tạo ra. Khu này KHÔNG tạo phiếu, KHÔNG sửa luồng Thu chi, và KHÔNG
// đụng vào `src/pages/payments`, `src/components/income-expenses`,
// `src/hooks/income-expenses` hay `supabase/`. Chỉ ba việc — Duyệt, Chi,
// Duyệt & Chi — gọi xuống đúng hàm sẵn có của Thu chi qua useSettlementActions.
// Việc chuyển làn Cần rà soát ⇄ Chờ duyệt là của riêng khu này và SUY RA từ dữ
// liệu, không ghi cột nào.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  ACTION_LABEL, KIND_LABEL, STATUS_FILTER_LABEL, STATUS_STYLE,
  boDau, fmtCompact, fmtMoney, fmtNgay, matchStatus, viewStatusOf,
  type SettlementRow, type StatusFilter, type ViewStatus,
} from '@/lib/contractSettlement';
import type { SettlementKind } from '@/lib/settlementTypes';
import { useContractSettlement } from '@/hooks/useContractSettlement';
import { useContractMovements, MOVEMENT_LABEL, type MovementType } from '@/hooks/useContractMovements';
import { useSettlementActions } from '@/hooks/useSettlementActions';
import { SettlementLifecycleModal } from './SettlementLifecycleModal';
import { NHAN_VUONG_MAC } from './nhan';
import './contract-settlement.css';

interface Props {
  buildingIds: string[];
  period: string;
}

const useOrgCuaToa = (buildingIds: string[]) =>
  useQuery({
    queryKey: ['contract-settlement', 'org-of-buildings', [...buildingIds].sort()],
    enabled: buildingIds.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from('buildings').select('organization_id').in('id', buildingIds).limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.organization_id ?? null;
    },
  });

type Tab = 'payments' | 'movements';

interface BoLoc {
  q: string;
  building: string;
  /** 'all' = mọi kỳ. Tab Khoản chi mặc định 'all' (giữ tồn cũ trong tầm mắt);
   *  tab Biến động mặc định kỳ đang xem, vì báo cáo theo tháng mới có nghĩa. */
  month: string;
  kind: string;
  status: StatusFilter;
  origin: string;
  person: string;
  issue: string;
  advanced: boolean;
}

const locMacDinh = (month: string): BoLoc => ({
  q: '', building: 'all', month, kind: 'all', status: 'open',
  origin: 'all', person: 'all', issue: 'all', advanced: false,
});

/** Tổng số tiền TRÊN PHIẾU. Thuần, không đóng bao biến nào. */
const cong = (rs: SettlementRow[]) => rs.reduce((s, r) => s + r.amount, 0);

const COT_CHI = 'minmax(150px,1.3fr) minmax(110px,.9fr) minmax(120px,1fr) minmax(120px,.9fr) minmax(110px,.8fr) 108px';
const COT_BD = 'minmax(150px,1.2fr) minmax(200px,1.5fr) 120px minmax(180px,1.1fr)';

export function ContractSettlementSection({ buildingIds, period }: Props) {
  const { data: organizationId } = useOrgCuaToa(buildingIds);

  const [tab, setTab] = useState<Tab>('payments');
  const [gop, setGop] = useState(true);
  const [locChi, setLocChi] = useState<BoLoc>(() => locMacDinh('all'));
  const [locBd, setLocBd] = useState<BoLoc>(() => locMacDinh(period));
  const [dangMo, setDangMo] = useState<string | null>(null);

  const mv = tab === 'movements';
  const f = mv ? locBd : locChi;
  const datLoc = (p: Partial<BoLoc>) =>
    (mv ? setLocBd : setLocChi)((cu) => ({ ...cu, ...p }));

  // ── Toàn trang: ẩn cột khung điện thoại khi đang xem khu này ──────────────
  // Khu này không có bản mobile (chủ chốt: làm sau), nên để khung điện thoại
  // bên cạnh chỉ tổ chiếm chỗ. Tự gắn rồi tự gỡ, không đụng ThanhToan.tsx nên
  // các hạng mục khác giữ nguyên bố cục hai cột mà E2E đang canh.
  useEffect(() => {
    const stage = document.querySelector('.tt-stage');
    stage?.classList.add('cs-full');
    return () => stage?.classList.remove('cs-full');
  }, []);

  const chi = useContractSettlement({
    organizationId, buildingIds, period,
    scope: locChi.month === 'all' ? 'open' : 'period',
  });
  const bd = useContractMovements({
    organizationId, buildingIds,
    period: locBd.month === 'all' ? null : locBd.month,
  });

  const actions = useSettlementActions(chi.rows);

  /** Trạng thái nhìn thấy, tính một lần cho mỗi dòng. */
  const viewOf = useMemo(() => {
    const m = new Map<string, ViewStatus>();
    for (const r of chi.rows) m.set(r.key, viewStatusOf(r));
    return m;
  }, [chi.rows]);

  // ── Nền lọc: mọi thứ TRỪ chip loại và chip trạng thái ─────────────────────
  // Tách ra vì số đếm trên chip phải tính trên nền này; nếu tính trên tập đã
  // lọc theo chính nó thì mọi chip đều hiện đúng số của nó và bằng tổng.
  const nenChi = useMemo(() => {
    const q = boDau(f.q);
    return chi.rows.filter((r) => {
      if (f.building !== 'all' && r.buildingId !== f.building) return false;
      if (f.month !== 'all' && !(r.eventDate ?? '').startsWith(f.month)) return false;
      if (f.origin !== 'all' && r.origin !== f.origin) return false;
      if (f.person !== 'all' && (r.recipientName ?? '') !== f.person) return false;
      if (f.issue === 'yes' && r.issues.length === 0) return false;
      if (q && !boDau([
        r.customerName, r.recipientName, r.roomName, r.buildingName,
        r.contractNumber, r.voucherCode,
      ].join(' ')).includes(q)) return false;
      return true;
    });
  }, [chi.rows, f.building, f.month, f.origin, f.person, f.issue, f.q]);

  const nenBd = useMemo(() => {
    const q = boDau(f.q);
    return bd.rows.filter((e) => {
      if (f.building !== 'all' && e.buildingId !== f.building) return false;
      if (f.origin !== 'all' && e.origin !== f.origin) return false;
      if (q && !boDau([e.customer, e.roomName, e.buildingName, e.source].join(' ')).includes(q)) return false;
      return true;
    });
  }, [bd.rows, f.building, f.origin, f.q]);

  const hienChi = useMemo(
    () => nenChi.filter((r) =>
      (f.kind === 'all' || r.kind === f.kind)
      && matchStatus(viewOf.get(r.key) ?? 'unknown', f.status)),
    [nenChi, f.kind, f.status, viewOf],
  );
  const hienBd = useMemo(
    () => nenBd.filter((e) => f.kind === 'all' || e.type === f.kind),
    [nenBd, f.kind],
  );

  // ── Thẻ số ────────────────────────────────────────────────────────────────
  // Tính trên nền đã lọc theo loại (giống thiết kế), KHÔNG theo trạng thái —
  // nếu không thì bấm một thẻ sẽ làm các thẻ còn lại về 0.
  const doThe = useMemo(() => nenChi.filter((r) => f.kind === 'all' || r.kind === f.kind), [nenChi, f.kind]);

  const the = useMemo(() => {
    if (mv) return [];
    const nhom = (vs: ViewStatus[]) => doThe.filter((r) => vs.includes(viewOf.get(r.key) ?? 'unknown'));
    const mk = (key: StatusFilter, label: string, vs: ViewStatus[], dot: string,
      meta?: (rs: SettlementRow[], n: number) => string) => {
      const rs = nhom(vs);
      const n = cong(rs);
      return { key, label, dot, so: fmtCompact(n), meta: meta ? meta(rs, n) : `${rs.length} phiếu · ${fmtMoney(n)}` };
    };
    const raSoat = nhom(['review']);
    const daChi = nhom(['paid']);
    const khongQuy = nhom(['noncash']);
    return [
      {
        key: 'review' as StatusFilter, label: 'Cần rà soát', dot: STATUS_STYLE.review.fg,
        so: String(raSoat.length), meta: 'hồ sơ cần kiểm tra',
      },
      ...(gop
        ? [mk('pendpay', 'Chờ Duyệt và Chi', ['pending', 'approved'], STATUS_STYLE.pending.fg,
            (rs, n) => `${rs.filter((r) => viewOf.get(r.key) === 'pending').length} chờ duyệt · `
              + `${rs.filter((r) => viewOf.get(r.key) === 'approved').length} chờ chi · ${fmtMoney(n)}`)]
        : [
            mk('pending', 'Chờ duyệt', ['pending'], STATUS_STYLE.pending.fg),
            mk('approved', 'Chờ chi', ['approved'], STATUS_STYLE.approved.fg),
          ]),
      {
        key: 'paid' as StatusFilter, label: 'Đã chi', dot: STATUS_STYLE.paid.fg,
        // ⚠ Số tiền CHỈ cộng phiếu đã ghi sổ thật. Phiếu "không ghi quỹ" được
        // đếm riêng ở dòng dưới — cộng chung là nói dối về tiền đã rời két.
        so: fmtCompact(cong(daChi)),
        meta: `${daChi.length} phiếu · ${fmtMoney(cong(daChi))}`
          + (khongQuy.length ? ` · ${khongQuy.length} không ghi quỹ` : ''),
      },
    ];
  }, [mv, doThe, gop, viewOf]);

  const theBd = useMemo(() => {
    if (!mv) return [];
    return (Object.keys(MOVEMENT_LABEL) as MovementType[]).map((k) => ({
      key: k, label: MOVEMENT_LABEL[k], so: String(nenBd.filter((e) => e.type === k).length),
    }));
  }, [mv, nenBd]);

  // ── Chip ──────────────────────────────────────────────────────────────────
  const demChi = (k: string) =>
    nenChi.filter((r) => (k === 'all' || r.kind === k)
      && matchStatus(viewOf.get(r.key) ?? 'unknown', f.status)).length;
  const demBd = (k: string) => nenBd.filter((e) => k === 'all' || e.type === k).length;

  const chipLoai = mv
    ? [{ k: 'all', l: 'Tất cả', n: demBd('all') },
       ...(Object.keys(MOVEMENT_LABEL) as MovementType[]).map((k) => ({ k, l: MOVEMENT_LABEL[k], n: demBd(k) }))]
    : [{ k: 'all', l: 'Tất cả', n: demChi('all') },
       ...(['refund', 'commission', 'bonus'] as SettlementKind[]).map((k) => ({ k, l: KIND_LABEL[k], n: demChi(k) }))];

  const toaCo = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of chi.rows) if (r.buildingId) m.set(r.buildingId, r.buildingName);
    for (const e of bd.rows) if (e.buildingId) m.set(e.buildingId, e.buildingName);
    return [...m].sort((a, b) => a[1].localeCompare(b[1], 'vi'));
  }, [chi.rows, bd.rows]);

  const nguoiCo = useMemo(() => {
    const s = new Set<string>();
    for (const r of chi.rows) if (r.recipientName?.trim()) s.add(r.recipientName.trim());
    return [...s].sort((a, b) => a.localeCompare(b, 'vi'));
  }, [chi.rows]);

  const ton = mv ? [] : hienChi.filter((r) => {
    const v = viewOf.get(r.key);
    return (r.eventDate ?? '').slice(0, 7) < period && v !== 'paid' && v !== 'cancelled';
  });

  const dangTai = mv ? bd.isLoading : chi.isLoading;
  const hong = mv ? bd.isError : chi.isError;
  const soDong = mv ? hienBd.length : hienChi.length;
  const tongTien = mv ? 0 : hienChi.reduce((s, r) => s + r.amount, 0);
  const coLoc = f.q !== '' || f.building !== 'all' || f.kind !== 'all' || f.origin !== 'all'
    || f.person !== 'all' || f.issue !== 'all';

  const row = dangMo ? chi.rows.find((r) => r.voucherId === dangMo) ?? null : null;

  const xoaLoc = () => (mv ? setLocBd : setLocChi)(
    { ...locMacDinh(mv ? period : 'all'), advanced: f.advanced },
  );

  return (
    <div className="cs-wrap">
      {/* ── Thanh chuyển tab ───────────────────────────────────────────── */}
      <div className="cs-viewbar">
        <div className="cs-pills">
          <button type="button" className={`cs-pill ${mv ? '' : 'on'}`} onClick={() => setTab('payments')}>
            Khoản chi
          </button>
          <button type="button" className={`cs-pill ${mv ? 'on' : ''}`} onClick={() => setTab('movements')}>
            Biến động
          </button>
        </div>
        {!mv && (
          <label className="cs-merge">
            <input
              type="checkbox" checked={gop}
              onChange={() => {
                setGop((g) => !g);
                // Đang lọc theo một thẻ sắp biến mất thì thả về "Cần xử lý",
                // kẻo bảng rỗng mà không ai hiểu vì sao.
                setLocChi((c) => (['pending', 'approved', 'pendpay'].includes(c.status)
                  ? { ...c, status: 'open' } : c));
              }}
            />
            Gộp Chờ duyệt và Chi
          </label>
        )}
      </div>

      {/* ── Thẻ số ─────────────────────────────────────────────────────── */}
      {!mv && !dangTai && !hong && (
        <div className="cs-stats" style={{ gridTemplateColumns: `repeat(${the.length}, minmax(0,1fr))` }}>
          {the.map((t) => {
            const on = f.status === t.key;
            return (
              <button type="button" key={t.key} className={`cs-stat ${on ? 'on' : ''}`}
                onClick={() => datLoc({ status: on ? 'open' : t.key })}>
                <div className="cs-stat-lbl"><span className="cs-dot" style={{ background: t.dot }} />{t.label}</div>
                <div className="cs-stat-num">{t.so}</div>
                <div className="cs-stat-meta">{t.meta}</div>
                <span className="cs-stat-cta">{on ? 'Đang lọc' : 'Lọc'}</span>
              </button>
            );
          })}
        </div>
      )}
      {mv && !dangTai && !hong && (
        <div className="cs-stats mov" style={{ gridTemplateColumns: 'repeat(5, minmax(0,1fr))' }}>
          {theBd.map((t) => {
            const on = f.kind === t.key;
            return (
              <button type="button" key={t.key} className={`cs-stat ${on ? 'on' : ''}`}
                onClick={() => datLoc({ kind: on ? 'all' : t.key })}>
                <div className="cs-stat-lbl">{t.label}</div>
                <div className="cs-stat-num">{t.so}</div>
                <div className="cs-stat-meta">lượt biến động</div>
              </button>
            );
          })}
        </div>
      )}

      {dangTai && (
        <>
          <div className="cs-stats" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
            {[0, 1, 2].map((i) => <div className="cs-skel" key={i} />)}
          </div>
          <div className="cs-load"><span className="cs-spin" />Đang tải {mv ? 'biến động' : 'khoản chi'}…</div>
        </>
      )}

      {hong && (
        <div className="cs-fail">
          <b>Không tải được danh sách {mv ? 'biến động' : 'khoản chi'}</b>
          <p>
            Bộ lọc vẫn được giữ. Đây là lỗi tải dữ liệu — <b style={{ color: 'inherit' }}>không</b> có
            nghĩa là không còn việc phải xử lý.
          </p>
          <button type="button" className="cs-btn primary" onClick={() => (mv ? bd : chi).refetch?.()}>
            Thử lại
          </button>
        </div>
      )}

      {!dangTai && !hong && (
        <section className="cs-surface">
          {/* ── Thanh công cụ ────────────────────────────────────────────── */}
          <div className="cs-tools">
            <label className="cs-search">
              <span style={{ fontSize: 12 }}>⌕</span>
              <input
                value={f.q} onChange={(e) => datLoc({ q: e.target.value })}
                placeholder="Tìm phòng, khách, hợp đồng, phiếu…"
              />
            </label>
            <select className="cs-sel" value={f.building} onChange={(e) => datLoc({ building: e.target.value })}>
              <option value="all">Tất cả tòa</option>
              {toaCo.map(([id, ten]) => <option key={id} value={id}>{ten}</option>)}
            </select>
            <select className="cs-sel" value={f.month} onChange={(e) => datLoc({ month: e.target.value })}>
              <option value="all">{mv ? 'Mọi kỳ' : 'Mọi kỳ · gồm tồn cũ'}</option>
              <option value={period}>Kỳ {period}</option>
            </select>
            <button type="button" className={`cs-advbtn ${f.advanced ? 'on' : ''}`}
              onClick={() => datLoc({ advanced: !f.advanced })}>
              Bộ lọc
            </button>
          </div>

          {f.advanced && (
            <div className="cs-adv">
              <label>
                Nguồn
                <select value={f.origin} onChange={(e) => datLoc({ origin: e.target.value })}>
                  <option value="all">Tất cả nguồn</option>
                  <option value="contract">Hợp đồng</option>
                  <option value="reservation">Giữ chỗ</option>
                </select>
              </label>
              {!mv && (
                <>
                  <label>
                    Người nhận
                    <select value={f.person} onChange={(e) => datLoc({ person: e.target.value })}>
                      <option value="all">Tất cả</option>
                      {nguoiCo.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </label>
                  <label>
                    Trạng thái
                    <select value={f.status} onChange={(e) => datLoc({ status: e.target.value as StatusFilter })}>
                      {(['open', 'all', 'review', 'pending', 'approved', 'paid', 'noncash', 'cancelled'] as StatusFilter[])
                        .map((k) => <option key={k} value={k}>{STATUS_FILTER_LABEL[k]}</option>)}
                    </select>
                  </label>
                  <label>
                    Vướng mắc
                    <select value={f.issue} onChange={(e) => datLoc({ issue: e.target.value })}>
                      <option value="all">Tất cả</option>
                      <option value="yes">Có vấn đề cần rà soát</option>
                    </select>
                  </label>
                </>
              )}
              <button type="button" className="cs-clear" onClick={xoaLoc}>Bỏ bộ lọc</button>
            </div>
          )}

          {/* ── Chip ─────────────────────────────────────────────────────── */}
          <div className="cs-chips">
            {chipLoai.map((c) => (
              <button type="button" key={c.k} className={`cs-chip ${f.kind === c.k ? 'on' : ''}`}
                onClick={() => datLoc({ kind: c.k })}>
                {c.l}<span className="cs-chip-n">{c.n}</span>
              </button>
            ))}
            <span className="cs-chips-gap" />
            {!mv && (['open', 'paid'] as StatusFilter[]).map((k) => (
              <button type="button" key={k} className={`cs-chip ${f.status === k ? 'on' : ''}`}
                onClick={() => datLoc({ status: k })}>
                {STATUS_FILTER_LABEL[k]}
              </button>
            ))}
          </div>

          {!mv && ton.length > 0 && (
            <div className="cs-notice">
              <span className="cs-tag-ton">TỒN</span>
              <span>
                Có <b>{ton.length} khoản tồn kỳ trước</b> ·{' '}
                <span style={{ fontFamily: 'var(--mono)' }}>{fmtMoney(ton.reduce((s, r) => s + r.amount, 0))}</span>.
                {' '}Vẫn được giữ trong danh sách cần xử lý.
              </span>
            </div>
          )}
          {mv && (
            <div className="cs-hint">
              Đếm theo lượt biến động, theo ngày phát sinh nghiệp vụ. Khoản chi liên kết dùng chung,
              không cộng lặp giữa giữ chỗ và ký hợp đồng.
            </div>
          )}

          <div className="cs-resline">
            <span>{soDong}{mv ? ' lượt biến động' : ` khoản · ${STATUS_FILTER_LABEL[f.status]}`}</span>
            <span>{mv ? 'Mỗi dòng = một sự kiện' : 'Danh sách chi tiết'}</span>
          </div>

          {/* ── Bảng khoản chi ───────────────────────────────────────────── */}
          {!mv && hienChi.length > 0 && (
            <div style={{ ['--cs-cols' as string]: COT_CHI }}>
              <div className="cs-head">
                <span>Phòng · Khách</span><span>Khoản chi</span><span>Người nhận</span>
                <span style={{ textAlign: 'right' }}>Số tiền</span><span>Trạng thái</span><span />
              </div>
              {hienChi.map((r) => {
                const v = viewOf.get(r.key) ?? 'unknown';
                const st = STATUS_STYLE[v];
                const cu = (r.eventDate ?? '').slice(0, 7) < period && v !== 'paid' && v !== 'cancelled';
                return (
                  <div className={`cs-row ${dangMo === r.voucherId ? 'on' : ''}`} key={r.key}>
                    <button type="button" className="cs-cellbtn" onClick={() => setDangMo(r.voucherId)}>
                      <div className="cs-room">{r.buildingName} · {r.roomName ?? '—'}</div>
                      <div className="cs-cust">{r.customerName}</div>
                      <div className="cs-code">{r.voucherCode ?? 'Chưa có mã'} · {r.contractNumber ?? '—'}</div>
                    </button>
                    <div style={{ minWidth: 0 }}>
                      <div className="cs-kind">{KIND_LABEL[r.kind]}</div>
                      <div className="cs-sub">{r.eventLabel}</div>
                      {cu && (
                        <span className="cs-tag sm" style={{ background: 'var(--st-soon-bg)', color: '#8a6111' }}>
                          Tồn kỳ trước
                        </span>
                      )}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5 }}>{r.recipientName ?? '—'}</div>
                      <div className={`cs-sub ${r.bankAccount ? '' : 'warn'}`}>
                        {r.bankAccount ? 'Đã có thông tin nhận' : 'Thiếu tài khoản'}
                      </div>
                    </div>
                    <div className="cs-amt">
                      <div className="cs-amt-v">{fmtMoney(r.amount)}</div>
                      <div className="cs-amt-s">
                        {v === 'paid' ? `Chi ${fmtNgay(r.paidDate)}`
                          : v === 'approved' ? 'Đã duyệt'
                          : v === 'review' ? 'Đề nghị · chưa xác minh' : 'Đề nghị'}
                      </div>
                    </div>
                    <div>
                      <span className="cs-tag" style={{ background: st.bg, color: st.fg }}>{st.nhan}</span>
                      {r.issues.length > 0 && (
                        <div className="cs-issue">{NHAN_VUONG_MAC.vuong[r.issues[0]].nhan}
                          {r.issues.length > 1 ? ` +${r.issues.length - 1}` : ''}</div>
                      )}
                    </div>
                    <button type="button" className={`cs-go ${v === 'approved' ? 'hot' : ''}`}
                      onClick={() => setDangMo(r.voucherId)}>
                      {ACTION_LABEL[v]}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Bảng biến động ───────────────────────────────────────────── */}
          {mv && hienBd.length > 0 && (
            <div style={{ ['--cs-cols' as string]: COT_BD }}>
              <div className="cs-head">
                <span>Phòng · Khách</span><span>Biến động</span><span>Ngày phát sinh</span>
                <span>Khoản chi liên quan</span>
              </div>
              {hienBd.map((e) => {
                const lienQuan = chi.rows.filter((r) => r.contractId && r.contractId === e.contractId);
                return (
                  <div className="cs-row" key={e.key}>
                    <div style={{ minWidth: 0 }}>
                      <div className="cs-room">{e.buildingName} · {e.roomName ?? '—'}</div>
                      <div className="cs-cust">{e.customer}</div>
                      <div className="cs-code">{e.source}</div>
                    </div>
                    <div>
                      <span className="cs-tag" style={{ background: 'var(--line-2)', color: 'var(--ink-2)' }}>
                        {MOVEMENT_LABEL[e.type]}
                      </span>
                      <div className="cs-sub" style={{ marginTop: 4 }}>
                        {e.origin === 'reservation' ? 'Giữ chỗ' : 'Hợp đồng'} · {e.description}
                      </div>
                    </div>
                    <div className="cs-date">{fmtNgay(e.date)}</div>
                    <div className="cs-links">
                      {lienQuan.length === 0
                        ? <span className="cs-sub">Không phát sinh chi</span>
                        : lienQuan.map((r) => (
                            <button type="button" key={r.key} className="cs-cellbtn"
                              style={{ display: 'block', color: 'var(--brand)' }}
                              onClick={() => setDangMo(r.voucherId)}>
                              {KIND_LABEL[r.kind]}{' '}
                              <span className="cs-sub">
                                · <span style={{ fontFamily: 'var(--mono)' }}>{fmtMoney(r.amount)}</span>
                                {' '}· {STATUS_STYLE[viewOf.get(r.key) ?? 'unknown'].nhan}
                              </span>
                            </button>
                          ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {soDong === 0 && (
            <div className="cs-empty">
              <b>{coLoc ? 'Không có hồ sơ phù hợp' : 'Không còn khoản cần xử lý'}</b>
              <p>
                {coLoc
                  ? 'Đổi kỳ hoặc bỏ bớt bộ lọc để xem các hồ sơ khác.'
                  : 'Mọi phiếu trong phạm vi đã được chi hoặc từ chối. Xem “Đã chi” để đối chiếu lịch sử.'}
              </p>
              {coLoc && <button type="button" onClick={xoaLoc}>Bỏ bộ lọc</button>}
            </div>
          )}

          <div className="cs-foot">
            <span>
              {mv
                ? 'Ngày ký · xác nhận gia hạn · thanh lý · xử lý cọc'
                : f.status === 'paid'
                  ? 'Lọc theo ngày chi thực tế'
                  : 'Lọc theo kỳ phát sinh · đã chi được xem riêng trong lịch sử'}
            </span>
            <span>{mv ? '' : `Tổng đang xem: ${fmtMoney(tongTien)}`}</span>
          </div>
        </section>
      )}

      {row && (
        <SettlementLifecycleModal
          row={row} view={viewOf.get(row.key) ?? 'unknown'}
          actions={actions} onClose={() => setDangMo(null)}
        />
      )}
    </div>
  );
}
