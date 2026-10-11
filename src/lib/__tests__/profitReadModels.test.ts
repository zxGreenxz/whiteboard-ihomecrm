import { describe, expect, it } from 'vitest';
import { readProfitMonthly, readProfitPreview, readProfitState } from '@/lib/profitReadModels';
import { LEGACY_UNALLOCATED_DISPOSITION, normalizeUnallocatedDisposition, unallocatedDispositionLabel } from '@/lib/profitClose';

// N-A3-01: các tháng chốt TRƯỚC V3 được migration 20260721110000 đánh dấu
// `LEGACY_RETAINED_UNALLOCATED` (CHECK của profit_monthly cho phép giá trị này).
// Bộ đọc cũ ném "Invalid profit read payload" ⇒ tab Tổng quan và Chốt LN tháng cũ
// báo "Chưa tải được…". Số liệu dưới đây là mẫu tổng hợp, không phải số thật.
const ORG = '00000000-0000-4000-8000-0000000000a1';
const BUILDING = '00000000-0000-4000-8000-0000000000b1';
const ROW_ID = '00000000-0000-4000-8000-0000000000c1';
const HASH = 'a'.repeat(32);
const LEGACY_REASON = 'Legacy close retained the undistributed balance without an explicit decision';

const legacyMonthly = {
  id: ROW_ID, user_id: '00000000-0000-4000-8000-0000000000d1', building_id: BUILDING, period_month: '2026-05-01',
  computed_profit: '1000000.00', adjusted_profit: '1000000.00', management_salary: '0.00',
  shareholder_percent_total: '90.0000', shareholder_allocated_amount: '900000.00', unallocated_profit: '100000.00',
  unallocated_disposition: 'LEGACY_RETAINED_UNALLOCATED', unallocated_disposition_reason: LEGACY_REASON,
  status: 'LOCKED', note: null, locked_at: '2026-06-02T03:04:05+00:00', locked_by: null,
};

const stateRow = {
  id: ROW_ID, building_id: BUILDING, building_name: 'Toà mẫu', is_virtual: false, building_deleted: false, status: 'LOCKED',
  computed_profit: 1000000, adjusted_profit: 1000000, adjustment_amount: 0, adjustment_reason: null, management_salary: 0,
  distributable_profit: 1000000, shareholder_percent_total: 90, shareholder_allocated_amount: 900000, unallocated_profit: 100000,
  unallocated_disposition: 'LEGACY_RETAINED_UNALLOCATED', unallocated_disposition_reason: LEGACY_REASON,
  source_revenue: 1500000, source_expense: 500000, source_hash: HASH, is_stale: false, stale_reason: null,
  revision_number: 1, locked_at: '2026-06-02T03:04:05+00:00',
};

describe('profitReadModels — chốt kiểu cũ LEGACY_RETAINED_UNALLOCATED (N-A3-01)', () => {
  it('readProfitMonthly đọc được dòng chốt kiểu cũ thay vì ném cả bảng', () => {
    const [row] = readProfitMonthly([legacyMonthly]);
    expect(row.unallocated_disposition).toBe(LEGACY_UNALLOCATED_DISPOSITION);
    expect(row.unallocated_profit).toBe(100000);
  });

  it('readProfitState (tab Chốt LN tháng cũ) đọc được dòng chốt kiểu cũ', () => {
    const state = readProfitState({
      organization_id: ORG, period_month: '2026-05-01', can_lock: true, can_unlock: true, state_hash: HASH,
      snapshot_ids: [ROW_ID], snapshot_count: 1, locked_count: 1, draft_count: 0, real_building_count: 1,
      active_real_snapshot_count: 1, has_out_of_scope_snapshots: false, rows: [stateRow],
    }, ORG, '2026-05-01');
    expect(state.rows[0].unallocated_disposition).toBe('LEGACY_RETAINED_UNALLOCATED');
  });

  it('readProfitPreview đọc được bản chụp hiện hành chốt kiểu cũ', () => {
    const preview = readProfitPreview({
      organization_id: ORG, period_month: '2026-05-01', source_hash: HASH, is_locked: true, is_stale: false,
      buildings: [{
        building_id: BUILDING, building_name: 'Toà mẫu', source_revenue: 1500000, source_expense: 500000, computed_profit: 1000000,
        adjustment_amount: 0, management_salary: 0, distributable_profit: 1000000, shareholder_percent_total: 90,
        shareholder_allocated_amount: 900000, unallocated_profit: 100000,
        unallocated_disposition: 'LEGACY_RETAINED_UNALLOCATED', unallocated_disposition_reason: LEGACY_REASON,
        building_source_hash: HASH, current_is_stale: false, current_stale_reason: null, current_status: 'LOCKED',
        shareholder_allocations: [], manager_allocations: [],
        current_snapshot: { ...stateRow, distributable_profit: 1000000 },
      }],
    }, ORG, '2026-05-01');
    expect(preview.rows[0].unallocated_disposition).toBe('LEGACY_RETAINED_UNALLOCATED');
    expect(preview.rows[0].current_snapshot?.unallocated_disposition).toBe('LEGACY_RETAINED_UNALLOCATED');
  });

  it('giá trị lạ khác vẫn bị chặn (không nới thành chấp nhận mọi chuỗi)', () => {
    expect(() => readProfitMonthly([{ ...legacyMonthly, unallocated_disposition: 'DISCARDED' }])).toThrow('Invalid profit read payload');
  });

  it('chốt lại tháng cũ: bản nháp KHÔNG tự chọn sẵn giá trị kiểu cũ (máy chủ chỉ nhận RETAINED_EARNINGS/CARRY_FORWARD)', () => {
    expect(normalizeUnallocatedDisposition('LEGACY_RETAINED_UNALLOCATED')).toBeNull();
  });

  it('nhãn tiếng Việt cho chốt kiểu cũ', () => {
    expect(unallocatedDispositionLabel('LEGACY_RETAINED_UNALLOCATED')).toBe('Giữ lại (chốt kiểu cũ)');
    expect(unallocatedDispositionLabel('RETAINED_EARNINGS')).toBe('Giữ lại lợi nhuận');
    expect(unallocatedDispositionLabel('CARRY_FORWARD')).toBe('Chuyển kỳ sau');
    expect(unallocatedDispositionLabel(null)).toBe('Chưa chọn');
  });
});
