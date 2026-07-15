# T1b — Harden `record_invoice_payment_v3`

> Trạng thái: `IN_DESIGN`  
> Production apply/canary: `BLOCKED` bởi T0a recovery, T1a và test harness T4a tối thiểu.

## Mục tiêu

Giữ trải nghiệm thu tiền single/bulk hiện tại nhưng sửa authorization, foreign-resource validation và durable idempotency để mọi retry/concurrency chỉ tạo đúng một hiệu ứng tiền theo đúng tổ chức/phạm vi.

## Trước và sau

| Chủ đề | Trước T1b | Sau T1b |
|---|---|---|
| Permission | Dùng `invoices.edit`. | Exact `thu_tien.collect`, resource scope server-derived. |
| Thứ tự kiểm tra | Có thể lookup idempotency trước authorization invoice. | Authorize caller/org/subject trước khi đọc operation replay. |
| Idempotency | Key chưa unique atomic và chưa scope đầy đủ; same key/different payload chưa conflict chuẩn. | Unique durable operation theo org + operation + subject + caller + key, canonical payload hash/response. Same payload replay original; khác payload conflict. |
| Invoice | Validation/lock chưa đạt contract mới. | Lock invoice, validate state/expected version và payment eligibility. |
| Foreign IDs | Chưa chứng minh mọi ID cùng org/scope. | Account/change/rounding/item/category/room/contract/owner đều server-validate cùng org và resource scope. |
| Atomicity | V3 đã gom nhiều effect nhưng cần re-audit. | Operation + payment + invoice + voucher/items + credit/excess commit hoặc rollback cùng nhau. |
| Bulk | Partial success client-driven. | Vẫn atomic theo invoice, partial success rõ từng dòng; durable result ngăn thu lại dòng thành công khi retry. |
| Audit | Chưa đủ evidence payload/conflict/provenance. | Actor, org, subject, key, payload hash, response, timestamps và immutable provenance. |

Ảnh hưởng nghiệp vụ: người không có quyền thu tiền bị backend deny dù UI từng cho thao tác; retry mạng không thu trùng; bulk có thể thành công một số hóa đơn và trả kết quả cụ thể cho số còn lại; same key với nội dung khác bị báo conflict thay vì trả nhầm giao dịch.

## Caller inventory bắt buộc

- Dialog thu tiền đơn (`useRecordPaymentRPC`).
- Thu hàng loạt (`useBulkRecordPayment`).
- `useCreatePayment` và mọi caller còn sống.
- External/Edge/cron/service caller nếu có.
- Receipt/payment-method/reversal/credit call sites dùng response của V3.

Inventory phải machine-readable và gắn commit SHA trước khi chốt contract.

## Contract đích

1. Parse/normalize input nhưng không lookup operation replay trước subject authorization.
2. Resolve invoice → organization/resource; assert active membership + exact collect permission/scope.
3. Canonicalize payload bằng server rules; hash bao gồm toàn bộ field làm đổi money/state/resource.
4. Insert/lock durable operation unique; conflict phân biệt same/different payload.
5. Lock invoice và related money rows theo lock order công bố.
6. Validate state/version, amount/numeric rules, period-open và mọi foreign ID.
7. Ghi tất cả effect atomically.
8. Lưu canonical response trong operation; replay trả đúng response đầu tiên.
9. Không để exception/notice chứa PII/secret; audit append-only.

## Acceptance matrix

- JWT có `thu_tien.collect`: allow trong scope.
- JWT thiếu exact permission hoặc chỉ có `invoices.edit`: deny.
- Suspended/revoked/orphan/cross-org: deny ngay backend.
- Foreign account/change/rounding/item/category/room/contract/owner: deny trước effect.
- Same key + same canonical payload tuần tự/đồng thời: một effect, cùng response.
- Same key + different payload: deterministic conflict, không effect mới.
- Retry after commit/connection loss: original response, không double collect.
- Inject failure ở từng bước: rollback toàn operation.
- Bulk: mỗi invoice atomic, kết quả từng dòng durable, retry chỉ xử lý dòng chưa thành công.
- Pre/post full reconciliation: payment, invoice status/balance, voucher/items, credit/excess, receipt; delta ngoài transactions test = 0.
- Generated types, related Vitest/property/concurrency, direct API, browser happy/edge/deny và console/network đều pass.

## Production gate

Canary count và VND cap mặc định `0`; feature flag mặc định `OFF`. Chỉ chốt giá trị sau exact migration/signature hash, recovery `VERIFIED`, restore evidence, owner approval và maintenance window. T1b chỉ chuyển `VERIFIED` sau observation interval và không còn legacy V3 writer ngoài inventory.
