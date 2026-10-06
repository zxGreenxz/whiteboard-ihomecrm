# iHomeCRM

Ứng dụng quản lý cho thuê và sổ sách: React/Vite, Supabase, Cloudflare R2, Network Center.

## Bắt đầu

Agent đọc [Project Contract](docs/engineering/PROJECT_CONTRACT.md); chỉ mở [một domain](docs/he-thong/README.md) khi chưa rõ nghiệp vụ hoặc [bản đồ code](docs/CODEBASE_STRUCTURE.md) khi chưa rõ vị trí source.
Chọn runtime của package từ [runtime-matrix](tooling/runtime-matrix.json).

```bash
npm ci
npm run dev
```

Vault `CLAUDE.local.md` ở checkout chính, không in/sao chép secret. Chỉ ghi fixture vào DEMO/TEST theo Contract §2.

## Kiểm chứng và phát hành

Sau focused tests và stage file cụ thể, xem `npm run gate:truoc-push -- --plan`, rồi chạy kế hoạch mặc định theo scope.
Không mặc định chạy full gate hoặc build local; receipt trên đầu vào không đổi có thể dùng lại. Runner/review lấy từ [test-matrix](tooling/test-matrix.json) và [risk-map](tooling/risk-map.json).
`main` tạo Preview; `production` phát hành qua promote đúng SHA theo Contract §3. Migration/backup có runbook riêng.
