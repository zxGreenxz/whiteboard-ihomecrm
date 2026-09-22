# Kế hoạch sửa modal Hợp đồng & quyết toán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Theo dõi bằng checkbox; không mở rộng phạm vi khi chưa trao đổi với người dùng.

**Trạng thái:** Đã cập nhật kế hoạch, chưa triển khai. Người dùng đã chốt: việc chưa xong có Kỳ hiện tại / Tồn Cũ / Tất Cả; Đã chi chỉ có Kỳ hiện tại / Tất Cả. Sau khi được giải thích, người dùng đồng ý bổ sung cả hai lỗi ngày chi mặc định UTC và HHMG bị xếp nhầm Hoàn khách bằng yêu cầu “okie bổ sung cho tôi”. Hai mục này đã thuộc phạm vi plan; các mục còn lại ở mục 7 vẫn ngoài phạm vi. Lượt cập nhật này chỉ sửa tài liệu kế hoạch.

**Goal:** Sửa việc dùng ảnh có sẵn/dán ảnh, dữ liệu vòng đời và ghi chú phiếu, chọn ngân hàng và QR, đồng thời làm nhất quán trạng thái/stat/bộ lọc kỳ, ngày chi theo giờ Việt Nam và phân loại phiếu HHMG trong Thanh toán → Hợp đồng & quyết toán.

**Architecture:** Khu Hợp đồng & quyết toán có phần đọc và trình bày riêng; tái sử dụng component ngân hàng, ghi chú và các hook chứng từ/duyệt/ghi sổ đang dùng tại Thu chi. Bổ sung mô hình dữ liệu vòng đời theo phòng, phân biệt tiền cọc đã thu với cọc còn giữ và số quyết toán. Không thay công thức hạch toán hoặc các writer tiền.

**Tech Stack:** React, TypeScript, TanStack Query, Supabase qua RLS/RPC hiện có, shadcn/ui, Vitest, Playwright.

## 0. Hướng dẫn bàn giao cho agent khác

Đây là kế hoạch triển khai trong repository, không phải file độc lập chứa sẵn mã nguồn, fixture và môi trường chạy. Agent nhận việc cần đọc toàn bộ plan và Project Contract trước khi sửa; không cần lịch sử chat để hiểu phạm vi. Chỉ bắt đầu sửa ứng dụng khi người dùng giao thực thi; việc duyệt hai bổ sung ở trên là duyệt phạm vi kế hoạch.

- **Tài liệu phải đi cùng:** repository đúng bản nguồn; file plan này; toàn bộ thư mục `mau thiet ke hopdong va quyet toan` gồm HTML, `support.js` và tài nguyên tham chiếu. Tại lần bàn giao ngày 22/09/2026, plan và thư mục mẫu chưa được Git theo dõi nên clone/worktree mới không tự có chúng. Trên máy hiện tại đọc từ `C:/Users/Nguyen Tam/whiteboard-ihomecrm-main/`; trên máy khác cần nhận bản sao các tài liệu này. Không sao chép cả checkout hoặc file chứa credential. Nếu thiếu mẫu, báo rõ phần đối chiếu giao diện chưa thể nghiệm thu, không tự dựng lại mẫu theo trí nhớ.
- **Nguồn quyết định:** yêu cầu đã chốt trong plan > mẫu thiết kế. Project Contract quy định dữ liệu, kiểm thử và phát hành. Số dòng/SHA/số đo production là neo tra cứu tại lúc audit, phải kiểm lại với source mới; không hardcode số đo hoặc coi ảnh là trạng thái DB hiện tại.
- **Thứ tự thực hiện:** T0 → T5a → T2 → T3 → T5 → T1 → T1a → T4 → T6. T5a tạo các test chung được liệt kê ở T5 khi cần. Những task sửa cùng `useContractSettlement.ts` hoặc `SettlementLifecycleModal.tsx` phải tích hợp tuần tự; chỉ giao song song việc đọc, viết fixture độc lập hoặc review.
- **Quyền tự quyết của agent:** tên hàm nội bộ, tách component nhỏ và cách viết fixture trong các file/phạm vi đã liệt kê. Không tự đổi định nghĩa cọc, quy tắc kỳ, nguồn ngày chi, cách phân loại, công thức tiền hoặc mở rộng writer/quyền/schema. Nếu không có skill Superpowers trong môi trường nhận việc, thực hiện thủ công cùng chu trình từng task: test tái hiện → sửa → test lại → review; không bỏ qua tiêu chí của plan.
- **Điểm cần chứng minh trong T0/T2:** khả năng đọc đủ lịch sử/phần cọc/posting bằng vai trò người dùng thực tế. Truy vấn quản trị lúc audit và test mock không chứng minh RLS đầy đủ. Nếu nguồn hiện hữu không đáp ứng, hoàn thành các phần độc lập, ghi bằng chứng và đề xuất phạm vi bổ sung cho người dùng; không tự mở quyền hoặc coi UI báo thiếu dữ liệu là đã nghiệm thu trọn vẹn vòng đời.
- **Báo cáo bàn giao cuối:** SHA/nhánh và PR nếu có; task đã xong/còn thiếu; lệnh kiểm tra cùng kết quả thật; ảnh E2E desktop/mobile và vai trò đã kiểm; fixture DEMO đã dọn; phần chưa xác minh và mọi đề nghị ngoài plan. Chỉ đánh dấu checkbox đạt sau khi có bằng chứng tương ứng, không tuyên bố hoàn tất chỉ vì build xanh.

## 1. Phạm vi và căn cứ

- Yêu cầu ban đầu ngày 22/09/2026 gồm ba nhóm modal. Yêu cầu tiếp theo bổ sung nhóm 4: kiểm PC2609095 và mọi trạng thái/stat, thay lựa chọn kỳ bằng **Kỳ hiện tại · Tồn Cũ · Tất Cả**. Cần chốt plan trước khi sửa. Thiết kế và ảnh là tài liệu đối chiếu; hành vi được người dùng sửa lại trong yêu cầu được ưu tiên hơn mẫu.
- Người dùng đã đồng ý thêm hai phát sinh: ngày chi mặc định theo giờ Việt Nam và phân loại HHMG đúng hạng mục. Chỉ sửa mặc định của form và phần đọc/hiển thị phân loại; không cập nhật lại ngày, hạng mục hoặc bút toán của phiếu thật đã lưu.
- Mẫu: `mau thiet ke hopdong va quyet toan/Thanh toan - Hop dong & quyet toan.dc.html`. Dòng 346–396 mô tả nhiều lane, tình trạng phòng hiện tại, bảng căn cứ và ghi chú; dòng 601–628 dựng chuỗi hợp đồng; dòng 650–695 dựng nội dung từng loại phiếu. Không sao chép số giả, QR giả hoặc hành vi tạo phiếu của mẫu vào ứng dụng.
- Source đã audit tại `C:/Users/Nguyen Tam/wt-hdqt`, SHA `edbf6cea6919f7105d83a40daf3dad67e9c2ea96`. `git ls-remote` xác nhận cả `main` và `production` cùng SHA lúc kiểm tra. Đây là nguồn khớp ảnh người dùng; checkout chính còn ở `df0f5920`.
- Checkout chính có thay đổi của phiên khác; `wt-hdqt` có sửa sẵn `supabase/migrations/20260528000007_drop_beds_fix_rpcs.sql`. Không sửa, revert, stage hoặc di chuyển các thay đổi này.
- Khi triển khai, tạo worktree từ `origin/main` mới nhất tại `../codex-worktrees/sua-modal-hop-dong-quyet-toan`, nhánh `codex/sua-modal-hop-dong-quyet-toan`. Nếu source mới khác bản đã audit, đối chiếu lại các điểm ảnh hưởng trước khi thực hiện.
- Đọc `docs/engineering/PROJECT_CONTRACT.md`. Dữ liệu THẬT chỉ đọc; kiểm thử có ghi chỉ chạy DEMO và dọn fixture.
- Không sửa trang Thu chi, component/hook dùng chung, quyền hoặc schema để tiện thực hiện. Dùng lại chúng qua adapter của khu mới. Nếu chứng minh cần sửa phần chung/schema, dừng phần phụ thuộc và trình thay đổi phạm vi cụ thể.
- Không sửa dữ liệu cọc/phiếu thật, không tính lại `contracts.deposit_paid`, không đổi số tiền phiếu. Nhóm 4 được sửa cách trình bày/lọc trạng thái; không tự đổi trạng thái DB hoặc thay điều kiện writer duyệt/chi.

## 2. Kết quả kiểm tra và nguyên nhân

### 2.1. Ca thật trong ảnh

Đã đọc production lúc khoảng 09:00 giờ Việt Nam ngày 22/09/2026, project `tryymsxyyckgbrmmvozx`, lọc org THẬT và hợp đồng đích. Không thực hiện lệnh ghi.

| Dữ kiện | Kết quả |
|---|---:|
| Hợp đồng | HĐT-046775/28102024, phòng 401/32PVC |
| PT2607068 ngày 26/04/2026 | Thu cọc 4.500.000đ, APPROVED + POSTED |
| PC2609118 ngày 21/09/2026 | Cấn cọc nội bộ 1.424.000đ, APPROVED + NOT_APPLICABLE |
| PC2609119 ngày 21/09/2026 | Hoàn 3.076.000đ, UNAPPROVED + UNPOSTED |
| Hồ sơ thanh lý | Cọc 4.500.000đ; khấu trừ 1.424.000đ; hoàn 3.076.000đ; COMPLETED |
| `contracts.deposit_paid` hiện tại | 3.076.000đ |
| Trạng thái hợp đồng / phòng | TERMINATED ngày 21/09/2026 / AVAILABLE |

Định nghĩa live `contract_deposit_paid_derived` lấy item DEPOSIT của phiếu đã duyệt: THU cộng, CHI trừ. Vì vậy `4.500.000 − 1.424.000 = 3.076.000` là số ròng sau cấn, không phải cọc từng thu. Khi duyệt phiếu hoàn, số ròng còn có thể giảm tiếp; mốc lịch sử thu cọc không được giảm theo.

Phòng này hiện chỉ có một bản ghi hợp đồng gắn trực tiếp, nên không được tạo lane hợp đồng kế tiếp giả. Trước khi chốt nhãn lịch sử cư trú, còn kiểm tra nguồn chuyển phòng/segment; trạng thái phòng đã đọc là AVAILABLE.

### 2.2. Đối chiếu source

| Vấn đề | Nguyên nhân và vị trí |
|---|---|
| Có ảnh nhưng phải bấm dùng ảnh | `SettlementLifecycleModal.tsx:119–155`: mở form đặt chứng từ về null; chỉ adopt ảnh qua nút riêng. Thu chi đã tự adopt tại `IncomeExpensePostingDialog.tsx:441–468`. |
| Chưa dán được ảnh | `SettlementLifecycleModal.tsx:469–489` chỉ có input file, chưa nối paste handler. |
| Cọc thực thu sai | `useContractLifecycle.ts:85` dùng `deposit_paid`; `ContractLifecycleBand.tsx:32–38` gắn nhãn thực thu và suy ra thiếu cọc. |
| Thiếu hợp đồng trước/sau/hiện tại | Hook chỉ nhận một `contractId`; Band chỉ render một lane. Mẫu yêu cầu chuỗi theo phòng. |
| Nội dung ghi chú thiếu | `useContractSettlement.ts:119–132` không select `notes`; mapping làm mất metadata cần cho ghi chú theo loại phiếu. Modal chỉ đọc lịch sử bổ sung. |
| Căn cứ hoàn chỉ là câu nhắc | `useContractSettlement.ts:332–336` trả placeholder; modal chưa gọi nguồn facts khi mở nên câu nhắc vẫn hiện thay bảng quyết toán. |
| Ngân hàng không chuẩn hóa | Modal dùng input tự do, khởi tạo rỗng; Thu chi đã có `BankSelect` và danh mục VietQR chung. |
| QR có thể dùng dữ liệu cũ | QR đọc `row.*`; lưu recipient chỉ có ở nhánh Cần rà soát, còn thao tác duyệt ở nhánh Chờ duyệt bỏ qua draft vừa nhập. |

Các điểm cần kiểm ngay trong nhóm vòng đời: tổng hóa đơn đang cộng `paid_amount` không phân trang; trạng thái không có bản ghi thanh lý bị coi là đang thuê/nợ 0; dòng hoàn được truyền cho cả phiếu hoa hồng. Đây là phần dữ liệu/nhãn của mục 2, không phải thay nghiệp vụ hạch toán.

### 2.3. PC2609095 và lỗi trạng thái/bộ lọc vừa được bổ sung

Đã đọc lại dữ liệu THẬT lúc 09:09–09:11 ngày 22/09/2026:

| Phiếu/ID đích | Kết quả |
|---|---|
| PC2609095 · `f065d2b5-cc1f-4525-8533-8931fedaa5d3` | 4.157.800đ; ngày phiếu 06/07/2026; UNAPPROVED + UNPOSTED; sổ thật TKHIEP; chưa có active posting. Vẫn chờ duyệt. |
| PC2607070 · `b4bb42f3-bcdf-4ffa-8f80-108a5ff0373a` | Cùng phòng 205/1392QT, hợp đồng và số tiền; ngày phiếu 02/07/2026; APPROVED + NOT_APPLICABLE, NON_CASH; sổ ảo CỌC (giữ hộ khách); không có active posting. Đây là dòng trong ảnh Thanh toán. |

Không có bằng chứng PC2609095 bị đổi thành đã chi. Hai ảnh đang đối chiếu hai phiếu khác UUID. Cùng mã hiển thị cũng chưa chắc cùng phiếu: DB hiện có hơn một PC2607070 thuộc các phòng/khoản khác nhau. Mọi join/key/thao tác tiếp tục dùng UUID + org, không mã hoặc phòng + số tiền. Việc sửa mã trùng hay xử lý nghĩa vụ trùng không thuộc kế hoạch này.

Nguyên nhân giao diện gây nhầm đã xác định:

1. `ContractSettlementSection.tsx:105–108` ánh xạ “Mọi kỳ” sang `scope='open'`; query `useContractSettlement.ts:193–194` loại POSTED và CANCELLED trước khi UI lọc trạng thái. Vì vậy “Mọi kỳ” không thật sự là mọi kỳ/mọi trạng thái.
2. `contractSettlement.ts:305` cho `matchStatus('paid')` nhận cả `noncash`. Thẻ Đã chi chỉ tính paid, còn bảng nhận cả noncash: sinh đúng 0đ/0 phiếu nhưng có 3 dòng.
3. Chọn tháng đi query khác, lọc `voucher_date` nhưng không loại POSTED nên có thêm các phiếu đã chi thật.
4. Footer ghi lọc ngày chi thực tế nhưng backend/client đều lọc ngày phiếu. `paidDate` hiện còn lấy `posted_at_v2` là thời điểm ghi hệ thống; ngày chi người dùng chọn nằm ở active posting `posted_on`.
5. Local state giữ literal tháng cũ trong khi query nhận kỳ mới của trang; đổi kỳ có thể lọc chéo hai tháng thành rỗng giả.
6. Badge tồn/banner không dùng cùng quy tắc với issue; có thể gọi noncash là tồn cần xử lý. Empty state cũng có thể kết luận đã làm hết khi dữ liệu bị query loại.
7. Một số tổ hợp đặc biệt được ánh xạ khác Thu chi: APPROVED+REVERSED thành chờ chi thay vì Đã hoàn tác; NON_CASH thiếu NOT_APPLICABLE bị đọc như chờ chi; UNAPPROVED+POSTED khác thứ tự ưu tiên của helper canonical. Cần dùng cùng ngữ nghĩa theo route, không sửa dữ liệu để ép khớp UI.

Số đo kiểm tra độc lập trên toàn org THẬT, trước RLS của từng người dùng, tại thời điểm trên (không phải số cố định để hardcode):

| Tập dữ liệu theo nguồn nhận phiếu hiện hữu | Số phiếu | Số tiền |
|---|---:|---:|
| Đã chi, mọi ngày | 155 | 397.620.200đ |
| Chờ duyệt, mọi ngày; chưa tách làn review | 97 | 271.369.134đ |
| Không ghi quỹ | 3 | 9.515.634đ |
| Hủy | 28 | 63.048.268đ |
| Đã chi, **ngày phiếu** trong 09/2026 | 25 | 72.234.500đ |
| Đã chi, **ngày chi `posted_on`** trong 09/2026 | 69 | 188.637.000đ |

Số 25/72.234.500đ khớp ảnh, xác nhận bộ lọc đang dùng ngày phiếu. Các số theo ngày chi sẽ khác sau sửa vì có phiếu phát sinh tháng 7–8 nhưng chi tháng 9. Có đủ active posting và posted_on cho 155 phiếu paid trong tập đã đo; vẫn cần ca dữ liệu thiếu trong test.

## 3. Hành vi sau sửa

### 3.1. Ảnh và xác nhận chi

- Khi mở bước ghi chi, tự nhận chứng từ từ ảnh có sẵn trên đúng phiếu; bỏ nút **Dùng ảnh có sẵn/Dùng ảnh này**.
- Nút **Xác nhận đã chi đủ [số tiền]** luôn có trong bước ghi chi. Có chứng từ hợp lệ và đủ sổ quỹ/ngày/quyền thì bấm ngay, không thêm thao tác xác nhận ảnh.
- Tự nhận ảnh chỉ chuẩn bị chứng từ; không tự duyệt hoặc ghi tiền. Ảnh đã có không thay thế điều kiện chọn sổ quỹ; ảnh 1 vẫn phải chọn sổ.
- Giữ nút **Tải hoặc Dán Ảnh** để bổ sung; upload và paste đi cùng đường xử lý. Hướng dẫn ngắn tại vùng ảnh về Ctrl/Cmd+V, không chặn dán văn bản vào ô ghi chú.
- Ảnh có sẵn và ảnh mới hiện thumbnail, phóng to được; danh sách không nhân đôi sau refetch. Không tạo nút xóa ảnh gốc ngoài yêu cầu.
- Chỉ dùng `evidenceIds` đã hợp lệ. Đang xử lý thì khóa xác nhận; ảnh mất, sai tổ chức hoặc không được tiếp nhận phải có thông báo cụ thể và đường tải/dán lại. Một ảnh lỗi không phủ nhận ảnh khác còn hợp lệ.
- Kết quả upload/adopt sau khi modal đóng/đổi phiếu không được gắn sang phiếu khác. Thử lại ghi chi giữ khóa idempotency của cùng lần thực hiện.

### 3.2. Vòng đời và ghi chú

- Dựng nhiều lane theo lịch sử phòng: hợp đồng liền trước, hợp đồng của phiếu/biến động, hợp đồng kế tiếp và hợp đồng hiện tại nếu có. Giữ toàn bộ chuỗi từ hợp đồng đích tới hiện tại; khử trùng nếu cùng một hợp đồng giữ nhiều vai trò.
- Làm nổi hợp đồng đích; nhãn đúng từng loại: của phiếu hoàn, tính hoa hồng, phát sinh thưởng, của biến động. Các hợp đồng khác chỉ để đối chiếu; mọi thao tác tiền vẫn giữ `voucherId` đang mở.
- Dưới chuỗi có **Phòng hiện tại** và **Phiếu đang xem/Nguồn** theo mẫu. Không suy có hợp đồng mới, đang thuê hay không nợ từ việc dữ liệu trả về rỗng/lỗi.
- Với gia hạn giữ nguyên ID, không nhân thành hai hợp đồng. Với chuyển phòng, dùng đoạn cư trú thực tế; không dựa riêng vào `contracts.room_id`, ngày ký hoặc `parent_contract_id`.
- Mốc cọc hiển thị khoản đã thu có nguồn chứng minh, mã phiếu và ngày thu. Tách cọc ghi nhận lịch sử/sổ ảo khỏi tiền thực thu; cọc đưa vào quyết toán là snapshot riêng. Không lấy cam kết cọc làm tiền đã nộp, không lấy số ròng sau cấn làm tiền đã thu.
- Phiếu hỗn hợp chỉ cộng phần item DEPOSIT; nguồn vừa liên kết vừa gắn trực tiếp chỉ tính một lần. Phiếu hủy/xóa/đảo phải xử lý theo trạng thái hiệu lực. Không cộng cấn cọc như một lần thu tiền mới.
- Đọc qua RLS có thể thành công nhưng chỉ thấy một phần dữ liệu. Phải kiểm quyền và tính đầy đủ nguồn trước khi kết luận tổng cọc/lịch sử đầy đủ; không chứng minh được thì ghi “Chưa đủ dữ liệu”, không hiện số 0 hoặc kết luận phòng trống. Không dùng service key để bù phần người dùng không được xem.
- Kiểm mốc tiền thuê/phí và nợ theo đúng nguồn chi tiết, loại trừ cọc và phiếu/hóa đơn không hiệu lực; có phân trang. Số lịch sử tại biến động phải có mốc thời gian rõ, không gắn nhãn “tại thời điểm biến động” cho tổng hiện tại.
- Ghi chú dùng nguồn đang phục vụ Thu chi: `VoucherNote`, `useTerminationRefundFacts`, `useCommissionVoucherFacts` và các hàm dựng bảng tương ứng. Không phân tích chuỗi ghi chú để bịa khoản tiền nếu đã có dữ liệu cấu trúc.
- Phần thân có bảng quyết toán/căn cứ theo loại phiếu, **Ghi chú gốc của phiếu**, và **Lịch sử bổ sung** riêng. Ghi chú gốc giữ xuống dòng; không lấy lịch sử bổ sung thay cho ghi chú gốc hoặc hiện lặp hai lần.
- Căn cứ chưa tải/không đủ quyền/lỗi phải hiện đúng trạng thái. Không coi căn cứ thiếu là 0 hoặc đã khớp. Căn cứ và ghi chú không tự sửa tiền phiếu hay trạng thái duyệt.
- Ca ảnh phải thấy: cọc thu 4.500.000đ từ PT2607068; cấn 1.424.000đ; hoàn 3.076.000đ; không còn câu “còn thiếu 1.424.000đ”. Sau chi hoàn, mốc cọc đã thu vẫn 4.500.000đ.

### 3.3. Ngân hàng và VietQR

- Dùng nguyên `src/components/income-expenses/BankSelect.tsx`: dropdown tìm ngân hàng/tên không dấu/alias như ảnh 4–5; không xây danh mục khác.
- Prefill ngân hàng hiện tại bằng cách chuẩn hóa qua `matchRecipientBankCode` và `RECIPIENT_BANKS`. Giá trị lưu theo `shortName` như form Thu chi; dữ liệu cũ không nhận diện được phải được giữ để người dùng biết và chọn lại.
- Có nút **Lưu thông tin nhận tiền** khi thay đổi tên/ngân hàng/số tài khoản. Trong khi chưa lưu hoặc lưu lỗi, không cho dùng QR cũ hay duyệt/chi dựa trên draft.
- Sau lưu thành công, cập nhật/refetch đúng phiếu rồi mới dựng QR từ ngân hàng/BIN, số tài khoản, tên, số tiền và mã phiếu đã lưu. Kiểm cả làn Cần rà soát lẫn Chờ duyệt.
- QR tiếp tục dùng `buildVietQRImageUrl`. Thiếu ngân hàng hoặc tài khoản hợp lệ thì hướng dẫn bổ sung; ảnh QR tải lỗi có trạng thái lỗi/thử lại.
- Dropdown trong portal phải thao tác được bằng chuột/bàn phím, không bị che và không làm đóng modal khi chọn. Kiểm desktop và mobile.

### 3.4. Trạng thái, stat và ba bộ lọc kỳ

**Đã được người dùng chốt trong lượt bổ sung:** việc chưa xong có ba lựa chọn; riêng Đã chi chỉ có hai lựa chọn Kỳ hiện tại / Tất Cả. **Phạm vi kỳ dùng enum, không giữ một bản sao chuỗi tháng:** `current | prior | all`. Kỳ tham chiếu duy nhất là `period` của trang, hiện là 09/2026; nhãn **Kỳ hiện tại (09/2026)**, **Tồn Cũ**, **Tất Cả**. Mặc định đề xuất Kỳ hiện tại. Đổi kỳ chung hoặc Bỏ lọc không để lại tháng cũ trong state.

| Lựa chọn | Quy tắc đề xuất |
|---|---|
| Kỳ hiện tại | Phiếu thuộc kỳ theo trục ngày đúng trạng thái ở bảng dưới. |
| Tồn Cũ | Ngày phiếu trước đầu kỳ và còn Cần rà soát/Chờ duyệt/Chờ chi. Không gồm đã chi, không ghi quỹ, hủy hoặc hoàn tác. |
| Tất Cả | Không giới hạn ngày, không ngầm loại đã chi/không ghi quỹ/hủy/hoàn tác/không xác định. Bộ lọc trạng thái tiếp tục chọn tập cần xem. |

Khi chuyển từ Tồn Cũ sang Đã chi: tự chuyển phạm vi sang Kỳ hiện tại, bỏ option Tồn Cũ và cập nhật nhãn đang lọc; không giữ scope cũ tạo bảng rỗng. Trên Tồn Cũ, thẻ lịch sử Đã chi/Không ghi quỹ không hiện số 0 như kết quả tiền thật: hiển thị “Không áp dụng cho tồn cũ”; chọn xem Đã chi đưa về kỳ hiện tại rõ ràng. Các trạng thái lịch sử khác dùng Kỳ hiện tại / Tất Cả; chọn Tồn Cũ từ Tất cả trạng thái thì về Cần xử lý. Không suy `Kỳ hiện tại + Tồn Cũ = Tất Cả` vì Tất Cả còn chứa lịch sử đã hoàn thành.

| Trạng thái | Ngày xét kỳ |
|---|---|
| Cần rà soát / Chờ duyệt / Chờ chi | `voucher_date` |
| Đã chi | `posted_on` của active posting; không dùng `posted_at_v2` hoặc mã phiếu để suy ngày |
| Không ghi quỹ / Hủy / Hoàn tác / Không xác định | `voucher_date`; không ghi nhãn ngày chi |
| Biến động | Ngày nghiệp vụ biến động; tab này là lịch sử, không có nghĩa “còn cần chi” |

Tab Biến động giữ lọc thời gian theo ngày nghiệp vụ. Trong nhóm sửa này, thay ba lựa chọn kỳ áp dụng cho Khoản chi/stat của Khoản chi; chỉ sửa đồng bộ kỳ ở Biến động để tránh state tháng cũ, không áp khái niệm Tồn công việc vào báo cáo lịch sử.

- Badge và mapping dùng chung ngữ nghĩa canonical/legacy với Thu chi. Cần rà soát vẫn là một phần Chờ duyệt, không phải trạng thái DB mới. Phiếu hoàn tác có trạng thái riêng; không tự coi là chưa từng chi hoặc cho chi lại chỉ vì hiển thị đổi.
- **Đã chi** chỉ chứa phiếu có trạng thái chi và bút toán tiền hiệu lực tương ứng; **Không ghi quỹ** là bộ lọc/stat riêng, không nằm trong danh sách hay tổng tiền Đã chi. Kiểm mode NON_CASH và dữ liệu posting, không chỉ đọc một cột.
- Tất cả trạng thái bao gồm ca không xác định để không giấu phiếu; tổ hợp mâu thuẫn có cảnh báo đối chiếu, không tự sửa/duyệt lại.
- Một tập nền chung sau quyền/org/tòa/tìm kiếm/nguồn/kỳ dùng cho stat, chip, banner và bảng. Stat bỏ filter trạng thái của chính nó để các thẻ khác vẫn có số; chip loại tôn trọng trạng thái đang chọn. Bấm thẻ nào, count/số tiền phải khớp tập dòng của thẻ đó.
- Footer tách **Tổng giá trị phiếu đang xem** và **Đã chi thực tế** khi có nhiều trạng thái. Không gọi tổng có sổ ảo/hủy là thực chi. Empty state chỉ nói không có kết quả phù hợp, không suy toàn bộ nghiệp vụ đã xong.
- Nhãn tồn không gắn cho phiếu hoàn thành như việc còn phải làm. Ngày null/không đủ nguồn không bị biến thành kỳ cũ; Tất Cả vẫn cho xem với cảnh báo, còn lọc kỳ phải báo có dữ liệu chưa xác định nếu cần.
- Đọc được phiếu nhưng posting bị RLS ẩn hoặc tải lỗi: không tự đổi paid thành pending/chờ chi, không báo 0 hoặc tổng đầy đủ. Giữ trạng thái phiếu theo nguồn gốc, đánh dấu số/ngày chi chưa xác minh và stat bị ảnh hưởng “Chưa đủ dữ liệu”, có thử lại. Không bù bằng quyền cao hơn người dùng.
- Với route legacy đã APPROVED nhưng không có active posting: giữ nhãn theo helper legacy và đánh dấu thực chi/ngày chi chưa xác minh; không tự cộng vào Đã chi thực tế hoặc đổi thành Chờ chi. Đây là cách hiển thị thiếu bằng chứng, không phải yêu cầu backfill posting.

### 3.5. Ngày chi mặc định theo giờ Việt Nam — đã đồng ý bổ sung

- `SettlementLifecycleModal.tsx:72` đang lấy `new Date().toISOString().slice(0, 10)` nên 00:00–06:59 giờ Việt Nam có thể tự điền ngày hôm trước.
- Thay mặc định bằng `vnTodayISO()` từ `src/lib/vnDate.ts`, ghim `Asia/Ho_Chi_Minh`. Không thay bằng `todayISO()` từ `collect.ts` vì helper đó còn phụ thuộc múi giờ máy.
- Ví dụ 01:00 ngày 22/09/2026 giờ Việt Nam phải điền `2026-09-22`, kể cả trình duyệt/máy chạy giờ UTC. Qua đầu tháng/năm cũng đúng ngày nghiệp vụ Việt Nam.
- Người dùng vẫn chọn ngày chi khác được; refetch/upload/lưu ngân hàng không tự ghi đè ngày đã chọn. Gửi nguyên chuỗi ngày chọn vào `postedOn`, không đổi qua timestamp UTC.
- Không sửa ngày của phiếu đã lưu và không mở rộng sửa các form khác.

### 3.6. Phân loại HHMG theo hạng mục — đã đồng ý bổ sung

- Đã đọc được hai phiếu PC2606169 và PC2608091 có hạng mục HHMG nhưng thiếu `commission_kind` và dấu nguồn hoàn khách. `useContractSettlement` mất thông tin hạng mục sau bước D4 rồi mặc định `refund`, gây xếp nhầm nhóm.
- Giữ `income_expense_type_id` từ các item đã đọc và map `voucherId → tập loại hạng mục`. Dùng `settlementTypeMatches` hiện có, vốn nhận HHMG là Hoa hồng; không đọc tên/mã phiếu để đoán loại.
- Một resolver thuần xác định loại, nguồn nhận diện và dấu xung đột; ưu tiên metadata rõ ràng theo thứ tự `commission_kind` → `system_source`, sau đó mới dùng hạng mục cho phiếu thiếu metadata. Không viết ngược metadata suy ra vào DB.
- Nhiều item cùng loại vẫn là một phiếu, một lần cộng số tiền. Item ngoài nhóm không đổi loại. Nhiều loại thuộc khu này cùng xuất hiện mà không có nguồn rõ, hoặc metadata mâu thuẫn với hạng mục: đánh dấu cần đối chiếu phân loại, giữ phiếu trong Tất cả và không tự chọn item đầu/tách phiếu/cộng tiền nhiều lần. Nếu chưa xác định được nhóm, hiển thị chưa xác định loại, không mặc định Hoàn khách.
- Căn cứ hoa hồng phải tải theo kết quả phân loại: HHMG thủ công cũng được tra căn cứ kỳ ký hợp đồng như phiếu có `commission_kind='broker'`. Không giả mạo dấu nguồn để ép renderer Thu chi chạy; ghi chú gốc và metadata thật vẫn được giữ.
- Phân biệt **căn cứ số tiền hoa hồng** với **ghi chú chi tiết được sinh tự động**. Căn cứ số tiền của HHMG thủ công dùng `get_period_commissions` theo kỳ ký và `contract_id`, qua nhánh `canCuHoaHong` hiện hữu sau khi mở rộng tập đầu vào bằng resolver. `CommissionVoucherNote` và RPC `get_commission_voucher_facts_v1` hiện đều yêu cầu `commission_kind` broker/sale; đổi điều kiện phía UI không làm RPC trả facts cho HHMG thiếu metadata. Phiếu này hiển thị căn cứ kỳ ký nếu đọc được, ghi chú gốc và lịch sử bổ sung; không giả lập facts chi tiết hoặc kết luận đã khớp khi RPC không trả dữ liệu. Muốn mở rộng ghi chú tự sinh cho loại này phải trình phương án riêng nếu cần sửa RPC/shared component, không ngầm đưa vào T5a.
- Reader kỳ ký tính số dự kiến theo bậc hoa hồng **hiện hành**, không phải snapshot bậc tại ngày ký. Giữ `tier_percent` cùng `expected_amount`: thiếu bậc phải báo thiếu cấu hình, không diễn giải số 0 do RPC fallback là căn cứ hợp lệ. Chỉ lấy căn cứ theo hợp đồng; không dùng `voucher_id` hoặc `status` gợi ý của reader này thay UUID/trạng thái phiếu đang mở. Không đổi công thức hay cấu hình bậc trong kế hoạch này.
- Nhãn, chip loại, bảng/stat và tiêu đề/căn cứ modal dùng cùng kết quả phân loại. Thay nhóm hiển thị không tự đổi số tiền, approval/posting, quyền duyệt hoặc nội dung phiếu thật.

## 4. Các bước triển khai sau khi duyệt

### T0 — Chốt bản nguồn và phạm vi

- [ ] Fetch, đối chiếu SHA mới, tạo worktree/nhánh như mục 1; giữ nguyên mọi thay đổi có sẵn.
- [ ] Giữ hai bổ sung đã được đồng ý tại mục 3.5–3.6 trong phạm vi; các mục còn lại ở mục 7 tiếp tục ngoài phạm vi, không hỏi lại quyền bổ sung hai mục đã chốt.
- [ ] Chốt fixtures DEMO và các trạng thái tái hiện; THẬT chỉ dùng truy vấn đọc để đối chiếu.
- [ ] Kiểm đủ tài liệu bàn giao ở mục 0 và runner/runtime theo manifest; ghi lại baseline lỗi có sẵn. Chạy thử các nguồn đọc cần dùng bằng vai trò bị giới hạn quyền để nhận diện sớm phần cần trao đổi, trước khi hứa hoàn thành toàn bộ T2.

### T1 — Tự dùng ảnh sẵn và hỗ trợ dán ảnh

**Sửa:** `src/components/thu-tien/contract-settlement/SettlementLifecycleModal.tsx`, `ChungTuThanhToan.tsx` nếu cần nhận thêm ảnh trong phiên. **Thêm test:** `src/components/thu-tien/contract-settlement/__tests__/SettlementLifecycleModal.test.tsx`.

**Tái dùng, không sửa:** `useAttachPostingEvidence`, `adoptVoucherAttachmentsAsEvidence`, `useClipboardImagePaste`, `validatePostFinanceExecutionInput`, mapping lỗi `postingEvidenceItems`.

- [ ] Viết test mở form có attachment hợp lệ: tự adopt, không có nút dùng ảnh, chọn sổ là xác nhận được; payload giữ đúng voucher/evidence.
- [ ] Chạy test trước sửa để xác nhận lỗi tái hiện.
- [ ] Nối vòng đời adopt/loading/error/cleanup, upload và paste; lưu URL ảnh trong phiên; invalidate query `contract-settlement` tại adapter của khu này.
- [ ] Kiểm empty/skipped/failure, file+items trùng, đang upload đóng modal, upload bổ sung khi đã có ảnh và gửi hai lần.
- [ ] Chạy lại test và kiểm diff chỉ có file thuộc T1.

### T1a — Sửa ngày chi mặc định

**Sửa:** `src/components/thu-tien/contract-settlement/SettlementLifecycleModal.tsx`. **Bổ sung test:** `__tests__/SettlementLifecycleModal.test.tsx` của T1. **Tái dùng, không sửa:** `src/lib/vnDate.ts`.

- [ ] Viết test đóng băng thời gian tại `2026-09-21T18:00:00Z` (01:00 ngày 22/09 giờ Việt Nam): form phải hiện `2026-09-22`; xác nhận test đỏ với cách lấy ngày UTC hiện tại.
- [ ] Thay initializer bằng helper sẵn có:

```ts
import { vnTodayISO } from '@/lib/vnDate';
const [ngayChi, setNgayChi] = useState(() => vnTodayISO());
```

- [ ] Kiểm 00:00, 06:59, 07:00 giờ Việt Nam, giao tháng/năm, môi trường múi giờ UTC và Việt Nam; chạy lại suite `vnDate.test.ts`.
- [ ] Kiểm người dùng chọn ngày khác rồi upload/refetch/lưu thông tin: giữ nguyên ngày đã chọn; input gửi writer đúng `postedOn`. Không backfill ngày phiếu cũ.

### T2 — Đọc và dựng vòng đời đúng nguồn

**Sửa:** `src/hooks/useContractLifecycle.ts`, `src/hooks/useContractMovements.ts`, `src/components/thu-tien/contract-settlement/ContractLifecycleBand.tsx`, `MovementLifecycleModal.tsx`, `SettlementLifecycleModal.tsx`, `contract-settlement.css`.

**Thêm:** `src/lib/contractLifecycle.ts` cho kiểu dữ liệu/chuẩn hóa/tính tổng/chọn lane thuần; `src/lib/__tests__/contractLifecycle.test.ts`, `src/hooks/__tests__/useContractLifecycle.test.ts`, `src/components/thu-tien/contract-settlement/__tests__/ContractLifecycleBand.test.tsx`.

**Đầu vào:** org, roomId, targetContractId, loại phiếu/biến động và mốc ngày nghiệp vụ. `MovementRow` bổ sung roomId/org context cần thiết. **Đầu ra:** tập lanes có vai trò, tình trạng phòng, các giá trị cọc được phân biệt và danh sách chứng từ nguồn, trạng thái đủ/thiếu/lỗi dữ liệu.

- [ ] Viết test fixture 4.500.000 / 1.424.000 / 3.076.000, trước và sau hoàn; thêm cọc một phần, sổ ảo, phiếu hỗn hợp, linked receipt, nguồn trùng, hủy/xóa/đảo, hơn 1.000 dòng.
- [ ] Tái hiện test đỏ với cách đọc `deposit_paid` hiện tại.
- [ ] Lấy candidate hợp đồng/transfer qua RLS có lọc org/phòng; dùng projection cư trú `get_room_residence_segments_v1` với các ID đã được phép đọc để dựng thứ tự. Kiểm quyền reader và tính đầy đủ nguồn bằng vai trò thật, gồm ca thấy hợp đồng nhưng không thấy linked receipt/transfer; không dùng service key ở client hoặc mở rộng quyền để lấy đủ lane. Nếu quyền/nguồn không chứng minh đủ thì báo thiếu dữ liệu, không kết luận 0/trống.
- [ ] Chuẩn hóa segment cuối còn `to_date=null`: đóng tại `actual_end_date`, hoặc ngày kết thúc phù hợp của hợp đồng TERMINATED/EXPIRED như lớp adapter room cash lifecycle hiện hữu; xử lý ngày đóng trước ngày mở/ngày tương lai thành diagnostic. Hợp đồng thanh lý không được gắn current chỉ vì raw segment chưa đóng.
- [ ] Đọc nguồn DEPOSIT trực tiếp + `contract_deposit_links`, khử trùng item và phân trang. Tham chiếu semantics mới nhất của `app_private.contract_deposit_sources_v1` tại `20260908051659_invoice_deposit_classification.sql:383–450`: item DEPOSIT, union direct/link, APPROVED, loại hủy/xóa/đảo, phân sổ thật/ghi nhận lịch sử. Hàm private không được gọi trực tiếp từ frontend.
- [ ] Đối chiếu POSTED với bút toán hiệu lực theo route canonical/legacy; ca canonical thiếu active posting phải báo chưa xác minh, không tự xếp vào thực thu. Không áp một giả định active posting lên mọi dữ liệu legacy. Bọc kết quả RPC bằng kiểu và validation boundary, không thêm cast `any`.
- [ ] Dựng các mốc thu cọc/thuê-phí/nợ/thanh lý với thời điểm rõ; error/null khác số 0. Lấy trạng thái hoàn từ đúng phiếu hoàn, không dùng số hoa hồng để gắn nhãn còn hoàn.
- [ ] Dựng nhiều lane và trạng thái phòng chung cho modal khoản chi và biến động, không áp bộ lọc tháng ngoài bảng vào lịch sử phòng.
- [ ] Chạy tests reducer/hook/component và kiểm tenant, phòng chuyển, gia hạn cùng ID, target cũ/current mới, overlap/segment chưa tin cậy.

**Ràng buộc nguồn:** Không cộng `DEPOSIT_RECEIVED.amount` từ room cash lifecycle như gross cọc: reader đó đang có đường lấy cả `voucher.total_amount`. Không gọi lại `read_contract_settlement_*` đã bị migration restore xóa. Không sửa RPC/SQL trong T2; thiếu quyền hoặc dữ liệu cần thiết là lý do trình phần mở rộng, không là lý do đoán số.

### T3 — Ghi chú và bảng căn cứ khớp Thu chi

**Sửa:** `src/hooks/useContractSettlement.ts`, `src/lib/contractSettlement.ts`, `SettlementLifecycleModal.tsx`. **Thêm:** `src/components/thu-tien/contract-settlement/SettlementVoucherDetails.tsx` và `__tests__/SettlementVoucherDetails.test.tsx`.

**Dùng lại:** `VoucherNote`, `useTerminationRefundFacts`, `useCommissionVoucherFacts` trong `src/hooks/useCommissionVoucher.ts`, `buildTerminationCard`, `buildTerminationHeaderLines`, nguồn chi tiết giữ chỗ khi đúng loại phiếu.

- [ ] Mở rộng query/mapping giữ `notes`, `system_source`, `commission_kind` và metadata component chung thực sự cần; không tự suy nguồn hệ thống cho phiếu tạo tay chỉ dựa vào tên.
- [ ] Viết test so cùng phiếu ở Thu chi và modal mới: nội dung ghi chú gốc, ngày/mã phiếu cọc, các khoản khấu trừ, tổng hoàn, ghi chú bổ sung.
- [ ] Hydrate facts theo `voucherId` khi mở modal, thay placeholder bằng nội dung cấu trúc; fallback ghi chú gốc khi phiếu không có facts chuyên biệt. Loading/error/không đủ nguồn phải khác đã khớp.
- [ ] Dùng renderer chung cho nội dung, bố trí wrapper hợp với mẫu; tránh lặp bảng tổng hợp hoặc lịch sử bổ sung.
- [ ] Kiểm riêng HHMG thiếu metadata: `VoucherNote` giữ fallback ghi chú gốc; `SettlementVoucherDetails` trình bày căn cứ số tiền theo kỳ ký từ read model. Không truyền metadata broker giả để ép component/RPC chạy; kiểm facts rỗng không biến thành số 0 hoặc đã khớp.
- [ ] Kiểm hoàn khách/thưởng sale/hoa hồng/giữ chỗ, phiếu tạo tay, ghi chú rỗng, ghi chú nhiều dòng, dữ liệu bị lệch có cảnh báo.

Ví dụ assertion số tiền cho fixture bằng hàm chung hiện có (fixture đã xây đủ `TerminationRefundFacts`):

```ts
const card = buildTerminationCard(facts)!;
expect(card.totalDeductions).toBe(1_424_000);
expect(card.net).toBe(3_076_000);
expect(card.warning).toBeNull();
expect(buildTerminationHeaderLines(facts).join('\n')).toContain('4.500.000');
expect(buildTerminationHeaderLines(facts).join('\n')).toContain('PT2607068');
```

### T4 — Ngân hàng có tìm kiếm, lưu nhất quán và QR

**Sửa:** `SettlementLifecycleModal.tsx`, `src/hooks/useSettlementActions.ts` chỉ phần adapter recipient nếu cần trả/refetch snapshot; CSS riêng của khu mới. **Bổ sung test:** file modal ở T1.

- [ ] Viết test ngân hàng đã có/legacy/không nhận diện; Chờ duyệt sửa thông tin rồi duyệt/chi không được dùng snapshot cũ.
- [ ] Thay input bằng `BankSelect`; dirty state so với giá trị gốc chuẩn hóa, không dùng điều kiện ngân hàng khác rỗng để coi là đã sửa.
- [ ] Thêm lưu thông tin nhận tiền; giữ patch thưa và items nguyên trạng. Lưu lỗi thì giữ form và hiển thị lỗi; lưu xong mới cập nhật QR và mở thao tác tiếp.
- [ ] Kiểm QR đúng BIN/STK/tên/số tiền/mã phiếu sau refetch và mở lại; chưa lưu thì QR cũ không thể bị hiểu là QR cho draft mới.
- [ ] Kiểm các tên dễ nhầm VietinBank/Vietcombank, MB/Sacombank, Timo/BVBank; giữ nguyên danh mục chung.
- [ ] Kiểm dropdown portal và điều hướng bàn phím/mobile; chạy lại bộ VietQR hiện có.

### T5 — Trạng thái/stat và bộ lọc kỳ

**Sửa:** `src/components/thu-tien/contract-settlement/ContractSettlementSection.tsx`, `src/hooks/useContractSettlement.ts`, `src/lib/contractSettlement.ts`, `nhan.ts`, các modal cần nhận trạng thái hoàn tác; `useContractMovements.ts` chỉ phần đồng bộ kỳ.

**Thêm test:** `src/hooks/__tests__/useContractSettlement.test.ts`, `src/components/thu-tien/contract-settlement/__tests__/ContractSettlementSection.test.tsx`. **Sửa test:** `src/lib/__tests__/contractSettlement.test.ts` đang cố định noncash thuộc paid và reversed thuộc chờ chi.

**Đầu vào:** `periodScope`, kỳ tham chiếu, `statusFilter` độc lập. **Dữ liệu bổ sung:** posting mode, active posting header với `posted_on` và trạng thái hiệu lực; giữ UUID/org làm identity.

- [ ] Áp dụng đúng quyết định đã chốt tại mục 3.4: ba phạm vi cho việc chưa xong, hai phạm vi cho Đã chi; test chuyển từ Tồn Cũ sang Đã chi không giữ scope cũ.
- [ ] Dùng cùng normalizer/reducer khi chuyển Tồn Cũ sang Không ghi quỹ/Hủy/Hoàn tác/Không xác định qua thẻ và dropdown: scope về current, options/nhãn/query/stat đổi đồng bộ, không giữ prior bị ẩn.
- [ ] Viết test đỏ: Tất Cả+Đã chi phải giữ paid, không có noncash; không loại hủy/unknown trước khi filter; PC2609095 pending tách PC2607070 noncash dù cùng tiền/phòng. Thêm hai phiếu cùng code khác UUID.
- [ ] Bỏ coupling `month='all'` → `scope='open'`. Thiết kế query ngày/phạm vi độc lập status và có phân trang; không lọc voucher_date trước rồi mới cố tìm khoản chi có posted_on trong kỳ.
- [ ] Dùng mô hình trạng thái theo route của Thu chi; mở rộng trạng thái hoàn tác và unknown filter khi cần. Hiển thị nút theo cùng điều kiện của Thu chi; không mời ghi chi lại cho phiếu hoàn tác chỉ vì mapping cũ coi là chờ chi. Giữ nguyên writer và cổng quyền phía server, không biến mapping hiển thị thành quyền ghi mới.
- [ ] Tập trung predicates thời gian/trạng thái và aggregate vào hàm thuần dùng chung. Thay nhãn/options kỳ, stat không ghi quỹ riêng, các badge tồn/banner/empty/footer theo mục 3.4.
- [ ] Kiểm ma trận mọi scope × mọi trạng thái × loại khoản; ngày 31/08–01/09, phiếu tháng 8 chi tháng 9, ghi sổ ngày khác posted_at, ngày null/tương lai, hoàn tác rồi chi lại, đổi kỳ chung và Bỏ lọc.
- [ ] Test đọc được voucher nhưng không đọc được posting do quyền hoặc lỗi query; stat không báo 0/đầy đủ, không chuyển sang chờ chi, không mở thêm quyền ghi.
- [ ] Kiểm stat/count/chip/table/footer sau tìm kiếm/tòa/nguồn/vướng mắc và bật/tắt gộp Chờ duyệt–Chờ chi. Không hardcode số production vào ứng dụng.

### T5a — Phân loại đúng phiếu HHMG và căn cứ đi kèm

**Sửa:** `src/hooks/useContractSettlement.ts`, `src/lib/settlementTypes.ts`; `src/lib/contractSettlement.ts`, `ContractSettlementSection.tsx`, `SettlementLifecycleModal.tsx` và `nhan.ts` chỉ phần nhận/hiện trạng thái phân loại chưa rõ hoặc có xung đột.

**Test:** mở rộng `src/lib/__tests__/settlementTypes.test.ts`, `src/hooks/__tests__/useContractSettlement.test.ts` và `__tests__/ContractSettlementSection.test.tsx` ở T5.

**Thứ tự:** thực hiện trước khi nghiệm thu T3/T5 vì nhóm hiển thị và căn cứ modal phụ thuộc kết quả phân loại. Resolver trả loại xác định hoặc chưa xác định, nguồn quyết định và dấu xung đột; dữ liệu raw vẫn được giữ nguyên.

- [ ] Viết test đỏ HHMG thiếu metadata phải vào Hoa hồng, không Hoàn khách; fixture theo hai ca PC2606169/PC2608091 nhưng identity bằng UUID/org. Thêm thưởng sale trong category Hoa hồng, hoàn cọc thủ công và metadata hợp lệ.
- [ ] D4 đọc/giữ `income_expense_type_id` cùng `income_expense_id`, phân trang và khử trùng. Lập map loại bằng `settlementTypeMatches`; dùng resolver chung theo mục 3.6 thay `return 'refund'` mặc định.
- [ ] Test item lặp, item ngoài nhóm, nhiều loại, thiếu quyền/thiếu dữ liệu hạng mục và metadata xung đột; kết quả phải giữ một phiếu/một số tiền, có thông báo khi không xác định được. Không tự đổi trạng thái duyệt hoặc tạo/sửa phiếu.
- [ ] Dùng kết quả resolver để chọn tập hợp đồng cần tải căn cứ hoa hồng và kỳ ký; bỏ hạn chế chỉ tải cho raw `commission_kind==='broker'`. Giữ nguyên metadata thật khi truyền vào renderer ghi chú.
- [ ] Test tách hai nguồn như mục 3.6: HHMG thủ công có căn cứ `get_period_commissions` vẫn đối chiếu số tiền được khi RPC ghi chú không trả facts; ghi chú gốc không mất. Thiếu hợp đồng/kỳ ký/quyền/căn cứ thì thông báo thiếu đúng nguyên nhân, không hứa có ghi chú sinh tự động.
- [ ] Giữ `tier_percent` tại boundary reader căn cứ; test thiếu bậc khác bậc 0% hợp lệ, và RPC gợi ý một phiếu khác cùng hợp đồng không làm đổi identity/trạng thái của HHMG đang xem.
- [ ] Kiểm nhãn/căn cứ/chip/stat ở hai nhóm Hoàn khách và Hoa hồng đổi đúng, tổng Tất cả không đổi; nhiều bản ghi trùng mã vẫn được giữ theo UUID. Chạy lại tests classification/read model và kiểm E2E phiếu HHMG thủ công trên DEMO.

### T6 — Nghiệm thu, review và phát hành

- [ ] Tests mới T1–T5, gồm T1a/T5a, phải chứng minh lỗi cũ rồi đạt sau sửa; không dùng test snapshot đơn thuần để chứng minh tiền đúng.
- [ ] Chạy các suite hiện hữu liên quan cùng tests mới:

```powershell
npx vitest run src/lib/__tests__/contractSettlement.test.ts src/lib/__tests__/contractLifecycle.test.ts src/hooks/__tests__/useContractLifecycle.test.ts src/hooks/__tests__/useContractSettlement.test.ts src/components/thu-tien/contract-settlement/__tests__ src/lib/__tests__/terminationRefundNote.test.ts src/lib/__tests__/commissionVoucherNote.test.ts src/lib/__tests__/incomeExpensePostingValidation.test.ts src/lib/__tests__/vietqrDeeplink.test.ts src/lib/__tests__/roomLifecycle.test.ts src/lib/__tests__/settlementTypes.test.ts src/lib/__tests__/vnDate.test.ts
npm run typecheck:baseline
npm run build
npm run gate:bundle
npm run gate:rpc-cast
npm run gate:timezone
npm run gate:reconcile-money
npm run gate:reconcile-money-v2
```

- [ ] Bổ sung `.e2e-fleet/specs/hop-dong-quyet-toan-modal.spec.ts`; chạy headless trong `.e2e-fleet/`. Fixture ghi ở DEMO, đúng vai kế toán/chủ nhà và người bị giới hạn quyền; kiểm console. Không chi thật để nghiệm thu.
- [ ] E2E desktop/mobile: mở phiếu hoàn, nhiều hợp đồng, hiện ghi chú đúng, tự dùng ảnh sẵn, paste/upload, chọn ngân hàng/lưu/QR, ghi chi đúng phiếu và không trùng khi bấm hai lần. Dọn fixture.
- [ ] Giải mã ảnh VietQR thử nghiệm để đối chiếu BIN/tài khoản/tiền/nội dung, không thực hiện chuyển tiền. E2E đối chiếu cùng UUID trên Thu chi và Thanh toán, mọi stat và ba scope; phiếu cũ chi kỳ này xuất hiện đúng ngày chi.
- [ ] Mutation tests bằng `scripts/dot-bien.mjs` cho invariant cọc gross/net, khử trùng nguồn, không cấn hai lần và cách ly org. Idempotency/concurrency đi qua writer hiện hữu; không viết writer mới.
- [ ] Review độc lập phần tiền/quyền đọc; stage đúng file, gate trước push theo Contract. Commit có trailer `Co-Authored-By: Codex <noreply@openai.com>`.
- [ ] Mở draft PR vì chạm luồng tiền; ghi gate đã chạy và giới hạn. Chỉ tích hợp/phát hành theo Contract §3 sau review/gate đủ; không tự đưa mục ngoài plan vào PR.

## 5. Điều kiện chấp nhận

1. Ảnh hợp lệ có sẵn không cần bấm dùng ảnh. Tải và dán ảnh đều hoạt động, không duplicate, ảnh mới nhìn thấy ngay; lỗi chứng từ không cho ghi thành công giả.
2. Ca 401/32PVC khớp 4.500.000 thu / 1.424.000 cấn / 3.076.000 hoàn; mốc cọc không đổi thành 0 khi hoàn xong. Không hiện thiếu cọc giả.
3. Phòng có lịch sử thật hiện đúng trước/đích/sau/hiện tại; phòng trống không có hợp đồng mới giả. Hợp đồng khác không đổi phiếu đang thao tác.
4. Bảng quyết toán/căn cứ và ghi chú gốc khớp nguồn Thu chi; supplement riêng; đủ trạng thái loading/error/thiếu dữ liệu.
5. Ngân hàng tìm/chọn như ảnh; lưu xong mới QR đúng tài khoản; không duyệt/chi với draft chưa lưu hoặc QR cũ.
6. Tất Cả+Đã chi không mất paid hoặc chứa noncash; ba scope/stat/chip/table khớp quy tắc đã chốt. PC2609095 vẫn hiển thị chờ duyệt/cần rà soát theo blocker, không nhầm với phiếu sổ ảo PC2607070; ngày chi lấy posted_on.
7. Ngày chi mặc định đúng giờ Việt Nam cả trước 07:00 và lúc giao tháng/năm; ngày người dùng chủ động chọn được giữ nguyên và gửi đúng `postedOn`.
8. HHMG thủ công vào Hoa hồng, đối chiếu căn cứ số tiền theo kỳ ký/bậc hiện hành khi đủ dữ liệu, giữ ghi chú gốc và supplements; không yêu cầu ghi chú chi tiết tự sinh khi RPC hiện hữu không hỗ trợ phiếu thiếu metadata. Hoàn khách/Thưởng sale không bị ảnh hưởng. Item trùng không nhân tiền, xung đột loại hoặc thiếu căn cứ có thông báo; tổng Tất cả không đổi và không ghi ngược metadata suy ra vào phiếu thật.
9. Không thay writer, công thức tiền, quyền, schema, dữ liệu THẬT hoặc nội dung trang Thu chi. Nếu cần vượt giới hạn này phải có sửa đổi plan được người dùng chấp thuận trước.

## 6. Phần đã kiểm và chưa kiểm trong lượt lập kế hoạch

- Đã đọc mẫu HTML và đối chiếu ảnh; kiểm mã nguồn khớp nhánh remote; ba nhánh audit độc lập về ảnh/ngân hàng, vòng đời và ghi chú.
- Đã truy vấn chỉ đọc phiếu/hợp đồng/hồ sơ thanh lý/phòng cụ thể; kiểm định nghĩa live hàm tính `deposit_paid` và sự tồn tại các RPC facts/residence liên quan. Chưa coi đây là kiểm chứng RLS qua tài khoản người dùng.
- Đã chạy 7 file test / 120 test đạt: contractSettlement, terminationRefundNote, commissionVoucherNote, incomeExpensePostingValidation, vietqrDeeplink, roomLifecycle, tokenPortal. Reviewer chạy bổ sung tests ghi chú/supplement: 3 file / 17 test đạt, có trùng suite terminationRefundNote với bộ trên.
- Tests hiện tại đạt không chứng minh modal đúng; chưa thấy tests trực tiếp bao phủ các lỗi vừa xác định.
- Đã xác minh live PC2609095 và UUID của dòng PC2607070; đo lại toàn tập nhận phiếu để tái hiện số 25/72.234.500đ trong ảnh và chênh lệch khi dùng posted_on. Đây là truy vấn DB theo org, chưa phải xác minh UI/RLS của người dùng.
- Chưa sửa source, chưa chạy E2E/browser cho thay đổi, chưa kiểm vai trò/RLS của chuỗi đọc mới, chưa giải mã ảnh VietQR sinh thực tế, chưa chạy các gate phát hành. Các mục này thuộc T6 sau triển khai.

## 7. Phát sinh ngoài phạm vi đã yêu cầu — chưa đưa vào phạm vi sửa

| Vấn đề | Bằng chứng / tác động | Xử lý trong bản kế hoạch này |
|---|---|---|
| Modal không tự cập nhật đầy đủ khi máy khác sửa | Descriptor realtime tài chính chưa invalidate `contract-settlement`. | Giữ ngoài plan. Refresh sau chính thao tác upload/lưu của modal vẫn nằm trong T1/T4; đồng bộ toàn bộ realtime cần đợt riêng. |
| Hai người sửa thông tin người nhận có thể ghi đè | `editRecipient` gọi RPC hiện hữu không có khóa phiên bản. | Giữ ngoài plan, không thêm migration/CAS. T4 chỉ bảo đảm draft của phiên hiện tại được lưu và QR khớp bản đọc lại; không hứa ngăn ghi đè liên phiên. |
| Attachment PDF chưa có preview đúng | `ChungTuThanhToan` render mọi attachment bằng `<img>`. | Giữ ngoài plan vì yêu cầu hiện tại là ảnh; không mở rộng thành quản lý mọi định dạng. |

Nếu người dùng muốn thêm mục nào, cập nhật đúng mục tiêu, file và test tương ứng trước khi sửa. Không gộp cải tiến khác hoặc tận dụng lượt này để khôi phục các triển khai đã bị gỡ trước đây.
