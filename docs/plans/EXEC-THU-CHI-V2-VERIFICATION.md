# TỔNG KIỂM & HOÀN THIỆN Thu Chi V2 — Kế hoạch thực thi (2026-07-23)

> Lệnh owner: kiểm tra TOÀN BỘ plan (code + data + hành vi) → sửa → test browser → lặp tới khi
> xong hết. **Định nghĩa "XONG" = đã verify bằng Playwright trên bản deploy, đường bấm thật.**
> Trạng thái 3 mức: 🟢 browser-verified · 🟡 test-verified (unit/DB) · 🔴 built-chưa-kiểm / thiếu.

## Vòng 1 — 3 fix chặn nghiệp vụ (đang chạy)

| # | Việc | Phương pháp verify | Trạng thái |
|---|---|---|---|
| F1 | Dialog **Duyệt / Duyệt-và-Chi** kích hoạt (root-cause đã khoanh: wiring page) | Dev local instrument → fix → Playwright cả 2 nhánh trên prod | 🔴 → đang debug |
| F2 | Báo cáo lợi nhuận **gồm phiếu Chờ duyệt** (§2.3) + dòng đếm riêng + bỏ "phiếu nháp" | Playwright: số tổng đổi đúng khi có pending; counter hiện | 🔴 |
| F3 | Badge composite §12.1 ở danh sách + inbox 2 nút + mobile parity | Playwright desktop + mobile viewport | 🔴 |

## Vòng 2 — Sượt §21 acceptance (từng dòng → test → fix → re-test)

### Nghiệp vụ/state (§21.1)
- [ ] Không còn "Nháp" toàn domain (🟡 sweep xong, cần browser-sượt các trang phụ: salary UI, ProfitVerificationBar)
- [ ] Tạo phiếu không đổi balance (🟢 verified — pending không vào tồn)
- [ ] **Duyệt không đổi balance** (🔴 chờ F1 — hiện luồng cũ vẫn auto-vào-sổ qua bridge)
- [ ] Duyệt-và-Chi atomic + rollback (🔴 chờ F1)
- [ ] Chi sau duyệt không cần quyền approve (🟡 RPC có; UI custodian-post chưa nối)
- [ ] Sửa/hủy pending (🟢 sau 4 hotfix); posted → reversal (🟡 RPC, chưa UI)

### Lợi nhuận (§21.2)
- [ ] Pending KQKD vào đúng kỳ + 1 lần (🔴 F2)
- [ ] Approve/post không nhảy P&L lần 2 (🟡 cần test browser sau F2)
- [ ] Close chặn pending + drill-down (🟡 blockers RPC có; close FROZEN — mục 4 owner)

### Sổ quỹ (§21.3)
- [ ] Balance = posting lines (🟢 25/25 khớp, reconcile-v2 PASS)
- [ ] Cash report theo posted_on (🟡 RPC v2 delegate; cần browser-check trang Dòng tiền)
- [ ] Retry/concurrency 1 posting (🟡 unique index + idempotency; cần test double-click)

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
