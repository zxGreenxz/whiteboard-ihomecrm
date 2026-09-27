# Quyết định nghiệp vụ và kỹ thuật cho plan V2

**Chốt mới nhất của chủ:** ngay bước đầu **bắt buộc chọn loại thanh lý và ngày trả thực tế**. Sau đó chọn quyết toán ngay hoặc để sau. Không thiết kế lại nghiệp vụ tiền đang đúng. B1/B2/B4/B5/N1 đã rõ; các đề xuất đổi cách duyệt hoàn B3 và cách cấn cọc N2 được rút lại, giữ cách hiện hành và kiểm chứng tương thích khi thi hành. Diễn giải “chưa chọn loại ở bước đầu” của tác giả đã được chủ sửa lại và không áp dụng.

**Phạm vi cuối:** giữ nguyên13 yêu cầu trước audit; chỉ nhượng hợp đồng EX01/P9.T là phần mở rộng mới được chủ xác nhận.

## 1. Giữ nguyên các chốt của chủ

- Nháp không giữ phòng; giữ chỗ/cọc là hành động riêng.
- Bước đầu bắt buộc **ngày trả thực tế + loại thanh lý** (hết hạn/trước hạn/bỏ cọc), để có dữ liệu đối soát ngay.
- Chọn **quyết toán sau:** xác nhận đã trả, kết thúc lượt ở, cập nhật phòng và lưu hồ sơ Chờ quyết toán; không bắt nhập đủ tiền. Chọn **quyết toán ngay:** tiếp tục xử lý bằng luồng quyết toán đang dùng.
- Khi xử lý quyết toán sau được đổi loại nếu cần; lưu loại ban đầu, loại mới, lý do, người và thời điểm. Lỗi/thiếu dữ liệu khi xử lý hồ sơ đã trả không mở lại lượt ở hoặc làm thay đổi khách mới.
- Đã trả phòng thì kết thúc lượt ở và sale được ngay; tiền chưa đủ để trong hàng chờ, không coi là 0.
- Dọn/sửa là công việc nội bộ, vẫn sale là trống kèm ngày nhận dự kiến; chậm phải nhắc và cập nhật.
- Quá ngày báo trả chưa xác nhận phải còn hàng việc cần xử lý; đọc/snooze không xóa vấn đề.
- Hồ sơ khách cũ không làm đổi phòng/tiền/cọc của khách mới; chốt số khác thực thu/chi.

## 2. Trạng thái quyết định nghiệp vụ

| ID | Chủ đề / liên hệ audit | Trạng thái hiện tại | Phương án đã gửi để chọn | Task phụ thuộc |
|---|---|---|---|---|
| B1 | Chỉ số điện/nước khi khách đã đi (Q1, IA-04) | **ĐÃ CHỐT** | Chủ chọn: “Trả phòng và sale ngay; đủ chỉ số mốc mới bàn giao khách mới”. Thiếu mốc A để chờ đối soát; B phải có mốc nhận riêng rõ ràng, không tính lẫn. | P6, P11a và meter acceptance |
| B2 | Bỏ cọc và hóa đơn nợ | **ĐÃ ĐÍNH CHÍNH: GIỮ NGUYÊN FLOW CŨ** | Chủ xác nhận mô tả giữ nợ khi bỏ cọc trước đó là nhầm. Giữ toàn bộ xử lý cọc, hóa đơn nợ, credit, chứng từ và quyền như flow hiện tại, kể cả hủy hóa đơn nợ theo cơ chế đó. Rút ví dụ bắt buộc còn phải thu1 triệu sau bỏ cọc. DEFERRED chỉ ghi trả; đến quyết toán mới chạy nghiệp vụ tiền theo loại cuối. | P7/V11/V14 so parity với flow hiện hành, không sửa policy |
| B3 | Tạo/duyệt/chi phiếu hoàn | **RÚT ĐỀ XUẤT ĐỔI FLOW TIỀN** | Giữ cách tạo, duyệt, chi đang dùng và quyền hiện tại. Không tự thêm “chốt và duyệt luôn”, không ép mọi phiếu thành chờ, không thêm tầng duyệt. P0 ghi nhận baseline thực và P7 tái sử dụng. Chốt hồ sơ không tự là đã trả tiền. | P0/P7 parity, không là câu hỏi chính sách còn treo |
| B4 | Quyền chốt tiền của quản lý (Q10, IA-33) | **ĐÃ CHỐT: GIỮ QUYỀN HIỆN TẠI** | Chủ yêu cầu giữ toàn bộ quyền hiện tại, chỉ thay flow/thêm bước, không đụng quyền xử lý tiền thu–chi. Không tạo/grant quyền settle mới để thay vai trò. P0 ghi matrix hiện hành, action mới ánh xạ đúng quyền đang dùng; vẫn giữ kiểm scope và chặn bypass. | P1a/P1b, P7/P8 và permission parity |
| B5 | Nhượng hợp đồng/chủ tiền (Q12, IA-26) | **ĐÃ CHỐT** | Hai hợp đồng riêng, old thanh lý/quyết toán bình thường, new ký bình thường; cả hai đánh dấu nhượng và liên kết đối soát. Tự tìm khách: thu cọc mới hoặc dùng cọc cũ bù; hợp đồng mới được giữ hạn cũ hoặc chọn hạn mới. Qua môi giới: trích 50% từ cọc cũ trả môi giới, khách mới đóng đủ cọc. | P9.T sau P7/P9/P11a; không chặn nháp/báo trả |
| N1 | Căn cứ tính phí nhượng/hoa hồng 50% | **ĐÃ CHỐT** | 50% cọc cũ trước các khoản thanh lý khác: cọc 4 triệu → khoản thu phí nhượng bắt buộc 2 triệu để chi phiếu hoa hồng khách mới → phần cọc hoàn 2 triệu. Điện/nước/nợ/thu khác tính bình thường. Không tính 50% trên số còn hoàn sau các khoản khác. | P9.T mandatory fee + exact commission link |
| N2 | Cách bù cọc ở nhánh tự tìm khách | **GIỮ CƠ CHẾ HIỆN HÀNH, KHÔNG THÊM POLICY** | Giữ lựa chọn thu cọc mới hoặc dùng cọc cũ theo B5; agent phải map vào cách cấn/chứng từ đang dùng, chỉ thêm liên kết nguồn giữa hai hồ sơ và chống ghi trùng. Không coi câu hỏi “tự chuyển số còn hoàn 3 triệu” chưa trả lời là được duyệt; không tự tạo cơ chế chuyển tiền/duyệt mới. Nếu đường hiện hành chưa thể map thì ghi thiếu tương thích, không chọn hộ chính sách. | P0/P9.T characterization và source mapping |

**Lưu ý B1 đã chốt:** MOVE_OUT của A và MOVE_IN của B là hai mốc vật lý khác nhau nếu có dọn/sửa ở giữa. Không mặc định số B bằng số A. Thiếu A không suy số A từ số B rồi tính tiền; A ở hàng đối soát, B chỉ nhận/tính tiền từ mốc đầu riêng được xác minh. Không bắt hoàn tất tiền A mới giao B.

**B3/B4:** giữ người nào có quyền gì và giữ cả cách làm tiền hiện tại. Không bảo tồn cửa raw bỏ qua kiểm scope/eligibility như một “quyền” hợp lệ, nhưng cũng không lấy audit làm lý do viết lại cách quyết toán người dùng đã chốt đúng.

**Đính chính mới nhất, thay thế mô tả giữ nợ trước đó:** sau khi xem FC02, chủ nói “flow cũ làm sao thì giữ nguyên vậy không thay đổi do tôi nhầm”. Vì vậy **rút FC02 như một bất nhất nghiệp vụ cần sửa**. Bằng chứng source UI → credit wrapper → forfeit wrapper → saved impl hủy invoice vẫn giữ để map luồng hiện tại; không coi tác động đó là lỗi theo plan này. P0 vẫn kiểm build/catalog/flags và parity khi nối adapter, không có task đổi bỏ cọc thành giữ nợ. DEFERRED không chạy tiền; khi chốt ngay hoặc sau mới dùng kết quả của flow cũ theo loại cuối, tách khỏi phần phòng đã xử lý. Không thay quyền/duyệt. Chưa sửa app/DB.

**Nhượng theo B5:** chỉ nối hai hợp đồng và các nguồn tiền thực; không đổi đại diện ngay trên contract cũ để thay thế flow này. Khi cọc khách mới đóng riêng đủ, tiền cũ còn chờ không chặn lượt ở mới. Nếu dùng cọc cũ bù, chỉ allocation đã chốt/đủ điều kiện mới được công nhận, không dùng số chưa biết làm cọc đã nhận. Với môi giới, phần hoa hồng và phần hoàn cũ phải đối soát cùng nguồn, tránh trả cọc hai lần; duyệt/chi theo quyền hiện hành. Nếu nguồn không đủ hoặc lineage cũ mơ hồ, cần hàng xử lý cụ thể, không âm thầm trừ vượt hay tự miễn nợ.

**N1 — cấu phần, không thu hai lần:** phiếu quyết toán phải thấy cọc gốc 4 triệu, phí nhượng 2 triệu, phần cọc hoàn 2 triệu; các khoản thu khác ở dòng riêng theo luồng thường. Phí nhượng là khoản bắt buộc gắn hợp đồng cũ/transfer link và phiếu hoa hồng hợp đồng mới. Nếu đã cấn 2 triệu từ cọc để thu phí thì không ghi thêm 2 triệu thu tiền mặt cho cùng phí. Số tiền mặt cuối cùng theo cách thu/cấn hiện hành, không được trình bày nhầm phần cọc hoàn thành tổng tiền mặt sau mọi khoản. Hoa hồng không tự PAID do phí đã tính; duyệt/chi theo luồng hiện tại. Base là cọc trước các khoản thanh lý, có nguồn/snapshot đối soát; số cọc thiếu/mơ hồ cần xử lý chứ không tự đoán.

## 3. Lựa chọn kỹ thuật của V2 — không hỏi lại chủ về công nghệ

| ID | Quyết định | Vì sao / giới hạn |
|---|---|---|
| T1 | Nháp dùng bảng riêng; tài liệu mới dùng Supabase Storage private qua lớp storage hiện có, object bất biến | Repo hiện chưa bật R2 private. Migration cũ khai báo bucket private nhưng policy/live scope còn cần xác minh; getPublicUrl không chứng minh public. Không cần một dự án đổi storage để giao nháp. |
| T2 | Registry business room_next_claims riêng; hold 24h cũ chỉ là khóa thao tác | amount>0/expiry/ACL của bảng cũ không phù hợp registry mới. Hạn hold_until sinh việc nhắc; không tự mất cọc/claim tiền. |
| T3 | Không tự sửa số hợp đồng lịch sử | Giữ giấy cũ. Cấp số mới duy nhất bằng allocator hiện có được tăng guard/registry, mọi số cũ được coi đã dùng. Duplicate legacy có hàng đối soát. |
| T4 | Ký từ nháp và nhận ngay là P11a; ký trước nhận là P11b riêng | R12 được giao mà không chờ thiết kế billing tương lai. P11a dùng official core hiện hành đã kiểm guard/identity/number. |
| T5 | Đối chiếu nguồn tiền ở server, permission theo từng action **giữ quyền hiện tại theo B4** | Không allowlist mọi action chỉ ACTIVE; không tin debt/deposit totals từ client; không thêm writer tiền độc lập hoặc tự cấp/bớt quyền thu–chi. |
| T6 | Revision metadata riêng theo scope/building, có bảo đảm thứ tự commit | Không chạm rooms/contracts.updated_at; không dùng MAX(seq) thuần. Poll 5s là mục tiêu cần benchmark, không phải push. |
| T7 | Facts chung cho public/in-app/Copilot/Zalo/worker | Scope riêng theo kênh; share cùng quy tắc, không share dữ liệu riêng tư. |
| T8 | Guard/token theo transaction, actor, entity và action; kiểm quyền lại sau chờ khóa | GUC hay postgres current_user không phải capability cho ứng dụng. Không hứa chống được DB superuser cố ý sửa schema. |
| T9 | Token public có mapping org/buildings/scope_version; không đổi URL cũ khi đã map chắc | Mapping chưa chắc thì disable cần đối soát, không đoán org/tòa hoặc rơi về dữ liệu mẫu. |
| T10 | Pass thuộc một hợp đồng/lượt khách, tắt khi lượt đó kết thúc; contact theo cấu hình đã được phép | Không cho pass cũ chào lại phòng khách mới. Pass là tin đăng, không phải nguồn giữ phòng. |
| T11 | Queue là nguồn công việc, inbox/push chỉ là kênh báo | Một OPEN item mỗi source; digest theo người/ngày; không mất việc khi xóa/đọc thông báo. |
| T12 | CASE/PREVIEW/SNAPSHOT tài chính có RLS riêng, không kế thừa buildings.view | Nhân viên dọn/sale không đọc được tiền khách chỉ vì thấy tòa. |

## 4. Cấu hình đề xuất và phần mở rộng chưa bật

- Nhắc trong app: sweep 15 phút, mốc nhắc 08:00 giờ org, trước 1 ngày/đến hạn/quá hạn. Tần suất/người nhận cấu hình được; đây chưa phải lịch chủ đã xác nhận. Không tự đăng ký automation ngoài CRM. Work item tài chính có responsible và due date riêng; để trống hiển thị “Chưa hẹn xử lý”, không tự coi hết hạn.
- PENDING turnover chưa biết ngày xong: vẫn ghi được thực tế trả phòng, sale “Cần xác nhận ngày nhận” và queue cần bổ sung hạn. Không tự giả một ngày hoặc READY.
- Nhận phòng phải xác nhận đủ mốc theo B1 đã chốt và readiness, áp mọi cửa tạo ACTIVE. Có thể xác nhận READY ngay trong cùng form, không bắt đi qua một màn phụ.
- Đề xuất bổ sung tính năng hoàn tác trả nhầm từ audit không đưa vào scope hiện tại. Chỉ kiểm guard chặn sửa ngược trái phép/sai khách; không tạo nút hoặc nghiệp vụ tiền mới.
- QR tài chính khách cũ: giữ nợ/hoàn nhìn được qua capability token theo contract+party có thu hồi; không công khai số tiền trên link sale. Chỉ bật sau kiểm scope/quyền; QR cũ không được mở rộng chỉ bằng bỏ filter TERMINATED.
- P11b (ký trước nhận): G-BILLING còn mở. Hiện lập hóa đơn thủ công và first_invoice lúc tạo, không có scheduler lập hóa đơn để tái dùng. Khi triển khai P11b mới chốt đưa signed-waiting vào UI lập, ngày bắt đầu tính tiền theo hợp đồng, no-show/hủy/hoa hồng; không âm thầm dời billing_start hoặc dựng cron mới.
- Vá IA-01/02/03 được tách thành slice an toàn riêng, không được đổi kết quả tiền của luồng hợp lệ. Lượt hiện tại chỉ sửa plan; không coi đề xuất ưu tiên là đã phát hành bản vá.
