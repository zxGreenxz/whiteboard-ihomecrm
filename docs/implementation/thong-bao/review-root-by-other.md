# Review root bởi agent audit_other

Ngày 30/09/2026. Phạm vi đọc độc lập: QueryProvider, QueryRegion/financeQueryState, friendlyError/voucherFeedback/financialWorkflow/formErrors/useOperationFormFeedback, createdVoucherReceipt, useManagerSalary/SalaryMonthly/ManagerSalaryPage, useCashbookClosing/CloseCashbookDialog/ConfirmCashbookClosingDialog/CashbookForm. Đọc source hiện tại và đối chiếu receipt SQL trong baseline/migration, không chỉ dựa vào tên helper. Không dùng dữ liệu thật.

| Mức | Phát hiện trước sửa | Tác động / bằng chứng | Chủ sửa / trạng thái |
| --- | --- | --- | --- |
| P1 | voucherOutcomeUnknown không xét HTTP5xx nếu message không có fetch/network/timeout | Error `{status:503,message:'Service Unavailable'}` không giữ unknown; FinancialWorkflowGuard và form có thể cho ghi lại. | Root xác nhận, đang thêm helper phân loại chung + regression. Chưa tự tuyên bố full suite đã xanh. |
| P1 | CashbookForm giữ draft quyền cũ qua refetch nhưng gửi `access.revision` mới | CAS bị vô hiệu ở client: lựa chọn revision1 có thể ghi đè revision2. | Root giao lại audit_other; đã giữ snapshot revision/sets gốc. DOM đỏ→xanh. Diff sửa của audit_other cần reviewer khác. |
| P2 | CashbookForm blockedRef/draftLoaded toàn component khi đổi account | Unknown sổ A → mở B vẫn hiển thị draftA, đồng thời nạp quyền B và khóa B. | Đã tách editor theo ID, wrapper giữ unresolved map từng ID; DOM chuyển A→B→A xanh. |
| P1 | set_cashbook_access_v2 null data vẫn success sau metadata update | Báo đã lưu sổ dù quyền chưa xác nhận. SQL receipt có cashbook_id/revision/custodian_count/knower_count. | Đã validate chính xác các trường này; DOM partial giữ ID, không đóng/không success xanh. |
| P2 | useCashbookClosing khai `meta.feedback='inline'`, QueryProvider chỉ đọc `errorDisplay` | Một lỗi nguồn tạo toast global lẫn QueryRegion. | Root xác nhận và đã thêm đọc meta.feedback; chờ gate tích hợp. |
| P1 | useSaveSalaryAdjustment không guard ngoài modal; modal unmount khi đóng | Unknown insert → đóng/mở mất khóa cục bộ; input không receipt, có nguy cơ lập lại. | Root nhận guard/receipt. |
| P2 | Salary adjustment update/delete và toggle job chỉ nhìn error, không kiểm số dòng | 0 affected vẫn toast đã lưu/xóa/đổi trạng thái. | Root nhận kiểm receipt/count. |
| P2 | Lock/unlock salary chỉ kiểm state, bỏ period/count | SQL `unlock_salary_month_v1` thật có unlocked_count=0 khi không có dòng LOCKED; UI vẫn báo đã mở khóa. Canonical receipt lock có period_month/locked_count; unlock có period_month/unlocked_count. | Root nhận validate/count/no-op. Bằng chứng baseline/schema.sql phần lock/unlock và migration20260927155251 v2 ghép v1. |
| P2 | useUpdateAccount/useDeleteAccount canonical success không kiểm payload | null/no-op chưa phân biệt kết quả thật; create đã kiểm cashbook_id. | Đã gửi root, chưa sửa bởi audit_other. |

Giới hạn: không có E2E/SQL/RLS/đa cửa sổ trong review này. Các guard chỉ ở hook/component không tự đảm bảo tồn tại qua tải lại trang; cần ghi rõ thay vì coi đó là idempotency backend. QueryRegion đọc giữ last-good chỉ khi transient, quyền từ chối chặn; form caller tài chính phải tiếp tục khóa ghi khi source stale/error. Không thay đổi root files ngoài CashbookForm được giao sau review.
