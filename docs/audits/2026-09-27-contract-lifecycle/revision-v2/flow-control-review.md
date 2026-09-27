# Rà flow, quyền thao tác và dấu vết đối soát

Ngày 27/09/2026. Rà thiết kế, source tại `e498f10d49f3548e72074095c955371d0cee41ab` và catalog do reviewer lưu lúc `2026-09-27T12:35:40.599Z`; không truy vấn DB sống, không sửa ứng dụng. Phạm vi giữ nguyên [13 yêu cầu đã chốt](scope-alignment.md); chỉ nhượng EX01 là phần mở rộng mới.

**Kết luận:** flow chính hợp lý và có thể làm gọn cho người dùng. Tuy nhiên chưa thể kết luận hiện thực sẽ an toàn chỉ từ sơ đồ. Phải đóng các đường ghi cũ, kiểm đúng tác động của từng thao tác và nối được lịch sử với chứng từ. Các ràng buộc dưới đây làm rõ P0/P1/P6/P7/P8/P9/P11 của [master](../../../superpowers/plans/2026-09-27-contract-lifecycle.md), không thêm quyền, tầng duyệt hoặc cách tính tiền.

## 1. Người dùng chỉ cần nhớ flow này

`Báo ngày trả (nếu có) → ngày thực trả + loại thanh lý bắt buộc → chọn quyết toán ngay / sau`.

- **Chọn sau:** xác nhận một lần → đã trả phòng, sale theo thực tế → hồ sơ cũ Chờ quyết toán. Không bắt nhập đủ tiền hoặc chờ người duyệt tiền mới nhả phòng, nếu người thao tác đã có quyền ghi trả theo mapping hiện hành.
- **Chọn ngay:** kiểm tiền → xem trước → xác nhận một lần ghi trả và quyết toán. Lỗi thì báo rõ chưa hoàn tất; được chủ động chuyển sang ghi trả trước, không tự chạy nửa giao dịch.
- **Mở hồ sơ cũ:** bổ sung thông tin → đổi loại nếu cần, có lý do → xem trước → chốt theo nghiệp vụ hiện tại. Không trả phòng lần hai.
- **Thu/hoàn còn lại:** từ hồ sơ mở đúng hóa đơn/phiếu để xử lý theo quyền đang có. Xử lý xong tiền không thay lượt ở hoặc phòng khách mới.
- **Hợp đồng mới P11a:** lưu nháp → tải gửi trước → kiểm dữ liệu bàn giao → xác nhận đã ký và nhận phòng trong một lần. Giữ chỗ/cọc là thao tác riêng; ký trước, nhận sau P11b vẫn là phần chưa bật.

## 2. Mỗi thao tác được thay đổi những gì

Đây là bảng tác động để review code/test, không phải các màn hình hoặc bước duyệt mới.

| Thao tác | Kết quả được ghi | Không được phát sinh từ thao tác này |
|---|---|---|
| Báo/đổi/hủy ngày dự kiến | Lịch, lịch sử, việc nhắc, facts sale | Kết thúc lượt ở, ghi tiền, tự xác nhận đã trả khi đến ngày |
| Xác nhận trả — quyết toán sau | Ngày thực, loại ban đầu, case, kết thúc lượt ở, nhả phòng theo claim, bàn giao/việc dọn nếu có | Hóa đơn/phiếu thanh lý, chuyển cọc vào doanh thu, cấn/hủy nợ, hoàn/thu tiền; kể cả chọn Bỏ cọc |
| Xác nhận trả — quyết toán ngay | Toàn bộ phần trả phòng và kết quả quyết toán cùng một giao dịch | Một nửa đã lưu khi phần kia lỗi; thêm phiếu ngoài kết quả xem trước/nghiệp vụ hiện hành |
| Bổ sung/đổi loại khi chưa chốt | Dữ kiện, current_kind, lý do và lịch sử; preview cũ hết hiệu lực | Ghi đè initial_kind, tự ghi tiền chỉ vì đổi loại |
| Chốt hồ sơ đã trả | Kết luận cuối, snapshot, nghĩa vụ/chứng từ đúng khách cũ theo cách hiện tại | Đổi phòng/khách đang ở; tái chạy phần trả phòng; tự coi chốt số là thu/chi đủ |
| Thu, duyệt, chi, đảo chứng từ | Chứng từ/posting và số còn phải xử lý của đúng nguồn; cập nhật hàng việc | Sửa snapshot chốt cũ, mở lại cư trú, trả phòng lần nữa, đổi chủ tiền sang khách hiện tại của phòng |
| Ghi việc dọn/sửa hoặc hoàn thành | Tình trạng sẵn sàng, ngày dự kiến, người phụ trách, lịch sử/nhắc việc | Ẩn phòng trống khỏi sale chỉ do dọn/sửa; xóa giữ chỗ khách kế tiếp; tự tính lương cho việc chỉ theo dõi |
| Lưu/sửa/tải nháp | Phiên bản dữ liệu và tài liệu nháp | Giữ phòng, số hợp đồng chính thức, hóa đơn/phiếu thu |
| Giữ chỗ/nhận cọc riêng | Claim và chứng từ đúng khách/nguồn theo hành động được chọn | Tự gắn cọc cũ dựa mỗi mã phòng; coi phiếu chưa duyệt là tiền đã nhận |
| Ký và nhận ngay từ nháp | Đúng một hợp đồng, lượt ở/mốc nhận, nguồn cọc/hóa đơn theo core hiện hành; consume claim đúng khách | Nhân đôi khi bấm lại; nhận phòng chưa đủ điều kiện; tự lấy cọc của người khác |
| Nhượng | Hai hợp đồng có liên kết; khoản phí/nguồn cọc/hoa hồng có đối chiếu chéo | Đổi tên khách trên cùng hồ sơ để thay hai hợp đồng; thu cùng phí hai lần hoặc sinh hai phiếu hoa hồng |

## 3. Một hồ sơ đối soát, ba thông tin nhìn riêng

Không thêm một enum chung ghép tất cả trạng thái. Trên cùng hồ sơ hiển thị:

1. **Lượt ở:** đang ở / đã trả, ngày thực và hợp đồng nào.
2. **Quyết toán:** Chờ quyết toán / Đã chốt, loại ban đầu và loại cuối.
3. **Tiền còn phải xử lý:** còn phải thu, còn phải hoàn, phiếu chờ duyệt/chi và nguồn cụ thể.

Hai nhãn **Chờ khách thanh toán** và **Chờ hoàn khách** có thể cùng xuất hiện nếu còn hai nghĩa vụ nguồn riêng. Không lấy số thu trừ số hoàn để che một bên hoặc tự cấn; phép cấn hợp lệ vẫn theo nghiệp vụ hiện hành. “Hoàn tất” chỉ khi đã chốt và mọi nghĩa vụ/chứng từ còn hiệu lực sau core quyết toán hiện hành đã xử lý đủ, không còn dữ kiện tài chính bắt buộc chờ đối soát. Hóa đơn đã hủy đúng flow cũ không còn là nợ chờ thu; vẫn xem được lịch sử hủy để đối soát. Việc dọn phòng theo dõi riêng, không làm hồ sơ tiền phải chờ.

Ví dụ nghĩa vụ đã được chốt là còn thu 1 triệu và còn hoàn 2 triệu: phải nhìn thấy cả hai nguồn; không chỉ ghi “còn hoàn 1 triệu”. Chi đủ 2 triệu mà nợ 1 triệu chưa trả thì vẫn Chờ khách thanh toán. Đảo một chứng từ hợp lệ có thể làm xuất hiện lại khoản chờ; giữ nguyên bản chốt và thêm sự kiện đảo, không sửa lùi lịch sử.

Hàng việc có **một dòng tổng hợp/hồ sơ quyết toán**, cho mở chi tiết các nghĩa vụ. Nhiều khoản còn mở không sinh nhiều bản sao case; xử lý một khoản không xóa việc của khoản khác. Bộ lọc hai loại chờ có thể cùng tìm thấy một hồ sơ.

Màn đối soát dùng dữ liệu/liên kết sẵn có trong plan, tối thiểu có:

| Cần trả lời | Dữ liệu phải xem được theo quyền |
|---|---|
| Hồ sơ của ai? | Mã hợp đồng, mã case, khách tại lúc trả, phòng tại lúc trả; link hợp đồng nhượng nếu có |
| Đã ghi nhận việc gì? | Ngày dự kiến, ngày thực trả, loại ban đầu, lựa chọn ngay/sau, người ghi và thời điểm |
| Sau đó đổi gì? | Từng lần đổi loại/dữ kiện/lịch: trước–sau, lý do, người và thời điểm; kết luận cuối riêng |
| Tại sao ra số đó? | Snapshot chốt, dữ kiện/mốc đo và nguồn đã dùng; ngày dịch vụ khác ngày hạch toán/thu chi |
| Tiền đi đâu? | Nguồn cọc, hóa đơn, phiếu thu/chi, duyệt, posting/reversal; số còn mở theo từng nguồn |
| Còn ai cần làm gì? | Dữ kiện thiếu, khoản chưa xử lý, người phụ trách, hạn hoặc Chưa hẹn |

Sự kiện nghiệp vụ phải nối được `operation_id → case/contract/party → snapshot → chứng từ/nguồn → posting/reversal`. Tái dùng canonical operations/lineage hiện có; thiếu liên kết thì bổ sung liên kết tối thiểu, không tạo sổ tiền hay kho operation mới. Một xác nhận chính có thể tạo nhiều bút toán kỹ thuật theo bộ máy hiện hành; giao diện gom dưới cùng hành động, không hiện thành nhiều lần thu/chi độc lập. Replay cùng lệnh không tạo thêm sự kiện nghiệp vụ; lần retry kỹ thuật có thể nằm ở log vận hành.

## 4. Trigger là phần thực hiện lệnh, không là một người ra quyết định khác

Giữ các trigger ràng buộc, posting và dữ liệu suy ra cần thiết của hệ thống hiện hành. Mỗi chuỗi tác động phải có một hành động gốc được kiểm quyền. Trigger không tự cấp quyền để bắt đầu thanh lý, chọn loại, đổi chủ cọc, tạo nghĩa vụ mới hoặc duyệt/chi ngoài hành động đã được phép. Các bút toán nội bộ tự duyệt vốn hợp lệ phải map đúng authority/nguồn hiện tại; không đổi thành duyệt tay chỉ để làm sơ đồ đơn giản hơn.

P0 phải xuất **một bảng tên thật**: entrypoint/signature → kiểm quyền → writer → trigger/callee → bảng/cột/nguồn thay đổi → transaction boundary/khóa → sự kiện/chứng từ kết quả → KEEP_ADAPTER/REPLACE/REVOKE và test. P1a đóng toàn bộ đường liên quan trước bật slice. Không xem ẩn nút UI hoặc thêm wrapper là đã đóng direct REST, import, Copilot, RPC cũ hoặc bảng driving.

| Chuỗi đã thấy trong source/catalog lưu | Nguy cơ cụ thể | Ràng buộc phải nghiệm thu |
|---|---|---|
| approve_contract_termination_v1 → update_contract_on_termination_approved → contracts → update_room_status_on_contract_change → rooms → trg_room_status_reconcile/recompute_room_reservation | Duyệt hồ sơ cũ có thể chạy lại phần trạng thái phòng; writer duyệt còn có nhánh tạo phiếu hoàn | Case đã trả chỉ quyết toán một lần, không đổi phòng B; không tạo phiếu ngoài nguồn/operation được chốt |
| auto_calculate_termination_financials trên contract_terminations | INSERT/UPDATE hồ sơ legacy có thể tự điền tiền | DEFERRED dùng case PENDING riêng, không mượn CT DRAFT làm hồ sơ chờ rồi để trigger tính tiền |
| trg_contract_link_orphan_deposits | Tìm cọc theo room và khoảng ngày, có thể gắn nhầm chủ | Nối theo reservation/customer/source chính xác; đường cũ bị thay/chặn trong slice, không giữ như fallback |
| RPC tiền/approval/reversal và các trigger posting hiện có | Dễ tạo tiền trùng nếu có cả core mới lẫn trigger cũ thực hiện cùng nghĩa vụ | Một nguồn nghiệp vụ, một bộ máy posting; retry không nhân đôi; lỗi nghiệp vụ rollback; chứng từ ngược giữ lineage |
| Sweep/outbox/realtime | Nhắc việc hoặc cache có thể bị dùng để điều khiển nghiệp vụ | Chỉ nhắc/đồng bộ facts; không tự kết thúc hợp đồng, thu/hoàn, đổi loại, hủy claim hoặc đánh dấu READY |

Việc ghi lịch sử nghiệp vụ hoặc chứng từ bắt buộc lỗi thì không báo lệnh thành công. Gửi thông báo ra ngoài có thể retry sau commit qua outbox; lỗi gửi không đảo giao dịch đã thành công. Tách rõ hai ranh giới này để người dùng không bấm lại tạo việc trùng.

## 5. Quyền giữ nguyên; không phát sinh thêm cửa duyệt

- Không thêm quyền `contracts.settle` hoặc tầng xin duyệt cho các bước mới. P0/P1b map mỗi thao tác vào quyền hợp lệ hiện đang dùng, giữ người được thu/chi/duyệt và điều kiện của họ.
- Người được ghi trả không bị bắt có quyền chi hoàn chỉ để cho phòng trống. Ngược lại quyền sửa hợp đồng không mặc nhiên được đọc toàn bộ tiền hoặc duyệt/chi. Nhánh quyết toán ngay chỉ dùng được khi actor có đủ authority tương ứng hiện hành.
- Cùng actor/action/subject, UI/RPC/Copilot/import phải cho cùng quyết định. Không mượn service role, current_user, GUC hoặc trigger để lách scope/quyền. Khi bị chặn phải báo rõ thiếu dữ kiện, dữ liệu vừa thay đổi hay thiếu quyền; không gom thành lỗi chung.
- Các bước preview, version, khóa và ghi audit thực hiện bên trong hệ thống. Không biến chúng thành màn hình, nút duyệt hay thao tác nhập lại cho quản lý.

## 6. Các phát hiện và tình trạng

| ID | Kết luận rà | Cách xử lý trong tài liệu / phần chưa chứng minh |
|---|---|---|
| FC01 — cao | Nhiều đường ghi/trigger cũ có tác động nghiệp vụ chéo. Master đã nhận diện nhưng thiếu bảng một thao tác–một tập tác động để nghiệm thu trực tiếp. | Bổ sung §2/§4 ở đây, dẫn vào master §3.4/P0/P1a. Inventory tên thật và kiểm JWT/DB còn phải làm, không coi đã vá. |
| FC02 — ĐÃ RÚT KẾT LUẬN BẤT NHẤT | Chủ xác nhận mô tả giữ nợ là nhầm, yêu cầu giữ nguyên flow cũ. Không có task sửa bỏ cọc thành giữ nợ. | Giữ bằng chứng source `TerminateDialog.tsx:343,392`; `useContractOperations.ts:199` → saved `terminate_contract_forfeit_with_credit_v1:71` → `terminate_contract_forfeit:59` → `terminate_contract_forfeit_impl:86,110`. Hủy hóa đơn nợ và xử lý credit theo flags hiện hành là baseline phải bảo toàn khi chốt, không là lỗi theo plan này. DEFERRED chưa chạy tiền; adapter phải tách phần trả phòng để không đụng B. Parity TEST vẫn chưa chạy. |
| FC03 — vừa | Ba nhãn kết quả dễ bị hiểu thành loại trừ nhau, chi đủ một bên có thể bị hiểu là Hoàn tất dù bên kia chưa xong. | Làm rõ hai nghĩa vụ có thể cùng chờ, reversal mở lại việc; bổ sung P8 và sơ đồ. Không thêm cách cấn hoặc trạng thái tài chính mới. |
| FC04 — vừa | Sơ đồ vẽ ký và nhận như hai lần xác nhận độc lập, trong khi P11a gộp atomic, P11b chưa bật. | Đổi sơ đồ thành chuẩn bị bàn giao → xác nhận ký và nhận; không ngầm mở thêm luồng ký trước. |
| FC05 — vừa | Event và nguồn tiền đã có trong model nhưng chưa quy định rõ người thẩm định lần từ một hành động tới chứng từ ra sao. | §3 chốt màn đối soát/liên kết tối thiểu và gom retry; P8 triển khai trên lịch sử/source hiện có, không thêm bộ máy tiền. |
| FC06 — vừa | Sơ đồ nói tạm rút listing khi quá ngày báo trả, còn master để policy public này là đề xuất UAT. | Sơ đồ ghi rõ cách hiển thị public còn là đề xuất kiểm UAT; không quảng cáo ngày cũ sai. Nhắc quá hạn và phòng đã trả đang dọn vẫn sale là yêu cầu đã chốt, giữ nguyên. Không thêm cửa xin phép cho từng phòng. |

## 7. Điều kiện để kết luận đã hiện thực đúng

Không mở thêm dự án hoặc danh sách test song song. Bổ sung assertions vào [V01–V55 hiện có](verification-matrix.md): V08–V14 về hai nhánh/đổi loại/nghĩa vụ/reversal; V18–V20 về nháp/ký; V26/V36/V37/V40 về bypass; V41/V43 về khóa/kỳ; V49 về nhượng; V55 về đọc tài chính.

Tối thiểu phải chứng minh: deferred không đổi tiền dù chọn Bỏ cọc; quyết toán A sau B không sửa B; cùng lệnh gọi lại không thêm chứng từ/event; đổi loại giữ lịch sử; có cả phải thu và phải hoàn thì hiển thị đủ; reversal mở đúng việc; các quyền trước–sau không đổi; trigger/REST/Copilot không đi đường khác; phí nhượng và phiếu hoa hồng không trùng.

**Chưa xác minh:** build đang chạy, catalog/quyền/flags hiện tại, hành vi TEST qua JWT, race/rollback, cả hai reconcile, cron delivery và CRM E2E. Đây là rà soát thiết kế/source; những điểm đã chỉnh trong tài liệu chưa phải chức năng đã chạy đúng trong sản phẩm.
