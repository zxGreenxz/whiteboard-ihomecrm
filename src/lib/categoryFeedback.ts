import type { OperationErrorRule } from './friendlyError';
// supabase/migrations/20250101000001_create_floors_table.sql: unique(building_id, floor_number).
export const FLOOR_ERROR_RULES: readonly OperationErrorRule[] = [{
  code: '23505', message: /floors_unique_building_floor/,
  description: 'Số tầng này đã có trong tòa. Nhập số tầng khác.',
  fieldErrors: {floor_number:'Số tầng này đã có trong tòa. Nhập số tầng khác.'},
}];
