# P0c fix1 — đóng ba lỗ oracle từ review

Base: `449de52e11400b8f2df48d011d6dcf229683b624`. Phạm vi chỉ oracle harness, test âm, README và evidence mới. Không sửa app, engine tiền, schema, policy, transport hoặc P0d.

## Sửa và đối chiếu review

Đã kiểm mã: ba nhận xét Important đúng. Evidence P0c trước ghi lại bốn kết quả đã quan sát nhưng reusable oracle lúc đó chưa được review chấp nhận.

Thêm `assertSettlementSources` trong financial-fixture.mjs, gọi trực tiếp từ live runFinancialScenario và local tests:

1. FORFEIT đòi đúng hai ID hóa đơn mới từ response writer (extra + settlement), không trùng/thiếu/rekey; extra đúng APPROVED/SETTLEMENT,total75000,paid0,remaining75000. Delta receivable phải -175000. Hóa đơn đã có vẫn đi qua oracle cancellation cũ.
2. Đòi một lot credit gốc ACTIVE amount/remaining50000; after phải giữ đúng tập ID/cardinality, amount50000, CONSUMED và remaining0. Không coi mảng rỗng là tiêu đúng.
3. Refund đúng một nguồn termination.refund, ID mới khớp writer, EXPENSE/CASHBOOK/UNPOSTED/UNAPPROVED, amount800000, accountNULL và cashdelta0. Pair FORFEIT đúng mỗi source một dòng, ID khớp writer, offsetEXPENSE/revenueINCOME, APPROVED/NON_CASH/NOT_APPLICABLE/amount1m và joined virtual account hợp lệ.

Evidence mới lưu writerSourceIds (chỉ ID synthetic), so sánh nguồn theo snapshot contract-scoped. Không xuất account/actor/tenant dữ liệu thật. Snapshot lịch sử giữ nguyên để phân biệt lượt trước và fix1.

## TDD/local

`baseline-sources.test.mjs` chứa 24 tests: positive control của FORFEIT/REFUND và 23 biến thể sai. Có missing/wrong/rekey/duplicate extra invoice; missing/rekey/duplicate/amount/status credit; duplicated pair source/wrongtype/posting/source/rekey; refund noncash/wrongposting/type/missing/duplicate/rekey.

Tests dùng copied committed artifact `2026-09-27T17-33-55.965Z-financial-baseline.json`; response source pointers được dựng từ các row lịch sử vì artifact cũ chưa lưu response. Đó là oracle sensitivity trong RAM, không là SQL mutation hay live proof. Chính hàm assertSettlementSources được live runner gọi, không có oracle test riêng khác logic.

Runtime prefix: `npm exec --yes --package=node@24.18.0 -- node`.

- RED `--test scripts/tests/contract-lifecycle/baseline-sources.test.mjs`:24fail vì shared assertion chưa tồn tại, assertion typeof undefined/function; không phải parser/import error.
- GREEN sau implementation:24pass0fail0skip.
- Whole local glob `--test scripts/tests/contract-lifecycle/*.test.mjs`:64pass0fail0skip (bao gồm P0d hiện có).
- `scripts/check-test-matrix.mjs`:791files/13suites PASS, globCI đã bao phủ file mới.
- `git diff --check`:PASS.

## Live TEST

Lệnh `scripts/contract-lifecycle/baseline.mjs --test --vault --ca-file .superpowers/sdd/2026-09-27-contract-lifecycle/supabase-ca.crt` với pinned prefix:PASS4/4, exit0. Tất cả rollbackAbsent=true qua read-only transaction mới.

Artifact mới `docs/generated/contract-lifecycle/2026-09-27T17-54-00.899Z-financial-baseline.json`.
Run `p0c-ce8ea93d-151a-42ce-aaf7-6c754841c513`.
Harness SHA256 `0ff6994ce8faf859106ef9303b6ed10104ef98bb55790520149141f6af4b52f2` đã tính lại khớp file source sau mutation/restore.
Git SHA evidence là base449de52e; digest mã harness ràng buộc đúng thay đổi chưa commit tại lúc chạy.

Giữ các kết quả quan sát trước: FORFEIT cash0/receivable-175k; REFUND800k unposted/cash0 và UI approvalP0001 khi không sổ; DEBT500k còn nợ/cash0; PAID500k thu thật. Credit FORFEIT lot50k còn row CONSUMED/remaining0. Không đổi flags, cấu hình fixture riêng luôn rollback.

## Mutation evidence

Cả hai lệnh dùng `scripts/dot-bien.mjs --file scripts/tests/contract-lifecycle/financial-fixture.mjs --suite 'node --test scripts/tests/contract-lifecycle/baseline-sources.test.mjs' --mong-doi-chua 'Missing expected exception'`.

- `--tim 'assert.deepEqual(after.credit.map' --thay 'void (after.credit.map'`:hash5d51bb55285d→4b4a4efd9415; suite exit1 đúng Missing expected exception; finally restored5d51bb55285d; helper exit0PASS.
- `--tim 'assert.equal(row.posting_status,status,' --thay 'void (row.posting_status,status,'`:hash5d51bb55285d→b160968fd64e; suite exit1 đúng Missing expected exception; finally restored5d51bb55285d; helper exit0PASS.
- Rerun focused suite sau restore:24pass0fail0skip. Không có mutation database/permission.

## Chưa kiểm / tích hợp

Chờ fresh scoped independent review. Không tuyên bố P0 hoàn tất hoặc release. Successful postcommit approval/payout, realJWTmutations, concurrency, cross-tenant denial/E2E/actualDBpermission mutations vẫn chưa được task này kiểm chứng. Parent sở hữu combined global/credentialed gates. Không push/deploy. Không thay parent inventory/P0d files.

Commit: c016e9c5886a8417e67873582ef7caa4f5f6d7ce. Named4files, trailer đúng Contract, không push.
