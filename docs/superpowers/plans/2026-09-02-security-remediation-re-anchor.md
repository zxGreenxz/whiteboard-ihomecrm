# Re-anchor tồn đọng khắc phục bảo mật — trạng thái tại HEAD 02/09/2026

> **[CÒN SỐNG — trạng thái 02/09/2026]** Bản neo lại của `2026-08-12-security-remediation.md` (neo cũ HEAD `931eb9e7`, 13/08/2026). HEAD hiện tại `8f6e6ece`, đi sau neo cũ **190 commit**. Đã soi lại từng finding trong 49 finding trên mã/migration/ACL thật: **4 ĐÃ VÁ · 45 CÒN MỞ · 0 KHÔNG CÒN ÁP DỤNG**. Plan gốc vẫn **0/80 checkbox** — con số đó đúng, không phải do quên tick.

**Tính chất:** read-only. Không sửa code/migration/dữ liệu. Mọi `file:line` dưới đây đã được đọc tận mắt tại HEAD `8f6e6ece`.

---

## 0. Ba điều phải biết trước khi đọc bảng

**(a) Không một dòng nào của plan 12/08 được thi hành.** Toàn bộ hạ tầng mà plan tự gọi đều không tồn tại: `scripts/test-security-remediation.mjs`, `scripts/security-disposable-db.mjs`, `scripts/check-security-remediation-manifest.mjs`, `tooling/security-remediation-manifest.json`, `src/lib/financeInputLimits.ts`, `src/integrations/supabase/authStorage.ts`, `infra/cloudflare-worker/src/boundedBody.ts`, `supabase/functions/_shared/bounded-json.ts`, `supabase/functions/public-room-events/`, `supabase/functions/lucky-proof-upload/`. Không có migration nào trong dải `20260814010000`–`20260814032000` mà plan đặt tên. 4 finding đã vá đều được vá **tình cờ bởi công việc khác**, không phải bởi plan này.

**(b) Audit `/thanh-toan` 31/08 KHÔNG trùng với 49 finding này.** `docs/audits/AUDIT-THANH-TOAN-2026-08-31.md` có 13 finding riêng (2 P1 · 7 P2 · 4 P3) về `pay_period_fee` / `pay_draft_fee_voucher` / `update_period_fee` / reader Điện-Nước. Đối chiếu từng dòng: **0 giao với 49 finding của scan 12/08**. Giả định "audit 31/08 đã vá 13 finding của plan bảo mật" là **sai** — hai tập rời nhau.

**(c) Gate `check-definer-acl` đang XANH mà không bảo vệ gì ở đây.** `scripts/definer-acl-baseline.json` (snapshot production 23/08/2026) **allowlist hoá** đúng những cửa đang hở: `approve_meter_reading(uuid)`, `bulk_approve_meter_readings(uuid[])`, `lucky_save_payout_v1(text,jsonb)`, `lucky_event_open_v1(text)`, `salary_work_ledger(date,uuid)`, `monthly_building_profit(date,date,uuid)`, `get_change_breakdown_v2(...)`, `get_deposit_breakdown_v2(...)`, `get_public_latest_invoice_by_code(text)`, `get_public_available_rooms(text)`, `log_public_room_events(text,jsonb)`. `denylist` chỉ có 4 mục, không mục nào thuộc 49 finding. CI xanh ở đây nghĩa là **"đã ghi nhận"**, không phải **"đã vá"** — chính `scripts/check-definer-acl.mjs:12-24` cảnh báo đúng khuyết tật này (án lệ 07/08/2026).

---

## 1. Bảng tổng

| Mức | Tổng | ĐÃ VÁ | CÒN MỞ | KHÔNG CÒN ÁP DỤNG | CHƯA XÁC MINH ĐƯỢC |
|---|---:|---:|---:|---:|---:|
| **P1** | 14 | 2 (+9 vá tối 02/09 → **11**) | **3** | 0 | 0 |
| **P2** | 26 | 1 (+8 vá tối 02/09 → **9**) | **17** | 0 | 0 |
| **P3** | 9 | 1 | **8** | 0 | 0 |
| **Tổng** | **49** | **4 → 21** | **45 → 28** | **0** | **0** |

4 finding ĐÃ VÁ tại thời điểm re-anchor: `PZALO-C02` (P1), `FR009-C03` (P1), `FR020-C03` (P2), `FR006-C01` (P3).

**CẬP NHẬT tối 02/09/2026 — 9 finding P1 đã vá ngay sau re-anchor** (đều có bằng chứng đo lại trên production):
- `PZALO-C01` ×4 (send/react/recall/history): guard worker `worker/lib/scope-guard.js` (`validateZaloCommandScope`, chạy SAU claim TRƯỚC provider; 8 test vitest) — **hiệu lực khi VPS worker cập nhật code** (bước 2–3 của plan: RPC enqueue v2 + revoke DML còn để sau).
- `PMETER-C01` ×2 + `FR009-C04` bước 1: migration `20260902082002` REVOKE anon/PUBLIC trên `approve_meter_reading(uuid)`, `bulk_approve_meter_readings(uuid[])`, `salary_work_ledger(date,uuid)` (đo lại: anon_exec=false), đưa `_v1` meter vào migration (hết drift PS04), 3 chữ ký vào `denylist` definer-acl.
- `FR002-C01`: migration `20260902082003` — `transfer_contract_impl` khoá org + khách mới phải cùng org (42501).
- `PCOMPAT-C01`: migration `20260902082004` — `ie_compat_update_pending_v2` khoá org, tính scope CUỐI, mọi quan hệ phải cùng org, authorize v3 hai lần (toà cũ + toà mới), hết helper STABLE trong đường quyết định.
- Còn mở P1: `FR009-C05` (đổi nguồn rule thưởng — đổi số tiền, chờ chủ), `FR001-C03` (lucky payout v2), `FR002-C02` (move-out settlement v2) — ba đường tiền, mỗi cái một PR riêng + reconcile.

**Không có finding nào "KHÔNG CÒN ÁP DỤNG."** Việc xoá OpenClaw 30/08 chỉ xoá *file client* mà plan trỏ tới (`src/lib/openclaw-zalo/`, `src/hooks/openclaw-zalo/openClawRpc.ts`, `.e2e-fleet/specs/openclaw-zalo.spec.ts`); mọi đối tượng SQL/queue `zalo_*` mà finding thật sự nói tới **vẫn sống** — migration `20260830085316_xoa_toan_bo_openclaw.sql:161-163` chỉ xoá key quyền `openclaw_zalo.%`, không đụng `chat_zalo.*`.

---

## 2. Từng finding

### FR001-C01 (P2) — Public room RPC lộ sale bonus note nội bộ

**Trạng thái:** CÒN MỞ — **CHỜ CHỦ QUYẾT (soi lại 02/09 tối)**: trang `/phong-trong` là trang cho ĐỐI TÁC SALE xem theo token (không phải khách thuê cuối) và `PhongTrongSheet.tsx:359-362` cố ý render ô "Thưởng sale" cho họ; comment `supabaseData.ts:58` "KHÔNG gửi khách" nghĩa là khách thuê cuối. Cắt `sale_bonus_note` khỏi RPC là đổi nghiệp vụ bán hàng, không tự làm. Nếu chủ muốn giữ cho sale: chấp nhận rủi ro token 6 ký tự (đóng chung với FR001-C05 bằng token dài + expiry); nếu không: bỏ cột khỏi CTE `rms` + bỏ ô UI.
**Bằng chứng:** `supabase/migrations/20260731070000_current_date_to_org_today.sql:2701` đưa `rm.sale_bonus_note` vào CTE `rms`, rồi `:2770` `SELECT jsonb_agg(to_jsonb(rms) …)` serialize **cả row** → trường nội bộ lọt thẳng vào payload anon. Không dùng allowlist như plan yêu cầu. `20260820090000_sale_bonus_deposit_account_attachments.sql` không đụng tới cột này.
**Vị trí mới:** RPC `supabase/migrations/20260731070000_current_date_to_org_today.sql:2657-2770`; client `src/pages/phong-trong/supabaseData.ts:58,174`; render `src/pages/phong-trong/PhongTrongSheet.tsx:359-362`.

### FR001-C02 (P3) — Contract code ngắn, không expiry, lộ invoice

**Trạng thái:** CÒN MỞ (đã giảm nhẹ, chưa đóng)
**Bằng chứng:** Mã 6 ký tự base-57 ≈ 3,4·10¹⁰ (`supabase/migrations/20260530000003_contract_public_short_code.sql:18-41,56`). Resolver `supabase/migrations/20260808140000_gdr_tra_ve_429_thay_vi_500.sql:66-68` chỉ lọc `public_code = p_code AND deleted_at IS NULL` — **không** `expires_at`, **không** `revoked`. ACL anon còn nguyên (`20260530000003:127-128`; xác nhận ở `scripts/definer-acl-baseline.json`). Đã có rate-limit 60 lần sai/10 phút/IP + HTTP 429 (`20260808130000`, `20260808140000:36-60`) và đã bỏ SĐT khỏi payload (`20260808100000`). Chính comment `20260808100000_bo_sdt_khoi_payload_cong_khai.sql:32-33` thừa nhận expiry/revoked "chờ người quyết".
**Vị trí mới:** `src/pages/public/PublicContractInvoicePage.tsx:108`; `src/components/contracts/ContractQRDialog.tsx:22`.

### FR001-C03 (P1) — Mã Lucky sáu chữ số cho phép sửa payout

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/migrations/20260731110000_lucky_multiple_proofs.sql:82` định nghĩa `lucky_save_payout_v1(p_code text, p jsonb)`; `:154-155` `revoke … from public;` rồi `grant execute … to anon, authenticated` → **anon ghi payout được**. Xác thực duy nhất `:101` `where t.code = p_code`. Mã sinh 6 chữ số tại `20260731070000_lucky_draw_events.sql:86`. Client còn gọi bằng anon key: `src/lib/luckyDrawApi.ts:251` `publicRpc('lucky_save_payout_v1', …)`. Không tồn tại `lucky_save_payout_v2`, `app_private.lucky_payout_capabilities`, `secure_bytea_equal_v1` (grep toàn repo = 0). `20260823060000_lucky_chot_ket_qua_la_quyen_quan_tri.sql` **không** chạm payout (0 hit chuỗi `lucky_save_payout`). Production ACL 23/08 vẫn liệt kê `lucky_save_payout_v1(text,jsonb)`.
**Fix đề xuất:** đúng khuôn Task 1 nhưng cắt gọn — migration additive tạo `app_private.lucky_payout_capabilities` + `lucky_save_payout_v2(p_capability,…)` với digest SHA-256, TTL ≤ 7 ngày, CAS revision, idempotency key; đổi `src/lib/luckyDrawApi.ts:251` sang v2 (token chỉ giữ trong React memory, đọc từ URL fragment rồi `history.replaceState`); migration revoke riêng cắt `anon, authenticated` khỏi v1 **sau** khi đo caller v1 = 0. **Rủi ro: CAO** — đây là đường ghi tiền thưởng do người ngoài (participant) gọi bằng anon key; đổi sai làm hỏng luồng nhận thưởng đang chạy. Bắt buộc giữ v1 song song tới khi adoption = 0.

### FR001-C04 (P2) — Lucky proof upload thiếu participant capability

**Trạng thái:** CÒN MỞ
**Bằng chứng:** Không có Edge function `supabase/functions/lucky-proof-upload/` (thư mục `supabase/functions/` chỉ có admin-create-user, demo-reset, llm-proxy, network-center-worker, network-watchdog, salary-v5-jobs, send-push). Policy hiệu lực `supabase/migrations/20260731100000_lucky_proof_upload_policy_fix.sql:46-51`: `for insert to anon, authenticated with check (bucket_id='lucky-proofs' and lucky_event_open_v1(...))` — điều kiện DUY NHẤT là "sự kiện còn mở", không ràng buộc team/mã. Client upload thẳng Storage bằng anon key: `src/lib/luckyDrawApi.ts:254,280-296`.

### FR001-C05 (P3) — Public room token sáu ký tự không expiry

**Trạng thái:** CÒN MỞ
**Bằng chứng:** Token base-57 6 ký tự (`supabase/migrations/20260607090300_create_public_room_token_rpc.sql:26`). Bảng `public_room_share_tokens` có `revoked` nhưng **không có `expires_at`** (`20260606120000_public_room_share_phong_trong.sql:19-26`; xác nhận `supabase/baseline/schema.sql:59178-59185` và `src/integrations/supabase/types.ts:13589-13597`). Resolver chỉ kiểm `revoked = false` (`20260606120000:57-58`). `20260831023937_public_room_events_ghi_loi_ben_vung.sql:54-57` dùng lại đúng check cũ. ACL của `create_public_room_token(text)` **đúng** (`20260607090300:49-50` revoke anon) — phần hở là vòng đời token, không phải ACL.
**Vị trí mới:** `src/hooks/usePublicRoomTokens.ts:67-77` (chỉ toggle `revoked`).

### FR002-C01 (P1) — Contract transfer gắn customer khác tổ chức

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902082003` _(bản re-anchor sáng 02/09 ghi: CÒN MỞ)_
**Bằng chứng:** Migration mới nhất `supabase/migrations/20260728170000_b8_contract_transfer_audit_customers.sql:69`; thân hiệu lực `supabase/baseline/schema.sql:93163-93254`. Kiểm khách hàng duy nhất là `schema.sql:93190` `IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_new_customer_id)` — **không** so `customers.organization_id` với `v_contract.organization_id`. Không có `lock_org_for_decision_v1`. Wrapper `schema.sql:93142-93148` chỉ gate quyền trên toà của **hợp đồng**, không gate khách hàng. Không có composite FK `(organization_id, customer_id)`.
**Fix đề xuất:** migration forward `CREATE OR REPLACE` cho `transfer_contract_impl` — pre-read lấy `contract.organization_id`, `PERFORM app_private.lock_org_for_decision_v1(v_org)`, re-read contract `FOR UPDATE` + customer `FOR SHARE` với `organization_id = v_org`, `RAISE … 42501` nếu lệch; enforce ở **cả** wrapper lẫn `_impl`. Chữ ký không đổi ⇒ `CREATE OR REPLACE` an toàn, không cần DROP. **Rủi ro: THẤP–TRUNG BÌNH** — thêm điều kiện chặn, ca hợp lệ cùng org không đổi hành vi; cần quarantine dữ liệu lệch sẵn có trước khi thêm ràng buộc cứng.

### FR002-C02 (P1) — Move-out tin số settlement từ caller

**Trạng thái:** CÒN MỞ
**Bằng chứng:** Migration mới nhất `supabase/migrations/20260822093000_termination_customer_refund_items.sql:89` (`_impl`), `:399` (`terminate_contract_move_out`, nay **11 đối số**), `:590` (`_with_credit_v1`, **12 đối số** — đã thêm `p_refund_items`, tức ABI đã trôi so với plan). Ba số client vẫn được tin thẳng: `:101-103` `v_penalty := COALESCE(p_penalty_fee,0)`, `v_excess := COALESCE(p_excess_rent,0)`, `v_debt := COALESCE(p_outstanding_debt,0)` → `:180` `v_charges := v_debt + v_penalty + v_extra`. Chốt duy nhất là kẹp **cọc**: `:163` `v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund,0),0), COALESCE(v_contract.deposit_paid,0))`. Không có `_v2`, `compute_moveout_settlement_v1`, `p_expected_settlement`. `20260828090000_termination_refund_writer_hardening.sql` **không áp** vào hàm này — nó chỉ sửa `record_termination_refund_obligation_v1` (`:52`) và `create_termination_refund_voucher_v1` (`:114`) trên đường hoàn cọc V2.
**Fix đề xuất:** migration additive tạo `app_private.compute_moveout_settlement_v1(...)` (VOLATILE, chỉ đọc state đã khoá) + `terminate_contract_move_out_v2(p_contract_id, p_move_out_date, p_expected_settlement jsonb, …)` tính server-side rồi so `p_expected_settlement`, lệch thì `40001`; **không** đổi chữ ký 11/12 đối số đang chạy. Cutover `src/hooks/useContractOperations.ts` + `src/lib/customerCreditRpc.ts` sang v2, đo caller legacy = 0 rồi mới revoke. **Rủi ro: CAO** — đường tiền thanh lý hợp đồng; bắt buộc chạy `node scripts/reconcile-money.mjs 2026-08` và `reconcile-money-v2.mjs` hai đầu, kèm bằng chứng idempotency.

### FR003-C01 (P2) — Edge buffer body trước byte cap

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/functions/network-center-worker/index.ts:669-705` — `readJsonBody` có pre-check `content-length` (`:690-693`) nhưng vẫn `:694` `const bytes = new Uint8Array(await request.arrayBuffer());` rồi `:695` mới `if (bytes.byteLength > maximumBytes)`. Request chunked/thiếu `Content-Length` → `declaredLength = 0` → lọt cửa, buffer toàn bộ vào RAM. Không có `supabase/functions/_shared/` (thư mục không tồn tại).

### FR003-C02 (P3) — Worker buffer success body trước cap 4 MiB

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `infra/network-center-worker/src/apiClient.ts:214-226` — `:215` pre-check `Number(response.headers.get("content-length") ?? "0")`, `:220` `raw = await response.text();`, cap hậu kiểm `:224`. `?? "0"` biến "không khai báo" thành "kích thước 0" nên response chunked lọt hoàn toàn. Cap `:120` `MAX_RESPONSE_BYTES = 4 * 1024 * 1024`. Không có `readBoundedUtf8Response` (grep repo = 0).

### FR003-C03 (P3) — Worker buffer error body trước cap 4 KiB

**Trạng thái:** CÒN MỞ (nhẹ hơn nhánh success)
**Bằng chứng:** Cùng file, `readErrorReason` `infra/network-center-worker/src/apiClient.ts:145-170`. Tốt hơn ở chỗ `:147` chặn declared-oversize và `:149` `body.cancel()`; nhưng `:156` `const raw = await response.text();` vẫn chạy khi header vắng (cùng bẫy `?? "0"`), cap hậu kiểm `:157`. Cap `:127` `MAX_ERROR_REASON_BYTES = 4_096`.

### FR005-C01 (P3) — Remember Me bị bỏ qua, session luôn localStorage

**Trạng thái:** CÒN MỞ — checkbox là **no-op** hoàn toàn
**Bằng chứng:** Checkbox có thật (`src/pages/auth/Login.tsx:131-139`, truyền lên `:51` `rememberMe: formData.rememberMe`), nhưng bị nuốt: `src/hooks/useAuth.ts:25` chỉ khai báo `rememberMe?: boolean` trong `LoginData`, còn `useLogin.mutationFn` (`:180-190`) gọi `supabase.auth.signInWithPassword({ email, password })` — **không đọc `data.rememberMe`**. Grep toàn repo: `rememberMe` chỉ xuất hiện ở 2 file đó, không nơi nào tiêu thụ. Client cứng localStorage: `src/integrations/supabase/client.ts:15-16`. `src/integrations/supabase/authStorage.ts` không tồn tại; `sessionStorage` = 0 hit trong `src/integrations/`.

### FR006-C01 (P3) — Confirmation do model điều khiển tạo finance voucher

**Trạng thái:** **ĐÃ VÁ**
**Bằng chứng:** Nonce do server phát, không phải cờ boolean của model — `src/copilot/tools/writeTools.ts:145` gọi `copilot_preview_income_expense_v1` → `:159,165` lấy `kq.confirmation_nonce`; thực thi riêng `:214-215` `copilot_execute_income_expense_v1({ p_confirmation_nonce: nonce, … })`. `inputSchema` của tool **không có** trường `confirmed`/`nonce` (`:60-90`). `src/copilot/confirmationStore.ts` tồn tại: giữ nonce in-memory, TTL 5 phút, khoá theo `intentKey` + `organizationId`/`threadId`/`generation`, xoá sạch khi đổi ngữ cảnh (`:47-60`). Bảng `app_private.copilot_write_confirmations` có trong `supabase/migrations/20260814034500_copilot_confirmation_intent_v1.sql` và `20260830171108_copilot_income_expense_rpc_hardening_v1.sql`. Browser hết đường ghi audit: `20260814034600_ai_write_audit_hardening.sql:45-48` `DROP POLICY … ai_write_audit_insert` + `REVOKE INSERT, UPDATE, DELETE ON public.ai_write_audit FROM authenticated`. Vá bởi commit `e366679c`, không phải bởi plan này.

### FR009-C01 (P2) — Zalo reaction permission rộng vượt tenant

**Trạng thái:** CÒN MỞ (nửa "vượt tenant" đã đóng, nửa "permission rộng" còn nguyên)
**Bằng chứng:** `supabase/migrations/20260813100000_zalo_khu_rieng_theo_cong_ty.sql:370-386` — `zalo_react_message(uuid,text)` nạp conversation `:377-380` rồi `IF NOT public.zalo_can('send', c.organization_id)` ⇒ đã org-scoped theo RBAC v3, nhưng **vẫn dùng key rộng `chat_zalo.send`**. Key `chat_zalo.react` **không tồn tại**: catalog seed `20260713110100_sprint2b_seed_permission_definitions.sql:10-13` chỉ có `view / send / manage_automation / manage_templates`; client map `src/lib/permissionPages.ts:134-137` khớp y hệt; grep `chat_zalo.react` toàn repo = 0.

### FR009-C02 (P2) — Zalo recall message outbound của user khác

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/migrations/20260813100000_zalo_khu_rieng_theo_cong_ty.sql:389-406` — `:396` chỉ kiểm `IF m.direction <> 'out' THEN RAISE EXCEPTION 'Chỉ thu hồi được tin do bạn gửi'`. Thông báo nói "do bạn gửi" nhưng **không so `sent_by` với `auth.uid()`**; `:398-400` chỉ `zalo_can('send', c.organization_id)`. ⇒ bất kỳ ai có `chat_zalo.send` trong org thu hồi được tin outbound của đồng nghiệp (cột `sent_by` có sẵn — `20260813110000:168,171`). Key `chat_zalo.recall` không tồn tại trong catalog.
**Vị trí mới:** client `src/hooks/useZaloChat.ts:275` `db.rpc('zalo_recall_message', { p_message_id })`.

### FR009-C03 (P1) — Zalo group history đọc conversation tùy ý

**Trạng thái:** **ĐÃ VÁ (ở tầng RPC)** — nhưng xem cảnh báo dưới
**Bằng chứng:** `supabase/migrations/20260813100000_zalo_khu_rieng_theo_cong_ty.sql:409-424` — `zalo_load_history(uuid,integer)`: `:414-415` nạp conversation, `:416` bắt buộc `thread_type = 'group'`, `:417-419` `IF NOT public.zalo_can('view', c.organization_id) THEN RAISE … 42501`. Job enqueue dùng `c.account_id`, `c.thread_id`, `c.organization_id` (`:420-423`) — client **không** chọn được thread. ACL không anon: `20260813140000_zalo_rpc_revoke_public.sql:44` + nghiệm thu `:72-80`. Vá bởi commit `cb88a8d7` + chuỗi migration Zalo 13/08.
**Cảnh báo:** lỗ **tương đương** vẫn còn qua đường queue forgery (xem `PZALO-C01/history`) vì worker không revalidate. Đóng ở RPC không đóng ở queue.

### FR009-C04 (P1) — Salary CASH branch thiếu tenant scope

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — bước 1 xong: migration `20260902082002` REVOKE anon + denylist; bước 2 (`salary_work_ledger_v2` theo org) gộp với FR009-C05 _(bản re-anchor sáng 02/09 ghi: CÒN MỞ)_
**Bằng chứng:** Bản hiệu lực `supabase/migrations/20260720181000_jobs_completion_time_integrity.sql:138-264`. Nhánh (D) CASH `:245-262`: `FROM public.income_expenses ie … WHERE ie.type='INCOME' AND ie.salary_role='CASH_COLLECTION' AND ie.deleted_at IS NULL AND ie.salary_staff_id IS NOT NULL AND (v_staff IS NULL OR ie.salary_staff_id = v_staff) AND ie.voucher_date BETWEEN v_start AND v_end` — **không `organization_id`, không building scope**. Hàm là `SECURITY DEFINER` nên RLS trên `income_expenses` bị bỏ qua. Admin org A gọi với `p_staff_id = NULL` thấy mọi dòng thu tiền mặt của **mọi org**. `salary_work_ledger_v2` không tồn tại (grep = 0). ACL: `contracts/surfaces/rpc-surface.json` ghi `execRoles: ["anon","authenticated","service_role"]`, `risk: "financial"` — **anon gọi được**. Ba migration lương gần đây (`20260827180000`, `20260827190000`, `20260901173727`) đều **không** đụng hàm này.
**Fix đề xuất:** hai bước tách bạch. (1) *Chặn ngay, rẻ và không đổi ABI*: migration forward `REVOKE ALL ON FUNCTION public.salary_work_ledger(date,uuid) FROM PUBLIC, anon;` + thêm `salary_work_ledger(date,uuid)` vào `denylist` của `scripts/definer-acl-baseline.json` để không ai mở lại. (2) *Đóng thật*: migration additive `salary_work_ledger_v2(p_organization_id uuid, p_period_month date, p_staff_id uuid DEFAULT NULL)` VOLATILE SECURITY DEFINER, `lock_org_for_decision_v1(p_organization_id)` rồi `authorize_tenant_action_v3(auth.uid(), p_organization_id, 'salary.view', NULL, NULL)`; mọi nhánh JOB/DAY_BONUS/CASH/config/holiday/building/room filter `organization_id = p_organization_id`; cutover `src/hooks/useManagerSalary.ts:145` và thêm org vào query key `:58`. **Rủi ro: bước (1) THẤP** (anon không phải caller hợp lệ — hook luôn gọi có JWT); **bước (2) TRUNG BÌNH** (đổi ABI, phải giữ v1 tới khi adoption = 0).

### FR009-C05 (P1) — Salary ledger dùng first-super-admin global

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/migrations/20260720181000_jobs_completion_time_integrity.sql:155` `v_owner := (SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1);` — lặp lại ở `:308` trong `award_job_bonus`. `v_owner` lái toàn bộ cấu hình tiền: `:162` `SELECT r.rules INTO v_rules FROM public.salary_bonus_rules r WHERE r.user_id = v_owner` và `:241` `salary_holidays h WHERE h.user_id = v_owner`. Tức quy tắc thưởng cuối tuần / ngày lễ / mốc của **super admin đầu tiên trong bảng** áp cho mọi tổ chức. `:156-158` `IF NOT (is_admin() OR is_super_admin()) THEN v_staff := auth.uid(); END IF;` — admin của **bất kỳ** org xem được toàn cục.
**Fix đề xuất:** đi chung migration với FR009-C04 — trong `salary_work_ledger_v2`, thay `v_owner` bằng `p_organization_id` và đọc `salary_bonus_rules` / `salary_holidays` theo org (nếu hai bảng đó chưa có `organization_id` thì phải backfill + trigger trước, theo đúng khuôn `20260827180000_salary_org_backfill_va_trigger.sql`). **Rủi ro: TRUNG BÌNH–CAO** — đổi nguồn quy tắc thưởng làm **số tiền lương đổi** với org đang vô tình ăn rule của super admin đầu; bắt buộc đo chênh lệch trước/sau trên dữ liệu thật và hỏi chủ trước khi apply.

### FR011-C01 (P2) — Monthly profit fallback first super-admin tenant

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/migrations/20260703162000_monthly_building_profit_tenant_aware.sql:23-29` — chuỗi `COALESCE` kết thúc bằng `(SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1)`, đúng nhánh fallback mà finding mô tả. `v_owner` sau đó lái mọi truy vấn (`:43`, `:54`, `:62` `WHERE b.user_id = v_owner`). Hàm còn anon-executable theo `scripts/definer-acl-baseline.json` (`monthly_building_profit(date,date,uuid)`).

### FR011-C02 (P2) — Monthly profit gồm restricted-category amounts

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/migrations/20260703162000_monthly_building_profit_tenant_aware.sql:40-61` — hai nhánh `SUM(ie.kqkd_amount)` chỉ lọc `type`, `kqkd_amount > 0`, `approval_status='APPROVED'`, `deleted_at`, `voucher_date`. **Không** gọi `can_view_restricted_ie()` (helper tồn tại, có trong `definer-acl-baseline.json`, nhưng không được dùng ở đây), không lọc category hạn chế.

### FR011-C03 (P2) — Change breakdown lộ restricted vouchers

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/migrations/20260703160000_breakdown_rpcs_setbased_scope.sql:28-71` — `get_change_breakdown_v2` chỉ scope theo toà (`:56-60` `has_full_building_scope()` / `accessible_building_ids()`). Grep `restricted|is_restricted|can_view_restricted_ie` trong file = **0 hit**. Hàm anon-executable theo `definer-acl-baseline.json`.

### FR011-C04 (P2) — Deposit breakdown lộ restricted data

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/migrations/20260703160000_breakdown_rpcs_setbased_scope.sql:74-120` — `get_deposit_breakdown_v2` cùng khuôn: chỉ scope toà (`:108-112`), không lọc restricted, và trả thêm trường nhạy cảm (`c.total_deposit`, `c.deposit_paid`, `c.deposit_remaining`, `ie.notes`). Hàm anon-executable theo `definer-acl-baseline.json`.

### FR014-C01 (P3) — Invoice collection nhận tender array không giới hạn

**Trạng thái:** CÒN MỞ
**Bằng chứng:** Migration mới nhất `supabase/migrations/20260802230000_collect_cashbook_possession_gate.sql:29`; thân hiệu lực `supabase/baseline/schema.sql:85126-85960`. Chỉ có cận **dưới**: `schema.sql:85204-85208` = `jsonb_typeof(p_tenders) <> 'array' OR jsonb_array_length(p_tenders) = 0`. Không `pg_column_size`, không `> N`. Mã lỗi `finance_input_limit_exceeded` không tồn tại trong repo.

### FR015-C01 (P3) — Compat insert nhận item array không giới hạn

**Trạng thái:** CÒN MỞ
**Bằng chứng:** Định nghĩa hiệu lực đã trôi **hậu-baseline**: `supabase/migrations/20260830183259_copilot_draft_writer_v1.sql:82` `CREATE OR REPLACE FUNCTION public.ie_compat_insert_v2`. Giới hạn duy nhất chỉ áp cho **nhánh Copilot**: `:203-204` `IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) <> 1 THEN RAISE … '22023'`, bọc trong `IF v_copilot_draft THEN` (`:181`). Nhánh caller thường (`v_copilot_draft = false`) chạy `FOR v_item IN SELECT * FROM jsonb_array_elements(...)` **không giới hạn** (baseline `schema.sql:67577-67594`, giữ nguyên trong bản 30/08).

### FR016-C01 (P2) — Recurring voucher mở one-building thành owner-wide

**Trạng thái:** CÒN MỞ
**Bằng chứng:** Thân hiệu lực `supabase/baseline/schema.sql:62686-62710`. Vẫn **no-arg**: `:62686` `generate_recurring_vouchers_v2() RETURNS TABLE(...)`. Phạm vi owner-wide `:62695-62700` (super admin → mọi `buildings.user_id`; staff → mọi owner qua `staff_assignments`), rồi `:62706-62708` `FOREACH v_owner … generate_recurring_vouchers(v_owner)` — chạy **toàn bộ toà của owner**, không lọc toà. `_v3(p_organization_id, p_building_ids)` không tồn tại. Caller vẫn no-arg: `src/hooks/income-expenses/recurring.ts:40`.

### FR017-C01 (P2) — Evidence adoption dùng attachment ngoài scope

**Trạng thái:** CÒN MỞ (đã có sẵn một lớp chặn chéo-org từ trước)
**Bằng chứng:** Thân hiệu lực `supabase/baseline/schema.sql:44631-44747`. Không có `_v3`; không có `app_private.finance_evidence_bindings` (grep = 0). Không bind evidence với source voucher + destination key — hàm chỉ `RETURN jsonb_build_object('evidence_ids', v_ids, …)` (`:44745`), trả ID trần cho client. Gate quyền chỉ là "có membership ACTIVE trong org của phiếu" (`:44656-44660`), **không** gate theo toà/sổ quỹ. Đã có sẵn (không do plan này): chặn mượn file chéo org `:44695-44703` qua `app_private.storage_object_links`.
**Vị trí mới:** caller `src/hooks/income-expenses/financeV2Mutations.ts:199`.

### FR018-C01 (P2) — Finance V2 nhận related UUID khác org

**Trạng thái:** CÒN MỞ (`cashbookId` đã kín, `roomId`/`tenantId`/`typeId` chưa)
**Bằng chứng:** Thân hiệu lực `supabase/baseline/schema.sql:58073-58242`. `cashbookId` **có** validate org (`:58152-58155` `a.organization_id = v_org`) — mục duy nhất kín. `roomId`/`tenantId` **không** validate, cắm thẳng vào INSERT `:58193`. `items[].typeId` chỉ kiểm NOT NULL (`:58209-58211`) rồi INSERT `:58216` với `organization_id = v_org` cứng ⇒ type của org khác được gắn vào item mang nhãn org mình. Composite FK `(organization_id, room_id) -> rooms` v.v. **không tồn tại**.

### FR018-C02 (P3) — Finance V2 nhận item array không giới hạn

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/baseline/schema.sql:58203-58222` — `:58203` `IF jsonb_typeof(payload->'items') = 'array' THEN` → `:58204` `FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP`, không đếm phần tử, không `pg_column_size`. Validate per-item chỉ về nội dung (`:58205-58211`). `src/lib/financeInputLimits.ts` không tồn tại.

### FR020-C01 (P2) — Copilot evaluator bỏ canonical deny/override

**Trạng thái:** CÒN MỞ — và nặng hơn mô tả gốc
**Bằng chứng:** `supabase/functions/llm-proxy/index.ts` uỷ quyền cho `reserve_ai_usage` (`:287`), hàm này gọi evaluator riêng `public.ai_copilot_perms_for(p_user)` (`supabase/migrations/20260710200000_ai_copilot_backend.sql:245`). Evaluator đó (`:163-197`) đọc `staff_assignments` JOIN `roles` với `ORDER BY … LIMIT 1` — lấy **đúng một** assignment; **không** đọc `member_permission_overrides`, **không** có DENY thắng ALLOW, **không** kiểm org lifecycle/membership status; tức không phải `authorize_tenant_action_v3`. Nghiêm trọng hơn: `:195` `IF v_perms IS NULL THEN RETURN '{"__superadmin": true}'::jsonb;` — user **không có** staff_assignment nào được trả về quyền superadmin (fail-**open**), và `reserve_ai_usage:246` `IF NOT (v_perms ? '__superadmin')` bỏ qua toàn bộ kiểm quyền cho trường hợp đó. Comment `:244` thừa nhận thiết kế này ("owner sentinel pass — entitlement mới là gate thật"), nên hàng rào thực tế chỉ còn bảng `ai_copilot_entitlements`.

### FR020-C02 (P2) — Authorization explanation thiếu target-org binding

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902084858` (gate `authorize_tenant_action_v3(v_actor, v_org, 'users.view')`, hết `can_v3` không org; đo prod: con_can_v3=false). _(bản re-anchor sáng ghi: CÒN MỞ)_
**Bằng chứng:** `supabase/migrations/20260725190000_authz_read_rpcs.sql:177` `explain_authorization_v1(p_membership, p_permission_keys, p_building, p_cashbook)`. Hàm **có** derive `v_org` từ membership (`:211-216`), **có** `lock_org_for_decision_v1(v_org)` (`:219`), **có** ràng buộc building/cashbook thuộc `v_org` (`:229-239`). Nhưng gate quyền của actor ở `:224` là `app_private.can_v3('users.view')` — **không truyền org**. `can_v3` (`20260725070000_authz_read_path_v3.sql:356-375`) dùng `authorized_scope_all_v3(p_permission_key)`, tức **hợp nhất mọi org** của actor. ⇒ actor có `users.view` ở org A đọc được giải thích phân quyền của thành viên org B. Biến thể đúng `app_private.authorized_scope_v3(text, uuid)` (có tham số org) tồn tại nhưng không được dùng ở đây.
**Fix gợi ý:** đổi `:224` sang biến thể nhận `v_org` (`authorized_scope_v3('users.view', v_org)` hoặc `authorize_tenant_action_v3(auth.uid(), v_org, 'users.view', NULL, NULL)`). Chữ ký hàm không đổi.

### FR020-C03 (P2) — Admin read chọn first org sau global permission

**Trạng thái:** **ĐÃ VÁ**
**Bằng chứng:** commit `4f3af291` *"feat(copilot): chot cong ty tuong minh — bo authority organizations[0]"* (14/08/2026). Thông điệp commit ghi rõ: `resolveSelectedOrganizationId()` — một công ty ⇒ tự chọn, nhiều công ty ⇒ phải chọn tường minh, chưa chọn thì `null`, **không rơi về phần tử đầu**; `selectOrganization()` lưu ID; thêm `ToolCtx.organizationId` + `chotToChuc()` để 9 tool org-scoped ném `organization_required` **trước** mọi truy vấn; `tim_khach_hang` / `hop_dong_sap_het_han` lọc thêm `.eq('organization_id')`. Đúng nội dung Task 9 yêu cầu cho finding này, vá độc lập với plan.

### FR023-C01 (P2) — Fixed-expense resolver ghi category vào org khác

**Trạng thái:** CÒN MỞ
**Bằng chứng:** Migration mới nhất `supabase/migrations/20260728180000_income_expense_type_canonicalization.sql:944`; thân hiệu lực `supabase/baseline/schema.sql:87382-87454`. Đối số đầu **vẫn là `p_owner uuid` do client truyền**: `:87382` `resolve_fixed_expense_type(p_owner uuid, p_category_key text)`. Org derive từ chính `p_owner`, không từ `auth.uid()`: `:87400` `v_organization_id := app_private.resolve_ie_type_org_for_user_v1(p_owner)` (thân `:36926-36962` đọc `profiles.organization_id` của `p_user_id`). **Không một dòng nào so `p_owner` với caller.** Ghi vào org đó: `:87445-87452`. Hàm phơi cho mọi user đăng nhập (`20260728180000:1023-1026` GRANT `authenticated`). `_v2(p_organization_id, p_category_key)` không tồn tại.

### FR024-C01 (P2) — R2 upload buffer body trước cap 8 MiB

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `infra/cloudflare-worker/src/index.ts:128-134` — `const buf = await req.arrayBuffer();` (`:129`) → `:130` `if (buf.byteLength > MAX_UPLOAD_BYTES)` → `:134` `env.FILES.put(key, buf, …)`. Buffer trước cap; pre-check `Content-Length` `:107-110` dính cùng bẫy chunked. Cap `:71` `MAX_UPLOAD_BYTES = 8 * 1024 * 1024`. `src/boundedBody.ts` không tồn tại (`src/` chỉ có `index.ts`). `infra/cloudflare-worker/package.json` chỉ có `deploy`/`dev`/`tail` — **không có `test` hay `typecheck`**; `tsconfig.json` có nhưng không script nào chạy ⇒ package này hiện không được gate nào canh.

### FR029-C01 (P2) — LLM proxy parse oversized JSON trước quota

**Trạng thái:** CÒN MỞ
**Bằng chứng:** `supabase/functions/llm-proxy/index.ts:220-225` `body = await req.json();` — không cap, không check `content-length`. Quota gate chỉ chạy sau đó (`:287` `admin.rpc('reserve_ai_usage', …)`), và giữa hai điểm còn `JSON.stringify(body.messages ?? []).length` (`:276`) serialize lại toàn bộ payload. Không có cap 512 KiB, không giới hạn 128 messages / 32 tools; cap duy nhất là `max_tokens ≤ 4096` (`:277`). Thư mục chỉ có `index.ts` — không `index.test.ts`, không `deno.json`.

### PANALYTICS-C01 (summary) (P2) — Summary RPC bỏ `view_analytics`

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902090518`: gate `app_private.pra_can_view_analytics_v1` (chủ dữ liệu · super admin · có `sale_phong.view_analytics` trong org của chủ), bỏ `is_admin()`. Dùng `authorized_scope_v3` (STABLE, không khoá) để 7 hàm giữ `STABLE` — tránh 25006. Đo prod: 7/7 hàm có gate mới, 0 hàm còn owner heuristic; chủ công ty vẫn xem được. _(sáng ghi: CÒN MỞ)_
**Bằng chứng:** Bản **mới nhất** là `supabase/migrations/20260831023938_pra_errors_v2_nhom_loi.sql:268` `CREATE OR REPLACE FUNCTION public.pra_summary(...)`, `:295` `LANGUAGE sql STABLE SECURITY DEFINER`, gate ở `:321-322` `e.owner_id = ANY (public.current_visible_owner_ids()) OR public.is_super_admin() OR public.is_admin()`. Vẫn là **owner heuristic**, không phải `authorize_tenant_action_v3(..., 'sale_phong.view_analytics', ...)`; không `lock_org_for_decision_v1`; vẫn `STABLE` (plan đòi `VOLATILE` để khoá org được). Key `sale_phong.view_analytics` tồn tại trong catalog (`20260713110100_sprint2b_seed_permission_definitions.sql:37`) nhưng **không hàm pra_ nào dùng** (grep `view_analytics` trong `supabase/migrations/*.sql` chỉ ra đúng 1 hit — chính dòng seed).

### PANALYTICS-C01 (time-series) (P2) — Time-series RPC bỏ `view_analytics`

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902090518`: gate `app_private.pra_can_view_analytics_v1` (chủ dữ liệu · super admin · có `sale_phong.view_analytics` trong org của chủ), bỏ `is_admin()`. Dùng `authorized_scope_v3` (STABLE, không khoá) để 7 hàm giữ `STABLE` — tránh 25006. Đo prod: 7/7 hàm có gate mới, 0 hàm còn owner heuristic; chủ công ty vẫn xem được. _(sáng ghi: CÒN MỞ)_
**Bằng chứng:** `supabase/migrations/20260621100100_public_room_analytics_reports.sql:85` `pra_timeseries`, `:100` `STABLE SECURITY DEFINER`, gate `:111-112` cùng owner heuristic. Không được định nghĩa lại ở migration 31/08 ⇒ đây là bản hiệu lực.

### PANALYTICS-C01 (top rooms) (P2) — Top-rooms RPC bỏ `view_analytics`

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902090518`: gate `app_private.pra_can_view_analytics_v1` (chủ dữ liệu · super admin · có `sale_phong.view_analytics` trong org của chủ), bỏ `is_admin()`. Dùng `authorized_scope_v3` (STABLE, không khoá) để 7 hàm giữ `STABLE` — tránh 25006. Đo prod: 7/7 hàm có gate mới, 0 hàm còn owner heuristic; chủ công ty vẫn xem được. _(sáng ghi: CÒN MỞ)_
**Bằng chứng:** `supabase/migrations/20260621100100_public_room_analytics_reports.sql:133` `pra_top_rooms`, `:152` `STABLE SECURITY DEFINER`, gate `:162-163` owner heuristic. Không có bản mới hơn.

### PANALYTICS-C01 (funnel) (P2) — Funnel RPC bỏ `view_analytics`

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902090518`: gate `app_private.pra_can_view_analytics_v1` (chủ dữ liệu · super admin · có `sale_phong.view_analytics` trong org của chủ), bỏ `is_admin()`. Dùng `authorized_scope_v3` (STABLE, không khoá) để 7 hàm giữ `STABLE` — tránh 25006. Đo prod: 7/7 hàm có gate mới, 0 hàm còn owner heuristic; chủ công ty vẫn xem được. _(sáng ghi: CÒN MỞ)_
**Bằng chứng:** `supabase/migrations/20260621100100_public_room_analytics_reports.sql:186` `pra_funnel`, `:199` `STABLE SECURITY DEFINER`, gate `:207-208` owner heuristic. Không có bản mới hơn.

### PANALYTICS-C01 (token) (P2) — Token analytics RPC bỏ `view_analytics`

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902090518`: gate `app_private.pra_can_view_analytics_v1` (chủ dữ liệu · super admin · có `sale_phong.view_analytics` trong org của chủ), bỏ `is_admin()`. Dùng `authorized_scope_v3` (STABLE, không khoá) để 7 hàm giữ `STABLE` — tránh 25006. Đo prod: 7/7 hàm có gate mới, 0 hàm còn owner heuristic; chủ công ty vẫn xem được. _(sáng ghi: CÒN MỞ)_
**Bằng chứng:** Bản mới nhất `supabase/migrations/20260831023938_pra_errors_v2_nhom_loi.sql:378` `pra_by_token`, `:396` `STABLE SECURITY DEFINER`, gate `:419-420` owner heuristic. Migration 31/08 có `REVOKE … FROM PUBLIC, anon` (`:455`) — siết ACL, **không** thêm kiểm quyền nghiệp vụ.

### PANALYTICS-C01 (errors) (P2) — Error analytics RPC bỏ `view_analytics`

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902090518` (gồm cả hàm mới `pra_error_groups` phát sinh sau scan): gate `app_private.pra_can_view_analytics_v1` (chủ dữ liệu · super admin · có `sale_phong.view_analytics` trong org của chủ), bỏ `is_admin()`. Dùng `authorized_scope_v3` (STABLE, không khoá) để 7 hàm giữ `STABLE` — tránh 25006. Đo prod: 7/7 hàm có gate mới, 0 hàm còn owner heuristic; chủ công ty vẫn xem được. _(sáng ghi: CÒN MỞ)_
**Bằng chứng:** Bản mới nhất `supabase/migrations/20260831023938_pra_errors_v2_nhom_loi.sql:46` `pra_errors`, `:73` `STABLE SECURITY DEFINER`, gate `:102-103` owner heuristic. Cùng file còn thêm hàm **mới** `pra_error_groups` (`:156`, `:181` STABLE, gate `:207-208`) mang y nguyên khuyết tật ⇒ bề mặt finding **rộng thêm một hàm** so với bản scan 12/08.

### PANALYTICS-C02 (P2) — Anonymous analytics logger tăng trưởng không giới hạn

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902091449`: ngân sách 5.000 dòng/token/ngày (giờ VN) qua `app_private.public_room_event_budgets` kiểm TRƯỚC khi ghi và kẹp batch theo hạn mức còn lại; retention 90 ngày (`app_private.pra_prune_public_room_events_v1`, sàn 30 ngày) chạy bằng cron `41 3 * * *`. Đo prod sau apply: cron active=1, logger có budget, anon vẫn ghi được trong hạn mức, 16.329 dòng giữ nguyên (dữ liệu cũ nhất 73 ngày nên lần prune đầu xoá 0). _(sáng ghi: CÒN MỞ)_
**Bằng chứng:** `supabase/migrations/20260831023937_public_room_events_ghi_loi_ben_vung.sql` chỉ vá **độ bền ghi** (sub-transaction mỗi dòng `:74-120`) và clamp metadata (`:78-88`); **không** thêm budget, **không** thêm retention. ACL anon còn nguyên: `:138` `GRANT EXECUTE ON FUNCTION public.log_public_room_events(text, jsonb) TO anon, authenticated`. Giới hạn duy nhất là per-request `:69` `WHERE t.ord <= 50` — không có trần số request/token nên anon lặp lời gọi để ghi vô hạn dòng. `app_private.public_room_event_budgets` = 0 hit; Edge `supabase/functions/public-room-events/` không tồn tại; không có cron/retention 90 ngày.
**Ghi chú ACL:** `:137` `REVOKE … FROM PUBLIC` **không** cắt `anon` trên Supabase (án lệ đã ghi sổ) — và ở đây `:138` cấp lại `anon` tường minh ngay dòng sau, nên đây là chủ ý, không phải sót.

### PCOMPAT-C01 (P1) — Pending voucher authorize building cũ, ghi scope mới

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902082004` _(bản re-anchor sáng 02/09 ghi: CÒN MỞ)_
**Bằng chứng:** Migration mới nhất `supabase/migrations/20260730100000_ie_meta_write_hardening.sql:159`; thân hiệu lực `supabase/baseline/schema.sql:67614-67782`. Authorize theo scope **CŨ**: `:67644` đọc `v_row` trước, rồi `:67683` `ie_can_edit_money_axis_v1(v_row.organization_id, v_row.building_id)`. Ghi scope **MỚI** không tái kiểm: `:67738` `building_id = … v_clean->>'building_id'`; `building_id` nằm trong `v_money_keys` (`:67624`) nên client patch được. Kèm theo `room_id/tenant_id/contract_id/invoice_id/shareholder_id` (`:67739-67743`) cũng ghi không kiểm org. Helper `STABLE` `app_private.ie_can_edit_money_axis_v1` vẫn được dùng làm quyết định (đúng thứ plan cấm), và **không** có `lock_org_for_decision_v1` — chỉ `FOR UPDATE` trên hàng phiếu (`:67644`).
**Fix đề xuất:** `CREATE OR REPLACE` cho `ie_compat_update_pending_v2(uuid,jsonb,jsonb)` (chữ ký không đổi ⇒ không cần DROP): pre-read chỉ lấy org/lock key → `PERFORM app_private.lock_org_for_decision_v1(v_target_org)` → tính scope **cuối** bằng `COALESCE(p_patch.field, current.field)` cho building/room/tenant/contract/invoice/account → kiểm mọi quan hệ cùng `v_target_org` → gọi `authorize_tenant_action_v3(auth.uid(), v_target_org, 'income_expenses.edit', v_target_building, v_target_account)` **hai lần** (scope cũ và scope mới), deny nếu một trong hai trượt. Bỏ hẳn `ie_can_edit_money_axis_v1` khỏi đường quyết định. **Rủi ro: TRUNG BÌNH** — chỉ siết thêm; ca hợp lệ (sửa phiếu trong cùng toà) không đổi. Cần regression cho ca đổi toà hợp pháp của người có quyền cả hai toà.

### PMETER-C01 (single) (P1) — Anonymous single meter approval

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902082002` REVOKE anon + `_v1` vào migration + denylist _(bản re-anchor sáng 02/09 ghi: CÒN MỞ)_
**Bằng chứng:** Thân hiệu lực `supabase/migrations/20250130000004_meter_reading_rpc_functions.sql:21-47` — chỉ kiểm `status`/`deleted_at`, **không** kiểm user/building/org. **Không một dòng GRANT/REVOKE nào** trên hàm này trong `supabase/migrations/`; migration duy nhất chạm tới là `20260601000100_sec_contract_rpc_authz_and_anon_revoke.sql:182` và nó chỉ `ALTER FUNCTION … SET search_path` — cùng file đó revoke anon cho contract RPC ở `:50-52,89-91,124-126,166-168`, tức meter bị **bỏ sót có hệ thống**. Catalog live (`contracts/surfaces/rpc-surface.json`, sinh 02/09, 1017 hàm) ghi `approve_meter_reading` → `securityDefiner: true`, `execRoles: ["anon","authenticated","service_role"]`. Bản vá `approve_meter_reading_v1` **có** authz thật nhưng chỉ tồn tại ở `scripts/authz-prepared/prod-snapshot/PS04_rbac_org_meter_threshold.sql:1473-1491` (script chạy tay), không có migration tương ứng. Hook đi đường an toàn nhưng **có fallback**: `src/hooks/useMeterReadings.ts:548-551` gọi `approve_meter_reading_v1`, gặp `PGRST202` thì rơi về legacy.
**Fix đề xuất:** migration forward hai việc, rẻ: (1) `REVOKE ALL ON FUNCTION public.approve_meter_reading(uuid) FROM PUBLIC, anon;` và thêm chữ ký vào `denylist` của `scripts/definer-acl-baseline.json`; (2) đưa định nghĩa `approve_meter_reading_v1` từ `scripts/authz-prepared/` **vào một migration thật** để bản khôi phục từ baseline không dựng ra DB thiếu `_v1` (nếu thiếu, hook tự động rơi về legacy không authz — đúng kịch bản tệ nhất). Sau khi `_v1` có migration, bỏ nhánh fallback ở `useMeterReadings.ts:549-551`. **Rủi ro: THẤP** — anon không phải caller hợp lệ của luồng duyệt chỉ số; hook luôn có JWT.

### PMETER-C01 (bulk) (P1) — Anonymous bulk meter approval

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — migration `20260902082002` REVOKE anon + `_v1` vào migration (giữ partial-success — đổi all-or-nothing để PR riêng) _(bản re-anchor sáng 02/09 ghi: CÒN MỞ)_
**Bằng chứng:** Thân hiệu lực `supabase/migrations/20250130000004_meter_reading_rpc_functions.sql:58-74` — một `UPDATE meter_readings … WHERE id = ANY(p_reading_ids) AND status='UNAPPROVED' AND deleted_at IS NULL`, **không authorize theo building/org/user**, không lặp từng reading. Catalog live: `execRoles: ["anon","authenticated","service_role"]`. Không có REVOKE trong migrations (chỉ `20260601000100:184` set `search_path`). Bản `_v1` (`scripts/authz-prepared/prod-snapshot/PS04_rbac_org_meter_threshold.sql:1495-1512`) authorize từng reading **nhưng nuốt lỗi**: `exception when insufficient_privilege then null;` rồi `return v_n` ⇒ batch trộn org A/B cho **partial success**, không reject nguyên transaction như plan yêu cầu. Hook: `src/hooks/useMeterReadings.ts:581-584` cùng khuôn fallback PGRST202.
**Fix đề xuất:** như single, cộng thêm: khi đưa `bulk_approve_meter_readings_v1` vào migration, **đổi `exception when insufficient_privilege then null` thành RAISE** để một deny làm rollback cả batch; thêm trần `c_max_readings_per_call = 200`; lấy distinct org UUID tăng dần rồi `lock_org_for_decision_v1` theo đúng thứ tự đó. **Rủi ro: TRUNG BÌNH** — đổi từ partial-success sang all-or-nothing là **thay đổi hành vi người dùng nhìn thấy** (trước đây duyệt được phần hợp lệ, nay cả lô trượt); cần báo trước và cần UI nói rõ dòng nào chặn.

### PZALO-C01 (send) (P1) — Forged queue gửi qua account khác

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — guard worker `scope-guard.js` (bước 1/3) _(bản re-anchor sáng 02/09 ghi: CÒN MỞ (đã thu hẹp về **trong-org**, chưa đóng))_
**Bằng chứng:** Grant DML cho `authenticated` **vẫn còn và chưa từng bị revoke**: `supabase/migrations/20260626000001_zalo_chat_schema.sql:224-226` cấp `SELECT, INSERT, UPDATE, DELETE` trên cả 6 bảng `zalo_*` gồm `zalo_send_queue`; grep `REVOKE.*zalo_send_queue` toàn bộ migrations = **0 hit**. Policy `zalo_send_queue_owner_all` đã bị DROP (`20260813100000:248`) nhưng thay bằng `_org_write` **`FOR ALL`** (`:258-262`, action `send`) + RESTRICTIVE `_org_boundary` (`:222-226`) ⇒ browser role **vẫn DML thẳng vào queue được**, chỉ bị chặn ở biên tenant (nhờ trigger fail-closed `app_private.autofill_org_zalo()` `:141-158`). Worker **không** revalidate: không có `validateZaloCommandScope` (grep = 0); `worker/lib/queue.js:147-149` claim nguyên tử rồi `:158` tin thẳng `payload.thread_id`, `:206` `sendText`. ⇒ user có `chat_zalo.send` tự INSERT job với `account_id` **bất kỳ trong công ty** và `payload.thread_id` **tuỳ ý**.
**Fix đề xuất:** ba lớp, làm theo thứ tự. (1) *Worker trước* (không cần migration, đảo được ngay): thêm `validateZaloCommandScope(job)` trong `worker/lib/queue.js` **sau** claim `queued→processing` và **trước** mọi lời gọi provider — join lại `job → account → conversation → message`, kiểm `account.organization_id = conversation.organization_id = job.organization_id` và `payload.thread_id = conversation.thread_id`; trượt thì `REJECTED_SCOPE` + audit, không gọi provider. (2) *Enqueue RPC*: migration additive tạo `zalo_send_message_v2(...)` derive toàn bộ khoá ngoại từ row đã khoá. (3) *Containment*: `REVOKE INSERT, UPDATE, DELETE ON public.zalo_send_queue FROM authenticated;` và đổi `_org_write` từ `FOR ALL` thành chỉ `SELECT` — **chỉ sau** khi (2) deploy và client hết ghi thẳng. **Rủi ro: bước (1) THẤP và giá trị cao nhất** (thuần worker, rollback bằng deploy lại); bước (3) CAO nếu làm sớm — hai hook `src/hooks/chat-zalo/useZaloConversationActions.ts:62-66` và `useZaloMedia.ts:118` đang **đọc** queue để poll job, phải giữ một SELECT policy tối thiểu, nếu không sẽ chết luồng tìm SĐT và gửi media.

### PZALO-C01 (react) (P1) — Forged queue reaction qua account khác

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — guard worker `scope-guard.js`: target_msg_id phải thuộc hội thoại của account _(bản re-anchor sáng 02/09 ghi: CÒN MỞ (trong-org))_
**Bằng chứng:** Cùng cơ chế queue như trên (grant `20260626000001:224-226` chưa revoke, `_org_write` FOR ALL `20260813100000:258-262`). Payload `{action:'react', target_msg_id, thread_id}` do client tự đặt; `worker/lib/queue.js:167-170` gọi `s.api.addReaction(...)` với `String(p.thread_id)` / `p.target_msg_id` mà **không** kiểm chúng thuộc `job.conversation_id` hay org của `job.account_id`.
**Fix đề xuất:** cùng `validateZaloCommandScope` của PZALO-C01/send, thêm nhánh riêng: `target_msg_id` phải tồn tại trong `zalo_messages` của đúng `job.conversation_id`. **Rủi ro: THẤP** (thuần worker).

### PZALO-C01 (recall) (P1) — Forged queue recall qua account khác

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — guard worker `scope-guard.js`: chỉ tin OUT của chính job.user_id _(bản re-anchor sáng 02/09 ghi: CÒN MỞ (trong-org))_
**Bằng chứng:** `worker/lib/queue.js:171-174` — `s.api.undo({ msgId: p.target_msg_id, cliMsgId: p.target_cli_msg_id }, String(p.thread_id), type)`: thu hồi theo `msgId` thô trong payload, không đối chiếu `zalo_messages` hay org. Forge job vẫn khả thi trong org (cùng grant/policy như trên).
**Fix đề xuất:** như trên, và guard phải kiểm thêm quyền recall của **actor gốc** (`job.user_id`), không chỉ sự tồn tại của message. **Rủi ro: THẤP** (thuần worker).

### PZALO-C01 (history) (P1) — Forged queue lấy history khác scope

**Trạng thái:** **ĐÃ VÁ 02/09/2026** — guard worker `scope-guard.js`: chỉ nhóm đã biết, thread từ conversation, count kẹp 1..200 _(bản re-anchor sáng 02/09 ghi: CÒN MỞ (trong-org) — **và đây là đường vòng qua bản vá FR009-C03**)_
**Bằng chứng:** `worker/lib/queue.js:175-179` — `getGroupChatHistory(String(p.thread_id), p.count)` rồi `upsertMessagesForThread(job.account_id, job.user_id, p.thread_id, 'group', …)`: kéo lịch sử **bất kỳ nhóm nào** account đang đăng nhập thấy được và ghi vào DB, chỉ dựa vào `thread_id` trong payload forge được. Worker lấy job không lọc quyền: `worker/index.js:84-88` chỉ lọc `channel/status/not_before` (`ORG_FILTER` là biến vận hành, không phải authz). RPC `zalo_load_history` đã vá (FR009-C03) nhưng **không chặn được** đường này vì client ghi thẳng queue.
**Fix đề xuất:** guard phải ép `p.thread_id = conversation.thread_id` của `job.conversation_id` và `conversation.thread_type = 'group'`; clamp `p.count` về `1..200`. **Rủi ro: THẤP** (thuần worker). Ưu tiên cao nhất trong 4 ca PZALO-C01 vì nó vô hiệu hoá một bản vá đã tồn tại.

### PZALO-C02 (P1) — Zalo send RPC target conversation tenant khác

**Trạng thái:** **ĐÃ VÁ**
**Bằng chứng:** Bản hiệu lực `supabase/migrations/20260813110000_zalo_gui_media_va_idempotency.sql:117-215` (chữ ký 8 đối số). Derive org từ conversation, không tin tham số: `:141-148` `SELECT * INTO v_conv FROM public.zalo_conversations WHERE id = p_conversation_id;` → `IF NOT public.zalo_can('send', v_conv.organization_id) THEN RAISE … 42501`. `zalo_can(text,uuid)` là RBAC v3 thật (`20260813100000:111-117` → `zalo_authorized_org_ids` = `my_org_ids()` ⨯ `app_private.authorized_scope_v3`, `:86-96`). Mọi dòng sinh ra đóng dấu `v_conv.organization_id` (`:170`, `:210`). ACL không anon: `contracts/surfaces/rpc-surface.json` → `execRoles: ["authenticated","service_role"]`, củng cố bởi `20260813140000_zalo_rpc_revoke_public.sql:31` + nghiệm thu `:69-83`. Vá bởi commit `cb88a8d7` + chuỗi migration Zalo 13/08.
**Dư lượng (không đủ để mở lại finding):** không gọi `lock_org_for_decision_v1` (hàm có tồn tại — `supabase/baseline/schema.sql:15506`) ⇒ còn khe TOCTOU giữa đọc và ghi, không phải lỗ cross-tenant.

### S49 (P2) — Cashbook report/Copilot bỏ `cashbooks.view`

**Trạng thái:** CÒN MỞ (nửa Copilot đã vá, nửa hook chưa)
**Bằng chứng — nửa ĐÃ vá:** `src/copilot/tools/nghiepVuTools.ts:222` khai `requiredPermission: { module: 'cashbooks', action: 'view' }` và `:230` gọi `copilot_cashbook_settlement_v2` (org-scoped, revoke anon tại `20260828160000_copilot_server_scope_v2.sql:184` và `20260829090000_copilot_org_scope_semantics_v1.sql:285`; legacy `copilot_cashbook_settlement_v1` bị revoke tại `20260829060000_copilot_cashbook_legacy_acl_v1.sql:6`).
**Bằng chứng — nửa CÒN MỞ:** `src/hooks/useSettlementReport.ts:70` vẫn gọi RPC legacy `cashbook_settlement_report({ p_from, p_to })` — **không truyền organization**, query key `:67` `['settlement-report', from, to]` **không có org**. Thân hàm hiệu lực `supabase/migrations/20260704100000_accounts_is_virtual.sql:81-159` chỉ kiểm `auth.uid()` (`:81`) rồi lọc bằng owner heuristic `public.is_super_admin() OR a.user_id = auth.uid() OR public.same_team(a.user_id)` (`:92`, `:158-159`) — **không** `cashbooks.view`, **không** `authorized_scope_v3`, không tham số org. Đúng thứ Task 9 Bước 4 cấm ("Không dùng `same_team`, owner heuristic hoặc route permission làm authorization thay thế"). Caller UI: `src/pages/reports/finance/BanGiaoReport.tsx`.

---

## 3. Hàng đợi fix — CÒN MỞ xếp P1 → P3

### P1 — 12 finding (làm trước, không xen kẽ P2)

| # | Finding | Nơi hở | Chi phí / rủi ro |
|---:|---|---|---|
| 1 | `PZALO-C01/history` | `worker/lib/queue.js:175-179` | Thấp — thuần worker, **vô hiệu hoá lại bản vá FR009-C03 nếu không làm** |
| 2 | `PZALO-C01/send` | `worker/lib/queue.js:147-158,206` + grant `20260626000001:224-226` | Thấp (bước worker) / Cao (bước revoke grant) |
| 3 | `PZALO-C01/react` | `worker/lib/queue.js:167-170` | Thấp — cùng guard với #1,#2 |
| 4 | `PZALO-C01/recall` | `worker/lib/queue.js:171-174` | Thấp — cùng guard |
| 5 | `PMETER-C01/single` | `20250130000004:21-47`; ACL anon | Thấp — một `REVOKE` + đưa `_v1` vào migration |
| 6 | `PMETER-C01/bulk` | `20250130000004:58-74`; partial-success ở `_v1` | Trung bình — đổi sang all-or-nothing là đổi hành vi UI |
| 7 | `FR009-C04` | `20260720181000:245-262`; ACL anon | Thấp (revoke anon) / Trung bình (v2 đổi ABI) |
| 8 | `FR009-C05` | `20260720181000:155,308` | Trung bình–Cao — **đổi số tiền lương**, phải hỏi chủ |
| 9 | `PCOMPAT-C01` | `baseline/schema.sql:67683` vs `:67738` | Trung bình — `CREATE OR REPLACE`, không đổi chữ ký |
| 10 | `FR002-C01` | `baseline/schema.sql:93190` | Thấp–Trung bình — thêm điều kiện chặn |
| 11 | `FR001-C03` | `20260731110000:82,154-155`; `luckyDrawApi.ts:251` | Cao — đường ghi tiền do anon gọi |
| 12 | `FR002-C02` | `20260822093000:101-103,180` | Cao — đường tiền thanh lý, cần reconcile hai đầu |

**Thứ tự khuyến nghị:** #1→#4 trước (một guard worker duy nhất đóng cả bốn, rẻ nhất, rollback bằng deploy lại), rồi #5→#7 (mỗi cái một `REVOKE` một dòng), rồi #9→#10, cuối cùng #8, #11, #12 (ba cái đụng tiền — mỗi cái một PR riêng, kèm `reconcile-money`).

### P2 — 25 finding

`FR001-C01`, `FR001-C04`, `FR003-C01`, `FR009-C01`, `FR009-C02`, `FR011-C01`, `FR011-C02`, `FR011-C03`, `FR011-C04`, `FR016-C01`, `FR017-C01`, `FR018-C01`, `FR020-C01`, `FR020-C02`, `FR023-C01`, `FR024-C01`, `FR029-C01`, `PANALYTICS-C01` ×6 (summary · time-series · top-rooms · funnel · token · errors), `PANALYTICS-C02`, `S49`.

Ba cụm gom được thành một PR mỗi cụm: **(a)** 6 `PANALYTICS-C01` + `PANALYTICS-C02` (cùng họ `pra_*` / logger, nhớ cộng thêm hàm mới `pra_error_groups` phát sinh sau scan); **(b)** `FR011-C01..C04` + `S49` + `FR020-C02` (đều là "báo cáo dùng owner heuristic / thiếu org binding"); **(c)** `FR003-C01` + `FR024-C01` + `FR029-C01` (cùng anti-pattern buffer-trước-cap, cùng helper `readBoundedBody`).
Hai cái rẻ nhất và độc lập: `FR020-C02` (đổi một lời gọi `can_v3` → biến thể có org, `20260725190000:224`) và `FR001-C01` (bỏ `to_jsonb(rms)`, dựng allowlist).

### P3 — 8 finding

`FR001-C02`, `FR001-C05`, `FR003-C02`, `FR003-C03`, `FR005-C01`, `FR014-C01`, `FR015-C01`, `FR018-C02`.

Gom: `FR003-C02` + `FR003-C03` (một `readBoundedUtf8Response` dùng chung, một package, đã có `test`/`typecheck` sẵn); `FR014-C01` + `FR015-C01` + `FR018-C02` (một migration hằng số cardinality/byte + `src/lib/financeInputLimits.ts`); `FR001-C02` + `FR001-C05` (cùng vòng đời capability công khai). `FR005-C01` đứng riêng và **rẻ nhất toàn bảng** — checkbox đã có sẵn ở UI, chỉ thiếu adapter storage.

---

## 4. Khoảng trống xác minh

Bản re-anchor này là **soi tĩnh trên mã nguồn + migration + hai artifact sinh từ catalog live**. Chưa làm, và cần làm trước khi coi bất kỳ finding nào là đóng:

1. **Chưa chạy mutation testing** (`scripts/dot-bien.mjs` có tồn tại nhưng chưa dùng cho tập finding này) ⇒ chưa chứng minh test nào đỏ đúng lý do bảo mật.
2. **Chưa chạy role-real trên DEMO/TEST** — không có `scripts/test-security-remediation.mjs` để chạy. Mọi kết luận "attacker làm được X" là suy luận từ mã, chưa có PoC thật.
3. **ACL production đọc từ snapshot 23/08** (`scripts/definer-acl-baseline.json`) cộng với việc **không có migration REVOKE nào sau đó** cho các hàm liên quan (đã grep toàn bộ `supabase/migrations/*.sql` từ `20260823` tới HEAD). `contracts/surfaces/rpc-surface.json` (sinh 02/09 từ catalog live, 1017 hàm) xác nhận lại `execRoles` cho meter và salary. Vẫn nên đo lại bằng một truy vấn read-only trước khi hành động.
4. **Drift nguy hiểm đã phát hiện:** các bản vá `approve_meter_reading_v1` / `bulk_approve_meter_readings_v1` **chỉ tồn tại trong `scripts/authz-prepared/`** (script chạy tay bằng psql), không có migration. Nghĩa là dựng lại DB từ `supabase/baseline/` + migrations sẽ ra một database **không có `_v1`**, và hook sẽ tự động rơi về nhánh fallback legacy không authz (`src/hooks/useMeterReadings.ts:549-551`, `:582-584`). Đây là rủi ro độc lập với chính finding.
5. **Chưa chạy E2E** (`FLEET_PASS_*` chưa nạp trong phiên này) và chưa chạy `node scripts/measure-org-leak.mjs` / `scripts/clone-org/snapshot.mjs after`.
6. **`infra/cloudflare-worker` hiện không được gate nào canh** — `package.json` thiếu script `test`/`typecheck`, nên `FR024-C01` không có lưới an toàn hồi quy dù có sửa.

---

## 5. Việc cần làm ngay với chính tài liệu

- Thêm banner vào đầu `docs/superpowers/plans/2026-08-12-security-remediation.md` trỏ sang file này, và sửa dòng "HEAD đã đi 128+ commit" thành 190.
- Cân nhắc đưa vào `denylist` của `scripts/definer-acl-baseline.json` các chữ ký đang bị allowlist che: `approve_meter_reading(uuid)`, `bulk_approve_meter_readings(uuid[])`, `salary_work_ledger(date,uuid)`, `lucky_save_payout_v1(text,jsonb)` — **sau** khi REVOKE, vì `check-definer-acl.mjs:107-113` từ chối `--update` khi denylist đang hở.
- Thêm file này vào số đếm tài liệu: chạy `npm run gate:truoc-push -- --khong-dao-strict` để `gate:doc-counts` và `gate:docs-views` tự cập nhật (nhớ án lệ: đếm tài liệu chạy **sau** `git add`).
