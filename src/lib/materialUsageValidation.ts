type MaterialUsageRowInput = { material_id: string | null; quantity: string };

/** Validates every visible row before any header or item write. */
export function validateMaterialUsageRows(
  rows: readonly MaterialUsageRowInput[],
  options: { optional?: boolean } = {},
): Record<string, string> {
  const errors: Record<string, string> = {};
  const untouched = rows.every(row => !row.material_id && !row.quantity.trim());
  if (options.optional && untouched) return errors;
  rows.forEach((row, index) => {
    const key = `materials.${index}`;
    if (!row.material_id) errors[`${key}.material_id`] = 'Chọn vật tư.';
    const quantity = Number(row.quantity);
    if (!row.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) {
      errors[`${key}.quantity`] = 'Nhập số lượng vật tư lớn hơn 0.';
    }
  });
  return errors;
}
