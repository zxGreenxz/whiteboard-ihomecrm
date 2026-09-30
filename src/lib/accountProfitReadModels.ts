/** Runtime validation at read boundaries; null list payloads never mean an empty list. */
export const readString = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const readNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
export const readDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const readNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const readRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function requireReadRows<T>(data: unknown, valid: (row: Record<string, unknown>) => boolean): T[] {
 if (!Array.isArray(data) || data.some(row => !readRecord(row) || !valid(row))) throw new TypeError('Malformed read rows');
 return data as T[];
}
export function requireReadRow<T>(data: unknown, valid: (row: Record<string, unknown>) => boolean): T {
 if (!readRecord(data) || !valid(data)) throw new TypeError('Malformed read row');
 return data as T;
}
export const profitPersonRow = (row: Record<string, unknown>): boolean =>
 ['id', 'user_id', 'name'].every(key => readString(row[key])) &&
 ['auth_user_id', 'note', 'deleted_at'].every(key => readNullableString(row[key])) &&
 typeof row.is_active === 'boolean' && readDate(row.created_at) && readDate(row.updated_at);
export const salaryRuleRow = (row: Record<string, unknown>): boolean =>
 readString(row.id) && readString(row.manager_id) && readNullableString(row.label) &&
 ['FIXED', 'PERCENT'].includes(row.form as string) && ['PER_BUILDING', 'TOTAL_GROUP'].includes(row.basis as string) &&
 readNumber(row.amount) && readNumber(row.percent) && typeof row.is_active === 'boolean' &&
 Array.isArray(row.profit_manager_salary_buildings) && row.profit_manager_salary_buildings.every(link => readRecord(link) && readString(link.building_id));
export const buildingShareRow = (row: Record<string, unknown>): boolean =>
 ['id', 'user_id', 'building_id', 'shareholder_id'].every(key => readString(row[key])) && readNumber(row.percent);
export const templateRow = (row: Record<string, unknown>): boolean =>
 ['id', 'user_id', 'name', 'code', 'file_url', 'file_name'].every(key => readString(row[key])) &&
 ['CONTRACT_NEW', 'CONTRACT_TERMINATION', 'CONTRACT_EXTENSION', 'CONTRACT_TRANSFER', 'INVOICE', 'RECEIPT', 'HANDOVER'].includes(row.category as string) &&
 ['content', 'description', 'file_type', 'type', 'created_at', 'updated_at', 'deleted_at'].every(key => readNullableString(row[key])) &&
 (row.file_size === null || readNumber(row.file_size)) &&
 [row.is_active, row.is_default].every(value => value === null || typeof value === 'boolean') &&
 (row.variables === null || Array.isArray(row.variables) && row.variables.every(readRecord));
