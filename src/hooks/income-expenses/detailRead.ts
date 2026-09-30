import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { loadIncomeExpenseDetails } from "@/lib/incomeExpenseDetailRpc";
import { hasCompleteVoucherDetail } from "@/lib/incomeExpenseDetailRead";
export { loadIncomeExpenseDetails } from "@/lib/incomeExpenseDetailRpc";
import type { IncomeExpenseWithRelations } from "./types";
import { hydrateReservationCreators } from "./reservationCreators";
import { hydrateIncomeExpenseSupplements } from "./supplements";
/** Keep ordinary RLS relation labels only while their FK still matches the snapshot. */
export async function enrichIncomeExpenseDetails(
  rows: IncomeExpenseWithRelations[],
): Promise<IncomeExpenseWithRelations[]> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.organization_id)
      throw new Error("Phiếu thiếu tổ chức. Vui lòng tải lại.");
    const ids = groups.get(row.organization_id) ?? [];
    ids.push(row.id);
    groups.set(row.organization_id, ids);
  }
  const details = (
    await Promise.all(
      [...groups].map(([org, ids]) => loadIncomeExpenseDetails(org, ids)),
    )
  ).flat();
  const byId = new Map(details.map((row) => [row.id, row]));
  return rows.map((row) => {
    const detail = byId.get(row.id)!;
    // The list was selected by these header fields. A newer snapshot needs the
    // selection query rerun, otherwise a cancelled/moved voucher crosses filters.
    const selectionFields: (keyof IncomeExpenseWithRelations)[] = [
      "updated_at",
      "approval_version",
      "posting_version",
      "organization_id",
      "building_id",
      "room_id",
      "tenant_id",
      "account_id",
      "type",
      "voucher_date",
      "approval_status",
      "user_id",
      "total_amount",
      "kqkd_amount",
      "verified_at",
      "system_source",
      "counts_in_business_result",
      "business_result_accounting",
    ];
    if (selectionFields.some((field) => row[field] !== detail[field])) {
      throw new Error("Danh sách phiếu vừa thay đổi. Vui lòng tải lại.");
    }
    return {
      ...row,
      ...detail,
      creator_name: detail.creator_name ?? row.creator_name,
      room_name: detail.room_id === row.room_id ? row.room_name : null,
      tenant_name: detail.tenant_id === row.tenant_id ? row.tenant_name : null,
      account_name:
        detail.account_id === row.account_id ? row.account_name : null,
      account_is_virtual:
        detail.account_id === row.account_id ? row.account_is_virtual : null,
    };
  });
}
/**
 * Đọc đủ một phiếu: đầu phiếu (quyết định "còn thấy" + nhãn phòng/khách/sổ),
 * chi tiết qua RPC và phần bổ sung — ba lần đọc qua RLS như trước.
 *
 * Trước 30/09/2026 ba lần đọc nối đuôi nhau (đo production: 570–1.870 ms mỗi lần
 * mở phiếu từ mạng cáp). Phần bổ sung chỉ cần id nên luôn chạy song song; RPC
 * cần tổ chức, nên khi màn gọi đã biết tổ chức (dòng danh sách vừa bấm) thì nó
 * cũng chạy ngay. `organizationIdHint` chỉ để chạy sớm, không phải căn cứ quyền:
 * đầu phiếu không thấy ⇒ null, tổ chức thật khác gợi ý ⇒ bỏ kết quả, đọc lại.
 */
export async function loadIncomeExpenseDetail(
  id: string,
  organizationIdHint?: string | null,
): Promise<IncomeExpenseWithRelations | null> {
  const headerRead = supabase
    .from("income_expenses")
    .select(
      "organization_id, room:rooms!income_expenses_room_id_fkey(id,name), tenant:tenants!income_expenses_tenant_id_fkey(id,full_name), account:accounts!income_expenses_account_id_fkey(id,name,is_virtual)",
    )
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const supplementsRead = hydrateIncomeExpenseSupplements([{ id }]);
  const earlyDetailRead = organizationIdHint
    ? loadIncomeExpenseDetails(organizationIdHint, [id])
    : null;
  // allSettled: đầu phiếu phải được xét TRƯỚC — phiếu hết quyền xem trả null,
  // không để lỗi của lần đọc song song đè lên thành "lỗi tải".
  const [header, supplements, earlyDetail] = await Promise.allSettled([
    headerRead,
    supplementsRead,
    earlyDetailRead,
  ]);
  if (header.status === "rejected") throw header.reason;
  const { data, error } = header.value;
  if (error) throw error;
  if (!data) return null;
  if (!data.organization_id) throw new Error("Phiếu thiếu tổ chức.");
  let details: IncomeExpenseWithRelations[];
  if (earlyDetailRead && organizationIdHint === data.organization_id) {
    if (earlyDetail.status === "rejected") throw earlyDetail.reason;
    details = earlyDetail.value ?? [];
  } else {
    details = await loadIncomeExpenseDetails(data.organization_id, [id]);
  }
  const [detail] = details;
  if (!detail) throw new Error("Không tải đủ chi tiết phiếu. Vui lòng thử lại.");
  if (supplements.status === "rejected") throw supplements.reason;
  const [named] = await hydrateReservationCreators([
    {
      ...detail,
      room_name: data.room?.id === detail.room_id ? data.room.name : null,
      tenant_name:
        data.tenant?.id === detail.tenant_id ? data.tenant.full_name : null,
      account_name:
        data.account?.id === detail.account_id ? data.account.name : null,
      account_is_virtual:
        data.account?.id === detail.account_id
          ? data.account.is_virtual
          : null,
    },
  ]);
  if (!named) throw new Error("Không tải đủ chi tiết phiếu. Vui lòng thử lại.");
  return { ...named, supplements: supplements.value[0]?.supplements };
}
/**
 * Hạn chờ một lần đọc chi tiết phiếu. Đọc thường xong dưới 2 giây (đo production
 * 30/09/2026: 570–1.870 ms kể cả khi ba lần đọc còn nối đuôi). Request kẹt mà
 * không có hạn thì vòng quay chạy mãi: màn chờ không mời "Thử lại", đóng mở lại
 * cũng dính vào đúng lần đọc đang treo — các lần đọc chưa nhận `signal` của React
 * Query nên chưa huỷ được request (việc sau: `.abortSignal()` cho từng lần đọc).
 * Chủ chốt 30/09/2026: chờ tối đa 20 giây — cho cả chi tiết phiếu lẻ lẫn phiếu
 * tổng (đợt ~7 lần đọc nối đuôi, thường ~3 giây).
 */
export const DETAIL_READ_TIMEOUT_MS = 20_000;

export class DetailReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`Mạng chậm — quá ${Math.round(ms / 1000)} giây chưa tải xong. Kiểm tra mạng rồi bấm Thử lại.`);
    this.name = "DetailReadTimeoutError";
  }
}

/** Đọc quá `ms` ⇒ lỗi DetailReadTimeoutError (màn hình hiện nút Thử lại). */
export function withDetailReadDeadline<T>(read: Promise<T>, ms = DETAIL_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DetailReadTimeoutError(ms)), ms);
  });
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
}

/**
 * @param organizationIdHint tổ chức của phiếu nếu màn gọi đã biết (dòng danh
 *   sách) — chỉ để tải song song, xem loadIncomeExpenseDetail.
 */
export function useIncomeExpenseDetail(
  id: string | null | undefined,
  enabled = true,
  organizationIdHint?: string | null,
  /**
   * Dòng danh sách vừa bấm — chủ chốt 30/09/2026: hiện NGAY làm bản xem trước
   * (`isPlaceholderData`), màn gọi khoá nút thao tác tới khi bản đọc mới về. Chỉ
   * nhận khi đúng phiếu và đã đủ hạng mục (dòng danh sách được làm giàu bằng cùng
   * RPC chi tiết); bản mới báo hết quyền/lỗi thì bản xem trước bị bỏ.
   */
  preview?: IncomeExpenseWithRelations | null,
) {
  const placeholder = preview && preview.id === id && hasCompleteVoucherDetail(preview) ? preview : undefined;
  return useQuery({
    queryKey: ["income-expense", "detail", id],
    queryFn: () => withDetailReadDeadline(loadIncomeExpenseDetail(id!, organizationIdHint)),
    placeholderData: placeholder,
    // Mọi màn dùng query này (tấm phiếu, hộp chi tiết, form sửa, trang in) tự hiện
    // lỗi + Thử lại tại chỗ. Toast chung của QueryProvider in cả queryKey và đè lên
    // nút Thử lại trên điện thoại — im với người dùng, vẫn ghi nhật ký lỗi.
    meta: { silent: true },
    enabled: enabled && !!id,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
}

/** Related entities retain their own RLS. Missing permission means no label, never a broader read grant. */
export async function hydrateIncomeExpenseDetailRelations(
  rows: IncomeExpenseWithRelations[],
): Promise<IncomeExpenseWithRelations[]> {
  const chunks = (ids: (string | null)[]) => {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const result: string[][] = [];
    for (let offset = 0; offset < unique.length; offset += 100)
      result.push(unique.slice(offset, offset + 100));
    return result;
  };
  const [roomResults, tenantResults, accountResults] = await Promise.all([
    Promise.all(
      chunks(rows.map((row) => row.room_id)).map((ids) =>
        supabase.from("rooms").select("id,name").in("id", ids),
      ),
    ),
    Promise.all(
      chunks(rows.map((row) => row.tenant_id)).map((ids) =>
        supabase.from("tenants").select("id,full_name").in("id", ids),
      ),
    ),
    Promise.all(
      chunks(rows.map((row) => row.account_id)).map((ids) =>
        supabase.from("accounts").select("id,name,is_virtual").in("id", ids),
      ),
    ),
  ]);
  for (const result of [...roomResults, ...tenantResults, ...accountResults])
    if (result.error) throw result.error;
  const rooms = new Map(
    roomResults
      .flatMap((result) => result.data ?? [])
      .map((row) => [row.id, row]),
  );
  const tenants = new Map(
    tenantResults
      .flatMap((result) => result.data ?? [])
      .map((row) => [row.id, row]),
  );
  const accounts = new Map(
    accountResults
      .flatMap((result) => result.data ?? [])
      .map((row) => [row.id, row]),
  );
  return rows.map((row) => ({
    ...row,
    room_name: row.room_id ? (rooms.get(row.room_id)?.name ?? null) : null,
    tenant_name: row.tenant_id
      ? (tenants.get(row.tenant_id)?.full_name ?? null)
      : null,
    account_name: row.account_id
      ? (accounts.get(row.account_id)?.name ?? null)
      : null,
    account_is_virtual: row.account_id
      ? (accounts.get(row.account_id)?.is_virtual ?? null)
      : null,
  }));
}
