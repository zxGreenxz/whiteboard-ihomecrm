# Review độc lập phần ứng dụng

Ngày: 2026-09-21. Phạm vi review: commit `5cc612c5938ecdce642af1bf6f0059dfbaa302a2`, base `718a04b59b2734a5b58695b437019bb54d1d2b7f`, đích ứng dụng `beca6ee8cd0628f2a210918657bdeec09dc45997`.

Đã đọc AGENTS.md, Project Contract, risk-map và task-1-report.md. Không review SQL, không ghi production, không sửa source/config, không commit/push. Trong lúc review có agent khác sửa tooling/E2E trên cùng worktree; các finding dưới đây áp dụng cho commit cố định, không khẳng định chúng vẫn còn sau follow-up.

## Kết luận

Khôi phục `src/**` chính xác, không phát hiện khác biệt ứng dụng so với mốc được chỉ định. Commit riêng này còn thiếu đồng bộ integration ngoài `src`; cần hoàn tất các finding dưới đây trước phát hành. Chưa xác nhận ứng dụng hoạt động trên database sau phục hồi.

## Finding

### P1 — Danh sách strict vẫn trỏ tới 49 file đã bị xóa

- Vị trí: `tsconfig.strict-islands.json:19` và các entry kế tiếp; baseline tương ứng `tooling/strict-islands-baseline.json`.
- Commit vẫn giữ danh sách `IncomeExpenseActionButtons.tsx`, `IncomeExpenseActionDialogs.tsx`, `ContractSettlement*`, `useIncomeExpenseActions.ts`, v.v., trong khi commit đã xóa chúng.
- Bằng chứng trực tiếp trước follow-up: `npx tsc --noEmit -p tsconfig.strict-islands.json --pretty false` thoát 1 với TS6053; kiểm số file không tồn tại trong `files` trả 49. `.github/workflows/ci-gates.yml:446` chạy gate strict, nên typecheck app/build xanh của task-1 không đủ chứng minh CI phát hành xanh.
- Hành động: bỏ đúng entry đã xóa khỏi config và baseline theo việc gỡ feature có chủ ý, đồng thời đưa module cũ phục hồi như `PeriodCommissionModal.tsx` về mức kiểm trước đó. Không bỏ cờ strict hoặc nới sàn/baseline lỗi. Đây là lỗi tích hợp do chỉ phục hồi `src`, không phải lỗi có sẵn của mốc cũ.

### P2 — E2E trang Thanh toán vẫn đòi giao diện quyết toán đã gỡ

- Vị trí: `.e2e-fleet/specs/thanh-toan-page.spec.ts:26` và `.e2e-fleet/specs/contract-settlement.spec.ts:11`.
- Spec còn tìm `.ptt-settlement-panel`, `.contract-settlement`, tab `Khoản chi`, nhãn `Hợp đồng & quyết toán`; mã nguồn đích đã quay lại các danh mục cũ. Đây là oracle kiểm thử sai với sản phẩm sau phục hồi, làm luồng E2E liên quan thất bại và không kiểm được kỳ vọng cũ.
- Hành động: phục hồi spec trang Thanh toán theo mốc cũ; gỡ/adapt spec dành riêng feature đã xóa rồi chạy browser headless cho luồng desktop/mobile và vai trò bị ảnh hưởng. Không tính việc xóa spec là bằng chứng E2E đã đạt. Đây là thiếu sót integration của restoration.

## Bằng chứng phạm vi và phụ thuộc

- `git rev-parse beca6ee8:src 5cc612c5:src` cho cùng tree hash `80c56900df88b97ac25c270578f25fab71b5b8d2`.
- `git diff beca6ee8 5cc612c5 -- src` rỗng; kiểm working source vào cuối review vẫn rỗng.
- `git diff --numstat 718a04b5 5cc612c5 -- ':!src'` rỗng: commit không đổi dữ liệu, SQL, migration history hoặc deployment/tooling.
- Đối chiếu đích và commit: không có diff trong `package.json`, lockfile, `vite.config.ts`, `vercel.json`, `index.html`, `public`, `api`, `supabase/functions`, `infra`, `services`, `worker`, `docs/he-thong`. Không phát hiện phụ thuộc runtime ngoài `src` bị bỏ sót trong các vùng này.
- Các RPC đọc ghi chú cũ được phục hồi đúng: `get_termination_refund_facts_v1` tại `src/hooks/useTerminationRefundFacts.ts:26`, `get_commission_voucher_facts_v1` tại `src/hooks/useCommissionVoucher.ts:33`. Sự tồn tại/quyền/nội dung các RPC trên database đích thuộc review tích hợp database của agent chính, chưa được xác nhận ở đây.
- Generated types được đưa về snapshot cũ cùng cây source. Sau khi chốt catalog database cần chạy generator/normalizer/check theo Contract §6; không dùng tính bằng nhau của snapshot cũ làm bằng chứng types khớp database còn giữ dữ liệu.

## Ghi chú UI và lỗi có sẵn

- Ghi chú thanh lý phục hồi dòng đầu, thông tin hợp đồng, cọc đã thu, danh sách phiếu thu cọc và khung tổng hợp. Ghi chú gốc vẫn hiện trong `details`; không có hành động xóa/chỉnh ghi chú lưu DB trong thay đổi hiển thị này.
- Ghi chú hoa hồng phục hồi các dòng hợp đồng, giá phòng, cọc, mốc 7 ngày và người đại diện; ghi chú gốc tiếp tục hiển thị. Các hành vi này đúng đích được yêu cầu.
- Câu “CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được” tại `src/lib/terminationRefundNote.ts:153` là nguyên văn mốc cũ. Trang Thu chi ở cùng mốc đã có nhánh V2 duyệt-only (`IncomeExpensePage.tsx:536`), nên câu này không mô tả chính xác mọi nhánh CANONICAL. Đây là giới hạn đã có ở mốc khôi phục, không phải restorationintroduced; không mở rộng yêu cầu thành thiết kế lại.
- Cách fallback số thiếu về 0 và fallback khoản thu thêm từ item cũng là hành vi cũ đúng snapshot. Review này không chứng minh tính đúng của các giá trị suy ra với toàn bộ dữ liệu thực.

## Kiểm chứng độc lập

- `npx vitest run src/lib/__tests__/terminationRefundNote.test.ts src/lib/__tests__/commissionVoucherNote.test.ts src/components/income-expenses/__tests__/reservationDetailActions.test.tsx src/lib/feeCategories.test.ts`: 4 files, 43 tests đạt. Có cảnh báo React Router và Radix description, không có test thất bại.
- Direct strict tsc trên cấu hình ban đầu: thất bại như finding P1.
- `node scripts/check-raw-rpc-callers.mjs`: thoát 0, 108 lời gọi thô / 141 file high-risk, không có caller mới.
- Lệnh wrapper `node scripts/check-strict-islands.mjs` kết thúc exit 0 trong lúc worktree được agent khác thay đổi (1305 strict / 583 strict+noUncheckedIndexedAccess). Không dùng lần chạy có thay đổi đồng thời này để chứng minh commit ban đầu hoặc SHA tích hợp cuối cùng đã đạt; cần kiểm lại trên cây đã chốt.
- Không chạy lại build/app typecheck vì task-1 đã ghi bằng chứng tương ứng, và review tập trung kiểm exact tree cùng integration bị bỏ sót. Không chạy browser E2E, không kiểm console trình duyệt thực, không kiểm dữ liệu production hoặc SQL. Bảo toàn dữ liệu và tính tương thích database chưa được chứng minh bằng review ứng dụng này.
