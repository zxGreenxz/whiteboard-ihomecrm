# TỔNG KIỂM & HOÀN THIỆN Thu Chi V2 — Kế hoạch thực thi (2026-07-23)

> Lệnh owner: kiểm tra TOÀN BỘ plan (code + data + hành vi) → sửa → test browser → lặp tới khi
> xong hết. **Định nghĩa "XONG" = đã verify bằng Playwright trên bản deploy, đường bấm thật.**
> Trạng thái 3 mức: 🟢 browser-verified · 🟡 test-verified (unit/DB) · 🔴 built-chưa-kiểm / thiếu.

## Vòng 1 — 3 fix chặn nghiệp vụ (đang chạy)

| # | Việc | Phương pháp verify | Trạng thái |
|---|---|---|---|
| F1 | Dialog **Duyệt / Duyệt-và-Chi** kích hoạt (root-cause: mapper thiếu org/status; +5 bug server 210000–240000, evidence sai tenant) | Playwright localhost cả 2 nhánh + DB assert + fixture tự dọn (commit 4c55ac8) | 🟢 **PROD** (dialog 2 nút mở trên ptcrm, read-only) |
| F2 | Báo cáo lợi nhuận **gồm phiếu Chờ duyệt** (§2.3) + dòng đếm riêng + bỏ "phiếu nháp" | Playwright: fixture 77k vào tổng+bảng; counter riêng; tie-out engine bảo toàn | 🟢 **PROD** (counter "15 phiếu chờ duyệt · thu 19,7tr · chi 112,6tr" live) |
| F3 | Badge composite §12.1 ở danh sách + inbox 2 nút + mobile parity | Playwright: desktop badge Chờ duyệt→Đã Duyệt-Chưa Chi→Đã Chi; mobile tag parity; inbox "Duyệt và Chi…" live (RPC +organization_id 250000) + request tự đóng (a87 260000) | 🟢 **PROD** (badge "Đã Thu" thay "Đã vào sổ" trên org thật) |

> **Finding V2-PRE-1 (pre-existing, KHÔNG do FIX 2):** tie-out engine chia cổ đông lệch
> thu −16.062.882 / chi −743.000 ở 8 toà (102LVT, 111PVC, 1392QT, 158PVC, 15KV, 162NVK,
> 32PVC, 331PHI) — đo y hệt trên baseline HEAD (APPROVED-only) lẫn sau FIX 2 → client
> accrual vs fa_accrual_allocations lệch từ trước. Điều tra ở Vòng 2 (§21.2).

## Vòng 2 — Sượt §21 acceptance (từng dòng → test → fix → re-test)

### Nghiệp vụ/state (§21.1)
- [ ] Không còn "Nháp" toàn domain (🟡 ProfitVerificationBar đã bỏ "phiếu nháp"; còn salary UI)
- [x] Tạo phiếu không đổi balance (🟢 verified — pending không vào tồn)
- [x] **Duyệt không đổi balance** (🟢 F1 — token FINANCE_V2_LIFECYCLE + bridge skip, 240000)
- [x] Duyệt-và-Chi atomic (🟢 F1 — POSTED + line MAIN + evidence ATTACHED + balance đúng)
- [ ] Chi sau duyệt không cần quyền approve (🟡 RPC có; UI custodian-post chưa nối)
- [ ] Sửa/hủy pending (🟢 sau 4 hotfix); posted → reversal (🟡 RPC, chưa UI)

### Lợi nhuận (§21.2)
- [x] Pending KQKD vào đúng kỳ + 1 lần (🟢 F2 local — fixture 77k vào bảng+tổng, counter riêng)
- [x] Finding V2-PRE-1: lệch engine pre-existing (🟢 **FIXED, browser "Khớp engine
      ±0 ✓"**). Hai nguồn, cộng khớp TỪNG ĐỒNG (−17.276.000 + 1.213.118 = −16.062.882):
      1. RPC kiểm chứng (fa engine/layer stats, SECURITY DEFINER) với
         p_building_ids=NULL quét MỌI building user thấy — gồm cả org DEMO
         (thu 17,3tr / chi 743k) trong khi client chỉ xem org hiện hành.
         Fix: 2 trang truyền TOÀN BỘ toà org hiện hành khi không lọc.
      2. Client accrual lọc `is_deposit` thay `accounting_class='PNL'` → tính dư
         item CUSTOMER_CREDIT/INTERNAL (+1,2tr — vd "Tiền khách trả thừa").
         Fix: skipDepositItem + rowCounts ưu tiên accounting_class (fallback
         is_deposit cho item cũ null).
- [ ] Approve/post không nhảy P&L lần 2 (🟡 cần test browser sau F2)
- [ ] Close chặn pending + drill-down (🟡 blockers RPC có; close FROZEN — mục 4 owner)

### Sổ quỹ (§21.3)
- [ ] Balance = posting lines (🟢 25/25 khớp, reconcile-v2 PASS)
- [x] Cash report theo posted_on (🟢 prod "Tài khoản theo ngày" render, 0 console error, chuỗi tồn ngày liên tục khớp)
- [x] Retry/concurrency 1 posting (🟢 DB: ux_ie_postings_subject_generation UNIQUE(org,subject,generation) WHERE POSTING + ux idempotency + CAS posting_version; UI disable isSubmitting)

### Phân quyền (§21.4)
- [ ] CUSTODIAN/KNOWER đúng ma trận (🟢 cài đặt 2 danh sách + chặn KNOWER-chi verified)
- [ ] KNOWER: chỉ thấy phiếu thu mình tạo (🔴 list vẫn RLS legacy — cần route list_income_expenses_v2 hoặc policy CANONICAL; kiểm bằng tài khoản NATHAN)
- [ ] Admin RPC share-scope (🟢 dialog verified)

### Security/data (§21.5)
- [ ] Base tables không client-DML (🟢 Stage-7 applied + grep 0 raw)
- [ ] Audit --strict CLEAN (🟢) · view invoker (🟢) · delta lag 0 (🟢)
- [ ] E2E specs `.e2e-fleet/finance-*.spec.ts` (🔴 chưa viết — thay bằng Playwright MCP checklist, sẽ bổ sung spec)

## Vòng 3 — Nợ kiến trúc ghi nhận (không chặn vận hành, làm sau vòng 2)
- §11.3 hợp nhất: report đọc resolver server (hiện F2 dùng ALL_ACTIVE client-side khớp công thức)
- V5 per-tender lineage đầy đủ §6.2 (hiện bridge voucher-formula, parity đúng)
- resubmit tạo request engine mới; execution-queue UI; evidence-first posting UI
- Mục 4 owner: 52 unsafe locks + 22 phiếu kỳ khóa (profit_close đang FROZEN an toàn)

## Smoke checklist cố định (chạy trước MỌI push main)
1. Login owner → /income-expense: tạo phiếu chi → Chờ duyệt, tồn quỹ KHÔNG đổi
2. Duyệt → 2 nút; "Chỉ duyệt" → badge Đã Duyệt-Chưa Chi, tồn KHÔNG đổi
3. "Duyệt và Chi" → form ngày/sổ/ảnh → tồn đổi đúng sổ
4. Sửa pending OK; hủy OK; báo cáo lợi nhuận: pending có trong tổng + counter
5. Console 0 error đỏ

*Cập nhật trạng thái từng dòng ngay sau mỗi verify. File này là nguồn truth của đợt tổng kiểm.*
