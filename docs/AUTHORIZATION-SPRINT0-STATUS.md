# Sprint 0 (Containment) — Trạng thái triển khai AUTHORIZATION-PLAN.md

> Cập nhật: 2026-07-13. Đối chiếu live DB `tryymsxyyckgbrmmvozx` (chỉ đọc + apply migration qua Management API).
> Tài liệu nguồn: [AUTHORIZATION-PLAN.md](./AUTHORIZATION-PLAN.md). Đây là **Sprint 0** — containment các P0 mà plan gắn nhãn **GO WITH CHANGES**. Sprint 1–7 (organizations, RBAC chuẩn hoá, RLS v2, approval engine, hợp nhất write path, storage/edge hardening, cutover) là chương trình nhiều tháng, plan tự kết luận **NO-GO** nếu chưa có audit độc lập + maintenance window + dual-write + reconciliation. Xem mục "Còn lại" bên dưới.

## Bối cảnh quan trọng

- Đây là DB **production thật** (ptcrm.vercel.app), có ~1.665 phiếu thu/chi APPROVED (tiền thật). Mọi thay đổi Sprint 0 được chọn theo tiêu chí **đóng lỗ hổng fail-OPEN mà KHÔNG phá luồng đang chạy**.
- Live-state được **xác minh lại** (không tin snapshot cũ của plan) trước khi sửa.

## Đã làm & đã kiểm chứng

| # | Hạng mục (plan) | Thay đổi | Bằng chứng kiểm chứng |
|---|---|---|---|
| 0.1 | Fail-open `get_my_permissions` + bản sao `ai_copilot_perms_for` | Migration `20260713090000`: tạo `legacy_owner_allowlist` (bằng chứng owner TẠM, seed từ user sở hữu building hoặc là owner của staff_assignment) + đổi nhánh cuối 2 hàm sang **fail closed** (orphan ⇒ `{}`). | Impersonation test (JWT sub) trên hàm ĐÃ DEPLOY: `phanboichauthcs@gmail.com` (orphan, sở hữu 0 dữ liệu) ⇒ `{}`; `demo.chunha` (legacy owner thật: 2 toà + 6 staff) ⇒ sentinel. 5 owner khác không đổi. |
| 0.3/0.4 | Revoke EXECUTE cho helper nội bộ còn hở | Migration `20260713091000`: revoke `anon`+`authenticated`+`PUBLIC` cho `_internal_settlement_account`, `_termination_ensure_type` (2 P0 bỏ sót ở `20260710130500`) + 6 recompute helper; revoke `anon` (giữ `authenticated`) cho `approve_voucher`/`unapprove_voucher`. | Đã xác minh MỌI caller của 8 helper đều `SECURITY DEFINER` (trigger fn + RPC impl chạy dưới owner) ⇒ revoke không phá luồng. Live re-check ACL: 8 helper `anon=false auth=false`; 2 voucher `anon=false auth=true`. Test trigger trong ROLLBACK: UPDATE `income_expenses` bởi role `authenticated` vẫn fire recompute triggers, không lỗi quyền. `secdef_anon_exec` 110 → **100**. |
| 0.9 | Contain Cloudflare R2 Worker | `infra/cloudflare-worker/src/index.ts`: `/upload` giờ (1) lấy user id từ token, (2) chỉ cho ghi `room-sale-images/<own-uid>/…` (chặn bucket riêng tư + cross-user + tuỳ ý chọn key), (3) giới hạn 8MB + MIME ảnh, (4) chặn overwrite (`head` → 409). | Typecheck worker sạch. **Cần `wrangler deploy` để lên production** (xem "Bước deploy còn lại"). Chỉ `room-sale-images` route sang R2 (r2Config) nên không phá upload thật. |
| 0.10 | Khoá `api/salary-v5-cron.js` | Verify `Authorization: Bearer <CRON_SECRET>` constant-time (Vercel Cron tự gửi khi env set). Giữ GET (Vercel Cron dùng GET; ép POST sẽ phá cron thật). | Deploy qua push Vercel. Nếu `CRON_SECRET` chưa set → 500 (watchdog worker chạy bù, như cũ). |
| 0.2 | Đóng signup tự do + bỏ browser signUp provisioning | Edge fn `admin-create-user` mở rộng nhận đủ metadata (username/full_name/phone/contact_email/employee_code/department/job_title/is_active) — **đã deploy (v9)**. `useProvisionStaff` chuyển từ `supabase.auth.signUp` (đổi session, để orphan row) sang `functions.invoke('admin-create-user')`. Trang `/register` vốn đã là placeholder "đăng ký đã đóng"; `useRegister` là dead code. | Browser test (local dev + live DB): tạo staff `test-p0-cleanup` (mẫu Viewer) → toast "Đã tạo tài khoản nhân viên thành công", 0 console error; DB: auth user email-confirmed + profile + 1 assignment; `ai_copilot_perms_for` trả đúng quyền Viewer (KHÔNG `{}`, KHÔNG sentinel). Đã xoá test user. **`disable_signup` bật SAU khi frontend deploy** (xem bên dưới). |

### Kiểm chứng không hồi quy
- `scripts/test-cross-tenant.mjs`: **PASS** (OWNER/ADMIN/FULL-SCOPE staff, không rò xuyên tenant).
- `npx tsc --noEmit -p tsconfig.app.json` + `npm run typecheck:baseline`: **khớp baseline 32 fingerprint, 0 lỗi mới**.
- `npx vitest run`: **745/745 pass** (63 file).
- Tài chính không đổi: SUM `income_expenses` theo status giữ nguyên (EXPENSE APPROVED 649/4.675 tỷ, INCOME APPROVED 1.016/4.726 tỷ).

## Quyết định hoãn có chủ đích (không phá luồng live)

| # | Hạng mục | Lý do hoãn | Đích |
|---|---|---|---|
| 0.5 | `pay_draft_fee_voucher` account scope | Guard hiện tại `user_id=auth.uid() OR is_admin/super` là **fail-CLOSED** (an toàn, không phải lỗ hổng). Đích `authorize(cashbooks.post, account)` cần mô hình cashbook-scope chưa tồn tại. Nới lỏng sớm có thể TẠO lỗ hổng. | Sprint 5 |
| 0.6/0.11 | Chặn direct approval columns / `initial_amount`/`initial_date`/`user_id` / lock/archive | Đổi default `approval_status` hoặc block cột trên DB tài chính LIVE sẽ **phá ghi thu/chi và sửa sổ quỹ đang chạy**. Plan (deliverable 12) nói rõ: chưa có RPC atomic thì feature-flag/hoãn, KHÔNG half-block. Access-control để orphan/anon lạm dụng các path này **đã đóng** ở 0.1 + 0.3/0.4; policy ghi vẫn gate theo building-scope (user lạ không ghi được vào owner khác). | Sprint 4 (approval engine) + Sprint 5 (canonical RPC) |

## Bước deploy còn lại (thủ công)

1. **`wrangler deploy`** worker R2 (`infra/cloudflare-worker/`) — cần Cloudflare creds. Code đã hardened; chưa lên production tới khi deploy.
2. **Push main** → Vercel deploy frontend (`useProvisionStaff`) + `api/salary-v5-cron.js`.
3. **Bật `disable_signup=true`** (Management API `PATCH /config/auth`) — CHỈ sau khi frontend deploy xong (provisioning không còn phụ thuộc signup công khai). `auth.admin.createUser` không bị ảnh hưởng bởi cờ này.
4. (Tuỳ chọn) xác minh `phanboichauthcs@gmail.com` là ai; nếu cần quyền, cấp role tường minh thay vì để fail-open như trước.

## Sprint 1 — Organization foundation (ADDITIVE / INERT) — ĐÃ LÀM

Migration `20260713100000_sprint1_organization_foundation.sql`. Hoàn toàn additive + inert (không đọc/enforce; rollback = DROP cột/bảng):

- Tạo `organizations`, `organization_memberships` (partial-unique 1 active/user), `organization_invitations`, `legacy_owner_organization_map`, `authorization_migration_exceptions`. RLS: chỉ super_admin đọc, không client DML.
- Mô hình org (hệ thống là "một tổ chức cố định"; demo tách qua `demo_user_ids()`): **PROD** (`ihome-prod`) = mọi dữ liệu non-demo; **DEMO** (`ihome-demo`) = dữ liệu demo.
- Memberships seed: PROD — nguyentamca(OWNER), bosshuy(PARTNER), joey/nathan(STAFF); DEMO — demo.chunha(OWNER)+5 demo(STAFF). **phanboichauthcs (orphan): KHÔNG membership** (khớp fail-closed 0.1).
- Thêm cột `organization_id` **NULLABLE** + `UNIQUE(organization_id,id)` cho root tables `buildings/areas/accounts/roles`, backfill theo owner. GIỮ NULLABLE vì code INSERT hiện tại chưa set (ép NOT NULL sẽ phá tạo toà/sổ quỹ).

**Verify**: buildings 26/26, areas 7/7, accounts 50/50, roles 7/7 backfilled (0 null); 0 org-mismatch vs owner; 0 demo-building lọt org prod; cross-tenant harness PASS; tsc baseline 32 fp không đổi. Chưa deploy frontend (cột mới nullable, `SELECT *` cũ bỏ qua).

**Kế tiếp Sprint 3 (additive)**: rollout `organization_id` cho các bảng nghiệp vụ còn lại — org DERIVE từ parent (building), KHÔNG từ audit `user_id` (§16.2). Cột giữ nullable tới khi app set + trigger auto-fill; **RLS v2 cutover là ENFORCEMENT → NO-GO tự động** (cần staging + negative-test matrix + reconciliation).

## Còn lại — Sprint 2→7 (chương trình nhiều tháng, KHÔNG "big-bang" lên production)

Plan yêu cầu thứ tự **không đảo**: `explicit organization boundary → normalized authz + shadow compare → RLS v2 → approval engine → consolidate financial writes → Storage/Edge/ACL hardening → cutover + reconciliation`. Mỗi sprint cần precheck/postcheck/hash/count, dual-write shadow, negative-test matrix, và audit độc lập trước cutover (mục 16–20, 23–24 của plan). Đây là lý do plan tự kết luận **NO-GO** cho cutover multi-tenant/approval trong một lần. Sprint 0 (tài liệu này) là điều kiện tiên quyết đã hoàn tất; các sprint sau nên triển khai theo PR có artifact bắt buộc (mục 22) và maintenance window.
