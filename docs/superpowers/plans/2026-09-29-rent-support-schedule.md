# Kế hoạch triển khai lịch hỗ trợ tiền thuê và khấu trừ hoa hồng/thưởng

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nhập số tháng và mức hỗ trợ để thấy ngay tháng/kỳ hóa đơn tương ứng; khách được giảm từng tháng, còn toàn bộ cam kết do Sale chịu được khấu trừ một lần khi lập phiếu hoa hồng/thưởng sau ký.

**Architecture:** Máy chủ giữ lịch hỗ trợ theo tháng, nguồn quyền lợi được chi và sổ phân bổ bất biến; giao diện chỉ dựng xem trước, gửi ý định và hiển thị kết quả được máy chủ xác nhận. Giảm hóa đơn và khấu trừ nguồn chi là hai sổ liên quan nhưng độc lập: một bên theo tháng hưởng của khách, một bên thu đủ cam kết ngay khi lập phiếu. Mọi đường tạo hóa đơn/phiếu/lương phải dùng cùng nguồn phân bổ để không trừ hai lần.

**Tech Stack:** React, React Hook Form, Zod, TanStack Query, Supabase PostgreSQL/PostgREST, Vitest/PGlite, Playwright, DOCX template engine hiện có.

## Global Constraints

- Trạng thái 01/10/2026: Task1–9 và QA tích hợp Task10 đã hoàn tất, có review độc lập và bằng chứng TEST phía cuối kế hoạch. Production đã áp dụng 8 migration additive qua forward lane, mỗi migration có backup và biên nhận; các gate tiền, catalog, types và gate trước push đạt. Draft PR101 đã mở trước tích hợp main. CI toàn bộ phát hiện test cũ chưa tương thích API mới và entry bundle vượt ngưỡng; đang sửa đúng các lỗi này, không miễn gate. **Ứng dụng hỗ trợ mới chưa phát hành production**, writer vẫn tắt; chỉ bật sau khi ứng dụng tương thích lên READY. Hotfix theo dõi lỗi thật đã phát hành riêng ở `ca3c8a0727346779b488c2a9d1f3bb032ba7472b` (PR95/96), bỏ inference backlog PR94; readonly smoke production8 PASS, queue UI0 lỗi trong phạm vi đã xem.
- Đọc `docs/engineering/PROJECT_CONTRACT.md` trước thực thi; phân loại money + authorization + migration trong `tooling/risk-map.json`, bắt buộc review độc lập và draft PR.
- Ghi dữ liệu thử chỉ DEMO hoặc project TEST; dữ liệu nghiệp vụ org THẬT chỉ đọc. Schema production chỉ qua forward lane có backup/biên nhận.
- Migration mới cấp tên bằng `node scripts/tao-ten-migration.mjs`; không sửa migration đã merge/deploy, không replay lịch sử legacy, không sửa generated types bằng tay.
- Không đổi ngầm cách tính tiền thuê/ngày, dịch vụ, cọc, credit, làm tròn, kỳ lương hoặc cách ghi nhận doanh thu.
- Không suy `APPROVED` là đã trả tiền; không coi số thực nhận bằng 0 là “không phát sinh”.
- Khấu trừ trước từ **hoa hồng** là mặc định; lựa chọn thứ hai là **thưởng trước, phần thiếu sang hoa hồng**. Không giữ lựa chọn cũ “chỉ trừ thưởng” vì đã bị yêu cầu mới thay thế.
- Toàn bộ hỗ trợ cam kết được khấu trừ ngay khi tạo phiếu sau ký; khách vẫn được giảm tiền trên các hóa đơn theo từng tháng. Đây là quyết định đã được người dùng xác nhận.
- Tháng đầu chưa tròn vẫn hưởng **đủ mức hỗ trợ đã thỏa thuận của tháng đủ điều kiện**, không nhân tỷ lệ số ngày ở.
- Quyền theo org/toà và miền tài chính; không thêm nhánh bypass super admin, không đưa chi tiết người nhận/ngân hàng vào lịch hỗ trợ.
- Trường hợp thiếu nguồn, dữ liệu legacy không rõ hoặc quyết định tài chính chưa chốt phải hiện việc cần xử lý; không tự tạo nợ Sale, không tự hoàn/chi tiền.
- Commit source/test theo từng task hoàn chỉnh, chỉ stage đường dẫn cụ thể; trailer `Co-Authored-By: Codex <noreply@openai.com>`.

---

## 1. Quyết định nghiệp vụ và điểm cần xác nhận

### Đã xác nhận

1. Nhập số tháng giảm phải lập tức nhìn thấy những tháng/kỳ tương ứng, trước khi bấm lưu.
2. Một hợp đồng có nhiều đoạn liên tiếp: **3 × 300.000đ từ 09–11/2026; 9 × 100.000đ từ 12/2026–08/2027**; tổng cam kết **1.800.000đ**.
3. Người chịu hỗ trợ là `BUILDING` hoặc `SALE`. Nếu toà chịu, không khấu trừ hoa hồng/thưởng của Sale.
4. Nếu Sale chịu, mặc định `COMMISSION_ONLY`, chỉ khấu trừ hoa hồng, không tự lấy thưởng bù thiếu. Lựa chọn thứ hai là `BONUS_THEN_COMMISSION`, khấu trừ thưởng trước rồi lấy phần còn thiếu từ hoa hồng.
5. Thu đủ cam kết một lần ở bước lập phiếu sau ký; không trừ lại theo mỗi hóa đơn tháng.
6. Tháng đầu lẻ ngày vẫn được giảm đủ mức hỗ trợ tháng; quy tắc này không thay đổi công thức tiền thuê lẻ ngày.

**Yêu cầu nhất quán suy ra từ hệ thống hiện hữu:** phiếu Sale qua cọc và hoa hồng quản lý qua sổ ảo/lương phải cùng tham gia nhận diện nguồn để tránh chi hoặc khấu trừ trùng. Đây là trách nhiệm thiết kế tích hợp.

### Chưa được phép tự quyết

| Điểm | Phương án an toàn trong thiết kế cho tới khi chốt | Điều kiện trước phát hành chức năng liên quan |
|---|---|---|
| Hỗ trợ tháng lớn hơn doanh thu đủ điều kiện trên hóa đơn đầu | Hiện `REVENUE_CAP_REVIEW`; không âm hóa đơn, không lấy tiền cọc/nợ cũ làm sức chứa, không làm biến mất phần cam kết | Chốt giữ phần còn lại ở đâu và ai phê duyệt; quy tắc “đủ tháng” không tự cấp phép ghi âm/credit |
| Khách trả sớm khi đã khấu trừ đủ 1,8 triệu nhưng chưa dùng hết lịch | Đưa phần chưa dùng vào `TERMINATION_REVIEW`; không hoàn Sale, không sửa hóa đơn đã hưởng, không đẩy sang nợ khách | Chốt có hoàn phần chưa dùng không, điều kiện và nguồn hoàn |
| Nguồn chi legacy chỉ lưu số đã trừ ròng | `LEGACY_REVIEW`, không suy gross từ net hoặc áp thêm 1,8 triệu | Đối chiếu gross/đã trừ/net với bằng chứng, người phê duyệt, đúng source ID |
| Sale chịu nhưng nguồn hoa hồng thuộc người nhận khác | `PAYEE_MISMATCH`; không lấy quyền lợi của người khác chỉ vì cùng hợp đồng | Phải có danh tính người chịu và liên kết nguồn chi phù hợp hoặc quyết định riêng có quyền/lý do |
| Một invoice hiện chứa nhiều tháng nhưng chỉ có một `billing_month` | Giữ đúng tháng đủ điều kiện hiện có, hiển thị cảnh báo kỳ chưa biểu diễn đầy đủ; không nhân hỗ trợ với `payment_cycle` | Nếu cần một hóa đơn hưởng nhiều tháng, phải có các kỳ con server xác nhận và thống nhất cách phân bổ khoản thuê cho chúng |

Các điểm trên không chặn xây preview, schema hoặc test đọc. Chúng chặn thao tác tài chính phụ thuộc tương ứng; không phát hành với trạng thái giả “đã xử lý”.

**Việc kỹ thuật phải xác minh:** ánh xạ gross/withheld/net vào engine ghi sổ hiện hữu, review độc lập và đối chiếu tiền trước/sau. Không vừa giảm chi phí hoa hồng vừa ghi thêm thu hoàn hỗ trợ khiến lợi nhuận tăng hai lần. Đây là điều kiện kiểm chứng triển khai, không phải yêu cầu người dùng phê duyệt thêm một thiết kế kỹ thuật.

### Ví dụ để rà soát kết quả

Các số trong bảng là nghìn đồng; giả sử nguồn chưa trả, chưa bị giữ và cùng người hưởng hợp lệ.

| Người chịu / cách trừ | Hoa hồng / thưởng | Cam kết | Khấu trừ hoa hồng / thưởng | Thực nhận hoa hồng / thưởng | Kết quả |
|---|---:|---:|---:|---:|---|
| Toà chịu | 3.000 / 500 | 1.800 | 0 / 0 | 3.000 / 500 | Không khấu trừ Sale |
| Sale, chỉ hoa hồng | 3.000 / 500 | 1.800 | 1.800 / 0 | 1.200 / 500 | Thu đủ ngay khi lập phiếu |
| Sale, thưởng rồi hoa hồng | 3.000 / 500 | 1.800 | 1.300 / 500 | 1.700 / 0 | Thưởng được xử lý bằng hỗ trợ, không phải “không phát sinh” |
| Sale, chỉ hoa hồng | 1.500 / 500 | 1.800 | Chưa ghi | Chưa tạo phiếu ròng | Thiếu 300 ở nguồn được chọn; không tự lấy thưởng |
| Sale, thưởng rồi hoa hồng | 1.000 / 500 | 1.800 | Chưa ghi | Chưa tạo phiếu ròng | Thiếu 300 tổng nguồn; `NEEDS_REVIEW`, không tự tạo nợ |

Thưởng từ cọc đã trả có sức chứa khấu trừ bằng 0; chọn thưởng trước sẽ chuyển phần còn thiếu sang hoa hồng còn hợp lệ, không thu lại tiền đã trả bằng một lần khấu trừ ảo.

## 2. Mã nguồn hiện tại đã đối chiếu

| Nơi | Hành vi hiện tại / thay đổi cần nối vào |
|---|---|
| `src/components/contracts/contract-form/RentDepositSection.tsx` | Hai ô `discount_months` và `discount_amount_per_month`; thay phần nhập bằng các đoạn hỗ trợ + preview tháng/kỳ |
| `src/components/contracts/contract-form/useContractFormState.ts` | Default/reset/watch/hydrate và first-invoice preview đang dùng hai scalar; phải giữ tương thích form cũ |
| `src/components/contracts/contract-form/useContractSubmit.ts` | Gửi `contracts.discounts={months,amount_per_month}` và tạo first invoice; cần gửi schedule version rõ ràng |
| `src/lib/contractValidation.ts`, `src/types/contract.ts`, `src/hooks/useContracts.ts` | Kiểu form/hợp đồng/cập nhật lịch hiện tại |
| `src/lib/contractDrafts.ts`, `contractDraftEditor.ts`, `contractDraftApi.ts`, `contractSigning.ts`, `contractCreateRpc.ts` | Draft Zod strict, mapping, payload ký/tạo hợp đồng; thay đổi schedule phải tăng revision và xuất lại bản ký |
| `supabase/migrations/20260929010015_unified_contract_editor_draft_signing.sql` | Tham khảo allowlist/validator và mapping ký mới nhất; chỉ vá qua migration mới |
| `src/lib/firstInvoiceBuilder.ts` | `computeFirstBillingMonth`; `buildFirstInvoiceDiscount` hiện lấy một mức/tháng và cap theo REVENUE subtotal |
| `src/components/contracts/contract-form/FirstInvoicePreview.tsx` | Hiển thị hóa đơn đầu/kỳ được suy ra; cần tách hỗ trợ, credit và giảm khác |
| `src/lib/invoiceHelpers.ts` | `getContractDiscountSlot` đếm invoice còn sống, kể cả SETTLEMENT; không đủ làm nguồn lịch theo tháng |
| `src/lib/excelInvoiceRows.ts`, `src/hooks/invoices/useExcelInvoiceData.ts` | Đếm invoice rồi chọn slot, ghép credit vào giảm trừ; phải thay với quote theo contract + tháng/kỳ thực tế |
| `src/components/invoices/GenerateInvoiceDialog.tsx` | Autofill chỉ khi discount bằng 0; query key chưa có billing month, dễ giữ mức cũ khi đổi kỳ |
| `src/components/invoices/ExcelInvoiceDialog.tsx` | Đổi `billingMonth` sau tải dữ liệu có thể giữ discount cũ; phải invalidation/requote rõ ràng |
| `src/lib/invoiceEntry.ts`, `src/components/invoices/invoice-entry/useInvoiceEntry.ts` | Giá thuê dùng hệ quy tắc hiện có; không gộp việc thống nhất `/30` với việc thêm lịch hỗ trợ |
| `src/hooks/useInvoices.ts` | Tạo qua RPC canonical, còn fallback direct insert cho một số non-credit; schedule mới phải fail closed, không rơi về đường bỏ guard |
| `create_invoice_v1`, `update_invoice_v1` và đường tạo có credit | Sửa adapter server ở migration mới để tính phần hỗ trợ bằng lịch + claim; không tin `p_discount_amount` tự khai |
| `generate_invoices_for_building`, `generate_invoices_for_building_v2` | RPC còn hiện diện dù chưa thấy React caller trực tiếp; kiểm callers/cron/Edge/catalog trước khi bỏ hoặc bỏ qua |
| `src/lib/contractTemplateEngine.ts`, `contractTemplateCodes.ts` | Chỉ có `PROMOTION_MONTH` / `PROMOTION_PRICE_PER_MONTH`; lịch nhiều mức cần biến lịch/tổng/người chịu mới |
| `src/hooks/useCommissionVoucher.ts`, `src/components/contracts/CommissionVoucherModal.tsx` | Tạo broker và sale, gross hiện là amount gửi vào RPC; cần quote gross/withheld/net và thao tác bundle an toàn |
| `src/hooks/useSaleBonus.ts`, `app_private.sale_bonus_claims` | Thưởng từ phiếu cọc trước hợp đồng; cùng một quyền lợi với Sale khi cọc được nối vào hợp đồng |
| `src/hooks/useCommissionManager.ts`, `src/lib/__tests__/salaryCommissionManager.test.ts` | Chuyển hoa hồng quản lý qua sổ ảo/lương; không phải nguồn hoa hồng mới |
| `supabase/migrations/20260927155251_hoa_hong_quan_ly_so_ao.sql` | `commission_manager_links`, `salary_commission_inclusions(voucher_id,period_month)`, `salary_commission_meta_v1`, lock/unlock lương; tham khảo để vá bằng migration mới |
| `src/lib/contractCommissionFollowup.ts`, `src/hooks/useContractCommissionFollowup.ts`, `ContractCommissionFollowupPanel.tsx` | Theo dõi bền vững sau ký vừa phát hành; nối trạng thái funding review/net-zero, không thay bằng toast |

### Các ví dụ kỳ phải giữ nguyên

- Khoảng 20/09–05/10 có `billing_month=2026-09`; tháng đầu hưởng đủ 300.000đ nếu còn đủ doanh thu đủ điều kiện.
- Khoảng 28/09–31/10 có `billing_month=2026-10` theo `computeFirstBillingMonth`; preview phải hiện **10/2026**, không tự gọi đây là tháng 09.
- Chọn chu kỳ 3/6/12 tháng hiện không tự làm writer sinh 3/6/12 `billing_month` hoặc nhân tiền thuê. Chỉ tháng/kỳ con thực sự có trong yêu cầu invoice canonical mới được nhận hỗ trợ.
- Nếu người dùng muốn lịch bắt đầu tháng 09 nhưng kỳ đầu thực tế là tháng 10, phải hiện tháng 09 “chưa có kỳ hóa đơn đủ điều kiện”; không tự dời lịch hoặc ăn hai tháng hỗ trợ vào tháng 10.
- Hai yêu cầu cùng nhận hỗ trợ của một tháng không được hưởng hai lần. Giữ unique MONTHLY hiện có theo hợp đồng + tháng; không mở đường tạo MONTHLY thứ hai. SETTLEMENT/adjustment hợp lệ có hỗ trợ bằng 0 vẫn đi theo engine hiện hữu, không bị chặn chỉ vì tháng đó đã có claim.

## 3. Mô hình đề xuất và bất biến

### 3.1 Payload lịch version 2

Tạo `src/lib/rentSupport.ts`; Zod DTO dùng tiền decimal dạng chuỗi tại boundary, PostgreSQL dùng `numeric` hữu hạn. Không đổi chính sách làm tròn hiện hữu.

```ts
type BillingMonth = string; // YYYY-MM, có kiểm tháng 01..12
type Money = string;        // số hữu hạn không âm; parse/serialize tường minh
type SupportPlanInput = {
  version: 2;
  start_billing_month: BillingMonth;
  payer: 'BUILDING' | 'SALE';
  sale_party_id: string | null;
  deduction_policy: 'COMMISSION_ONLY' | 'BONUS_THEN_COMMISSION';
  collection_mode: 'UPFRONT_COMMITTED';
  segments: Array<{ month_count: number; monthly_amount: Money }>;
};
type SupportMonth = {
  billing_month: BillingMonth;
  agreed_amount: Money;
  invoice_period_label: string;
  eligibility: 'PLANNED' | 'ELIGIBLE' | 'UNMAPPED' | 'REVENUE_CAP_REVIEW';
};
type SourceQuote = {
  source_id: string; kind: 'COMMISSION' | 'BONUS';
  gross_original: Money; already_paid: Money; prior_withheld: Money;
  remaining_payable: Money; available_to_withhold: Money;
  current_withheld: Money; net_this_operation: Money;
  route: 'CASHBOOK' | 'MANAGER_PAYROLL';
};
type FundingQuote = {
  quote_hash: string; plan_revision: number; payload_hash: string;
  committed_total: Money; due_upfront: Money;
  sources: SourceQuote[]; unallocated: Money;
  state: 'READY' | 'NEEDS_REVIEW' | 'LEGACY_REVIEW';
  issues: Array<{ code: string; message: string }>;
};
```

- `buildSupportMonths(plan, billingContext)` trả 12 dòng ngay từ local form; RPC quote xác nhận server trước ghi.
- Mỗi tháng là một nghĩa vụ với số tiền thỏa thuận cố định; không lưu “tháng thứ mấy = count invoice”.
- `committed_total = SUM(agreed_amount)`; ví dụ chuẩn là 1.800.000đ.
- `invoice_support` khác `credit_applied` và `manual_discount`; tổng giảm hiển thị có thể cộng ba phần, nhưng audit/guard giữ riêng.
- Chi tiết ngày/kỳ con lấy từ canonical invoice request đã server xác nhận; `payment_cycle` chỉ là cấu hình kế hoạch, không chứng minh tháng đã được lập invoice.

### 3.2 Bảng mới, private và versioned

Tạo bằng migration mới do script cấp tên; không backfill hàng loạt trong migration cấu trúc.

| Bảng đề xuất | Cột/khóa chính và trách nhiệm |
|---|---|
| `app_private.contract_rent_support_plans` | `id,organization_id,contract_id,revision,payload,committed_total,payer,sale_party_id,deduction_policy,created_by,created_at,supersedes_id`; unique `(org,contract,revision)`; nội dung đã ký bất biến |
| `app_private.contract_rent_support_months` | `id,plan_id,organization_id,contract_id,billing_month,agreed_amount`; unique `(plan_id,billing_month)`; không sửa amount tháng đã có claim |
| `app_private.rent_support_invoice_claims` | `organization_id,contract_id,billing_month,support_month_id,invoice_id,invoice_revision,claimed_amount,version`; unique claim đang sống theo **`(organization_id,contract_id,billing_month)` xuyên mọi phiên bản lịch**; `support_month_id` chỉ trỏ snapshot bằng chứng; writer giữ/giải phóng trong transaction |
| `app_private.rent_support_invoice_events` | append-only `CLAIMED/APPLIED/RELEASED/REVERSED`, claim/source invoice IDs, before/after, request UUID, actor/reason; unique idempotency theo action |
| `app_private.rent_support_payout_sources` | economic `source_id`, org, payee identity, kind, entitlement version; gross snapshot có bằng chứng; trạng thái tiền thực tế đọc từ engine hiện hữu |
| `app_private.rent_support_source_aliases` | alias typed `(org,alias_kind,alias_id,period_key)` unique → `source_id`; liên kết hợp đồng/phiếu cọc/phiếu chi/kỳ lương, không dùng tên người hoặc ghi chú làm khóa |
| `app_private.rent_support_funding_operations` | plan revision + request UUID + payload hash, quote snapshot, trạng thái `READY/COMPLETED/NEEDS_REVIEW/LEGACY_REVIEW/REVERSAL_REVIEW`; kết quả lặp lại bất biến |
| `app_private.rent_support_withholding_events` | append-only `RESERVED/COMMITTED/RELEASED/REVERSED`; operation ID, source ID, amount, voucher/payroll linkage, actor/time/reason; không ghi thêm tiền mỗi tháng invoice |

Nếu người nhận Sale chưa có stable party ID, chỉ cho chọn danh tính miền hiện có được xác minh. Nếu repository chưa có danh mục bên nhận ngoài nhân sự, tạo registry tối thiểu được kiểm quyền trước writer; không khấu trừ bằng cách so `payer_name`/`recipient_name` tự do. Đây là điều kiện nhận diện nguồn, không phải lý do tự tạo người nhận mới.

Mọi FK nghiệp vụ có org trong quan hệ. Bảng private revoke PUBLIC/anon/authenticated/service_role, bật RLS để phòng cấp quyền nhầm; policy sandbox theo Contract. API tài chính kiểm contract view + financial view/write trong cùng toà; không mở raw SELECT. Reason có thể chứa số tiền, nên cùng quyền với chi tiết tài chính, như bài học PR94.

### 3.3 API có thẩm quyền máy chủ

Các tên mới dưới đây là giao diện đích thống nhất cho mọi task:

```sql
-- STABLE, không khóa/ghi; p_contract_id hoặc p_draft_id có thể NULL,
-- nhưng đúng một subject phải hiện diện và phải thuộc org/toà được cấp quyền.
quote_contract_rent_support_v1(
  p_organization_id uuid, p_contract_id uuid, p_draft_id uuid,
  p_payload jsonb, p_invoice_context jsonb, p_payout_context jsonb
) returns jsonb;

-- VOLATILE: chỉ dành thay đổi hợp đồng đã ký có revision/amendment hợp lệ.
revise_contract_rent_support_v1(
  p_organization_id uuid, p_contract_id uuid, p_expected_revision bigint,
  p_payload jsonb, p_reason text, p_request_id uuid
) returns jsonb;

-- VOLATILE: một request tạo/tiếp tục toàn bộ phân bổ nguồn và các phiếu cần có.
create_contract_payouts_with_support_v1(
  p_organization_id uuid, p_contract_id uuid, p_plan_revision bigint,
  p_quote_hash text, p_payload jsonb, p_request_id uuid
) returns jsonb;

-- STABLE, phân trang thực và tổng; không lấy trang đầu làm tổng.
read_contract_rent_support_v1(
  p_organization_id uuid, p_contract_ids uuid[], p_building_ids uuid[],
  p_offset integer default 0, p_limit integer default 50
) returns jsonb;
```

`p_payload` của payout gồm gross/recipient/account/date/attachments cho nguồn người dùng định tạo và source IDs đã tồn tại. Gross vẫn phải qua quy tắc quyền lợi và kiểm quyền hiện hữu; client không có quyền tự khai số cần trừ có hiệu lực. Server đọc plan revision, claims và thực trạng phiếu để tính lại. Quote là kết quả đọc với hash của dữ kiện; không tạo reservation hay lưu quote trong hàm STABLE. Writer kiểm lại hash sau khóa. Quote cũ, sai người hưởng/phạm vi, nguồn đã chi hoặc payload đổi cùng request trả conflict có mã rõ ràng, không fallback.

Không thêm một RPC tạo hóa đơn song song bỏ engine cũ. Tạo helper private `resolve_invoice_rent_support_v1(org,contract,invoice_id,billing_month,eligible_periods,expected_plan_revision,request_id)` và gọi bên trong canonical invoice writers, cả create/update/cancel/restore. API quote dùng cùng thuật toán thuần; writer tự tính lại sau khóa.

### 3.4 Phân bổ và khóa

```text
Đầu tiên kiểm payer/payee/policy và revision có được tiếp tục funding hay không.
required = committed_total - net_committed_withholding_for_same_funding_identity
required < 0 => NEEDS_REVIEW, không thu âm/hoàn tiền/cấn sang người khác.
Nếu payer=BUILDING: required_from_sale=0, không đụng source Sale.
COMMISSION_ONLY: chỉ xét available_commission; thiếu => NEEDS_REVIEW.
BONUS_THEN_COMMISSION: giữ min(required, available_bonus), rồi xét available_commission.
unallocated>0: không hoàn tất phân bổ/phiếu ròng, không tạo debt; giữ việc cần xử lý.
remaining_payable = gross_original - already_paid - prior_withheld
available_to_withhold = phần remaining_payable chưa bị khóa hoặc reservation khác
net_this_operation = remaining_payable - current_withheld
Kiểm mọi số không âm; nếu nguồn có reservation khác thì chờ/xử lý xong trước tạo phiếu.
```

- `already_paid` là tiền thực trả theo engine, khác `prior_withheld` là khấu trừ đã cam kết trước đó sau khi tính reversal hợp lệ. Không lấy `approval_status` để đo tiền đã chi, không đếm cùng khoản ở cả hai biến. Khi tăng phiên bản lịch tương thích, khoản khấu trừ của phiên bản trước vẫn được tính; không thu lại toàn bộ cam kết.
- Funding identity gồm org, hợp đồng, người chịu và danh tính người có quyền lợi bị giữ. Chỉ cộng khoản đã giữ cùng identity qua các revision hợp lệ. Đổi Sale A thành Sale B không dùng tiền đã giữ của A để xem B đã đóng; không cấn chéo danh tính.
- Sau khi đã funding, đổi người chịu/người hưởng/cách trừ hoặc giảm cam kết phải vào `NEEDS_REVIEW` với lý do funding/reversal; bảo toàn audit, chặn tính tiếp cho đến khi có điều chỉnh hợp lệ. Giảm 1,8 triệu xuống 900.000đ không tạo required âm, hoàn tự động hoặc khoản tín dụng cho người mới.
- Ví dụ nguồn gross gốc 3 triệu, đã trả 700 nghìn và đã giữ 300 nghìn: còn được chi 2 triệu. Lần này giữ thêm 500 nghìn thì phiếu ròng tối đa 1,5 triệu, không phải 2,5 triệu.
- `available_to_withhold` loại tiền đã chi, kỳ lương khóa/đã trả, khấu trừ đang có và reservation khác. Trường hợp chỉ thanh toán một phần quyền lợi phải có phần nguồn với ID/số tiền được engine xác nhận, không tự tạo một gross mới.
- Nếu tổng khả dụng chỉ 1,5 triệu: báo thiếu 300 nghìn; không tự ghi Sale nợ 300 nghìn và không phát hai phiếu khiến UI tưởng đã thu đủ.
- Thưởng qua cọc đã chi không còn khả dụng. `BONUS_THEN_COMMISSION` chuyển phần chưa đủ sang nguồn hoa hồng hợp lệ; nếu không đủ thì `NEEDS_REVIEW`.
- Khóa org theo giao thức authorization hiện có trước quyết định; khóa contract/plan revision, rồi economic sources theo thứ tự source UUID, rồi invoice/payroll rows theo thứ tự ổn định. Đối chiếu tất cả writer cũ dùng advisory `commission:` và khóa phiếu cọc; cần thống nhất thứ tự hoặc adapter trước khi bật luồng mới để tránh deadlock.
- Request identity: `(organization_id,actor_id,operation,request_id)` + hash toàn payload; cùng key/cùng payload trả cùng kết quả, khác payload trả PT409.
- Khóa riêng không đủ: thêm unique live claims/source aliases và kiểm tổng withholding không vượt source entitlement tại commit.
- Claim invoice phải duy nhất theo org + hợp đồng + tháng trên mọi phiên bản lịch. Đổi plan ID/revision không mở lại tháng đã hưởng; muốn điều chỉnh phải qua engine revision/adjustment có audit.
- Invoice create và claim tháng ở cùng transaction. Payout allocation và các phiếu cần tạo ở cùng transaction hoặc một operation có reservation bền vững, không để các RPC frontend rời rạc tự “chia trừ”. Ưu tiên một transaction server vì hai nguồn cùng chịu một cam kết.
- Số thực nhận 0: ghi trạng thái `SETTLED_BY_SUPPORT`, kết quả có gross/withheld/net và operation ID. Không tạo phiếu chi 0 trái guard hiện có, không gọi NOT_APPLICABLE.

### 3.5 Vòng đời và tương thích

- Lịch hưởng của khách gắn vào snapshot ký: đổi số tháng, mức tiền hoặc tháng bắt đầu làm tài liệu cũ không còn hợp lệ. Đổi cấu hình nội bộ về người chịu/cách cấn trừ tăng plan revision và có audit tài chính; quote cũ mất hiệu lực nhưng hash tài liệu khách chỉ thay đổi khi nội dung của khách đổi. Trước funding, không tự buộc xuất lại hợp đồng khách chỉ vì đổi nguồn cấn trừ. Sau funding, áp quy tắc review ở dưới.
- Với lịch đã funding, thay payer/payee/policy hoặc giảm tổng chỉ tạo đề nghị điều chỉnh cần xử lý. Không kích hoạt phân bổ mới hoặc sửa nghĩa vụ đã khấu trừ trong lúc chờ đối chiếu; tăng tổng cùng identity chỉ xét phần tăng sau khi amendment có hiệu lực.
- Với hợp đồng không có v2, giữ read adapter lịch cũ rõ nhãn `LEGACY`; không tự gán tháng dựa số invoice. Chuyển sang v2 phải có preview đối chiếu và request được kiểm quyền.
- Không overwrite `contracts.discounts` cũ thành một mức trung bình của nhiều đoạn. Với v2, field cũ chỉ giữ compatibility snapshot có marker version; mọi caller cũ phải bị chặn hoặc đã được nâng cấp, không được áp giảm lần hai.
- Cancel invoice giải phóng claim để invoice thay thế cùng tháng dùng lại; không tự giải phóng withholding upfront. Restore phải đòi lại cùng claim, conflict nếu tháng đã có invoice thay thế.
- Revise invoice đã trả tiền phải qua revision/adjustment engine hiện có; lịch hỗ trợ không cấp đường sửa trực tiếp số dư đã thu.
- Cancel/restore phiếu nguồn cấn trừ phải ghi reversal/claim tương ứng. Nếu hỗ trợ đã dùng hoặc lương đã chốt, chuyển review/compensating workflow; không xóa lịch sử hoặc tự lùi hóa đơn khách.
- Trả sớm ngừng tạo kỳ hưởng tương lai sau ngày/kỳ hiệu lực được xác nhận; phần cam kết đã thu nhưng chưa dùng chuyển review. Giữ nguyên các tháng đã hưởng và bằng chứng.
- Legacy netted vouchers: không suy từ notes, không trừ lại vì thiếu event mới. Cho khai báo reconciliation có nguồn/chứng từ/actor/reason/gross/previous_withheld/net, hai số tiền phải đối chiếu engine trước mở tiếp.

## 4. Các giai đoạn bàn giao

1. **Lịch và xem trước:** Task 1–2 và phần preview của Task 4. Đọc được dữ liệu cũ, nhập lịch và xem kỳ ngay; chưa bật ký hợp đồng v2 hoặc writer tài chính khi các guard chưa tích hợp đủ.
2. **Một luồng hoàn chỉnh:** Task 3–6, nối form → snapshot ký → lịch invoice → khấu trừ toàn cam kết → phiếu ròng. Chạy trên TEST/DEMO sau cờ chức năng; không phát hành từng writer có đường bỏ kiểm soát.
3. **Các nguồn và vòng đời:** Task 7–9, bao phủ Sale qua cọc, lương quản lý, hủy/khôi phục, đối chiếu legacy và hàng đợi xử lý. Chỉ cho phép thao tác đã có đầy đủ kiểm soát; nghiệp vụ chưa chốt giữ `NEEDS_REVIEW` kèm mã lý do.
4. **Phát hành có bằng chứng:** Task 10. Schema additive trước ứng dụng; chỉ bật writer v2 khi tất cả đường liên quan đã dùng cùng guard, kiểm quyền thực và đối chiếu tiền đạt yêu cầu.

## 5. Các task thực thi

Mỗi task theo vòng đỏ → xanh → review. Chạy test mới để chứng minh lỗi đúng yêu cầu trước khi viết implementation; không tính lỗi thiếu runner là bằng chứng đỏ. Sau khi xanh, stage các file cụ thể và commit với trailer quy định. Không dùng các bước dưới đây để sửa hoặc gộp vào PR94.

### Task 1 — Lịch tháng và thuật toán preview thuần

**Tạo:** `src/lib/rentSupport.ts`, `src/lib/__tests__/rentSupport.test.ts`. **Sửa:** `src/lib/firstInvoiceBuilder.ts` chỉ để cung cấp ngữ cảnh kỳ, giữ nguyên công thức thuê.

**Đầu ra:** `supportPlanInputSchema`, `buildSupportMonths`, `sumSupportCommitment`, `allocateSupportQuote`; thuật toán local chỉ phục vụ preview.

- [x] Viết test literal lịch `[09,10,11]/2026 = 300000` và `[12/2026..08/2027] = 100000`; tổng phải bằng chuỗi `'1800000'`. Test count âm/lẻ, tháng sai, NaN, đoạn rỗng, vượt năm và vượt thời hạn hợp đồng phải bị từ chối hoặc hiện vấn đề cụ thể.
- [x] Chạy `npx vitest run src/lib/__tests__/rentSupport.test.ts` để thấy đỏ; triển khai normalizer và hàm thuần không đọc Supabase.
- [x] Test khoảng 20/09–05/10 chọn tháng 09, 28/09–31/10 chọn tháng 10; đều hưởng đủ mức tháng khi đủ doanh thu, không sửa giá thuê hiện hành.
- [x] Test chính xác `COMMISSION_ONLY` không lấy thưởng bù thiếu; `BONUS_THEN_COMMISSION` lấy thưởng trước rồi hoa hồng. Dùng số tiền đã trả/đã giữ trong §3.4 để ngăn trả vượt quyền lợi.
- [x] Chạy suite mới và `src/lib/__tests__/firstInvoiceBilling.test.ts`; commit khi xanh.

### Task 2 — Lưu lịch, phân quyền và snapshot ký

**Tạo:** migration qua `node scripts/tao-ten-migration.mjs contract_rent_support_plans`; `src/lib/rentSupportApi.ts`, `src/hooks/useContractRentSupport.ts`, `src/lib/__tests__/rentSupportPlanMigration.test.ts`, `src/lib/__tests__/rentSupportApi.test.ts`.
**Sửa:** `src/lib/contractDrafts.ts`, `src/lib/contractDraftEditor.ts`, `src/lib/contractDraftApi.ts`, `src/lib/contractSigning.ts`, `src/lib/contractCreateRpc.ts`, `src/lib/contractValidation.ts`, `src/types/contract.ts`, `src/hooks/useContracts.ts`.

**Đầu ra:** plan/month tables, quote/read/revise ở §3.3, draft payload v2 và version snapshot.

- [x] Viết PGlite gọi RPC thật: lưu/đọc đủ 12 tháng; v1 vẫn đọc được; sai org/toà trả `42501`; request giống nhau trả cùng kết quả, đổi payload cùng request trả `PT409`.
- [x] Test SQL allowlist và Zod strict đều chặn trường lạ/tiền không hữu hạn; đổi lịch sau xuất DOCX khiến ký revision/hash cũ thất bại.
- [x] Chạy đỏ, cấp tên migration rồi tạo schema/RLS/ACL và hàm owner/search_path tường minh. Lưu lịch cùng transaction ký/tạo hợp đồng; lưu nháp không tạo khấu trừ.
- [x] Test revision tương thích không thu lại khoản đã giữ cùng funding identity. Đổi Sale A → B không tính khoản A đã đóng cho B; đổi payer/policy sau funding hoặc giảm tổng 1,8 triệu → 900.000đ phải vào review, không required âm/hoàn tự động. Tháng đã hưởng giữ nguyên snapshot.
- [x] Chạy migration hai lần trên DB dùng một lần, mutation bỏ guard org phải đỏ; kiểm actual TEST JWT và sinh types bằng generator từ schema đúng đích.

### Task 3 — Hóa đơn theo tháng đủ điều kiện, không đếm số phiếu

**Tạo:** migration qua `node scripts/tao-ten-migration.mjs invoice_rent_support_claims`; `src/lib/invoiceRentSupport.ts`, `src/lib/__tests__/invoiceRentSupportMigration.test.ts`.
**Sửa:** `src/hooks/useInvoices.ts`, `src/lib/invoiceHelpers.ts`, `src/lib/firstInvoiceBuilder.ts`, `src/lib/excelInvoiceRows.ts`, `src/hooks/invoices/useExcelInvoiceData.ts`; mở rộng `src/lib/__tests__/firstInvoiceBilling.test.ts` và `src/lib/__tests__/excelInvoiceRows.test.ts`.

**Đầu ra:** helper private §3.3, claims/events và các thành phần giảm trừ trong canonical invoice writers.

- [x] Test đỏ: tạo tháng 11 trước tháng 10 vẫn hưởng đúng 300.000đ; tháng 12 hưởng 100.000đ dù đã có nhiều invoice; SETTLEMENT không chiếm tháng hỗ trợ.
- [x] Test hai yêu cầu cùng nhận toàn bộ hỗ trợ của tháng chỉ có một claim sống. Đổi revision rồi yêu cầu helper chiếm lại tháng đã hưởng phải `PT409`, không chỉ dựa unique invoice để test vô tình xanh. Unique claim theo `(org,contract,billing_month)`; giữ unique MONTHLY hiện có, SETTLEMENT/adjustment hợp lệ với hỗ trợ 0 không bị guard hỗ trợ chặn.
- [x] Test chu kỳ 1/3/6/12: request có một tháng đủ điều kiện chỉ nhận một mức tháng; chỉ cộng nhiều tháng nếu canonical request có kỳ con được server xác nhận. Không nhân với `payment_cycle` và không tự đổi công thức thuê.
- [x] Test tháng lẻ hưởng đủ 300.000đ; doanh thu chỉ 200.000đ thì trả `NEEDS_REVIEW` với lý do `REVENUE_CAP_REVIEW`, không âm invoice, không tự làm mất 100.000đ cam kết.
- [x] Triển khai claim và invoice trong cùng transaction; tách `invoice_support`, credit và giảm khác. Bảo vệ create/update/cancel/restore, RPC generate còn expose, caller cron/Edge; chặn direct-insert fallback với v2.
- [x] Nối helper vào cả đường tạo hóa đơn đầu trong `create_contract_v2`/ký nháp; không chỉ sửa writer hóa đơn độc lập. Test ký thành công tạo đúng một invoice và một claim tháng; lỗi giữa chừng rollback cả hợp đồng/lịch/invoice theo transaction hiện hữu, retry không nhân đôi.
- [x] Chạy `npx vitest run src/lib/__tests__/invoiceRentSupportMigration.test.ts src/lib/__tests__/firstInvoiceBilling.test.ts src/lib/__tests__/excelInvoiceRows.test.ts`; hai writer đồng thời chỉ một claim, bên thua nhận conflict có kiểm soát.

### Task 4 — Form hiển thị ngay tháng/kỳ và bản ký đầy đủ

**Tạo:** `src/components/contracts/contract-form/RentSupportScheduleEditor.tsx` và `__tests__/RentSupportScheduleEditor.test.tsx` cùng thư mục.
**Sửa trong `src/components/contracts/contract-form/`:** `RentDepositSection.tsx`, `useContractFormState.ts`, `useContractSubmit.ts`, `FirstInvoicePreview.tsx`; sửa `src/lib/contractTemplateEngine.ts`, `src/lib/contractTemplateCodes.ts` và test draft/signing tương ứng.

- [x] Test nhập 3 tháng × 300.000đ thấy ngay 09/10/11; thêm 9 × 100.000đ thấy 12–08 và tổng 1,8 triệu trước khi lưu.
- [x] Mặc định mở một giai đoạn; có nút thêm giai đoạn kế tiếp. Hiển thị tháng kèm năm, ví dụ `09/2026 · 10/2026 · 11/2026`; khi chưa đủ ngày để suy kỳ thì yêu cầu nhập ngày, không tự lấy tháng hiện tại. Giai đoạn sau bắt đầu ngay sau giai đoạn trước.
- [x] Test chọn toà chịu vẫn giữ lịch khách nhưng không trừ Sale; Sale mặc định chỉ hoa hồng; lựa chọn thưởng trước ghi rõ phần thiếu chuyển sang hoa hồng.
- [x] Trước bấm tạo phiếu, luôn hiển thị lựa chọn nguồn và bảng khấu trừ để người dùng kiểm tra/chọn lại. Đổi nguồn khi chưa funding phải tạo quote mới và audit; không dùng lựa chọn mặc định để âm thầm ghi tiền.
- [x] Hiện từng tháng, mức giảm và kỳ invoice thực tế/dự kiến. Đổi ngày kỳ đầu cập nhật ngay; trường hợp lịch bắt đầu 09 nhưng kỳ đầu là 10 phải báo tháng 09 chưa ánh xạ, không tự dịch lịch.
- [x] Thêm mã template cho khách `RENT_SUPPORT_SCHEDULE`, `RENT_SUPPORT_TOTAL`; biến cũ một mức vẫn tương thích, không lấy trung bình nhiều đoạn để nhét vào biến cũ. Dữ liệu hoa hồng, thưởng, người chịu và cách cấn trừ chỉ thuộc phần quản trị tài chính có quyền; không tự đưa vào DOCX gửi khách.
- [x] Test thay lịch hưởng của khách làm snapshot tài liệu cũ không ký được; đổi cấu hình funding nội bộ làm quote mất hiệu lực theo plan revision đã tăng, giữ hash nội dung khách nếu lịch hưởng không đổi. Xuất và render DOCX kiểm lịch 12 tháng không tràn trang và không lộ số hoa hồng/thưởng. Chạy component tests và typecheck trước commit.

### Task 5 — Nhận diện nguồn chi và quote khoản còn khả dụng

**Tạo:** migration qua `node scripts/tao-ten-migration.mjs rent_support_payout_sources`; `src/lib/rentSupportFunding.ts`, `src/lib/__tests__/rentSupportFundingMigration.test.ts`.
**Sửa:** boundary typed trong `src/hooks/useSaleBonus.ts`, `src/lib/rentSupportApi.ts`.

**Đầu ra:** source/alias và `FundingQuote` theo §3, có tiền gốc, đã trả, đã giữ, còn được chi, giữ lần này và thực nhận lần này.

- [x] Test đỏ: cùng quyền lợi Sale qua phiếu cọc và hợp đồng chỉ có một source; chuyển hoa hồng sang lương quản lý vẫn giữ source đó.
- [x] Test toàn bộ bảng ví dụ §1; nguồn khác người hưởng, tiền đã trả, kỳ đã khóa, legacy chỉ biết net hoặc thiếu tiền không được trả `READY` sai.
- [x] Test gross gốc 3 triệu, đã trả 700.000đ, đã giữ 300.000đ, lần này giữ 500.000đ: `remaining_payable=2000000`, `net_this_operation=1500000`; retry không tạo thêm quyền được chi.
- [x] Resolve theo FK và alias có kiểu; không ghép bằng tên, ngày hoặc số tiền gần giống. Kiểm engine thanh toán thực tế và các phần quyền lợi có ID riêng trước khi tính sức chứa.
- [x] Quote kiểm org/toà và quyền đọc nguồn tài chính; người không đọc được nguồn chỉ thấy vấn đề cần xử lý, không lộ tiền, ngân hàng hoặc reason chứa chi tiết tài chính.
- [x] Chạy SQL và actual TEST JWT cho owner/manager/người ngoài; mutation bỏ unique alias hoặc bỏ loại tiền đã trả phải đỏ.

### Task 6 — Thu đủ cam kết và tạo phiếu trong một transaction

**Tạo:** migration qua `node scripts/tao-ten-migration.mjs rent_support_upfront_payouts`; `src/lib/__tests__/rentSupportPayoutMigration.test.ts`.
**Sửa:** `src/hooks/useCommissionVoucher.ts`, `src/hooks/useSaleBonus.ts`, `src/lib/rentSupportApi.ts`, `src/components/contracts/CommissionVoucherModal.tsx` và test modal/hook.

**Đầu ra:** `create_contract_payouts_with_support_v1`, operation bền vững, withholding events, phiếu ròng dương hoặc `SETTLED_BY_SUPPORT`.

- [x] Test đỏ: hai request khác nhau đồng thời không dùng cùng khoản khả dụng; cùng request mất phản hồi rồi gọi lại trả đúng các operation/source/voucher IDs cũ.
- [x] Test bundle thưởng rồi hoa hồng lỗi ở bước sau phải rollback toàn bộ phiếu/khấu trừ trước đó. Lỗi trước commit và mất response sau commit có readback khác nhau, không retry mù.
- [x] Test invoice tháng 09 giảm 300.000đ rồi tháng 10 giảm 300.000đ không phát sinh khấu trừ nguồn mới; tổng thu upfront vẫn 1,8 triệu.
- [x] Test nguồn bị giữ hết có net 0: hoàn tất bằng `SETTLED_BY_SUPPORT`, giữ gross/withheld/net và audit, không tạo phiếu chi 0 hoặc đánh dấu `NOT_APPLICABLE`.
- [x] Triển khai khóa có thứ tự, hash payload và unique idempotency ở §3.4. Writer hoa hồng/thưởng cũ gặp v2 phải dùng adapter chung hoặc từ chối rõ; UI giữ request ID và đọc operation trước retry.
- [x] Chạy concurrency PostgREST nhiều kết nối, inject lỗi giữa transaction, mutation vượt nguồn/âm net/mất idempotency; review canonical postings và đối chiếu tiền, không thêm bước xin người dùng duyệt kỹ thuật.

### Task 7 — Nối lương quản lý và thưởng từ cọc vào cùng nguồn

**Tạo:** migration qua `node scripts/tao-ten-migration.mjs rent_support_salary_source_bridge`; `src/lib/__tests__/rentSupportSalaryMigration.test.ts`.
**Sửa:** `src/hooks/useCommissionManager.ts`, `src/hooks/useManagerSalary.ts`, `src/lib/managerSalary.ts`, `src/components/income-expenses/CommissionManagerAction.tsx`, `src/lib/__tests__/salaryCommissionManager.test.ts`.

- [x] Test đỏ: hoa hồng đã giữ 1,8 triệu chuyển sang sổ ảo rồi chốt lương không bị giữ thêm; tổng chi trên mọi đường không vượt phần thực nhận còn lại.
- [x] Test thưởng cọc đã trả không bị khấu trừ lại khi ký hợp đồng; nguồn chưa trả và còn sửa được dùng đúng alias, quyền và reservation.
- [x] Ánh xạ withholding vào các phần quyền lợi/kỳ lương có ID thật; không tự chia đều theo số kỳ. Nếu quyền lợi trải nhiều kỳ, tổng giữ của từng kỳ phải bằng một lần giữ của nguồn; kỳ đã khóa/đã trả không tự sửa.
- [x] Lock/unlock lương giữ hoặc đảo đúng inclusion/reservation của engine hiện có; không xóa lịch sử tiền gốc hoặc tạo nguồn mới khi đổi manager.
- [x] Chạy TEST với vai kế toán/quản lý, cạnh tranh chốt lương với gán/đổi phiếu, hai money gates và review độc lập phần nối lương.

### Task 8 — Hủy, khôi phục, trả sớm và đối chiếu legacy

**Tạo:** migration qua `node scripts/tao-ten-migration.mjs rent_support_lifecycle_reconciliation`; `src/lib/__tests__/rentSupportLifecycleMigration.test.ts`, `src/components/contracts/RentSupportReconciliationPanel.tsx`.
**Sửa:** `src/hooks/useInvoices.ts`, `src/lib/rentSupportApi.ts`, `src/hooks/useContractRentSupport.ts`, `src/components/thu-tien/contract-settlement/ContractSettlementSection.tsx`.

- [x] Test đỏ: hủy invoice rồi tạo lại cùng tháng chỉ hưởng đúng 300.000đ một lần; khôi phục invoice cũ khi có invoice thay thế phải conflict. Revision lịch không phá unique tháng.
- [x] Test hủy/khôi phục phiếu nguồn không xóa audit. Nếu khách đã hưởng hoặc lương đã khóa, trả `NEEDS_REVIEW` với lý do `REVERSAL_REVIEW`, không tự hoàn tiền/tạo nợ.
- [x] Test trả sớm sau 3 tháng: 900.000đ đã hưởng giữ nguyên, 900.000đ chưa dùng chờ xử lý theo quyết định nghiệp vụ; không tự hoàn Sale. Giới hạn kỳ tương lai dựa trên termination đã có hiệu lực trong engine.
- [x] Test legacy phiếu net 1,2 triệu không bị trừ thêm 1,8 triệu. Đối chiếu gross 3 triệu/đã giữ 1,8 triệu/net 1,2 triệu phải có bằng chứng đúng source, actor và reason; retry không nhân dòng.
- [x] Tạo báo cáo dry-run theo ID và khoản tiền, áp đối chiếu theo batch chỉ định, idempotent; không backfill đại trà trong migration cấu trúc. Cap/hoàn phần chưa dùng chưa chốt thì giữ hành động tiền liên quan ở trạng thái cần xử lý.

### Task 9 — Invoice, phiếu ròng và theo dõi sau ký

**Sửa:** `src/components/invoices/GenerateInvoiceDialog.tsx`, `src/components/invoices/ExcelInvoiceDialog.tsx`, `src/components/invoices/EditInvoiceDialog.tsx`, `src/hooks/invoices/useExcelInvoiceData.ts`, `src/components/invoices/invoice-entry/useInvoiceEntry.ts`, `src/components/contracts/CommissionVoucherModal.tsx`, `src/components/contracts/ContractCommissionFollowupPanel.tsx`, `src/lib/contractCommissionFollowup.ts`, `src/hooks/useContractCommissionFollowup.ts`.
**Tạo test cạnh các component:** `GenerateInvoiceDialog.rentSupport.test.tsx`, `ExcelInvoiceDialog.rentSupport.test.tsx`, `CommissionVoucherModal.rentSupport.test.tsx`.

- [x] Test đỏ: đổi tháng 11 sang 12 sau khi đã nhập giảm khác hoặc đã tải Excel phải đổi hỗ trợ 300.000đ → 100.000đ; credit/giảm khác không mất hoặc cộng lặp.
- [x] Query key có org/contract/plan revision/billing month/kỳ đủ điều kiện; đổi ngữ cảnh làm quote cũ không submit được. Lỗi query phải hiện lỗi/cần kiểm tra, không chuyển thành 0.
- [x] Nối cùng context hỗ trợ vào EditInvoiceDialog để chỉnh hóa đơn v2 qua canonical update; hỗ trợ, giảm khác và credit tách riêng, đổi dòng doanh thu cần quote lại. Giữ một request UUID cho ý định không đổi qua lỗi/mất phản hồi, đọc kết quả trước khi tạo lại; không hấp thụ mức hỗ trợ cũ vào giảm khác.
- [x] Modal hiện “Theo thỏa thuận / Đã trả hoặc giữ trước / Khấu trừ lần này / Thực nhận lần này”, tổng cam kết thu upfront và lịch giảm của khách. Nguồn thiếu/đã trả/chưa xác định có lý do xử lý cụ thể.
- [x] Nối follow-up bền vững với funding review, legacy review và net 0 khi có yêu cầu tạo phiếu thực sự được ghi nhận. Theo sửa yêu cầu ngày 29/09: chỉ lỗi/gián đoạn tạo có bằng chứng mới vào ghi chú dưới nút tạo hoa hồng tại chi tiết hợp đồng và Cần rà soát của trang Hợp đồng & quyết toán. Không suy lỗi từ hợp đồng cũ chưa có phiếu hoặc quote chưa được submit; không dựng lại global banner. Trạng thái lấy từ operation/phiếu thực; net 0 đã xử lý bằng hỗ trợ là hoàn thành, không phải lỗi/NOT_APPLICABLE. Tích hợp API retry của bản commission-failure-retry đã phát hành; không tạo cơ chế cạnh tranh.
- [x] Kiểm desktop/mobile chi tiết hợp đồng và desktop Hợp đồng & quyết toán; hàng đợi lỗi chỉ có FAILED/UNKNOWN thực sự có attempt, không có PENDING cũ. Người chỉ xem hợp đồng không lộ tiền/reason tài chính. Chạy component tests, strict/baseline và build/bundle.

### Task 10 — Kiểm chứng thực và phát hành

**Tạo:** `.e2e-fleet/specs/rent-support-schedule.spec.ts`, `scripts/test-rent-support-authz.mjs`, các harness concurrency thực của Task3/6/7/8 (tái sử dụng bằng chứng đã review); cập nhật tài liệu nghiệp vụ/manifest theo Contract §8b. Types, surfaces và provenance phải sinh bằng generator.

- [x] E2E headless trên TEST/DEMO: lịch 3+9, preview ngay, ký đúng revision, hai cách trừ, net 0, đổi kỳ invoice/Excel, hủy/khôi phục, nguồn thiếu, thưởng cọc và lương quản lý. Kiểm console, dọn fixture và ghi bằng chứng theo SHA.
- [x] Actual JWT: owner, manager giới hạn toà, kế toán giới hạn sổ, người chỉ xem hợp đồng, người nhận khác, membership hết hiệu lực. Assert cả cho phép và từ chối; không dùng superuser để tuyên bố RLS đạt.
- [x] Nhiều kết nối: hai yêu cầu claim cùng tháng xuyên revision, hai khấu trừ cùng source, thưởng cọc với thưởng hợp đồng, chốt lương với đổi phiếu, hủy/khôi phục với tạo thay thế. Assert không dùng lại quyền lợi, không chi vượt gross sau tiền đã trả/đã giữ, không cấn chéo payee hoặc nuốt deadlock.
- [x] Mutation qua `scripts/dot-bien.mjs`: bỏ org/toà, bỏ unique tháng xuyên revision, bỏ unique alias, bỏ khoản đã trả khỏi công thức, đổi tháng thành count invoice, khấu trừ mỗi invoice, bỏ rollback hoặc kiểm quote hash. Mỗi lần có hash đổi → test đỏ → khôi phục hash.
- [x] Chạy `npm run gate:reconcile-money` và `npm run gate:reconcile-money-v2`; đối chiếu IDs fixture và postings trước/sau. Replay migration TEST hai lần; chạy `node scripts/check-stable-fn-locks.mjs`, `node scripts/check-view-invoker.mjs` nếu sửa VIEW; kiểm ACL/owner/search_path/volatility và PostgREST thật.
- [ ] Chạy `npm run gen:types`, `npm run types:normalize`, `npm run types:check`, `npm run gate:rpc-cast`, `npm run typecheck:baseline`, strict modules, tests liên quan và build/bundle. Thiếu credential hoặc gate đỏ không ghi là pass.
- [ ] Stage đường dẫn cụ thể rồi sinh provenance/surfaces; chạy `npm run gate:migration-provenance`, `npm run catalog:check`, `npm run gate:truoc-push`. Review độc lập tiền/quyền/migration, cập nhật base main và mở draft PR có bằng chứng, rủi ro, phần chưa xác minh.
- [ ] Rollout schema additive bằng forward lane có backup; xác minh digest/catalog và RPC đọc production trước promote app đúng SHA CI. Giữ reader v1; writer cũ gặp v2 không được bỏ guard. Tắt cờ writer về chế độ đọc/cần xử lý là đường phục hồi ứng dụng; không xóa schema/event hoặc tự đảo tiền đã ghi.

## 6. Điều kiện hoàn thành và phần chưa xác minh

- [x] Yêu cầu đã xác nhận có test: preview ngay (1/4), lịch 3+9 (1/2), người chịu/cách trừ (4/5), thu đủ upfront (6), tháng lẻ và kỳ thực (3/9), nguồn chi/gross/net (5/7), net 0 (6/9), thiếu tiền/hủy/khôi phục/legacy (5/8).
- [x] Tháng hỗ trợ không bị dùng lại qua revision; nguồn không bị trả lại phần đã trả/đã giữ; lương và phiếu cọc không tạo một quyền lợi thứ hai.
- [x] Không dùng phiếu 0 hoặc `NOT_APPLICABLE` cho tiền đã cấn trừ hết; không đổi ngầm công thức thuê, kỳ lương hoặc cách ghi sổ hiện hành.
- [x] Mọi API, DTO và enum ở §3 dùng thống nhất; mọi migration do script cấp timestamp tại lúc triển khai. Tên bảng/API mới là thiết kế đích, không khẳng định đã tồn tại.
- [x] Cap, phần chưa dùng khi trả sớm và legacy chưa đủ bằng chứng được xử lý hoặc chặn hành động liên quan bằng `NEEDS_REVIEW` với lý do rõ. Kỹ thuật tự xác minh canonical postings bằng review và money gates.

**Phần còn lại trước phát hành:** QA tích hợp đã chốt trên app source b2ace648. Schema additive 8 migration, backup/biên nhận, provenance/catalog/types production, hai gate tiền và 44 gate trước push đã đạt; draft PR101 đã mở. Còn chốt sửa tương thích CI, xác minh CI đúng SHA, promote ứng dụng, bật writer qua forward lane sau ứng dụng tương thích và smoke chỉ đọc. Chưa tuyên bố hỗ trợ tiền thuê đã lên production.

**Bàn giao:** Kế hoạch đã được rà soát với các quy tắc người dùng xác nhận; tách khỏi hotfix PR #95 đã phát hành và PR #96 cập nhật tài liệu. Các checkbox còn mở là việc triển khai tính năng hỗ trợ mới, không phải việc còn thiếu của bản sửa theo dõi phiếu.

### Bằng chứng QA cuối — 01/10/2026

App source `b2ace64820d76ca52fde25e249fc867fe9b24a3a`; scoped QA commit `c2551ff6aa423100d15c02651d80f956a1650af1`. Lấy PASS theo từng ca và đúng source, giữ nguyên các lượt FAIL; không ghi thành một lượt full suite đạt.

- Attempt14: lịch 3+9, preview/save/export DOCX thật/reopen/ký đúng tài liệu, tự mở popup hoa hồng; hóa đơn tháng đầu giảm đủ 300.000đ. Ca ký PASS 26,7 giây.
- Commission/bonus/net0/nguồn thiếu/v3 và role UI: tái sử dụng actual money assertions, lost-response proof cùng các ca đọc lại đã đạt; không tạo lại nguồn/phiếu đã hoàn tất. V3 giữ thưởng 500.000đ trước, còn 1.300.000đ cấn vào hoa hồng; thực nhận 1.700.000đ qua lương.
- Attempt16: hóa đơn lẻ/Excel đổi 11→12, hai hóa đơn đã lưu hỗ trợ 100.000đ, giảm khác 20.000đ, credit 0; quyết toán đọc đúng gross/held/net và kiểm các nút đối chiếu. 2 ca PASS 34,2 giây. Hóa đơn chỉ chạy auto-overdue có scope; không tạo lại phiếu.
- Attempt17: lương tháng 11 hiện nguồn 1.700.000đ đúng kỳ/sổ ảo, READY; không chốt/trả lại. PASS 8,6 giây. Quyền đọc danh mục thiếu trong fixture đã bổ sung theo quyền canonical, không đổi nguồn/ngày/tiền hoặc RLS sản phẩm.
- Cleanup TEST: 446 bảng của org fixture còn 0 dòng, 6 actors và 19 file còn 0; 23 cron rows của cross-fixture được dọn theo exact IDs; writer trở lại exact false. Hai gate tiền sau cleanup đạt: v1 1.165 dòng, ba nguồn cùng 5.784.524.013đ; v2 20 sổ thực, 3.795 posting lines phân trang cùng SQL 2.626.953.004đ.
- Typecheck app và E2E đạt. Build Node24: 5.053 modules, 34,15 giây, entry 243,94 kB/gzip 71,53 kB. Related suite 26 files/294 tests đã đạt; các source fix cuối có RED/GREEN và mutants riêng đã review. Không nâng baseline hoặc miễn gate.
