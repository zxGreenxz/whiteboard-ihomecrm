# Tối ưu màn Hợp đồng & quyết toán

## Goal và giới hạn

Thực hiện kế hoạch người dùng duyệt ngày 22/09/2026, chỉ màn Hợp đồng & quyết toán thuộc `/thanh-toan`, hai tab Khoản chi/Biến động và hai modal. Base `2932d65fa520194d471c37485cc5edd93c3b3df6`. Giữ desktop, bố cục, luật ngày ghi sổ/tiền/quyền; không thêm RPC, migration hoặc sửa writer Thu chi. Production chỉ đọc; E2E ghi DEMO và dọn fixture. Review độc lập và draft PR trước main.

## Task 1: Đường đọc và cache khoản chi

- Chạy D1–D3 song song với D4 items; giữ bốn dấu nhận phiếu, dedupe UUID, không cắt ngày phiếu cho current/all.
- Cache raw current/all theo org+tòa+điều kiện DB thực; prior có cutoff. Hỗ trợ contractId/voucherId tùy chọn để modal đọc riêng mọi kỳ, qua cùng RLS.
- Căn cứ hoa hồng từng kỳ có query key riêng gồm org+tòa+kỳ, giới hạn tổng 4 request đồng thời. Loại mã phiếu trùng khỏi hydrate thừa, batch ID có giới hạn.
- Hiện base rows trước enrichment; `SettlementRow.validationState?: 'loading' | 'ready' | 'error'` do hook gán thực tế. undefined chỉ dành compatibility fixture/caller cũ. Trả `isEnriching`, `enrichmentError`, refetch đủ các nguồn.
- Khi căn cứ/supplement chưa đủ, dòng không được đủ điều kiện duyệt/chi. Giữ khác biệt thiếu căn cứ hợp lệ (warning) và nguồn tải lỗi (blocker).
- TDD: concurrent branches, max 4, cache current/all và từng kỳ, ngày chi khác ngày phiếu, 4 nguồn trùng/manual vouchers, partial errors, targeted modal query.

## Task 2: Vòng đời và danh sách biến động

- Chỉ termination APPROVED/COMPLETED có hiệu lực; đưa status qua boundary. DRAFT/PENDING không đóng lane hoặc biến phòng thành trống. Contract TERMINATED thiếu audit vẫn đã thanh lý, số quyết toán thiếu dữ liệu.
- Nhãn `Công nợ đưa vào quyết toán` ở band và mô tả biến động giữ số input. Không tự tính lại tiền.
- useContractMovements thêm `enabled?: boolean` default true; fetchAllRows stable date+id thay caps 400/200, lỗi nhánh không thành rỗng.
- Song song các nguồn vòng đời độc lập, giữ RLS/org/target contract và fail-closed.
- TDD: bốn status, bản nháp mới hơn bản effective, terminated thiếu audit; nợ trước cấn khác nợ sau; >400/>200, lỗi trang sau, enabled false.

## Task 3: Hai modal

- MovementLifecycleModal thêm `readState: 'loading'|'ready'|'error'` và `onRetry` cho khoản chi liên quan. Tổng chưa xử lý dựa review/pending/approved; cancelled/reversed/noncash không tính; unknown báo chưa xác minh, không thành 0.
- SettlementLifecycleModal: idempotency key mỗi logical supplement command, retry cùng payload giữ key, command khác/đổi phiếu dùng key mới.
- Async completion chỉ cập nhật/đóng đúng voucher + attempt; reset state theo voucher. Chặn financial action nếu row.validationState là loading/error.
- Sổ quỹ loading/error/empty riêng và retry; shared reader chỉ sửa tối thiểu nếu cần, không writer/migration.
- TDD: request→done trong cùng modal; ambiguous retry; đổi row trong mutation; trạng thái phiếu hỗn hợp; nguồn sổ và liên quan loading/error.

## Task 4: Tích hợp page, loading, realtime và parent

- Root sở hữu ContractSettlementSection và useSettlementActions: gate tab, targeted data modal độc lập filter; mở phiếu bằng UUID. Lazy hai modal với loading shell đóng được.
- Query org-of-buildings có loading/error/retry đúng. Không in số 0/thẻ đủ điều kiện khi chưa đủ nguồn; thông báo enrichment ngay trên page.
- Biến động phân trang UI 50 dòng, tổng/tìm kiếm trên đầy đủ. Chỉ hỏi cancel eligibility cho phiếu cần thao tác.
- Hoãn hook phí khác trong parent khi đang CONTRACT_SETTLEMENT, giữ menu/badge/layout/default các caller khác.
- Realtime chỉ thêm dependencies khu contract-settlement vào hub, gộp prefix invalidation trùng trong burst; không redesign global cache/prefetch.
- TDD: tab chưa mở không fetch, modal độc lập filter, pagination, org error, readiness/financial guards, realtime nhiều bảng một burst.

## Task 5: Review, kiểm chứng và phát hành

- Baseline: 282 tests tại SHA production; HTTP một lượt 282 phiếu/750558 bytes trước dedupe, 9 kỳ căn cứ. Build static closure ThanhToan 1395942 bytes / 422703 gzip. Đây không phải browser latency.
- Chạy targeted tests, typecheck baseline, build/bundle, gate tiền v1+v2, kiểm đột biến invariants liên quan, gate trước push và review độc lập.
- Browser: cold/warm, tab/filter/modal, console/network, đúng SHA. E2E writes DEMO; nếu browser/credential bị chặn ghi đúng giới hạn, không tuyên bố đã đạt.
- Commit trailer Codex, stage file cụ thể, rebase origin/main; push feature branch và draft PR có bằng chứng. Chỉ promote khi mọi gate của đúng SHA đạt.

## Yêu cầu bổ sung

Bỏ khối “Ghi chú gốc của phiếu” khỏi modal theo yêu cầu người dùng. Giữ dữ liệu notes trong DB, bảng căn cứ và lịch sử bổ sung.
