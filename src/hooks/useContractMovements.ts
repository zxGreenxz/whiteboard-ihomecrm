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
  roomName: string | null;
  customer: string;
  /** Mã hợp đồng, hoặc mã phiếu giữ chỗ. */
  source: string;
  origin: 'contract' | 'reservation';
  contractId: string | null;
  description: string;
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
  rooms: { name: string | null; building_id: string | null; buildings: { name: string | null } | null } | null;
  contract_customers: KhachNoi[] | null;
}

const HD_NOI =
  'id, contract_number, rooms!inner ( name, building_id, buildings ( name ) ), contract_customers ( customers ( full_name ) )';

const toaCua = (c: HopDongNoi | null) => ({
  buildingId: c?.rooms?.building_id ?? null,
  buildingName: c?.rooms?.buildings?.name ?? '—',
  roomName: c?.rooms?.name ?? null,
});

export interface MovementArgs {
  organizationId: string | null | undefined;
  buildingIds: string[];
  /** 'YYYY-MM', hoặc null để lấy mọi kỳ. */
  period: string | null;
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
}

export function useContractMovements(a: MovementArgs) {
  const bat = !!a.organizationId && a.buildingIds.length > 0;
  const khoang = khoangKy(a.period);

  const q = useQuery({
    queryKey: [
      'contract-settlement', 'movements', a.organizationId,
      [...a.buildingIds].sort(), a.period,
    ],
    enabled: bat,
    staleTime: 60_000,
    queryFn: async (): Promise<MovementRow[]> => {
      const org = a.organizationId!;
      const trongKy = (qb: LocBuilder, cot: string): LocBuilder =>
        (khoang ? qb.gte(cot, khoang[0]).lt(cot, khoang[1]) : qb);

      // ── Ký mới ───────────────────────────────────────────────────────────
      const qKy = trongKy(
        supabase
          .from('contracts')
          .select(`${HD_NOI}, signed_date, start_date, end_date, rent_price, total_deposit`)
          .eq('organization_id', org)
          .in('rooms.building_id', a.buildingIds)
          .is('deleted_at', null)
          .not('signed_date', 'is', null)
          .order('signed_date', { ascending: false })
          .limit(400) as unknown as LocBuilder,
        'signed_date',
      );

      // ── Gia hạn ──────────────────────────────────────────────────────────
      const qGiaHan = trongKy(
        supabase
          .from('contract_extensions')
          // ⚠ PHẢI nêu ĐÍCH DANH khoá ngoại: bảng này có HAI đường sang
          // `contracts` (`contract_id` và `new_contract_id`), PostgREST không tự
          // chọn được và trả "more than one relationship was found".
          .select(`id, extension_date, extension_months, old_end_date, new_end_date, new_rent_price, rent_price_changed, contracts!contract_extensions_contract_id_fkey!inner ( ${HD_NOI} )`)
          .eq('organization_id', org)
          .in('contracts.rooms.building_id', a.buildingIds)
          .order('extension_date', { ascending: false })
          .limit(400) as unknown as LocBuilder,
        'extension_date',
      );

      // ── Thanh lý + Bỏ cọc (cùng một bảng, tách bằng termination_type) ────
      const qKetThuc = trongKy(
        supabase
          .from('contract_terminations')
          .select(`id, termination_date, termination_type, refund_amount, total_deductions, outstanding_debt, actual_move_out_date, contracts!inner ( ${HD_NOI} )`)
          .eq('organization_id', org)
          .in('contracts.rooms.building_id', a.buildingIds)
          .order('termination_date', { ascending: false })
          .limit(400) as unknown as LocBuilder,
        'termination_date',
      );

      // ── Giữ chỗ ──────────────────────────────────────────────────────────
      const qGiuCho = trongKy(
        supabase
          .from('room_reservation_holds')
          .select('id, amount, held_at, expires_at, status, contract_id, building_id, buildings ( name ), rooms ( name )')
          .eq('organization_id', org)
          .in('building_id', a.buildingIds)
          .order('held_at', { ascending: false })
          .limit(200) as unknown as LocBuilder,
        'held_at',
      );

      const [ky, giaHan, ketThuc, giuCho] = await Promise.all([qKy, qGiaHan, qKetThuc, qGiuCho]);

      for (const r of [ky, giaHan, ketThuc, giuCho]) {
        // Fail-closed: một nhánh hỏng mà trả danh sách thiếu thì người dùng
        // tưởng kỳ này ít biến động. Thà báo lỗi.
        if (r.error) throw new Error(r.error.message);
      }

      const out: MovementRow[] = [];

      for (const c of (ky.data ?? []) as (HopDongNoi & {
        signed_date: string | null; start_date: string | null; end_date: string | null;
        rent_price: number | null; total_deposit: number | null;
      })[]) {
        out.push({
          key: `sign:${c.id}`, type: 'sign', date: c.signed_date, ...toaCua(c),
          customer: tenKhach(c.contract_customers),
          source: c.contract_number ?? '—', origin: 'contract', contractId: c.id,
          description: `Thuê từ ${ngay(c.start_date)} đến ${ngay(c.end_date)} · giá ${dong(c.rent_price)}/tháng · cọc ${dong(c.total_deposit)}`,
        });
      }

      for (const e of (giaHan.data ?? []) as {
        id: string; extension_date: string | null; extension_months: number | null;
        old_end_date: string | null; new_end_date: string | null;
        new_rent_price: number | null; rent_price_changed: boolean | null;
        contracts: HopDongNoi | null;
      }[]) {
        const c = e.contracts;
        out.push({
          key: `renew:${e.id}`, type: 'renew', date: e.extension_date, ...toaCua(c),
          customer: tenKhach(c?.contract_customers),
          source: c?.contract_number ?? '—', origin: 'contract', contractId: c?.id ?? null,
          description: `Gia hạn ${e.extension_months ?? '?'} tháng · ${ngay(e.old_end_date)} → ${ngay(e.new_end_date)}`
            + (e.rent_price_changed ? ` · giá mới ${dong(e.new_rent_price)}` : ' · giữ nguyên giá'),
        });
      }

      for (const t of (ketThuc.data ?? []) as {
        id: string; termination_date: string | null; termination_type: string | null;
        refund_amount: number | null; total_deductions: number | null;
        outstanding_debt: number | null; actual_move_out_date: string | null;
        contracts: HopDongNoi | null;
      }[]) {
        const c = t.contracts;
        const boCoc = t.termination_type === 'FORFEIT';
        out.push({
          key: `${boCoc ? 'forfeit' : 'terminate'}:${t.id}`,
          type: boCoc ? 'forfeit' : 'terminate',
          date: t.termination_date, ...toaCua(c),
          customer: tenKhach(c?.contract_customers),
          source: c?.contract_number ?? '—', origin: 'contract', contractId: c?.id ?? null,
          description: `Trả phòng ${ngay(t.actual_move_out_date)} · khấu trừ ${dong(t.total_deductions)}`
            + ` · hoàn ${dong(t.refund_amount)}`
            + (Number(t.outstanding_debt) > 0 ? ` · còn nợ ${dong(t.outstanding_debt)}` : ''),
        });
      }

      for (const h of (giuCho.data ?? []) as {
        id: string; amount: number | null; held_at: string | null; expires_at: string | null;
        status: string | null; contract_id: string | null; building_id: string | null;
        buildings: { name: string | null } | null; rooms: { name: string | null } | null;
      }[]) {
        out.push({
          key: `reserve:${h.id}`, type: 'reserve', date: h.held_at,
          buildingId: h.building_id, buildingName: h.buildings?.name ?? '—',
          roomName: h.rooms?.name ?? null,
          customer: 'Khách giữ chỗ', source: `GC-${h.id.slice(0, 8)}`,
          origin: 'reservation', contractId: h.contract_id,
          description: `Cọc giữ chỗ ${dong(h.amount)} · hạn ${ngay(h.expires_at)} · ${h.status ?? '—'}`,
        });
      }

      // Một danh sách duy nhất, mới nhất trước — bảng chỉ có một cột ngày.
      return out.sort((x, y) => (y.date ?? '').localeCompare(x.date ?? ''));
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
