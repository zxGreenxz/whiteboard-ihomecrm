# Contract workflow — hồ sơ rollout 28/09/2026

Checkpoint trước khi promote web, 28/09/2026: **PROD 13/13 migration đã apply; Edge v1 ACTIVE; cron đã được quan sát chạy; app chưa promote**. Bằng chứng cron PROD là tương quan thời gian giữa run, HTTP và health, chưa phải liên kết chính xác request. Đây là hồ sơ theo [Project Contract §3–5](PROJECT_CONTRACT.md#3-git-review-và-phát-hành), không thay thế biên nhận apply hoặc miễn gate. Kết quả phát hành web sau checkpoint này được cập nhật tại [PR87](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/87).

Project PROD là `tryymsxyyckgbrmmvozx`. [migration-provenance.json](../../supabase/migration-provenance.json) đã sinh lại, cả 13 migration ghi `ledger-applied` dựa trên biên nhận forward lane. [migration-unknown-review.json](../../supabase/migration-unknown-review.json) chỉ gỡ 13 mục của rollout này, giữ các mục khác; không backfill ledger lịch sử. Hồ sơ candidate ban đầu lúc `2026-09-28T04:30:18.586Z` không được dùng thay trạng thái sau apply.

## Trạng thái phát hành

| Bước | Bằng chứng/trạng thái |
|---|---|
| PR CI | SUCCESS trên SHA `a16a99cdab28f54b02a99d3874ba4b3d07eea2da`, [PR87](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/87). Không gán kết quả này cho commit biên nhận/main mới chưa được kiểm. |
| PROD SQL 1–13 | Đã apply tuần tự qua forward lane; đủ 13 biên nhận trong `docs/generated/schema-change-evidence/`, gồm backup và catalog trước/sau, đã commit tại HEAD `a087a5278592dcdf0be675768e3ce640b76e4614`. Số thứ tự theo release plan, không theo timestamp. |
| PROD SQL 13 | [Biên nhận cron](../generated/schema-change-evidence/20260928042301_lifecycle_reminder_cron.json) ghi apply lúc 05:59:40 UTC, đúng SHA `9bd7d15828e87e05cdd7eac55caee4badf4b36ff9404b1ac9fc474e5d667ceb3`, có backup và catalog. |
| PROD Edge | `lifecycle-reminders` version 1 ACTIVE, `verify_jwt=true`; receipt `production-lifecycle-reminders-deploy.json` ghi VERIFIED_CONFIGURED_AND_DEPLOYED lúc 05:56:28 UTC, reviewed HEAD `3df3ade8657646afe6aa09345bbcc8d2b92a1edf`. Dedicated Edge secret và Vault cùng token đã đối chiếu digest. Deploy không dispatch. |
| PROD cron | Job `lifecycle-reminders-15m` ACTIVE, `*/15 * * * *`, gọi private dispatcher. Tick tự nhiên 06:00 UTC succeeded; quan sát cùng thời gian có response dạng P5 HTTP200/oktrue và healthOK mới. Trạng thái receipt: `OBSERVED_SCHEDULE_HTTP_HEALTH_TEMPORAL_CORRELATION`; chưa liên kết chính xác request-id. |
| Catalog/types/provenance sau apply | Catalog cuối SQL 13 ghi 267 logical tables/1725 functions; provenance cả 13 đã cập nhật từ biên nhận. Types CLI bằng PROD PAT và normalize PASS, types không diff so với candidate đã review. Edge/RPC/realtime surfaces sinh từ PROD PASS. |
| Prepush artifacts cuối | `production-artifacts-prepush.log` exit0, 41 gate tĩnh/51 giây. Lượt chỉ đổi docs/generated release dùng `--khong-dao-strict --khong-do-ro-org`; full feature 44 gate đã đạt trước đó. Đây không thay CI/security của main cuối. |
| Main và CI | Chờ tích hợp main và CI của SHA cuối; SUCCESS a16a99cd là CI PR đã có, không phải chứng cứ main hiện tại. |
| App production | Chưa promote; chờ biên nhận promote đúng SHA và deployment. |
| UAT PROD | Chưa có kết quả UAT sau phát hành app. TEST E2E không được tính thay UAT PROD. |

## Phạm vi phát hành

Luồng gồm nháp/tài liệu, báo trả, trả thực tế và quyết toán sau, chỉ số vật lý, dọn/sửa, sale, giữ chỗ, ký/nhận phòng, nhắc việc lifecycle và liên kết hai hợp đồng nhượng đã chốt. Các adapter quyết toán/nhận cọc/hoa hồng gọi cơ chế hiện hành; không thiết kế lại bộ máy thu–chi, quyền hoặc chính sách tiền. Phòng trống đang chuẩn bị vẫn xuất hiện trong sale với dữ kiện ngày sẵn sàng; ngày hết hạn hợp đồng không tự trở thành báo trả.

| Migration trong `supabase/migrations/` | Focused test trực tiếp |
|---|---|
| [20260928013138_contract_moveout_notice_workflow.sql](../../supabase/migrations/20260928013138_contract_moveout_notice_workflow.sql) | [contractMoveOutNoticeMigration.test.ts](../../src/lib/__tests__/contractMoveOutNoticeMigration.test.ts) |
| [20260928013253_contract_drafts_workflow.sql](../../supabase/migrations/20260928013253_contract_drafts_workflow.sql) | [contractDraftMigration.test.ts](../../src/lib/__tests__/contractDraftMigration.test.ts) |
| [20260928015559_contract_exit_case_workflow.sql](../../supabase/migrations/20260928015559_contract_exit_case_workflow.sql) | [contractExitCaseMigration.test.ts](../../src/lib/__tests__/contractExitCaseMigration.test.ts) |
| [20260928015735_room_turnover_workflow.sql](../../supabase/migrations/20260928015735_room_turnover_workflow.sql) | [turnoverMigration.test.ts](../../src/lib/contract-lifecycle/__tests__/turnoverMigration.test.ts) |
| [20260928021213_room_sale_workflow_facts.sql](../../supabase/migrations/20260928021213_room_sale_workflow_facts.sql) | [roomSaleMigration.test.ts](../../src/lib/__tests__/roomSaleMigration.test.ts) |
| [20260928023413_contract_meter_boundaries.sql](../../supabase/migrations/20260928023413_contract_meter_boundaries.sql) | [contractMeterBoundaryMigration.test.ts](../../src/lib/__tests__/contractMeterBoundaryMigration.test.ts) |
| [20260928024559_contract_draft_sign_checkin.sql](../../supabase/migrations/20260928024559_contract_draft_sign_checkin.sql) | [contractSigningMigration.test.ts](../../src/lib/__tests__/contractSigningMigration.test.ts) |
| [20260928024843_lifecycle_reminders.sql](../../supabase/migrations/20260928024843_lifecycle_reminders.sql) | [reminders.test.ts](../../src/lib/contract-lifecycle/__tests__/reminders.test.ts), [reminderRunner.test.ts](../../src/lib/contract-lifecycle/__tests__/reminderRunner.test.ts) |
| [20260928025848_room_reservation_workflow.sql](../../supabase/migrations/20260928025848_room_reservation_workflow.sql) | [roomReservationMigration.test.ts](../../src/lib/__tests__/roomReservationMigration.test.ts) |
| [20260928032349_contract_transfer_links.sql](../../supabase/migrations/20260928032349_contract_transfer_links.sql) | [transferMigration.test.ts](../../src/lib/contract-lifecycle/__tests__/transferMigration.test.ts) |
| [20260928035250_contract_notice_action_adapters.sql](../../supabase/migrations/20260928035250_contract_notice_action_adapters.sql) | [noticeTransitions.test.ts](../../src/lib/contract-lifecycle/__tests__/noticeTransitions.test.ts) |
| [20260928035400_contract_meter_followups.sql](../../supabase/migrations/20260928035400_contract_meter_followups.sql) | [contractMeterFollowups.test.ts](../../src/lib/__tests__/contractMeterFollowups.test.ts) |
| [20260928042301_lifecycle_reminder_cron.sql](../../supabase/migrations/20260928042301_lifecycle_reminder_cron.sql) | [lifecycle-reminder-cron-migration.test.ts](../../scripts/__tests__/lifecycle-reminder-cron-migration.test.ts) |

## Bằng chứng TEST

Target riêng `hzulujxgonszuleqticb`. Các artifact dưới `.superpowers/sdd/2026-09-27-contract-lifecycle/` là bằng chứng cục bộ ignored; người review cần nhận chúng cùng hồ sơ, không coi chúng là biên nhận PROD. Test local dùng stub cho các seam hiện hành không chứng minh posting tiền thực tế.

Kiểm hồ sơ lần đầu 12 file: `check-unknown-review.mjs` và `check-migration-provenance.mjs` exit0; SHA/missingObjects khớp file/provenance, mọi mục review cũ giữ nguyên. Mục13 scheduler bổ sung từ provenance mới đúng SHA đã review; gate candidate do parent chạy sau freeze. Cảnh báo hồ sơ cũ thừa và nợ provenance còn được báo, không sửa hoặc miễn trong lượt này.

| Artifact | Kết quả và giới hạn |
|---|---|
| `notice-live.json`, `drafts-live.json`, `turnover-live.json`, `sale-live.json` | PASS actual Postgres, áp hai lượt; auth/CAS/replay/scope và hành vi trực tiếp tương ứng. Fixtures rollback. SHA khớp provenance hiện tại. |
| `workflow-jwt.json`, `reminders-jwt.json` | PASS HTTP JWT notice/draft và inbox lifecycle theo org; stale/cross-org/anonymous/service-only denial. Fixtures đã dọn. Không phải ma trận mọi vai trò. |
| `return-live.json` | PASS actual deferred return/replay, late FORFEIT qua entrypoint hiện hành và B/room không đổi ở digest trước. Digest cuối return `8e6a3dd77890d23a875885ab1bc70806ad9dd3fa24886d7fd8b29c507ca1fdee` sau chuẩn hóa whitespace được kiểm lại **25/25** local (exit domain9 + migration16, Node24, 11:17:52 ICT); không gán SHA mới cho biên nhận TEST cũ. |
| `transfer-live.json` | PASS compose đúng SHA cuối B1/P9/P11/EX01/followup, no-hold/hold0/replay, incoming0 khác missing, selected service dùng reading thực, old missing vẫn queue sau FINALIZED, SELF_FOUND/offset và B/room giữ nguyên. |
| `reminders-live.json` | PASS đúng SHA cuối, ba nguồn lifecycle, service-only, bổ sung nguồn cùng ngày cập nhật refs/count không thêm digest, recheck người nhận, lease/CAS/retry. Chưa chứng minh provider push. |
| `reminder-cron-test-live.json`, `reminder-cron-mutations.json` | Scheduler SHA `9bd7d15828e87e05cdd7eac55caee4badf4b36ff9404b1ac9fc474e5d667ceb3` APPROVED độc lập; reviewer chạy riêng **7/7 PASS**,11:29:55 ICT. Author actual TEST apply2x/no PRODjob/unchanged other jobs/private ACL **3checks PASS**, rollback/no HTTP;3mutants caught RED/restore. Local cron/net/vault explicit stub; lượt rollback này không enqueue/invoke PROD. |
| `reminder-release-proof-v2.json` | PASS actual TEST explicit dispatch tại SHA `a16a99cdab28f54b02a99d3874ba4b3d07eea2da`, Edge version3 ACTIVE/verify_jwt=true; request4 HTTP200/oktrue và healthOK tăng lúc05:03:28UTC. Dedicated Edge secret trùng current service JWT; không VAPID. inserted0/delivered0; không chứng minh provider/device. |
| `reminder-natural-proof-v2.json` | PASS cron tự chạy05:15UTC sau auth deploy, own job26/run23→request5 HTTP200/oktrue; healthOK/last_success_at05:15:03UTC. Chỉ đọc TEST khi kiểm tick, không kích hoạt thêm HTTP. Lịch sweep server đã được chứng minh không cần mở trình duyệt; lượt này inserted0/delivered0. |
| `reminder-key-compatibility.json`, `reminder-auth-mutations.json`, `reminder-auth-independent-review.json` | Lỗi v1 handler401 được giữ lịch sử; API/Vault token trùng nhau nhưng built-in Edge credential khác. Sửa dùng dedicated exact-match credential, giữ native built-in DB key và verify_jwt=true;27 test/2 mutants đạt, review độc lập12/12. Không sửa quyền hay tắt gateway JWT. |
| `notice-transition-live.json` | PASS apply2x rollback, renewal KEEP/CANCEL, transfer clear notice cũ, replay/CAS/audit. Xác nhận fixtures không còn, cài riêng migration35250 lên TEST đúng SHA và yêu cầu schema reload. SQL authenticated role; chưa HTTP JWT wrapper/E2E. |
| `draft-sign-e2e.json`, `task-draft-sign-storage-e2e-report.md` | PASS headless owner desktop: byte DOCX/private storage thật, saved revision/template, tải nháp/chính thức đúng SHA, sign/replay/reload, cleanup DB/storage. Nhánh no-hold/cọc0/no active meters; trước guard mapping cuối. Spec: [contract-draft-sign-storage.spec.ts](../../.e2e-fleet/specs/contract-draft-sign-storage.spec.ts). |

## Bằng chứng PROD đã nhận

`production-lifecycle-reminders-deploy.json` là biên nhận ignored của thao tác cấu hình/deploy Edge, không phải receipt migration. Script digest `133950a0ef1e75b68ed3c01dcc06c2741bd7cc1548bea8716177eaca0fa13234` đã review độc lập; hai source SHA256 là index `0a4ff909ed1a4192ae4049eeb44ed23ff5f0281fd0287f6cc322ab89a548f7cb` và runner `da58d08816fbf0f75a0c717d3dee7dfed3638a553174010a127447b4e28a7388`; descriptor digest `50b2a6e37a4b665666fc11e7debc7969b730c8a4538fe944abd7f8bd0d86e99b`. Biên nhận ghi exact source/clean reviewed HEAD, credential Edge/Vault trùng digest, version 1 ACTIVE và verify_jwt=true. Không chứa token; thao tác deploy không dispatch hoặc ghi dữ liệu nghiệp vụ.

SQL 13 đã apply qua forward lane lúc 05:59:40 UTC. Receipt ignored `production-lifecycle-reminders-natural-2026-09-28T06-00-50-681Z.json` ghi job 500 ACTIVE và run 260762 succeeded lúc 06:00 UTC, sau deploy. Trong cùng cửa sổ quan sát có một response dạng lifecycle HTTP200/oktrue, batches0/delivered0; aggregate health statusOK và last_success_at06:00:03.402376UTC. Trạng thái là `OBSERVED_SCHEDULE_HTTP_HEALTH_TEMPORAL_CORRELATION`: không lấy được request-id từ cron và net response không có URL, nên chỉ chứng minh tương quan thời gian, không gán response candidate1 chính xác cho run này. Runner chứng minh bằng một lượt đọc, không tự dispatch/sweep, không đọc nội dung thông báo, không probe provider/device.

## Giới hạn cần giữ khi phát hành

- `OLD_DEPOSIT_OFFSET` chỉ lưu lựa chọn/lịch sử để đối soát và chặn ký: chưa hỗ trợ chuyển cọc giữa hai hợp đồng. Không tuyên bố đã cấn/chuyển phiếu.
- Nhánh receipt cọc dương chưa đạt actual TEST: fixture DEMO vướng `42501` từ quyền tạo nguồn hiện hành; `reservation-positive-live.json` ghi FAIL ở bước xác định authority. Không nới quyền hoặc dùng mock để tính là PASS.
- BROKER/phiếu hoa hồng thực tế chưa được chứng minh end-to-end. Fee preview/link pin 50% cọc theo hợp đồng và adapter có test local; không suy thành chứng từ thực đã chạy. BROKER+FORFEIT và phiếu hoa hồng amount0 còn bất tương thích với cơ chế hiện hành, cần đối soát theo thông báo UI.
- PROD Edge `lifecycle-reminders` đã deploy, credential Edge/Vault cùng token, cron 15 phút đã cài và quan sát tick tự nhiên/HTTP/health theo tương quan thời gian. Chưa chứng minh liên kết request-id chính xác hoặc provider/device. Private dispatcher chỉ gọi endpoint lifecycle PROD cố định; Edge giữ `verify_jwt=true`, exact-match `LIFECYCLE_REMINDERS_SERVICE_JWT` và dùng khóa built-in riêng cho DB; Vault slot là `lifecycle_reminders_service_jwt`. TEST đã chứng minh explicit và natural tick với liên kết request riêng; giữ receipt401 v1 làm lịch sử. TEST marker chặn PRODjob/dispatch, TEST bootstrap sở hữu job riêng và không có VAPID theo thiết kế. Ba nguồn chỉ gồm notice, turnover, pending exit.
- Client cũ gọi trực tiếp `renew_contract`/`transfer_room` không được hai adapter mới bảo đảm KEEP/CANCEL; UI mới đã dùng wrapper. Không có global cutover trong candidate này.
- PROD đủ 13 biên nhận SQL, Edge/cron đã cài, types/surface/provenance/prepush artifacts cuối đạt; app/main CI/security/promote/UAT còn chờ. Gate, review, backup và exact-SHA release vẫn bắt buộc theo Contract. Không dùng trạng thái TEST hoặc review candidate ban đầu để bỏ qua các bước đó.
- Worker Zalo: nơi chạy/vận hành còn cần xác định; không có bằng chứng deploy, gửi provider hoặc nhận thiết bị mới trong rollout này.
