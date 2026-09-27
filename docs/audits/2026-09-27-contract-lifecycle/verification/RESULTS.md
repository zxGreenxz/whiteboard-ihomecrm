# Biên bản xác minh của lượt lập plan

Ngày: 27/09/2026. Source: `e498f10d49f3548e72074095c955371d0cee41ab`.

## Đã chạy

| Kiểm tra | Kết quả | Giới hạn |
|---|---|---|
| Git base và origin/main lúc bắt đầu | HEAD trùng origin/main, ahead/behind 0/0 | Không phải kiểm tra deployed SHA/database |
| Vitest baseline dưới đây | 20 file, 496 tests PASS, exit 0 | Test cũ của source base, không chứng minh feature đề xuất |
| `node scripts/check-docs.mjs` sau cập nhật tài liệu | 325 Markdown, 0 lỗi, exit 0 | Link docs; không phải typecheck/build/app E2E |
| Tên npm scripts có trong master | Tất cả có trong package.json ở base | Script tồn tại không có nghĩa đã chạy hay đúng TEST target |
| Paths trong ba evidence domain | Các full file path hiện tại tra được tại base | Line là neo; cần đọc toàn symbol/patch |
| Master code fences + task/test/requirement IDs | Fences khép cặp; R01–R13, P0–P13, V01–V35, D01–D08 | Kiểm cấu trúc, không phải xác nhận đủ nghiệp vụ |
| Source package | Git blob từ base, SHA256 từng file; ZIP CRC và digest kiểm bằng build-handoff.py | Không phải runtime environment; không có dependencies/binary templates |

HTML trong gói là bản 03 của lượt trước trong cùng phiên: đã kiểm các nút 5 tab, desktop/mobile 320–1440 px không tràn ngang, print media hiện đủ 5 ví dụ và console không lỗi. Sơ đồ là đề xuất quy trình, chưa phải UI CRM đã chạy.

Baseline chạy từ checkout chính cùng SHA vì đã có dependencies; worktree lập plan không cài lại. Node `v22.20.0`, Vitest `4.0.18`; thời gian bắt đầu log 18:35:09, duration 23.80s. Runtime này không thay phiên bản CI trong runtime-matrix.

```powershell
npx --no-install vitest run src/lib/__tests__/contractLifecycle.test.ts src/lib/__tests__/contractCreateRpc.test.ts src/lib/__tests__/contractStatus.property.test.ts src/lib/__tests__/contractOperations.property.test.ts src/lib/__tests__/contractValidation.property.test.ts src/lib/__tests__/contractSettlement.test.ts src/lib/__tests__/contractSettlementReads.test.ts src/lib/__tests__/terminationSettlement.test.ts src/lib/__tests__/roomLifecycle.test.ts src/lib/__tests__/depositWorkQueue.test.ts src/lib/__tests__/publicRoomsHoldingDepositMigration.test.ts src/lib/__tests__/reservationSettlementRpc.test.ts src/lib/__tests__/reservationSettlementForm.test.ts src/lib/__tests__/reservationHoldDeadlineMigration.test.ts src/lib/__tests__/notificationRoutes.test.ts src/hooks/__tests__/useContractLifecycle.test.ts src/hooks/__tests__/useContractSettlement.test.ts src/hooks/__tests__/useContractMovements.test.ts src/hooks/__tests__/realtimeTenantBoundary.test.ts src/components/contracts/contract-form/useContractSubmit.test.ts
```

Log đầy đủ: `baseline-vitest.txt`. Không chạy lại baseline sau mỗi lần sửa văn bản vì không đổi app/source test.

## Chưa xác minh, chưa thực hiện

- Live catalog: function bodies sau patch, ACL/owner/search_path, flags, constraints, RLS, cron và publication.
- JWT/role/PostgREST với schema mới; SQL concurrency/locks, tiền/reconcile/spend mới, mutation tests V01–V35.
- E2E ghi dữ liệu của các chức năng đề xuất, DOCX snapshot thực, chi phí/độ trễ public polling, push thật.
- Backfill/migration/restore/rollback rehearsal; quyền và chính sách billing ký trước nhận cần chốt theo gate.
- Typecheck/build/bundle toàn app không chạy cho lượt chỉ viết plan; không gắn nhãn PASS cho các bước này. Full docs-site image gate không chạy, chỉ link checker ở trên.

Không đọc vault; không apply migration; không ghi database production/TEST; không deploy/push. Working tree chỉ thêm tài liệu/bằng chứng của nhiệm vụ. File migration newline-dirty có sẵn được giữ nguyên và không đưa từ working tree vào snapshot.

Các file mới được ghi là plan, ba báo cáo domain, prompt audit, ghi chú rà chéo, inventory và biên bản/tiện ích đóng gói. Nhiều file source trong ZIP chỉ giúp reviewer tìm callers; không được diễn giải số lượng file kèm thành số lượng file đã review thủ công.
