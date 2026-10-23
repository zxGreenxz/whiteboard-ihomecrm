---
status: current
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

- **1638** file test, **428** file đọc file bằng fs (1064 lời gọi)
- **468** lời gọi **KHÔNG phân loại được** — đường dẫn dựng lúc chạy.
  Đây là giới hạn của phép đo, không phải "không có gì". Bộ kiểm kê không dùng AST
  (để chạy được ở mọi runner không cần parser TypeScript), nên nó phải nói ra chỗ mình mù.

## Theo loại file được đọc

| Loại | Số file | Vì sao đáng/không đáng lo |
|---|---|---|
| sql | 174 | Đọc migration/SQL. Thường hợp lệ: SQL không import được, và nội dung CHÍNH LÀ hợp đồng. |
| ma-nguon | 61 | Đọc mã nguồn rồi khẳng định trên văn bản — thứ cần chuyển sang data-driven. |
| manifest | 61 | Đọc manifest/cấu hình. Hợp lệ: đây đúng là dữ liệu, và lệch manifest là thứ cần canh. |
| tai-lieu | 14 | Đọc tài liệu/asset. |
| powershell | 3 | Đọc script PowerShell. Hợp lệ vì lý do như SQL. |

## 61 file đọc MÃ NGUỒN

Đây là danh sách §0.2/C10 cần: những file nên chuyển sang data-driven.

- `.e2e-fleet/controlled/copilot-approval-readback.test.mjs`
- `infra/hermes-broker/confirm-guard.test.mjs`
- `infra/hermes-broker/read-catalog-authority.test.mjs`
- `infra/hermes-broker/room-pass-upsert-mutation.test.mjs`
- `infra/hermes-runtime/host-cli.test.mjs`
- `scripts/__tests__/apply-reviewed-migration.test.mjs`
- `scripts/__tests__/business-performance-gated-data-rollout.test.mjs`
- `scripts/__tests__/check-copilot-docs-manifest.test.mjs`
- `scripts/__tests__/copilot-g1-acceptance.test.mjs`
- `scripts/__tests__/copilot-room-pass-live-acceptance.test.mjs`
- `scripts/__tests__/e2e-fleet-read-rpc-allowlist.test.mjs`
- `scripts/__tests__/gate-e2e-local-evidence.test.mjs`
- `scripts/__tests__/gen-supabase-types.test.ts`
- `scripts/__tests__/generate-repository-inventory.test.mjs`
- `scripts/__tests__/hermes-cde-live.test.mjs`
- `scripts/__tests__/hermes-durable-store.test.mjs`
- `scripts/__tests__/hermes-private-flow.test.mjs`
- `scripts/__tests__/lifecycle-reminder-edge-auth.test.ts`
- `scripts/__tests__/network-center-worker-release-readback.test.mjs`
- `scripts/__tests__/network-center-worker-scope-verifier.test.mjs`
- `scripts/__tests__/qr-csp-bindings.test.mjs`
- `scripts/__tests__/super-admin-route-contract.test.mjs`
- `scripts/__tests__/test-hermes-broker-authz.test.mjs`
- `scripts/org-context-repair/sealed-artifact.test.mjs`
- `src/components/errors/ErrorBoundary.pageNames.test.tsx`
- `src/components/finance-performance/__tests__/BuildingPerformanceTab.test.tsx`
- `src/components/finance-performance/__tests__/BusinessOverviewTab.test.tsx`
- `src/components/finance-performance/__tests__/RevenueCostStructureTab.test.tsx`
- `src/components/income-expenses/__tests__/IncomeExpenseFormDongThiKhongDoc.test.tsx`
- `src/contexts/__tests__/OrganizationContext.test.ts`
- `src/copilot/__tests__/confirmationStore.test.ts`
- `src/copilot/__tests__/pageAgentCompatibility.test.ts`
- `src/copilot/__tests__/readonlyQueryContracts.test.ts`
- `src/copilot/__tests__/toolOrgScope.test.ts`
- `src/hooks/__tests__/accountsWithBalanceMasking.test.ts`
- `src/hooks/__tests__/incomeExpenseTypeWriterOrganizationScope.test.ts`
- `src/hooks/__tests__/realtimeTenantBoundary.test.ts`
- `src/hooks/__tests__/useCustomers.deleteActiveContractGuard.test.ts`
- `src/hooks/__tests__/useManagerSalaryOrganizationScope.test.ts`
- `src/hooks/__tests__/useManagerSalaryV5Bulk.test.ts`
- `src/hooks/__tests__/useMeterReadings.noLegacyFallback.test.ts`
- `src/hooks/__tests__/useMeters.serviceResolve.test.ts`
- `src/hooks/__tests__/useMyPermissionsOrgScope.test.tsx`
- `src/hooks/quick-entry/__tests__/quickEntryAi.test.ts`
- `src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts`
- `src/lib/__tests__/accountingHistoryResolutionMigration.test.ts`
- `src/lib/__tests__/copilotReportRpcMigration.test.ts`
- `src/lib/__tests__/copilotSensitiveRpcMigration.test.ts`
- `src/lib/__tests__/docsDemoSeedP3.test.ts`
- `src/lib/__tests__/errorPageNames.test.ts`
- `src/lib/__tests__/financeV2Characterization.test.ts`
- `src/lib/__tests__/ieGuardHandoverScopeMigration.test.ts`
- `src/lib/__tests__/networkCenterDatabaseRuntimeSafety.test.ts`
- `src/lib/__tests__/networkCenterSettingsBoundsMatchDatabase.test.ts`
- `src/lib/__tests__/permissionPages.test.ts`
- `src/lib/__tests__/profitClose.test.ts`
- `src/lib/__tests__/salaryCompletionDate.test.ts`
- `src/lib/quickEntry/__tests__/categorySuggestGolden.test.ts`
- `src/lib/quickEntry/__tests__/models.test.ts`
- `src/pages/phong-trong/__tests__/exportRoomListImage.test.ts`
- `src/pages/reports/finance/__tests__/BusinessPerformanceReportPage.test.tsx`
