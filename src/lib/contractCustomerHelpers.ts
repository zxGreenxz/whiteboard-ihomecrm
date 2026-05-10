// Helpers cho việc đọc khách đại diện của một hợp đồng.
//
// Sau khi chuyển từ tenants → contract_customers, contracts.tenant_id là NULL
// cho mọi hợp đồng mới. Các nơi vẫn cần hiển thị "khách đại diện" phải
// đọc từ contract_customers (đại diện trước, fallback khách đầu tiên),
// và rớt về contract.tenant cũ chỉ khi tuyệt đối không có gì khác.

interface CustomerLite {
  id?: string;
  full_name?: string | null;
  phone?: string | null;
  email?: string | null;
  id_number?: string | null;
}

interface ContractLike {
  contract_customers?: Array<{
    is_representative?: boolean | null;
    customer?: CustomerLite | null;
  }>;
  tenant?: CustomerLite | null;
}

/** Lấy customer đại diện (object, có thể null) — ưu tiên is_representative. */
export function getRepresentativeCustomer(
  contract: ContractLike | null | undefined,
): CustomerLite | null {
  if (!contract) return null;
  const list = contract.contract_customers ?? [];
  const rep = list.find((cc) => cc.is_representative)?.customer;
  if (rep) return rep;
  const first = list[0]?.customer;
  if (first) return first;
  return contract.tenant ?? null;
}

/** Tên khách đại diện hoặc fallback. */
export function getRepresentativeName(
  contract: ContractLike | null | undefined,
  fallback = '—',
): string {
  return getRepresentativeCustomer(contract)?.full_name || fallback;
}

/** SĐT khách đại diện hoặc fallback. */
export function getRepresentativePhone(
  contract: ContractLike | null | undefined,
  fallback = '—',
): string {
  return getRepresentativeCustomer(contract)?.phone || fallback;
}

/** Email khách đại diện hoặc fallback. */
export function getRepresentativeEmail(
  contract: ContractLike | null | undefined,
  fallback = '',
): string {
  return getRepresentativeCustomer(contract)?.email || fallback;
}
