# T1 implementer report — data contract Hợp đồng & quyết toán

## Trạng thái

DONE_WITH_CONCERNS. Hoàn thành contract/parser/helper thuần và test invariant trong scope T1. Không sửa SQL, UI, reader hoặc writer.

## Thay đổi

- Tạo `src/lib/contractSettlement.ts` với discriminated source refs cho broker, refund thanh lý, refund giữ chỗ, sale theo hợp đồng và sale theo phiếu cọc.
- Tách source row/voucher row, selection, basis, readiness, action eligibility, review badge, display state, issues, filters và totals.
- Boundary parser kiểm literal enum, safe-integer VND, version thật, maker, ownership readiness và posting evidence. Snapshot sai giữ voucher ID/code nhưng chuyển `unavailable`.
- `CHANGES_REQUESTED` chỉ sinh semantic candidate `RESUBMIT_REVIEW` khi capability đã tải cho phép; giữ voucher ID/code/amount/source. Nguồn chưa tạo dùng candidate `CREATE_VOUCHER` riêng.
- `PAID` chỉ được nhận khi CASHBOOK/POSTED có active posting khớp posting evidence, net amount và posting date. NON_CASH, REVERSED, CANCELLED, bất nhất active posting và UNAPPROVED đã mang posting đều tách nhóm/fail closed.

## Exports cho task sau

- Types: `SettlementKind`, `SettlementSourceRef`, `SettlementBasis`, `Readiness<T>`, `SettlementActionKind`, `ActionEligibility`, `CreateEligibility`, `VoucherSnapshot`, `SettlementSourceRow`, `SettlementVoucherRow`, `SettlementRow`, `SettlementSelection`, `SettlementDisplayCode`, `SettlementIssue`, `SettlementRowAction`, `SettlementTotals`, `SettlementFilters`.
- Helpers: `parseSettlementRow`, `getSettlementDisplayState`, `getSettlementReviewBadge`, `getSettlementRowActions`, `detectSettlementIssues`, `calculateSettlementTotals`, `filterSettlementRows`.
- Reader T2 cần trả `voucherDate`, `sourceEventDate`, `makerUserId`, verified `flowOwnership`, per-action `allowedActions`, và verified `postingEvidence`; không được tự lấp version/state thiếu.

## TDD evidence

### RED 1

Command:

`npx vitest run src/lib/__tests__/contractSettlement.test.ts`

Result: exit 1; suite không import được `../contractSettlement`. Đây là failure đúng nguyên nhân vì module production chưa tồn tại.

### GREEN 1

Command giống RED 1.

Result: 1 file, 20 tests passed.

### RED 2 — review action và badge

Command:

`npx vitest run src/lib/__tests__/contractSettlement.test.ts`

Result: exit 1; 3 tests fail vì `getSettlementReviewBadge` và `getSettlementRowActions` chưa có.

### GREEN 2

Command giống RED 2.

Result: 1 file, 22 tests passed.

### RED 3 — integration invariants

Command:

`npx --yes --package=node@24.18.0 node node_modules/vitest/vitest.mjs run src/lib/__tests__/contractSettlement.test.ts`

Result: exit 1; 4 tests fail đúng các lỗ hổng: readiness bị suy thành resubmit permission, posting evidence không được đối chiếu, UNAPPROVED+POSTED bị nén thành pending, OLD_PERIOD dùng ngày posting.

### GREEN cuối

Command:

`npx --yes --package=node@24.18.0 node node_modules/vitest/vitest.mjs run src/lib/__tests__/contractSettlement.test.ts src/lib/__tests__/financeV2Characterization.test.ts src/hooks/income-expenses/statusMutations.test.ts src/hooks/income-expenses/__tests__/flexCancelGate.test.ts src/hooks/income-expenses/__tests__/incomeCancelGate.test.ts src/hooks/income-expenses/__tests__/supplements.test.tsx src/components/income-expenses/__tests__/reservationDetailActions.test.tsx`

Result: exit 0; 7 files, 99 tests passed. Các warning React Router/Dialog và log lỗi fixture supplement là stderr hiện hữu, không có test fail.

Type checks:

- `npx --yes --package=node@24.18.0 node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json` — exit 0, không output.
- `npm run typecheck:baseline` — exit 0; 0 fingerprint, không lỗi mới.

Mutation:

`node scripts/dot-bien.mjs --file src/lib/contractSettlement.ts --tim 'case "PAID": totals.effectiveNetPaid += row.snapshot.value.effectiveNetPaid; break;' --thay 'case "PAID": totals.pendingAmount += row.snapshot.value.effectiveNetPaid; break;' --suite 'npx --yes --package=node@24.18.0 node node_modules/vitest/vitest.mjs run src/lib/__tests__/contractSettlement.test.ts' --mong-doi-chua 'expected'`

Result: exit 0; SHA đổi thật, suite đỏ đúng kỳ vọng, file được khôi phục đúng digest.

## Concerns / phần chưa xác minh

- Không chạy browser E2E vì T1 không sửa UI.
- Writer proof, role/PostgREST, reader pagination/aggregate và backend capability vẫn là gate T6/T11 theo preflight.
- Các suite characterization hiện hữu khóa action Thu chi và mobile. Fixture render riêng cho dueSum/draftCount/paidSum của cả Panel/Sheet chưa được thêm vì helper tính overview hiện nằm private trong hai component; trích helper/chạm UI nằm ngoài scope file production T1 được giao. Totals domain mới có fixture riêng cho source/pending/unposted/paid/noncash/reversed/cancelled.

## Fix round 1 — review findings

### Nội dung sửa

- `SettlementFilters.period` nay bắt buộc và `OLD_PERIOD` dùng đúng kỳ được chọn. Search giữ metadata mã phiếu, hợp đồng, phòng, khách và người nhận trên cả source/voucher.
- Parser kiểm organization và settlement kind xuyên source row/source link/snapshot. Source row mâu thuẫn bị từ chối; voucher vẫn giữ ID/code, hạ snapshot hoặc source link về unavailable/unverified tương ứng.
- Boundary VND nhận decimal string có phần lẻ toàn số 0 như `2640000.00`, vẫn từ chối `2640000.01` và số vượt safe integer.
- Trích nguyên phép tính Tổng quan hiện hành vào `periodFeeOverview.ts`; cả `PeriodFeePanel` và `PeriodFeeSheet` cùng dùng helper. Fixture cố định khóa `dueSum=1.170.000`, `draftCount=3`, `paidSum=850.000` và việc loại family sổ theo dõi. Semantics due-list giữ nguyên: EN/commission khử trùng tên như trước; GRID một dòng cho mỗi building/category; commission không được tính vào `dueBldCount`, đúng hành vi Panel cũ.
- Bổ sung characterization hành vi thật của Finance V2: approve-only, owned dispatcher, post-only và reverse.

### RED/GREEN

RED command:

`npx --yes --package=node@24.18.0 node node_modules/vitest/vitest.mjs run src/lib/__tests__/contractSettlement.test.ts src/lib/__tests__/periodFeeOverview.test.ts`

Result: exit 1; 12 assertion fail đúng filter/search/consistency và module overview chưa tồn tại. RED decimal boundary chạy riêng: 1 fail vì `2640000.00` bị hạ unavailable.

GREEN focused:

`npx --yes --package=node@24.18.0 node node_modules/vitest/vitest.mjs run src/lib/__tests__/contractSettlement.test.ts src/lib/__tests__/periodFeeOverview.test.ts src/hooks/income-expenses/financeV2Mutations.characterization.test.ts`

Result: exit 0; 3 files, 45 tests passed.

GREEN regression:

`npx --yes --package=node@24.18.0 node node_modules/vitest/vitest.mjs run src/lib/__tests__/contractSettlement.test.ts src/lib/__tests__/periodFeeOverview.test.ts src/hooks/income-expenses/financeV2Mutations.characterization.test.ts src/lib/__tests__/financeV2Characterization.test.ts src/hooks/income-expenses/statusMutations.test.ts src/hooks/income-expenses/__tests__/flexCancelGate.test.ts src/hooks/income-expenses/__tests__/incomeCancelGate.test.ts src/hooks/income-expenses/__tests__/supplements.test.tsx src/components/income-expenses/__tests__/reservationDetailActions.test.tsx`

Result: exit 0; 9 files, 118 tests passed. Stderr chỉ gồm warning React Router/Dialog và log fixture lỗi có chủ đích đã có.

- `npx --yes --package=node@24.18.0 node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`: exit 0.
- `npm run typecheck:baseline`: exit 0, 0 fingerprint.
- Mutation thay kỳ chọn bằng `9999-12`: SHA đổi thật, contract suite đỏ đúng kỳ vọng và digest được khôi phục; helper exit 0.

### Ma trận characterization hiện có và gap giao T4

- Canonical approve-only: `financeV2Mutations.characterization.test.ts:29`; owned dispatcher: dòng 37; post-only: dòng 46; reverse: dòng 55.
- Legacy/canonical approve fallback: `statusMutations.test.ts:97-260`, ordinary legacy path tại dòng 212; unapprove/CAS: dòng 264-350.
- Cancel income/expense và fallback: `incomeCancelGate.test.ts:78-157`, cửa INCOME dòng 112, cửa EXPENSE dòng 135; flex cancellation compatibility ở `flexCancelGate.test.ts:51-106`.
- Supplement phiếu không sửa field tiền: `supplements.test.tsx:26-45`, writer additions-only dòng 41; UI add-document riêng và phiếu đã huỷ/nguồn reservation không lộ money action được khóa tại `reservationDetailActions.test.tsx:37-63`.
- Gap còn lại: chưa có integration characterization cho wiring đầy đủ của `IncomeExpenseMobilePage` và command approve-and-post atomic trên shared controller vì controller T4 chưa tồn tại. T4 phải thêm parity desktop/mobile trên controller dùng chung; T1 không dựng controller trước phụ thuộc.
