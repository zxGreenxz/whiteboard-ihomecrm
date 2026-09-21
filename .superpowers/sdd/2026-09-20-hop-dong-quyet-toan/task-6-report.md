# T6 — capability, adapter và form lập phiếu theo nguồn

Trạng thái: code và kiểm thử local sẵn sàng review. Chưa đóng T6 release: chưa chạy DEMO live matrix/positive-control, chưa áp dụng shared schema, chưa cutover Page cũ. Base phần code riêng: `4741ba2a`; các tệp T5/root và design assets không nằm trong commit này.

## Phạm vi đã làm

- `ContractSettlementCreateForm` nhận `sourceRef`, `onCreated({outcome:'created'|'existing',voucherId})`, `refreshRequired():Promise<void>`, `onBusyChange?(blocked)`. Source hợp lệ gồm broker, sale_contract, sale_deposit dùng actual deposit ID, termination_refund dùng actual termination ID. `reservation_refund` còn thuộc T6R.
- `ContractSettlementSaleProposalSelector({organizationId,onSelectSource})` tìm nguồn hợp đồng/phiếu cọc theo RLS, 30 dòng/trang và khóa org/actor. Đây là đề xuất chủ động; không sinh nghĩa vụ hay lấy trần thưởng làm số tiền được hưởng.
- Repository có kiểu, parser runtime bắt thiếu/mâu thuẫn org/actor/source/basis, và adapter gọi các writer nghiệp vụ. Tất cả bốn lệnh truyền `p_account_id: rpcNullable<string>(null)`. Không có picker/default sổ quỹ, approve/post/compensation/generic create hay fallback sang legacy.
- Trước lệnh ghi: tải nguồn/claim/eligibility mới và so revision đã xem. Sau lệnh: xác minh claim đúng nguồn và snapshot đúng ID/org/type/systemSource, số tiền, UNAPPROVED/PENDING/UNPOSTED, account NULL, active posting NULL. Existing claim được mở theo ID thực/trạng thái thực; không ép amount mới lên phiếu cũ. Network outcome không rõ giữ khóa, đối chiếu đúng nguồn; không tự gửi lại.
- Hook chặn nhấp đúp đồng bộ, giữ khóa khi refresh thất bại/unknown, kiểm identity trước/sau mỗi port, chỉ gọi `onCreated` sau refresh bắt buộc thành công. Invalidate có namespace thực `settlement-financial-context` và `room-cash-lifecycle`.
- Refund giữ preview → record obligation → read đúng ID/version/basis → create. Số tiền chỉ đọc từ nghĩa vụ, ngày do writer quyết định. Warning force cần authority thực, checkbox và lý do >=8 ký tự. Form người nhận/ngân hàng được lưu ngay khi sinh phiếu qua overload mới.

## SQL và những phát hiện đã khép

`20260920212716_contract_settlement_source_creation_reader.sql` thêm authenticated selected-source reader, owner `ie_action_snapshot_reader` NOLOGIN/NOBYPASSRLS. Public reader xác minh active org/member và SELECT nguồn/phòng/toà/khách bằng RLS trước khi gọi helper private. Không cấp bảng private cho authenticated, không cấp write/core cho reader role. Chuyển owner dùng CREATE tạm trong cùng transaction rồi REVOKE như T4A; không giữ CREATE sau commit.

Helper private chỉ cung cấp published tier/cap, actual writer eligibility, claim và projection nghĩa vụ. Không tự suy quyền tạo từ quyền Page. Broker giữ đúng trường hợp building owner mà writer hiện tại cho phép; sale/refund giữ guard hiện hành. Source đọc được nhưng phiếu claim bị RLS che sẽ blocked, không trả hidden voucher ID/code/amount. Refund preview bỏ nested basis chứa voucher IDs; latest obligation chỉ whitelist các trường cần so ID/version/basis, không trả voucher_id/snapshot.

`categories.view` không phải guard tạo thưởng từ cọc. Kiểm deposit marker nằm trong private boolean enrichment sau source RLS; selector lọc item accounting_class DEPOSIT qua RLS thay vì yêu cầu đọc category. Phiếu cọc không gắn phòng vẫn dùng building thực nếu building đọc được; room/building mâu thuẫn bị chặn.

Actual JWT adapter đã phát hiện `termination_refund_obligations` có thể trả 200 [] cho actor đọc được nguồn và được writer cho phép, do `tro_read` lồng RLS membership. Không đổi policy. Repository lấy nghĩa vụ vừa record từ projection `readSource(ref).latestObligation`, buộc ID/version/basis khớp. Version khác chen vào là conflict trước create.

`20260920235851_termination_refund_creation_recipient.sql` khép thiếu recipient persist: body writer cũ được dùng chung trong private core, giữ auth/source/status/force/account/natural claim locks, chỉ thêm payer_name/receive_bank_name/receive_bank_account vào INSERT. Chữ ký public cũ 4 tham số delegate với NULL và giữ ACL cũ; overload mới 7 tham số thêm recipient name/bank/account, kiểm active-org + selected-source RLS trước core, chỉ authenticated gọi được. Core không public/authenticated/service_role/reader EXECUTE. Không update bank sau sinh, không nới freeze. Existing result không overwrite recipient. Đây là capability T6, không đẩy việc sửa frozen recipient sang T5.

Migration pin definition hash/owner/ACL; reader chấp nhận đúng writer refund gốc hoặc đúng cặp wrapper/core T6, nên tự reapply sau recipient migration được. Không sửa migration đã deploy; cả hai file mới vẫn chờ review/forward lane. T4A/B phải có trước reader. Root đã cho áp dụng bản T4B reviewed hiện tại vào original disposable DB để snapshot parser có đủ reservation flags; đã apply thành công, không bypass guard.

## Kiểm chứng

Exact Node 24.18.0 cho các lệnh dưới đây; localhost PG17 `postgres`/55488 và PostgREST16.3/55489, JWT authenticated, fixture org/actor ngẫu nhiên, cleanup `finally`. Không dùng service_role để kiểm writer. Fixture setup/cleanup replica chỉ trong DB dùng một lần; không phải chiến lược cleanup live.

- `node node_modules/vitest/vitest.mjs run src/lib/__tests__/contractSettlementCreate.test.ts src/lib/__tests__/contractSettlementCreateReader.test.ts src/hooks/__tests__/useContractSettlementCreate.test.tsx src/components/thu-tien/__tests__/ContractSettlementCreateForm.test.tsx`: 47 PASS. Có amount/account/source anomalies, scope/revision/hidden/permission denial, date rollover, force/version drift, unknown/refresh failure, double click, org change, recipient form và thiếu refund evidence không giả 0.
- `node scripts/test-contract-settlement-create-local.mjs`: PASS actual TS adapter/parser qua JWT cho 4 nguồn; source read + authoritative action snapshot; recipient tại birth; real-held preview/obligation; force/cross-org denial; cạnh tranh tạo broker chỉ một phiếu sống; cancelled claim cho phép phiếu thay thế; source bị rút bị chặn; hai version refund đồng thời trả cùng ID và không overwrite recipient; hidden claim không lộ ID. Có fixture receipt POSTED kèm active posting nhất quán để thử realHeld; các phiếu mới đều NULL account, pending, zero postings. Đây chưa phải broker autopay VALID positive-control/live proof.
- `node scripts/test-contract-settlement-create-schema-local.mjs`: PASS first apply + reapply dưới non-superuser có measured CREATE/USAGE/CREATEROLE/BYPASSRLS; hash/owner/ACL/role drift bị chặn; private core isolation; transitive STABLE gate. Mọi schema/role mutation trong rehearsal rollback.
- `scripts/dot-bien.mjs`: thay account NULL thành source ID làm suite đỏ đúng ca `passes explicit account NULL`; bỏ canCreate guard làm suite đỏ đúng `blocks permission drift`; cả hai exit0 và khôi phục SHA256. Schema drift mutations cũng được kiểm bằng harness riêng.
- App TS `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`: session72820 và lần cuối70847 exit0. Sáu module production mới compile bằng config strict hiện tại sau chỉnh sửa cuối: 0 owned errors, 0 dependency errors. ESLint sáu module: exit0, 0 warning sau sửa dependency effect.

## Phần còn lại trước hoàn tất/phát hành

1. Independent review SQL/form/adapter và sửa findings; root giữ registry strict/test-matrix/generated types/surfaces/provenance và gate tích hợp.
2. Reviewed `migrate:forward` cho capability mới, đúng backup/preflight/clean SHA; chưa apply shared trong lượt này.
3. Chuẩn bị/dọn fixture DEMO bằng đường nghiệp vụ an toàn; chạy live matrix 5 ca và adapter 4 NULL-account. Broker positive control phải commission_autopay_check_v1 VALID với cọc thực đầy đủ, ACTIVE, start qua 7 ngày và tier đúng. Không dùng zero-deposit fixture hay manual transition authorization để cleanup. Harness cũ `test-contract-settlement-money.mjs` chưa được coi là đã chạy.
4. Root tích hợp hai component vào T8/T9, T6R và cutover Page còn riêng. Browser E2E desktop/mobile theo actor thực, app build/bundle và gates money/sandbox/release còn thuộc lượt tích hợp, chưa được xác minh bởi component tests/local JWT.

Không có shared business/schema writes, live fixture hay tiền DEMO nào phát sinh trong lượt này. Không claim production-ready hoặc T6 release-complete.
