# Review độc lập — guard tài chính, bàn giao và lương

Rà soát chỉ đọc trong worktree thông báo, ngày 30/09/2026. Không gọi writer thật và không chỉnh quy tắc database. Các số dòng là snapshot lúc review; root đang sửa song song nên cần đối chiếu diff cuối.

## Findings đã bàn giao root

1. **P1 — Không được mất biên nhận hoặc mở lại retry sau một bước đã ghi.** `src/lib/financialWorkflow.ts` bản trước review trả nguyên `FinancialWorkflowError`, bỏ `progress.completed`; catch không ghi `error.completed` vào pending. Bàn giao trả ID nhưng payload thiếu trường (`src/hooks/useCashHandovers.ts:159`) vì vậy mất ID khi remount; bước trước đã thành công rồi lỗi dạng failure có thể xóa pending và cho gửi lại cả chuỗi. Root đã bổ sung merge/dedupe completed và ghi IDs từ lỗi vào pending trong snapshot đọc sau. Kiểm cuối cần xác nhận regression: bước đã xác nhận + failure vẫn partial; payload lỗi mang ID vẫn giữ qua guard mới.

2. **P2 — Scope pending cần khớp tổ chức writer.** Các mutation lợi nhuận truyền `input.organizationId` tới RPC; factory trước review chỉ dùng tổ chức đang chọn trong localStorage. Biểu mẫu của A gửi khi lựa chọn B có thể lưu marker B cho writer A; quay lại A sẽ không thấy marker. Root đã bổ sung `targetOrganizationId` validation trong factory/run. Cần kiểm caller close/unlock/reset thực sự truyền tổ chức mục tiêu và regression mismatch không gọi RPC.

3. **P1 — Ô số tiền thưởng/trừ và chi lương vẫn đổi dữ liệu sai thành một số dương hợp lệ.** `src/components/salary/SalaryMonthly.tsx:16,45,90,118` dùng `parseNum` xóa mọi ký tự không số. `-100` hoặc `abc100` thành `100`, `1.5` thành `15`; validation `!numVal` cho qua rồi gọi `onSave`/`onPayout`. Helper `parseSalaryAmount` đã có nhưng chưa nối hai dialog trong snapshot review. Hướng sửa: giữ nguyên text không hợp lệ, strict parse và hiển thị lỗi tại amount; DOM test không gọi callback khi âm/chữ/số lẻ, và vẫn chấp nhận phân nhóm đồng `800.000`.

4. **P2 — Legacy chi lương chưa xác nhận hàng paid được cập nhật.** `src/hooks/useManagerSalary.ts:1300` chỉ kiểm error của update `salary_monthly`, rồi trả receipt và clear guard. Response 0 hàng/no-error (RLS hoặc bản ghi không còn) có thể báo hoàn tất dù stamp paid/payout_voucher_id chưa được ghi. Hướng sửa: select và xác nhận đúng monthly ID, paid, voucher ID; thiếu hàng/không khớp chuyển partial, giữ voucher/payment IDs. Regression nên đi qua fallback đã được backend cho phép, trả 0 hàng ở paid update, không success và remount không gửi lại voucher.

5. **P2 — Legacy chốt lương gọi IDs mục tiêu là bước đã xác nhận dù chưa có receipt.** `src/hooks/useManagerSalary.ts:874–881` raw commission update chỉ kiểm error rồi push tất cả `commVoucherIds` với nhãn đã cập nhật duyệt. Response 0 hàng/thiếu hàng vẫn có thể chốt lương và toast thành công. Hướng sửa: xác nhận trạng thái thật của toàn bộ IDs (bao gồm hàng đã APPROVED trước đó), chỉ ghi biên nhận xác nhận và chặn chốt tiếp nếu chưa đối chiếu đủ. Không đổi engine hay chính sách duyệt trong lượt feedback. Regression: một target không đọc/không cập nhật được thì không báo toàn bộ đã hoàn tất.

Root đã tiếp nhận cả ba findings lương để sửa bằng DOM red và receipt tests. Review này không xác nhận các sửa đó đã qua kiểm cuối.

## Giới hạn xác minh

Đã đọc shared guard/pending/factory, handover hooks/UI và source RPC tạo bàn giao (có khóa phiếu và kiểm phiếu chưa bàn giao), collection recovery, salary read/write và dialogs, profit actions, voucher receipt, period fee và operation feedback callers. Không chứng minh backend live đang có đúng migrations hay semantics atomic/concurrent; không chạy kiểm thử tài chính live. Frontend pending không thay thế idempotency và khóa ở database. Không đánh dấu một lỗi writer là retry-safe chỉ từ việc đổi câu thông báo.
