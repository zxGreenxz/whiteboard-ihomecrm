---
status: current
reviewed: 2026-08-14
source_paths:
  - docs/generated/repository-inventory.json
copilot_ingest: false
risk: normal
---

> **SINH TỰ ĐỘNG — đừng sửa tay.** `node scripts/generate-docs-views.mjs`
> Sửa ở đây tạo nguồn sự thật thứ hai, và nó sẽ trôi khỏi manifest trong vài ngày.

# Kiểm kê: test nào đọc MÃ NGUỒN thay vì import nó

Một test đọc `src/App.tsx` rồi khẳng định trên VĂN BẢN của nó không kiểm hành vi —
nó kiểm cách viết. Refactor không đổi hành vi vẫn làm nó đỏ; và refactor CÓ đổi hành
vi vẫn để nó xanh nếu chuỗi được tìm còn nguyên.

- **529** file test, **168** file đọc file bằng fs (430 lời gọi)
- **232** lời gọi **KHÔNG phân loại được** — đường dẫn dựng lúc chạy.
  Đây là giới hạn của phép đo, không phải "không có gì". Bộ kiểm kê không dùng AST
  (để chạy được ở mọi runner không cần parser TypeScript), nên nó phải nói ra chỗ mình mù.

## Theo loại file được đọc

| Loại | Số file | Vì sao đáng/không đáng lo |
|---|---|---|
| sql | 46 | Đọc migration/SQL. Thường hợp lệ: SQL không import được, và nội dung CHÍNH LÀ hợp đồng. |
| ma-nguon | 35 | Đọc mã nguồn rồi khẳng định trên văn bản — thứ cần chuyển sang data-driven. |
| manifest | 29 | Đọc manifest/cấu hình. Hợp lệ: đây đúng là dữ liệu, và lệch manifest là thứ cần canh. |
| tai-lieu | 8 | Đọc tài liệu/asset. |
| powershell | 3 | Đọc script PowerShell. Hợp lệ vì lý do như SQL. |

## 35 file đọc MÃ NGUỒN

Đây là danh sách §0.2/C10 cần: những file nên chuyển sang data-driven.

- `infra/openclaw-media-gateway/test/security.test.ts`
- `infra/openclaw-zalo/test/task20-adapters.test.ts`
- `scripts/__tests__/business-performance-gated-data-rollout.test.mjs`
- `scripts/__tests__/deploy-openclaw-edge-bundle.test.mjs`
- `scripts/__tests__/gen-supabase-types.test.ts`
- `scripts/__tests__/generate-repository-inventory.test.mjs`
- `scripts/__tests__/network-center-worker-release-readback.test.mjs`
- `scripts/__tests__/network-center-worker-scope-verifier.test.mjs`
- `scripts/__tests__/openclaw-host-isolation.test.mjs`
- `scripts/__tests__/openclawCommandContract.test.mjs`
- `services/openclaw-zalo-cell/session-crypto/src/daemon.test.ts`
- `services/openclaw-zalo-cell/test/image-contract.test.mjs`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/test/control-patched-source.test.ts`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/test/egress-patched-source.test.ts`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/test/inbound-patched-source.test.ts`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/test/outbound-patched-source.test.ts`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/test/reproducible-pack.test.ts`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/test/vendor-integrity.test.ts`
- `src/components/finance-performance/__tests__/BuildingPerformanceTab.test.tsx`
- `src/components/finance-performance/__tests__/BusinessOverviewTab.test.tsx`
- `src/components/finance-performance/__tests__/RevenueCostStructureTab.test.tsx`
- `src/components/openclaw-zalo/__tests__/cockpitWiring.test.tsx`
- `src/hooks/__tests__/incomeExpenseTypeWriterOrganizationScope.test.ts`
- `src/hooks/__tests__/realtimeTenantBoundary.test.ts`
- `src/hooks/__tests__/useManagerSalaryOrganizationScope.test.ts`
- `src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts`
- `src/lib/__tests__/accountingHistoryResolutionMigration.test.ts`
- `src/lib/__tests__/docsDemoSeedP3.test.ts`
- `src/lib/__tests__/financeV2Characterization.test.ts`
- `src/lib/__tests__/ieGuardHandoverScopeMigration.test.ts`
- `src/lib/__tests__/networkCenterDatabaseRuntimeSafety.test.ts`
- `src/lib/__tests__/permissionPages.test.ts`
- `src/lib/__tests__/profitClose.test.ts`
- `src/lib/__tests__/salaryCompletionDate.test.ts`
- `src/pages/reports/finance/__tests__/BusinessPerformanceReportPage.test.tsx`
