# iHomeCRM

Ứng dụng quản lý cho thuê và sổ sách: React/Vite, Supabase, Cloudflare R2, Network Center.

## Bắt đầu

Agent đọc [Project Contract](docs/engineering/PROJECT_CONTRACT.md). Tra [mục lục domain](docs/he-thong/README.md) khi chưa rõ nghiệp vụ hoặc [bản đồ code](docs/CODEBASE_STRUCTURE.md) khi cần tìm source.
Chọn runtime của package từ [runtime-matrix](tooling/runtime-matrix.json).

```bash
npm ci
npm run dev
```

Chỉ ghi fixture vào DEMO/TEST theo Contract §2. Khi tác vụ cần credential, dùng lệnh repo ở §9.

## Kiểm chứng và phát hành

Sau test tập trung, stage file cụ thể, xem `npm run gate:truoc-push -- --plan` rồi chạy `npm run gate:truoc-push`. Contract §3 và §10 hướng dẫn chọn draft PR, chờ CI đúng commit và dùng lại biên nhận. `main` tạo Preview. Ứng dụng phát hành qua promote sang `production`.
