# Thu chi cá nhân: chọn ví và giữ ảnh chứng từ

**Goal:** Sửa chọn ví từ chữ/giọng nói/ảnh và lưu, xem, thêm, gỡ ảnh giao dịch cá nhân.
**Architecture:** Bộ chọn ví xác định ở client theo dữ liệu của chủ ví; AI chỉ cung cấp bằng chứng phương thức/nền tảng. Ảnh lưu bucket private theo owner, giao dịch lưu path, RPC hiện có giữ atomic/idempotency/version.
**Tech Stack:** React/TypeScript/Vitest, Supabase PostgreSQL/Storage.

## Global Constraints

- Trả lời tiếng Việt. Đọc Project Contract một lần và tối đa một runbook cần thiết; không đọc plan/audit lịch sử.
- Worktree này ở `../codex-worktrees/thu-chi-vi-va-anh`, giữ WIP checkout chính. Chỉ stage file cụ thể, trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- Org thật chỉ đọc. Schema chỉ forward lane có bằng chứng, không sửa migration đã áp dụng. Không đọc/in secret để kiểm thông thường.
- TDD cho thay đổi hành vi tiền/quyền; focused tests rồi gate theo staged diff. Theo Contract, review độc lập một lần trên diff cuối + receipts; không lặp kiểm đầu vào không đổi.
- Quy tắc người dùng: thiếu chỉ định ví và không có bill chuyển khoản => tiền mặt; bill chuyển khoản => ngân hàng mặc định rồi ngân hàng đầu tiên; Shopee/Grab (mọi dịch vụ) => ví tên Thẻ SP. Chọn tay/chỉ định ví rõ ưu tiên cao hơn tự động.
- Giao dịch cũ và pending payload không bị đổi ví, số tiền hay tự backfill ảnh. Ảnh cũ không được lưu phải đính lại.

## Task 1: Chọn ví theo nội dung, nền tảng và bill

### Requirements

- Phạm vi implementation: `src/lib/quickEntry` compose/personalRefs/draft/aiSchema/prompt + tests; `src/hooks/quick-entry/useQuickEntryFeed.ts` + tests; nhãn lý do ví trong `DraftCard`; defaults ví khi tạo mới `FinanceEditor`/transactionInput nếu cần. Không sửa schema DB hay attachment code của Task 2/3.
- Tạo bộ resolver riêng trong quickEntry với input danh sách ví (id/name/kind/hidden/is_default), nguồn chữ, evidence ảnh và lựa chọn/lock hiện có; output ví hoặc null cùng reason. Chuẩn hóa hoa thường/dấu/khoảng trắng; chỉ match tên ví đầy đủ có boundary, không đoán theo đuôi tài khoản.
- Ưu tiên: (1) chọn tay/touched; (2) tên ví/phương thức được chỉ rõ trong chữ hoặc caption; (3) Shopee/Grab trong câu/ảnh => ví Thẻ SP; (4) chứng từ chuyển khoản => bank default/first; (5) cash default/first. Các ví được tự chọn phải không hidden. Không có ứng viên đúng loại/tên hoặc tên explicit mơ hồ => null, hiển thị yêu cầu chọn; không fallback sang loại khác. Với Thẻ SP match duy nhất tên đã chuẩn hóa, không tạo ví mới.
- Shopee gồm Shopee/ShopeeFood; Grab gồm Grab/GrabFood/GrabExpress/GrabBike/GrabCar và cách viết có khoảng trắng. Nhận diện lời nói sau STT như các kênh chữ. Không vì câu chỉ có 'đồ ăn' mà chọn Thẻ SP. Không suy từ đoạn chỉ nhắc phủ định ('không đi Grab', 'không phải Shopee') nếu không có chi thực tế trên nền tảng.
- AI trả optional evidence `payment_method` (cash/bank_transfer/null) và `platform` (shopee/grab/null); thiếu field vẫn đọc kết quả cũ. Chỉ ảnh có bằng chứng chuyển khoản đã thực hiện mới bank; logo ngân hàng/QR/STK trên hóa đơn thường không đủ. Platform đọc từ nguồn ảnh/nội dung thực; không dùng output bịa ID. Explicit text cash giữ ưu tiên hơn evidence/platform.
- Áp ví theo từng khoản trước grouping, nhóm personal theo ví + thu/chi. Một câu chứa 'Grab 50k; đổ xăng 100k tiền mặt' ra đúng hai ví. Không đổi thẻ saving/unknown. Sau AI tách thẻ giữ ví manual của mẹ và mỗi thẻ mới có id/request key riêng. Hỗ trợ image caption rõ ví; state photo giữ sourceText caption.
- Không để resolvePersonalDraft tái điền ví mặc định khi null là kết quả cố ý chưa xác định. Thêm metadata resolution optional vào DraftState/QuickDraft phù hợp và schema persistence; legacy/current pending giữ nguyên.
- Hiển thị lý do ngắn cạnh dropdown: theo nội dung, Shopee/Grab, bill chuyển khoản, mặc định tiền mặt. Người sửa tay đổi reason tương ứng hoặc ẩn lý do cũ. AI về muộn không đè lựa chọn.
- Nhập tay mới mặc định cash bằng cùng helper; khi sửa giao dịch giữ ví hiện có. Thay đổi chỉ tại luồng cá nhân.

### Test cycle / deliverable

- [ ] Viết regression fail trước: bank Tk939 default + cash + Thẻ SP; cash explicit/missing => cash; Grab/Shopee từng dịch vụ/chữ/AI ảnh => SP; ghi rõ ví khác thắng platform.
- [ ] Test ảnh thường có QR không thành bank, transfer => bank default/first, missing/hidden/duplicate SP => require select, platform từng dòng không lan dòng khác, manual edit muộn và intentional null sau refs reload.
- [ ] Chạy focused compose/prompt/schema/personalIntegration/hook/DraftCard tests với vitest; sửa test kỳ vọng cũ chỉ khi hành vi đã đổi được spec này yêu cầu.
- [ ] Commit đúng file, báo TDD red/green và output vào task report. Không push/deploy, không chạy full gates (root tích hợp).

## Task 2: Contract và database ảnh cá nhân

### Requirements

- Tạo forward migration timestamp qua script repo; `personal_transactions.attachment_paths text[] NOT NULL DEFAULT '{}'`. Whitelist RPC apply nhận trường mới, snapshot/receipt giữ contract cũ cộng thêm field; request/version/idempotency signatures giữ nguyên.
- Private Supabase bucket `personal-finance-attachments`: owner prefix `${ownerId}/${uploadId}.ext`, owner-only SELECT/INSERT, restrictive fences để policy permissive khác không mở quyền. Cấm client UPDATE/DELETE object; gỡ là unlink. Chỉ ảnh MIME được hỗ trợ và <= 5 MiB. Array giao dịch <=20 paths, tồn tại đúng bucket với owner đúng; cấm URL hoặc path ngoại lai.
- Client contract `attachment_paths?: string[]` input; output default [] khi thiếu để receipt cũ replay được. Không thêm default input khiến payload pending cũ đổi. Update transactionInput/transactionChanges/batch conversion và giữ mảng đúng thứ tự khi retry. Omit giữ ảnh, [] chủ ý xóa liên kết.
- Harness database apply forward migration mới và mutation harness mutate final logic thực, không che mutant bởi override migration. Không sửa migration cũ.
- Test owner/cross-owner, invalid paths, batch rollback, atomic/version/replay cũ, concurrent edit; kiểm mutation tiền và quyền.
- DB thử dùng một lần, không ghi org thật. Types/surfaces/provenance theo generator chuẩn khi đích đã xác minh.

### Test cycle / deliverable

- [ ] Thêm tests fail cho contract roundtrip/missing/output default/input omission và database invalid/foreign paths.
- [ ] Implement migration và contracts.
- [ ] Chạy focused tests, database harness và mutation harness phù hợp; report phần TEST JWT/Storage chưa chạy nếu thiếu môi trường.
- [ ] Commit file cụ thể sau checks và giữ evidence đầu vào không đổi.

## Task 3: Upload và UI ảnh từ nháp tới chi tiết

### Requirements

- Tạo personal attachment service/UI wrapper dùng uploadFileDetailed với evidence compression, maxBytes 5*1024*1024, resilient AbortSignal và actual returned path; image-only, <=20 files. Không truyền bucket mới vào AttachmentUpload cũ mà giữ default deleteOnRemove=true.
- `QuickDraft.personalAttachmentPaths?: string[]` riêng đường cá nhân (company attachmentUrls giữ contract riêng); metadata pending local ảnh cho reload. Giữ photo File trong personal card tới khi upload; upload xong ghi paths vào draft trước prepare mutation. Một ảnh split nhiều dòng dùng cùng path. Nếu upload lỗi chặn save và cho retry, không im lặng bỏ ảnh.
- Retry/pending recovery khôi phục attachment_paths và cùng request key/payload; không upload lại paths đã biết. Reload khi File chưa upload mất thì giữ marker, yêu cầu đính lại hoặc gỡ chủ ý, chặn save thiếu chứng từ. Không lưu File/blob vào localStorage.
- FinanceEditor transaction tạo/sửa: thumbnails, lightbox qua ký URL private, add/unlink theo create/edit perms, status loading/error rõ. Giữ array trong form; compare nội dung path arrays; omit ảnh khi sửa trường khác. Gỡ chỉ áp khi Save; Cancel giữ DB nguyên. Cấm auto physical delete/overwrite và GC ngoài scope.
- Result upload gắn đúng owner và editor instance/card còn sống; đổi tài khoản/đóng editor không gắn completion về chỗ khác. Save khóa khi upload hoặc pending unknown. Retry giữ exact request.
- Ảnh signed URL chỉ dùng hiển thị, không lưu DB; không fallback public khi ký lỗi. UI error/retry cho ảnh không tải được.

### Test cycle / deliverable

- [ ] Regression fail cho photo personal -> upload -> batch paths và details display; giữ ảnh lúc sửa notes; add/remove/save/cancel; upload failure/late result/permission denied.
- [ ] Implement service/wrapper, hook, conversion, recovery, validation, form.
- [ ] Focused tests gồm feedStorage, QuickEntry feed/save, FinanceEditor/permissions, attachment service/UI; mobile browser smoke và console/screenshot.
- [ ] Commit file cụ thể và report evidence.

## Task 4: Final integration, review và release readiness

- [ ] Stage đúng file và chạy `npm run gate:truoc-push -- --plan`, rồi gate cho plan; không rerun receipts xanh đầu vào không đổi. Build/bundle tại CI một lần.
- [ ] Review độc lập cuối diff + receipts (Contract override per-task review ritual), sửa và chỉ re-review phần sửa.
- [ ] Fetch/rebase origin/main trước tích hợp; conflicts source sửa tay, generated theo main + generator. Draft PR vì tiền/schema/quyền, attach PR vào chat.
- [ ] Chỉ apply schema qua lane có backup/digest/SHA review và đủ evidence; kiểm external controls trước production lane. Nếu thiếu bằng chứng thì giữ draft PR rõ phần chưa xác minh, không gọi chưa đo là pass.
