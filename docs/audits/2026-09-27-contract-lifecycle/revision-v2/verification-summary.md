# Kiểm chứng lần sửa plan V2

Ngày 27/09/2026. Phạm vi: tài liệu thiết kế và HTML quy trình; không sửa ứng dụng/schema/DB. Source HEAD `e498f10d49f3548e72074095c955371d0cee41ab`.

## Kết quả của lượt này

| Kiểm | Kết quả / bằng chứng |
|---|---|
| Rà audit theo source | Đối chiếu đủ 35 IA; ba review theo miền tiền, nháp/cọc và availability. Phán quyết ở [audit-response.md](audit-response.md), không gắn nhãn đã sửa lỗi sản phẩm. |
| Cấu trúc tài liệu | 13 requirement IDs, 35 IA, 55 scenario IDs, 16 task chính + tiểu mục P9.T nhượng. Lượt trước ở [structure-check.json](structure-check.json); lượt rà flow ở [flow-review-check.json](flow-review-check.json); bản sau đính chính B2 kiểm theo [correction-check.json](correction-check.json). Không coi hash cũ là chứng cứ cho bản mới. |
| Toàn docs repo | Lần rà flow: `node scripts/check-docs.mjs` **exit 1**, kiểm358 Markdown, **28 lỗi cũ** ở tài liệu/gói21–23/09. Không sửa ngoài phạm vi để làm xanh. Log mới [docs-check-flow.txt](docs-check-flow.txt), log trước [docs-check.txt](docs-check.txt). |
| Bằng chứng cũ | SHA256 45 file thân hàm lưu bởi reviewer khớp manifest; plan V1 và HTML V03 giữ nguyên byte. Đây là xác minh file trên đĩa, không phải DB sống. |
| HTML V05 trước đính chính B2 | Chromium headless: 1440/768/390/320px không tràn ngang, 5 tabs chuyển được, Home/End/ArrowRight hoạt động, print CSS hiện 5 panel, 2 link tương đối đúng, console/page errors=0. [Log theo hash HTML V05](html-qa-v05.json); đã xem ảnh [hợp đồng mới](html-v05-contract.png) và [khoản còn chờ](html-v05-money.png). Log [V04](html-qa.json)/[ảnh V04](html-v04-example.png) giữ làm chứng cứ lượt trước. |
| Rà flow/quyền/đối soát | [FC01–FC06](flow-control-review.md), hai review đọc độc lập và đối chiếu source: bảng tác động, authority của trigger, nghĩa vụ thu/hoàn song song, lịch sử nối chứng từ, P11a ký+nhận một lần, policy public quá hạn ghi đúng trạng thái đề xuất. Không đổi R01–R13 hoặc quyền/duyệt. |
| Phạm vi Git | Không sửa app/schema/script runtime. Tracked diff vẫn chỉ `docs/doi-chieu/so-quy-686tcb.md` có sẵn từ trước, giữ nguyên; tài liệu/outputs của nhiệm vụ là untracked đã có hoặc bổ sung. Không commit/push/deploy. |

HTML **V06 hiện tại** cập nhật lời giải thích bỏ cọc theo đính chính B2. Kiểm hash, bốn cỡ màn hình, tabs/keyboard/print và console tại [html-qa-v06.json](html-qa-v06.json). Các log V04/V05 giữ làm lịch sử, không chứng minh bản mới.

## Các sửa bổ sung từ rà chéo V2

- IMMEDIATE preview dùng ACTIVE_CONTRACT_EXIT_INTENT trước khi case tồn tại; confirm revalidate rồi tạo case+physical+financial effects nguyên tử.
- Theo xác nhận phạm vi cuối: không tự bổ sung flow hoàn tác trả phòng từ audit. V50 kiểm chặn direct reopen/sai khách, không thêm nút/RPC ngoài13 yêu cầu gốc và mở rộng nhượng.
- Ký nhận ngay consume LIVE claim cùng transaction, unique draft→contract và exact reservation conversion; không để next claim của người đã vào phòng còn sống.
- E6 là họ thông báo chốt sổ tiền mặt, lifecycle phải có family/validators riêng. Migration template cũ khai báo private; getPublicUrl không chứng minh live bucket public.
- Tách fixture H3a cho P7 khỏi reservation/draft/signing chưa xây; H3b mới mở rộng sau P9/P11a. Refund TUNG_PHIEU không bị bắt tạo spend lines giả để test xanh.
- Đã đối chiếu lại bản trước audit; R01–R13 trong master giữ **nguyên văn**. Chọn loại từ bước đầu; khi quyết toán được đổi có lịch sử. Tiền/duyệt giữ nguyên; theo đính chính mới nhất, bỏ cọc giữ cả cách xử lý/hủy hóa đơn nợ và credit hiện hành. Chỉ nhượng EX01/P9.T là phần mở rộng mới. [Bảng đối chiếu phạm vi](scope-alignment.md).

## Giới hạn và phần còn mở

**Chưa chạy trong lượt này:** DB/catalog query mới, migration/backfill, real JWT, money/reconcile, lock races, cron delivery, CRM E2E, DOCX renderer hoặc PDF pagination. V01–V55 đều **PLANNED**, không phải 55 test đã pass. HTML QA chỉ chứng minh artifact sơ đồ, không chứng minh CRM đã có tính năng.

Logs baseline của reviewer: 20 files/496 tests sau exclude outputs; 6 files/259 bổ sung có phần trùng. Không cộng thành 755 unique tests và không nhận là lần chạy mới của tác giả V2. Probe TEST lưu sẵn chứng minh thêm phiếu hoàn chưa duyệt, direct status update và deadlock mô phỏng; không chứng minh production đã chi trùng.

**Không còn yêu cầu chủ chọn lại nghiệp vụ tiền đang đúng.** B2 đã được chủ mô tả rõ; các đề xuất đổi B3/N2 đã rút, giữ cơ chế hiện hành. Phần cần kiểm là call path/baseline thật và khả năng nối adapter, không phải phép tự sửa policy. P11b là đề xuất D03 đã có từ bản trước audit, vẫn chưa tự bật; không chặn các yêu cầu đã chốt. Runtime gates còn mở; xem [decisions.md](decisions.md).

**Đính chính B2 sau rà flow:** chủ xác nhận mô tả giữ nợ trước đó là nhầm, giữ nguyên flow cũ. FC02 giữ bằng chứng trace nhưng rút kết luận bất nhất cần sửa; không có task thay bỏ cọc thành giữ nợ. Chưa chạy parity TEST; phần cần kiểm là adapter giữ kết quả tiền/quyền cũ và không chạy lại phần phòng khi chốt muộn. Kiểm tài liệu/sơ đồ sau đính chính tại [correction-check.json](correction-check.json).
