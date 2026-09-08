# Điều chỉnh lịch sử phân loại cọc — evidence đã lọc PII

Migration: `20260908052713_repair_invoice_deposit_classification_history.sql`.
Repair code: `INVOICE_DEPOSIT_CLASS_HISTORY_20260908`.

| Hóa đơn | Tổng phiếu thu giữ nguyên | Chuyển PNL sang DEPOSIT | PNL sau sửa |
|---|---:|---:|---:|
| INV-2026-00598 | 7.450.000 | 3.600.000 | 3.850.000 |
| INV-2026-00802 | 7.490.000 | 2.200.000 | 5.290.000 |
| INV-2026-00823 | 4.720.000 | 1.600.000 | 3.120.000 |
| INV-2026-00622 | 3.900.000 | 3.900.000 | 0 |

Nguồn bằng chứng: `2026-09-08-commission-deposit-classification.json`. Migration ràng buộc
ID hóa đơn, item hiện tại, item bị xóa, phiếu thu, payment, collection, account, org,
amount và đúng timestamp của cặp DELETE DEPOSIT / INSERT REVENUE. Không dò tên để mở rộng cohort.

Hai guard canonical chỉ nhận capability đúng JSON trước/sau của item, transaction ID,
backend PID và đúng header có delta dẫn xuất. Khóa bảng phiếu/item trong transaction;
khóa nguồn đóng kỳ và account; giữ mọi trigger kiểm kỳ và bàn giao. DDL guard ban đầu được
khôi phục byte-identical trước commit. Lỗi làm rollback cả DDL và dữ liệu.

Chỉ `accounting_class` đổi trên invoice item. Phiếu gộp tách thành PNL còn lại + DEPOSIT
trong một CTE để trigger tổng tiền nhìn thấy tổng cuối cùng. Phiếu chỉ có cọc đổi class/type
trên dòng cũ. Trigger hiện có tính lại cọc hợp đồng; không ghi tay `deposit_paid`, không sửa
cảnh báo hay tự duyệt hoa hồng.

Postcondition so sánh nguyên payments, postings, posting lines, collection, tenders,
flow ownership, component manifests/components, settlement, nghĩa vụ refund và các phiếu
khác của hợp đồng. Header chỉ được đổi KQKD/counts/restricted/updated_at; gross/net/change,
ngày, trạng thái, tài khoản và bàn giao giữ nguyên. Audit before/after được ghi bền vững
vào `accounting_repair_audit` với unique repair code, chạy lại không tạo audit mới.

INV-2026-00622 đã COMPLETED: giữ nguyên hồ sơ thanh lý và ba phiếu hoàn/offset/revenue
bằng precondition digest toàn dòng. Khoản cọc khôi phục 3.900.000 là liability cần rà
soát riêng: tạo đúng một `RESTORED_DEPOSIT_REQUIRES_SETTLEMENT_REVIEW` trạng thái OPEN.
Không suy ra quyết định hoàn hoặc tịch thu cọc. Phiếu hoàn thuê chờ duyệt 1.891.500,
refund tính cũ -58.500 và rent refund 1.950.000 không bị thay đổi.

Manifests đã finalized giữ các tổng lịch sử 7.650.000 / 7.511.000 / 4.720.000 /
8.050.000, khác tổng hiện tại ở ba hóa đơn. Đây là snapshot lịch sử bất biến được giữ
nguyên, không mở băng để điều chỉnh lịch sử ngoài phạm vi phân loại đã chứng minh.

## Kiểm chứng trước review

`node scripts/test-invoice-deposit-history-repair.mjs` (PAT từ cấu hình runtime): DEMO-only,
BEGIN/ROLLBACK; bốn phiếu thu qua RPC canonical dưới role authenticated.

- RED: bỏ migration, assertion phát hiện 0/4 item được khôi phục.
- GREEN: ba phiếu gộp + một phiếu chỉ cọc; deposit tăng đúng 11.300.000, tổng thu không đổi.
- Completed termination + pending refund giữ nguyên; đúng một exception OPEN; repeat không
  thay audit. Fixture hoàn tất được tạo trong transaction và rollback toàn bộ.
- Fail sau khi đã sửa cohort đầu: toàn bộ item và định nghĩa guard được phục hồi.
- Fault injection recognition period CLOSED: bị từ chối, hàm closure khôi phục.
- Guard sau sửa chặn update tiền tùy ý trên cả item và header.
- Đảo cả bốn collection qua canonical RPC: derived deposit về baseline ban đầu.
- Mutation bỏ UPDATE class: test đỏ vì không khôi phục cọc; nguồn migration không bị mutate.
- `node --check` harness và `git diff --check`: pass.

Không apply production trong tác vụ này. Root phải review và dùng lane có backup.
Schema-only restore được no-op chỉ khi organizations, contracts, invoices, payments và
income_expenses đều rỗng. Database có dữ liệu thiếu một cohort vẫn bị từ chối (DEMO negative
đã kiểm). Restore drill schema-only thật do CI nhánh tích hợp xác minh.
Graph freshness high-risk tại worktree: FAIL GitNexus MISSING; graph impact không có index;
không đọc graph cũ để kết luận. Gate graph ở nhánh tích hợp vẫn là yêu cầu trước phát hành.
