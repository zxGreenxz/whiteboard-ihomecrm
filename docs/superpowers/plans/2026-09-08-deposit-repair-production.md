# Sửa phân loại cọc và phát hành tiền thối — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute the checklist without further approval pauses: the user explicitly requested planning, implementation and production deployment on 08/09/2026.

**Goal:** Hoá đơn giữ đúng cọc sau mọi lần sửa; các khoản đã thu bị phân loại sai được điều chỉnh có audit; tiền thối thực tế và báo cáo bỏ qua hoạt động trên production.

**Architecture:** Bảo toàn `accounting_class` xuyên suốt form → typed hook → writer. Sửa phép đọc cọc theo hạng mục thực tế, dùng migration riêng để điều chỉnh dữ liệu đã chứng minh bằng lịch sử. Triển khai writer trước frontend, đối chiếu cash trước/sau và kiểm người dùng thật trong DEMO.

**Tech Stack:** React/RHF/Zod, TypeScript, Vitest/Playwright, Supabase PostgreSQL/Management API, Vercel.

## Global Constraints

- User đã cho phép thực hiện và đưa production; không cần hỏi lại về lựa chọn kỹ thuật hoặc triển khai đã yêu cầu.
- Tổ chức thật `aaaa0000-0000-4000-8000-000000000001`: chỉ điều chỉnh cohort có bằng chứng qua migration đã review và lane có backup. Mọi truy vấn khám phá chỉ đọc. DEMO `dddd0000-0000-4000-8000-000000000001` dùng fixture tự rollback/dọn.
- Không tăng/giảm tiền thực thu, tạo phiếu thu trùng, tự duyệt hoa hồng hoặc bỏ điều kiện 7 ngày. Phòng305 vẫn chờ mốc12/09;505 còn thiếu74.000đ và chờ14/09.
- Tên hiển thị không thay cho phân loại kế toán. Không suy `DEPOSIT` chỉ từ chữ “cọc”. Giữ phạm vi tổ chức/toà, khoá hoá đơn, trạng thái được sửa, idempotency và kỳ đã chốt.
- Worktree riêng từng tác vụ; base tích hợp PR55. Migration xin timestamp bằng allocator, stage trước provenance. Không sửa migration đã triển khai.
- Bí mật lấy từ vault chính lúc chạy; không ghi vào git/log. Không dùng production DML ngoài lane đã review. Sao lưu đầy đủ trước apply; không bỏ gate để đạt production.

## Task 1 — Form và boundary giữ cọc

**Files:** `src/types/invoice.ts`, `src/hooks/useInvoices.ts`, `src/components/invoices/EditInvoiceDialog.tsx`, các form tạo/sửa dùng chung cần parity; tests dưới `src/components/invoices/__tests__/` và `src/hooks/__tests__/`.

**Interface:** `accounting_class?: 'REVENUE' | 'DEPOSIT' | 'NON_PNL'` trên `InvoiceItem`/`InvoiceFormItem`; schema hiện có NON_PNL nên phải bảo toàn cả lớp này. Trả trường trong projection, giữ trong decomposition và gửi `p_items[].accounting_class` trong canonical và fallback. Hạng mục mới chọn “Tiền cọc” tạo `type:'OTHER', accounting_class:'DEPOSIT'`; lựa chọn doanh thu mới là REVENUE, không dò tên tự do.

- [ ] Chuyển reproduction notes-only đã đỏ thành regression: item đầu vào OTHER/DEPOSIT2.200.000, chỉ đổi ghi chú, payload phải giữ class/name/amount.
- [ ] Kiểm xóa/thêm lại bằng lựa chọn Tiền cọc; sửa số tiền; dòng doanh thu bình thường; giữ phân loại qua hook và fallback; không tự biến dòng có chữ cọc thành DEPOSIT.
- [ ] Sửa type/projection/schema/decompose/payload/selector; truy vết mọi callsite dùng cùng hook tạo và sửa để không còn đường mất metadata.
- [ ] Kiểm rendering vẫn rõ tên, không hiện thuật ngữ kế toán cho người thu; chạy test/strict và mutation bỏ class để xác nhận regression đỏ.
- [ ] Commit explicit files và gửi review package.

```ts
expect(submitted.items.find(i => i.description === 'Tiền cọc'))
  .toMatchObject({ type: 'OTHER', accounting_class: 'DEPOSIT', unit_price: 2200000 });
```

## Task 2 — Writer và nguồn tính cọc

**Files:** migration mới cấp bởi `node scripts/tao-ten-migration.mjs invoice_deposit_classification`; `scripts/test-invoice-deposit-classification.mjs`.

**Interface:** Giữ chữ ký `update_invoice_v1`/writer tạo và JSON `p_items`; đọc/lưu/validate accounting_class. Client cũ thiếu trường không được âm thầm hạ DEPOSIT: bảo toàn từ nguồn hiện có khi nhận diện duy nhất; trường hợp mơ hồ phải từ chối trước thay đổi. `contract_deposit_sources_v1`/`resolve_signed_contract_deposit_basis_v1` tính phần cọc của phiếu gộp, không lấy cả tổng phiếu.

- [ ] Lấy định nghĩa live, ghi precondition digest; dùng probe DEMO hiện có làm RED cho notes-only và explicit DEPOSIT.
- [ ] Test class không hợp lệ, cross-org/toà, invoice đã thanh toán, dữ liệu cũ thiếu field, deposit/new revenue, nhiều dòng trùng tên gây mơ hồ.
- [ ] Patch writer nhỏ nhất, giữ toàn bộ guard/lock của bản live; kiểm writer tạo dùng cùng JSON để không còn đường mất cọc.
- [ ] Tái hiện basis phòng505 bằng DEMO: holding2m + mixed receipt8m có deposit2.926m phải netHeld4.926m, không10m. Kiểm standalone cọc, partial, reversal/refund/forfeit, cancelled/unapproved và liên kết không đếm đôi.
- [ ] Apply migration hai lần trong DEMO rollback; role authenticated; kiểm mutation bỏ trường/đếm toàn phiếu bị bắt; commit migration và harness riêng.

```sql
-- In a DEMO transaction after update_invoice_v1(...):
SELECT accounting_class, amount FROM public.invoice_items
WHERE invoice_id = fixture_invoice_id AND description = 'Tiền cọc';
-- Required: DEPOSIT | 2200000, for both explicit and compatible legacy payloads.
```

## Task 3 — Điều chỉnh các khoản lịch sử đã chứng minh

**Files:** migration mới `repair_invoice_deposit_classification_history` (allocator), `scripts/test-invoice-deposit-history-repair.mjs`, evidence kế toán đã lọc PII dưới `docs/audits/`.

**Input:** audit `2026-09-08-commission-deposit-classification.json` và probe. **Output:** đúng classification invoice/payment-voucher items, các tổng dẫn xuất cọc/KQKD và ghi chú hoa hồng; cash/posting tổng/số phiếu không đổi. Migration repeat-safe và ràng buộc ID + org + before amounts/classes + audit event.

- [ ] Đọc lại cohort hiện tại và dòng ledger/đóng kỳ/thanh lý. Cohort đã biết: INV-2026-00802 (501/102LVT2.2m),00823 (305/80DS3 1.6m),00622 (102/102LVT3.9m, đã thanh lý),00598 (203/111PVC3.6m). Không mở rộng chỉ dựa tên.
- [ ] Thiết kế điều chỉnh bằng cơ chế lifecycle/audit hiện có, không tắt trigger chung. Nếu cần helper one-off, scope exactcohort + actor và rút execute public/anon; không mở đường sửa tiền tuỳ ý.
- [ ] Khôi phục cọc dựa audit trước khi mất class, phân bổ lại phần PNL/DEPOSIT của phiếu tương ứng; bảo toàn gross/net/change, trạng thái, ngày và sổ. Đối chiếu nghĩa vụ thanh lý/refund trước khi recompute hợp đồng đã thanh lý.
- [ ] DEMO clone cấu trúc tối thiểu từng loại; chạy trước/sau/repeat, assert cash không đổi, tổng hạng mục bằng phiếu, không trùng receipt/deposit, settlement/refund không đổi ngoài reclassification; rollback mọi fixture.
- [ ] Khóa/preconditions trước backfill, ghi bằng chứng before/after bền vững, kiểm migration chạy lại không đổi. Review độc lập trước apply thật.

```ts
expect(after.cashByAccount).toEqual(before.cashByAccount);
expect(after.receiptCount).toBe(before.receiptCount);
expect(after.deposit501).toBe(4200000);
expect(after.deposit305).toBe(3600000);
expect(after.deposit505).toBe(4926000);
```

## Task 4 — Tích hợp và review

- [ ] Cherry-pick từng deliverable đã review vào PR55; cập nhật docs và tên PR theo phạm vi cuối, giữ lịch sử review.
- [ ] Rebase origin/main; conflict máy sinh lấy main rồi generate; chạy 119 rounding tests cùng regression cọc, strict/noUnchecked, ESLint ratchet, build và bundle.
- [ ] Kiểm tương tác Thu tiền/Hoá đơn và sửa ghi chú trong browser headless; test quyền/billing period/collector report. Role thật DEMO, không fixture trên org thật.
- [ ] Chạy graph freshness/impact/detect-changes, migration/provenance/unknown-review, catalog guards, reconcile-money v1/v2 và cross-review SQL/frontend/history riêng.
- [ ] Đọc CI PR55, sửa gate đỏ thuộc thay đổi; điều tra catalog drift có bằng chứng thay vì ghi đè snapshot cho xanh.

## Task 5 — Triển khai và xác minh production

- [ ] Chốt reviewed SHA sạch và backup lane; kiểm project/org/environment đúng. Kiểm bản dump đọc được, đủ dữ liệu và có manifest/digest. Nếu guard backup lỗi, điều tra nguyên nhân, không bỏ qua.
- [ ] Apply lần lượt migration chống mất cọc + nguồn tính cọc, tiền thối/báo cáo, rồi history repair qua `npm run migrate:forward <file> --apply`; mỗi lần ghi evidence và pre/post catalog.
- [ ] Sau apply, regenerate types/provenance/surfaces/catalog/unknown-review cho đúng live; các generated changes commit và gate lại.
- [ ] Kiểm RPC qua HTTP và hai kết nối DEMO cùng invoice: chỉ một lần thu được tính, stale/retry trả kết quả đúng; cleanup fixtures.
- [ ] Push main theo authorization hiện tại, chờ đầy đủ gate CI/preview xanh rồi promote production đúng SHA. Không tính skipped/continue-on-error là pass.
- [ ] Xác minh domain production phục vụ SHA mới; truy vấn READ ONLY:5014.2m/3053.6m/5054.926m, cảnh báo cọc đúng, các điều kiện khác giữ nguyên; đối chiếu cash/KQKD trước/sau, report bỏ qua và hoàn tác DEMO.
- [ ] Báo người dùng mã phát hành, số chứng từ đã điều chỉnh, vị trí báo cáo và kết quả đối chiếu. Nếu còn blocker thực tế, báo chính xác trạng thái đã/chưa triển khai thay vì tuyên bố hoàn tất.

## Execution ledger

- 08/09/2026: user authorizes detailed plan, implementation and production; PR55 contains completed rounding feature. Deposit cause proven by live READ ONLY audit + two DEMO rollback scenarios; no deposit fix or production apply yet.
- 08/09/2026: user selects GPT-6 Astra Medium; implementation agents handed off existing worktrees to fresh agents explicitly configured with that model/effort. Backup preflight full519 TABLE DATA entries,28.9MB, no excludeddata, manifest outsidegit. Rounding restore-drill exposed omitted writerACL reset; reproducedRED under rollback and patched explicitREVOKE/GRANT, fullrollbackmatrixGREEN.
