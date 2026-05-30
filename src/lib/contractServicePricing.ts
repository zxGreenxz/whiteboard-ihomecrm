/**
 * Phân loại dịch vụ + suy ra đơn giá hiệu lực cho hoá đơn của một hợp đồng.
 *
 * Bối cảnh: dialog tạo hoá đơn (đơn lẻ & Mode Excel) trước đây luôn lấy đơn
 * giá điện/nước/PDV từ `building_services` (đơn giá toà) và prefill nước + PDV
 * cho MỌI hợp đồng — kể cả hợp đồng không đăng ký các dịch vụ đó. Toà còn có
 * thể bật nhiều loại điện (vd "Điện 3K1" + "Điện 3k8") nên việc chọn loại nào
 * là không xác định.
 *
 * Quy tắc đúng (khớp ý người dùng):
 *  - Hợp đồng CÓ cấu hình `contract_services` → đơn giá + service_id của
 *    điện/nước/PDV lấy theo đúng dịch vụ HĐ đã chọn; nước/PDV CHỈ áp khi HĐ có
 *    liệt kê (không có → không tự bỏ vào hoá đơn).
 *  - Hợp đồng CHƯA cấu hình dịch vụ nào (legacy) → fallback về đơn giá toà như
 *    cũ để không phá luồng tạo hoá đơn hàng loạt hiện hành.
 */

export type ServiceKind = 'electric' | 'water' | 'pdv' | 'other';

export interface ContractServiceInput {
  service_id: string;
  unit_price: number | string | null;
  service?: { name?: string | null; pricing_type?: string | null } | null;
}

export interface BuildingDefaults {
  elec: number;
  water: number;
  pdv: number;
  elecServiceId: string | null;
  waterServiceId: string | null;
  pdvServiceId: string | null;
}

export interface EffectiveInvoicePricing {
  elec: number;
  water: number;
  pdv: number;
  elecServiceId: string | null;
  waterServiceId: string | null;
  pdvServiceId: string | null;
  /** HĐ có áp dịch vụ Nước không (quyết định có prefill tiền nước). */
  waterApplicable: boolean;
  /** HĐ có áp Phí dịch vụ không (quyết định có prefill PDV). */
  pdvApplicable: boolean;
  /** HĐ có cấu hình ≥1 dòng dịch vụ riêng hay không (legacy = false). */
  hasContractServices: boolean;
}

/**
 * Phân loại 1 dịch vụ theo tên + pricing_type. Ưu tiên tên (vì người dùng đặt
 * tên rõ "Điện…", "Nước"), bổ sung pricing_type cho dịch vụ thiếu tên chuẩn.
 *  - DON_GIA_CO_DINH_DONG_HO → điện (theo đồng hồ)
 *  - DON_GIA_THEO_NGUOI      → nước (theo người)
 *  - DON_GIA_THEO_PHONG      → PDV (theo phòng)
 */
export function classifyService(
  name?: string | null,
  pricingType?: string | null,
): ServiceKind {
  const n = (name ?? '').trim().toLowerCase();
  const pt = pricingType ?? '';
  if (n.includes('điện') || pt === 'DON_GIA_CO_DINH_DONG_HO') return 'electric';
  if (n.includes('nước') || pt === 'DON_GIA_THEO_NGUOI') return 'water';
  if (
    n.includes('dịch vụ') ||
    n.includes('phí') ||
    n === 'pdv' ||
    pt === 'DON_GIA_THEO_PHONG'
  ) {
    return 'pdv';
  }
  return 'other';
}

/**
 * Suy ra đơn giá điện/nước/PDV hiệu lực cho hoá đơn dựa trên dịch vụ HĐ đăng
 * ký, fallback về đơn giá toà khi HĐ chưa cấu hình.
 */
export function resolveInvoicePricing(
  contractServices: ContractServiceInput[] | null | undefined,
  buildingDefaults: BuildingDefaults,
): EffectiveInvoicePricing {
  const list = contractServices ?? [];
  const hasContractServices = list.length > 0;

  let elec: { id: string; price: number } | null = null;
  let water: { id: string; price: number } | null = null;
  let pdv: { id: string; price: number } | null = null;

  for (const cs of list) {
    const kind = classifyService(cs.service?.name, cs.service?.pricing_type);
    const price = Number(cs.unit_price) || 0;
    const entry = { id: cs.service_id, price };
    // Lấy dòng đầu tiên match mỗi loại (một HĐ thường chỉ có 1 điện/nước/PDV).
    if (kind === 'electric' && !elec) elec = entry;
    else if (kind === 'water' && !water) water = entry;
    else if (kind === 'pdv' && !pdv) pdv = entry;
  }

  return {
    // Điện: luôn có đơn giá (HĐ nếu có, không thì toà) vì tiền điện chỉ hiện
    // khi nhập chỉ số → không gây tự bỏ khoản thừa.
    elec: elec?.price ?? buildingDefaults.elec,
    elecServiceId: elec?.id ?? buildingDefaults.elecServiceId,
    // Nước/PDV: HĐ đã cấu hình dịch vụ → chỉ áp khi HĐ liệt kê; HĐ legacy →
    // dùng đơn giá toà như trước.
    water: water?.price ?? buildingDefaults.water,
    waterServiceId: water?.id ?? buildingDefaults.waterServiceId,
    waterApplicable: hasContractServices ? !!water : true,
    pdv: pdv?.price ?? buildingDefaults.pdv,
    pdvServiceId: pdv?.id ?? buildingDefaults.pdvServiceId,
    pdvApplicable: hasContractServices ? !!pdv : true,
    hasContractServices,
  };
}
