/**
 * The meters schema has UNIQUE(user_id, code); only its named constraint identifies this field. Đợt 9: lời từ chối gốc có
 * thể nằm ở `cause` của lỗi đã nêu mã công tơ đang giữ mã đó (tạo công tơ), vẫn tính là trùng mã.
 */
export function isDuplicateMeterCode(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const detail = error as { code?: string; message?: string; details?: string; cause?: unknown };
  return (detail.code === '23505' && /\bmeters_user_id_code_key\b/.test(`${detail.message ?? ''} ${detail.details ?? ''}`))
    || isDuplicateMeterCode(detail.cause, depth + 1);
}
