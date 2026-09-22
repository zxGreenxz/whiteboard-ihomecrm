// =============================================================================
// useContractMovements — nguồn dữ liệu tab "Biến động".
//
// Đây là BÁO CÁO THUẦN ĐỌC. Không hàm ghi nào ở đây, và tab Biến động không có
// nút thao tác nào ngoài "Xem hồ sơ". Mọi việc duyệt/chi vẫn nằm ở tab Khoản
// chi và vẫn gọi đúng hàm của Thu chi.
//
// Năm loại biến động, lấy từ BỐN bảng thật (đo production 21/09/2026):
//   Ký mới   ← contracts.signed_date          134 hợp đồng ký trong 90 ngày
//   Gia hạn  ← contract_extensions            109 dòng, đều UPDATE_EXISTING
//   Thanh lý ← contract_terminations NORMAL    77 dòng
//   Bỏ cọc   ← contract_terminations FORFEIT   37 dòng
//   Giữ chỗ  ← room_reservation_holds           3 dòng
//
// ⚠ `contracts` KHÔNG có `building_id` — tòa nhà đi vòng qua `rooms.building_id`,
// nên phải dùng `rooms!inner` thì bộ lọc tòa mới cắt được dòng cha. Tên khách
// cũng không nằm trong `contracts`: phải qua bảng nối `contract_customers`.
// =============================================================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';
import { isEffectiveTermination } from '@/lib/contractLifecycle';

export type MovementType = 'sign' | 'renew' | 'terminate' | 'forfeit' | 'reserve';

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  sign: 'Ký mới',
  renew: 'Gia hạn',
  terminate: 'Thanh lý',
  forfeit: 'Bỏ cọc',
  reserve: 'Giữ chỗ',
};

export interface MovementRow {
  key: string;
  type: MovementType;
  /** Ngày phát sinh NGHIỆP VỤ, không phải created_at. */
  date: string | null;
  buildingId: string | null;
  buildingName: string;
  /**
   * Phòng của biến động. BẮT BUỘC để dựng dải vòng đời: lịch sử cư trú đi theo
   * PHÒNG, không theo cây hợp đồng (`parent_contract_id` gần như trống trên
   * production). Thiếu nó thì modal biến động không dựng nổi chuỗi lane.
   */
  roomId: string | null;
  roomName: string | null;
  /** Công ty của biến động — mọi truy vấn phía sau phải kẹp theo nó. */
  organizationId: string;
  customer: string;
  /** Mã hợp đồng, hoặc mã phiếu giữ chỗ. */
  source: string;
  origin: 'contract' | 'reservation';
  contractId: string | null;
  description: string;
  /** Người tạo hợp đồng / bản ghi. Null khi không tra được tên. */
  staffName: string | null;
}

const dong = (n: unknown) => `${new Intl.NumberFormat('vi-VN').format(Math.round(Number(n) || 0))} đ`;
const ngay = (s: string | null | undefined) =>
  s ? s.slice(0, 10).split('-').reverse().join('/') : '—';

interface KhachNoi { customers: { full_name: string | null } | null }
const tenKhach = (ds: KhachNoi[] | null | undefined): string => {
  const t = ds?.find((x) => x.customers?.full_name)?.customers?.full_name;
  return (t ?? '').trim() || 'Chưa có tên khách';
};

interface HopDongNoi {
  id: string;
  contract_number: string | null;
  user_id: string | null;
  rooms: { id: string | null; name: string | null; building_id: string | null; buildings: { name: string | null } | null } | null;
  contract_customers: KhachNoi[] | null;
}

const HD_NOI =
  'id, contract_number, user_id, rooms!inner ( id, name, building_id, buildings ( name ) ), contract_customers ( customers ( full_name ) )';

const toaCua = (c: HopDongNoi | null) => ({
  buildingId: c?.rooms?.building_id ?? null,
  buildingName: c?.rooms?.buildings?.name ?? '—',
  roomId: c?.rooms?.id ?? null,
  roomName: c?.rooms?.name ?? null,
});

export interface MovementArgs {
  organizationId: string | null | undefined;
  buildingIds: string[];
  /** 'YYYY-MM', hoặc null để lấy mọi kỳ. */
  period: string | null;
  /** Caller chỉ tải tab đang mở; mặc định true để giữ hành vi caller cũ. */
  enabled?: boolean;
}

/**
 * Khoảng ngày của một kỳ, dạng nửa mở [đầu, đầu tháng sau).
 * Dùng chuỗi chứ không dùng Date để khỏi dính lệch múi giờ — cùng cách các
 * truy vấn khác trong kho này làm.
 */
const khoangKy = (period: string | null): [string, string] | null => {
  if (!period) return null;
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return null;
  const sau = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return [`${period}-01`, sau];
};

/**
 * Bề mặt TỐI THIỂU của builder PostgREST mà hàm dưới đây dùng tới.
 *
 * Vì sao không dùng kiểu sinh sẵn: `.gte/.lt` được chắp thêm SAU khi đã gọi
 * `.select(...)` với chuỗi embed lồng hai tầng, nên kiểu suy ra dài tới mức
 * `tsc` bỏ cuộc. Khai đúng bốn thứ cần dùng thì vừa gọn vừa không mất an toàn ở
 * chỗ thật sự quan trọng là hình dạng `data` (ép ngay tại nơi đọc).
 */
interface KetQua { data: unknown[] | null; error: { message: string } | null }
interface LocBuilder extends PromiseLike<KetQua> {
  gte(cot: string, v: string): LocBuilder;
  lt(cot: string, v: string): LocBuilder;
  range(from: number, to: number): LocBuilder;
}

export function useContractMovements(a: MovementArgs) {
  const bat = (a.enabled ?? true) && !!a.organizationId && a.buildingIds.length > 0;
  const khoang = khoangKy(a.period);

  const q = useQuery({
    queryKey: [
      'contract-settlement', 'movements', a.organizationId,
      [...a.buildingIds].sort(), a.period,
    ],
    enabled: bat,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<MovementRow[]> => {
      const org = a.organizationId!;
      const trongKy = (qb: LocBuilder, cot: string): LocBuilder =>
        (khoang ? qb.gte(cot, khoang[0]).lt(cot, khoang[1]) : qb);

      // ── Ký mới ───────────────────────────────────────────────────────────
      const qKy = fetchAllRows<unknown>((from, to) => trongKy(
        supabase
          .from('contracts')
          .select(`${HD_NOI}, signed_date, start_date, end_date, rent_price, total_deposit`)
          .eq('organization_id', org)
          .in('rooms.building_id', a.buildingIds)
          .is('deleted_at', null)
          .not('signed_date', 'is', null)
          .order('signed_date', { ascending: false })
          .order('id', { ascending: false }) as unknown as LocBuilder,
        'signed_date',
      ).range(from, to), { label: 'movements.sign' });

      // ── Gia hạn ──────────────────────────────────────────────────────────
      const qGiaHan = fetchAllRows<unknown>((from, to) => trongKy(
        supabase
          .from('contract_extensions')
          // ⚠ PHẢI nêu ĐÍCH DANH khoá ngoại: bảng này có HAI đường sang
          // `contracts` (`contract_id` và `new_contract_id`), PostgREST không tự
          // chọn được và trả "more than one relationship was found".
          .select(`id, extension_date, extension_months, old_end_date, new_end_date, new_rent_price, rent_price_changed, contracts!contract_extensions_contract_id_fkey!inner ( ${HD_NOI} )`)
          .eq('organization_id', org)
          .in('contracts.rooms.building_id', a.buildingIds)
          .order('extension_date', { ascending: false })
          .order('id', { ascending: false }) as unknown as LocBuilder,
        'extension_date',
      ).range(from, to), { label: 'movements.renew' });

      // ── Thanh lý + Bỏ cọc (cùng một bảng, tách bằng termination_type) ────
      const qKetThuc = fetchAllRows<unknown>((from, to) => trongKy(
        supabase
          .from('contract_terminations')
          .select(`id, status, termination_date, termination_type, refund_amount, total_deductions, outstanding_debt, actual_move_out_date, contracts!inner ( ${HD_NOI} )`)
          .eq('organization_id', org)
          .in('contracts.rooms.building_id', a.buildingIds)
          .in('status', ['APPROVED', 'COMPLETED'])
          .order('termination_date', { ascending: false })
          .order('id', { ascending: false }) as unknown as LocBuilder,
        'termination_date',
      ).range(from, to), { label: 'movements.terminate' });

      // ── Giữ chỗ ──────────────────────────────────────────────────────────
      const qGiuCho = fetchAllRows<unknown>((from, to) => trongKy(
        supabase
          .from('room_reservation_holds')
          .select('id, amount, held_at, expires_at, status, contract_id, building_id, room_id, buildings ( name ), rooms ( name )')
          .eq('organization_id', org)
          .in('building_id', a.buildingIds)
          .order('held_at', { ascending: false })
          .order('id', { ascending: false }) as unknown as LocBuilder,
        'held_at',
      ).range(from, to), { label: 'movements.reserve' });

      const [ky, giaHan, ketThuc, giuCho] = await Promise.all([qKy, qGiaHan, qKetThuc, qGiuCho]);

      for (const r of [ky, giaHan, ketThuc, giuCho]) {
        // Fail-closed: một nhánh hỏng mà trả danh sách thiếu thì người dùng
        // tưởng kỳ này ít biến động. Thà báo lỗi.
        if (r === null) throw new Error('Không đọc đủ biến động hợp đồng — thử lại.');
      }

      const out: MovementRow[] = [];
      /** Ghép dòng với user_id của nó, để tra tên một lượt ở cuối. */
      const hoSo: { row: MovementRow; userId: string | null }[] = [];
      const them = (row: MovementRow, userId: string | null) => {
        out.push(row);
        hoSo.push({ row, userId });
      };

      for (const c of ky as (HopDongNoi & {
        signed_date: string | null; start_date: string | null; end_date: string | null;
        rent_price: number | null; total_deposit: number | null;
      })[]) {
        them({
          key: `sign:${c.id}`, type: 'sign', date: c.signed_date, ...toaCua(c),
          customer: tenKhach(c.contract_customers), organizationId: org,
          source: c.contract_number ?? '—', origin: 'contract', contractId: c.id,
          description: `Thuê từ ${ngay(c.start_date)} đến ${ngay(c.end_date)} · giá ${dong(c.rent_price)}/tháng · cọc ${dong(c.total_deposit)}`,
          staffName: null,
        }, c.user_id);
      }

      for (const e of giaHan as {
        id: string; extension_date: string | null; extension_months: number | null;
        old_end_date: string | null; new_end_date: string | null;
        new_rent_price: number | null; rent_price_changed: boolean | null;
        contracts: HopDongNoi | null;
      }[]) {
        const c = e.contracts;
        them({
          key: `renew:${e.id}`, type: 'renew', date: e.extension_date, ...toaCua(c),
          customer: tenKhach(c?.contract_customers), organizationId: org,
          source: c?.contract_number ?? '—', origin: 'contract', contractId: c?.id ?? null,
          description: `Gia hạn ${e.extension_months ?? '?'} tháng · ${ngay(e.old_end_date)} → ${ngay(e.new_end_date)}`
            + (e.rent_price_changed ? ` · giá mới ${dong(e.new_rent_price)}` : ' · giữ nguyên giá'),
          staffName: null,
        }, c?.user_id ?? null);
      }

      for (const t of ketThuc as {
        id: string; status: string | null; termination_date: string | null; termination_type: string | null;
        refund_amount: number | null; total_deductions: number | null;
        outstanding_debt: number | null; actual_move_out_date: string | null;
        contracts: HopDongNoi | null;
      }[]) {
        if (!isEffectiveTermination(t.status)) continue;
        const c = t.contracts;
        const boCoc = t.termination_type === 'FORFEIT';
        them({
          key: `${boCoc ? 'forfeit' : 'terminate'}:${t.id}`,
          type: boCoc ? 'forfeit' : 'terminate',
          date: t.termination_date, ...toaCua(c),
          customer: tenKhach(c?.contract_customers), organizationId: org,
          source: c?.contract_number ?? '—', origin: 'contract', contractId: c?.id ?? null,
          description: `Trả phòng ${ngay(t.actual_move_out_date)} · khấu trừ ${dong(t.total_deductions)}`
            + ` · hoàn ${dong(t.refund_amount)}`
            + (Number(t.outstanding_debt) > 0 ? ` · Công nợ đưa vào quyết toán ${dong(t.outstanding_debt)}` : ''),
          staffName: null,
        }, c?.user_id ?? null);
      }

      for (const h of giuCho as {
        id: string; amount: number | null; held_at: string | null; expires_at: string | null;
        status: string | null; contract_id: string | null; building_id: string | null;
        room_id: string | null;
        buildings: { name: string | null } | null; rooms: { name: string | null } | null;
      }[]) {
        them({
          key: `reserve:${h.id}`, type: 'reserve', date: h.held_at,
          buildingId: h.building_id, buildingName: h.buildings?.name ?? '—',
          roomId: h.room_id, roomName: h.rooms?.name ?? null, organizationId: org,
          customer: 'Khách giữ chỗ', source: `GC-${h.id.slice(0, 8)}`,
          origin: 'reservation', contractId: h.contract_id,
          description: `Cọc giữ chỗ ${dong(h.amount)} · hạn ${ngay(h.expires_at)} · ${h.status ?? '—'}`,
          staffName: null,
        }, null);
      }

      // ── Tên người phụ trách ─────────────────────────────────────────────
      // Tra RIÊNG bằng một lượt `in(...)` thay vì embed: `contracts.user_id`
      // trỏ sang `auth.users`, không có khoá ngoại tới `public.profiles` nên
      // PostgREST không embed được. Lỗi tra tên KHÔNG làm hỏng cả bảng — tên
      // chỉ là thông tin phụ, thiếu thì để trống.
      const uid = [...new Set(hoSo.map((h) => h.userId).filter((x): x is string => !!x))];
      if (uid.length > 0) {
        const { data: ten } = await supabase
          .from('profiles').select('id, full_name').in('id', uid);
        const bang = new Map(
          ((ten ?? []) as { id: string; full_name: string | null }[])
            .map((p) => [p.id, (p.full_name ?? '').trim() || null]),
        );
        for (const h of hoSo) h.row.staffName = h.userId ? bang.get(h.userId) ?? null : null;
      }

      // Một danh sách duy nhất, mới nhất trước — bảng chỉ có một cột ngày.
      return out.sort((x, y) => (y.date ?? '').localeCompare(x.date ?? '') || x.key.localeCompare(y.key));
    },
  });

  return useMemo(
    () => ({
      rows: q.data ?? [],
      isLoading: bat && q.isLoading,
      isError: q.isError,
      error: q.error,
      refetch: q.refetch,
    }),
    [q.data, q.isLoading, q.isError, q.error, q.refetch, bat],
  );
}
