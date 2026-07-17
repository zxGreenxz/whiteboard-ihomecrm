# On-target validation — staging Supabase (2026-07-17)

> Evidence đã sanitize. KHÔNG chứa credential/PAT/password/JWT/signed URL/PII.
> Đây là **integration evidence trên môi trường Supabase thật** (staging project
> tạm do owner cấp) + **backward-compat evidence** trên PostgreSQL superuser local.
> Không phải production apply — mọi cutover vẫn gated theo §27 của AUTHORIZATION-PLAN.

## 0. Vì sao vòng này tồn tại

Toàn bộ prepared SQL trước 2026-07-17 chỉ được test trên **disposable harness
local** nơi `postgres` là **superuser**. Owner đã cấp một **Supabase project tạm**
để validate on-target — nơi `postgres` KHÔNG phải superuser, `auth`/`storage` do
`supabase_admin` sở hữu, RLS/trigger/extension đúng như production. Vòng này phát
hiện **4 defect chỉ xảy ra trên Supabase** mà harness superuser che mất — trong đó
một defect (Finding #4) sẽ **phá vỡ toàn bộ chuỗi T3 income-expense giữa lúc apply
lên dữ liệu tài chính production, không có đường rollback sạch**. Đây là bằng chứng
trực tiếp cho kỷ luật "không tự cutover, validate on-target trước".

## 1. Môi trường & danh tính nguồn

| Thành phần | Giá trị |
|---|---|
| Branch / HEAD lúc test | `security/authz-preparation` / `4ee309ac2d55f188bff1d12bb8834627d1fb93da` (các fix của vòng này là working-tree changes TRÊN commit này, pin bằng commit preparation kế tiếp) |
| Staging Supabase (temp) | project ref `qwxgygsewymkahiavslu`, PostgreSQL 17, Supavisor session pooler `aws-0-ap-southeast-1`; `postgres` = **NOT superuser**, **NOT member `supabase_admin`** |
| Local backward-compat | cluster PG 17.10, database `verify3` (blank restore của cùng dump), `postgres` = **superuser** |
| Tooling | `psql`/`pg_dump`/`pg_restore` 17.10 |
| Nguồn restore | recovery `20260717T095450Z-db-portable`, `database/full.custom` 43.014.738 byte, SHA-256 `3dcbc76da4f921ed9bc486389a0644f6b48f54488528b9b114d73672b8805983` |

## 2. Recovery `20260717T095450Z` — round-trip + cross-restore

Bản dump production tươi (chụp 2026-07-17 ~09:54 UTC, `-Z0` + TCP keepalive để
tránh pooler idle-drop từng làm hỏng 2 bản trước — xem §2b). Kiểm chứng bằng **hai
target độc lập restore từ CÙNG một dump**:

| Bảng tiền | Blank local (`verify3`) | Live Supabase (staging) | Khớp? |
|---|---|---|---|
| `income_expenses` SUM(total_amount) | 10.492.190.716,00 | 10.492.190.716,00 | ✅ exact |
| `invoices` SUM(total_amount) | 4.242.342.993,00 | 4.242.342.993,00 | ✅ exact |
| `payments` SUM(amount) | 3.893.111.563,00 | 3.893.111.563,00 | ✅ exact |
| `auth.users` count | 11 | 11 | ✅ |
| `storage.objects` count | 2.418 | 2.380 | ⚠ delta 38 (xem dưới) |

- **Money invariant khớp 100%** trên cả hai restore độc lập — chỉ số tài chính
  trọng yếu được cross-validate, không chỉ một lần.
- **`storage.objects` delta (2.418 vs 2.380):** blank local (2.418) là bản trung
  thực theo dump; restore vào **Supabase project đang sống** rớt 38 row (object trỏ
  tới bucket không được restore / ON CONFLICT với storage do Supabase quản lý). Đây
  là artifact của restore-vào-live-Supabase, KHÔNG phải mất dữ liệu nguồn. Cần giải
  thích/đối chiếu object-level trước khi certify recovery tổng thể.
- **Extension-complete target (gate cũ BLOCKED):** gate 2026-07-16 để `BLOCKED` vì
  local Windows PG thiếu `vector`/`pg_cron`/`supabase_vault`. Staging Supabase có
  `pg_cron 1.6.4`, `supabase_vault 0.3.1`, `pgcrypto 1.3` present → **toàn bộ
  prepared SQL compile + chạy được trên target có đủ extension**. (`vector`/`pg_net`
  chưa xác nhận trên project tạm; không phụ thuộc bởi authz stack.)

**Trạng thái recovery:** round-trip PROVEN trên blank target với money 100% exact
+ cross-validate trên second independent restore. Vẫn CHƯA `VERIFIED` tổng thể:
cần (a) giải thích 38-row storage delta, (b) fault-domain replica thật (hiện cùng
ổ D:), (c) independent reviewer, (d) exhaustive R2/object bytes. KHÔNG dùng làm
production gate cho tới khi các mục này đóng.

## 3. Bốn defect chỉ-Supabase mà harness superuser che mất

Cài prepared SQL (migrations app_private + toàn bộ slice T2/T3/T1b/T5) lên staging
theo đúng thứ tự install. Bốn lỗi integration lộ ra — không lỗi nào reproduce trên
harness superuser:

### Finding #1 — `postgres` không grant được `USAGE ON SCHEMA auth`
`auth` do `supabase_admin` sở hữu; `postgres.<ref>` không phải member → `GRANT USAGE
ON SCHEMA auth TO ie_canonical_writer` chỉ ra `WARNING: no privileges were granted
for "auth"` (im lặng, không lỗi cứng). Hệ quả: bất kỳ code chạy dưới role
`ie_canonical_writer` mà chạm `auth.*` đều fail.

### Finding #2 — PG16+ cần `GRANT ... WITH SET TRUE` để SET ROLE
`t3_02` re-own wrapper sang `ie_canonical_writer` rồi cần `SET ROLE` → PG16+ báo
`must be able to SET ROLE "ie_canonical_writer"`. Fix: `grant ie_canonical_writer
to current_user with set true` (fallback plain grant cho PG15).

### Finding #3 — role thiếu `USAGE ON SCHEMA public`
Writer chạy dưới `ie_canonical_writer` → `permission denied for schema public`.
Fix: `grant usage on schema public`.

### Finding #4 (NGHIÊM TRỌNG NHẤT) — INVOKER trigger `auth.uid()` chết dưới writer role
Trigger SECURITY INVOKER `_guard_ie_financial_columns` trên `public.income_expenses`
gọi `auth.uid()`. Khi wrapper chạy dưới `ie_canonical_writer`, trigger fire dưới
cùng role đó và chết `permission denied for schema auth` — **migration không grant
được `auth` USAGE (Finding #1)**. Nghĩa là thiết kế "re-own wrapper sang bare
NOLOGIN writer role" **không thể hoạt động trên Supabase**; nếu apply lên production
sẽ vỡ chuỗi T3 income-expense giữa chừng, trên dữ liệu tiền thật, không rollback sạch.

### Finding #5 (test harness) — fixture nondeterminism `t5_94` T8
`t5_94` T8 giả định revoke member-override sẽ bỏ `contracts.create`, nhưng actor
fixture có thể được cấp qua ROLE; và dùng `v_room2` không lọc "phòng trống" nên có
thể là phòng đã có hợp đồng ACTIVE → guard occupancy (55000) fire trước, thay vì
`insufficient_privilege` (42501). PASS trên staging do may mắn data-snapshot, FAIL
trên `verify3`. Đã harden: T8 chuyển sang **stranger principal** trên `v_room` —
deterministic bất kể role/room-state, và chứng minh property mạnh hơn: writer
**authorize TRƯỚC khi chạm room-state** (deny = 42501, không rò occupancy 55000).
Precedence override-revocation đã được `t2_90` cover deterministic.

## 4. Redesign A.9 — capability-token (Supabase-viable)

`scripts/authz-prepared/t3_12_capability_token_redesign.sql` (mới). Giải Finding #4
bằng "smallest shape":

- **Wrapper `create_income_expense_v1` giữ owner = `postgres`** (postgres CÓ auth
  access + INVOKER trigger resolve) — undo ownership-transfer của `t3_02`.
- Capability claim không còn là `current_user = 'ie_canonical_writer'` (bất khả thi)
  mà là **nonce transaction-local**: `grant_ie_claim_capability_v1()` (DEFINER,
  postgres-owned, revoke khỏi mọi app role) tính nonce, `set_config(..., local=true)`,
  trả nonce; claim yêu cầu echo đúng nonce.
- `has_ie_claim_capability_v1(nonce)` fail-closed strictly boolean (`coalesce(...,
  false)` — NULL/GUC-unset/mismatch đều false; một `IF NOT NULL` sẽ âm thầm bỏ guard).
- Delegate `app_private.current_uid_v1()` (DEFINER, postgres-owned, có auth) thay
  `auth.uid()` trong claim/writer.
- **Trust boundary y hệt bản cũ:** cũ = "chỉ code chạy dưới `ie_canonical_writer`
  claim được"; mới = "chỉ code gọi được DEFINER setter postgres-owned (reachable duy
  nhất từ wrapper) claim được". Cả hai un-forgeable bởi anon/authenticated/service_role;
  token transaction-scoped nên không rò qua statement sau.

File đổi kèm theo: `t3_01` (thêm `current_uid_v1` delegate + claim helper),
`t3_02` (WITH SET TRUE + USAGE public; phần lớn bị `t3_12` thay), `build-t3-03.mjs`
(delegate + capability nonce tại A.2 point), các test `t3_90/94/99` (claim 3-arg +
forged-nonce), `t5_94` (harden T8).

## 5. Kết quả full suite — 15 suite trên CẢ HAI môi trường

Chạy sau khi cài đủ stack (migrations + T2 + T3 + T3.12 + T1b + T5 + rollout CAS):

| Suite | Assertion | Staging Supabase | Local superuser `verify3` |
|---|---:|---|---|
| `t2_90_resolver_decision` | 14 | ✅ | ✅ |
| `t3_90_containment` | 14 | ✅ | ✅ |
| `t3_91_writer_e2e` | 8 | ✅ | ✅ |
| `t3_93_audit_chain` | 6 | ✅ | ✅ |
| `t3_94_receipt` | 5 | ✅ | ✅ |
| `t3_95_approval_v2` | 11 | ✅ | ✅ |
| `t3_96_candidate` | 7 | ✅ | ✅ |
| `t3_97_emergency` | 6 | ✅ | ✅ |
| `t3_99_transition` | 5 | ✅ | ✅ |
| `t3_9a_submit_e2e` | 7 | ✅ | ✅ |
| `t1b_90_payment` | 7 | ✅ | ✅ |
| `t5_91_invoice_reversal` | 6 | ✅ | ✅ |
| `t5_92_cashbook` | 8 | ✅ | ✅ |
| `t5_93_salary` | 5 | ✅ | ✅ |
| `t5_94_contract_deposit` | 8 | ✅ | ✅ (sau harden T8) |
| **Tổng** | **117** | **15/15** | **15/15** |

Ngoài suite: mọi money writer (`create_income_expense_v1`, `record_invoice_payment_v4`,
invoice/reversal/cashbook/salary/contract-deposit writers) đều **deny đúng cho
`authenticated`** khi gọi trực tiếp (chỉ callable qua flag-gated wrapper); resolver
14/14, rule-governance 7/7, rollout CAS 8/8 đều xanh on-target.

## 6. Gate đóng / còn mở

**Đóng vòng này:**
- Prepared authz stack **chạy đúng trên Supabase thật** (non-superuser, RLS,
  extension đầy đủ) — Finding #1–4 đã fix + verify.
- Backward-compat: **không regress** trên superuser PG (verify3 15/15).
- Recovery: round-trip money 100% exact, cross-validate trên 2 restore độc lập;
  extension-complete target đạt được.

**Còn mở (không tự đóng — cần owner):**
- Recovery certification tổng thể: giải thích 38-row `storage.objects` delta,
  fault-domain replica thật, independent reviewer, exhaustive R2/object bytes.
- Production cutover từng domain (§27.3): window + canary org/class + count/VND cap
  + backup ID + migration/signature hash — **owner cấp riêng cho từng slice**.
- `t3_02` còn là superseded-but-present; migration production sẽ drop 2-arg claim
  cũ + phần ownership-transfer đã bị `t3_12` thay.

## 7. Điểm quyết định cho owner

1. **Recovery:** chấp nhận round-trip hiện tại (money exact, cross-validated) làm
   PROVEN core; hay yêu cầu đóng nốt 4 mục certification trước khi mở bất kỳ cutover.
2. **Cutover thứ tự §27.3** (payment/credit → invoice → income-expense/approval →
   cashbook → meter → deposit/contract → salary/profit): domain nào canary trước,
   canary org/class + count + VND cap + maintenance window cụ thể.
3. Bật/không bật các mục certification tốn phí (fault-domain thật, R2 exhaustive).

Không có input trên, trạng thái giữ nguyên: stack **PREPARED + on-target VALIDATED**,
KHÔNG apply production, KHÔNG grant/route/flip.
