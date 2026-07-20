# Kế hoạch triển khai hệ thống Zalo + AI chăm sóc khách hàng

> **Lifecycle:** kế hoạch đã được review tới 2026-07-20 nhưng vẫn là prepare/review artifact cho các tranche tiếp theo. Authorization runtime hiện đã go-live 15/15; xem [authorization status](../authorization/README.md). Không suy ra “NO-GO authorization cutover” từ snapshot cũ bên dưới.

## Context

CRM đã có hai nền tảng quan trọng nhưng hiện còn tách rời:

- Chat Zalo cá nhân: schema `zalo_*`, giao diện 3 cột tại `/chat-zalo`, Realtime và worker `zca-js` chạy dài hạn.
- AI Copilot: `llm-proxy`, quota/kill switch/usage log, provider OpenAI-compatible, 9Router và tool registry.

Mục tiêu là biến phần Chat Zalo hiện có thành **trung tâm chăm sóc khách hàng đa tổ chức**, không xây thêm một hệ thống chat song song. Mỗi tổ chức kết nối tối đa một tài khoản Zalo cá nhân; nhân viên xử lý theo tòa/phòng; AI chỉ tự trả lời các intent an toàn, còn trường hợp riêng tư/nhạy cảm/không chắc chắn phải tạo bản nháp hoặc bàn giao ngay cho người thật.

Snapshot live đọc-only ngày 2026-07-15 cho thấy:

- 2 tổ chức, 10 membership active, 494 khách hàng, 271 hợp đồng active.
- 1.832 hội thoại và 2.883 tin Zalo, nhưng chưa hội thoại nào link khách/phòng/nhân viên.
- 1 tài khoản Zalo `connected`, 1 tài khoản `error`.
- Queue có 16 `sent`, 4 `failed`; live `issues` chưa có dữ liệu, trong khi `jobs` có 161 bản ghi.
- 45 hóa đơn `OVERDUE`, 10 `APPROVED`, 4 `PARTIAL_PAID`, nên tra cứu/nhắc giao dịch là nhu cầu thật nhưng phải khóa chặt identity và quyền dữ liệu.

Đối chiếu bổ sung (đã xác minh live 15/07 qua `pg_policies`/truy vấn trực tiếp):

- 0 row `zalo_*` có org NULL và 0 mismatch org so với `zalo_accounts.organization_id` — attribution hiện đã sạch vì cả 2 account cùng org PROD nên fallback membership trùng đáp án đúng.
- Cả 2 account đều `kind='personal'` và CÙNG một org (1 `connected` + 1 `error`).
- Chỉ 61/1.832 hội thoại có `peer_phone` (~3%).
- `zalo_*` hiện **không có** org-boundary RESTRICTIVE policy nào (không nằm trong `core[]` của Sprint 3b); RLS đang là owner-permissive (`user_id = auth.uid()` + `assigned_staff_id` cho SELECT conversation/message).

Điều này xác nhận thứ tự ưu tiên: **tenant boundary → connector/queue bền vững → xác minh danh tính và routing → inbox người thật → AI draft-only → auto-reply allowlist → chiến dịch giao dịch**.

Kế hoạch này tuân thủ quyết định hiện tại “prepare all, review first”. Không apply migration, không deploy worker, không bật AI tự gửi và không thay đổi production chỉ vì plan được chấp thuận. Mỗi tranche production phải có review bằng chứng và GO riêng. `docs/AUTHORIZATION-PLAN.md` là thiết kế baseline; runtime authorization hiện đã go-live theo status mới nhất, nhưng các gate Zalo về tenant boundary, queue, identity và anti-spam vẫn độc lập.

---

## 0. Trạng thái review, phạm vi được phép và quyết định còn mở

### 0.1 Phán quyết review 15/07/2026

**Trạng thái tài liệu: REVIEWED DRAFT — chưa phải lệnh triển khai production.**

- **GO ngay**: preflight read-only, test harness SQL/RLS, fake adapter, protocol contract, schema additive chưa cutover và rehearsal trên dữ liệu giả/ẩn danh.
- **CONDITIONAL GO**: cutover một account canary sang bridge không có service-role key, chỉ sau khi các gate P0 bên dưới có bằng chứng PASS và có maintenance/rollback runbook.
- **NO-GO hiện tại**: AI auto-send trên tài khoản cá nhân, proactive/bulk campaign, normalized authorization cutover, multi-organization rollout và mọi đường gửi chưa đi qua queue/policy v2.

Stop-the-line, tự động **NO-GO/pause** nếu có một trong các sự kiện:

- Cross-organization/cross-building access hoặc private disclosure khi identity chưa verified/group chat.
- Tin gửi tới recipient đã suppression/opt-out; sensitive auto-send; financial/contract mutation từ AI.
- Credential, QR, session, message body hoặc signed media URL xuất hiện trong log không được phép.
- Stale connector generation vẫn claim/ack được; automatic retry một attempt có thể đã qua provider boundary.
- Confirmed duplicate customer-visible send do hệ thống; account bị `LIMITED/challenged` có liên hệ với automation/campaign.

### 0.2 Document control bắt buộc trước mỗi tranche

Mỗi review packet phải ghi: document version, commit SHA, live snapshot time, migration list/checksum, reviewer security/product/operations/data protection, nguồn chính sách Zalo và ngày đối chiếu, open-decision count, GO approver và rollback owner. Con số quota/cap/rate không có nguồn chính thức phải ghi rõ là **guardrail nội bộ**, không mô tả như giới hạn Zalo chính thức.

### 0.3 Sáu quyết định P0 phải chốt trước production traffic

| ID | Quyết định cần chốt | Default an toàn khi chưa chốt | Bằng chứng/owner bắt buộc |
|---|---|---|---|
| D1 | Eligibility của `zca-js`/personal account cho automation và proactive send | Staff-assisted inbox + AI draft-only; campaign/auto-send off | Product/platform risk owner; điều khoản/nguồn Zalo có URL + ngày kiểm tra; account owner chấp thuận residual risk |
| D2 | Capability matrix riêng cho Personal Chat, OA Messaging và ZNS | Không suy capability/UID/consent từ kênh khác | Channel owner; adapter contract + official-source register |
| D3 | `zalo_conversations` là channel thread; care case là episode riêng | Không gắn một SLA/`resolved_at` duy nhất cho toàn bộ lịch sử thread | Product + data owner; state model reopen/close |
| D4 | Outbound wake-up hay chấp nhận idle polling latency | SLO pickup theo poll floor, không hứa ≤2 giây | Operations owner; load/cost test và SLI đo `queued_at → claimed_at` |
| D5 | Data classification, legal basis, retention/legal hold | Không ingest/cache thêm PII/media ngoài nhu cầu support tối thiểu | Data-protection owner; retention schedule/version + hold/deletion/export flow |
| D6 | Transitional authorization trong lúc normalized RBAC còn NO-GO | Current effective authority + helper hẹp derive resource; không dùng shadow | Security owner; permission/resource matrix + negative tests |

### 0.4 Trust boundary checklist

Sáu vùng tin cậy phải được thể hiện trong architecture packet: browser; Supabase Auth/RLS/Postgres; privileged Edge Functions; connector VPS per-account; Zalo Personal/OA/ZNS; LLM/external services. Với mỗi đường gọi phải ghi caller identity, credential, resource scope, replay protection, schema/body limit, PII được phép, timeout/retry owner, audit event và kill switch. Edge Function có service role vẫn chỉ được gọi RPC hẹp; không được trở thành CRUD proxy tùy ý.

---

## 1. Quyết định kiến trúc

### 1.1 Hướng duy nhất được đề xuất

Giữ và harden các bảng canonical hiện có (đủ 7 bảng, không phải 5):

- `zalo_accounts`
- `zalo_conversations`
- `zalo_messages`
- `zalo_send_queue`
- `zalo_message_templates`
- `zalo_labels` — cùng org hardening/RLS như các bảng trên.
- `zalo_automations` — per-user, kind `broadcast_vacant|auto_reply`, UNIQUE(user_id,kind); **deprecate có lộ trình**: config migrate sang `automation_mode` per-conversation + AI policy org-level (Migration D), giữ read-only trong transition, revoke ở cutover (mục 3.6).

Bổ sung các bảng con cho identity, care workflow, AI, knowledge, campaign và audit. Không tạo một bộ `care_messages/care_conversations` thứ hai vì sẽ gây hai nguồn sự thật, backfill phức tạp và làm mất giá trị của UI/Realtime hiện có.

Luồng đích:

```text
Zalo cá nhân
  → ZcaPersonalAdapter trên VPS
  → Edge Function zalo-bridge-api (credential buộc theo account)
  → RPC ingest transaction + dedupe
  → zalo_messages/conversations + durable care work
  → Edge Function zalo-care-orchestrator
  → deterministic policy + scoped CRM tools
  → llm-proxy → 9Router/provider allowlisted
  → AUTO_REPLY | DRAFT_REVIEW | HANDOFF | NO_ACTION
  → durable zalo_send_queue
  → bridge claim/lease/send/ack
  → audit + Realtime + alert đúng nhân viên
```

### 1.2 Ranh giới runtime

1. **Frontend CRM** chỉ đọc qua RPC phân trang và mutation qua RPC. Không direct insert/update vào message, identity, AI run, queue, campaign hay account state.
2. **Supabase/Postgres** là control plane và nguồn sự thật cho tổ chức, quyền, identity, conversation, queue, audit, retention.
3. **`zalo-bridge-api`** là biên duy nhất mà connector VPS được gọi. VPS không giữ Supabase service-role key.
4. **`zalo-care-orchestrator`** chạy server-side dưới dạng Edge Function. Database webhook kích hoạt nhanh khi có work mới; Supabase Cron chạy recovery sweep để không phụ thuộc webhook như durable queue.
5. **`llm-proxy`** tiếp tục là cổng AI duy nhất. Browser và Zalo adapter không gọi 9Router trực tiếp.
6. **VPS** chạy 9Router và các connector trong container/process riêng, network/secret/volume/resource cap riêng. Một connector instance chỉ được buộc vào một `zalo_account_id`.

### 1.3 Seam chuyển sang Zalo OA

Refactor worker quanh contract không phụ thuộc `zca-js`:

```ts
interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(reason: string): Promise<void>;
  health(): Promise<ChannelHealth>;
  onEvent(handler: (event: CanonicalChannelEvent) => Promise<void>): void;
  send(command: OutboundCommand): Promise<SendResult>;
  syncRecent?(since: string): Promise<CanonicalChannelEvent[]>;
  capabilities(): ChannelCapabilities;
}
```

- `ZcaPersonalAdapter` triển khai staff-assisted MVP; auto-send/proactive mặc định off cho tới khi D1 được GO.
- `FakeChannelAdapter` dùng cho test/staging.
- Tách rõ `ZaloOfficialAccountMessagingAdapter` và `ZaloZnsNotificationAdapter`; không gom OA chat và ZNS vào một adapter vì webhook/token/template/quota/reply-window khác nhau.
- Message/queue giữ được phần lõi channel-neutral, nhưng OA/ZNS onboarding vẫn bắt buộc capability matrix, identity re-link/re-consent và migration rehearsal. Không kế thừa verified link chỉ vì tên/phone trùng; personal UID và OA UID là namespace khác nhau.
- Canonical identity key gồm `(organization_id, provider, product/channel, account_scope, subject_namespace, provider_subject_id)`.
- Domain không import type từ `zca-js`; mọi behavior phải capability-gated thay vì mặc định adapter nào cũng hỗ trợ reaction/seen/group/media/proactive send.

Capability matrix phải được điền bằng tài liệu chính thức/contract test trước khi enable; default là deny:

| Capability | Personal (`zca-js`) | OA Messaging | ZNS |
|---|---|---|---|
| Inbound/staff reply | Unofficial, canary-only | Xác minh official webhook/reply rules | Không coi là chat |
| Proactive send | NO-GO mặc định | Chỉ khi policy OA cho phép | Theo approved template/category |
| Group/reaction/seen/media | Adapter-specific | Adapter-specific | Không giả định |
| Identity/consent | Personal UID namespace | OA user namespace + OA consent | ZNS recipient/template basis |
| Delivery/quota/SLO | Không có platform guarantee | Theo nguồn OA hiện hành | Theo nguồn ZNS hiện hành |

### 1.4 Quyết định nghiệp vụ quan trọng

- `customers` và `contract_customers` là customer/occupancy canonical; không dùng legacy `tenants` làm identity chăm sóc khách hàng.
- Dữ liệu Zalo/care là tài sản của organization. Các FK `user_id ... ON DELETE CASCADE` legacy phải được chuyển thành provenance (`created_by`/`legacy_owner_id`, nullable `ON DELETE SET NULL` hoặc `RESTRICT`); xóa/offboard creator không được xóa account, conversation, message, template, queue hay audit của tổ chức.
- `zalo_conversations` là **channel thread sống lâu dài** theo `(account_id,thread_id)`, không phải một support case duy nhất. Thêm `zalo_care_cases`/episode cho từng lần mở–đóng–reopen, SLA, priority, assignee, opening/closing message, resolution và job link; conversation chỉ giữ inbox state/latest active case. `jobs` là work order/yêu cầu vận hành được tạo từ care case/conversation.
- Không kích hoạt hoặc sửa toàn bộ `issues` trong MVP. Live `issues` = 0, trong khi `jobs` có UI desktop/mobile và dữ liệu thật; trigger SLA của `issues` còn có lỗi thứ tự `BEFORE UPDATE` đã xác minh.
- AI không được sửa hợp đồng, hóa đơn, thanh toán, số dư, tiền cọc hoặc sổ quỹ.
- Phone matching chỉ tạo gợi ý cho nhân viên; không bao giờ tự xác minh danh tính.
- Group chat không được nhận dữ liệu riêng tư của khách/phòng/hợp đồng/tài chính.
- Proactive MVP chỉ có thông báo giao dịch, không marketing, không upload audience tùy ý.

---

## 2. Tenant boundary và authorization — dependency bắt buộc

### 2.1 Sửa attribution trước khi dùng organization làm authority

Các migration Sprint 3 hiện có hai vấn đề phải sửa bằng migration mới, không sửa migration đã apply:

- Zalo backfill trong `20260713120000_sprint3a_org_rollout_all_tables.sql` đi qua `public.accounts` (bảng kế toán) thay vì `public.zalo_accounts`.
- `_autofill_org()` trong `20260713121000_sprint3b_org_autofill_and_boundary.sql` cũng suy `account_id` qua `public.accounts` và policy vẫn cho `organization_id IS NULL`.

Tranche preflight phải:

1. Lập artifact read-only về mọi `zalo_*` row có org null, org sai parent, account không map duy nhất hoặc nhiều personal account/org.
2. Derive org của conversation/message/queue/label từ `zalo_accounts.organization_id`; nếu mơ hồ thì đưa vào bảng anomaly/review, không gán mặc định.
3. Đặt `organization_id NOT NULL` cho toàn bộ Zalo/care/AI/campaign rows sau khi mismatch = 0.
4. Thêm composite integrity hoặc constraint trigger bảo đảm child và parent cùng organization.
5. Thêm unique partial index: tối đa một account `kind='personal'` có `lifecycle_status='ENABLED'` cho mỗi organization; health tạm thời không giải phóng slot.
6. Không gắn generic `_autofill_org()` vào Zalo. Dùng trigger/RPC riêng derive từ parent tin cậy.
7. Policy Zalo/care phải fail closed; tuyệt đối không giữ nhánh `organization_id IS NULL`.
8. Chính xác hoá hiện trạng (đã xác minh live 15/07): `zalo_*` hiện **chưa có** org-boundary RESTRICTIVE policy nào — tranche A3 phải **THÊM MỚI** policy fail-closed cho cả 7 bảng, không phải sửa policy cũ.
9. Attribution live hiện đã sạch (0 org NULL, 0 mismatch): artifact preflight expectation là PASS ngay với dữ liệu hiện tại; giá trị của gate là chống sai lệch tương lai khi thêm organization mới.
10. Trước khi bật fail-closed policy: xác nhận mọi user có quyền `chat_zalo.*` đều có ACTIVE membership (live: toàn bộ staff trong `staff_assignments` OK; còn 1 profile chưa có membership ACTIVE cần rà).
11. Unique partial index "một personal account/org" sẽ đụng dữ liệu thật: org PROD đang có 2 account `kind='personal'` (1 `connected`, 1 `error`); `status='error'` không đồng nghĩa lifecycle disabled — preflight phải audit-disable/resolve account lỗi trước, rồi index theo `lifecycle_status='ENABLED'`.

### 2.2 Một authorization boundary ổn định cho care

Tạo helper nội bộ `zalo_authorize_conversation(p_conversation_id, p_action)` và `zalo_authorize_account(p_account_id, p_action)`:

- Derive actor bằng `auth.uid()`.
- Derive organization/account/building/room từ resource, không tin `organization_id` client gửi.
- Yêu cầu `organizations.status='ACTIVE'`, membership `status='ACTIVE'`, `valid_from <= statement_timestamp()` và `valid_to IS NULL OR valid_to > statement_timestamp()`; organization suspended/closed hoặc membership chưa hiệu lực/hết hạn phải deny.
- Map action sang permission key chính xác; key mới chưa tồn tại phải default-deny, không fallback sang quyền legacy rộng hơn.
- Kiểm tra building/area bằng nguồn authorization đang effective (`staff_assignments`, `can_access_building`, `can_do_on_building`).
- Normalized `authorize_v2` tiếp tục shadow cho tới khi parity/cutover trong authorization plan được review; care không được âm thầm coi helper shadow là production authority.
- Assignment/routing chỉ chọn trong số nhân viên đã có quyền; assignment không cấp thêm quyền.

Permission giữ tương thích và bổ sung hẹp:

- Có sẵn: `chat_zalo.view`, `send`, `manage_automation`, `manage_templates`.
- Bổ sung: `assign`, `takeover`, `verify_identity`, `review_ai`, `manage_ai_policy`, `manage_knowledge`, `approve_campaign`, `manage_account`, `view_audit`, `manage_operations`.
- `zalo_authorize_*` **thay thế** helper `zalo_can()` legacy (hiện đọc thẳng `staff_assignments.permissions->'chat_zalo'`); tuyệt đối không tạo mirror thứ ba của `get_my_permissions` (án lệ `ai_copilot_perms_for` đã phải sync tay mỗi lần đổi logic) — helper mới gọi chung nguồn permission đang effective.
- Key mới phải seed đồng bộ đủ 3 nơi: `permission_definitions` (migration), `src/lib/permissions.ts`, `src/lib/permissionPages.ts` (catalog trang + fallback `canUse`).

Mọi RPC `SECURITY DEFINER` phải:

- Pin `search_path`, qualify object, revoke `PUBLIC/anon`, grant đúng role.
- Derive org/actor từ resource/auth, không nhận org như authority.
- Lock state trước transition, validate độ dài/schema JSON, không dynamic SQL từ input.
- Ghi audit trong cùng transaction.
- Có negative test cross-org, cross-building, revoked membership và forged parent IDs.

---

## 3. Data model và migration ordering

Không sửa các migration `20260626...` hoặc `20260713...` đã tồn tại. Tạo migration mới theo thứ tự sau; timestamp thực tế được chốt lúc triển khai để tránh collision.

### 3.1 Tranche A0–A3 — tenant preflight, correction và enforcement

Không gộp read-only preflight, sửa dữ liệu, constraint và ACL cutover vào một transaction. Nếu migration vừa insert anomaly vừa `RAISE`, transaction rollback sẽ làm mất chính artifact cần review.

- **A0 — read-only preflight ngoài migration transaction**: xuất artifact có timestamp/code SHA về org null/sai parent, orphan, duplicate personal account, queue stuck, legacy state không map được; không chứa chat body/PII không cần thiết. Artifact phải đếm cả **directory-only conversation** (chưa có message nào) làm input cho quyết định D5 — live 15/07: 1.756/1.832 (~96%, gồm 1.456 user + 300 group) là bản sao danh bạ từ `syncContacts`, chỉ 76 thread có tin thật; D5 chốt purge/quarantine hay giữ số này.
- **A1 — reviewed correction/quarantine**: correct organization qua `zalo_accounts`; row không derive duy nhất phải quarantine/fail closed, tuyệt đối không fallback về org PROD.
- **A2 — additive constraints**: thêm column/index/composite FK; với bảng lớn dùng backfill batch, `NOT VALID`/validate sau nếu cần giảm lock; chưa revoke legacy path.
- **A3 — authorization/ACL cutover**: chỉ chạy sau khi bridge/RPC v2, frontend compatibility, Realtime/RLS negative tests và rollback rehearsal đều PASS; sau đó mới revoke direct writes/RPC cũ và bật org RESTRICTIVE policy.

Deliverables chi tiết:

- Tạo `zalo_migration_anomalies` cho row mơ hồ, reason, source table/id, resolution state; không chứa nội dung chat/PII không cần thiết.
- Correct organization backfill qua `zalo_accounts`.
- Validate account → conversation → message/queue/label cùng org.
- Backfill `building_id` chỉ khi suy ra duy nhất từ room/current canonical contract; trường hợp nhiều hợp đồng/phòng giữ unresolved.
- Đưa customer links cũ (nếu có) thành candidate `PENDING`, không coi là verified.
- Resolve account `status='error'` bằng transition `lifecycle_status='DISABLED'` có audit (hoặc gỡ theo runbook đã duyệt) trước khi tạo unique partial index một-personal-account/org.
- Thêm candidate key `(organization_id,id)` và composite FK/constraint tương ứng.
- Chuyển ownership FK theo hai bước có thứ tự (đã xác minh 15/07: cả 7 bảng đang `user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE`): **A2** đổi `ON DELETE CASCADE → RESTRICT` (an toàn ngay — chỉ chặn xoá user, không đụng RLS owner-based đang chạy); sang **A3** (khi org RESTRICTIVE policy đã live và RPC v2 không còn key theo user_id) mới đổi semantics sang `created_by`/`legacy_owner_id` nullable `SET NULL`. Đổi sớm nullable sẽ vỡ RLS hiện hành vì mọi policy đang key `user_id = auth.uid()`.
- Add fail-closed RLS — **thêm mới** org-boundary RESTRICTIVE cho cả 7 bảng `zalo_*` (gồm `zalo_automations`, `zalo_labels`; hiện chưa có policy org nào) — và revoke direct authenticated write theo từng tranche sau khi RPC v2 sẵn sàng.
- Gate: anomaly chưa resolved hoặc mismatch > 0 thì migration cutover phải fail.

### 3.2 Migration B — `*_zalo_care_transport_reliability.sql`

#### Mở rộng `zalo_accounts`

Thêm:

- `organization_id NOT NULL`.
- Tách lifecycle khỏi health: `lifecycle_status = ENABLED | DISABLED`; unique partial `(organization_id) WHERE kind='personal' AND lifecycle_status='ENABLED'`. Trạng thái login/limited/paused không giải phóng slot account. Thay account là transition audit: disable account cũ rồi mới enable account mới.
- `health_status`: `LOGIN_REQUIRED | CONNECTING | CONNECTED | DEGRADED | LIMITED | PAUSED`.
- `reauth_required`, `automation_paused`, `outbound_paused`, `pause_reason`.
- `last_heartbeat_at`, `last_event_at`, `connected_at`, `disconnected_at`, `last_error_code`.
- `state_version` để chống worker cũ quay lại.

QR là credential/challenge ngắn hạn, **không lưu trong generic `zalo_accounts` và không publish Realtime**. Dùng login-challenge riêng: one-time ID, manager `manage_account` only, TTL ngắn, no-cache, chỉ caller tạo challenge được đọc, xóa ngay khi used/expired và rate-limit số lần tạo; staff chỉ có `view` chỉ thấy health metadata. Session cookie không được lưu DB.

Số phận cột legacy trên `zalo_accounts` (hiện trạng đã xác minh 15/07: bảng đang nằm trong publication `supabase_realtime` → `qr_data` hiện phát qua Realtime cho mọi subscriber):

- `status` CHECK cũ (`connected|disconnected|error|connecting|waiting_scan`) giữ nguyên cho worker cũ đọc/ghi tới cutover; `health_status`/`lifecycle_status` là nguồn sự thật mới (trigger sync một chiều nếu cần); drop `status` sau observation window.
- `qr_data`/`qr_expires_at`: ngừng ghi ngay khi login-challenge flow hoạt động, xoá dữ liệu tồn đọng, DROP cột ở Migration F; đồng thời gỡ `zalo_accounts` khỏi publication hoặc bảo đảm cột QR không còn tồn tại trước khi giữ bảng trong publication.

#### Mở rộng `zalo_messages`

Thêm:

- `organization_id NOT NULL`, `correlation_id`.
- `source`: `LIVE | HISTORY_SYNC | STAFF | AI | CAMPAIGN | SYSTEM`.
- `external_message_id`/chuẩn hóa `zalo_msg_id`.
- `client_idempotency_key` thay cho client ID dựa `Date.now()`.
- `automation_control_version`, `ai_run_id`, `campaign_recipient_id`.
- `content_purge_after`, `content_purged_at`, error code redacted.
- Mở rộng CHECK `status` hiện tại (`pending|sent|delivered|seen|failed`) thêm `unknown | cancelled` khớp state machine outbound mới.

Indexes:

- Unique partial `(account_id, external_message_id)`.
- Unique partial `(account_id, client_idempotency_key)`.
- Cursor index `(organization_id, conversation_id, created_at DESC, id DESC)`.

#### Harden `zalo_send_queue`

Thêm trạng thái `queued | processing | retry_wait | paused | sent | failed | unknown | dead | cancelled` và các cột:

- `idempotency_key`, unique theo `(organization_id,idempotency_key)`.
- `available_at`, `attempts`, `max_attempts`.
- `lease_owner`, `lease_token_hash`, `lease_generation`, `lease_expires_at`.
- `next_attempt_at`, `processed_at`, `dead_at`.
- `provider_message_id`, `correlation_id`, `last_error_code`, detail redacted.
- `created_control_version`, để claim recheck takeover race.
- `queue_class`, `priority`, `conversation_sequence`, `claimed_at`; claim deterministic và không cho quá một outbound in-flight trên cùng account/conversation (hoặc peer). Support/manual reply ưu tiên hơn campaign, có aging/fairness để campaign không starvation.

Semantics bắt buộc: exactly-once cho state transition nội bộ; at-least-once processing; external delivery không guaranteed exactly-once. Attempt đã bắt đầu gọi provider nhưng mất ACK phải thành `unknown` và manual reconcile, không automatic retry. Thêm `zalo_outbound_attempts` append-only để lưu attempt, outcome, provider ID/hash và ambiguous outcome; không lưu credential/body thừa.

Backfill 20 row queue hiện hữu sang state machine mới: `sent` → `sent`, `failed` → `dead` (kèm `dead_at`), có audit.

#### Bảng mới

- `zalo_inbound_events`: unique `(account_id,event_key)`, payload hash, metadata allowlist, occurred/received/processed time, linked message, retention timestamps. Nội dung tin ở `zalo_messages`, không nhân đôi raw payload lâu dài.
- `zalo_care_work_queue`: durable work cho `INBOUND_POLICY`, `AI_ORCHESTRATION`, `STAFF_ALERT`, `CAMPAIGN_EXPAND`, `RETENTION`; claim bằng `FOR UPDATE SKIP LOCKED`, lease/retry/dead-letter như outbound.
- `zalo_bridge_credentials`: credential key ID, account binding, hash, validity/revocation/last-used. Không giữ plaintext. Request ghi dùng secret đủ entropy + key ID, account/lease-generation binding, timestamp window, unique nonce/request ID, body hash, replay cache, constant-time compare, rate limit và rotation overlap ngắn; TLS bắt buộc.
- `zalo_account_leases`: một lease/generation/account để bảo đảm single listener/sender.
- `zalo_audit_events`: append-only, actor type, object, action, correlation/policy version và detail đã redacted.

#### RPC transport/internal

- `zalo_bridge_claim_account_lease`
- `zalo_bridge_renew_account_lease`
- `zalo_bridge_release_account_lease`
- `zalo_bridge_ingest_event`
- `zalo_bridge_ingest_events` — biến thể batch (mảng, thứ tự bảo toàn, kết quả per-event) cho history/bulk sync; dedupe kiểu INSERT-nếu-chưa-có, không UPDATE đè row cũ (tránh bão Realtime — xem 7.6)
- `zalo_bridge_report_health`
- `zalo_bridge_claim_outbound` — nhận batch (p_limit) và kiêm heartbeat/health trong cùng call; enforce rate window/`available_at` tại đây (caps là luật DB, không phải sleep phía worker)
- `zalo_bridge_ack_sent`
- `zalo_bridge_ack_failed`
- `zalo_bridge_sync_contacts`
- `zalo_bridge_sync_labels`
- `zalo_claim_care_work`
- `zalo_complete_care_work`
- `zalo_fail_care_work`
- `zalo_reap_expired_leases`

Canonical protocol phải có `schema_version`, provider/product/account, capability set, provider event/command ID, deterministic versioned fallback key, provider-occurrence/connector-received/bridge-persisted timestamps, thread/sender namespace, connector generation và correlation ID. Bridge/connector handshake khai báo min/max protocol version; version/capability không tương thích phải reject rõ, không parse best-effort. Outbound dùng typed command (`SEND_TEXT`, `SEND_MEDIA`, `REACT`, `RECALL`, `MARK_PROVIDER_READ`) với validation/rate/retry policy riêng.

`zalo_bridge_ingest_event` là một transaction: authenticate account binding → dedupe event → upsert peer/conversation → insert message → atomic unread increment/preview → routing → staff alert work → AI-policy work → audit. Duplicate phải trả message cũ và **không** tăng unread, push hay tạo work lần hai.

Canonical event phải phủ đủ hành vi worker hiện có, kẻo mất tính năng khi cắt service-role key: `REACTION`, `UNDO`, `SEEN` đi qua `zalo_bridge_ingest_event` (idempotent theo event_key, cập nhật message hiện hữu, không tạo work AI). Contact/label sync đi qua `zalo_bridge_sync_contacts`/`zalo_bridge_sync_labels` dạng batch, giới hạn kích thước, chỉ metadata allowlist, không đụng unread/routing; mặc định sync delta/peer đã có business thread, không materialize toàn bộ `getAllFriends`/`getAllGroups` nếu chưa có D5 legal-purpose approval.

### 3.3 Migration C — `*_zalo_care_identity_routing.sql`

#### Identity và privacy

- `zalo_channel_identities`: provider/product/account scope/subject namespace/provider subject ID unique, direct/group kind, display metadata, first/last seen. Chỉ materialize identity đã xuất hiện trong business conversation hoặc được staff allowlist có căn cứ; không full-sync toàn bộ friends/groups mặc định.
- `zalo_customer_links`: identity, customer, `PENDING | VERIFIED | REJECTED | REVOKED`, evidence category/reference, assurance level/purpose/expiry/reverification policy, requested/approved/revoked actor/timestamp, version.
- `zalo_customer_link_events`: append-only transition history.
- `zalo_contact_preferences`: support response và proactive transactional status; source/legal-basis enum, evidence, effective/expiry/revocation/version.
- `zalo_contact_preference_events`: append-only opt-in/opt-out history. Opt-out rõ ràng như `STOP`/“đừng nhắn” phải tạo suppression proactive **có hiệu lực ngay** trong transaction ingest; staff chỉ review câu mơ hồ hoặc release suppression sau đó có reason/audit.
- `zalo_suppressions`: `PROACTIVE_TRANSACTIONAL | ALL_OUTBOUND`, reason/effective/expiry/release.
- Hàm immutable `normalize_phone_vn(text)` + generated column/index trên `customers.phone` (live đang lẫn 10 và 11 chữ số, chưa có chuẩn hóa server-side nào) — chỉ phục vụ candidate suggestion, không phải bằng chứng verify.

Constraints:

- Chỉ direct identity được verify.
- Một identity chỉ có một verified customer đang hiệu lực.
- `VERIFIED` bắt buộc approver, timestamp, evidence; `REVOKED` bắt buộc actor/reason.
- Identity, customer và account phải cùng org.
- Phone/name match chỉ là UI suggestion; không tạo `VERIFIED` bằng trigger hoặc AI.

Revocation trong một transaction phải khóa private context, cancel sensitive queued drafts/messages, mark campaign recipients stale/suppressed và tăng conversation control/context version.

#### Conversation support state

Mở rộng `zalo_conversations` cho **thread-level inbox state**:

- `organization_id NOT NULL`, `channel_identity_id`, `building_id`.
- `automation_mode`: `AUTO | DRAFT_ONLY | HUMAN | PAUSED`.
- `control_version`, `context_version`.
- `assigned_staff_id`, `assignment_source`, latest active case reference.
- `identity_link_id`, customer/contract/room refs chỉ khi verified và canonical context hợp lệ (reuse các cột `customer_id/contract_id/room_id/assigned_staff_id` đã có sẵn nhưng đang trống — không tạo cột trùng).
- `lead_id` và `kind` CHECK (`tenant|lead|broker|unknown`) hiện có: giữ read-only trong transition; Customer 360 chỉ dùng canonical `customers`; `LeadInfo`/`BrokerInfo` tiếp tục hiển thị từ `profile` jsonb cho tới khi có quyết định riêng cho leads/brokers.

Thêm:

- `zalo_care_cases`: một episode support có `OPEN | WAITING_STAFF | WAITING_CUSTOMER | RESOLVED | CLOSED`, priority, assignee, opening/closing message, first response/resolution SLA timestamps, resolution, reopen linkage, `control_version`; không ghi đè lịch sử case cũ khi thread có yêu cầu mới.
- Vòng đời case mặc định (default an toàn cho D3, owner có thể chỉnh): ingest transaction tự mở case `OPEN` khi inbound đến mà thread không có case active; inbound trong ≤72h sau `RESOLVED` thì reopen chính case đó (ghi reopen linkage), quá 72h hoặc case đã `CLOSED` thì mở case mới; `RESOLVED` không có inbound sau 7 ngày được cron tự chuyển `CLOSED` (audit). Tối đa một case active/thread (unique partial index).
- `zalo_routing_responsibilities`: org/building/optional room/staff/priority/effective dates; chỉ cho staff vốn đã có scope.
- `zalo_assignment_events`: append-only.
- `zalo_handoffs`: reason, AI/source, assignee, requested/ack/closed state.
- `zalo_internal_notes`: nội bộ, retention 12 tháng, không phải message gửi khách.
- `zalo_sla_policies` và `zalo_sla_events`; SLA update qua RPC explicit, không tái dùng trigger ordering của `issues`.
- `zalo_job_links`: unique job, conversation, care case, source message, AI run, idempotency/provenance.

Routing priority:

1. Context room đã staff xác nhận.
2. Trách nhiệm room cụ thể.
3. Trách nhiệm building.
4. Organization intake queue.

Nếu approved customer có nhiều hợp đồng/phòng active và không suy ra duy nhất: active care case ở `WAITING_STAFF`, conversation context giữ unresolved; AI không tra cứu riêng tư cho tới khi staff chọn context.

#### RPC UI nghiệp vụ

- `zalo_list_inbox(p_cursor,p_limit,p_filters)`
- `zalo_get_conversation_context(p_conversation_id)`
- `zalo_list_messages_page(p_conversation_id,p_before,p_limit)`
- `zalo_send_message_v2(p_conversation_id,p_body,p_idempotency_key,p_reply_to)`
- `zalo_mark_read_v2(p_conversation_id,p_through_message_id)`
- `zalo_assign_conversation`
- `zalo_take_over_conversation`
- `zalo_release_conversation_automation`
- `zalo_request_customer_link`
- `zalo_approve_customer_link`
- `zalo_reject_customer_link`
- `zalo_revoke_customer_link`
- `zalo_add_internal_note`
- `zalo_request_handoff`
- `zalo_resolve_care_case`
- `zalo_close_care_case`
- `zalo_reopen_care_case`
- `zalo_create_job_from_conversation`

`zalo_create_job_from_conversation` phải validate identity/org/building/room/care case, sanitize title/description, dedupe theo `(organization_id,source_message_id,operation)`, insert `jobs` + `zalo_job_links` + audit trong một transaction. Generator mã job (`generate_job_code`) đã được vá secdef + `pg_advisory_xact_lock` từ 20260527000001 (là reference pattern của 20260701000001) — không cần re-fix; phần còn thiếu là retry-on-unique-conflict ở RPC khi hy hữu trùng mã, vì exactly-once theo source không ngăn collision giữa hai source khác nhau. AI chỉ được tạo job/note/handoff; không tạo material usage hoặc tác động tiền.

### 3.4 Migration D — `*_zalo_care_ai_knowledge.sql`

#### Knowledge base theo organization

- `zalo_knowledge_articles`: parent, title/category/status owner.
- `zalo_knowledge_versions`: `DRAFT | IN_REVIEW | APPROVED | PUBLISHED | RETIRED`, version, body/source hash, submit/approve/publish actor/time; published immutable.
- `zalo_knowledge_chunks`: version, ordinal, heading/content/token count/checksum, generated `tsvector`.

MVP retrieval dùng PostgreSQL full-text + `pg_trgm`, filter bắt buộc theo organization và đúng published version được pin vào AI run. Với <500 khách hàng, chưa cần vector DB/embedding; tránh thêm provider và cross-tenant index trước khi có nhu cầu đo được.

#### AI policy/decision state

- `zalo_ai_policy_versions`: intent allowlists, confidence threshold, max autonomous turns, tool/model allowlist, prompt/KB refs, approval/publish/checksum.
- `zalo_prompt_versions`: prompt + JSON schema, immutable sau publish.
- `zalo_ai_runs`: conversation/trigger message, identity/policy/prompt/KB/model snapshots, intent/confidence/risk/reason, proposed/final action, token/cost/status/correlation.
- `zalo_ai_tool_calls`: sequence, tool, args/result redacted, authorization outcome, idempotency.
- `zalo_ai_drafts`: body, `PENDING | AUTO_APPROVED | STAFF_APPROVED | REJECTED | SUPERSEDED | SENT`, control version, reviewer, purge timestamps.

Mở rộng AI backend hiện có:

- Exact model catalog/allowlist, positive integer-micro pricing và effective dates.
- Usage reservation cho purpose `CARE_ORCHESTRATION`, gắn organization và `zalo_ai_run_id`, giữ nguyên flow Copilot user hiện có.
- Internal workload authentication giữa orchestrator và `llm-proxy`; proxy derive org/policy/model từ run row, không tin header model/org.
- Request body limit, message/tool/result length limit, correlation ID.
- Unknown model, model không allowlist hoặc pricing 0/unknown phải reject trước upstream.

RPC AI nội bộ:

- `zalo_start_ai_run`
- `zalo_record_ai_decision`
- `zalo_finalize_ai_outcome`
- `zalo_lookup_support_customer`
- `zalo_lookup_support_contract`
- `zalo_lookup_support_invoice`
- `zalo_lookup_open_jobs`
- `zalo_create_job_as_ai`
- `zalo_add_note_as_ai`
- `zalo_handoff_as_ai`
- `zalo_approve_ai_draft`
- `zalo_reject_ai_draft`

Mọi lookup private nhận `conversation_id`/`ai_run_id`, derive org/customer/scope lại, đòi direct verified identity và chỉ trả allowlisted display facts. Không có generic SQL/REST tool và không tái dùng unrestricted Copilot write tool.

### 3.5 Migration E — `*_zalo_care_transactional_campaigns.sql`

Harden `zalo_message_templates` thành versioned/approved template:

- organization, purpose, version, status, checksum, approver/time, sensitivity, requires_verified_identity.
- Existing templates backfill thành `DRAFT`.
- UI dùng `body`, sửa lỗi hiện tại đang chỉ select/insert `title`.

Thêm:

- `organizations.timezone` dạng IANA canonical, `NOT NULL` trước khi enable campaign; quiet-hours/due scanner dùng timezone này. Thay đổi timezone sau approval phải re-evaluate dispatch window và có behavior/audit rõ.
- `zalo_notification_events`: durable occurrence từ invoice/contract/job/service events; unique occurrence key.
- `zalo_transactional_campaigns`: source event, account, template version, audience snapshot/hash, status, submit/approve/pause/cancel actors, approval expiry.
- `zalo_campaign_recipients`: customer/verified identity/conversation/source fact/rendered body hash/status/suppression/message/idempotency.

Purpose MVP chỉ gồm:

- `INVOICE_DUE`
- `DEBT_REMINDER`
- `CONTRACT_EXPIRY`
- `SERVICE_REQUEST_UPDATE`
- `SERVICE_ANNOUNCEMENT`

Không có enum marketing và không nhận CSV/custom arbitrary recipients.

Luồng: domain event/date scanner → campaign draft → resolve candidate → staff preview → submit → authorized approval → immutable recipient snapshot → dispatch recheck → common outbound queue. Mọi batch đều cần approval; content/audience/template/source fact thay đổi thì tạo approval mới.

RPC:

- `zalo_generate_due_events(p_as_of)` chạy bởi Cron.
- `zalo_preview_campaign`
- `zalo_submit_campaign`
- `zalo_approve_campaign`
- `zalo_pause_campaign`
- `zalo_resume_campaign`
- `zalo_cancel_campaign`

Dispatch recheck identity, opt-out/suppression, source fact hash, quiet hours, account health, campaign expiry, per-peer/account cap. Opt-out sau approval luôn thắng.

### 3.6 Migration F — `*_zalo_care_retention_and_cutover.sql`

- `zalo_retention_runs` và `zalo_run_retention(p_batch_size)`.
- Retention schedule phải được data owner/privacy owner phê duyệt và version hóa trước production ingest; thời hạn dưới đây là default đề xuất, không phải kết luận pháp lý.
- Chat body, AI draft, internal note và rendered recipient body: purge/anonymize sau 12 tháng.
- Raw inbound diagnostic metadata: purge sau khoảng 30 ngày.
- Attachment: default 90 ngày, trừ policy/legal hold được audit.
- Có `zalo_legal_holds`/classification và precedence rõ; retention hỗ trợ dry-run, batch resume, hold exclusion và audit counts. Legal hold thắng purge; deletion/export request có workflow riêng; backup/PITR erasure được tài liệu hóa.
- `media_url` hiện trỏ CDN Zalo (URL ngoài, hết hạn ngoài kiểm soát): từ cutover trở đi cache chọn lọc vào Storage; media cũ chấp nhận mất khi CDN hết hạn. **Private bucket/signed URL không tự tạo tenant isolation**: browser không được tự ký chỉ vì role `authenticated`; RPC/Edge phải authorize conversation/org/building ngay lúc ký, kể cả khi caller biết chính xác object path. Path resource-scoped `(org/account/conversation/message/random-id)`, không list cross-org; negative test org B biết path org A vẫn không read/sign được.
- Downloader là SSRF boundary: HTTPS + verified hostname allowlist, chặn private/loopback/link-local/metadata IP sau DNS và mọi redirect, timeout/stream size cap, MIME sniff, cấm active SVG/HTML, checksum/quarantine, không tự tải file lớn và không log signed/source URL. Retention 90 ngày chỉ áp dụng cho media tự lưu.
- Scope `demo-reset`: org DEMO (`dddd…0001`) hiện chưa có dữ liệu zalo; nếu demo dùng `FakeChannelAdapter` thì toàn bộ `zalo_*`/care/AI/campaign phải nằm trong demo_reset scope.
- Giữ content-free delivery/audit aggregates cần cho vận hành; audit bảo mật tối thiểu 24 tháng nếu chính sách tổ chức cho phép.
- Purge phải tombstone content, không phá FK/delivery aggregate.
- Tài liệu hóa backup/PITR window: dữ liệu đã purge có thể còn trong encrypted backup chỉ tới hết retention của backup.
- Session Zalo và encryption key không nằm trong app/VPS backup.
- Chạy retention hàng ngày qua Supabase Cron; alert nếu backlog/failure.

Cutover additive:

1. Feature flag mới mặc định off.
2. Backfill tối đa 12 tháng message; cũ hơn chỉ content-free metadata nếu cần.
3. Stop old worker trong maintenance window, ingest final delta.
4. Start new connector bằng fake/staging trước rồi personal pilot.
5. Switch frontend sang RPC v2.
6. Xác nhận service-role credential của old worker đã bị revoke từ Phase 1; tại đây chỉ revoke nốt direct authenticated table writes/legacy UI path sau compatibility gate.
7. Giữ legacy RPC/table path read-only trong observation window; không tự quay lại broad-service-role worker khi rollback.
8. Sau observation, revoke old `zalo_send_message`, `zalo_broadcast`, `zalo_toggle_automation` hoặc bọc chúng về RPC v2; bảng `zalo_automations` deprecate sau khi config đã migrate sang `automation_mode` + AI policy org-level.

Sau mọi schema migration: regenerate `src/integrations/supabase/types.ts` và thêm lại comment header. Nếu migration đụng VIEW, bắt buộc chạy `node scripts/check-view-invoker.mjs`; ưu tiên RPC để không cần view.

---

## 4. Luồng nghiệp vụ chi tiết

### 4.1 Inbound message

1. Adapter nhận event và normalize thành canonical event.
2. Tạo stable `event_key` từ provider IDs; fallback là hash canonical account/type/peer/time/payload theo schema version và canonical serialization cố định.
3. Gọi `zalo-bridge-api` với account-bound credential, request ID/nonce, timestamp, connector generation và body hash chống replay; bearer secret dài hạn đơn thuần là chưa đủ.
4. Edge Function hash credential, derive account/org từ binding; payload không được đổi account/org.
5. `zalo_bridge_ingest_event` transaction thực hiện dedupe, identity/conversation/message, unread/preview, routing, alert/work/audit.
6. `HISTORY_SYNC`, group, unsupported media, recalled/stale event không trigger AI.
7. Orchestrator claim work, chạy deterministic gates trước model.
8. Model trả structured intent/confidence/risk/tool proposal; policy server quyết định.
9. Kết quả duy nhất: `AUTO_REPLY`, `DRAFT_REVIEW`, `HANDOFF`, `NO_ACTION`.
10. Outbound message được enqueue với idempotency/control version và bridge gửi.

### 4.2 Manual identity approval

1. Peer mới là unverified; UI có thể đề xuất candidate bằng phone/name nhưng không hiển thị private data. Coverage thực tế rất thấp (61/1.832 hội thoại có `peer_phone`, ~3% — đã xác minh live 15/07) nên search khách hàng thủ công là đường chính, phone suggestion chỉ phụ trợ.
2. Staff có `verify_identity` và đúng scope chọn customer, kiểm tra bằng kênh ngoài/biết rõ nghiệp vụ, ghi evidence category/reference.
3. RPC khóa identity, customer và conversation, validate cùng org/direct chat, tạo `VERIFIED` event và resolve canonical contract/building/room.
4. Nếu nhiều active context, giữ unresolved và yêu cầu staff chọn.
5. Revocation có hiệu lực tức thì cho UI, AI, drafts, queue và campaign.

### 4.3 Human takeover race

- `control_version` tăng mỗi lần takeover/release/policy pause.
- Mọi AI draft/outbound ghi version lúc tạo.
- Takeover transaction cancel toàn bộ unclaimed AI reply cùng conversation.
- Outbound claim recheck current version; mismatch → `cancelled/suppressed`.
- Tin đã giao cho Zalo có thể không thu hồi được; UI/runbook phải nói rõ residual risk.

### 4.4 AI service-request intake

- AI chỉ hỏi thông tin cần thiết: loại sự cố, mô tả, vị trí, mức khẩn; không tự khẳng định trách nhiệm/chi phí.
- Khi đủ dữ liệu, `zalo_create_job_as_ai` tạo `jobs` + `zalo_job_links` exactly-once.
- Không tạo material usage, chi phí, hóa đơn hay financial effects.
- AI gửi xác nhận generic chứa mã job và handoff nếu urgent/safety.

### 4.5 Proactive transactional campaign

1. `AFTER` transition event hoặc Cron scanner tạo unique occurrence; không gửi trực tiếp.
2. Expand candidate từ canonical org/customer/contract/building/room.
3. Chỉ verified direct identity, có basis transactional, không suppression/opt-out.
4. Render exact template version + source fact snapshot.
5. Staff review số lượng, excluded reasons, sample, quiet hours/caps rồi approve batch.
6. Recipient rows immutable sau approval; recheck ngay trước claim.
7. Campaign dùng queue chung nhưng priority thấp hơn support replies.
8. Account/session lỗi pause batch; sau re-login staff xem stale recipients và explicit resume.

---

## 5. AI policy an toàn

### 5.1 Auto-send allowlist MVP

Được tự gửi khi đủ tất cả gate:

- Greeting/acknowledgement.
- FAQ công khai có grounding từ KB published.
- Câu hỏi làm rõ để tiếp nhận sự cố.
- Xác nhận đã tạo service request.
- Trạng thái vận hành không nhạy cảm lấy từ tool deterministic.

Điều kiện: intent allowlisted, confidence ≥ threshold (khởi tạo 0,90), không risk flag, account/conversation eligible, không takeover, dưới 2 autonomous turns liên tiếp, prompt/policy/KB/model đều published/current.

### 5.2 Luôn draft hoặc handoff

- Công nợ, hóa đơn, thanh toán, cọc, hợp đồng và mọi số tiền riêng tư.
- Cam kết hoàn/giảm phí, hứa thanh toán, sửa dữ liệu.
- Tranh chấp pháp lý, đuổi nhà, đe dọa/quấy rối/an toàn cá nhân.
- Identity không rõ, group chat, prompt injection, unsupported attachment.
- Complaint cần phán đoán quản lý, confidence thấp hoặc thiếu nguồn.

Ngay cả identity đã verified, finance/contract reply vẫn staff-review trong MVP.

### 5.3 Structured output và tools

JSON schema tối thiểu:

- `intent`, `confidence`, `risk_flags`, `sensitivity`.
- `requires_verified_identity`, `recommended_action`.
- `facts_needed`, `tool_requests`, `reason_codes`.
- `proposed_response`, `handoff_reason`, `service_request_fields`.

Malformed output được retry có kiểm soát một lần; vẫn lỗi thì handoff. Model chỉ đề xuất, deterministic policy mới cho phép tool và send.

Tool read:

- Public/organization FAQ.
- Customer/room/building support summary.
- Contract display summary.
- Invoice/debt display summary.
- Open jobs/service requests.

Tool write duy nhất:

- Create job.
- Add internal note.
- Request handoff.

### 5.4 PII/prompt-injection

- Chỉ gửi tối đa khoảng 10 message gần nhất có liên quan.
- Mask phone, CCCD, bank/account, email và unrelated identities server-side trước provider.
- Không gửi attachment, full contract, full payment history, cookie, secret hay internal staff note.
- Tool result field allowlist theo intent; monetary facts lấy bằng RPC không cap 1.000 rows.
- System policy, user text, KB chunks và tool result là typed sections riêng.
- Customer/KB text được đánh dấu untrusted data, không được tạo tool/policy instruction.
- Persist hash/redaction summary; không nhân đôi unredacted prompt ngoài chat content retention.

### 5.5 Evaluation gates trước auto-send

Dataset tiếng Việt phải có FAQ, sự cố, ambiguous room, verified/unverified invoice, group privacy, injection, financial write, legal/safety, opt-out và hallucination traps.

Gate:

- 100% block financial writes.
- 100% block private disclosure khi unverified/group/cross-org.
- ≥95% handoff recall cho sensitive cases.
- ≥90% grounded precision cho auto-send candidates.
- 0 unknown model/zero-price call.
- Mọi prompt/policy/model/KB version có approval + evaluation record.

---

## 6. Frontend `/chat-zalo`

Giữ route hiện tại và tiến hóa UI thay vì thay mới:

### Inbox/list

- Server-side cursor pagination, search và filter theo org/account, assignment, building/room, unread, SLA, identity, AI/human state.
- Không tải 5.000 conversation hoặc 1.000 message mỗi refetch.
- Realtime chỉ invalidate/append confirmed rows; authorization và durable job vẫn ở server.

### Thread

- Message cursor pagination.
- Delivery/retry/unknown/cancel state rõ ràng.
- AI draft card có approve/edit/reject/handoff.
- Human takeover control.
- Composer giữ draft theo conversation, sinh UUID idempotency ổn định và chỉ clear sau RPC success; send fail không mất nội dung.
- Media thumbnail-first lazy-load: chỉ tải ảnh khi vào viewport/bấm mở; media đã cache storage dùng signed URL batch (`signedUrlBatcher` sẵn có), media chưa cache dùng URL CDN còn sống + placeholder khi hết hạn (xem 7.6).

### Customer 360

- Identity verification/revocation banner.
- Customer, contract, building, room, invoice/debt summary chỉ hiện khi verified và authorized.
- Open jobs, create service request, internal notes, handoff, assignment/SLA history.
- Refactor `TenantInfo` thành canonical `Customer360Panel`; không củng cố legacy tenant model.

### Account/operations

- Health banner khi login required/error/limited/paused.
- QR reconnect có expiry; explicit resume sau reconnect.
- Queue/dead-letter/retention metrics cho người có quyền.
- Thay số hard-code `automationRuns={34}` bằng metric thật.

### Knowledge/campaign

- `/chat-zalo/knowledge`: draft/review/publish/version history.
- `/chat-zalo/campaigns`: transactional wizard, recipient preview/exclusion, approval/audit.
- `/chat-zalo/operations`: account health, queue, dead letter, runbooks.
- `/chat-zalo/settings`: routing, AI policy, quiet hours, caps.

Fix kèm theo:

- Template hook select `body` và picker chèn body, không chèn title.
- Label identity phải scope theo `(account_id,label_id)`, không dedupe toàn cục bằng numeric `label_id`.
- Push/handoff alert tới assigned/responsible staff, không chỉ account owner; payload lock-screen mặc định content-free, server derive recipient từ `conversation_id` và reauthorize ngay lúc gửi.
- `ConnectZaloDialog` chuyển sang đọc QR qua login-challenge RPC (short-poll với TTL), KHÔNG nhận QR qua Realtime `zalo_accounts` như hiện tại; `useZaloRealtime`/poll accounts chỉ còn health metadata.

---

## 7. VPS và connector operations

### 7.1 Isolation trên cùng Vultr

- Một container `zalo-bridge-<account>`/account, một container 9Router riêng.
- Non-root, read-only root filesystem, drop capabilities, PID/CPU/RAM cap, no Docker socket.
- Session volume riêng per account; UID/permissions riêng; connector không mount 9Router data và ngược lại.
- Network policy: connector chỉ cần Zalo endpoints, DNS/NTP và `zalo-bridge-api`; không có 9Router API key.
- 9Router tiếp tục sau Caddy TLS + API key; key chỉ nằm trong Supabase Edge secrets, không nằm trong connector.

Khởi tạo resource cap khoảng 0,5 CPU/512 MB mỗi connector và tune theo metrics; không để Zalo burst làm nghẽn 9Router.

Baseline hardening VPS (bổ sung theo rà soát 15/07):

- SSH key-only + disable password auth, fail2ban, `unattended-upgrades` bật sẵn.
- Docker image pin theo digest; healthcheck container + restart backoff (không restart-loop nhanh — mỗi restart kéo theo re-login/sync, vừa tốn băng thông vừa là tín hiệu bất thường với Zalo).
- Log rotation content-free (logrotate/docker log-opts max-size), NTP sync (lệch giờ phá lease/timing).
- RAM headroom: `getAllFriends(20000)` hiện tải một mảng lớn vào bộ nhớ — adapter mới phải paginate contact sync theo trang, và Node `--max-old-space-size` đặt khớp cap container để OOM fail rõ ràng thay vì treo.

### 7.2 Session protection

- Mã hóa session file bằng AES-256-GCM hoặc encrypted volume; key từ root-only runtime secret, không commit, không log. Chốt key source/rotation, nonce+tag file format, atomic temp-write+rename, startup fail-closed khi decrypt lỗi và revoke/delete runbook; không bao giờ fallback ghi plaintext.
- Session dir permission tương đương `0700`, một account/volume.
- Loại session/cookie khỏi logs, crash dumps, snapshots và backup thường.
- Disaster restore yêu cầu QR/manual re-login; không restore cookie backup.
- Chỉ một active lease/listener/account.
- Session volume persist qua deploy/recreate container (named volume) — mất session file đồng nghĩa QR re-login = sự kiện "thiết bị mới" lặp với Zalo (xem hygiene 7.3); deploy code KHÔNG được đụng volume session.
- Encryption at rest không bảo vệ được khi root/VPS đang bị compromise; đây là residual risk phải alert/rotate/re-login, không coi mã hóa volume là ranh giới tuyệt đối.

### 7.3 Health, retry và failure behavior

- Lease TTL 60s, heartbeat 20s; generation chống stale worker.
- Mất 2–3 heartbeat → `DEGRADED/PAUSED`, dừng AI automation và outbound claim.
- Session invalid/limited/QR required: không blind auto-login loop; alert admin + assigned staff, native Zalo fallback, manual QR.
- Sau login: bounded recent history sync gắn `HISTORY_SYNC`, dedupe và không trigger AI; staff review stale queue rồi explicit resume.

Retry transport chắc chắn chưa gửi:

- 15s → 1m → 5m → 15m → 1h, jitter ±20%, tối đa 5 lần.
- Respect `Retry-After`.
- Auth/session/limit/suppression là non-retryable.
- Kết quả “có thể đã gửi nhưng chưa ack” chuyển `unknown/dead review`; không auto retry để tránh duplicate customer-visible message.

Default conservative limits:

- 1 message/3 giây, burst 2.
- 30/account/giờ, 200/account/ngày.
- 10 auto-replies/peer/giờ.
- 100 recipients/approved batch.
- Proactive quiet hours 20:00–08:00 theo timezone tổ chức.

Các số này là **guardrail nội bộ khởi tạo**, không phải quota Zalo được bảo đảm; phải tune giảm từ pilot và revalidate platform policy trước mỗi rollout.

**Caps phải enforce ở DB claim (`available_at` + rate window trong `zalo_bridge_claim_outbound`), không phải sleep phía worker.** Worker hiện tại chỉ rải nhịp 0,7–1,5s giữa job → khi queue đầy đạt ~35–40 tin/phút, vượt xa ngưỡng an toàn tài khoản cá nhân; worker cũ/compromised bỏ sleep là mất lưới.

Anti-spam hygiene (chống Zalo đánh dấu spam — bổ sung theo rà soát worker 15/07):

- **Thiết bị/phiên ổn định**: giữ UA + imei cố định per account (pattern `uaFor` hiện có), session volume persist qua deploy — KHÔNG xoá session file khi recreate container, vì mỗi lần quét QR lại = sự kiện "thiết bị mới" lặp. Hạn chế tối đa số lần QR re-login.
- **IP ổn định lâu dài quan trọng hơn geo**: VPS hiện ở Seoul trong khi user dùng app tại VN — chấp nhận được nếu IP tĩnh và KHÔNG đổi region/IP sau khi phiên đã ổn định; nếu Zalo challenge lặp lại, cân nhắc chuyển connector về VPS VN (tách khỏi 9Router, adapter seam cho phép di dời độc lập).
- **Warm-up account**: sau connect/reconnect mới, caps giảm còn ~1/3 trong 48–72h đầu rồi nâng dần; account vừa bị LIMITED thì reset warm-up.
- **Auto-reply có floor delay** ngẫu nhiên 3–8s (trả lời <1s đều đặn 24/7 là tín hiệu bot); support reply được phép 24/7, chỉ proactive chịu quiet hours.
- **Chỉ gửi proactive cho peer đã có thread hiện hữu** (khách đã từng nhắn); TUYỆT ĐỐI không bulk lookup theo số điện thoại (`findUser`) để tạo peer mới — bulk phone lookup là vector khoá nick, và cũng bị cấm ở tầng nghiệp vụ (identity chỉ từ conversation).
- **Per-peer proactive cap**: mặc định ≤1 proactive/ngày và ≤4/tháng mỗi peer (chuỗi nhắc nợ theo hoá đơn có cap riêng đã approve), đếm bằng counter DB.
- **Biến thể nội dung**: campaign render template + variables per-recipient (tên, phòng, số liệu) — không gửi body y hệt hàng loạt như `zalo_broadcast` cũ; hạn chế URL trong tin bulk (link rút gọn hàng loạt là tín hiệu spam), ưu tiên text thuần.
- **Circuit breaker theo error class**: phân loại lỗi send (bị chặn/không phải bạn/spam-limited vs lỗi mạng) — worker hiện chỉ mark `failed` không phân loại. Peer chặn → auto-suppress peer; gặp mã limit thì pause ngay. Ngưỡng error-rate khởi tạo `>5%` chỉ có hiệu lực khi đã chốt denominator, rolling window, minimum sample, included error classes, cooldown và resume approver; không dùng tỷ lệ mơ hồ để auto-pause/resume.
- **Dừng ngay theo tín hiệu người dùng**: opt-out rõ ràng trong nội dung tin (STOP, "đừng nhắn") → upsert suppression proactive effective ngay; staff chỉ xác nhận trường hợp mơ hồ hoặc release sau đó có reason/audit. Claim luôn đọc suppression hiện thời, kể cả sau approval/enqueue.

### 7.4 Logs, metrics và alerts

Log content-free: surrogate org/account IDs, message/work/correlation IDs, lease generation, attempt, latency, error code. Không log body, prompt, session, token hay CRM row đầy đủ.

Alert ngay khi:

- login required/limited/heartbeat >60s;
- outbound bị pause ngoài dự kiến;
- oldest inbound work >2 phút;
- dead letters tăng;
- worker path bị cross-org denial;
- AI quota/model/pricing bị reject;
- retention backlog/failure.

Runbooks bắt buộc: session loss, limitation, ambiguous send, queue lease starvation, Supabase/9Router outage, session theft, cross-tenant incident, VPS loss, wrong campaign audience, retention failure. Mỗi runbook mở đầu bằng pause automation/outbound và native-Zalo fallback.

### 7.5 Cron/webhook cần tạo

Live hiện chỉ có **1 cron job** (`recurring_vouchers_daily`) và database webhook (pg_net) chưa từng dùng trong repo — toàn bộ danh sách dưới là hạ tầng mới:

| Job | Cơ chế | Tần suất đề xuất |
|---|---|---|
| Care work recovery sweep | Supabase Cron → `zalo-care-orchestrator` | mỗi 1 phút |
| `zalo_reap_expired_leases` | Cron SQL | mỗi 1 phút |
| Retention (`zalo_run_retention`) | Cron SQL | hằng ngày (đêm) |
| Login-challenge cleanup (challenge used/expired) | Cron SQL | mỗi 5 phút |
| Auto-close care case `RESOLVED` quá 7 ngày | Cron SQL | hằng ngày |
| `zalo_generate_due_events` | Cron SQL | hằng ngày theo timezone tổ chức |
| Kích hoạt nhanh work mới | Database webhook (pg_net) → orchestrator | theo INSERT `zalo_care_work_queue` |

Webhook chỉ là tối ưu độ trễ; recovery sweep là đường bảo đảm (durable queue không phụ thuộc webhook). Cả hai idempotent nhờ claim lease.

### 7.6 Băng thông & chi phí request (đo từ worker hiện tại, 15/07)

Hiện trạng đo được từ `worker/index.js`:

- `tick()` mỗi 2s luôn chạy 2 SELECT (accounts + queue) kể cả khi im lặng → ~86.400 request PostgREST/ngày ≈ **2,6 triệu request/tháng cho một worker rảnh**. Nếu bê nguyên nhịp này sang bridge, mỗi poll = 1 Edge invocation → ~1,3 triệu invocation/tháng, vượt xa quota (Free 500K, Pro 2M).
- Mỗi tin đến = 4–5 round-trip (SELECT conv → INSERT conv → UPSERT msg → UPDATE conv → gọi `send-push`).
- `notifyPush` bắn từng tin — burst 10 tin của một khách = 10 invocation + 10 push.
- `syncContacts` chạy `getAllFriends(20000)` + `getGroupInfo` mỗi lần connect/re-login → restart nhiều = full-sync lặp (băng thông Zalo + RAM spike trong cap 512MB).
- `syncLabels` wipe-regrant (`label_ids=[]` toàn bộ rồi gắn lại) và `old_messages` upsert với `ignoreDuplicates:false` (UPDATE đè) → mỗi reconnect tạo bão UPDATE → bão Realtime cho FE.

Thiết kế đích phải đạt:

- **Gộp call**: `zalo_bridge_claim_outbound` nhận batch (limit N) và kiêm luôn heartbeat/health report trong cùng invocation — không tách 2 call.
- **Adaptive poll + jitter**: 2–3s khi vừa có việc/inbound, giãn dần 15–30s khi idle (±20% jitter). Mục tiêu ≤300–400K invocation/tháng/account. Webhook kích hoạt orchestrator không tự đánh thức process VPS; nếu yêu cầu outbound pickup ≤2s phải bổ sung authenticated outbound wake-up/long-poll/SSE/WebSocket + recovery poll. Nếu chưa có wake-up, SLO `queued_at → claimed_at` phải phản ánh idle floor 15–30s. Heartbeat/lease renewal tách khỏi work polling để backoff không làm mất lease.
- **Batch ingest**: `zalo_bridge_ingest_events` (mảng, thứ tự bảo toàn, kết quả per-event) cho `old_messages`/history sync — không gọi per-event khi bulk. Dedupe phía RPC phải là INSERT-nếu-chưa-có (không UPDATE đè row cũ) để không phát Realtime churn.
- **Push debounce**: STAFF_ALERT gộp theo conversation trong cửa sổ 30–60s (giữ tag `zalo-<conversation_id>` để SW collapse); không push từng tin trong cùng phiên chat.
- **Sync tối thiểu hóa dữ liệu**: reconnect chỉ sync khoảng trống từ `last_event_at`; label sync phải diff. Mặc định chỉ materialize peer/group đã xuất hiện trong business thread, không daily full-sync toàn bộ friend/group directory. Nếu full directory thật sự cần, phải có purpose/legal basis, allowlisted metadata, retention và staff-triggered/rate-limited flow; pagination chỉ giải quyết RAM, không giải quyết data minimization.
- **Media (tải lên/tải xuống Zalo)**:
  - Inbound: KHÔNG tự tải media theo tin (giữ hành vi hiện tại chỉ lưu URL); job nền rate-limited cache chọn lọc vào bucket private — ảnh ≤5MB nén WebP (max 1600px), thumbnail-first; video/file lớn giữ URL CDN + metadata, không tải mặc định.
  - Outbound: nén ảnh trước khi gửi (≤2MB, max 1600px); campaign ưu tiên text thuần; đường đi media outbound là storage → VPS → Zalo (2 chiều băng thông VPS) — Vultr $5 có ~1TB/tháng, đủ nhưng phải meter.
- **Metric**: đếm invocation/request/bandwidth per account per ngày trong health report; alert khi vượt ngân sách (chặn hồi quy kiểu poll-2s).

---

## 8. Phased rollout, estimates và exit gates

Ước lượng tổng: **24–33 engineer-weeks**, tương đương khoảng **12–16 tuần lịch** với 2 kỹ sư chính + hỗ trợ security/infra. Pilot MVP tới safe auto-reply: khoảng 17–23 engineer-weeks; campaign và production hardening cộng 7–10 engineer-weeks. Hai tuần pilot observation là thời gian lịch, không chỉ coding.

### Phase 0 — Decision gates + preflight security/tenancy (2–3 engineer-weeks)

- Chốt D1–D6: platform eligibility/capability, Personal–OA–ZNS matrix, thread-vs-case, wake/SLO, data protection/retention và transitional authz.
- Audit live catalog, Zalo organization attribution, ownership FK cascade, Storage policies, RLS/grants/RPC.
- Resolve/quarantine wrong/null/multiple account rows.
- Chốt permission/resource matrix và SQL/RLS test harness.
- Harden exact AI model/pricing/body limits.
- Khóa server-side legacy `zalo_broadcast` trước khi mở bất kỳ automation/campaign; ẩn UI không đủ.

Exit: D1–D6 có owner/evidence/outcome; mismatch/anomaly P0 = 0; xóa creator không xóa dữ liệu org; user biết exact media object path cross-org vẫn không read/sign được; không fixture nào cross-org/building đọc/ghi được; unknown model/zero price reject; security review chấp nhận narrow bridge.

### Phase 1 — Durable transport + connector isolation (4–6 engineer-weeks)

- Migration transport tables/fields/RPC.
- Refactor worker thành adapters và bridge client.
- Account-bound credentials, lease, heartbeat, retry/dead/unknown.
- Per-account containers/session protection/health alerts.
- Cắt service-role credential khỏi VPS ngay trong Phase 1 sau bridge compatibility; không chờ Migration F. Frontend/direct-authenticated-write cutover là gate riêng ở Phase 2.

Exit: duplicate inbound chỉ có một normalized side effect; attempt có thể đã qua provider boundary không automatic retry mà vào `UNKNOWN`; queue bảo toàn per-conversation order và support preempt campaign; session loss pause ≤60s; VPS không còn service-role key; replay/stale generation bị reject; fake adapter contract tests xanh.

### Phase 2 — Inbox, identity, routing, jobs (3–4 engineer-weeks)

- Identity approval/revocation, customer 360, assignment, SLA, handoff/note/job.
- RPC pagination và frontend update.
- Fix composer/template/stat/label issues.

Exit: staff xử lý full happy path; unverified/group locked; cross-building denied; revocation tức thì; create job exactly-once; failed send giữ draft; case reopen/mở mới không ghi đè lịch sử case cũ (một active case/thread).

### Phase 3 — Knowledge + AI draft-only (4–5 engineer-weeks)

- Versioned KB, FTS retrieval.
- Care orchestrator, structured AI, scoped tools, PII masking.
- AI policy/version/cost/audit và evaluation suite.
- Mặc định mọi AI response là draft/handoff, auto-send off.

Exit: evaluation safety gates xanh; staff review/approve/reject; mọi run có policy/prompt/KB/model/token/cost; takeover cancel reply race.

### Phase 4 — Safe auto-reply controlled pilot (2–3 engineer-weeks + 2 tuần observation)

Scope: 1 organization, 1 personal account, một số building, chỉ FAQ + service intake allowlist; private finance/contract vẫn draft-only.

Exit không chỉ dựa vào thời gian. Trước pilot phải chốt `N_min` cho eligible candidates/actual auto-sends, denominator và confidence interval; 100% auto-send được post-review trong pilot; có ngưỡng routing accuracy, unsupported answer, `unknown`/dead-letter và latency. Reconnect/native fallback/ambiguous-send drills phải có evidence artifact và named approvers security/operations/data protection. Hai tuần ít traffic không tự động PASS.

Automatic NO-GO nếu có cross-org/unverified/group disclosure, sensitive auto-send, financial/contract write, opt-out violation, duplicate do automatic retry hoặc account `LIMITED` có attribution tới automation.

### Phase 5 — Transactional campaigns (3–4 engineer-weeks)

Gate vào phase: D1 platform eligibility GO rõ cho kênh được chọn; data-protection sign-off đã có (không đợi Phase 6); ưu tiên OA/ZNS chính thức nếu capability phù hợp. Organization phải có timezone IANA canonical; quiet hours/scanner tính theo timezone này và thay đổi timezone sau approval có behavior được test.

- Durable event/Cron, approved templates, recipient snapshot, opt-out, quiet hours/caps/dedupe.
- Thay broadcast tự do bằng campaign wizard.
- Bắt đầu một event type volume thấp.

Exit: không dispatch thiếu approval; marketing/custom audience không thể biểu diễn; duplicate scheduler không duplicate sends; opt-out sau approval chặn send; source change yêu cầu reapproval.

### Phase 6 — Production hardening/multi-org (4–5 engineer-weeks)

- Tune từ pilot, rollout từng organization.
- Restore/VPS-loss/retention/security drills.
- SLO dashboards, OA adapter contract test và migration runbook.

Exit: alerts active; retention không backlog; kill switches/rollback test; mỗi org vượt onboarding checklist; security/data-protection sign-off.

---

## 9. Verification matrix

### SQL/migration/RLS

Tạo test harness dưới `supabase/tests/` hoặc equivalent reviewed local DB flow. Fixtures bắt buộc có 2 org × 2 building, staff một building, org admin, intake staff, verified/unverified, direct/group.

Test:

- Org/account/parent composite integrity và one personal account/org.
- Direct-only identity verification, unique active link, revoke cascade.
- Conversation context room/building/contract/customer consistency.
- Every RPC: same scope, other building, other org, revoked member, forged IDs.
- Queue claim exclusivity, lease expiry/reaper, idempotency, campaign immutability, SLA transitions, audit append-only, retention tombstone.
- Bridge credential/account không claim/ack account khác; replay nonce, stale lease generation và body hash sai bị reject.
- Offboard/xóa creator legacy không làm giảm row count account/conversation/message/template/audit của organization.
- Membership chưa tới `valid_from`, đã qua `valid_to`, organization `SUSPENDED/CLOSED` đều deny.
- Storage: user org B biết exact object path org A vẫn không list/read/sign được; downloader test SSRF/redirect/private IP/oversize/MIME mismatch.
- QR challenge không nằm trong account Realtime; staff chỉ `chat_zalo.view` không đọc được QR.
- Realtime chịu RLS: sau khi thêm RESTRICTIVE policy, 2 channel hiện có (`zalo-convs` gồm conversations/accounts/labels và `zalo-msg-<id>`) vẫn nhận event cho user hợp lệ và **không** nhận event cross-org; giữ nguyên debounce 400ms (fix egress 26/06, không được phá).

### Worker/adapter

Fake adapter trong CI, tuyệt đối không gọi real Zalo:

- connect/disconnect/health;
- duplicate/out-of-order/history/recall/reaction events;
- lease loss, heartbeat timeout, credential rotate;
- sent/retryable/non-retryable/ambiguous outcomes; attempt đã bắt đầu provider call rồi mất ACK vào `UNKNOWN`, không auto retry;
- pause/resume, rate limit, caps, history sync không AI;
- per-conversation FIFO; campaign flood không chặn manual/support reply; fairness không starvation;
- adaptive poll backoff + batch claim: worker idle không vượt ngân sách invocation (7.6); caps enforce ở claim RPC — worker bỏ sleep vẫn không gửi vượt rate; đo riêng `queue commit → claim` active/idle và kiểm outbound wake-up nếu SLO ≤2s;
- warm-up caps sau connect mới; circuit breaker khi error class bị-chặn/limited vượt ngưỡng.

### AI

- JSON-schema, malformed response fallback.
- Exact allowlist/pricing/quota reserve-settle.
- PII corpus và prompt injection.
- KB org/version scoping.
- Private identity/group/takeover gates.
- Tool authorization/idempotency và financial write refusal.
- Timeout/9Router outage → draft/handoff, không blind retry/send.

### Frontend Vitest/fast-check

- Cursor pagination/cache invalidation.
- Composer draft/idempotency persistence.
- Identity link state machine/private lock.
- Assignment/takeover race.
- AI draft approve/reject/edit.
- Template body insertion và account-scoped labels.
- Campaign approval/opt-out/account outage/dead letter permission.
- Property tests cho dedupe keys, state transitions, retry schedule và recipient suppression.

### Playwright end-to-end

Trên staging/fake adapter trước, sau đó controlled production pilot:

1. Receive inbound → route đúng staff.
2. Approve identity → customer 360 mở; revoke → đóng ngay.
3. Create job from message.
3b. Resolve case → inbound trong 72h reopen đúng case; close hẳn → inbound mở case mới, lịch sử case cũ nguyên vẹn.
4. Public FAQ auto reply.
5. Sensitive reply draft → staff edit/approve.
6. Takeover khi AI đang chạy → không có AI send.
7. Create/approve transactional campaign.
8. Opt-out giữa approve và claim → suppressed.
9. Simulate connector limited → account/AI/queue pause + alerts.
10. Re-login → history reconcile → explicit resume.
11. Console không có error và Realtime không gây refetch storm.

### Chaos/replay boundaries

Kill/retry tại: sau event trước ack, sau DB insert trước work, giữa AI call, sau outbound claim trước send, sau external send trước ack, sau campaign approval trước expand và giữa retention batch. Xác nhận không duplicate normalized side effects; ambiguous send không auto retry; lease hồi phục; account pause/takeover luôn authoritative.

### Repository-mandated checks

- `npx vitest run <related paths>`
- `npm run typecheck:baseline`
- `npx tsc --noEmit -p tsconfig.app.json` để biết full state, so với baseline.
- `npm run gen:types > src/integrations/supabase/types.ts`, restore comment header.
- `node scripts/check-view-invoker.mjs` sau mọi VIEW migration.
- Vì feature tra cứu/nhắc số tiền, chạy `node scripts/reconcile-money.mjs [YYYY-MM]` cho các kỳ test liên quan để bắt cap-1000/regression.
- Playwright happy + edge path; kiểm tra browser console.
- Không tuyên bố xong nếu chưa thấy flow hoạt động trong browser.

---

## 10. Rollback và kill switches

Rollback ưu tiên operational, không destructive down migration:

- Global care AI kill switch.
- Per-org automation pause.
- Per-account outbound pause.
- Per-conversation human takeover.
- Per-campaign pause/cancel.
- Feature flag đưa UI về staff-only inbox.
- Native Zalo manual fallback.

Nếu connector mới lỗi, không tự khôi phục worker cũ có broad service-role key. Pause hệ thống và dùng native Zalo trong lúc sửa. Schema/migration additive được sửa bằng forward migration đã review. Old Zalo path chỉ read-only trong observation window rồi revoke.

---

## 11. KPI và SLO MVP

KPI:

- Eligible containment rate: mục tiêu đầu 20–35%, không tính sensitive/disallowed.
- Handoff rate theo reason.
- First-response median/p90.
- Resolution median/p90, loại thời gian waiting customer theo policy.
- AI draft acceptance/edit distance.
- Delivery success, unknown outcome, duplicate-send rate.
- Suppression/opt-out violation: mục tiêu 0.
- Privacy/cross-tenant/unverified/group disclosure: mục tiêu 0.
- Unsupported/hallucinated auto-send: mục tiêu 0 trong pilot.
- AI cost per assisted conversation.
- Connector healthy time, queue oldest age, dead-letter rate.
- Invocation/request + bandwidth per account/ngày so với ngân sách 7.6 (chặn hồi quy kiểu poll-2s).
- Service intake → valid unique job conversion.

Initial SLO khi connector connected, không bị Zalo limit:

- 99% inbound persisted ≤5 giây.
- 95% safe AI decision ≤15 giây.
- 99% `staff submit → durable queue commit` ≤2 giây.
- `queued_at → claimed_at` đo riêng active/idle connector: ≤2 giây chỉ khi đã triển khai outbound wake-up; nếu dùng adaptive poll thì target phải theo poll floor đã load-test, không dùng từ “claimable” mơ hồ.
- Connector loss detect/pause ≤60 giây.
- Responsible staff alert ≤2 phút.
- Không có normal inbound work quá 2 phút mà không alert.
- Retention hoàn tất trong 24 giờ sau eligibility.

External Zalo availability/delivery phải báo riêng; personal unofficial bridge không thể cam kết official platform SLO hoặc exactly-once external delivery.

---

## 12. Critical files dự kiến thay đổi

### Existing

- `worker/index.js` — tách adapter/supervisor/lease/bridge; bỏ direct broad Supabase writes.
- `worker/package.json`, `worker/README.md` — test, schema validation, ops/container/runbook.
- `supabase/functions/llm-proxy/index.ts` — internal care mode, exact model/pricing, body/schema limits, org quota/correlation.
- `src/hooks/useZaloChat.ts` — thay direct broad queries bằng care RPC hooks/phân trang; sau đó tách hook theo domain.
- `src/pages/chat-zalo/ChatZaloPage.tsx` — inbox shell, health/identity/AI/takeover/customer 360.
- `src/components/chat-zalo/*` — evolve ConversationList, ChatThread, Composer, InfoPanel, AutomationPanel, BroadcastDialog, TemplatePicker, ConnectZaloDialog (QR qua login-challenge RPC).
- `src/lib/permissions.ts`, `src/lib/permissionPages.ts`, `src/App.tsx` — permission và subroutes.
- `src/copilot/maskPii.ts`/server equivalent — common test corpus cho PII policy.
- `src/hooks/useJobs.ts` và task components — reuse read/UI; AI path vẫn gọi atomic RPC, không browser hook.
- `src/hooks/useNotifications.ts`, `supabase/functions/send-push/index.ts` — care push mặc định content-free (“Có tin Zalo mới”); caller chỉ gửi `conversation_id`, server derive recipient + reauthorize membership/scope, không tin arbitrary `userId`/body; route đúng assigned/responsible staff sau hardening.
- `src/integrations/supabase/types.ts` — regenerate sau schema.

### New representative files

- `worker/src/adapters/ChannelAdapter.*`
- `worker/src/adapters/ZcaPersonalAdapter.*`
- `worker/src/adapters/FakeChannelAdapter.*`
- `worker/src/bridgeClient.*`
- `worker/src/supervisor.*`
- `supabase/functions/zalo-bridge-api/index.ts`
- `supabase/functions/zalo-care-orchestrator/index.ts`
- `supabase/functions/_shared/carePolicy.ts`
- `supabase/functions/_shared/pii.ts`
- Các tranche/migration A0–A3 và B–F dưới `supabase/migrations/` (A0 là artifact read-only ngoài migration transaction).
- Focused hooks: `useZaloInbox`, `useZaloConversation`, `useZaloIdentity`, `useZaloAiDrafts`, `useZaloCampaigns`, `useZaloKnowledge`, `useZaloOperations`.
- Components: `Customer360Panel`, `IdentityVerificationBanner`, `HumanTakeoverControl`, `AiDraftReviewCard`, `AssignmentMenu`, `SlaIndicator`, `AccountHealthBanner`, `TransactionalCampaignWizard`, KB/operations panels.
- SQL/RLS, worker adapter, AI evaluation và frontend tests tương ứng.
- `docs/zalo-ai/ARCHITECTURE.md`, `OPERATIONS.md`, `SECURITY-RUNBOOKS.md`, `PILOT-CHECKLIST.md`.

---

## 13. Explicit non-goals và residual risks

Non-goals MVP:

- Marketing/promotion/lead nurture/arbitrary bulk broadcast.
- Auto identity approval.
- Private data trong group chat.
- AI mutation tài chính/hợp đồng/hóa đơn/payment/deposit.
- AI image/document/voice/video interpretation.
- Rebuild `issues` hoặc migrate jobs.
- Cutover normalized RBAC toàn CRM như một phần ngầm của feature.
- OA implementation ngay MVP.
- High-volume campaign infrastructure.

Residual risks phải chấp nhận/giám sát:

- `zca-js` là unofficial: Zalo có thể đổi protocol, invalidate cookie hoặc khóa/hạn chế account bất cứ lúc nào.
- Dùng native Zalo/Web nơi khác có thể làm rớt worker session và tạo khoảng trống CRM history.
- External send không thể guaranteed exactly-once; ambiguous result phải review thay vì retry.
- Cùng một VPS vẫn là correlated host failure dù container đã tách.
- Root/hypervisor compromise vẫn có thể vượt isolation.
- Nhân viên có thể tiết lộ dữ liệu ngoài CRM controls.
- AI vẫn có thể viết câu kém; vì vậy sensitive luôn draft-only và auto allowlist rất hẹp.
- OA migration có thể cần re-link identity vì personal UID và official UID không chắc tương thích.

Adapter seam, fail-closed identity/tenant policy, durable queues, takeover version và native-Zalo fallback giảm blast radius nhưng không loại bỏ các rủi ro này.

---

## 14. Risk register và traceability gate

Risk register phải được review lại trước mỗi tranche, tối thiểu gồm:

| Risk | Khả năng | Tác động | Mitigation/detection | Acceptance owner |
|---|---|---|---|---|
| Personal account bị challenge/khóa | Cao dài hạn | Cao | D1 eligibility, staff-only default, caps, health alert, native/OA fallback | Product/platform |
| Cross-org/Storage leak | Trung bình | Critical | Resource-derived RPC/RLS, composite invariant, signer authorization, negative tests | Security |
| Duplicate/ambiguous outbound | Trung bình | Cao | Lease/generation, FIFO, `UNKNOWN`, reconcile/manual decision | Engineering/operations |
| Session/QR theft | Trung bình | Critical | Per-account isolation, login challenge, rotation, no logs/backups | Operations/security |
| AI private disclosure | Trung bình | Critical | Verified-direct gate, deterministic policy, eval/post-review, kill switch | AI/security |
| Protocol `zca-js` break | Cao dài hạn | Cao | Versioned adapter fixtures, canary, circuit breaker, OA roadmap | Connector owner |
| Over-collection/retention error | Trung bình | Cao | Conversation-only identity materialization, classification/hold/dry-run purge | Data protection |

Mỗi requirement quan trọng phải có traceability:

`requirement → migration/schema invariant → RPC/Edge/connector module → UI → test → SLI/alert → runbook → owner`.

Không được tuyên bố một tranche hoàn tất nếu requirement P0/P1 không có test hoặc evidence artifact tương ứng. Open question không được ẩn trong implementation detail; phải nằm trong D1–D6 hoặc risk register với owner và deadline.
