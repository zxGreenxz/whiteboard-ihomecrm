// SINH TỰ ĐỘNG — ĐỪNG SỬA TAY.
//   node scripts/generate-copilot-guide-corpus.mjs
//   node scripts/generate-copilot-guide-corpus.mjs --check   (gate CI)
//
// Danh sách dưới đây là ALLOWLIST `CAPABILITIES` (docs.visibility === "public"
// && docs.userDoc) viết thành literal, vì `import.meta.glob` phân tích TĨNH và
// không nhận biến. Sửa tay ở đây là tạo nguồn sự thật thứ hai — sửa ở
// `src/app/capabilities/registry.ts` rồi chạy lại generator.
//
// VÌ SAO KHÔNG DÙNG `**` NỮA: glob là chỉ thị BUILD. `/docs/huong-dan-su-dung/**/index.md`
// gom NỘI DUNG cả 104 trang vào chunk JS công khai trên CDN — kể cả
// `05-cai-dat/admin-users`, `05-cai-dat/phan-quyen` và roadmap
// `08-ke-hoach-phat-trien/**` — trong khi docs-site gác mật khẩu fail-closed.
// Allowlist ở `trangHuongDanChoPhep()` chỉ chặn TÌM; chặn PHÂN PHỐI là việc của
// chính đối số này.

/** Trang hướng dẫn người dùng được PHÉP đưa vào bundle. Khoá = đường dẫn glob. */
export const USER_DOC_MODULES = import.meta.glob(
  [
    '/docs/huong-dan-su-dung/02-theo-doi-nhanh/so-do-toa-nha/index.md',
    '/docs/huong-dan-su-dung/02-theo-doi-nhanh/thong-bao/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/bang-luong/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/can-ho-phong/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/chat-zalo/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/cong-viec/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/cu-dan/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/dat-coc/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/dich-vu/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/ghi-chi-so/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/hoa-don/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/hop-dong/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/khach-hen/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/kho-vat-tu/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/phuong-tien/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/sale-phong/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/so-quy/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/tai-san/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/thu-chi/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/thu-tien-hoa-don/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/tien-thua/index.md',
    '/docs/huong-dan-su-dung/03-quan-ly-van-hanh/toa-nha/index.md',
    '/docs/huong-dan-su-dung/04-bao-cao/hub-bds/index.md',
    '/docs/huong-dan-su-dung/05-cai-dat/cai-dat-chung/index.md',
    '/docs/huong-dan-su-dung/05-cai-dat/mau-bieu/index.md',
  ],
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;
