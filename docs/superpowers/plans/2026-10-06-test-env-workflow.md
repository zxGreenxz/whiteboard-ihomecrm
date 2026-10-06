# TEST workflow Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; independent owner/media/browser work uses superpowers:dispatching-parallel-agents. Final independent review follows Project Contract §3.

**Goal:** Một lệnh thử đúng mã nguồn với dữ liệu TEST, có kiểm quyền, Chrome, chống chạy chồng và biên nhận dọn fixture.

**Architecture:** `test-env:check` giữ advisory lock TEST xuyên suốt. Chế độ nhanh dùng snapshot đã đạt còn mới; `--sync` tạo snapshot mới trước khi chạy. Chrome build chính worktree lên loopback bằng public config TEST, kiểm SHA và chặn request production. Đồng bộ giữ nguyên owner/ACL custom roles từ cùng snapshot; app TEST không fallback ảnh sang production.

**Tech Stack:** Node ESM, PostgreSQL 17 client, Vitest, Playwright Chrome, Vite.

## Constraints / thiết kế đã được user duyệt

- Production chỉ đọc; TEST ref được xác nhận qua database marker và Management API hiện có.
- Vault duy nhất ở checkout chính; không ghi token, password, browser storage state vào artifact.
- TEST chung dùng một lock cho sync, check, thu-sql và JWT harness. Không đồng bộ trong lúc test.
- Không đưa sync nặng vào mọi lần CI; chạy CI tĩnh song song được, promotion vẫn chờ CI đúng SHA theo lane hiện có.
- Snapshot là bản chụp một thời điểm, không tuyên bố luôn giống production đang thay đổi.
- Không copy byte ảnh; không chứng nhận R2/Edge/SMS chưa thực sự test.
- Bản web kiểm ở loopback của đúng worktree tránh phụ thuộc Vercel SSO; Preview test-env dùng để kiểm deployment riêng.

## Tasks

- [x] Owner restore: thêm `owners.mjs`, capture qua `xuat.mjs`, prepare/restore qua `khoi-phuc.mjs`; tests phản chứng role nguy hiểm và ACL sai.
- [x] Shared lock + receipt: thêm `lock.mjs`, `check.mjs`, helper policy; refactor sync export và thu-sql/harness dùng chung lock; test busy/lost/forged lease, receipt thiếu/lệch/cũ, empty suite.
- [x] Chrome lane: `chrome.mjs` build đúng SHA, login TEST, smoke, lifecycle fixture, network và console evidence, cleanup cả khi fail; chạy tuần tự.
- [x] Media isolation: sửa storage URL boundary + render fallback TEST, tests production unchanged và không gọi origin production.
- [x] Update README, DATA_ENVIRONMENTS, Contract §8, npm commands và test-matrix.
- [ ] Unit RED/GREEN, mutation guard, full sync thực tế, JWT + Chrome, gate:truoc-push; đọc diff cuối và gate receipts bởi reviewer độc lập.
- [ ] Commit, push branch và draft PR vì thay đổi owner/ACL; báo kết quả, timing và giới hạn. Không tự coi draft PR là đã phát hành production.

## Acceptance

Full sync phải đối chiếu snapshot catalog/data không lệch ngoài khác biệt đã được code hiện tại công bố. Biên nhận chứa SHA, schema digest sau hậu kỳ, thời điểm snapshot, các bước/timing và cleanup. Quick không chấp nhận lịch sử LECH, schema đổi, snapshot quá hạn hay suite rỗng. Bất kỳ kiểm bắt buộc hoặc cleanup thất bại đều exit khác 0. Lỗi đang chạy phải giữ bằng chứng; dump nhạy cảm vẫn được xoá.
