# Đề xuất sửa plan vòng đời hợp đồng

Bản này **tách riêng** khỏi `docs/superpowers/plans/2026-09-27-contract-lifecycle.md`. Plan gốc giữ nguyên để làm căn cứ audit.
- Mỗi mục ghi ID finding trong [`../independent-audit.md`](../independent-audit.md) và vị trí trong plan cần sửa.
- Chỗ nào ghi "(Q…)" là cần chủ chốt trước. Phần đề xuất ở đó chỉ là mặc định để thảo luận.

## A. Global Constraints: thêm mục

1. **TEST phải tương đương production trước mọi nghiệm thu** (IA-08).
   - Sync TEST đúng SHA cần thử và áp đủ các migration đã chạy trên production, kể cả `20260926*`.
   - Preflight so md5 `prosrc` của danh sách hàm liên quan giữa TEST và production (mẫu truy vấn: `live-catalog-prod-20260927/cat-test.sql`). Lệch là dừng.
   - Đăng ký lại cron của TEST sau mỗi lần sync.
2. **Không sửa tại chỗ các hàm bị ghim trong `idempotencyRetirements`** (IA-14). Danh sách 14 hàm có trong `supabase/migration-policy.json`. Cần thay đổi thì làm `_v2` rồi đổi caller.
3. **Cổng DB cho cột vòng đời dùng write-token trong giao dịch** (IA-02). Không dùng `current_user` vì mẫu đó cho DEFINER đi qua. Mọi writer hợp lệ phải tự cấp token; thiếu token thì từ chối, kể cả khi chạy dưới postgres.
4. **Mọi writer tiền và vòng đời dùng allowlist trạng thái** (IA-09), không dùng `NOT IN (...)`.
5. **RPC đọc không gọi `authorize_tenant_action_v3`**, vì hàm này khoá org FOR SHARE và gây 25006 khi gọi qua PostgREST. Dùng `can_v3` / `authorized_scope_v3` (IA-33).

## B. §3.2 Schema

| Đối tượng | Sửa đề xuất | Finding |
|---|---|---|
| `contract_exit_cases` | Thêm `closing_readings_ref` (hoặc liên kết `meter_readings` có `reading_kind='MOVE_OUT'`). Đổi `legacy_termination_id` thành một marker bắt buộc chặn đường duyệt cũ: guard `contract_terminations` tra exit case | IA-01, IA-04 |
| `meter_readings` | Thêm `reading_kind` MONTHLY/MOVE_IN/MOVE_OUT; `contract_id` bắt buộc với MOVE_*. Unique chỉ áp cho MONTHLY. Trigger previous chọn theo `reading_date <= NEW.reading_date` trên cùng công tơ. Bỏ `EXCEPTION WHEN OTHERS THEN NULL` | IA-04 |
| `room_turnovers` | Đổi `exit_case_id UNIQUE` thành `source_kind` (EXIT_CASE / TRANSFER / LEGACY_END / SIGN_CANCEL) + `source_id`, cộng partial unique theo phòng khi PENDING. Định nghĩa facts cho trường hợp "không cư trú, không có turnover" | IA-34 |
| `lifecycle_work_items` | Partial UNIQUE `(source_kind, source_id) WHERE status='OPEN'` (bỏ `source_revision`). Thêm kind CONTRACT_END_CHECK, SETTLEMENT_PENDING, REFUND_PENDING, CUSTOMER_OWES, HOLD_DUE, hoặc ghi rõ là ngoài phạm vi (Q8). Outbox là bảng riêng, dedup theo `(recipient_user, local_day, digest)`. Map membership ↔ user id qua một hàm chung | IA-15, IA-16 |
| `room_pass_listings` | Thêm `contract_id`, `source`, `confirmed_by`/`confirmed_at`, `expires_on`. Writer trả phòng/nhận phòng tự tắt pass (Q5) | IA-07 |
| Registry giữ chỗ | **Bảng mới** `room_next_claims` gắn `reservation_id` hoặc `signed_contract_id`, có `claim_state` và partial unique theo phòng. Giữ `room_reservation_holds` như khoá thao tác, không nâng thành registry. Adapter đọc phiếu cọc mồ côi cộng `reservation_hold_deadlines.hold_until`. D05 theo `hold_until` (Q4) | IA-06 |
| Revision phòng sale | Bỏ bảng hot-row `availability_scope_versions`. Thay bằng change-log append-only (sequence), revision = max(seq) theo scope. Nguồn gồm cả phiếu cọc, settlement, `reservation_hold_deadlines`, pass, settings, token. Không UPDATE `rooms`/`contracts` để bump | IA-19 |
| Scope token public | Bảng scope (token → org, tập toà, `scope_version`) làm nguồn `scopeEpoch`; link do nhân viên tạo cũng dùng được (Q16) | IA-18 |
| Số hợp đồng | Chỉ cấp khi ký; unique `(organization_id, contract_number)` sau khi xử lý 10 cặp trùng (Q11) | IA-24 |
| Tài liệu | Mẫu lưu theo phiên bản bất biến (object mới theo digest, không xoá object còn được tham chiếu). Nơi lưu chốt ở Q13 (hiện là Supabase Storage `document-templates`, không phải R2) | IA-23 |

## C. §4.2 Thứ tự khoá và harness

**Order tổng đề xuất** (IA-05). Order này dựa trên giao thức đã có: `lock_org_for_decision_v1` "take the org lock FIRST", và thứ tự đã ghi trong `create_income_expense_v1`.

```text
0. Đọc không khoá để resolve org/room/contract.
1. lock_org_for_decision_v1(org)                    -- câu lệnh đầu, TRƯỚC mọi authorize
2. authorize_tenant_action_v3(...)                  -- FOR SHARE lúc này là re-entrant
3. rooms FOR UPDATE theo id tăng dần                 -- khoá dòng; bỏ advisory 'room:' hoặc thêm vào mọi writer
4. contracts FOR UPDATE theo id; đọc lại room_id/scope, lệch thì VERSION_CONFLICT
5. case / notice / claim / draft / reservation
6. invoices theo (billing_month, created_at, id)
7. income_expenses (vouchers) theo id
8. accounts (cashbook) theo id
9. spend buckets (advisory, đã sort)
```

**Writer phải có prelock adapter (hoặc được định tuyến) trước khi bật writer mới:**
- thanh lý / bỏ cọc / approve cũ (hiện khoá contract trước);
- collection v5, reverse, tender change (invoice trước);
- `approve_income_expense_v2`, `set_termination_forfeit_status_v1`, `reverse_posted_income_expense_v2` (voucher trước);
- `lock_cashbook_period_v1`, `confirm_cashbook_closing_v1` (cashbook trước);
- `transfer_room` (advisory);
- `renew_contract_impl` (không khoá);
- `create_contract_v2` và các writer settle giữ chỗ (room trước org — cần đảo lại).

**Cặp bắt buộc trong harness.** Mỗi cặp chạy trên hai kết nối, lặp nhiều lần, đo 40P01 và kết quả serial hợp lệ:
1. legacy terminate ∥ confirm/sign cùng phòng (đã có phép thử `t-probe-lock-order.cjs`);
2. finalize ∥ `record_invoice_collection_v5` trên hoá đơn của A;
3. finalize ∥ `approve_income_expense_v2` trên phiếu hoàn của A;
4. finalize ∥ `confirm_cashbook_closing_v1`;
5. `transfer_room` ∥ confirm cùng phòng;
6. hai confirm khác phòng, cùng org (bắt lỗi nâng khoá);
7. `create_contract_v2` ∥ `create_income_expense_v1` cùng phòng;
8. renew ∥ confirm.

## D. §4.1 API

- **`MoveOutCommand`:** thêm `closingReadings: { meterId: string; reading: MoneyVnd; photoRef?: string }[]`, bắt buộc với mọi công tơ ACTIVE của phòng (Q1). Server kiểm công tơ thuộc đúng phòng và org.
- **`confirm_contract_moveout_v1`, cả hai nhánh:**
  - ghi chỉ số MOVE_OUT;
  - tắt pass của hợp đồng;
  - đóng notice;
  - tạo turnover;
  - cấp write-token cho các cột vòng đời.
- **Thêm `revert_contract_moveout_v1`** (Q7): chỉ khi case còn PENDING, chưa có khách mới hoặc claim, chưa có dòng tiền nào; có lý do và event.
- **Quyền:**
  - `contracts.terminate` đã có (ELEVATED) nhưng chưa được kiểm ở SQL. Dùng nó cho bàn giao.
  - `contracts.settle/sign/checkin` là key mới, cần migration grant cho cả hai vai chủ và matrix đã duyệt (Q10).
  - Chọn **một** key cho giữ chỗ: `deposits.create` hoặc `sale_phong.create_deposit` (IA-33).

## E. §4.3 Quyết toán

- **Context thanh lý:** `classify_termination_payment_v1` phải nhận `payment_date = accounting_on`, không bắt bằng `move_out_date`. Finalize khoá dòng `profit_monthly` (toà, tháng) của `accounting_on` (IA-11).
- **Core tính ở server:**
  - Chỉ cấn các hoá đơn đã liệt kê trong preview, và chỉ các trạng thái APPROVED/OVERDUE/PARTIAL_PAID.
  - Không tin `p_outstanding_debt`/`p_extra_charges` từ client.
  - Kỳ cuối (prorata) có input có kiểu và quy ước chia ngày cố định (IA-31).
- **Tự duyệt phiếu hoàn** (Q3): nêu rõ core ghi phiếu bằng đường nào. Nếu qua `create_income_expense_v1` thì người có quyền duyệt sẽ tự duyệt (IA-12).
- **FORFEIT** (Q2): nêu rõ giữ hay đổi hành vi hiện hành (huỷ mọi hoá đơn mở, đốt toàn bộ credit); ghi `policy_version` (IA-10).
- **Replay:** authorize **trước** replay (mẫu `create_contract_v2`), không theo wrapper 22/08 (IA-31).
- **Test P7:** phiếu hoàn thanh lý không sinh HOLD/DRAW. Kỳ vọng 0 draw, và kỳ vọng abort có kiểm soát khi sổ tiêu lỗi (IA-12).

## F. §4.4 Inventory writer có tên (P0b)

| Writer | Quyết định đề xuất |
|---|---|
| `approve_contract_termination_v1` + INSERT `contract_terminations` qua REST | Chặn với hợp đồng không ACTIVE hoặc có case; thu INSERT của `authenticated` sau khi map caller (P1a, IA-01) |
| `create_contract_v1` (cờ ON) | Tắt cờ hoặc thu quyền; hiện không có caller UI (IA-03) |
| Import `ContractImportExportDialog` | Chuyển sang RPC có guard claim (IA-03) |
| `terminate_contract_move_out` / `_forfeit` (bản trần) | Thu quyền nếu không còn caller; chặn với case v2 và SIGNED_WAITING |
| `renew_contract` | Guard claim/case/notice; khoá theo order (IA-13) |
| `transfer_room` / `transfer_contract` | Kiểm claim; khoá dòng; nhượng hợp đồng theo Q12 (IA-26) |
| Trigger `trigger_apply_contract_extension_update`, `trigger_apply_contract_transfer` | Phủ bởi guard IA-02 |
| Copilot `contract.duyet_thanh_ly`, `contract.gia_han`, `contract.chuyen_nhuong`, `room.chuyen_phong`, `reservation_deposit.create`, `reservation.set_hold_terms` | Từ chối hoặc chuyển sang adapter v2 |
| PATCH trực tiếp `contracts` (sửa HĐ, báo trả, xoá mềm) | Chuyển sang RPC trước khi bật guard |

## G. §5.1 Phòng sale

- **Một phép tính cho mọi kênh** (IA-20):
  - public, in-app;
  - `copilot_available_rooms_v1`;
  - `zalo_phong_trong_cho_worker_v1`;
  - `worker/lib/vacant-rooms.js`, `worker/lib/room-list-table.js`;
  - Copilot tool (`registry.ts`);
  - `src/lib/roomStatus.ts`.
- **Contract lỗi:** server trả `INVALID` khác `EMPTY`. Bỏ `SAMPLE_BUILDINGS` và `MANAGER` (SĐT giả) khỏi đường dữ liệu thật. Lỗi mạng hiện "dữ liệu chưa cập nhật", không hiện "link hết hạn" (IA-18).
- **Allowlist:** loại `sale_bonus_note`; phòng rented chỉ trả trường tối thiểu.
- **Pass:** chỉ hợp lệ khi gắn đúng hợp đồng đang ở và không có claim (IA-07).
- **Nguồn "đang giữ":** facts đọc đủ 5 nguồn (holds, phiếu cọc mồ côi, `reservation_hold_deadlines`, `deposits`, pass). Slice A không cần chờ P9 (IA-06).

## H. §5.2 Scheduler

- **Người nhận:** resolve bằng `authorize_tenant_action_v3(recipient_user, org, key, building)` cho từng người, theo mẫu `ie_approver_ids_v1`. Không dùng `can_access_building()`, vì hàm này theo người gọi và có nhánh super admin (IA-16).
- **Ngày của org:** `(p_as_of AT TIME ZONE org_timezone_v1(org))::date`. Không gọi `org_today_v1(NULL)`.
- **`cron_runs` riêng:** có run_id, environment, heartbeat. Lỗi không khoá lượt chạy lại (không chép `v5_cron_start`).
- **Push:** dùng drain hiện có. Khi supersede, đặt `push_state='SKIPPED'` hoặc xoá dòng notification chưa đọc. Ghi rõ push chỉ đi 07:00 VN mỗi ngày (Q8).
- **Job sinh từ server:** đặt `user_id` tường minh, và tự enqueue thông báo cho người được giao (trigger E4 không chạy khi không có `auth.uid()`).

## I. §6 Nháp, ký, billing

- **Tách P11** (IA-21):
  - **P11a**: ký từ nháp, nhận ngay, qua adapter `create_contract_v2` (ACTIVE) và gắn `documentVersionId`. Không phụ thuộc G-BILLING.
  - **P11b**: SIGNED_WAITING.
- **Viết lại G-BILLING theo hiện trạng** (IA-22):
  - Hoá đơn lập thủ công ở hai UI, chỉ lấy ACTIVE, chống trùng theo nhãn tháng; không có issuer.
  - Quyết định: đưa SIGNED_WAITING vào danh sách lập; chống trùng theo khoảng ngày; `create_invoice_v1` kiểm hợp đồng và khoảng ngày ở server.
- **Bàn giao tài sản:** biên bản gắn case/activation, không chỉ gắn hợp đồng ACTIVE (IA-27).

## J. §8 Thứ tự task

Xem sơ đồ và bảng slice trong [`../independent-audit.md` §8](../independent-audit.md#8-thứ-tự-task-điều-chỉnh). Điểm chính:
- **P0a/P0b trước:** catalog, TEST parity, harness khoá, inventory có tên.
- **P1a vá khẩn tách riêng:** chủ duyệt Q15.
- **Slice A** (P2 → P3 → P4 → P5) không phụ thuộc P9.
- **Slice B** (P6 → P8) cần P1a, Q1–Q3, G-LOCK.

## K. §9 Ma trận kiểm chứng: thêm

| ID | Kịch bản | Kỳ vọng |
|---|---|---|
| V36 | Quản lý INSERT DRAFT `contract_terminations` rồi approve, trên hợp đồng đã kết thúc hoặc case PENDING | 42501 / `LEGACY_CLIENT_BLOCKED`; 0 phiếu |
| V37 | PATCH trực tiếp từng cột vòng đời bằng JWT | 42501; writer hợp lệ vẫn chạy |
| V38 | Quyết toán sau có công tơ; B nhận ngày hôm sau | Hoá đơn đầu của B bắt đầu từ số chốt A; quyết toán A dùng số chốt; ghi muộn không lỗi im lặng |
| V39 | Pass của A sau khi A trả phòng / B vào ở | Không còn trong payload; không lộ liên hệ |
| V40 | Mọi writer cũ (bảng F) trên phòng có claim hoặc hợp đồng có case | Từ chối rõ; 0 ghi |
| V41 | Các cặp khoá ở mục C | Không có chu trình; hoặc 40P01 được retry có kiểm soát, không fail-open |
| V42 | Gia hạn khi notice OPEN; gia hạn ∥ confirm | Notice được xử lý; không gia hạn hợp đồng đã TERMINATED |
| V43 | Chốt với `accounting_on` khác ngày bàn giao; khoá tháng ∥ finalize | Payment CT hợp lệ; không kẹt phiếu chờ |
| V44 | Preflight TEST so với production | Đỏ khi lệch md5 hoặc thiếu object |
| V45 | Kênh Zalo/Copilot/worker so với public | Cùng facts |

## L. §10 Gate: thêm

- `gate:org-boundary-inventory`, `gate:realtime-surface`, `gate:copilot-forbidden-actions`, `gate:route-permission-drift`.
- Chạy `gate:definer-body-authz` trong quy trình. Gate này chưa nằm trong CI, và cho qua bất kỳ thân hàm nào có `auth.uid()`, nên phải review tay các RPC mới.
- Harness đối soát theo fixture/org trên TEST thay cho `gate:reconcile-money*`. Hai gate đó mặc định trỏ production, bỏ qua DEMO và không khoanh được fixture (IA-32).
