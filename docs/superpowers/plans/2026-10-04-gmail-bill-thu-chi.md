# Gmail bill → phiếu chi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Follow the Project Contract for one final independent review; implementation tasks own disjoint files.

**Goal:** Đọc Gmail Grab/Shopee và điền sẵn phiếu chi, chỉ lưu khi người dùng xác nhận.

**Architecture:** GIS token trong bộ nhớ → Gmail REST → parser bảo thủ → form thu chi hiện có → RPC claim bill và writer tiền atomic. Không đọc Gmail nền hoặc lưu token.

**Tech Stack:** React, TypeScript strict modules, Vitest, Supabase PostgreSQL, PGlite, Playwright.

## Global Constraints

- Người dùng chọn Gmail và phương án điền sẵn rồi bấm lưu.
- Mọi sửa đổi ở worktree `C:/Users/Nguyen Tam/codex-worktrees/gmail-bill-thu-chi`, nhánh `codex/gmail-bill-thu-chi` từ origin/main.
- Đọc PROJECT_CONTRACT trước sửa; không ghi org THẬT, không sửa generated types bằng tay.
- Không token/thư gốc trong browser persistence/log/server; không render HTML email.
- Chống trùng server atomic theo org + provider + receipt_id, cả retry và concurrency.
- Preview, tìm kiếm hoặc đóng màn hình không tạo phiếu. Luật tiền hiện hữu tiếp tục sở hữu việc duyệt/ghi sổ.
- Chỉ stage file cụ thể; root sở hữu Git index và gate tổng. Agent phụ không commit.

## Task 1: Gmail và parser (agent email_reader)

**Files:** tạo `src/lib/emailBills/types.ts`, `parser.ts`, `gmail.ts`, `googleAuth.ts` và `__tests__/*.test.ts`.

**Interfaces:**
```ts
export type BillProvider = 'grab' | 'shopee';
export interface EmailBillSource { provider: BillProvider; mailbox: string; message_id: string; receipt_id: string }
export interface EmailBill { source: EmailBillSource; subject: string; description: string; date: string | null; amount: number | null; text: string; warnings: string[]; blocked: boolean }
export interface GmailSession { accessToken: string; expiresAt: number }
// Gmail list exposes cursor and explicit individual failures, never false empty success.
export interface GmailBillPage { bills: EmailBill[]; nextPageToken: string | null; failedCount: number }
export function loadGoogleAuth(): Promise<void>;
export function authorizeGmail(clientId: string): Promise<GmailSession>;
export function readGmailProfile(session: GmailSession, signal?: AbortSignal): Promise<string>;
export function listGmailBills(session: GmailSession, mailbox: string, range: {from:string;to:string}, pageToken?: string, signal?: AbortSignal): Promise<GmailBillPage>;
```

- [ ] Viết test trước: total 85.000đ = 85000; tổng khác subtotal; không đoán số tiền/mã khi mơ hồ; mã phải ổn định; spoof `grab.com.evil.test` bị loại; hủy/hoàn bị chặn; HTML không tải nguồn ngoài; multipart/plain ưu tiên tránh nhân đôi; Gmail 401 khác empty, pagination cursor giữ nguyên.
- [ ] Chạy `npx vitest run src/lib/emailBills/__tests__` và ghi bằng chứng đỏ vì chức năng chưa có.
- [ ] Triển khai đúng giao diện trên, có timeout/abort/expiry, OAuth popup lỗi rõ ràng, script load single-flight, load trước cú bấm authorize để giữ user gesture. Query sender domains phải thống nhất parser; kiểm token scope thiếu trước khi gọi Gmail.
- [ ] Chạy lại tests; lưu biên nhận vào `.superpowers/sdd/gmail-bill-thu-chi/task-1-report.md`.

## Task 2: Claim nguồn bill và writer atomic (agent email_writer)

**Files:** migration do `node scripts/tao-ten-migration.mjs gmail_bill_income_expense` cấp tên; `src/lib/__tests__/emailBillImportMigration.test.ts`.

**Interfaces:**
```sql
public.create_income_expense_from_email_v1(p_organization_id uuid, p_source jsonb, p_voucher jsonb, p_items jsonb) returns jsonb
-- result {id: uuid, created: boolean}; p_source = EmailBillSource.
public.get_imported_email_bills_v1(p_organization_id uuid, p_sources jsonb) returns jsonb
-- result [{provider: 'grab'|'shopee', receipt_id: string, imported: boolean}]. No hidden voucher details.
```
`p_voucher` chỉ nhận trường form: type (EXPENSE), name, building_id, room_id, tenant_id, contract_id, payer_name, receive_bank_account, receive_bank_name, account_id, attachments, business_result_accounting, voucher_date. Items theo CreateIncomeExpenseInput (income_expense_type_id, description, quantity, unit_price, start_date, end_date). Gọi `create_income_expense_v1` với stable key của nguồn; không fallback quyền, không raw INSERT vào phiếu. Scope kiểm bằng authorize_tenant_action_v3 và can_access_building; validate cả replay.

- [ ] Viết PGlite harness với authenticated role/JWT stub; tải migration thực và canonical writer spy transaction; test unauthenticated, cross-org/building, malformed source/items, create, replay, changed payload conflict, rollback khi writer lỗi, lookup chỉ org được quyền, direct registry write bị từ chối.
- [ ] Chạy test đỏ trước triển khai; triển khai migration idempotent cùng RLS sandbox policy theo Contract, immutable nguồn, unique identity, function VOLATILE, search_path/ACL/owner rõ.
- [ ] Chạy xanh; không apply production. Ghi biên nhận và ghi rõ concurrency Postgres TEST chưa có nếu chưa kiểm.

## Task 3: UI và typed boundary (root)

**Files:** `src/lib/emailBills/importRpc.ts`, `src/hooks/useEmailBillImport.ts`, `src/components/income-expenses/EmailBillImportDialog.tsx`; sửa Form, mutation/types, desktop/mobile page. Thêm UI/hook tests.

**Interfaces:** form nhận `emailBillSource?: EmailBillSource` và `defaultPrefill` thêm `voucher_date?: string`; hook create nhận optional `email_bill_source`, chuyển tới RPC mới duy nhất khi có nguồn. UI chọn hạng mục trước để prefill items; tòa/sổ vẫn người dùng chọn. Stable source qua việc sửa form không bị reset/replay vào nguồn khác.

- [ ] Test UI kết nối thiếu config, tìm/lỗi, xem thư, chọn bill, cancel không ghi, điền amount/date/name nhưng không tự chọn tòa/sổ; double click save bị khóa. Hook test nguồn gửi đúng RPC, failed transport giữ khả năng retry cùng nguồn, không fallback ordinary create khi lỗi.
- [ ] Triển khai UI lazy, chỉ hiện theo quyền tạo, clear token/data khi đóng/logout/đổi org, abort requests cũ; hiển thị thư bằng text, link Gmail domain cố định và mailbox encoded.
- [ ] Form onSaved quay lại list và đánh dấu nhập thành công sau receipt validated. Các trường thiếu/blocked không được tiếp tục.
- [ ] Chạy tests cục bộ và test form hiện có.

## Task 4: Cấu hình, E2E và giao hàng (root)

**Files:** CSP Vercel thêm Google origins tối thiểu; docs engineering cấu hình Gmail; .e2e-fleet spec cho luồng mới; manifest/test surfaces nếu cần.

- [ ] Cấu hình `VITE_GMAIL_CLIENT_ID` công khai, consent screen/test users/authorized origins và giới hạn hỗ trợ email trong tài liệu. Không tạo OAuth secret hoặc chép vault.
- [ ] E2E headless với Gmail transport kiểm soát + role TEST khi sẵn, theo dõi console; Gmail OAuth live cần tài khoản cấp quyền, ghi giới hạn riêng.
- [ ] Stage migration để provenance generate; chạy gate tổng, build/bundle, reconcile v1/v2, mutation invariant chống trùng. Không mở rộng baseline để né lỗi.
- [ ] Review độc lập trên final diff và biên nhận gate; sửa phát hiện, re-review phần sửa. Fetch/rebase, commit có trailer Codex; draft PR theo Contract nếu gate và credentials cho phép. Không merge/promote khi chưa đạt.

## Tiến độ

Thiết kế đã chốt theo lựa chọn Gmail + phương án 1 của người dùng. Các yêu cầu cần Google Cloud OAuth hoặc mẫu email thật là điều kiện kiểm chứng triển khai, không chặn viết và kiểm thử độc lập.
