# Audit: bảng DB nghi mồ côi + phần "chưa hoạt động" — 2026-09-02

> Theo khuôn `AUDIT-TIEN-HOA-DON-THU-CHI-THANH-TOAN-2026-08-13.md`. **Read-only tuyệt đối**: mọi
> truy vấn production là SELECT qua Management API (project `tryymsxyyckgbrmmvozx`), không một câu
> ghi nào. Sinh trong đợt đại tu dọn dẹp 02/09/2026 (chuỗi commit `c6c57e39`…), HEAD tại thời điểm
> audit: sau `2f085ebc`.

## 0. Kết luận điều hành

1. **Không bảng nào trong 14 bảng nghi vấn đang mất dữ liệu** — cả 14 đều `n_live_tup = 0`.
2. **12/14 bảng KHÔNG mồ côi**: `lucky_*` (4) và `approval_*` (8) đều có hệ hàm/trigger sống đang
   phục vụ; 0 dòng chỉ nghĩa là "chưa có dữ liệu", không phải "chết".
3. **2/14 bảng MỒ CÔI THẬT**: `legacy_owner_allowlist`, `legacy_owner_organization_map` — 0 dòng,
   0 hàm tham chiếu, 0 policy tham chiếu, 0 code ngoài types.ts + test migration lịch sử.
   → Ứng viên DROP, **đi plan riêng qua `migrate:forward`**, KHÔNG drop trong đợt này.
4. **Phát hiện ngoài dự kiến khi soi storage**: bucket `avatars` và `documents` **không tồn tại**
   trên production, nhưng code đang upload vào chúng → **đổi avatar hỏng 100%** (finding C-01).

## 1. Phương pháp

- Đếm dòng: `select relname, n_live_tup from pg_stat_user_tables where relname like '<nhóm>%'`.
- Ai đụng ở tầng DB: quét `pg_proc.prosrc` (schema `public` + `app_private`), `pg_trigger`
  (`tgisinternal = false`), `pg_policy` (qual + with_check).
- Ai đụng ở tầng code — **đủ 5 nguồn**: `src/`, `supabase/functions/`, `worker/`, `infra/`, và thân
  hàm SQL ở trên. (Bài học: chỉ grep `.from()` trong `src/` sẽ kết luận sai — 45 bảng `network_*`
  không hề xuất hiện trong `src/` nhưng sống khỏe qua worker/edge.)
- Storage: `select id, name, public from storage.buckets`.

## 2. Phán quyết từng nhóm bảng

### 2.1. `lucky_*` (4 bảng) — **SỐNG, đang trống**

| Bảng | n_live_tup |
|---|---|
| `lucky_events` · `lucky_event_rounds` · `lucky_event_teams` · `lucky_round_winners` | 0 |

Bằng chứng sống: **20 hàm** `lucky_*` trong catalog (`lucky_draw_v1`, `lucky_checkin_v1`,
`lucky_admin_upsert_event_v1`…), 2 trigger (`trg_lucky_set_event_slug`, `trg_lucky_set_team_code`),
client `src/lib/luckyDrawApi.ts`, và 3 migration MỚI 21–23/08/2026 (`20260821060000_lucky_game_mode`,
`20260821140000_lucky_nhieu_luot_dua`, `20260823060000_lucky_chot_ket_qua_la_quyen_quan_tri`).
Đây là hệ `/quayso` — khung nhiều trò chơi, **tuyệt đối không xóa trò cũ** (luật đã chốt với chủ).
0 dòng = giữa hai sự kiện. **Không đụng.**

### 2.2. `approval_*` (8 bảng) — **SỐNG, đang trống (engine phê duyệt canonical)**

| Bảng | n_live_tup |
|---|---|
| `approval_requests` · `approval_request_steps` · `approval_request_step_candidates` · `approval_decisions` · `approval_rules` · `approval_rule_sets` · `approval_rule_steps` · `approval_step_approvers` | 0 |

Bằng chứng sống: **~40 hàm** nhắc tới nhóm này trong prosrc — toàn bộ engine tài chính v2
(`submit_financial_request_v1`, `decide_financial_request_v2`, `materialize_step_candidates_v1`,
`_eval_approval_rule`, `emergency_approve_financial_v1`…), 2 trigger immutable
(`a00_rules_immutable`, `a00_rule_set_immutable`). Hệ phê duyệt tài chính (`docs/he-thong/20`) đang
go-live; 0 dòng nghĩa là các org chưa cấu hình rule set / chưa phát sinh request qua đường này —
migration `20260426000002` chỉ gỡ approval khỏi **thu chi thường**, không giết engine. **Không đụng.**
(Ghi chú điều tra tiếp — NGOÀI phạm vi audit này: vì sao 0 request sau nhiều tháng go-live; nếu
toàn bộ duyệt đang đi `income_expenses.status` thay vì engine, đó là câu hỏi kiến trúc, không phải
lý do DROP.)

### 2.3. `legacy_owner_*` (2 bảng) — **MỒ CÔI THẬT — ứng viên DROP**

| Bảng | n_live_tup | Hàm tham chiếu | Policy tham chiếu | Code tham chiếu |
|---|---|---|---|---|
| `legacy_owner_allowlist` | 0 | **0** (`prosrc ilike '%legacy_owner%'` → rỗng) | **0** | chỉ `types.ts` + `src/lib/__tests__/gd1SoMienTruMigration.test.ts` (test đọc file migration lịch sử) |
| `legacy_owner_organization_map` | 0 | **0** | **0** | chỉ `types.ts` |

→ Đề xuất: **plan riêng** DROP 2 bảng qua lane `migrate:forward` (kèm regen types + surfaces).
Không khẩn cấp — 2 bảng rỗng không gây hại, chỉ là rác schema.

## 3. Phần "chưa hoạt động" phát hiện qua đợt rà soát

### C-01 (P2) — Upload avatar hỏng 100%: bucket `avatars` không tồn tại — **ĐÃ VÁ cùng ngày** (migration `20260902005030_avatars_bucket_cho_anh_dai_dien.sql` apply prod qua migrate:forward, đo lại: bucket public + 4 policy LIVE)

`src/hooks/useProfile.ts:123` gọi `supabase.storage.from('avatars').upload(...)` nhưng
`storage.buckets` production chỉ có 10 bucket: `customer-id-cards`, `customer-images`,
`document-templates`, `income-expense-attachments`, `job-attachments`, `lucky-proofs`,
`meter-images`, `payment-receipts`, `ui-references`, `zalo-media` — **không có `avatars`**.
Upload ném lỗi ngay → tính năng đổi ảnh đại diện chết từ trong trứng.
**Sửa (chọn 1):** tạo bucket `avatars` (private + policy theo user), HOẶC đổi code sang bucket có
sẵn (`customer-images` không đúng nghĩa — nên tạo bucket riêng).

### C-02 (P3) — Fallback upload biên lai trỏ bucket `documents` không tồn tại — **ĐÃ VÁ cùng ngày** (commit `f2828765` gỡ 3 nhánh fallback)

`src/lib/receiptUpload.ts:40` + `src/components/invoices/{RecordPaymentDialog,BulkRecordPaymentDialog}.tsx`:
đường chính upload vào `payment-receipts` (tồn tại ✓); khi lỗi thì fallback sang bucket `documents`
— **không tồn tại**, nên fallback chắc chắn lỗi thêm lần nữa. Fallback chết = mã chết + che mờ lỗi
gốc. **Sửa:** bỏ nhánh fallback, hiển thị lỗi thật của `payment-receipts`.

### C-03 (P2) — Xóa khách thuê không kiểm hợp đồng đang hiệu lực

`src/hooks/useTenants.ts:194` — `// TODO: Check if tenant has active contracts`. Rủi ro toàn vẹn
nghiệp vụ: xóa khách đang có HĐ sống.

### C-04 (P3) — UI "Lịch sử chỉnh sửa" hóa đơn chưa làm

`src/components/invoices/InvoiceListTable.tsx:323` — placeholder TODO.

### C-05 (P3) — 2 lỗi TypeScript tồn đọng (baseline)

`ts-baseline.json`: TS2322 tại `src/components/invoices/GenerateInvoiceDialog.tsx` và
`src/pages/customers/CT01FormPage.tsx`. Không tăng thêm — gate chặn lỗi mới.

### C-06 (P3) — 3 e2e skip vô điều kiện

`.e2e-fleet/specs/accounting-chain.spec.ts:40`, `invoice-collection-v5.spec.ts:47` (pre-deploy
diagnostic skip), `salary-mobile-period.spec.ts:18` (tài khoản DEMO chưa cấu hình hưởng lương —
liên quan việc org DEMO mất fixture giữ sổ).

### C-07 (P2) — Nút "Thêm công tơ điện" trên UI hỏng

Service tên "Điện" đã xóa mềm 10/05/2026 nên `resolveServiceId` luôn throw (án lệ đã ghi nhận
trong memory dự án). Workaround hiện tại: INSERT thẳng công tơ bằng SQL.

## 4. Nợ hệ thống / CI (trạng thái 02/09)

- **Gap `ua-graph-stale` hết hạn 30/09/2026 — SÁT.** Graph `.ua/` build 11/08, còn 364 node
  OpenClaw (hệ đã xóa 30/08). Rebuild phải đi **PR riêng** (Contract §12 luật #6) — làm trước 30/09.
- Cross-tenant fixture đang **nuốt lỗi** (`|| ::warning::`, gap `cross-tenant-fixture-non-gating`
  đến 30/11/2026).
- `external-controls` + `generated-types-drift` là 2 job CI hay đỏ nhất (3 commit `fix(ci)` gần đây).
- Sổ nợ có cấu trúc: `tooling/plan-remaining.json` còn 106/365 deliverable (audit 08/08);
  `tooling/program-status.json` cập nhật lần cuối 13/08 — đã cũ 3 tuần.

## 5. Khuyến nghị

1. ~~Sửa C-01 + C-02~~ — **XONG cùng ngày 02/09**: bucket `avatars` live (migration `20260902005030`), fallback `documents` đã gỡ (`f2828765`).
2. ~~DROP `legacy_owner_*`~~ — **XONG cùng ngày 02/09**: migration `20260902005734_xoa_2_bang_legacy_owner_mo_coi.sql` apply prod (lane backup trước), đo lại pg_class: 2 bảng đã biến mất, catalog fingerprint đổi.
3. **Gate mới `check-orphan-tables.mjs`** (đề xuất, chưa làm): đối chiếu bảng trong catalog
   production với hợp nhất 5 nguồn tham chiếu (src / edge / worker / infra / prosrc) — chống lặp
   lại kiểu nghi vấn phải điều tra tay như đợt này.
4. **Rebuild graph `.ua/` trước 30/09** (PR riêng).

## 6. Truy vết lệnh (tái lập được)

```sql
select id, name, public from storage.buckets order by name;
select relname, n_live_tup from pg_stat_user_tables where relname like 'lucky%';
select relname, n_live_tup from pg_stat_user_tables where relname like 'approval%';
select relname, n_live_tup from pg_stat_user_tables where relname like 'legacy_owner%';
select n.nspname||'.'||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','app_private') and (p.prosrc ilike '%approval_req%'
  or p.prosrc ilike '%approval_rule%' or p.prosrc ilike '%lucky_event%'
  or p.prosrc ilike '%legacy_owner_%');
select tgname, tgrelid::regclass from pg_trigger where not tgisinternal
  and (tgrelid::regclass::text like 'lucky%' or tgrelid::regclass::text like 'approval%'
  or tgrelid::regclass::text like 'legacy_owner%');
select polname, polrelid::regclass from pg_policy
  where pg_get_expr(polqual, polrelid) ilike '%legacy_owner%'
  or pg_get_expr(polwithcheck, polrelid) ilike '%legacy_owner%';
```

Grep code: `grep -rln "<bảng>" src supabase/functions worker infra` cho từng bảng nghi vấn.
