// =============================================================================
// useContractLifecycle — lớp ĐỌC của dải "Vòng đời hợp đồng của phòng".
//
// Hook này CHỈ làm I/O. Mọi quyết định (chuẩn hoá, cộng tổng, chọn lane, đóng
// đoạn, chẩn đoán) nằm ở `src/lib/contractLifecycle.ts` và kiểm được bằng unit
// test. Ở đây không có công thức tiền nào.
//
// ── VÌ SAO KHÔNG CÒN ĐỌC `contracts.deposit_paid` ──────────────────────────
// `deposit_paid` là SỐ RÒNG SAU CẤN, không phải tiền khách từng nộp. Ca thật
// 401/32PVC: nộp 4.500.000 (PT2607068), cấn 1.424.000 ⇒ `deposit_paid` còn
// 3.076.000, và màn hình cũ tuyên bố "còn thiếu 1.424.000đ". Từ đây mốc cọc
// dựng từ CHÍNH CÁC PHIẾU CỌC, có mã phiếu và ngày thu chứng minh.
//
// ── CHỈ ĐỌC ────────────────────────────────────────────────────────────────
// Không hàm ghi nào. Không tính lại `deposit_paid`. Không đụng số tiền phiếu.
//
// ── BA THỨ KHÔNG ĐƯỢC LÀM (ràng buộc nguồn của plan) ───────────────────────
//   · KHÔNG gọi `read_contract_settlement_*` — migration `20260921085952` đã
//     xoá, không còn trong kiểu sinh sẵn.
//   · KHÔNG lấy `DEPOSIT_RECEIVED.amount` của `get_room_cash_lifecycle_v1` làm
//     cọc gross — reader đó có đường lấy cả `voucher.total_amount`, tức cộng
//     dư phần không phải cọc của phiếu hỗn hợp.
//   · KHÔNG gọi `app_private.contract_deposit_sources_v1` — hàm private, đã
//     REVOKE khỏi `authenticated`. Luật của nó được CHÉP sang lib thuần.
//
// ── ĐỌC QUA RLS CÓ THỂ CHỈ THẤY MỘT PHẦN ───────────────────────────────────
// Mỗi nguồn có trạng thái riêng (`reads`). Nguồn nào không chứng minh được thì
// phần đó ghi "Chưa đủ dữ liệu" — KHÔNG hiện số 0, KHÔNG kết luận phòng trống,
// và KHÔNG đi tìm đường quyền cao hơn để bù.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';
import {
  buildDepositSources, buildLifecycleLanes, parseResidenceSegments, reconcilePostings,
  summariseDeposit, sumEffectiveInvoices,
  type DepositFigures, type DepositReach, type DepositItemRow, type DepositVoucherRow,
  type InvoiceRow, type InvoiceTotals, type LaneSubject, type LifecycleContractRow,
  type LifecycleReads, type LifecycleView, type PostingRow, type PostingSubject,
  type ResidenceSegmentRow, type TerminationRow,
} from '@/lib/contractLifecycle';

export type {
  LaneSubject, LaneVoucherKind, LifecycleView, Lane, RoomState,
} from '@/lib/contractLifecycle';

export interface ContractLifecycleArgs {
  organizationId: string | null | undefined;
  roomId: string | null | undefined;
  targetContractId: string | null | undefined;
  /** Loại phiếu đang mở, hoặc modal biến động. Quyết định NHÃN VAI của lane đích. */
  subject: LaneSubject;
  /** Mốc ngày NGHIỆP VỤ ('YYYY-MM-DD'). Không lấy đồng hồ trong hook. */
  businessDate: string;
}

/**
 * Bề mặt TỐI THIỂU của builder PostgREST mà file này dùng. Khai tay thay vì
 * `any`: sai tên phương thức hay quên `.range` vẫn bị bắt lúc biên dịch, mà
 * không phải gánh kiểu suy ra khổng lồ của select lồng nhiều tầng.
 */
interface LocBuilder {
  eq(col: string, v: unknown): LocBuilder;
  in(col: string, v: readonly unknown[]): LocBuilder;
  is(col: string, v: null): LocBuilder;
  or(filter: string): LocBuilder;
  order(col: string, o: { ascending: boolean }): LocBuilder;
  /** Mắt xích cuối: builder thật LÀ thenable, khai đúng để khỏi phải ép `any`. */
  range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
}

const HD_COT = [
  'id', 'organization_id', 'contract_number', 'room_id', 'status',
  'signed_date', 'start_date', 'end_date', 'actual_end_date',
  'total_deposit', 'rent_price',
  // Tên khách KHÔNG nằm trong `contracts` — phải qua bảng nối.
  'contract_customers ( customers ( full_name ) )',
].join(', ');

const PHIEU_COT = [
  'id', 'code', 'organization_id', 'type', 'approval_status', 'posting_status',
  'posting_mode', 'deleted_at', 'reversal_of_income_expense_id', 'account_id',
  'system_source', 'voucher_date', 'created_at',
].join(', ');

/** Lỗi đọc một nguồn PHỤ: ghi lại trạng thái, không làm sập cả dải. */
const hong = (reason: string) => ({ ok: false as const, reason });

export function useContractLifecycle(a: ContractLifecycleArgs) {
  const enabled = !!a.organizationId && !!a.targetContractId;

  return useQuery({
    queryKey: [
      'contract-settlement', 'lifecycle', a.organizationId, a.roomId,
      a.targetContractId,
      a.subject.kind === 'voucher' ? `voucher:${a.subject.voucherKind}` : 'movement',
      a.businessDate,
    ],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<LifecycleView> => {
      const org = a.organizationId!;
      const target = a.targetContractId!;
      const roomId = a.roomId ?? null;

      const reads: LifecycleReads = {
        contracts: { ok: true }, segments: { ok: true }, transfers: { ok: true },
        deposits: { ok: true }, invoices: { ok: true }, postings: { ok: true },
      };

      // ── 1. Hợp đồng ứng viên, LỌC QUA RLS theo org + phòng ───────────────
      // Phòng là trục, không phải cây hợp đồng: production không có liên kết
      // cha-con nào đáng tin (`parent_contract_id` 0/366, đo 27/08/2026).
      let idsQuaTransfer: string[] = [];
      if (roomId) {
        const tr = await fetchAllRows<{ contract_id: string | null }>(
          (f, t) => (supabase
            .from('contract_transfers')
            .select('id, contract_id, old_room_id, new_room_id, status') as unknown as LocBuilder)
            .eq('organization_id', org)
            .in('status', ['COMPLETED', 'APPROVED'])
            .or(`old_room_id.eq.${roomId},new_room_id.eq.${roomId}`)
            .order('id', { ascending: true })
            .range(f, t),
          { label: 'lifecycle.transfers' },
        );
        if (tr === null) {
          reads.transfers = hong('Không đọc được lịch sử chuyển phòng');
        } else {
          idsQuaTransfer = [...new Set(tr.map((x) => x.contract_id).filter((x): x is string => !!x))];
        }
      } else {
        // Không có phòng thì không có lịch sử phòng để dựng. Nói thẳng, đừng
        // vẽ một chuỗi chỉ gồm hợp đồng đích rồi để người đọc tưởng là đủ.
        reads.contracts = hong('Phiếu chưa gắn phòng nên không dựng được lịch sử phòng');
      }

      const theoPhong = roomId
        ? await fetchAllRows<LifecycleContractRow>(
            (f, t) => (supabase.from('contracts').select(HD_COT) as unknown as LocBuilder)
              .eq('organization_id', org)
              .eq('room_id', roomId)
              .is('deleted_at', null)
              .order('start_date', { ascending: true })
              .order('id', { ascending: true })
              .range(f, t),
            { label: 'lifecycle.contracts-room' },
          )
        : [];
      if (theoPhong === null) throw new Error('Không đọc được hợp đồng của phòng — thử lại.');

      const daCo = new Set(theoPhong.map((c) => c.id));
      const conThieu = [...new Set([target, ...idsQuaTransfer])].filter((id) => !daCo.has(id));
      const theoId = conThieu.length > 0
        ? await fetchAllRows<LifecycleContractRow>(
            (f, t) => (supabase.from('contracts').select(HD_COT) as unknown as LocBuilder)
              .eq('organization_id', org)
              .in('id', conThieu)
              .is('deleted_at', null)
              .order('start_date', { ascending: true })
              .order('id', { ascending: true })
              .range(f, t),
            { label: 'lifecycle.contracts-ids' },
          )
        : [];
      if (theoId === null) throw new Error('Không đọc được hợp đồng liên quan — thử lại.');

      const contracts = [...theoPhong, ...theoId];
      const hdIds = [...new Set(contracts.map((c) => c.id))];

      // ── 2. Thứ tự cư trú: projection dùng chung, gated theo toà ─────────
      // Truyền ĐÚNG các ID đã đọc được qua RLS. Gọi mở (NULL) rồi coi kết quả
      // là toàn bộ sự thật là sai — RPC vẫn lọc theo quyền, nên "không thấy"
      // không có nghĩa là "không có".
      let segments: ResidenceSegmentRow[] = [];
      if (hdIds.length > 0) {
        const { data, error } = await supabase.rpc('get_room_residence_segments_v1', {
          p_contract_ids: hdIds,
        });
        if (error) {
          reads.segments = hong(`Không đọc được lịch sử cư trú: ${error.message}`);
        } else {
          // Biên kiểm tra: `rpc` trả `Json`, ép thẳng là nhận một lời hứa chưa
          // ai kiểm. Dòng sai hình dạng bị loại VÀ đếm — thứ tự lane dựng trên
          // dữ liệu thiếu thì phải báo thiếu, không được vẽ như đã đủ.
          const ps = parseResidenceSegments(data);
          segments = ps.rows;
          if (ps.rejected > 0) {
            reads.segments = hong(
              `Lịch sử cư trú có ${ps.rejected} dòng sai hình dạng — thứ tự hợp đồng chưa chắc đúng`,
            );
          }
        }
      }

      // ── 3. Thanh lý, nguồn cọc, hoá đơn ─────────────────────────────────
      const [ketThuc, links, truc, hoaDon] = await Promise.all([
        hdIds.length ? fetchAllRows<TerminationRow>(
          (f, t) => (supabase.from('contract_terminations').select(
            'id, contract_id, organization_id, termination_date, termination_type, refund_amount, outstanding_debt, total_deposit',
          ) as unknown as LocBuilder)
            .eq('organization_id', org)
            .in('contract_id', hdIds)
            .order('termination_date', { ascending: true })
            .order('id', { ascending: true })
            .range(f, t),
          { label: 'lifecycle.terminations' },
        ) : Promise.resolve([] as TerminationRow[]),

        hdIds.length ? fetchAllRows<{ contract_id: string; income_expense_id: string }>(
          (f, t) => (supabase.from('contract_deposit_links')
            .select('id, contract_id, income_expense_id, organization_id') as unknown as LocBuilder)
            .eq('organization_id', org)
            .in('contract_id', hdIds)
            .order('contract_id', { ascending: true })
            .order('id', { ascending: true })
            .range(f, t),
          { label: 'lifecycle.deposit-links' },
        ) : Promise.resolve([] as { contract_id: string; income_expense_id: string }[]),

        hdIds.length ? fetchAllRows<DepositVoucherRow & { contract_id: string | null }>(
          (f, t) => (supabase.from('income_expenses')
            .select(`${PHIEU_COT}, contract_id`) as unknown as LocBuilder)
            .eq('organization_id', org)
            .in('contract_id', hdIds)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(f, t),
          { label: 'lifecycle.deposit-direct' },
        ) : Promise.resolve([] as (DepositVoucherRow & { contract_id: string | null })[]),

        hdIds.length ? fetchAllRows<InvoiceRow>(
          (f, t) => (supabase.from('invoices').select(
            'id, contract_id, organization_id, status, deleted_at, paid_amount, total_amount, remaining_amount',
          ) as unknown as LocBuilder)
            .eq('organization_id', org)
            .in('contract_id', hdIds)
            .is('deleted_at', null)
            .order('contract_id', { ascending: true })
            .order('id', { ascending: true })
            .range(f, t),
          { label: 'lifecycle.invoices' },
        ) : Promise.resolve([] as InvoiceRow[]),
      ]);

      // Thanh lý quyết định nhãn "Đã thanh lý" và cả mốc 4. Đọc hỏng mà vẫn vẽ
      // thì một hợp đồng đã thanh lý có thể đội lốt "HĐ hiện tại" — fail-closed.
      if (ketThuc === null) throw new Error('Không đọc được bản ghi thanh lý — thử lại.');
      if (hoaDon === null) reads.invoices = hong('Không đọc được hoá đơn của hợp đồng');

      // ── 4. Nguồn cọc: union trực tiếp + liên kết, khử trùng ─────────────
      let depositByContract = new Map<string, DepositFigures>();
      // Không đọc nổi nguồn cọc thì cũng KHÔNG có gì để đối chiếu bút toán —
      // nói đúng như vậy thay vì để ô đối chiếu trông như đã khớp.
      const chuaDoiChieu = () => {
        reads.postings = hong('Chưa đối chiếu được bút toán vì không đọc được nguồn cọc');
      };

      if (links === null || truc === null) {
        reads.deposits = hong('Không đọc được nguồn cọc của hợp đồng');
        chuaDoiChieu();
      } else {
        const idLienKet = [...new Set(links.map((l) => l.income_expense_id).filter(Boolean))];
        const chuaCo = idLienKet.filter((id) => !truc.some((v) => v.id === id));
        const lienKet = chuaCo.length > 0
          ? await fetchAllRows<DepositVoucherRow>(
              (f, t) => (supabase.from('income_expenses').select(PHIEU_COT) as unknown as LocBuilder)
                .eq('organization_id', org)
                .in('id', chuaCo)
                .order('created_at', { ascending: true })
                .order('id', { ascending: true })
                .range(f, t),
              { label: 'lifecycle.deposit-linked' },
            )
          : [];

        if (lienKet === null) {
          reads.deposits = hong('Không đọc được phiếu cọc liên kết');
          chuaDoiChieu();
        } else {
          const vouchers: DepositVoucherRow[] = [...truc, ...lienKet];
          const voucherIds = [...new Set(vouchers.map((v) => v.id))];

          const [items, soQuy] = await Promise.all([
            voucherIds.length ? fetchAllRows<DepositItemRow>(
              (f, t) => (supabase.from('income_expense_items').select(
                'id, income_expense_id, organization_id, accounting_class, amount, unit_price, quantity',
              ) as unknown as LocBuilder)
                .eq('organization_id', org)
                .eq('accounting_class', 'DEPOSIT')
                .in('income_expense_id', voucherIds)
                // Một phiếu nhiều item ⇒ `income_expense_id` KHÔNG duy nhất;
                // thiếu tiebreaker `id` là phân trang sót/trùng ở ranh giới.
                .order('income_expense_id', { ascending: true })
                .order('id', { ascending: true })
                .range(f, t),
              { label: 'lifecycle.deposit-items' },
            ) : Promise.resolve([] as DepositItemRow[]),

            (() => {
              const ids = [...new Set(vouchers.map((v) => v.account_id).filter((x): x is string => !!x))];
              return ids.length ? fetchAllRows<{ id: string; is_virtual: boolean | null }>(
                (f, t) => (supabase.from('accounts')
                  .select('id, organization_id, is_virtual') as unknown as LocBuilder)
                  .eq('organization_id', org)
                  .in('id', ids)
                  .order('id', { ascending: true })
                  .range(f, t),
                { label: 'lifecycle.accounts' },
              ) : Promise.resolve([] as { id: string; is_virtual: boolean | null }[]);
            })(),
          ]);

          if (items === null || soQuy === null) {
            reads.deposits = hong('Không đọc được hạng mục cọc của phiếu');
            chuaDoiChieu();
          } else {
            // ── 5. Đối chiếu bút toán. Đa số người dùng KHÔNG đọc được bảng
            // này (policy đòi binding CUSTODIAN trên đúng sổ) — nên đọc rỗng
            // và đọc hỏng đều ra "chưa xác minh", không ra số 0.
            const postings = voucherIds.length ? await fetchAllRows<PostingRow>(
              (f, t) => (supabase.from('income_expense_postings').select(
                'id, organization_id, posting_subject_kind, posting_subject_id, event_kind, posting_generation, reversal_of_id, source_kind, legacy_provenance, account_id',
              ) as unknown as LocBuilder)
                .eq('organization_id', org)
                .eq('posting_subject_kind', 'VOUCHER')
                .in('posting_subject_id', voucherIds)
                .order('posting_subject_id', { ascending: true })
                .order('id', { ascending: true })
                .range(f, t),
              { label: 'lifecycle.postings' },
            ) : [];
            if (postings === null) {
              reads.postings = hong('Không đọc được bút toán để đối chiếu — cần quyền giữ sổ quỹ');
            }

            const chuThe: PostingSubject[] = vouchers.map((v) => ({
              id: v.id, postingStatus: v.posting_status, postingMode: v.posting_mode,
            }));
            const xacMinh = reconcilePostings(chuThe, postings ?? [], {
              readable: postings !== null,
              reason: postings === null
                ? 'Không đủ quyền đọc bút toán để đối chiếu'
                : undefined,
            });

            const reaches: DepositReach[] = [
              ...truc
                .filter((v) => !!v.contract_id)
                .map((v) => ({ contractId: v.contract_id!, voucherId: v.id, via: 'direct' as const })),
              ...links.map((l) => ({
                contractId: l.contract_id, voucherId: l.income_expense_id, via: 'link' as const,
              })),
            ];

            const nguon = buildDepositSources({
              organizationId: org,
              reaches,
              vouchers,
              items,
              virtualAccountIds: soQuy.filter((s) => s.is_virtual).map((s) => s.id),
            });

            depositByContract = new Map<string, DepositFigures>(
              // Mọi hợp đồng trong chuỗi đều phải có MỘT mục — kể cả khi không
              // có nguồn nào. Thiếu mục nghĩa là "chưa đọc", khác hẳn "bằng 0".
              hdIds.map((id) => [id, summariseDeposit(nguon.get(id) ?? [], xacMinh)]),
            );
          }
        }
      }

      // Cộng MỘT LƯỢT rồi tra — gọi `sumEffectiveInvoices` trong vòng lặp là
      // quét lại cả mảng hoá đơn cho từng hợp đồng.
      const tongHoaDon = hoaDon === null ? null : sumEffectiveInvoices(hoaDon, org);
      const invoiceByContract: Map<string, InvoiceTotals> = tongHoaDon === null
        ? new Map()
        // Mọi hợp đồng trong chuỗi có MỘT mục: thiếu mục = "chưa đọc", khác "0".
        : new Map(hdIds.map((id) => [id, tongHoaDon.get(id) ?? { paid: 0, debt: 0 }]));

      return buildLifecycleLanes({
        organizationId: org,
        roomId,
        targetContractId: target,
        subject: a.subject,
        businessDate: a.businessDate,
        contracts,
        segments,
        terminations: ketThuc,
        depositByContract,
        invoiceByContract,
        reads,
      });
    },
  });
}
