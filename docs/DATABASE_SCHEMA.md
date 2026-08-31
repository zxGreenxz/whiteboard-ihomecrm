# Database schema

> **Reviewed:** 2026-08-06
> **Source of truth:** catalog production đã chụp + generated types, **không phải số đếm trong prose**.

## Inventory hiện tại

**Số đếm không còn viết tay.** Chạy `npm run catalog:capture` (chỉ đọc `pg_catalog`) và đọc
[`docs/generated/database-inventory.json`](generated/database-inventory.json).

Ảnh chụp 2026-08-06, PostgreSQL 17.6, project `tryymsxyyckgbrmmvozx`:

| Object public | Số lượng |
|---|---:|
| Bảng **logic** | 316 |
| Phân mảnh runtime (child partition) | 82 |
| Views | 12 |
| Hàm trong `public` + `app_private` | 1527 (1057 SECURITY DEFINER) |
| Enums | 30 |
| Bảng bật realtime | 30 |

Ba cạm bẫy khi đọc bảng trên — bản cũ của tài liệu này dính cả ba:

1. **Bảng logic ≠ tổng số bảng.** Tổng `pg_class` là 398, nhưng 82 trong đó là child partition do
   Network Center sinh **mỗi ngày**. Con số thiết kế là 316. Bất kỳ số nào bao gồm partition sẽ tự
   tăng theo lịch mà không ai đổi schema.
2. **`pg_proc` ≠ số RPC.** 1527 là mọi hàm kể cả overload và hàm nội bộ; số RPC mà frontend gọi
   được nhỏ hơn nhiều. Đừng so trực tiếp con số này với số function trong generated types.
3. **Số file migration ≠ số migration đã deploy.** Repository hiện có 731 file trong
   `supabase/migrations/` + 15 file trong `migrations-archive/`; ledger `schema_migrations` dừng
   trước schema đang chạy. Xem `docs/whiteboard-ihomecrm-architecture-agent-plan-2026-08-05 (1).md`
   Phần VI, và **đừng coi số file là bằng chứng đã deploy**.

Ảnh chụp cũng kiểm luôn ba invariant an toàn (tại 2026-08-06 đều xanh): mọi bảng logic bật RLS,
mọi view có `security_invoker=true`, mọi hàm SECURITY DEFINER có `search_path`.

## Cách xác định schema đúng

1. Đọc type của table/view/function trong [src/integrations/supabase/types.ts](../src/integrations/supabase/types.ts).
2. Tìm migration mới nhất chạm object bằng `rg "<object_name>" supabase/migrations`.
3. Với incident/cutover, đối chiếu catalog live read-only; ghi rõ project ref, UTC, query và commit.
4. Sau thay đổi schema đã deploy, chạy `npm run gen:types` rồi review diff generated types.

Không dùng các con số inventory như API ổn định. Khi cần số mới, đếm lại trực tiếp từ generated types và `supabase/migrations/`, rồi cập nhật ngày/commit ở đầu tài liệu.

## Các cụm schema chính

- **Tổ chức và quyền:** `organizations`, `organization_memberships`, `organization_roles`, `role_bindings`, `role_binding_scopes`, `authorization_scopes`, member overrides và `authorization_audit_events`.
- **Approval tài chính:** `approval_rule_sets`, `approval_rules`, `approval_rule_steps`, approver/candidate tables, `approval_requests`, request steps và decisions.
- **Bất động sản:** areas/buildings/floors/rooms/services/meters, customers/leads/deposits/contracts.
- **Tài chính:** invoices/items/payments, `income_expenses` + items/types/templates, accounts/cashbooks, handover/reconciliation và profit/salary tables.
- **AI Copilot:** provider/settings/entitlements/usage/conversation/message tables và `ai_write_audit`.
- **Zalo:** accounts/conversations/messages/send queue/labels/templates/automations.
- **Network Center** (`network_*`, **33 bảng**): thiết bị và phiên (`network_devices`,
  `network_device_current`, `network_device_leases`, `network_client_sessions`), vòng đời lệnh
  (`network_commands`, `network_command_attempts`, `network_command_events`,
  `network_command_observations`), trạng thái mong muốn (`network_desired_state_versions`,
  `network_config_snapshots`, `network_managed_resources`), sự cố (`network_incidents`,
  `network_incident_events`, `network_maintenance_windows`), và **đo lường dạng chuỗi thời gian**
  (`network_device_samples`, `network_interface_samples`, `network_metric_hourly`).
> Cụm **OpenClaw Zalo** (`openclaw_*`, từng là cụm lớn nhất với 79 bảng) đã bị **DROP toàn bộ
> 30/08/2026** — migration `20260830085316_xoa_toan_bo_openclaw.sql`. 16 migration tạo ra nó vẫn
> nằm trong repo (ledger đóng băng); replay từ baseline sẽ dựng lên rồi drop lại, đó là chủ ý.

### Partition theo ngày — đọc trước khi sinh types

`network_device_samples` / `network_interface_samples` sinh **child partition theo NGÀY**. Hệ quả cụ
thể, đã cắn thật:

- `types.ts` phình ~96 dòng mỗi ngày nếu để nguyên typegen thô, và job drift đỏ mỗi lần maintenance
  chạy — trong khi API logic không đổi một chữ.
- Nên có hai tầng: **raw live typegen** và **canonical generated types**.
  `npm run types:normalize` bỏ đúng các partition khớp policy và chỉ chúng; `npm run types:check`
  là gate. Chi tiết ở Contract §6 "Canonical vs raw: partition ngày".

Retention/lifecycle của các bảng phân vùng do job maintenance quản; đừng xoá partition bằng tay.

### Baseline và forward-only lane

Lịch sử legacy **không replay được** (trùng version + collision `001_`–`033_`), nên schema mới không
dựng bằng `supabase db push`:

- **Dựng lại**: `supabase/baseline/` (`roles.sql` trước, rồi `schema.sql` **hai lượt**) — xem
  [README baseline](../supabase/baseline/README.md) để biết vì sao hai lượt.
- **Thay đổi mới**: forward-only lane `npm run migrate:forward` với backup bắt buộc và evidence —
  xem [supabase/README.md](../supabase/README.md).
- **Trạng thái apply**: `npm run migrations:list-forward` · bằng chứng ở
  [`supabase/migration-provenance.json`](../supabase/migration-provenance.json).

Đừng dùng `max(ledger)` làm trạng thái schema: repo apply qua Management API nên nhiều thay đổi có
thật mà không sinh dòng ledger (`migration-policy.json#knownLimits`).

## RLS và writer

RLS bật trên dữ liệu nghiệp vụ; organization/scope là biên tenant. Helper `authorize_v2` và các RPC writer canonical phải fail closed. Không cho client tự tạo trạng thái tiền cuối cùng bằng REST insert/update nếu domain đã có writer.

15/15 canonical route flags đã ON ngày 19/07. Approval engine và inbox là luồng thật; maker không tự duyệt request engine. T7 drain quyền DML legacy vẫn là việc có điều kiện, vì vậy khi audit phải xem cả writer route lẫn fallback caller.

## Archive

`supabase/migrations-archive/20260617000001_forfeit_full_settlement.sql` là bản superseded, **không replay**. Luôn đọc README archive và các migration thay thế mới hơn.
