# iHomeCRM

Ứng dụng quản lý cho thuê: hợp đồng, hoá đơn, thu chi, sổ quỹ, công tơ, lương thưởng và lợi nhuận.
Frontend React/Vite; backend Supabase; file trên Cloudflare R2; worker Zalo và Network Center chạy riêng.

## Bắt đầu

Agent đọc [Project Contract](docs/engineering/PROJECT_CONTRACT.md).
Nghiệp vụ ở [docs/he-thong](docs/he-thong/README.md);
cấu trúc mã ở [CODEBASE_STRUCTURE.md](docs/CODEBASE_STRUCTURE.md).
Số liệu repo/database ở [docs/generated](docs/generated/), không chép lại vào README.

Chọn Node theo [runtime-matrix.json](tooling/runtime-matrix.json), dùng runtime của CI app để cài root.
Package con dùng runtime và dependency riêng.

```bash
npm ci
npm run dev
```

Credential nằm trong `CLAUDE.local.md` bị gitignore. Chỉ nạp vào process env khi cần, không in hoặc sao chép.
Không ghi dữ liệu thử vào org THẬT; phạm vi DEMO/TEST theo Contract §2.

## Kiểm tra và phát hành

```bash
npm run typecheck:baseline
npx vitest run <path>
npm run build
npm run gate:truoc-push
```

Chọn runner/gate theo [test-matrix](tooling/test-matrix.json) và [risk-map](tooling/risk-map.json).
Thay đổi docs/script thuần không cần build hoặc E2E app nếu không chạm runtime.

App dùng `main` cho Preview và `production` để phát hành.
Kiểm CI đúng SHA bằng `npm run promote:production -- --sha <sha>`; chỉ thêm `--apply` sau khi đạt.
Quy trình Git/review/deploy nằm ở Contract §3; migration/backup ở §4–6.
