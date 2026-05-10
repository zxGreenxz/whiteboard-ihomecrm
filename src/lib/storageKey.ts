/**
 * Chuẩn hoá tên file thành object key hợp lệ cho Supabase Storage.
 * Bỏ dấu tiếng Việt, thay mọi ký tự không phải [a-zA-Z0-9._-] bằng "_",
 * gộp run "_" và truncate base name để tránh key quá dài.
 *
 * Vì sao: Supabase Storage trả 400 "Invalid key" cho key chứa space, dấu phẩy,
 * và một số ký tự đặc biệt (vd tên file DALL-E sinh tự động, tên TV có dấu).
 *
 * Pure function — không import gì từ runtime để có thể test trong môi trường node.
 */
export function sanitizeStorageFileName(name: string): string {
  if (!name) return "file";

  const lastDot = name.lastIndexOf(".");
  const rawBase = lastDot > 0 ? name.slice(0, lastDot) : name;
  const rawExt = lastDot > 0 ? name.slice(lastDot) : "";

  const safeBase = rawBase
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // \u0111/\u0110 kh\u00f4ng c\u00f3 canonical decomposition trong NFKD n\u00ean ph\u1ea3i map th\u1ee7 c\u00f4ng
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");

  const safeExt = rawExt.replace(/[^a-zA-Z0-9.]/g, "");

  const MAX_BASE = 100;
  const truncated = safeBase.length > MAX_BASE ? safeBase.slice(0, MAX_BASE) : safeBase;

  return (truncated || "file") + safeExt;
}
