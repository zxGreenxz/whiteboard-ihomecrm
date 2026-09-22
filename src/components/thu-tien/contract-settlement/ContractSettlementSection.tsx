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
  boDau, fmtCompact, fmtMoney, fmtNgay, groupTotal, isOldPeriodWork,
  lyDoChuaXacMinhNgayChi, matchScope, matchStatus, normalisePeriodFilter,
  periodScopeLabel, periodScopeOptions, statValue, viewStatusOf,
  type PeriodScope, type PostingReadState, type SettlementRow, type StatValue,
  type StatusFilter, type ViewStatus,
} from '@/lib/contractSettlement';
import type { SettlementKind } from '@/lib/settlementTypes';
import { useContractSettlement } from '@/hooks/useContractSettlement';
import { useContractMovements, MOVEMENT_LABEL, type MovementType, type MovementRow } from '@/hooks/useContractMovements';
import { useSettlementActions } from '@/hooks/useSettlementActions';
import { SettlementLifecycleModal } from './SettlementLifecycleModal';
import { MovementLifecycleModal } from './MovementLifecycleModal';
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
  /**
   * Phạm vi kỳ — ENUM, KHÔNG phải chuỗi tháng.
   *
   * ⚠ Bản trước giữ một chuỗi `month` ở đây và ánh xạ 'all' → một chế độ truy
   * vấn vừa bỏ lọc ngày vừa CẮT sẵn POSTED/CANCELLED. Hệ quả: "Mọi kỳ" không
   * phải mọi kỳ cũng không phải mọi trạng thái, và mỗi lần đổi kỳ chung của
   * trang lại còn một tháng cũ nằm khuất trong state. Kỳ tham chiếu duy nhất
   * bây giờ là `period` của trang.
   */
  scope: PeriodScope;
  kind: string;
  status: StatusFilter;
  origin: string;
  person: string;
  issue: string;
  advanced: boolean;
}

const locMacDinh = (): BoLoc => ({
  q: '', building: 'all', scope: 'current', kind: 'all', status: 'open',
  origin: 'all', person: 'all', issue: 'all', advanced: false,
});

/** Tổng số tiền TRÊN PHIẾU. Thuần, không đóng bao biến nào. */
const cong = (rs: SettlementRow[]) => rs.reduce((s, r) => s + r.amount, 0);

/**
 * Chữ trên thẻ số. Bốn ca tách bạch vì ba ca cuối KHÔNG được in ra số 0 —
 * "không có đồng nào" và "không biết" là hai câu khác hẳn nhau khi nói về tiền.
 */
const soThe = (v: StatValue): string => {
  switch (v.kind) {
    case 'number': return fmtCompact(v.total);
    /**
     * ⚠ `count === 0` thì KHÔNG in "0 đ". Đây đúng là màn hình mặc định của
     * chủ công ty: đo thật 22/09/2026 trên org THẬT — 1139 phiếu POSTED, 0
     * dòng bút toán đọc được, nên phần chứng minh được đúng bằng 0 phiếu. In
     * "0 đ" ở đó là nói "không có đồng nào đã chi", trong khi sự thật là "chưa
     * chứng minh được đồng nào" (plan §3.4, và docblock của `StatValue`).
     * Số phiếu chưa xác minh đi ra ở dòng meta ngay dưới thẻ.
     */
    case 'unverified': return v.count === 0 ? '—' : fmtCompact(v.total);
    case 'insufficient': return '—';
    case 'na': return '—';
  }
};

/**
 * ⚠ `unverified` in HAI con số, KHÔNG in một con số có nhãn.
 * Tiền là phần ĐỐI CHIẾU ĐƯỢC; phần còn lại là SỐ ĐẾM PHIẾU, không kèm tiền —
 * xem chú thích của `StatValue.unverified`. Và luôn kèm LÝ DO, vì "thử lại
 * được" / "phải đi xin quyền" / "thôi đừng chờ" là ba việc khác nhau.
 */
const metaThe = (v: StatValue, read: PostingReadState): string => {
  switch (v.kind) {
    case 'number': return `${v.count} phiếu · ${fmtMoney(v.total)}`;
    case 'unverified':
      return `${v.count} phiếu đã đối chiếu · ${fmtMoney(v.total)} · `
        + `${v.unverifiedCount} phiếu chưa xác minh (${lyDoChuaXacMinhNgayChi(read)})`;
    case 'insufficient': return `Chưa đủ dữ liệu — ${lyDoChuaXacMinhNgayChi(read)}`;
    case 'na': return 'Không áp dụng cho tồn cũ';
  }
};

const COT_CHI = 'minmax(150px,1.3fr) minmax(110px,.9fr) minmax(120px,1fr) minmax(120px,.9fr) minmax(110px,.8fr) 108px';
const COT_BD = 'minmax(150px,1.2fr) minmax(190px,1.4fr) 116px minmax(170px,1fr) 108px';

export function ContractSettlementSection({ buildingIds, period }: Props) {
  const { data: organizationId } = useOrgCuaToa(buildingIds);

  const [tab, setTab] = useState<Tab>('payments');
  const [gop, setGop] = useState(true);
  const [locChi, setLocChi] = useState<BoLoc>(locMacDinh);
  const [locBd, setLocBd] = useState<BoLoc>(locMacDinh);
  const [dangMo, setDangMo] = useState<string | null>(null);
  const [dangMoBd, setDangMoBd] = useState<string | null>(null);

  const mv = tab === 'movements';
  const f = mv ? locBd : locChi;

  /**
   * MỘT lối đổi bộ lọc duy nhất, và nó luôn đi qua `normalisePeriodFilter`.
   *
   * Thẻ số, dropdown kỳ, dropdown trạng thái, chip — tất cả gọi vào đây. Nếu
   * mỗi chỗ tự chữa lấy thì sẽ có chỗ quên, và chỗ quên đó để lại phạm vi
   * "Tồn Cũ" nằm ẩn sau một trạng thái lịch sử: bảng rỗng, không lời giải thích.
   *
   * Tab Biến động là BÁO CÁO LỊCH SỬ, không có khái niệm việc tồn — nó chỉ có
   * hai phạm vi, nên 'prior' bị kéo về 'current'.
   */
  const datLoc = (p: Partial<BoLoc>) =>
    (mv ? setLocBd : setLocChi)((cu) => {
      const sau = { ...cu, ...p };
      if (mv) return { ...sau, scope: sau.scope === 'prior' ? 'current' : sau.scope };
      return { ...sau, ...normalisePeriodFilter({ scope: sau.scope, status: sau.status }) };
    });

  // ── Toàn trang: ẩn cột khung điện thoại khi đang xem khu này ──────────────
  // Khu này không có bản mobile (chủ chốt: làm sau), nên để khung điện thoại
  // bên cạnh chỉ tổ chiếm chỗ. Tự gắn rồi tự gỡ, không đụng ThanhToan.tsx nên
  // các hạng mục khác giữ nguyên bố cục hai cột mà E2E đang canh.
  useEffect(() => {
    const stage = document.querySelector('.tt-stage');
    stage?.classList.add('cs-full');
    return () => stage?.classList.remove('cs-full');
  }, []);

  const chi = useContractSettlement({ organizationId, buildingIds, period, scope: locChi.scope });
  const bd = useContractMovements({
    organizationId, buildingIds,
    // Biến động lọc theo NGÀY NGHIỆP VỤ và chỉ có hai phạm vi. Kỳ tham chiếu
    // lấy thẳng từ prop nên đổi kỳ chung không để lại tháng cũ trong state.
    period: locBd.scope === 'all' ? null : period,
  });

  const actions = useSettlementActions(chi.rows);

  /**
   * Đọc bảng bút toán tới đâu — `true` đủ, `'partial'` bị RLS giấu bớt, `false`
   * lỗi tải. KHÔNG dùng để đổi trạng thái phiếu; chỉ để GIẢI THÍCH vì sao thiếu
   * ngày chi, và ba lý do đó dẫn tới ba việc khác nhau cho người dùng.
   */
  const docButToan: PostingReadState = chi.postingRead ?? true;

  /** Trạng thái nhìn thấy, tính một lần cho mỗi dòng. */
  const viewOf = useMemo(() => {
    const m = new Map<string, ViewStatus>();
    for (const r of chi.rows) m.set(r.key, viewStatusOf(r));
    return m;
  }, [chi.rows]);

  // ── Nền lọc: mọi thứ TRỪ chip loại và chip trạng thái ─────────────────────
  // Tách ra vì số đếm trên chip phải tính trên nền này; nếu tính trên tập đã
  // lọc theo chính nó thì mọi chip đều hiện đúng số của nó và bằng tổng.
  //
  // `nenTruocKy` = quyền/org/tòa/tìm kiếm/nguồn/người nhận/vướng mắc, CHƯA có kỳ.
  // Giữ riêng vì hai thứ phải đếm trên nó: số tồn kỳ trước (để mời sang phạm vi
  // Tồn Cũ) và số phiếu CHƯA XẾP ĐƯỢC KỲ (để không ai biến mất im lặng).
  const nenTruocKy = useMemo(() => {
    const q = boDau(f.q);
    return chi.rows.filter((r) => {
      if (f.building !== 'all' && r.buildingId !== f.building) return false;
      if (f.origin !== 'all' && r.origin !== f.origin) return false;
      if (f.person !== 'all' && (r.recipientName ?? '') !== f.person) return false;
      if (f.issue === 'yes' && r.issues.length === 0) return false;
      if (q && !boDau([
        r.customerName, r.recipientName, r.roomName, r.buildingName,
        r.contractNumber, r.voucherCode,
      ].join(' ')).includes(q)) return false;
      return true;
    });
  }, [chi.rows, f.building, f.origin, f.person, f.issue, f.q]);

  /** TẬP NỀN CHUNG: thẻ, chip, banner, bảng và chân trang đều bắt đầu từ đây. */
  const nenChi = useMemo(
    () => nenTruocKy.filter((r) => matchScope(r, f.scope, period) === 'in'),
    [nenTruocKy, f.scope, period],
  );

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
  /**
   * Nền của thẻ số: đã lọc loại nhưng CHƯA cắt kỳ — `statValue` tự cắt.
   *
   * ⚠ Đưa tập đã cắt kỳ vào đó là vô hiệu hoá chính điều thẻ phải nói: phiếu đã
   * chi mà không đọc nổi ngày ghi sổ bị phép cắt kỳ loại ra, nên thẻ sẽ thấy
   * một tập "sạch" rồi in 0đ — đúng câu nói dối đang phải sửa.
   */
  const nenThe = useMemo(
    () => nenTruocKy.filter((r) => f.kind === 'all' || r.kind === f.kind),
    [nenTruocKy, f.kind],
  );

  /**
   * Thiếu nguồn để xếp kỳ — phải BÁO RA, không được lặng lẽ rơi khỏi bảng.
   *
   * ⚠ Đếm TRONG trạng thái và loại đang lọc. Đếm trên cả tập nền thì màn hình
   * mặc định của chủ công ty (Cần xử lý · Kỳ hiện tại) sẽ treo suốt ngày câu
   * "Có 1139 khoản chưa xác định kỳ" — đúng sự thật, nhưng nói về một tập không
   * hề nằm trong bộ lọc người ta đang xem. Câu đúng sai ngữ cảnh vẫn là nhiễu.
   */
  const chuaXacDinhKy = useMemo(
    () => (f.scope === 'all'
      ? []
      : nenThe.filter((r) => matchStatus(viewOf.get(r.key) ?? 'unknown', f.status)
        && matchScope(r, f.scope, period) === 'undetermined')),
    [nenThe, viewOf, f.status, f.scope, period],
  );

  const the = useMemo(() => {
    if (mv) return [];
    const nhom = (vs: ViewStatus[]) => doThe.filter((r) => vs.includes(viewOf.get(r.key) ?? 'unknown'));
    const mk = (key: StatusFilter, label: string, vs: ViewStatus[], dot: string,
      needsPosting = false,
      meta?: (rs: SettlementRow[], n: number) => string) => {
      const v = statValue({ rows: nenThe, views: vs, scope: f.scope, period, needsPosting });
      const rs = nhom(vs);
      return {
        key, label, dot, gtri: v,
        so: soThe(v),
        meta: meta && v.kind === 'number' ? meta(rs, cong(rs)) : metaThe(v, docButToan),
      };
    };
    const raSoat = nhom(['review']);
    return [
      {
        key: 'review' as StatusFilter, label: 'Cần rà soát', dot: STATUS_STYLE.review.fg,
        gtri: { kind: 'number', count: raSoat.length, total: cong(raSoat) } as StatValue,
        so: String(raSoat.length), meta: 'hồ sơ cần kiểm tra',
      },
      ...(gop
        ? [mk('pendpay', 'Chờ Duyệt và Chi', ['pending', 'approved'], STATUS_STYLE.pending.fg, false,
            (_rs, n) => `${groupTotal(doThe, ['pending']).count} chờ duyệt · `
              + `${groupTotal(doThe, ['approved']).count} chờ chi · ${fmtMoney(n)}`)]
        : [
            mk('pending', 'Chờ duyệt', ['pending'], STATUS_STYLE.pending.fg),
            mk('approved', 'Chờ chi', ['approved'], STATUS_STYLE.approved.fg),
          ]),
      // ⚠ HAI THẺ RIÊNG. "Đã chi" chỉ cộng phiếu đã ghi sổ THẬT; phiếu ghi trên
      // sổ ảo có thẻ của nó. Gộp chung là nói dối về số tiền đã rời két — và
      // chính chỗ gộp ấy từng làm thẻ hiện 0đ trên một bảng đang có ba dòng.
      mk('paid', 'Đã chi', ['paid'], STATUS_STYLE.paid.fg, true),
      mk('noncash', 'Không ghi quỹ', ['noncash'], STATUS_STYLE.noncash.fg),
    ];
  }, [mv, doThe, nenThe, gop, viewOf, f.scope, period, docButToan]);

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

  // Tồn kỳ trước đếm trên nền TRƯỚC KỲ: đứng ở Kỳ hiện tại vẫn phải biết ngoài
  // kia còn bao nhiêu việc cũ. `isOldPeriodWork` chỉ nhận việc CHƯA XONG — nhãn
  // tồn không bao giờ dán lên một phiếu đã chi/đã huỷ/đã hoàn tác.
  const ton = mv || f.scope === 'prior'
    ? []
    : nenTruocKy.filter((r) => isOldPeriodWork(r, period));

  const dangTai = mv ? bd.isLoading : chi.isLoading;
  const hong = mv ? bd.isError : chi.isError;
  const soDong = mv ? hienBd.length : hienChi.length;
  const tongTien = mv ? 0 : hienChi.reduce((s, r) => s + r.amount, 0);
  /**
   * Tiền ĐÃ RỜI KÉT trong tập đang xem. Sổ ảo và phiếu huỷ không nằm ở đây.
   * Dùng nền TRƯỚC KỲ (đã lọc loại + trạng thái) vì cùng lý do với thẻ số:
   * phiếu đã chi mà chưa xác minh được ngày sẽ rơi khỏi tập đã cắt kỳ, và khi
   * đó "0 đ" là câu sai — phải nói "Chưa đủ dữ liệu".
   */
  const thucChi = useMemo(
    () => statValue({
      rows: nenThe.filter((r) => matchStatus(viewOf.get(r.key) ?? 'unknown', f.status)),
      views: ['paid'], scope: f.scope, period, needsPosting: true,
    }),
    [nenThe, viewOf, f.status, f.scope, period],
  );
  const nhieuTrangThai = useMemo(
    () => new Set(hienChi.map((r) => viewOf.get(r.key) ?? 'unknown')).size > 1,
    [hienChi, viewOf],
  );
  /**
   * Khi nào phải in con số thứ hai.
   *
   * Nhiều trạng thái ⇒ luôn in, kể cả khi bằng 0: đó là cách nói "tiền của sổ
   * ảo/phiếu huỷ trong danh sách này KHÔNG phải tiền đã rời két".
   * Toàn phiếu đã chi và đối chiếu đủ ⇒ hai con số trùng nhau, in lại là thừa.
   * Toàn phiếu đã chi mà còn phiếu chưa xác minh ⇒ PHẢI in, vì lúc đó "tổng giá
   * trị phiếu đang xem" khác hẳn số tiền chứng minh được.
   */
  const coDaChi = useMemo(
    () => hienChi.some((r) => (viewOf.get(r.key) ?? 'unknown') === 'paid'),
    [hienChi, viewOf],
  );
  const hienThucChi = nhieuTrangThai
    || (coDaChi && (thucChi.kind !== 'number' || thucChi.total !== tongTien));
  const coLoc = f.q !== '' || f.building !== 'all' || f.kind !== 'all' || f.origin !== 'all'
    || f.person !== 'all' || f.issue !== 'all' || f.status !== 'open' || f.scope !== 'current';

  const row = dangMo ? chi.rows.find((r) => r.voucherId === dangMo) ?? null : null;
  const bdDangXem: MovementRow | null =
    dangMoBd ? bd.rows.find((e) => e.key === dangMoBd) ?? null : null;

  // Bỏ lọc là về ĐÚNG mặc định, kể cả phạm vi kỳ. Không còn chuỗi tháng nào để
  // sót lại, vì phạm vi là enum và kỳ tham chiếu lấy từ prop.
  const xoaLoc = () => (mv ? setLocBd : setLocChi)({ ...locMacDinh(), advanced: f.advanced });

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
                // kẻo bảng rỗng mà không ai hiểu vì sao. Vẫn đi qua normalizer
                // để phạm vi và trạng thái không bao giờ lệch nhau.
                setLocChi((c) => (['pending', 'approved', 'pendpay'].includes(c.status)
                  ? { ...c, ...normalisePeriodFilter({ scope: c.scope, status: 'open' }) }
                  : c));
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
              <div className="cs-stat-wrap" key={t.key}>
                <button type="button" className={`cs-stat ${on ? 'on' : ''}`}
                  onClick={() => datLoc({ status: on ? 'open' : t.key })}>
                  <div className="cs-stat-lbl"><span className="cs-dot" style={{ background: t.dot }} />{t.label}</div>
                  <div className="cs-stat-num">{t.so}</div>
                  <div className="cs-stat-meta">{t.meta}</div>
                  <span className="cs-stat-cta">{on ? 'Đang lọc' : 'Lọc'}</span>
                </button>
                {/* Thiếu bút toán là thứ THỬ LẠI ĐƯỢC — mạng chập, hoặc vừa
                    được cấp binding giữ sổ, thì lần đọc sau đã có số. Nút nằm
                    NGOÀI thẻ vì lồng button trong button là HTML không hợp lệ. */}
                {t.gtri.kind === 'insufficient' && (
                  <button type="button" className="cs-stat-retry" onClick={() => chi.refetch?.()}>
                    Thử lại
                  </button>
                )}
              </div>
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
            <select className="cs-sel" aria-label="Tòa"
              value={f.building} onChange={(e) => datLoc({ building: e.target.value })}>
              <option value="all">Tất cả tòa</option>
              {toaCo.map(([id, ten]) => <option key={id} value={id}>{ten}</option>)}
            </select>
            {/* Ba phạm vi cho việc chưa xong, hai cho lịch sử. Danh sách option
                đổi THEO trạng thái đang chọn, nên không có phạm vi nào tồn tại
                trong state mà không hiện ra trên màn hình. */}
            <select className="cs-sel" aria-label="Phạm vi kỳ"
              value={f.scope} onChange={(e) => datLoc({ scope: e.target.value as PeriodScope })}>
              {(mv ? (['current', 'all'] as PeriodScope[]) : periodScopeOptions(f.status))
                .map((s) => (
                  <option key={s} value={s}>{periodScopeLabel(s, period)}</option>
                ))}
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
                    {/* 'reversed' và 'unknown' có mặt để KHÔNG GIẤU phiếu nào:
                        phiếu hoàn tác và tổ hợp trạng thái lạ vẫn phải soi được. */}
                    <select aria-label="Trạng thái" value={f.status}
                      onChange={(e) => datLoc({ status: e.target.value as StatusFilter })}>
                      {(['open', 'all', 'review', 'pending', 'approved', 'paid', 'noncash',
                        'reversed', 'cancelled', 'unknown'] as StatusFilter[])
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
                <span style={{ fontFamily: 'var(--mono)' }}>{fmtMoney(cong(ton))}</span>.
                {' '}
                <button type="button" className="cs-linkbtn"
                  onClick={() => datLoc({ scope: 'prior', status: 'open' })}>
                  Xem phạm vi Tồn Cũ
                </button>
              </span>
            </div>
          )}
          {/* Phiếu THIẾU NGUỒN để xếp kỳ không được lặng lẽ rơi khỏi bảng. Hay
              gặp nhất: phiếu đã ghi sổ mà người xem không đọc nổi bút toán nên
              không có ngày chi. Nói ra và mời sang Tất Cả, đừng giấu. */}
          {!mv && chuaXacDinhKy.length > 0 && (
            <div className="cs-notice">
              <span className="cs-tag-ton" style={{ background: 'var(--line-2)', color: 'var(--ink-2)' }}>?</span>
              <span>
                Có <b>{chuaXacDinhKy.length} khoản chưa xác định kỳ</b> — thiếu ngày phiếu hoặc
                chưa đọc được ngày ghi sổ, nên không xếp vào phạm vi nào.{' '}
                <button type="button" className="cs-linkbtn" onClick={() => datLoc({ scope: 'all' })}>
                  Xem ở Tất Cả
                </button>
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
            <span>
              {soDong}
              {mv
                ? ' lượt biến động'
                : ` khoản · ${STATUS_FILTER_LABEL[f.status]} · ${periodScopeLabel(f.scope, period)}`}
            </span>
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
                const cu = isOldPeriodWork(r, period);
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
                        {/* Không đọc được bút toán thì nói thẳng là CHƯA XÁC
                            MINH. In "Chi —" là để người ta tưởng phiếu thiếu
                            ngày, trong khi sự thật là mình không được phép đọc. */}
                        {v === 'paid'
                          ? (r.postedOn ? `Chi ${fmtNgay(r.postedOn)}` : 'Ngày chi chưa xác minh')
                          : v === 'reversed' ? 'Đã ghi sổ rồi hoàn tác'
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
                <span>Khoản chi liên quan</span><span />
              </div>
              {hienBd.map((e) => {
                const lienQuan = chi.rows.filter((r) => r.contractId && r.contractId === e.contractId);
                return (
                  <div className={`cs-row ${dangMoBd === e.key ? 'on' : ''}`} key={e.key}>
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
                    <button type="button" className="cs-go" onClick={() => setDangMoBd(e.key)}>
                      Xem hồ sơ
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {soDong === 0 && (
            <div className="cs-empty">
              {/* KHÔNG suy "mọi việc đã xong". Rỗng chỉ nói về PHẠM VI ĐANG XEM;
                  kết luận rộng hơn thế là câu không có bằng chứng. */}
              <b>
                {mv ? 'Không có biến động nào' : 'Không có khoản nào khớp phạm vi đang xem'}
              </b>
              <p>
                {mv
                  ? 'Đổi phạm vi kỳ hoặc bỏ bớt bộ lọc để xem các sự kiện khác.'
                  : `Đang xem ${STATUS_FILTER_LABEL[f.status]} · ${periodScopeLabel(f.scope, period)}.`
                    + ' Đổi phạm vi kỳ hoặc trạng thái để xem tiếp.'}
              </p>
              {coLoc && <button type="button" onClick={xoaLoc}>Bỏ bộ lọc</button>}
            </div>
          )}

          <div className="cs-foot">
            <span>
              {mv
                ? 'Ngày ký · xác nhận gia hạn · thanh lý · xử lý cọc'
                : f.status === 'paid'
                  ? 'Lọc theo ngày ghi sổ của bút toán hiệu lực'
                  : f.status === 'open' || f.status === 'review' || f.status === 'pending'
                    || f.status === 'approved' || f.status === 'pendpay'
                    ? 'Lọc theo ngày phiếu'
                    : 'Lọc theo ngày phiếu · riêng Đã chi theo ngày ghi sổ'}
            </span>
            {/* Hai con số KHÁC NHAU và phải nói rõ là khác: tổng giá trị phiếu
                đang xem có cả sổ ảo/huỷ, còn thực chi chỉ là tiền đã rời két. */}
            <span>
              {mv ? '' : `Tổng giá trị phiếu đang xem: ${fmtMoney(tongTien)}`}
              {!mv && hienThucChi && ` · Đã chi thực tế: ${
                thucChi.kind === 'insufficient'
                  ? `Chưa đủ dữ liệu (${lyDoChuaXacMinhNgayChi(docButToan)})`
                  : thucChi.kind === 'na' ? 'Không áp dụng cho tồn cũ'
                  // ⚠ Tiền chỉ là phần ĐỐI CHIẾU ĐƯỢC. Phần còn lại đi ra dưới
                  // dạng SỐ ĐẾM — gộp vào rồi treo nhãn là vẫn nói dối về tiền.
                  // Và chứng minh được 0 phiếu thì in "—", KHÔNG in "0 đ": xem
                  // chú thích của `soThe`. "0 đ" ở chân trang chỉ được dùng khi
                  // thật sự có 0 phiếu đã chi (ca sổ ảo/huỷ), lúc đó `thucChi`
                  // là `kind: 'number'` và rơi xuống nhánh cuối.
                  : thucChi.kind === 'unverified'
                    ? `${thucChi.count === 0 ? '—' : fmtMoney(thucChi.total)} · `
                      + `${thucChi.unverifiedCount} phiếu chưa xác minh (không cộng tiền)`
                    : fmtMoney(thucChi.total)
              }`}
            </span>
          </div>
        </section>
      )}

      {bdDangXem && (
        <MovementLifecycleModal
          ev={bdDangXem}
          lienQuan={chi.rows.filter((r) => r.contractId && r.contractId === bdDangXem.contractId)}
          onMoPhieu={(id) => { setDangMoBd(null); setDangMo(id); }}
          onClose={() => setDangMoBd(null)}
        />
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
