// Kích thước trang danh sách dùng chung giữa các trang list và prefetch
// (src/lib/prefetchPages.ts). Prefetch dựng lại query key của trang — pageSize
// lệch nhau là trật cache key, prefetch thành vô dụng. Module tách riêng, KHÔNG
// import gì để trang mobile không kéo theo graph import của prefetchPages.

/** Trang đầu desktop: 20 phiếu. */
export const DESKTOP_LIST_PAGE_SIZE = 20;

/** Trang đầu mobile: 15 phiếu — đủ 1 màn, prefetch nhẹ cho 4G.
 *  Nút "Tải thêm" của từng trang vẫn nới theo bước riêng (+30/+50). */
export const MOBILE_FIRST_PAGE_SIZE = 15;
