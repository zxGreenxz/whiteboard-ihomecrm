// Link công khai của hợp đồng (D-HĐ9, HOP-DONG-THAO-TAC-GHI.md mục 6, lượt 11 24/10/2026). SQL chỉ trả đường tương đối publicPath
// ('/c/<public_code>', như nút QR / link của web — src/lib/contractQrImage.ts buildPublicContractUrl = origin + '/c/' + code), không bao
// giờ trả URL tuyệt đối; origin web lấy từ cấu hình host publicWebOrigin. Vắng origin hoặc đường không đúng khuôn ⇒ null (không link).
import { PUBLIC_PATH } from './full-read-contract.mjs';

/** Origin hợp lệ: chỉ https, đúng dạng origin (không đường, không query, không thông tin đăng nhập). */
export function publicWebOrigin(value) {
  if (typeof value !== 'string' || value.length > 200) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
}
export const publicLink = (origin, path) => typeof origin === 'string' && publicWebOrigin(origin) && typeof path === 'string' && PUBLIC_PATH.test(path)
  ? origin + path : null;

/** Kết quả cuối của crm_read_contract_detail: publicPath (đã kiểm khuôn ở full-read-contract) ⇒ publicLink tuyệt đối hoặc null. Miền khác giữ nguyên. */
export function withPublicLink(result, origin) {
  if (result === null || typeof result !== 'object' || result.domain !== 'contract_detail' || result.item === null || typeof result.item !== 'object' ||
      !Object.hasOwn(result.item, 'publicPath')) return result;
  const { publicPath, ...item } = result.item;
  return { ...result, item: { ...item, publicLink: publicLink(origin, publicPath) } };
}
