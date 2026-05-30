import { describe, it, expect } from 'vitest';
import {
  classifyService,
  resolveInvoicePricing,
  type BuildingDefaults,
} from '../contractServicePricing';

const BLD: BuildingDefaults = {
  elec: 3800,
  water: 100000,
  pdv: 150000,
  elecServiceId: 'bld-elec',
  waterServiceId: 'bld-water',
  pdvServiceId: 'bld-pdv',
};

describe('classifyService', () => {
  it('phân loại theo tên', () => {
    expect(classifyService('Điện 3K1', null)).toBe('electric');
    expect(classifyService('Điện 3k8', null)).toBe('electric');
    expect(classifyService('Nước', null)).toBe('water');
    expect(classifyService('Phí Dịch Vụ TL', null)).toBe('pdv');
    expect(classifyService('PDV', null)).toBe('pdv');
    expect(classifyService('Giữ xe', null)).toBe('other');
  });

  it('phân loại theo pricing_type khi tên không chuẩn', () => {
    expect(classifyService('X', 'DON_GIA_CO_DINH_DONG_HO')).toBe('electric');
    expect(classifyService('Y', 'DON_GIA_THEO_NGUOI')).toBe('water');
    expect(classifyService('Z', 'DON_GIA_THEO_PHONG')).toBe('pdv');
  });
});

describe('resolveInvoicePricing', () => {
  it('HĐ legacy (không có dịch vụ) → fallback đơn giá toà, áp cả nước & PDV', () => {
    const p = resolveInvoicePricing([], BLD);
    expect(p.hasContractServices).toBe(false);
    expect(p.elec).toBe(3800);
    expect(p.elecServiceId).toBe('bld-elec');
    expect(p.waterApplicable).toBe(true);
    expect(p.water).toBe(100000);
    expect(p.pdvApplicable).toBe(true);
    expect(p.pdv).toBe(150000);
  });

  it('null contract_services cũng coi như legacy', () => {
    const p = resolveInvoicePricing(null, BLD);
    expect(p.hasContractServices).toBe(false);
    expect(p.waterApplicable).toBe(true);
    expect(p.pdvApplicable).toBe(true);
  });

  it('HĐ chỉ có Điện 3K1 → dùng điện HĐ, KHÔNG áp nước & PDV', () => {
    const p = resolveInvoicePricing(
      [
        {
          service_id: 'svc-3k1',
          unit_price: 3100,
          service: { name: 'Điện 3K1', pricing_type: 'DON_GIA_CO_DINH_DONG_HO' },
        },
      ],
      BLD,
    );
    expect(p.hasContractServices).toBe(true);
    expect(p.elec).toBe(3100);
    expect(p.elecServiceId).toBe('svc-3k1');
    expect(p.waterApplicable).toBe(false);
    expect(p.pdvApplicable).toBe(false);
  });

  it('HĐ có đủ điện + nước + PDV → dùng đơn giá HĐ cho tất cả', () => {
    const p = resolveInvoicePricing(
      [
        { service_id: 'e', unit_price: 3500, service: { name: 'Điện 3k5', pricing_type: null } },
        { service_id: 'w', unit_price: 80000, service: { name: 'Nước', pricing_type: 'DON_GIA_THEO_NGUOI' } },
        { service_id: 'p', unit_price: 120000, service: { name: 'PDV', pricing_type: 'DON_GIA_THEO_PHONG' } },
      ],
      BLD,
    );
    expect(p.elec).toBe(3500);
    expect(p.elecServiceId).toBe('e');
    expect(p.waterApplicable).toBe(true);
    expect(p.water).toBe(80000);
    expect(p.waterServiceId).toBe('w');
    expect(p.pdvApplicable).toBe(true);
    expect(p.pdv).toBe(120000);
    expect(p.pdvServiceId).toBe('p');
  });

  it('HĐ có nước nhưng không điện → điện fallback giá toà, nước theo HĐ', () => {
    const p = resolveInvoicePricing(
      [{ service_id: 'w', unit_price: 90000, service: { name: 'Nước', pricing_type: 'DON_GIA_THEO_NGUOI' } }],
      BLD,
    );
    expect(p.elec).toBe(3800); // fallback toà — tiền điện chỉ hiện khi nhập chỉ số
    expect(p.elecServiceId).toBe('bld-elec');
    expect(p.waterApplicable).toBe(true);
    expect(p.water).toBe(90000);
    expect(p.pdvApplicable).toBe(false); // không đăng ký PDV
  });

  it('unit_price dạng chuỗi (Postgres numeric) vẫn parse đúng', () => {
    const p = resolveInvoicePricing(
      [{ service_id: 'e', unit_price: '3100.00', service: { name: 'Điện 3K1', pricing_type: null } }],
      BLD,
    );
    expect(p.elec).toBe(3100);
  });
});
