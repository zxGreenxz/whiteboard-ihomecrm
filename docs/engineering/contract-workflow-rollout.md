# Contract workflow — hồ sơ rollout 28/09/2026

Trạng thái: **candidate, chưa áp dụng PROD**. Đây là bằng chứng để review và chuẩn bị phát hành theo [Project Contract §3–5](PROJECT_CONTRACT.md#3-git-review-và-phát-hành), không phải biên nhận apply hoặc miễn gate. SHA và object vắng mặt lấy từ [migration-provenance.json](../../supabase/migration-provenance.json) sinh `2026-09-28T04:30:18.586Z`, project PROD `tryymsxyyckgbrmmvozx`; cả 13 file vẫn `unknown`. [migration-unknown-review.json](../../supabase/migration-unknown-review.json) ghi `chua-ap-dung-cho-y` theo tiền lệ hiện hữu.

## Phạm vi candidate

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
| `reminder-cron-test-live.json`, `reminder-cron-mutations.json` | Scheduler SHA `9bd7d15828e87e05cdd7eac55caee4badf4b36ff9404b1ac9fc474e5d667ceb3` APPROVED độc lập; reviewer chạy riêng **7/7 PASS**,11:29:55 ICT. Author actual TEST apply2x/no PRODjob/unchanged other jobs/private ACL **3checks PASS**, rollback/no HTTP;3mutants caught RED/restore. Local cron/net/vault explicit stub; chưa enqueue/invoke PROD. |
| `notice-transition-live.json` | PASS apply2x rollback, renewal KEEP/CANCEL, transfer clear notice cũ, replay/CAS/audit. Xác nhận fixtures không còn, cài riêng migration35250 lên TEST đúng SHA và yêu cầu schema reload. SQL authenticated role; chưa HTTP JWT wrapper/E2E. |
| `draft-sign-e2e.json`, `task-draft-sign-storage-e2e-report.md` | PASS headless owner desktop: byte DOCX/private storage thật, saved revision/template, tải nháp/chính thức đúng SHA, sign/replay/reload, cleanup DB/storage. Nhánh no-hold/cọc0/no active meters; trước guard mapping cuối. Spec: [contract-draft-sign-storage.spec.ts](../../.e2e-fleet/specs/contract-draft-sign-storage.spec.ts). |

## Giới hạn cần giữ khi phát hành

- `OLD_DEPOSIT_OFFSET` chỉ lưu lựa chọn/lịch sử để đối soát và chặn ký: chưa hỗ trợ chuyển cọc giữa hai hợp đồng. Không tuyên bố đã cấn/chuyển phiếu.
- Nhánh receipt cọc dương chưa đạt actual TEST: fixture DEMO vướng `42501` từ quyền tạo nguồn hiện hành; `reservation-positive-live.json` ghi FAIL ở bước xác định authority. Không nới quyền hoặc dùng mock để tính là PASS.
- BROKER/phiếu hoa hồng thực tế chưa được chứng minh end-to-end. Fee preview/link pin 50% cọc theo hợp đồng và adapter có test local; không suy thành chứng từ thực đã chạy. BROKER+FORFEIT và phiếu hoa hồng amount0 còn bất tương thích với cơ chế hiện hành, cần đối soát theo thông báo UI.
- Edge `lifecycle-reminders` và cron chưa deploy. Scheduler riêng15phút đã chuẩn bị trong migration42301; private dispatcher chỉ gọi endpoint lifecycle PROD cố định, cần Vault slot `lifecycle_reminders_service_jwt` chứa current PROD service JWT trước apply. TEST marker chặn PRODjob/dispatch; TEST bootstrap sở hữu job riêng. TEST không có VAPID theo thiết kế; inbox thành công khác push. Chưa chứng minh lịch sweep/provider/device hoạt động ngoài trình duyệt; ba nguồn giới hạn notice, turnover, pending exit.
- Client cũ gọi trực tiếp `renew_contract`/`transfer_room` không được hai adapter mới bảo đảm KEEP/CANCEL; UI mới đã dùng wrapper. Không có global cutover trong candidate này.
- PROD chưa áp 13 migration; chưa phát hành app/Edge của candidate. Gate, review, backup, exact-SHA apply và biên nhận catalog/types sau apply vẫn bắt buộc theo Contract. Không dùng trạng thái TEST hoặc mục review `chua-ap-dung-cho-y` để bỏ qua các bước đó.
