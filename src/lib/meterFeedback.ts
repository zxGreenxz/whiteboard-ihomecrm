/** The meters schema has UNIQUE(user_id, code); only its named constraint identifies this field. */
export function isDuplicateMeterCode(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { code?: string; message?: string; details?: string };
  return detail.code === '23505' && /\bmeters_user_id_code_key\b/.test(`${detail.message ?? ''} ${detail.details ?? ''}`);
}
