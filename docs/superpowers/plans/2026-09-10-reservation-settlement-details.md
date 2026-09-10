# Thông tin bỏ cọc và chứng từ hoàn tiền

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. User requested implementation of these additions to the already approved settlement feature.

**Goal:** Hiện người xử lý trên phiếu phát sinh, kết quả bỏ cọc ngay trong chi tiết phiếu thu và ảnh chuyển khoản trên cả phiếu hoàn tiền lẫn thông tin xử lý phiếu gốc.

**Architecture:** Giữ nguyên các số tiền và lịch sử phiếu gốc. Tóm tắt trực tiếp từ hồ sơ xử lý và phiếu hoàn tiền liên quan; không chép một ghi chú cố định dễ sai sau hoàn tác. Lưu ảnh cùng giao dịch hoàn tiền bằng RPC hiện hữu, dùng thêm trường tùy chọn `refundAttachments: string[]`; ảnh rỗng hợp lệ. Hiển thị tên người xử lý từ actor của phiếu phát sinh, giữ đúng người tạo phiếu gốc.

**Tech Stack:** React, React Query, React Hook Form/Zod, Supabase PostgreSQL, uploader dùng chung (bucket chứng từ hiện ở Supabase Storage).

## Constraints

- THẬT chỉ đọc; mọi kiểm thử ghi dùng local hoặc DEMO với fixture tự dọn.
- Không sửa migration đã áp dụng. Migration mới cấp tên qua script, idempotent hai lần và review trước apply có backup.
- Không đổi logic tiền, quyền, idempotency, nhận cọc vào hợp đồng hoặc giải phóng phòng.
- Không backfill sổ THẬT: phiếu đã phát sinh thiếu creator_name dùng fallback theo user_id khi đọc.
- Giao diện desktop/mobile; khung thông tin và nút không làm co hẹp nội dung mobile.

## Task 1: Backend lưu chứng từ đồng thời với hoàn tiền

Files: new forward migration, `scripts/test-reservation-deposit-settlement.mjs`.

Interface: `settle_reservation_deposit_v1` và `pay_reservation_refund_v1` nhận `p_input.refundAttachments?: string[]`, mặc định rỗng. Settle chỉ chấp nhận ảnh khi mode NOW; LATER/NONE không ghi ảnh. Ảnh lưu trong `income_expenses.attachments` của phiếu REFUND trong cùng transaction. Request hash bao gồm ảnh. Giữ chữ ký RPC để client cũ chạy được. Creator name cho cả ba loại phiếu là tên actor thực hiện; không đổi creator gốc.

- [x] Viết test thiếu trường, nhiều ảnh, hoàn ngay/toàn bộ/một phần, hoàn sau, retry cùng payload không thêm phiếu, đổi ảnh cùng key bị chặn, đầu vào sai bị rollback.
- [x] Chạy test đỏ trên bản cũ rồi thay hàm qua migration tiến idempotent; giới hạn số lượng/độ dài, kiểm kiểu và storage reference, không nhận script/data URL.
- [x] Test chạy thật SQL và hai lần migration ROLLBACK, báo số đo và commit riêng.

## Task 2: Giao diện, tên người tạo và ghi chú trực tiếp

Files: settlement/refund dialogs, form/DTO schemas, `AttachmentUpload`, settlement hooks, income expense queries, voucher desktop/mobile details; component mới `ReservationSettlementDetails`.

- [x] Test trước: lưu đủ URL trong NOW/pay; bỏ URL khi LATER/NONE; vô hiệu xác nhận khi upload hoặc ghi đang chạy.
- [x] Dùng uploader có sẵn cho ảnh chuyển khoản (chọn/kéo/dán), trường không bắt buộc; giữ ảnh khi RPC lỗi/retry, reset khi mở hồ sơ mới.
- [x] Khung trực tiếp dưới thông tin chung: “Khách đã bỏ cọc”, cọc ban đầu, giữ lại thành doanh thu, đã hoàn/còn phải hoàn, ngày/người xử lý, lý do, phiếu liên quan và chứng từ hoàn. Hoàn tác phải hiện đang chờ và phân biệt ảnh phiếu đã hoàn tác.
- [x] Tên creator thiếu trên phiếu reservation được hydrate theo user_id theo batch; phiếu gốc giữ creator thật.
- [x] Dùng chung khung cho desktop/mobile và lịch sử nếu thích hợp; sửa vị trí nút mobile để không thành cột ngang.
- [x] Chạy Vitest liên quan, TypeScript, build và kiểm bundle; kiểm đột biến cho nhánh ảnh/refund.

## Task 3: Xác minh và phát hành

- [x] Rà độc lập diff backend và frontend, sửa lỗi thực có bằng chứng.
- [x] Kiểm trình duyệt headless DEMO/local: tên creator, tóm tắt ở chi tiết không mở lịch sử, upload/thumbnail/click ảnh ở hai phiếu, cả mobile và desktop, giữ nguyên tiền/idempotency.
- [x] Gate theo Contract; migration chỉ apply reviewed bytes qua lane backup; PR/diff có số đo. Chờ CI xanh, promote rồi xác minh production, dọn fixture.

## Progress

- Started from b4ea4b70 in isolated worktree. GitNexus freshness passed; source + SQL harness supplement eight new files absent from the initial graph.
- SQL 50/50 passed in the integrated root; independent backend review approved SHA256 91bf3d5206d8159b12855f8b2f438f85eb5d4fc42280c1736e8243cfa56daa51. Actual storage object locks/binding fix NULL-org quarantine visibility; R2-only/phantom references rejected.
- Reviewed migration applied 2026-09-10T02:29:36.055Z after double ROLLBACK and full backup (523 tables / 27.8 MB, receipt 97b3a862c0a88191). No THẬT business-data writes.
- Headless local app + real DEMO: 2/2 passed in 23.7s. Both screens upload an actual PNG, freeze fields while uploading, save/preview proof on both vouchers and open/close lightbox. Second accounting staff login signs and renders the same private proof. Owned uploads and fixtures cleaned.
- Browser caught mobile portal click closing the parent detail; reproduced red, fixed direct-backdrop target check, independent scoped review clean, same two cases green. Initial login interruption and initial unscoped Vitest runner failure are not counted as passing verification.
- PR #59 merged; released runtime `045830ee86d29c660a8162b0a88891de47567189`. Main CI Gates 34431457696 passed (469 files / 7,299 Vitest; 620 Node tests), restore 34431457578 passed on PostgreSQL 17.6, and migration validation 34431457618 passed. Promotion verified 13 jobs / 123 steps before updating production.
- Vercel `dpl_HtRyBa2wv3t84KCgfKM9wDYKLWJy` READY on production. Public ptcrm.vercel.app headless DEMO E2E checked that exact build SHA: 2/2 passed in 36.5s. Reconcile V1/V2 and sandbox after release passed. Independent cleanup: 0 rooms, 0 vouchers, 0 storage objects and 0 storage links; ownership guard remains ENABLE ALWAYS. Production CI Gates 34431998373 and restore 34431998350 passed.
- Restore drill now includes platform Storage metadata, native FK and closed RLS; existing applied SQL remains unchanged. Fresh full forward replay: 209 files / 173 clean / 36 expected stops / 0 drift, plus clean restored security checks; real shim regression and related unit tests 23/23, two FK/RLS mutations detected. Independent review approved the bounded harness fix.
- Owned Vite and PostgreSQL helpers stopped; database files and evidence preserved. Subsequent checklist/runbook edits are documentation only and do not require a second application deployment.
