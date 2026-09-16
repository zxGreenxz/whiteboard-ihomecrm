/**
 * Điền `organization_id` cho payload ghi thẳng bảng (insert/upsert) từ tổ chức
 * ĐANG CHỌN — plan I3, rà soát 15/09/2026.
 *
 * VÌ SAO CẦN
 *   Migration 20260915144656 chuyển trigger BEFORE INSERT của 33 bảng (contracts,
 *   customers, invoices, payments, tenants, services, leads, jobs…) từ
 *   `public._autofill_org` (đoán org bằng LIMIT 1 rồi rơi về HẰNG SỐ tổ chức
 *   THẬT) sang `app_private.autofill_org_strict` — FAIL-CLOSED: suy org qua cột
 *   cha, rồi qua người NHƯNG CHỈ khi người đó thuộc đúng MỘT tổ chức ACTIVE;
 *   không suy được thì nổ 23502. Tài khoản hệ thống thuộc HAI tổ chức nên mọi
 *   INSERT vào bảng không có cột cha (customers, leads, services, tenants…) từ
 *   tài khoản đó sẽ bị chặn nếu client không tự gửi `organization_id`.
 *
 *   Trước đây cùng lệnh đó không hỏng — nó im lặng ghi dòng vào sổ THẬT. Nên
 *   helper này KHÔNG được im lặng: chưa chọn công ty thì ném, để người dùng
 *   thấy ngay thay vì thấy một dòng lạc tổ chức ba tháng sau.
 *
 * LUẬT
 *   - Payload đã có `organization_id` (chuỗi khác rỗng) ⇒ giữ nguyên, không ghi
 *     đè. Có những đường ghi tự suy org từ cha (vd phiếu chi lương lấy org của
 *     hoá đơn) và đó là nguồn đúng hơn tổ chức đang chọn.
 *   - Chưa có ⇒ điền `orgId`; `orgId` rỗng ⇒ ném `Chưa chọn công ty`.
 *   - Không đột biến payload gốc.
 *
 * Nguồn `orgId` phía React: `useOrganization().selectedOrganizationId`
 * (src/contexts/OrganizationContext.tsx). `null` ở đó nghĩa là CHƯA CHỐT, không
 * phải "dùng mặc định" — xem chú thích của `resolveSelectedOrganizationId`.
 */
export const LOI_CHUA_CHON_CONG_TY = "Chưa chọn công ty";

export type WithOrg<T> = T & { organization_id: string };

function daCoOrg(payload: object): payload is { organization_id: string } {
  const own = (payload as { organization_id?: unknown }).organization_id;
  return typeof own === "string" && own !== "";
}

export function withOrg<T extends object>(
  payload: T,
  orgId: string | null | undefined,
): WithOrg<T> {
  if (daCoOrg(payload)) return payload as WithOrg<T>;
  if (!orgId) throw new Error(LOI_CHUA_CHON_CONG_TY);
  return { ...payload, organization_id: orgId };
}

/** Bản cho mảng dòng: map từng phần tử qua `withOrg`. Mảng rỗng ⇒ mảng rỗng. */
export function withOrgAll<T extends object>(
  rows: readonly T[],
  orgId: string | null | undefined,
): WithOrg<T>[] {
  return rows.map((row) => withOrg(row, orgId));
}
