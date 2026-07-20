# ptcrm docs site

VitePress xuất nội dung trực tiếp từ `../docs/huong-dan-su-dung`. Sidebar viết tay ở `.vitepress/sidebar.mts`; mỗi trang published mới phải được thêm vào đó.

```powershell
npm --prefix docs-site ci
npm --prefix docs-site run images:check
npm --prefix docs-site run build
npm --prefix docs-site run dev
```

- `prepare-content` tạo liên kết module để Markdown ngoài `docs-site` resolve dependency.
- `images:check` kiểm ảnh và cảnh báo trang chưa có sidebar.
- Build giữ `ignoreDeadLinks: false`; link nội bộ hỏng phải sửa, không tắt gate.
- Không sửa `docs-site/package-lock.json` bằng tay.
