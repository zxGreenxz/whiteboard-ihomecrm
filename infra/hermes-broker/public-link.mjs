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

// Câu SQL thêm vào messageText khi dòng có publicPath (20261022051620, invoice_reminders): tin hứa có link kèm theo.
export const REMINDER_LINK_SENTENCE = ' Chi tiết hoá đơn xem ở link kèm theo.';

/** Kết quả cuối của crm_read_report (lượt 12, HOA-DON-THAO-TAC-GHI.md mục 4.6): mỗi dòng có publicPath ⇒ publicLink tuyệt đối hoặc null,
 * cùng chỗ trong dòng; mô hình chỉ thấy publicLink. Tin soạn sẵn (messageText) thành MỘT khối chép nguyên văn: có link ⇒ link xuống dòng ở
 * cuối tin (như link công khai web chép riêng: origin + /c/<mã>); không ghép được (vắng origin) ⇒ bỏ câu hứa link, không bao giờ để mô hình
 * tự điền tên miền. summary.withLink đếm dòng thật sự có link. Báo cáo không có publicPath giữ nguyên. */
export function withReportPublicLinks(result, origin) {
  if (result === null || typeof result !== 'object' || typeof result.report !== 'string' || !Array.isArray(result.items) ||
      !result.items.some(row => row !== null && typeof row === 'object' && Object.hasOwn(row, 'publicPath'))) return result;
  const items = result.items.map(row => {
    if (row === null || typeof row !== 'object' || !Object.hasOwn(row, 'publicPath')) return row;
    const link = publicLink(origin, row.publicPath), next = {};
    for (const [key, value] of Object.entries(row)) next[key === 'publicPath' ? 'publicLink' : key] = key === 'publicPath' ? link : value;
    if (typeof next.messageText === 'string')
      next.messageText = link === null ? next.messageText.replace(REMINDER_LINK_SENTENCE, '') : `${next.messageText}\n${link}`;
    return next;
  });
  const summary = result.summary !== null && typeof result.summary === 'object' && Object.hasOwn(result.summary, 'withLink') && !publicWebOrigin(origin)
    ? { ...result.summary, withLink: 0 } : result.summary;
  return { ...result, items, summary };
}
