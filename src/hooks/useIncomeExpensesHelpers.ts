/**
 * Pure helper functions for income/expense business logic.
 * Extracted for testability without Supabase/browser dependencies.
 */

import { excelImportRowSchema } from '../lib/incomeExpenseValidation';
import type { ExcelImportRow } from '../lib/incomeExpenseValidation';

// --- Pure helper: create insert payload for a new voucher ---
export function createVoucherPayload(input: {
  userId: string;
  type: 'INCOME' | 'EXPENSE';
  name: string;
  buildingId: string;
  roomId?: string;
  bedId?: string;
  tenantId?: string;
  voucherDate: string;
  notes?: string;
}): {
  user_id: string;
  type: 'INCOME' | 'EXPENSE';
  name: string;
  building_id: string;
  room_id: string | null;
  bed_id: string | null;
  tenant_id: string | null;
  voucher_date: string;
  notes: string | null;
  approval_status: 'UNAPPROVED';
} {
  return {
    user_id: input.userId,
    type: input.type,
    name: input.name,
    building_id: input.buildingId,
    room_id: input.roomId ?? null,
    bed_id: input.bedId ?? null,
    tenant_id: input.tenantId ?? null,
    voucher_date: input.voucherDate,
    notes: input.notes ?? null,
    approval_status: 'UNAPPROVED',
  };
}

// --- Pure helper: permission check ---
export function canEditVoucher(status: 'UNAPPROVED' | 'APPROVED'): boolean {
  return status === 'UNAPPROVED';
}

export function canDeleteVoucher(status: 'UNAPPROVED' | 'APPROVED'): boolean {
  return status === 'UNAPPROVED';
}

// --- Pure helpers: approval state transitions ---
export interface ApprovableVoucher {
  approval_status: 'UNAPPROVED' | 'APPROVED';
  approved_by: string | null;
  approved_at: string | null;
}

export function applyApproval<T extends ApprovableVoucher>(
  voucher: T,
  approverId: string,
  approvedAt: string,
): T & { approval_status: 'APPROVED'; approved_by: string; approved_at: string } {
  return { ...voucher, approval_status: 'APPROVED', approved_by: approverId, approved_at: approvedAt };
}

export function applyUnapproval<T extends ApprovableVoucher>(
  voucher: T,
): T & { approval_status: 'UNAPPROVED'; approved_by: null; approved_at: null } {
  return { ...voucher, approval_status: 'UNAPPROVED', approved_by: null, approved_at: null };
}

// --- Pure helper: soft-delete filter ---
export function filterNonDeleted<T extends { deleted_at: string | null }>(items: T[]): T[] {
  return items.filter(item => item.deleted_at === null);
}

// --- Pure helper: apply voucher updates (round-trip) ---
export interface VoucherBase {
  id: string;
  type: 'INCOME' | 'EXPENSE';
  name: string;
  building_id: string;
  room_id: string | null;
  bed_id: string | null;
  tenant_id: string | null;
  voucher_date: string;
  notes: string | null;
  approval_status: 'UNAPPROVED' | 'APPROVED';
  updated_at: string;
}

export type VoucherUpdates = Partial<Pick<VoucherBase, 'name' | 'building_id' | 'room_id' | 'bed_id' | 'tenant_id' | 'voucher_date' | 'notes'>>;

export function applyVoucherUpdate(voucher: VoucherBase, updates: VoucherUpdates, newUpdatedAt: string): VoucherBase {
  const definedUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      definedUpdates[key] = value;
    }
  }
  return { ...voucher, ...definedUpdates, updated_at: newUpdatedAt } as VoucherBase;
}

// --- Pure helper: apply filters ---
export interface VoucherFilterable {
  building_id: string;
  room_id: string | null;
  type: 'INCOME' | 'EXPENSE';
  voucher_date: string;
  approval_status: 'UNAPPROVED' | 'APPROVED';
  name: string;
  code: string;
  tenant_name: string | null;
}

export interface VoucherFilterParams {
  building_id?: string;
  room_id?: string;
  type?: 'INCOME' | 'EXPENSE';
  start_date?: string;
  end_date?: string;
  approval_status?: 'UNAPPROVED' | 'APPROVED';
  searchQuery?: string;
}

export function applyVoucherFilters<T extends VoucherFilterable>(vouchers: T[], filters: VoucherFilterParams): T[] {
  return vouchers.filter(v => {
    if (filters.building_id && v.building_id !== filters.building_id) return false;
    if (filters.room_id && v.room_id !== filters.room_id) return false;
    if (filters.type && v.type !== filters.type) return false;
    if (filters.start_date && v.voucher_date < filters.start_date) return false;
    if (filters.end_date && v.voucher_date > filters.end_date) return false;
    if (filters.approval_status && v.approval_status !== filters.approval_status) return false;
    if (filters.searchQuery) {
      const search = filters.searchQuery.toLowerCase();
      const matchesName = v.name.toLowerCase().includes(search);
      const matchesCode = v.code.toLowerCase().includes(search);
      const matchesTenant = v.tenant_name ? v.tenant_name.toLowerCase().includes(search) : false;
      if (!matchesName && !matchesCode && !matchesTenant) return false;
    }
    return true;
  });
}

// --- Pure helper: paginate ---
export function paginateList<T>(items: T[], page: number, pageSize: number): { data: T[]; totalCount: number } {
  const totalCount = items.length;
  const start = (page - 1) * pageSize;
  const data = items.slice(start, start + pageSize);
  return { data, totalCount };
}

// --- Pure helper: compute stats ---
export interface VoucherForStats {
  type: 'INCOME' | 'EXPENSE';
  total_amount: number;
}

export interface ComputedIncomeExpenseStats {
  totalIncome: number;
  totalExpense: number;
  difference: number;
  totalTransactions: number;
}

export function computeIncomeExpenseStats(vouchers: VoucherForStats[]): ComputedIncomeExpenseStats {
  let totalIncome = 0;
  let totalExpense = 0;
  for (const v of vouchers) {
    if (v.type === 'INCOME') totalIncome += v.total_amount;
    else if (v.type === 'EXPENSE') totalExpense += v.total_amount;
  }
  return {
    totalIncome,
    totalExpense,
    difference: totalIncome - totalExpense,
    totalTransactions: vouchers.length,
  };
}

// --- Pure helper: cascade dropdown filter ---
export interface RoomFilterable { id: string; building_id: string; }
export interface BedFilterable { id: string; room_id: string; }
export interface TenantFilterable { id: string; room_id?: string | null; bed_id?: string | null; }

export function filterRoomsByBuilding<T extends RoomFilterable>(rooms: T[], buildingId: string): T[] {
  return rooms.filter(r => r.building_id === buildingId);
}

export function filterBedsByRoom<T extends BedFilterable>(beds: T[], roomId: string): T[] {
  return beds.filter(b => b.room_id === roomId);
}

export function filterTenantsByRoomOrBed<T extends TenantFilterable>(tenants: T[], roomId?: string, bedId?: string): T[] {
  return tenants.filter(t => {
    if (bedId && t.bed_id === bedId) return true;
    if (roomId && t.room_id === roomId) return true;
    return false;
  });
}

// --- Pure helper: voucher code validation ---
export function generateVoucherCode(type: 'INCOME' | 'EXPENSE', yearMonth: string, sequence: number): string {
  const prefix = type === 'INCOME' ? 'PT' : 'PC';
  const [yyyy, mm] = yearMonth.split('-');
  const yy = yyyy.slice(2);
  const seq = String(sequence).padStart(3, '0');
  return `${prefix}${yy}${mm}${seq}`;
}

export function isValidVoucherCode(code: string): boolean {
  return /^P[TC]\d{7}$/.test(code);
}

// --- Pure helper: validate import rows ---
export interface ImportRowError {
  rowIndex: number;
  message: string;
}

export interface ValidateImportRowsResult {
  validRows: ExcelImportRow[];
  errors: ImportRowError[];
}

export function validateImportRows(rows: unknown[]): ValidateImportRowsResult {
  const validRows: ExcelImportRow[] = [];
  const errors: ImportRowError[] = [];
  for (let i = 0; i < rows.length; i++) {
    const result = excelImportRowSchema.safeParse(rows[i]);
    if (result.success) {
      validRows.push(result.data);
    } else {
      const message = result.error.issues.map(issue => issue.message).join('; ');
      errors.push({ rowIndex: i, message });
    }
  }
  return { validRows, errors };
}

// --- Pure helper: type CRUD round-trip ---
export interface IncomeExpenseTypeBase {
  id: string;
  name: string;
  type: 'income' | 'expense';
  description: string | null;
  is_default: boolean;
  updated_at: string;
}

export type TypeUpdates = Partial<Pick<IncomeExpenseTypeBase, 'name' | 'type' | 'description' | 'is_default'>>;

export function applyTypeUpdate(typeObj: IncomeExpenseTypeBase, updates: TypeUpdates, newUpdatedAt: string): IncomeExpenseTypeBase {
  const definedUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      definedUpdates[key] = value;
    }
  }
  return { ...typeObj, ...definedUpdates, updated_at: newUpdatedAt } as IncomeExpenseTypeBase;
}

// --- Pure helper: template default toggle ---
export interface TemplateBase {
  id: string;
  code: string;
  name: string;
  is_default: boolean;
  is_income_template: boolean;
}

export function toggleDefaultTemplate(templates: TemplateBase[], templateId: string): TemplateBase[] {
  const target = templates.find(t => t.id === templateId);
  if (!target) return templates;

  return templates.map(t => {
    if (t.id === templateId) {
      return { ...t, is_default: !t.is_default };
    }
    // If we're setting this one to default, unset others of the same type
    if (!target.is_default && t.is_income_template === target.is_income_template && t.is_default) {
      return { ...t, is_default: false };
    }
    return t;
  });
}

// --- Pure helper: multi-item voucher ---
export interface VoucherItem {
  income_expense_type_id: string;
  quantity: number;
  unit_price: number;
}

export function calculateTotalFromItems(items: VoucherItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
}

export function countItemsForVoucher(items: Array<{ income_expense_id: string }>, voucherId: string): number {
  return items.filter(item => item.income_expense_id === voucherId).length;
}
