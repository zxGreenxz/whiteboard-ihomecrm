# Review độc lập luồng tiền của root

Ngày 30/09/2026, reviewer finish_finance. Đọc source/diff useManagerSalary, financialWorkflow (P0001), operationOutcome, useReceivingCashbooks, useIeAutoApproveThreshold và IeAutoApproveThresholdCard. Không tự review các implementation B/C/D/E do finish_finance viết trước đó. Không ghi dữ liệu thật hoặc đổi luật/SQL.

| Phát hiện trước sửa | Biên đã sửa và bằng chứng |
|---|---|
| Bỏ sổ cá nhân: personalCashBook `{}`/false/0/blank bị hiểu như null, báo đã bỏ sổ và xóa marker | Chỉ null thật hoặc book id/name hợp lệ được xác nhận. 6 RED→GREEN; membership và account phải khớp. |
| Legacy chi lương: nợ phòng null/undefined thay bằng tổng, blank/bad thành0 rồi vẫn ghi phiếu | Đúng invoiceID + financialReadNumber(remaining_amount) trước INSERT; 4 RED→GREEN, không viết phiếu sau read hỏng. |
| `paid=''` thành0 rồi tăng số đã trả | financialReadNumber cho paid/readback; 1 RED→GREEN, không UPDATE salary_monthly sau read hỏng. |
| Trạng thái phiếu lương lạ vẫn hoàn tất và giải phóng marker | Tập approval/posting theo CHECK hiện hữu; voucherID giữ qua pending/remount. 2 RED→GREEN. |
| Query lương: invoice total/remaining thiếu thành0 hoặc tổng | Số bắt buộc qua financialReadNumber; 4 RED→GREEN. Không đổi nullable mặc định của cấu hình cũ. |
| Query v5: staff entry hiện diện null/thiếu money coi không có quyền hoặc0 | Omitted staff key giữ fallback đúng SQL authz; entry hiện diện phải đủ money/ngày chuẩn. 3 RED→GREEN + zero thật hợp lệ. |

P0001 đơn thuần trước positive receipt giữ nguyên identity/code và cho sửa; P0001 kèm503 giữ unknown, không writer thứ hai. Shared guard không cần sửa trong review này. Actor scope/requestKey lock/unlock/tender/settings chặn bypass reload/selector. Tender replay thiếu `to` là shape thực tế SQL20260925082815:664–674; không ép trường backend không trả.

Final focused: **121/121, 13 file**, `.superpowers/sdd/plan/tmp-root-money-cross-review-final.json`; 20 RED→GREEN trong rootMoneyCrossReview và salaryReadSources. Strict sửa sourceIssues retry/nullable fixture và Mobile BatchDetail unknown condition: **41/41, 4 file thật**, `.superpowers/sdd/plan/tmp-root-review-strict-focused.json`; BatchDetailRead2 nằm trong121.

Mutation scripts/dot-bien.mjs đều exit0, suite đỏ đúng ca, restore digest:

| Neo | Trước → đột biến → khôi phục |
|---|---|
| Personal null proof | eb096008bcae → 8bc825504ef7 → eb096008bcae |
| Legacy remaining | 0c256dfcc953 → b63fa92a6329 → 0c256dfcc953 |
| Legacy paid | 0c256dfcc953 → f28bca993b8c → 0c256dfcc953 |
| Salary receipt state | 0c256dfcc953 → 27a25c21d2bb → 0c256dfcc953 |
| Required invoice total | ff27f4eadad6 → a79280a835b0 → ff27f4eadad6 |
| Present v5 money | ff27f4eadad6 → f893fd90f47a → ff27f4eadad6 |

0c256 là trước sửa query; ff27f4 là source cuối. Chưa E2E Preview/role, concurrency đa cửa sổ, RLS/PostgREST thật. TSC strict/app, build và gate tiền cuối do root chạy; focused unit/DOM không chứng minh các gate đó. Không stage/commit/push.
