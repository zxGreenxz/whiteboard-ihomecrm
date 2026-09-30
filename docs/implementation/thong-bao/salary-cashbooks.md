# E01–E08, E11, I08 — sổ quỹ và bảng lương

| Mã | Trước | Sau | Bằng chứng hiện có |
|---|---|---|---|
| E01 | CRUD generic/receipt không kiểm | Tên sổ trong kết quả; create/update/archive đúng ID. CashbookForm giữ draft theo sổ và revision CAS; partial quyền giữ sổ core ID, unknown không ghi lại | cashbookFeedback8; CashbookForm.feedback3; review độc lập audit_other |
| E02 | Lỗi cấu hình lẫn không có sổ/thiếu quyền | ReceivingCashbookSettings tách data/error/permission unread, retry; receipt đúng cashbook/revision/count mới xác nhận | ReceivingCashbookSettings8; receivingPermissionFeedback1 |
| E03 | Chốt sổ chỉ toast/nút khóa | Form có lỗi số kiểm đếm/người nhận/ngày/chứng từ, focus; giữ form; thiếu nguồn khóa và retry | cashbookClosingFeedback4; Closing dialogs DOM2 |
| E04 | ISO/khóa vĩnh viễn | Ngày dd/MM/yyyy và giao dịch đến ngày chốt đã khóa; noop theo kết quả thật | closing hooks validate ID/status/date |
| E05 | Bàn giao thiếu data/toast-only | HandoverSheet inline/focus, list/receiving QueryRegion; 5 RPC validate ID, giữ code và nguồn lỗi, unknown chặn lặp trong hook | handoverFeedback2; HandoverSheet DOM2; phần đối soát xem finance |
| E06 | Điều chỉnh salary generic/delete no-row | Nêu khoản/nhân viên; nhập thiếu đỏ/focus; create/update trả đúng ID; delete0dòng info; lỗi giữ form | salaryMutationFeedback9; SalaryMonthly.feedback |
| E07 | Chốt/mở khóa có bước bị nuốt | Kiểm lock/unlock envelope state/month/count; legacy rows/update IDs; partial giữ bước+ID. Count0 là thông tin | salaryMutationFeedback; FinancialWorkflowGuard4 |
| E08 | Chi lương nhiều toast/đóng sớm | Async payout/bulk giữ form lỗi, một kết quả n/m với nhân viên và voucherIDs; trạng thái chờ duyệt/ghi sổ theo receipt | useManagerSalaryV5Bulk; SalaryMonthly.feedback |
| E11 | Đơn nghỉ lỗi raw | Safe operation + ngày/nhân viên, source errors không giả empty | leaveFeedback |
| I08 | Fund/monthly thiếu nguồn vẫn có thể tính | SalaryFund validate links/vouchers/items/numbers; manager/self/monthly QueryRegion và source bắt buộc, chặn chốt khi thiếu | salaryFundReadFeedback2; query region suites |

## Giới hạn cần hoàn tất

- Các luồng chi/chốt/mở khóa lương, sổ quỹ/chốt sổ/bàn giao/cấu hình nhận tiền dùng persistentFinancialWorkflow theo actor và ID nghiệp vụ, giữ requestKey trước gọi. salaryDurableWorkflow, cashbookPersistence, receivingCashbookDurableFeedback kiểm remount/switch-org. Legacy mở khóa chỉ cập nhật trạng thái sau xác nhận các snapshot đã gỡ; khóa so snapshot theo đúng từng nhân viên và số tiền. Không đổi atomicity backend. Đối chiếu tiền/bulkcollection có helper riêng do finance triển khai; không tự suy ra các flow khác đã an toàn qua reload.
- Chưa chạy toàn bộ E2E role chủ công ty/kế toán/quản lý/không quyền, đồng thời2actor hoặc money reconciliation v1/v2 của commit này.
- E09/E10/E12–E15 do scope other; E16–E20 scope finance; E21–E23 scope estate. Không đổi atomicity backend.

## Review kết quả tiền và nguồn dữ liệu

- PersonalCashbook bỏ sổ nhận null chỉ hợp lệ khi receipt thực sự null, không chấp nhận `{}`, false,0 hoặc chuỗi trống. Salary phần còn thu không suy từ tổng khi null/thiếu; cur.paid rỗng không thành0; trạng thái approval/posting lạ không được báo đã chi hoặc mở khóa marker. 13 ca tái hiện RED→GREEN, focused121/121; 4 mutation đổi hash/suite đỏ/restore đã ghi trong review độc lập.
- Sổ nhận và tender dùng requestKey của lượt đang giữ, đúng tender/method/account, read schemas nguồn/count không giả quyền/empty; 7 RED→GREEN, mutation actor scope RED/restored.
- Bản in hóa đơn và biên bản chốt sổ không in từ nguồn thiếu item/payment/totals; print exactinvoiceID và ngày thực, cashbookclosure exactID, tiền chênh lệch hữu hạn, danh sách phiếu `[]` hợp lệ nhưng null lỗi. Nhóm43/43 trước review.
- E09 `useSalaryCanEditAmounts`: boolean false đúng giữ fail-closed; null/JSON/string không biến thành không có quyền. salaryCanEditFeedback4 RED→GREEN +true/false2.
