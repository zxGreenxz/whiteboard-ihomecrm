# Bật quyền GHI của Hermes trên production cho bốn trang — runbook (CHỈ FILE, chưa áp)

Ngày 28/10/2026 (giờ Việt Nam). Soạn sẵn để phiên chính bật từng trang sau lượt kiểm cuối: Hợp đồng (HĐ), Thu chi (TC), Hoá đơn (HĐn), Công việc (CV). Chủ đã đồng ý bật trang nào đạt nghiệm thu (≥ 95 %, 0 ghi sai). Mỗi trang có một migration bật và một file lùi riêng nên bật hoặc lùi được độc lập. Chưa áp gì lên TEST hay production.

Nguồn: [NEN-CHUNG-THAO-TAC-GHI.md](NEN-CHUNG-THAO-TAC-GHI.md) mục 8.3 và 11; [CONG-VIEC-THAO-TAC-GHI.md](CONG-VIEC-THAO-TAC-GHI.md) mục 19 và 22; mẫu `20261022121254_hermes_sale_action_activation_v1.sql`; mã connector ở `infra/hermes-broker/` và `infra/hermes-runtime/`. Số liệu production ở mục 2 đọc ngày 28/10 bằng `npm run db:query` (chỉ đọc).

## 0. Kết luận

1. **Bốn migration, mỗi file một trang:**

   | Trang | File | Khoá file bật | Chính sách |
   | --- | --- | --- | --- |
   | HĐ | `20261027234335_hermes_contract_actions_activation_v1` | `contracts.create`, `contracts.edit`, `contracts.renew`, `contracts.terminate` | 10 dòng `contract.*` đã có, chỉ kiểm |
   | TC | `20261030065028_hermes_expense_actions_activation_v1` (tên cũ `20261027234414`; đổi mốc để chạy SAU `20261030050424_hermes_sale_deposit_receipt_key_v1`) | `income_expenses.create`, `.edit`, `.cancel`, `.approve_vouchers` | 5 dòng `expense.*` đã có, chỉ kiểm |
   | HĐn | `20261027234454_hermes_invoice_actions_activation_v1` | `thu_tien.collect_transfer`, `meter_readings.create`, `invoices.edit`, `invoices.approve`, `invoices.cancel` | 6 dòng `invoice.*` đã có, chỉ kiểm |
   | CV | `20261027234537_hermes_task_actions_activation_v1` | `tasks.delete` (bảo đảm thêm `tasks.create`, `tasks.edit` vốn đã bật) | chèn 4 dòng `task.recurring_*` (mục 22), kiểm 4 dòng cũ |

   File lùi tương ứng ở `docs/plans/hermes-crm/revert/hermes_<trang>_actions_activation_revert_v1.sql` (không phải migration; mục 6).
2. **Connector production `3bd1313b` đã có mã cả bốn trang.** Thu chi, Hoá đơn, Công việc nằm trong danh mục production, luôn nạp, **không cần** `actionPages`. Chỉ Hợp đồng cần `"actionPages": ["contract"]`. Riêng TC còn cần connector có `SALE_DEPOSIT_RECEIPT_KEY` (nhánh `claude/hermes-sale-deposit-key-split`); `3bd1313b` CHƯA có (mục 1.2, 5.2). `"contract"` là giá trị hợp lệ DUY NHẤT: tên khác (`"expense"`, `"invoice"`, `"task"`…) qua được kiểm của host nhưng làm backend từ chối cấu hình, connector không khởi động (mục 3).
3. **Ai nhận khoá ngay khi bật:** 6 kết nối ACTIVE, đều `inherit_crm`, phạm vi toàn tổ chức, không loại trừ khoá nào, thuộc 2 tài khoản đều là chủ (OWNER) của công ty. Chỉ **một** kết nối còn token sống: kết nối của profile owner (bot Zalo production). Năm kết nối kia token chết từ sự cố 21/10, nhận khoá trong bảng chiếu nhưng không dùng được. 0 kết nối `legacy_allowlist` ACTIVE, 0 dòng chính sách công ty (trần trung tính). Vậy bật trang nào là bot owner có ngay thao tác của trang đó.
4. **Không cần tạo lại kết nối.** Trigger chiếu lại khoá cho `inherit_crm` mà không đổi epoch. Lần TEST 23/10 phải tạo lại kết nối là do lỗi cấp trùng `sale_phong.lock_room`, đã sửa ở #300 (có trong `3bd1313b`). Lúc áp, một lời gọi đang chạy có thể nhận `context_changed` một lần (mục 7).
5. **Phụ thuộc chéo** (mục 1.2): HĐ mượn khoá `sale_phong.lock_room` của trang Sale; riêng việc thêm `actionPages: ["contract"]` đã mở ngay `contract.room_lock` / `room_unlock`. CV đang sống một phần trên production (`task.create`, `task.create_batch`, `task.update`), file CV chỉ thêm phần huỷ và việc định kỳ. TC kéo theo Sale: `income_expenses.create` còn là điều kiện của `crm_sale_reservation_create` / `_topup` (báo cọc ghi phiếu thu một bước, không xem trước / confirmToken). Sau `20261030050424_hermes_sale_deposit_receipt_key_v1` + connector có `SALE_DEPOSIT_RECEIPT_KEY`, hai tool đó đòi thêm `deposits.create_receipt` (TẮT), nên TC chỉ mở `crm_action_*` — với điều kiện hai thứ đó lên trước (file TC tự dừng nếu thiếu phần SQL; connector kiểm ở 5.2). HĐn không kéo theo trang nào.

## 1. Phân khoá theo trang

### 1.1 Thao tác và khoá

Nguồn: danh mục connector (`contract-action-contract.mjs`, `expense-actions-contract.mjs`, `invoice-actions-contract.mjs`, `task-actions-contract.mjs`) đối chiếu `app_private.hermes_action_policies` trên production. Test `action-activation-sql.test.mjs` khoá: khoá của mỗi file bật = khoá danh mục connector của trang, trừ khoá mượn của lớp Sale.

| Trang | Thao tác (khoá Hermes → quyền CRM giao vào) | Lớp | `actionPages` |
| --- | --- | --- | --- |
| HĐ | `notice_set`, `notice_cancel` (`contracts.terminate`); `return` (`contracts.terminate`); `renew`, `renew_batch` (`contracts.renew`); `occupant_add`, `occupant_remove` (`contracts.edit`); `draft` (`contracts.create`); `room_lock`, `room_unlock` (`sale_phong.lock_room`, khoá MƯỢN) | `return`, `renew*` không lùi được; còn lại lùi được | `["contract"]` |
| TC | `create`, `note` (`income_expenses.create`); `edit` (`income_expenses.edit` → `income_expenses.create`); `cancel` (`income_expenses.cancel` → `income_expenses.create`); `approve` (`income_expenses.approve_vouchers` → `income_expenses.approve`) | tiền / không lùi được, trừ `note` | không cần |
| HĐn | `collect` (`thu_tien.collect_transfer` → `thu_tien.collect`); `meter_record` (`meter_readings.create`); `adjust` (`invoices.edit`); `adjustment_check` (`invoices.approve`); `cancel`, `restore` (`invoices.cancel`) | tiền / không lùi được | không cần |
| CV | `create`, `create_batch`, `recurring_create` (`tasks.create`); `update`, `recurring_update`, `recurring_pause` (`tasks.edit`); `cancel`, `recurring_delete` (`tasks.delete`) | `cancel` không lùi được; còn lại lùi được | không cần |

### 1.2 Bật một trang có kéo theo trang khác không

- **HĐ ↔ Sale (`sale_phong.lock_room`).** Khoá này của trang Sale, đã bật từ `20261022121254`. Lớp Sale là nguồn cấp duy nhất; lớp thao tác chỉ mượn (`borrowedKeys`, `server.mjs` dòng 193, #300). Hệ quả:
  - migration HĐ không bật, file lùi HĐ không tắt khoá này. Tắt nó sẽ làm hỏng khoá tạm phòng của trang Sale;
  - chỉ cần thêm `"contract"` vào `actionPages` là `contract.room_lock` / `room_unlock` sống ngay, trước cả migration HĐ;
  - muốn ẩn hai thao tác đó thì gỡ `"contract"` khỏi `actionPages`;
  - Sale tắt khoá ⇒ hai thao tác khoá tạm của HĐ ẩn, tám thao tác kia vẫn chạy (test `action-shared-keys.test.mjs`).
- **CV ↔ tool việc cũ và theo dõi.** `tasks.create`, `tasks.edit` đã bật trước đây cho `crm_task_follow_*` và `crm_task_progress`. Chính sách `task.create`, `task.create_batch`, `task.update` đã có, nên ba thao tác này **đang sống** cho bot owner. Khi các thao tác này sống, tool cũ `crm_task_create` / `crm_task_progress` / `crm_task_cancel` nghỉ hưu theo danh mục sống (`TASK_RETIRED_BY`).
  - File CV đổi thực chất hai thứ. (1) Bật `tasks.delete` ⇒ `task.cancel` (luôn xem trước) và `task.recurring_delete`. (2) Chèn 4 dòng chính sách ⇒ `task.recurring_create` / `_update` / `_pause` sống ngay vì khoá đã bật.
  - File lùi CV đưa về đúng trạng thái này, không tắt `tasks.create` / `tasks.edit`.
  - Điều kiện của mục 19: không host nào dùng database production còn chạy connector cũ hơn Mốc 3. Production chỉ có connector `3bd1313b`; TEST dùng database riêng.
- **TC, HĐn:** không lớp quyền nào khác CẤP khoá của hai trang (`action-shared-keys.test.mjs` khoá bất biến "không khoá nào do hai lớp cùng cấp"). Nhưng lớp Sale có ĐỌC `income_expenses.create`: `mayUseSaleAction` (connector) và `hermes_sale_actions_v1` (SQL) đòi nó cho báo cọc / thu thêm có tiền. Họ `crm_expense_*` đã gỡ (TC1); hai tool báo cọc đòi thêm `deposits.create_receipt` từ `20261030050424_hermes_sale_deposit_receipt_key_v1` + connector cùng nhánh. Vậy bật lại `income_expenses.create` chỉ mở `crm_action_*` khi hai thứ đó đã lên trước; chưa lên thì mở luôn hai tool báo cọc ghi tiền một bước. File TC tự dừng (`hermes_expense_activation_sale_deposit_gate_missing`) khi thiếu dòng registry `deposits.create_receipt` hoặc thân `public.hermes_sale_actions_v1` không chứa chuỗi đó; phần connector không kiểm được từ SQL nên kiểm ở 5.2.
- **`tools/list`:** ba tool `crm_action_*` đã hiện trên production vì `task.*` đang sống. Bật thêm trang không đổi byte nào: danh mục thao tác nằm trong kết quả `crm_action_list`. Riêng TC còn phải giữ nguyên kết quả `crm_sale_action operation=list`: không có `reservation_create` / `reservation_topup`.

## 2. Production đọc ngày 28/10 (chỉ đọc)

- **Registry** (`app_private.hermes_capabilities`, mode `action`):
  - TẮT: `contracts.create/edit/renew/terminate`, `contracts.transfer` (không thao tác nào dùng), `income_expenses.create/edit/cancel/approve_vouchers`, `invoices.edit/approve/cancel`, `meter_readings.create`, `thu_tien.collect_transfer`, `tasks.delete`, `assistant.action_probe`;
  - BẬT: `sale_phong.lock_room`, `tasks.create`, `tasks.edit`, `income_expenses.approve` (khoá cũ, file không đụng). Khoá Read của bốn trang (`contracts.view`, `income_expenses.view`, `invoices.view`, `meter_readings.view`, `thu_tien.view`, `tasks.view`, `task_types.view`, …) đều bật.
- **Chính sách:** 27 dòng; đủ 10 `contract.*`, 5 `expense.*`, 6 `invoice.*`, 4 `task.*` (`create`, `create_batch`, `update`, `cancel`) và 2 `probe.*`; **chưa có** `task.recurring_*`.
- **Hàm:** cả 81 chữ ký mà bốn file kiểm đều có (`to_regprocedure`). Vỏ trang đang gắn bước ghi mới nhất: HĐ gắn `contract_action_step_v1` + `batch_step_v1` + ba hàm tra cứu; HĐn gắn `action_step_v3` + `lookup_core_v3`, `meter_*_v1`, `edit_step_v2`; TC và CV gắn bước ghi / chuẩn bị / chốt hiện hành. Thân hai hàm chiếu lại khớp md5 với `20261019034754`, hai trigger chiếu lại đang bật.
- **Kết nối:**
  - 6 ACTIVE `inherit_crm` / `unrestricted`, 0 loại trừ, 2 người dùng, 1 công ty; chỉ một kết nối có token còn hạn;
  - 0 `legacy_allowlist` ACTIVE, 0 PENDING; `hermes_org_policies` 0 dòng.
- **Dữ liệu:** `hermes_action_receipts` 0 dòng (chưa ai ghi qua `crm_action_*` trên production); `job_recurrence_rules` 0 dòng; cron `job-recurrence-daily` đang bật.
- **Web, nhánh `production` (`3414753db`):** `capability-contract.mjs` và `capabilityLabels.ts` có đủ 17 khoá ở bảng 1.1, nên màn `/settings/hermes` đọc được khoá vừa bật (bài học 19/10).

## 3. Connector và `actionPages`

- `infra/hermes-broker/server.mjs`:
  - dòng 57: `ACTION_PAGE_CATALOGS = { contract: CONTRACT_ACTIONS }`, nên chỉ có trang `contract`;
  - dòng 185–187: danh mục = `EXPENSE_ACTIONS + TASK_ACTIONS + INVOICE_ACTIONS` (luôn nạp), cộng thao tác thử nếu `actionProbe`, cộng các trang trong `actionPages`;
  - dòng 143–146: tên trang không có trong `ACTION_PAGE_CATALOGS` ⇒ `invalid_backend_config`.
- `infra/hermes-runtime/host-config.mjs` dòng 134–135 chỉ kiểm khuôn: mảng, tối đa 8 phần tử, `^[a-z]{2,16}$`, không trùng. `host-service.mjs` dòng 112 chuyển nguyên mảng cho backend. Vì vậy `"expense"` qua được host nhưng backend từ chối; khi đó `host_failed`, connector không lên và bot mất mọi tool CRM.
- Vắng `actionPages` (production hiện tại) hay `[]` thì như nhau: không nạp thao tác HĐ, không đổi epoch kết nối (test `action-shared-keys.test.mjs`: bật / tắt `actionPages` không gây `context_changed`).
- **`3bd1313b` so với `main` `c5c2eab80`:** chỉ khác tài liệu và hồ sơ (không file mã connector nào). `3bd1313b` chứa #300 (`borrowedKeys`, commit `414854a81`) và Mốc 3 + Mốc 5 của Công việc.
- **Chưa đọc lại VPS trong phiên soạn.** `CONNECTOR.md` ghi production chạy `3bd1313b` từ 27/10 23:13. Phiên chính kiểm trước khi làm (lệnh chỉ đọc, chạy bằng root):

  ```bash
  readlink -f /opt/ihome-hermes/current
  systemctl is-active hermes-connector
  python3 -c 'import json; print(json.load(open("/etc/ihome-hermes/connector.json")).get("actionPages"))'
  ```

## 4. Bốn migration bật (khuôn chung)

Theo mẫu Sale `20261022121254`; mỗi file là một `DO` trong `BEGIN … COMMIT`, `lock_timeout 5s`, `statement_timeout 120s`, rồi `NOTIFY pgrst`.

1. **Kiểm bảng.** Có `hermes_capabilities`, `hermes_connections`, `hermes_action_policies`, `hermes_action_receipts`. CV kiểm thêm `job_recurrence_rules` / `_occurrences`.
2. **Kiểm hàm** (`to_regprocedure`), gồm:
   - khung chung: capabilities, status, guard, mở / chốt biên nhận, lý do, giải tên ghi;
   - vỏ trang và mọi tầng vỏ gắn ở phiên bản hiện hành (HĐn đòi `*_v3` / `edit_step_v2`);
   - hàm ghi web mà bước ghi gọi;
   - hai hàm chiếu lại.

   Không ghim md5: lượt sửa thân về sau không làm file này hỏng khi chạy lại.
3. **Kiểm trigger chiếu lại** `hermes_registry_projection_v2` / `hermes_connection_limits_projection_v2`: có, đang bật, đúng hàm.
4. **Kiểm dòng chính sách** của trang: đúng khoá + quyền CRM giao vào, tức bật khoá mở đúng các thao tác đã duyệt. `confirm` / `private_only` là núm chỉ siết được nên không ghim. Riêng CV ghim trọn bốn dòng mình chèn.
5. **Khoá dòng registry** `FOR UPDATE`, đếm đúng số khoá mode `action`, rồi `UPDATE … SET enabled=true … AND NOT enabled`. CV chèn chính sách bằng `ON CONFLICT (action) DO NOTHING`. Dòng có sẵn khác bản mục 22 thì dừng (`recurring_policy_invalid`), không nhận im lặng.
6. **Kiểm cuối:**
   - đủ khoá đang bật;
   - CV: tám thao tác đã duyệt đều trỏ khoá đang bật;
   - HĐ: báo `NOTICE` nếu `sale_phong.lock_room` tắt, không dừng.
7. **Riêng TC, rào tiền điều kiện báo cọc Sale** (sau bước 5, khi đã khoá dòng registry): có dòng `deposits.create_receipt` mode `action` (FOR SHARE) và thân `public.hermes_sale_actions_v1` chứa chuỗi `deposits.create_receipt`; thiếu ⇒ `hermes_expense_activation_sale_deposit_gate_missing`, không khoá nào đổi. Kiểm theo chuỗi, không ghim md5, để lượt sửa thân hàm về sau không làm hỏng rào.

Chạy lại không đổi gì. Không DROP, không đổi quyền CRM / chính sách công ty / loại trừ / phạm vi kết nối, không ghi bảng nghiệp vụ. Provenance: `unknown` (file chỉ DML), như mẫu `20261021162612`. Sau áp, hồ sơ chuyển sang `ledger-applied` theo biên nhận lane.

**Cửa idempotent của CI main** dán file hai lượt lên production rồi ROLLBACK. HĐ, HĐn, CV: phụ thuộc đều đã áp nên file chạy được dù merge trước hay sau khi áp. **TC thì khác:** rào ở bước 7 làm lượt dán ĐỎ khi `20261030050424_hermes_sale_deposit_receipt_key_v1` chưa áp production. Vì vậy chỉ merge file TC lên `main` SAU khi split đã áp production (hoặc giữ file TC ngoài `main` tới lúc đó); merge sớm làm `main` đỏ cho mọi phiên. Lượt dán giữ khoá dòng registry và 6 dòng kết nối trong một giao dịch ngắn.

**KHÔNG** đưa bốn file vào một chuỗi áp hàng loạt. Áp đích danh từng file của trang đã đạt. File của trang chưa bật có thể nằm lại trên `main` (chưa áp, provenance `unknown`) hoặc tách khỏi PR, phiên chính chọn.

## 5. Runbook bật từng trang

### 5.0 Chung cho mọi trang

1. **Điều kiện.** Trang đạt lượt kiểm cuối (≥ 95 %, 0 ghi sai). Migration đã qua review chéo theo Contract §3 (PR có base / head / kết luận).
2. **Connector.** Kiểm `readlink -f /opt/ihome-hermes/current` là `3bd1313b` hoặc bản mới hơn còn đủ danh mục của trang; `hermes-connector` đang `active`.
3. **Kiểm trước, chỉ đọc** (ví dụ HĐn; đổi danh sách khoá theo bảng mục 0):

   ```bash
   npm run db:query -- --sql "select capability, mode, enabled from app_private.hermes_capabilities where capability = any(array['thu_tien.collect_transfer','meter_readings.create','invoices.edit','invoices.approve','invoices.cancel']) order by 1"
   npm run db:query -- --sql "select state, permission_mode, scope_mode, count(*) as n, sum(cardinality(excluded_action)) as excluded from app_private.hermes_connections group by 1,2,3 order by 1,2,3"
   ```

   Có kết nối `legacy_allowlist` ACTIVE thì nó không nhận khoá. Ghi lại để biết trước khi lùi (file lùi sẽ từ chối nếu nó đang giữ khoá của trang).
4. **Chọn lúc bot rảnh.** Dòng log cuối của `hermes-owner` là `response ready` / `Turn ended`, không phải `inbound message`. Lý do ở mục 7.
5. **Lane.** `npm run migrate:forward -- supabase/migrations/<file>.sql` (dry-run: idempotency hai lượt + ROLLBACK), xanh thì thêm `--apply` (backup + biên nhận).
6. **Kiểm sau, chỉ đọc:**
   - lệnh 3 lại: khoá của trang `enabled = true`;
   - kết nối nhận khoá: `npm run db:query -- --sql "select right(id::text,8) as conn, permission_mode, array(select k from unnest(action_capabilities) k where k = any(array[<khoá trang>])) as page_keys from app_private.hermes_connections where state='ACTIVE'"`;
   - CV thêm: `select action, capability, confirm from app_private.hermes_action_policies where action like 'task.recurring_%'`.
7. **SOUL owner.** Cài bản SOUL dùng ở lượt kiểm cuối đạt, theo quy trình cài SOUL đang dùng (backup bản cũ như các lần trước).
   - Bản thân việc bật khoá không cần restart `hermes-owner`: `tools/list` không đổi. Riêng TC, kiểm thêm (chỉ đọc) `crm_sale_action operation=list` của bot owner không có `reservation_create` / `reservation_topup`. Nếu có thì connector chưa mang `SALE_DEPOSIT_RECEIPT_KEY` hoặc split chưa áp ⇒ lùi TC ngay (6.2);
   - SOUL là rào mềm; rào cứng là máy chủ (xem trước + đồng ý cho tiền / không lùi được, phạm vi, quyền CRM).
8. **Canary có chủ duyệt.** Contract §2: org thật chỉ đọc với agent, nên agent KHÔNG tự tạo dữ liệu thử trên production.
   - Chủ làm một thao tác thật qua Zalo; agent đối soát chỉ đọc: `select action, state, sqlstate, created_at, finished_at from app_private.hermes_action_receipts order by created_at desc limit 10`, sự kiện `HERMES_ACTION_*` / `HERMES_TASK_*` trong `authorization_audit_events`, và dòng nghiệp vụ trên web.
9. **Hồ sơ sau áp** (một PR, như `aaa249224`):
   - evidence `docs/generated/schema-change-evidence/<file>.json` do lane sinh;
   - provenance của file thành `ledger-applied`; câu đếm `unknown` trong `migration-policy.json` giảm theo;
   - `CONNECTOR.md` ghi trạng thái.

   Merge ngay sau khi CI xanh.

### 5.1 Hợp đồng

1. Backup cấu hình, thêm trang, giữ đúng chủ sở hữu và quyền: `ProtectSystem=strict`, file phải là `ihome-hermes:ihome-hermes` 0600. Ghi bằng root sẽ ra `host_failed`.

   ```bash
   umask 077
   cp -a /etc/ihome-hermes/connector.json /root/ihome-perf/backup-connector-$(date -u +%Y%m%dT%H%M%SZ).json
   python3 -c 'import json; c=json.load(open("/etc/ihome-hermes/connector.json")); c["actionPages"]=["contract"]; print(json.dumps(c, indent=2))' > /root/connector.json.new
   install -o ihome-hermes -g ihome-hermes -m 600 /root/connector.json.new /etc/ihome-hermes/connector.json && rm /root/connector.json.new
   systemctl restart hermes-connector
   systemctl is-active hermes-connector && journalctl -u hermes-connector -n 30 --no-pager | grep -E 'host_(ready|failed)'
   ```

   Không cần restart `hermes-owner` vì `tools/list` không đổi. `host_failed` thì chép lại bản backup bằng đúng lệnh `install` rồi restart.
2. Ngay sau bước 1, `contract.room_lock` / `room_unlock` đã sống (khoá Sale đang bật). Muốn mở cả mười thao tác cùng lúc thì đổi thứ tự: áp migration trước rồi mới tới bước 1. Cách này cũng an toàn: khoá `contracts.*` bật nhưng connector chưa nạp thao tác HĐ thì không lớp nào cấp khoá.
3. Lane áp `20261027234335_hermes_contract_actions_activation_v1`. Kiểm sau theo 5.0.6 với 4 khoá `contracts.*`.
4. SOUL, rồi canary. Ưu tiên thao tác lùi được: báo trả / huỷ báo trả, khoá tạm. Gia hạn và ghi nhận trả phòng (không lùi được) chỉ khi có ca thật và chủ đồng ý ở bản xem trước.

### 5.2 Thu chi

1. **Tiền điều kiện** (review chéo PR #349): `20261030050424_hermes_sale_deposit_receipt_key_v1` đã áp (lane, đích danh: provenance `catalog-proven`), và connector đang chạy có `SALE_DEPOSIT_RECEIPT_KEY`. Kiểm connector (chỉ đọc, root): `readlink -f /opt/ihome-hermes/current` trỏ bản build có commit split, rồi `grep -c SALE_DEPOSIT_RECEIPT_KEY "$(readlink -f /opt/ihome-hermes/current)"/infra/hermes-broker/sale-action-contract.mjs` ≥ 1. Thiếu connector mà áp TC thì SQL vẫn chặn, nhưng bot sẽ thấy hai tool báo cọc trong danh sách rồi bị từ chối.
2. Lane áp `20261030065028_hermes_expense_actions_activation_v1`. Thiếu split thì file tự dừng (`hermes_expense_activation_sale_deposit_gate_missing`), không khoá nào đổi.
3. Kiểm sau với 4 khoá `income_expenses.*` (5.0.6), và dòng `deposits.create_receipt` vẫn TẮT:
   `npm run db:query -- --sql "select capability, enabled from app_private.hermes_capabilities where capability in ('income_expenses.create','deposits.create_receipt') order by 1"`. Thao tác tiền luôn xem trước. Phiếu vượt ngưỡng tự duyệt vẫn chờ duyệt như web.
4. **Kiểm `crm_sale_action operation=list`** của bot owner (chỉ đọc, qua chính kết nối owner): danh sách KHÔNG có `reservation_create` / `reservation_topup`. Có ⇒ lùi TC ngay (6.2) rồi kiểm connector.
5. SOUL, rồi canary: một phiếu chi thật (bản xem trước nói "vào sổ ngay" hay "chờ duyệt"), một ghi chú. Duyệt / duyệt + chi chỉ khi chủ có phiếu thật cần duyệt.

### 5.3 Hoá đơn

1. Không đổi connector. Lane áp `20261027234454_hermes_invoice_actions_activation_v1`.
2. Kiểm sau với 5 khoá. Thu tiền mặt vẫn bị từ chối (`cash_collection_web_only`, Q13).
3. SOUL, rồi canary: ghi chỉ số thật của một toà, hoặc thu một khoản chuyển khoản thật đã về. Điều chỉnh / huỷ / khôi phục chỉ khi có ca thật.

### 5.4 Công việc

1. Không đổi connector. Xác nhận không host nào khác dùng database production (mục 1.2).
2. Lane áp `20261027234537_hermes_task_actions_activation_v1`.
3. Kiểm sau: `tasks.delete` bật, 4 dòng `task.recurring_*` đúng bản mục 22.
4. SOUL, rồi canary: tạo một việc định kỳ thật (luôn xem trước, kèm lịch chữ và ba lần tới), xem báo cáo `task_recurrences`. Huỷ việc chỉ khi có việc thật cần huỷ (luôn xem trước).

## 6. Lùi

### 6.1 Phanh nhanh, không cần lane

- **HĐ:** gỡ `"contract"` khỏi `actionPages` (backup + `install` + restart như 5.1). Cả mười thao tác HĐ biến mất dù khoá còn bật. Đây cũng là cách DUY NHẤT để ẩn `room_lock` / `room_unlock` mà không đụng trang Sale.
- **SOUL:** cài lại bản cũ (rào mềm).
- **Theo kết nối** (chưa kiểm trên production): `/settings/hermes`, mục "Giới hạn cho Hermes", bỏ khoá của trang khỏi kết nối của owner. Thao tác này ghi `excluded_action` và tăng epoch kết nối (luồng web TG2). Kiểm trên TEST trước khi dựa vào.

### 6.2 Lùi bằng migration (theo trang)

1. Chép file lùi vào `supabase/migrations/` dưới tên `node scripts/tao-ten-migration.mjs hermes_<trang>_actions_activation_revert_v1` cấp, rồi `git add`.
2. Thêm entry provenance (`unknown`, chỉ DML) và đếm tài liệu (`node scripts/check-doc-counts.mjs --fix`) như file bật.
3. Review, rồi lane dry-run → `--apply` (TEST trước nếu kịp, rồi production).

Mỗi file lùi:
- **Rào legacy** như `20261021162612`: từ chối khi còn kết nối `legacy_allowlist` ACTIVE giữ khoá của trang, vì gia hạn token của nó sẽ hỏng. Xử lý kết nối đó trước: thu hẹp, chuyển `inherit_crm` hoặc thu hồi.
- Chỉ `UPDATE … SET enabled=false … AND enabled`, chạy lại được. Kết nối `inherit_crm` mất khoá ngay, không đổi epoch.

Theo trang:
- **HĐ:** tắt 4 khoá `contracts.*`, không tắt `sale_phong.lock_room`. Còn `room_lock` / `room_unlock` nếu vẫn giữ `actionPages`.
- **TC, HĐn:** tắt 4 / 5 khoá của trang. Phiếu, lần thu, chỉ số, điều chỉnh đã ghi vẫn giữ nguyên. Bản xem trước chưa xác nhận bị từ chối ở lượt xác nhận (guard đọc lại registry). Muốn lùi luôn cổng báo cọc của Sale (`docs/plans/hermes-crm/revert/hermes_sale_deposit_receipt_key_revert_v1.sql`, nhánh split) thì lùi TC TRƯỚC: file đó từ chối khi `income_expenses.create` còn bật, vì thân cũ sẽ mở lại hai tool báo cọc.
- **CV:** tắt `tasks.delete` và xoá 4 dòng `task.recurring_*`, đưa về đúng trạng thái trước khi bật (`task.create`, `task.create_batch`, `task.update` vẫn sống). Quy tắc định kỳ đã tạo VẪN sinh việc mỗi đêm. Web chưa có màn quản lý quy tắc, nên tạm dừng / xoá quy tắc muốn dừng TRƯỚC khi lùi (qua Hermes lúc còn bật, hoặc migration dữ liệu có review).

Bật lại sau khi lùi: tạo forward migration MỚI (bản chép của file bật, tên mới). File đã áp là bất biến.

### 6.3 Tắt hẳn Công việc (quyết định riêng, chưa soạn file)

Phải tắt thêm `tasks.create` / `tasks.edit`. Mất luôn `task.create` / `task.update` / `task.create_batch` và tool theo dõi / nhắc việc (cần `tasks.create`). Tool tạo việc cũ vẫn nghỉ hưu vì `task.create` còn sống phía SQL, nên bot không tạo được việc nào. Cần migration riêng có rào legacy, và chủ chốt trước.

### 6.4 Khi có ghi sai thật

1. Phanh (6.1).
2. Lùi migration của trang (6.2).
3. Đối soát chỉ đọc: biên nhận `hermes_action_receipts` theo `request_id`, audit `HERMES_*`, dòng nghiệp vụ.
4. Sửa dữ liệu trên web bằng tài khoản của chủ, không bằng SQL tay.

## 7. `context_changed`, kết nối `inherit_crm` và bot owner đang chạy

- **Kết nối nhận khoá ngay, không tạo lại** (NEN-CHUNG mục 8.3). `hermes_registry_projection_v2` chạy cho mỗi câu lệnh trên registry và chiếu lại `action_capabilities` của mọi kết nối `inherit_crm` chưa thu hồi. Nó không đổi danh tính, epoch, credential hay loại trừ. Trigger Zalo `hermes_zalo_project_connection` chỉ chạy khi đổi epoch nên không bị kích. Kết nối `legacy_allowlist` không nhận khoá mới.
- **Lần TEST 23/10 phải tạo lại kết nối** là vì `actionPages: ["contract"]` + `sale_phong.lock_room` bị hai lớp cùng cấp, sinh `context_changed` cho mọi kết nối và tạo kết nối mới bị 409. #300 đã sửa (lớp Sale là nguồn duy nhất), có trong `3bd1313b`. `action-shared-keys.test.mjs` khoá bất biến; bật / tắt `actionPages` không đổi epoch.
- **Lúc áp migration:**
  - authority so ảnh chụp kết nối trước và sau trong CÙNG một lời gọi (`durable-authority.mjs`). Lời gọi đang chạy đúng lúc trigger cập nhật dòng kết nối có thể nhận `context_changed` một lần; gọi lại là được;
  - bản xem trước cấp trước lúc áp mà xác nhận sau lúc áp có thể phải xem trước lại;
  - vòng gia hạn token gặp thay đổi giữa chừng thì thử lại sau 30 / 60 / 120 / 240 giây (`connector-maintenance.mjs`), không chết token;
  - vì vậy áp lúc bot rảnh (5.0.4).
- **Sau áp**, nếu kết nối của owner báo `context_changed` ở MỌI lời gọi (≥ 3 lần liền) hoặc `connector_maintenance_*` báo lỗi kéo dài thì đó không phải hiện tượng thoáng qua.
  - Dừng, đọc journal `hermes-connector`, so lớp quyền cấp trùng.
  - Chỉ tạo lại kết nối khi đã loại trừ lỗi mã: kết nối mới `inherit_crm` + toàn tổ chức, thay token ở `config.yaml` và `.env` của profile owner, `docker restart hermes-owner`, thu hồi kết nối cũ.
- **Năm kết nối token chết** (từ 21/10) vẫn ACTIVE và vẫn được chiếu khoá. Chúng vô hại (token không gia hạn lại được), nhưng nên thu hồi để bảng kết nối phản ánh đúng ai giữ quyền ghi.
- **Màn `/settings/hermes`:** khoá vừa bật hiện ở màn tạo kết nối (hook options chỉ thêm khoá đang bật). Nhánh `production` của web đã có nhãn đủ 17 khoá.

## 8. Đã kiểm và chưa kiểm

- **Đã kiểm, offline:** `infra/hermes-broker/action-activation-sql.test.mjs` (PGlite, 14 ca). Fixture dùng bảng registry / chính sách / biên nhận thật, hai hàm + trigger chiếu lại thật, dữ liệu như production 28/10. Test chứng minh:
  - khoá mỗi file = khoá danh mục connector của trang;
  - các trang độc lập; chạy lại không đổi gì;
  - `inherit_crm` nhận / mất khoá mà không đổi epoch; legacy / REVOKED không đổi;
  - từng hàm / bảng / trigger / dòng chính sách / dòng registry thiếu ⇒ dừng trước khi ghi;
  - CV chèn đúng bốn dòng mục 22; rào legacy của file lùi; lùi rồi bật lại;
  - file nguyên văn chạy được rồi về đúng trạng thái 28/10;
  - TC: thiếu split (dòng `deposits.create_receipt`, sai mode, vỏ Sale chưa có cổng hoặc vắng) ⇒ dừng trước khi ghi; có split ⇒ qua; HĐ / HĐn / CV không phụ thuộc rào này.

  Kiểm đột biến bằng `HERMES_ACTIVATION_SQL_MUTATION`: 10/10 bị bắt (thêm `forward-skip-sale-deposit-guard`).
- **Đã kiểm, chỉ đọc trên production:** mục 2, gồm 81 chữ ký hàm có đủ.
- **Chưa kiểm:**
  - dry-run lane / cửa idempotent trên production và TEST (không chạy theo yêu cầu "không áp gì");
  - VPS (`current`, `actionPages`);
  - tầng 2 trên TEST;
  - canary bot thật;
  - phanh theo kết nối ở 6.1.
