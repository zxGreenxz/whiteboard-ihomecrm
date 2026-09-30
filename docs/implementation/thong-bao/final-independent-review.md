# Review cuối: thông báo người dùng

Ngày: 30/09/2026. Worktree: codex/thong-bao-nguoi-dung; snapshot tại HEAD f854e75aac29e187088ad2ebefdd6d42e79685c4 với thay đổi chưa commit. Báo cáo này xác minh mã nguồn và fixture. Không thay thế nghiệm thu Preview hoặc production đúng SHA.

## Phạm vi

Chỉ review các phản hồi trong plan A–I: lỗi gốc bị che, lỗi trường/focus, dữ liệu tải lỗi, thông báo đúng kết quả, phần đã lưu và hướng thử lại. Đã đối chiếu caller sống/legacy và hình dạng SQL hợp lệ. Không thay quy tắc tính tiền, quyền, SQL/migration hoặc ghi dữ liệu nghiệp vụ.

Lượt đầu chỉ đọc nguồn/ghi tài liệu. Sau đó root lần lượt giao sửa đúng các khoảng trống đã xác định: bốn điểm ngoại vi; nguồn cảnh báo phiếu/gia hạn; ba caller thống kê hợp đồng. Mỗi lượt có RED→GREEN và source freeze riêng; root sở hữu review độc lập các diff reviewer đã thực hiện. Không mở audit hay thay rule ngoài những điểm root giao.

## Các phát hiện đã đóng ở nguồn

| Plan | Trước | Sau và bằng chứng |
|---|---|---|
| A07/G22 | Năm mutation MyDay có caller tự báo lỗi nhưng MutationCache báo thêm toast. | meta.handlesFeedback ở cả năm; review boundary độc lập 23 ca đạt. Root báo integration MutationCache chỉ phát một toast, trong 43 ca/3 file riêng. |
| I07/I09 | CashBook/StatBreakdowns trả 0/[] khi nguồn thiếu; chi tiết cọc có thể hiện số 0. | Nguồn bắt buộc giữ lỗi/financialReadRows/financialReadNumber; DepositBreakdownDialog có QueryRegion. Đã đọc lại và chạy bộ nguồn/quyền 22 ca. |
| G07/I14 | Đọc quyền lỗi thành false/default-owner/danh mục rỗng; route admin chuyển hướng khi chưa biết quyền. | Giữ lỗi nguồn, kiểm boolean, phạm vi không tự thành ALL; AdminOnlyRoute có QueryRegion trước redirect. Bộ nguồn/quyền 22 ca đạt; không đổi predicate quyền. |
| G09/G21 | Lưu tùy chọn rollback nhưng im lặng; lỗi RPC có thể giống cấu hình rỗng. | Nguồn cấu hình yêu cầu object; writer kiểm key/value, rollback đúng key và một owner thông báo. RoutePlanner có inlineError để giữ phản hồi riêng. 14 ca hook/rollback đạt. |
| A01/I03/I11 | RoomContractLifecycleDrawer đưa error.message trực tiếp; nguồn mất mã/cause; extras thiếu không có cảnh báo. | Drawer dùng friendlyError, giữ nguyên nguyên nhân ở nguồn, hiển thị phần extras chưa tải và retry. 8 ca DOM Drawer đạt. |
| I06 | DepositLedgerSection dùng [] thành thống kê 0 khi query lỗi. | QueryRegion bao thống kê và bảng; useThanhToanLedgers giữ trạng thái lỗi. Đã đọc lại nguồn/caller, chưa có ca DOM riêng của reviewer cho khối này. |
| I07 | RefundLog bỏ lỗi tài khoản/phiếu và trả rows/total/count bằng 0. | Account được xác nhận theo ID, nguồn rows/money bắt buộc, lỗi giữ nguyên; QueryRegion tách trạng thái lỗi và giữ bộ lọc. 5 ca DOM độc lập đạt. |
| F08/F10/F11/G09 | Onboarding thiếu tên chỉ toast; hoàn tất wizard đóng/cache trước khi lưu setting. | Đỏ/aria-invalid/focus tên tương ứng; await markCompleted rồi mới cache/đóng; lỗi giữ form. 8 ca DOM và 9 ca cờ hoàn tất đạt. |
| D06/A07 | CollectDrawer tự báo lỗi ghi chú nhưng mutation không có feedback ownership. | useUpdateInvoiceNote meta.handlesFeedback, caller vẫn giữ inline/toast của mình. Đã đọc source; root báo bộ Spend/transfer/invoice-note 44 ca đạt. |
| B14/I01 | Thống kê hợp đồng nguồn thiếu thành 0; xóa không chọn lại bản ghi vẫn báo thành công. | Thống kê/số đếm bắt buộc hợp lệ; xóa yêu cầu xác nhận ID/deleted_at và nêu mã hợp đồng. Đã đọc source; root báo 11 ca RED trước, 25 ca GREEN sau. |
| E20/I13/A01 | SpendEngine nguồn thiếu thành mảng/số 0; transfer lỗi gốc có thể lên UI. | Giữ lỗi và kiểm các nguồn cần thiết; transfer giữ PT409/42501 chuyên biệt, fallback qua friendlyError. Đã đọc source; root báo bộ 44 ca liên quan đạt. |
| A11 | Draft export/CT01 khẳng định đã lưu tệp trên máy khi mới kích hoạt tải. | Nói đã chuẩn bị tệp để tải xuống. CT01 lỗi nghiệp vụ giữ CT01InputError, lỗi khác qua friendlyError. Đã đọc source; kiểm tải thật trên trình duyệt còn thuộc E2E. |
| I03 | RoomDetailDialog bỏ error ở query hợp đồng/hóa đơn và hiện như không có dữ liệu. | Query giữ error, maybeSingle cho empty hợp lệ, QueryRegion tại khối. Root báo 4 ca DOM đạt; đã kiểm lại root gỡ destructure invoiceQuery bị chèn nhầm bên trong contract queryFn trước freeze. |

Các bộ kiểm thử root báo ở bảng là bằng chứng do root chạy, không cộng vào số reviewer tự chạy ở dưới. Các trạng thái nhiều bước/không chắc kết quả trong tài chính vẫn cần đối chiếu TEST theo kế hoạch; việc đổi phản hồi không chứng minh toàn vẹn backend.

## Bốn sửa ngoại vi của reviewer

| Plan | Trước | Sau |
|---|---|---|
| I13/G22 | useAcceptanceGeofenceConfig nuốt lỗi tải thành cấu hình mặc định. | Giữ lỗi RPC gốc; thiếu/sai phản hồi thành lỗi nguồn. SQL luôn trả object enabled/radius_m, gồm cả mặc định hợp lệ. TaskCompleteDialog/InspectionRunner có QueryRegion và Tải lại, giữ ảnh/phiên. Camera vẫn dùng quy tắc dự phòng đã có; không thay quy tắc vị trí máy chủ. |
| I03/I11 | Lịch sử giá query lỗi vẫn hiện “Chưa có thay đổi giá nào”. | QueryRegion tách lỗi/tải lại thất bại/empty thật; giữ lịch sử đã đọc kèm cảnh báo thời điểm. Hook meta inline để không báo trùng. |
| I13/G07 | parseOrganizations bỏ dòng hỏng hoặc đổi payload sai thành [] rồi báo không có công ty. | Payload/dòng sai được báo lỗi tải, giữ lựa chọn đã lưu và có Thử lại. organizations: [] thật vẫn hợp lệ; slug/member_type nullable vẫn hợp lệ theo SQL. |
| A13 | Trang không tìm thấy có câu tiếng Anh. | “Không tìm thấy trang này”, “Về trang chủ”. Log 404 chỉ diagnostic. Sửa câu nhỏ được kiểm bằng đọc diff, không thêm test chỉ khóa một chuỗi văn bản. |

RED: 33 ca, 18 đạt/15 thất bại đúng các nhánh lỗi ở trên. GREEN: 33/33 ca, 4 file, exit 0. Fixture DOM kiểm vùng lỗi/Thử lại/giữ lựa chọn/ảnh/phiên; không chỉ kiểm chuỗi nguồn. Bằng chứng final-peripheral-read-red.json và final-peripheral-read-green.json dưới .superpowers/sdd/plan.

## Kiểm thử reviewer tự chạy

| Báo cáo dưới .superpowers/sdd/plan | Kết quả | Phạm vi |
|---|---|---|
| final-independent-review-tests.json | 83/83, 10 file, exit 0 | formErrors 8; QueryRegion 7; NetworkForms DOM 3; Lucky admin 15; Lucky read 15; Lucky proof transport 3; Lucky admin DOM 3; MyDay 23; chốt sổ 4; bàn giao 2. |
| final-independent-followup-tests.json | 36/36, 2 file, exit 0 | reportPermissionSourceFeedback 22; uiPreferencesFeedback 14. |
| final-independent-lifecycle-tests.json | 8/8, 1 file, exit 0 | DOM RoomContractLifecycleDrawer. |
| final-independent-refund-onboarding-tests.json | 22/22, 3 file, exit 0 | RefundLog 5; OnboardingWizard 8; onboardingCompleted 9. |
| final-peripheral-read-green.json | 33/33, 4 file, exit 0 | Cấu hình vị trí/hai caller, lịch sử giá, parser và UI danh bạ công ty. Reviewer cũng là người sửa bốn điểm cuối; root sở hữu review độc lập diff nhóm này. |

Bốn lượt review nguồn root khác nhau có tổng 149 ca trong 16 file không trùng. Nhóm 33 ca ngoại vi là kiểm chứng thay đổi do reviewer thực hiện, được ghi tách riêng. Không cộng bộ 121 ca của reviewer tài chính hoặc các lần root chạy vào các số trên.

Đã đối chiếu SQL để không loại nhầm null hợp lệ: danh bạ có member_type nullable; cấu hình vị trí trả object gồm mặc định hợp lệ; Quay số slug/viewer nullable, xóa đội có thể làm số người thắng còn lại ít hơn. Không coi đọc không có posting là bằng chứng tiền chưa được ghi.

## Inventory đã đối chiếu theo call hiện tại

Snapshot cuối ở lượt này: 1.308 file / 1.854 call gồm notification, query, mutation và diagnostic; không phải số lỗi độc lập. Merge các ledger theo ID source hiện tại: 1.854/1.854 call khớp, 0 chưa phân loại, 0 quyết định implementation-gap còn mở. Bảng thống kê và source thật được lưu tại final-review-inventory-reconciliation.json; final-review-unclassified.json và final-review-classified-open.json là mảng rỗng.

Reviewer ledger có 164 quyết định. Trong lượt chốt đã đọc độc lập 40 call useContracts/useContractDrafts/TransferLinks/CollectDrawer/Reconciliations và ghi 1 diagnostic xuất hợp đồng. Mỗi call có caller/bằng chứng riêng. Các export chỉ definition như usePendingTerminations, useConfirmReconciliation, useCancelReconciliation được phân loại unused sau tìm caller hiện hành; không giả định chúng đã chạy E2E. Các diagnostic ngay trước throw hoặc phản hồi inline được phân loại background-only; không tạo thêm toast cho log.

Estate ledger bọc decisions được normalize đúng; metadata note không tính thành call. Các ledger chủ sở hữu và ledger tổng hợp có 52 khác biệt nhãn đóng: chủ yếu intentional-background/background/background-only và fixed/already-correct. Chúng được giữ trong báo cáo để root thống nhất khi regenerate, không tự coi là runtime defect hoặc đổi toàn file sang fixed. Ledger tổng hợp hiện tại đã có một quyết định đóng cho từng ID.

Root phải regenerate sau commit/rebase để ghim bằng chứng đúng nguồn/SHA. 0 call chưa phân loại chỉ chứng minh danh mục source đã có quyết định; không chứng minh mọi nhánh đã chạy trong Preview, mọi vai trò hoặc production.

## Ranh giới nghiệm thu

Các phát hiện thuộc phạm vi đã đọc có bằng chứng sửa/kiểm thử nêu trên. Các khoảng chưa chứng minh được ghi rõ: E2E trên Preview đúng SHA sau rebase, mọi vai trò và giao diện điện thoại, DB/RLS thật, idempotency/concurrency trên TEST, typecheck/build/bundle/gates cuối, draft PR/CI/production SHA và phép promote theo Contract §3. Không gửi thử Zalo/email/push đến người dùng thật trong fixture.

Chưa xác nhận nghiệm thu/phát hành toàn bộ tại lượt báo cáo này: inventory cuối và các bằng chứng Preview/gates/release thuộc root còn phải hoàn tất. Giới hạn này không mở rộng scope; chỉ yêu cầu chứng minh đúng những sửa thông báo được phê duyệt.

## Bổ sung hai khoảng trống nguồn đã được giao

Sau source freeze đầu, root giao xử lý đúng hai điểm đã xác định, không mở audit mới:

- A01/C04/I05: useVoucherSlotWarning giữ lỗi gốc/code, không biến null danh sách/số tiền thành []/0. IncomeExpenseForm giữ lỗi/Thử lại tại vùng kiểm tra phiếu cùng hạng mục, chỉ khi có đủ tòa/hạng mục/kỳ. Cảnh báo này không vào điều kiện khóa Lưu, không thay quy tắc chống trùng của máy chủ.
- I03/I11/B16: useRenewedContracts bắt buộc phản hồi mảng; null không thành kết luận chưa gia hạn. RenewedBadge và ContractsMobilePage có trạng thái lỗi/Thử lại. Bản điện thoại giữ các hợp đồng và bộ lọc, chưa hiển thị badge đã gia hạn khi source lỗi. Predicate APPROVED/COMPLETED giữ nguyên.

Bộ nguồn/query và DOM: final-slot-renewal-red.json có 8/26 ca thất bại đúng lỗi; final-slot-renewal-green-2.json đạt 26/26, 4 file, exit0. Lần GREEN đầu 25/26 do fixture kỳ null của phiếu đang sửa thực tế được form cấp tháng mặc định; đã chỉnh fixture thành chưa chọn tòa/hạng mục để đúng source disabled, không đổi điều kiện hoặc quy tắc form. Các ca kiểm dữ liệu trống thật, giữ code 42501, số tiền thiếu, retry, và Lưu vẫn hoạt động khi cảnh báo tải lỗi.

Review ReportingRole root giao sau đó: đã đọc mutation useSetBusinessPerformanceReportingRole và caller ReportingRoleConfiguration. Mutation giữ lỗi gốc, meta.handlesFeedback để caller sở hữu phản hồi; caller dùng friendlyError inline, giữ lựa chọn và giải thích thiếu vai trò cạnh nút. Không đưa SQL/RPC/mapping trong phản hồi mới. Chạy độc lập final-independent-reporting-role-tests.json đạt 45/45, 3 file, exit0; không cộng lặp vào các báo cáo root đã chạy.

Nguồn đã freeze riêng sau hai điểm này. Số inventory 1.851/45 còn chờ ở thời điểm đó đã được thay bằng snapshot 1.854/0 sau owner refresh và review caller cuối; xem mục Inventory bên trên. Không suy trạng thái theo file.

## Chốt caller thống kê và read-ledger theo phạm vi root giao

Ba caller của thống kê hợp đồng trước đây chỉ lấy data rồi dùng fallback 0 dù hook đã giữ lỗi nguồn. Đã sửa đúng I01/I11:

| Caller | Trước | Sau |
|---|---|---|
| ContractsPage | Bốn ô thống kê hiện 0 khi tải lần đầu lỗi. | QueryRegion riêng thống kê hợp đồng, thông báo lỗi và Tải lại; giữ ô tìm kiếm, bộ lọc và danh sách. |
| ContractsMobilePage | Tiêu đề “0 hợp đồng thuê” và các tab đếm 0. | Không hiện tiêu đề số lượng khi query chưa xác nhận; QueryRegion ở các tab thống kê, giữ tòa/phòng/danh sách và trạng thái gia hạn. |
| DashboardMobilePage | Tổng quan hợp đồng hiện bốn số 0. | QueryRegion chỉ khối số liệu hợp đồng, lỗi và tải lại đúng nguồn; giữ lựa chọn tòa và khối khác. |

useContractStats/useContractDashboardCounts chỉ bổ sung metadata inline sau khi toàn bộ caller sống của hai hook đã có lỗi+retry. Không đổi công thức/count, bộ lọc hoặc commission. Không thêm validator nghiệp vụ hay SQL.

RED final-contract-stats-regions-red.json: 3/3 ca DOM thất bại vì chưa có vùng lỗi. GREEN final-contract-stats-regions-green-3.json: 27/27 ca, 3 file, exit0 (3 DOM mới, 1 hồi quy gia hạn mobile, 23 nguồn hợp đồng). Hai lần GREEN trung gian chỉ cần chỉnh fixture đợi query của bộ lọc mới hoàn tất và dùng đúng tên truy cập nút có khoảng trắng; không đổi source để chiều fixture.

Read-ledger độc lập final-ledger-callers-green.json: 39/39 ca, 8 file, exit0: DeleteContract 2; PrintDraft 6; DraftList 5; DraftExportReceipt 8; Transfers 3; Reconciliations 3; ReconcileDialog 2; CollectDrawer.receiving 10. Đã đọc enclosing call/caller/API rồi đối chiếu các ca; không dùng kết quả này để đánh fixed mọi call trong cùng file.

Source freeze mới sau ba caller thống kê. Reviewer không stage/commit/rebase; root tiếp tục review độc lập diff nhóm này và gate/Preview/PR/promote đúng SHA. Không tuyên bố production đã phát hành trong báo cáo reviewer.

## Bổ sung I01 mobile theo review độc lập của root

Root review nhóm ba caller thống kê và phát hiện ngay trong DashboardMobilePage còn tám nguồn bỏ trạng thái query. Chỉ hoàn thiện các vùng trên chính file này, không mở audit nơi khác và không sửa hook/công thức/CSS:

| Vùng/nguồn | Trước | Sau |
|---|---|---|
| Chọn tòa / useBuildings | Lỗi tải giống danh sách tòa rỗng. | QueryRegion danh sách tòa, Tải lại; lựa chọn persisted được giữ. |
| KPI / useDashboardStats | Nguồn thiếu làm cả phần bảng tin chỉ hiện đang tải. | Vùng số liệu có lỗi/tải lại riêng; khối khác vẫn dùng nguồn riêng. |
| Doanh thu / useRevenueChart | Lỗi giống biểu đồ rỗng. | Vùng lỗi doanh thu theo tháng, tải lại đúng nguồn. |
| Lấp đầy / useOccupancyChart + stats | Nguồn thiếu có thể là 0 phòng/biểu đồ rỗng. | Guard hai nguồn cần cho tổng phòng và tỷ lệ; lỗi/tải lại đúng vùng. |
| Tổng quan khách hẹn / useLeads | [] fallback làm bốn số 0. | Chưa tải được tổng quan khách hẹn; công thức giữ nguyên sau source success. |
| Tổng quan cọc / useDeposits | [] fallback làm bốn số 0. | Chưa tải được tổng quan đặt cọc; retry riêng, giữ lọc. |
| Cảnh báo / useAlerts | Lỗi giống không có cảnh báo, còn suy toàn hệ thống bình thường. | Lỗi/tải lại riêng; empty xác nhận nói “Không có cảnh báo trong phạm vi đang xem.” |
| Hoạt động / useRecentActivities | Lỗi giống chưa có hoạt động nào. | Lỗi/tải lại riêng; empty thật vẫn hiện đúng. |

RED final-mobile-dashboard-regions-red.json: 8/9 ca thất bại đúng tám vùng chưa có lỗi; ca empty thật đạt. GREEN final-mobile-dashboard-regions-green-2.json: 21/21 ca, 3 file, exit0: 11 DOM mới của mobile (8 lỗi/retry từng nguồn, empty thật, cached mạng, cached quyền), 3 DOM thống kê hợp đồng và 7 QueryRegion. Retry giữ tòa đang chọn; không refetch nguồn ngoài vùng. Riêng lấp đầy tải lại stats + occupancy vì số tổng phòng phụ thuộc stats. Khi lỗi mạng sau đã tải, cảnh báo hiển thị giờ dữ liệu cũ; khi lỗi quyền, dữ liệu cũ không còn hiển thị.

Đã bổ sung bằng chứng caller mobile cho tám call query hiện tại trong reviewer ledger. Đây là quyết định theo call/caller đã đọc và fixture, không khẳng định mọi caller khác đã E2E. Source mới freeze: chỉ DashboardMobilePage; root sở hữu review độc lập diff/test trước checkpoint rebase/gates.


## Review độc lập bản ghép sau rebase và lint fixture

Phạm vi chỉ các file root/finance giao để giữ thay đổi main trong bản thông báo. Đối chiếu bản main ở HEAD rebase 45149b9b và checkpoint task 281449fe; không sửa source trong lượt review:

- ContractDetailView, ContractDetailDesktop và test mobileSettlement: giữ vị trí commissionFollowup của main ở cả desktop/mobile; queryStates và QueryRegion của task vẫn bảo vệ nguồn hợp đồng, công nợ, khách/xe/dịch vụ/lịch sử. Lỗi quyền ẩn dữ liệu cache; công nợ chưa xác nhận không thành zero.
- ContractSettlementSection: khác biệt nguồn so với main chỉ chuyển lỗi danh mục tòa qua phản hồi an toàn và giữ code/cause. Hàng đợi phiếu chưa hoàn tất, phân trang, bộ lọc và công thức của main giữ nguyên.
- CommissionVoucherModal, ContractCommissionFollowupPanel, useCommissionVoucher, useContractCommissionFollowup và hai test component cùng fixture commissionReservationFeedbackOwner: giữ protocol prepare/retry, saved intents, onlyKind và manager_id của main. Không phục hồi decision UI hay lớp retry cũ mà main đã thay. Thông báo partial giữ mã phiếu đã tạo và retry đúng yêu cầu đã lưu; lỗi đầu vào tại người quản lý được focus; lỗi quyền/transport an toàn và có một owner.

Không phát hiện regression có thể hành động trong các diff đã đọc. Chạy độc lập hai suite detail + settlement sau finance source freeze đạt **87/87 ca, 2 file, exit0** tại `.superpowers/sdd/plan/final-rebase-details-settlement-independent.json` (detail 23, settlement 64). Artifact `final-rebase-settlement-section-independent.json` trước freeze có 0 ca/exit1 vì dependency còn marker rebase; giữ riêng, không diễn giải thành lỗi sản phẩm. Finance báo 70/70 trong 5 suite commission ở `commission-rebase-focused.json`; đó là bằng chứng của owner, không phải lượt chạy độc lập này.

Root giao đúng 8 tệp kiểm thử để đóng lint gate; chỉ sửa kiểu fixture và tên component/helper dùng Hook, không sửa source sản phẩm, không đổi assertions, không dùng any alias/implicit-any/disable hoặc chỉnh baseline. `final-owned-fixtures-lint-red.json` ghi **20 lỗi, 0 cảnh báo**; `final-owned-fixtures-lint-green.json` ghi **0 lỗi, 0 cảnh báo**, cùng 8 file. Chạy đủ 8 suite sau sửa đạt **111/111 ca, exit0** tại `final-owned-fixtures-lint-tests.json`:

| Tệp kiểm thử | Số ca đạt |
|---|---:|
| CustomerForm.feedback | 3 |
| contractListReadFeedback | 23 |
| contractNoticeOperationFeedback | 10 |
| financialReadFeedback | 33 |
| meterOutcome | 5 |
| meterReadingOutcome | 17 |
| slotAndRenewalReadFeedback | 9 |
| DashboardMobilePage.feedback | 11 |

Nhóm fixture đã freeze; reviewer không stage/commit/rebase. Các số này chỉ chứng minh phạm vi đã chạy, chưa xác nhận gate toàn repo, Preview/E2E đúng SHA hoặc production. Root còn phải chốt SHA sau rebase, regenerate inventory và thực hiện quy trình phát hành đã được user cho phép.


## Review hẹp F09 dịch vụ tòa, sau khôi phục luồng ghi main

Root giao độc lập đúng useBuildingServices và buildingServiceWriteOutcome sau owner khôi phục writer. Diff origin/main xác nhận DELETE toàn bộ liên kết theo building_id rồi INSERT bốn trường building_id/service_id/is_active/unit_price_override giữ nguyên; sáu API legacy casts vẫn như main. Không có incremental read/upsert/delete, giới hạn giá âm/trùng phía client, thay organization/auth payload hoặc SQL. Biên nhận select bổ sung xác nhận chính xác kết quả; signed decimal ban đầu vẫn chuyển nguyên tới máy chủ.

Guard dùng actor + buildingId tạo dấu chờ trước DELETE, giữ mã biên nhận trước kiểm cả lô; null/wrong receipt không gửi INSERT. Xóa [] thật cho phép tiếp tục. Lỗi đầu tiên xác định do máy chủ giữ nguyên cause và không ghi bước sau; xóa đã xác nhận nhưng chưa xác nhận lưu mới báo partial và giữ mã, chặn chạy lại toàn bộ sau remount. Lượt độc lập `final-building-service-independent.json` đạt **8/8 ca, exit0**. Các ca nguồn chỉ là fixture, chưa chứng minh RLS/SQL production.

Review tích hợp phát hiện symbol adapter task cũ còn dùng tại BuildingFormDialog: import BuildingServicesPartialError và instanceof/savedServiceIds, nhưng hook đã chuyển sang FinancialWorkflowError và không export adapter. Đã báo root/owner; chưa chấp thuận tích hợp tại thời điểm phát hiện. Cần sửa hẹp caller rồi kiểm caller/typecheck trước commit. Không tự phục hồi writer cũ hoặc sửa nguồn từ reviewer.

Legacy organization auto-fill là hiện trạng có sẵn trên main và chưa thay đổi trong hai file này. Root cho biết proposed org metadata và mở rộng gate AST đã bị auto-review từ chối, chưa áp dụng. Review này không né từ chối, không tuyên bố debt đó đã sửa hoặc payload đã được gate bảo vệ. Phát hành/gate cuối còn thuộc root.


### Đóng finding adapter caller F09

Sau finding, root giao owner sửa thêm đúng BuildingFormDialog. Reviewer đọc lại final patch ba file: caller import FinancialWorkflowError từ leaf hiện có, chuyển nguyên error.completed vào progress để mã đã gỡ không bị đổi nhãn thành đã lưu. Form gọi useUpsertBuildingServices({silent:true}); hook metadata handlesFeedback:true và default safe toast, form giữ phản hồi inline nên một owner. Writer/payload/cast của main không đổi trong bổ sung này.

Independent `final-building-service-caller-independent.json` đạt **22/22 ca, 3 file, exit0**: hook 9, BuildingFormOwnerRetry 6, buildingSaveWorkflow 7. `git diff --check` đúng ba file sạch. Finding missing export đã đóng; không còn điểm cần sửa trong phạm vi review hẹp này. Chấp thuận root tiếp tục gate/integrate, chưa đồng nghĩa gate toàn repo hoặc production đã đạt. Legacy org-autofill/gate rejection giới hạn nêu trên vẫn giữ nguyên.


## Review hẹp writer quota so với main 45149b9b

Root giao read-only bốn hook để kiểm giới hạn notification-only. Finding ban đầu: quota UPDATE đổi DELETE-all → INSERT thành read/upsert-before-delete obsolete, thêm org payload/filter và client limits; các update vật tư cũng đổi order/identity. Root giao owner khôi phục operation/order/payload; reviewer không sửa nguồn/gate.

Sau quota source freeze, reviewer đối chiếu đúng useCreateServiceQuota/useUpdateServiceQuota và test owner với main:

- Create giữ header ba trường name/description/user_id, tier năm trường quota_id/tier_number/from_value/to_value/unit_price. Không thêm organization_id vào writer. Selected organization chỉ thuộc dấu chờ của cơ chế giữ kết quả.
- Update giữ header UPDATE theo id, DELETE toàn bậc theo quota_id, rồi INSERT năm trường nếu có dòng. Không upsert/read trước DELETE/giữ ID dòng cũ, không thêm org filter hoặc payload. Dữ liệu signed/empty/duplicate trước đây hook chuyển server vẫn được chuyển như main; validation helper cũ còn trong file nhưng hai mutation không gọi nên không áp giới hạn mới.
- Select receipts thêm việc xác minh mã/nội dung; mã header/đã gỡ/mới nhận được persist trước kiểm toàn bộ phản hồi. Nhãn deleted/new giữ khác nhau; null/wrong receipt báo phần đã xác nhận và chặn chạy lại toàn bộ sau remount. Lỗi máy chủ giữ nguyên cause, chi tiết kỹ thuật ở log.

Independent `final-quota-main-writer-independent.json` đạt **24/24 ca, 2 file, exit0**: serviceQuotaWriteOutcome 22 và EditQuotaDialog.partial 2. `git diff --check` đúng hook/test sạch. Findings operation/order/org/rules trong **hai mutation quota này** đã đóng; chấp thuận review hẹp sau restore. Kết quả này không đóng finding thứ tự liên kết useUpdateService hoặc các hook vật tư đang chờ owner freeze, không tuyên bố whole file đã được review hay gate/production đạt.


## Đóng findings writer ba hook vật tư sau restore main

Sau source freeze 17:36:54, reviewer đọc useMaterialPurchases/useMaterialUsages/useMaterialAdjustments và fixture parity, đối chiếu main 45149b9b. Không sửa source/gate hay chạy compiler app:

- Purchase update giữ UPDATE header → DELETE toàn dòng theo purchase_id → INSERT nếu có dòng. Job existing giữ UPDATE header → DELETE toàn dòng theo usage_id → INSERT; nhánh empty giữ UPDATE → DELETE-items → DELETE-header. Không upsert/reuse ID/read-before-delete obsolete.
- Header/item giữ projection từng trường như main, ID dòng mặc định máy chủ; không client UUID/spread item ngoài payload. Purchase/adjustment empty vẫn INSERT header; manual usage giữ check ít nhất một dòng đã có trên main; không thêm sign/quantity/SET-target constraints ở hook.
- SET giữ delta target-current, IN/OUT theo dấu, Math.abs, todayISO, lý do mặc định và item dạng object như main. Không đổi SQL, RPC, org/auth payload hoặc công thức.
- Create purchase/manual usage/adjustment/SET giữ DELETE-header cleanup sau **API insert-lines error** như main. Không chạy cleanup chỉ vì biên nhận thiếu/malformed. Job new không thêm cleanup ngoài main.
- Cleanup đúng ID + original known rejection báo phiếu tạm đã gỡ, bỏ ID khỏi completed để guard mở lần sửa/thử lại. Cleanup lỗi/missing/wrong ID hoặc original unknown giữ ID/barrier. Original unknown nhưng cleanup confirmed dùng nhãn header đã gỡ, không khẳng định header vẫn tồn tại. Update lỗi sau DELETE nói rõ header và dòng cũ đã thay đổi, không chạy lại toàn bộ.

Independent `final-material-main-writer-independent.json` đạt **57/57 ca, 5 file, exit0**: materialMainWriterParity 22, materialVoucherOutcome 14, assetMaterialDeleteOutcome 12, MaterialVoucherForms.feedback 5, materialUsageValidation 4. `git diff --check` đúng ba hook sạch. Findings order/identity/fields/cleanup/new-hook-rules trong ba hook đã đóng; chấp thuận review hẹp để root tiếp tục gate. Không dùng fixture để tuyên bố live stock triggers/DB atomicity/cross-tab hoặc production đã xác minh. Finding service link-order do root đang xử lý riêng, chưa đóng theo kết quả vật tư.


## Review hẹp thứ tự liên kết dịch vụ, khu và phương tiện khách

Root freeze useServices/useAreas/useCustomers sau khôi phục writer theo yêu cầu notification-only. Reviewer chỉ đọc diff main và fixture, chạy đúng suites, không sửa nguồn/gate/compiler:

- Service giữ DELETE liên kết cần gỡ → ACTIVATE liên kết đang tắt → INSERT tòa mới; raw building_ids cho INSERT như main, filters DELETE/UPDATE chỉ in(id) như main. Create không deduplicate mảng tòa ghi. Payload/withOrg có sẵn giữ nguyên. Hai mutation quota đã review ở trên không đổi; helper validation cũ không dùng đã bỏ.
- Area assignment giữ DELETE theo area_id + original toRemoveIds → UPSERT toàn original toAddIds, gồm overlap/duplicate đầu vào; onConflict area_id,building_id + ignoreDuplicates:true và ba trường area_id/building_id/user_id như main.
- Customer vehicle sync giữ REMOVE soft-delete → UPDATE từng xe còn giữ → INSERT xe mới; original filters/payload projection/withOrg đã có giữ nguyên. Biên nhận thêm progress/partial IDs, không chuyển thứ tự ghi.

Independent `final-estate-service-main-writer-independent.json` đạt **58/58 ca, 6 file, exit0**: serviceQuotaWriteOutcome 25, đúng EditQuotaDialog.partial 2, estateCoreWriteOutcome 14, vehicleAreaWriteOutcome 13, areaDeletePartial 1 và CustomerForm.feedback 3. `git diff --check` đúng ba source sạch. Artifact root service-main-order-green.json thực tế 25/25 trong một file, estate-main-order-green.json 31/31 trong bốn file; không ghi nhầm chúng thành 27/2 hoặc lượt độc lập của reviewer.

Findings thứ tự/input/filter của service và customer đã đóng. Còn một finding biên nhận ngay tại helper confirmPairs của area assignment: null bị thay [] và có thể pass khi expected removed/missing=[]; một phần phản hồi pair hợp lệ cũng chưa được persist trước khi kiểm toàn lô. Đã báo root để sửa hẹp requireArray + ghi mã cặp nhận hợp lệ và giữ nhãn cần đối chiếu trước batchcheck. Các 58 ca hiện có không bao phủ hai nhánh đó nên chưa chấp thuận closure toàn ba source ở thời điểm này. Không mở audit/caller/rules ngoài phạm vi được giao.


### Đóng finding biên nhận pair khu/tòa

Root sửa duy nhất confirmPairs: bắt buộc mảng thật dù số cặp kỳ vọng bằng zero; persist cặp area_id đúng và building_id dương trước batch validation với nhãn đã nhận mã/cần đối chiếu; chỉ đổi nhãn các bước mới từ start của lô sau xác nhận đầy đủ. DELETE → UPSERT, raw input arrays, filters, payload/onConflict vẫn như main. Reviewer đọc lại helper và các ca RED→GREEN, không sửa nguồn/gate.

Independent `final-area-receipt-closure-independent.json` đạt **83/83 ca, 7 file, exit0**: serviceQuota 25, actual EditQuotaDialog 2, areaDelete 1, estateCore 14, vehicleArea 16, CustomerForm 3, materialMainWriterParity 22. Các ca mới kiểm null expected-zero hai nhánh, partial positive pair persist và remount không replay. Finding biên nhận pair đã đóng; phạm vi thứ tự ghi service/area/customer được chấp thuận sau sửa này.

Tại lượt kiểm này, diff --check đúng ba file có exit1 vì useAreas.ts toàn CRLF bị đánh trailing whitespace sau root sửa. Đã báo root để normalize LF trước checkpoint; reviewer không sửa nguồn. Không dùng các suite xanh để khẳng định kiểm định dạng/global gates/E2E/release đã đạt; root vẫn sở hữu bước đó và SHA production.


## Review hẹp 15 file sửa typing noUncheckedIndexedAccess

Root giao read-only đúng 15 file trong notification-nuia-errors.txt (42 diagnostics). Không thay source/gate/metadata/business, không chạm approval template đang pending. Baseline HEAD lúc review 6ed43de64fd5c7f6e27c6f303403f760aaab2624; staged index chỉ Areas/Services khác HEAD ở writer restore đã được review trước. Các delta typing được đối chiếu index → working tree, giữ hai phạm vi đó riêng.

Reviewer đọc actual 15-file diff: non-null assertions được đặt sau invariant đã có (length/nonempty, push completed, singleton, regex đủ nhóm, split có phần tử đầu, Object.keys có label, Zod strict giới hạn key, Promise.allSettled giữ thứ tự/độ dài). Không thấy assertion được dùng để bỏ qua một nhánh kiểm bắt buộc của luồng đang đọc. Tuple/as const/key cast chỉ thuộc typing; không thêm default, predicate, writer, payload hoặc quy tắc.

Independent read-only Node check dùng TypeScript transpileModule removeComments đối chiếu chính staged source với working source: **14/15 emitted JS byte-identical**. File salarySettingsFeedback là ngoại lệ được ghi rõ: tách rejection !key vốn đã có ra trước truy cập result[key]. Mapping, điều kiện integer/nonnegative, TypeError/message và kết quả giữ nguyên. Reviewer tự chạy **29/29 before/after plain-JSON probes tương đương**, gồm thiếu/unknown job, 3 job số lượng hợp lệ/sai, digest, push drain và skipped. Command exit0. Đây là probe trên dữ liệu JSON của API, không tuyên bố mọi đối tượng JS có accessor/proxy sẽ tương đương.

Đã đọc proof owner notification-nuia-estate-runtime-proof.json (6 file), notification-nuia-owned-runtime-parity.json (4 file) và đúng tên finance-nuia-runtime-comparison.json/finance-nuia-salary-runtime-probe.json (5 file, salary JS khác được báo). Parsed owner artifact finance-nuia-focused.json **53/53** và notification-nuia-owned-focused.json **66/66**; đó là các lượt của owner, không cộng làm kiểm thử độc lập của reviewer. Root sở hữu full typecheck/noUncheckedIndexedAccess/app/gates/E2E/production SHA cuối. Review hẹp typing không có finding còn mở.


## Review độc lập leaf imports và thời điểm focus B03

Root giao read-only đúng financialWorkflow.ts, recordWriteOutcome.ts, useResidenceRegistrations.ts và hunk onError của useContractSubmit.ts. Reviewer đối chiếu HEAD 6ed43de64fd5c7f6e27c6f303403f760aaab2624 với working tree bằng kiểm tra toàn văn: ba file đầu chỉ đổi import; file submit chỉ đổi thứ tự await refreshStaleOrphanDeposits và gọi void applyFeedbackToForm. Không sửa nguồn/template/payload/gate/auth/business.

- financialWorkflow.ts chuyển từ wrapper voucherOutcomeUnknown sang alias hasUnconfirmedResponse của operationOutcome. Wrapper cũ chỉ return hasUnconfirmedResponse(error); mọi call hiện tại truyền một tham số. Predicate unknown/partial, status/code/cause và các bước guard giữ nguyên.
- recordWriteOutcome.ts và useResidenceRegistrations.ts import FinancialWorkflowError trực tiếp từ leaf. financialWorkflow.ts vẫn re-export đúng class từ leaf đó; instanceof cùng class, không tạo class mới hoặc đổi xử lý biên nhận/lưu hồ sơ.
- B03 giữ request, writer, validation, nội dung thông báo, dữ liệu form và logic refresh cọc. Sau refresh, setError vẫn chạy trước focus; focusFirstError đã có lượt đợi timer để React commit. Không await promise focus trong onError cho callback kết thúc và fieldset pending có thể mở trước lúc chọn ô. Chưa xem suite mock hook là bằng chứng fieldset thật trên trình duyệt đã mở đúng thời điểm.

Lượt `final-leaf-contract-focus-independent.json` exit0 ghi 78 ca, nhưng đối chiếu đường dẫn sau đó phát hiện năm ca thuộc bản main archive trong .superpowers/sdd/plan/main-bundle-parity. **Nguồn hiện hành của lượt đó là 73/73 ca, 7 file**: financialWorkflow 23, operationOutcome 3, voucherFeedback 13, residenceWriteOutcome 6, formErrors 8, useContractSubmit.focus 2 và useContractSubmit 18. Hai testResults cùng tên file thuộc hai đường dẫn khác nhau, không phải hai nhóm của cùng file như bản báo cáo ban đầu. Đã sửa số đo và báo root; không dùng năm ca archive làm bằng chứng patch hiện hành. Review hẹp không có finding nguồn còn mở. Root sở hữu E2E desktop/mobile, bundle/build/gates, đúng commit và phát hành; kết quả review này không tuyên bố chúng đã đạt.


### Review bổ sung chờ mở khóa fieldset trước focus B03

Root báo lượt trình duyệt mới vẫn RED desktop/mobile: hai ngày đã đỏ nhưng focus còn ở dialog; timer đơn thuần chưa đủ dù fieldset cuối đã mở. Reviewer chỉ đọc bổ sung waitForEnabled của formErrors và option tương ứng tại callback tạo hợp đồng, không sửa nguồn hoặc nghiệp vụ. Option mặc định không bật nên caller khác giữ luồng cũ. Với input ngày hiện tại có name, helper chờ khi :disabled thật, quan sát thuộc tính disabled trong root; khi mở khóa hoặc hết 2 giây đều disconnect observer và clear timeout rồi thực hiện cùng đường focus cũ. Không gửi lại mutation, không đổi error mapping/draft/writer. Ca DOM mở fieldset sau 20 ms chứng minh không bỏ qua input trước khi nó mở khóa.

Parsed bằng chứng owner contract-fieldset-focus-red.json có **8/9 ca, 1 fail đúng focus**. contract-fieldset-focus-green.json ghi 36 ca nhưng có năm ca main archive, nên chỉ **31/31 ca, 3 file nguồn hiện hành**; không ghi số 36 như gate của patch. Reviewer chạy lại bounded suites với CLI --exclude '.superpowers/**' (không sửa config/gate). `final-fieldset-focus-independent.json` đạt **78/78 ca, 8 file nguồn hiện hành, exit0**: financialWorkflow 23, operationOutcome 3, voucherFeedback 13, residenceWriteOutcome 6, formErrors 9, contractBillingBounds 4, useContractSubmit.focus 2 và useContractSubmit 18. Đã kiểm mọi đường dẫn testResults nằm trong src hiện hành; không có archive.

Review hẹp waitForEnabled không có finding nguồn cần sửa. Bằng chứng DOM không thay thế E2E fieldset thật: root còn phải rebuild và chạy lại desktop/mobile, chưa tuyên bố browser GREEN hay production đạt. Tại thời điểm review ba source/test này là CRLF sau chỉnh của root; reviewer chỉ báo để owner chuẩn hóa trước checkpoint, không sửa định dạng nguồn.


### Review B03 final, một dòng template được cho phép và coordinator hồ sơ tải khi lưu

Root giao read-only phiên bản cuối sau finding parent dialog tạm aria-hidden. formErrors giữ option waitForEnabled mặc định tắt; B03 bật option tại cùng callback. Kiểm tra có control tương tác được dùng visibleControl đã có, vẫn giới hạn trường trong root và thứ tự lỗi cũ. Observer document được dùng để thấy parent phía trên root mở lại; chỉ chạy trong cửa sổ chờ tối đa 2 giây, quan sát disabled/aria-hidden/hidden/inert/style/data-state và childList. Cả thành công lẫn timeout đều disconnect/clear timeout, rồi đợi một tick để dialog hoàn tất phục hồi focus trước cùng đường focus lỗi. Không đổi dữ liệu, predicate ngày, writer hay gửi lại yêu cầu.

Reviewer đọc owner artifacts: contract-parent-focus-red.json **9/10 ca, 1 fail đúng parent-hidden focus**; contract-parent-focus-green.json **32/32 ca, 3 file nguồn hiện hành**. notification-local-e2e-interactable.json/txt có **10/10 expected, 0 skipped/unexpected/flaky**: desktop/mobile phiếu thu chi trống, ngày kỳ đầu sai, biên bằng nhau + lỗi máy chủ hợp đồng và lỗi thống kê/quyền ở bốn vai trò. Đây là lượt E2E của root trên local working label, không phải lượt reviewer tự chạy và **chưa chứng minh exact SHA phát hành**. Trạng thái browser pending ở đoạn review trước đã được cập nhật bằng proof local này; vẫn chờ exact-commit Preview/gates/promote.

Root báo người dùng đã trực tiếp cho phép đúng một dòng template. Reviewer xác minh toàn văn HEAD → working của useDocumentTemplates.ts chỉ `.insert(submitted)` thành `.insert(withOrg(submitted, selectedOrganizationId))`. submitted đã qua withOrg cùng tổ chức trước đó; helper hiện có giữ payload đã có organization_id, nên lần bọc thứ hai giữ cùng object/reference/fields. Không đổi helper org, catalog, gate hoặc payload khác.

Reviewer xác minh toàn văn residenceRegistrations.ts chỉ chuyển class sang financialWorkflowError leaf và await import persistentFinancialWorkflow ngay trước .run. Validation mã và getSessionUser vẫn đi trước; .run giữ nguyên namespace/scope/target org và bao quanh writer upsert. Input projection, onConflict, quyền/lỗi, receipt matching, mã giữ lại và reconcile đều không đổi. Nếu tải coordinator chưa xong hoặc lỗi, writer chưa chạy; không có đường ghi bỏ qua guard.

Independent `final-b03-template-residence-independent.json` đạt **106/106 ca, 9 file hiện hành, exit0**, CLI exclude .superpowers/**: accountTemplateReceipts 53, documentTemplateFeedback 1, orgPayload 9, orgPayloadCoverage 3, residenceWriteOutcome 6, formErrors 10, contractBillingBounds 4, useContractSubmit.focus 2 và useContractSubmit 18. Không có test path archive. Năm file source/test được review đã LF và diff --check exit0; finding định dạng CRLF trước đó đã đóng. Review hẹp không có finding nguồn còn mở. Bundle và global gates do root/owner đang kiểm; chưa tuyên bố production đã đạt.


## Review độc lập A13: tải tên trang khi ErrorBoundary bắt lỗi

Root giao read-only ErrorBoundary và bảng tên trang nhẹ sau owner freeze. Reviewer /root/finish_copilot đọc diff HEAD 6ed43de64fd5c7f6e27c6f303403f760aaab2624 → working tree, props/fallback và chunkReload hiện hành; không sửa source, test, config, baseline, gate hoặc stage.

- Props children/fallback/pageName và ưu tiên pageName (kể cả chuỗi rỗng), custom fallback giữ nguyên. Nhánh khỏe trả children và không import tên trang; custom fallback/explicit pageName cũng không cần tải bảng tên. Trong lúc import còn chờ hoặc bị từ chối, thông báo dùng tên chung “đang mở”, vẫn giữ nút Tải lại/Về trang chủ phù hợp nhánh lỗi, không lộ nội dung lỗi kỹ thuật.
- reportBoundaryError vẫn đi trước phục hồi chunk. Nếu reloadOnceForStaleChunk nhận phục hồi thì return trước import tên; spinner, willAutoReload/isReloadPending, ngân sách và xử lý privacy mode giữ nguyên. Sau hết lượt, nhánh chunk có tên trang tải bất đồng bộ và nút tải lại thủ công. chunkReload.ts không có diff trong lượt này; không sửa hay mở rộng số lần tải lại.
- ERROR_PAGE_NAMES có đúng 41 bản ghi route/label, đúng thứ tự ALL_PAGES, gồm hai nhãn cùng route / với Bảng tin được chọn trước. Thuật toán sort chiều dài + exact/prefix-segment giữ nguyên. Reviewer chạy thêm probe chỉ đọc bằng AST các route hiện hành: 178 path/đích chuyển hướng với tham số thay bằng feedback-id, wildcard bằng feedback-child và đích động tenant → customer; không có mismatch so lookup canonical. Ví dụ /contracts/:id giữ Hợp đồng, /rooms/:id và /tenants/:id trước redirect vẫn dùng “đang mở” như cũ, đích /apartments và /customers/:id có đúng nhãn catalog. Đây là parity nhãn, không tuyên bố đã thực hiện chuyển hướng trên trình duyệt.

Lượt độc lập `copilot-a13-errorboundary-independent.json` đạt **101/101 ca, 3 file nguồn hiện hành, exit0** lúc 20:01:12: ErrorBoundary.feedback 2, ErrorBoundary.pageNames 94, errorPageNames 5. Command dùng `--exclude '.superpowers/**'`; đã đọc đường dẫn từng testResults, không có main archive. Hai ca feedback cố ý ném lỗi render có log jsdom expected, JSON vẫn success và không có ca fail. Bộ DOM bao phủ healthy/custom fallback, explicit/empty pageName, pending/rejected import, mọi route catalog/descendant và report-before-auto-reload; đây không phải mô phỏng đầy đủ ngân sách storage thật của chunkReload. `git diff --check` đúng nguồn/test được review exit0.

Review A13 hẹp không có finding nguồn còn mở; chấp thuận để root tiếp tục gate. Reviewer chỉ bổ sung đoạn bằng chứng này vào tài liệu. Bundle, full compiler/build, E2E chunk network/reload thật và SHA phát hành vẫn do root xác minh, chưa dùng 101 ca để tuyên bố production đã đạt.


## Review hẹp notification/bootstrap tải theo nhu cầu

Root giao read-only asyncActionFeedback.ts, useAuth/useNotifications, QueryProvider, AdminOnlyRoute, main.tsx, useTamTruKetQuaSync và ErrorBoundary async names; sau đó bổ sung leaf residenceRegistrationKeys và import/re-export của hook. Không sửa source, gate, config, auth, business hoặc payload. Riêng ErrorBoundary async names là implementation do chính reviewer này vừa thực hiện ở vai owner: việc đọc lại/chạy tests được ghi là owner regression, không thay review độc lập của root đối với patch A13 đó.

Reviewer kiểm các patch root mới:

- asyncActionFeedback tải converter khi có lỗi, giữ exact title/description của converter và log chi tiết qua reporter. Import/converter hỏng dùng lời giải thích an toàn, lỗi tài chính giữ trạng thái chưa xác nhận và không gửi thêm giao dịch. Detached promise có xử lý cuối; reporter hỏng không tạo rejection mới. Sink ném lỗi được thử một fallback an toàn với cùng delivery ID, tránh hai thông báo hiển thị khi sink đã publish trước khi ném; không có vòng lặp retry.
- useAuth chỉ đổi nhánh onError hiển thị; sai thông tin đăng nhập vẫn giữ câu không tiết lộ tài khoản. Mutation keys, login/reset/logout writers, cache/session/navigation/onSuccess giữ nguyên. useNotifications chỉ đổi import notifier. Reviewer tự chạy AST check HEAD → working, bỏ imports và các property onError: phần còn lại của cả hai hook có hash giống hệt, lưu tại final-notification-bootstrap-scope-proof.json. Không suy từ proof này rằng mọi nhánh Auth đã được E2E.
- QueryProvider giữ owner check mutation.options.onError/meta.silent/meta.handlesFeedback trước fallback; query dedup và inline/silent policy xảy ra trước tải nhãn. Query-label load lỗi vẫn có câu an toàn, lý do quyền đã xác định và retry đúng query; key/UUID/SQL không hiện ra. Giữ hỗ trợ Safari Load failed và exported default read message đã có từ main. Bộ test actual MutationCache xác nhận caller tự hiển thị lỗi không phát thêm toast.
- AdminOnlyRoute giữ thứ tự loading → query error → confirmed !isAdmin redirect → children. Khi UI lỗi đang tải, fallback có câu quyền chưa tải được và nút chỉ refetch quyền; không mở cached admin children hay đổi hướng vì lỗi đọc. Confirmed true/false, empty, custom redirect và expiry feedback được DOM kiểm. Test các lỗi tải module/toast là fixture mô phỏng, không tuyên bố mọi mạng trình duyệt đã được kiểm.
- main.tsx chỉ bỏ import push tĩnh và tải module trong đúng callback window.load rồi gọi cùng registerServiceWorker, giữ cùng catch/log nền. Reviewer trích chính statement window-load từ AST hiện hành, transpile và chạy ba VM probes với importer/registration mock: success, import failure, registration failure. Không gọi trước load, một importer/call hợp lệ sau load, lỗi được log và zero unhandled rejection. Đây là callback probe, không phải đăng ký service worker thật trên trình duyệt hoặc gửi push.
- useTamTruKetQuaSync chỉ tải recordWriteOutcome khi cần phản hồi lỗi không thuộc RegistrationError; tải/chuyển lỗi thất bại có câu chưa xác nhận kết quả an toàn. Thứ tự ghi → invalidate → xác nhận extension, giữ mã khi lỗi, dedup báo lỗi và subscriptions giữ nguyên. Leaf residenceRegistrationKeys có đúng nguyên AST declaration của constant cũ, zero imports và bốn runtime probes customer key giữ tuple. Hook import/re-export cùng constant để giữ API; listener bootstrap import leaf, không kéo whole mutation hook. Giữ nguyên validation/auth/writer/scope/guard đã review trước.

Lượt current-src regression `final-notification-bootstrap-independent.json` đạt **239/239 ca, 12 file, exit0**, exclude .superpowers/**. Trong đó **101 ca/3 file A13 là owner regression**, không gọi là độc lập đối với code của chính reviewer; **138 ca/9 file còn lại** là kiểm thử cho các patch root trong phạm vi review. `final-notification-bootstrap-mutation-owner.json` bổ sung **2/2 ca, 2 file, exit0** với actual MutationCache inspection và invoice-note owner. Sau leaf keys cuối, `final-residence-keys-bootstrap-independent.json` đạt **20/20 ca, 3 file, exit0** (sync 6, residence registration 8, receipt outcome 6); có overlap với lượt trước nên không cộng thành tổng unique tests.

Scoped diff --check mười source exit0. Root proofs async-action-feedback-scope-proof.json, admin-route-error-lazy-green.json và async-action-feedback regressions chỉ là bằng chứng owner được đối chiếu; không tính thành lượt reviewer. Review patch root hẹp này không có finding nguồn còn mở. Root vẫn sở hữu independent review A13 do reviewer làm owner, số đo bundle, global CI, E2E đúng SHA Preview, draft PR và promote; chưa xác nhận production bằng các fixture/probes trên.


### Bằng chứng owner G01/G02: focus lỗi auth tải khi có lỗi

Theo phân công root sau bundle đỏ, owner /root/finish_copilot tạo asyncFormErrors.ts và chỉ đổi import target ở src/pages/auth/Login.tsx, ForgotPassword.tsx, ResetPassword.tsx. Đây là proof của owner, không phải review độc lập của patch mới. Diff ba trang mỗi file đúng một dòng import; validator, auth handlers, markup, nội dung, dữ liệu và quy tắc giữ nguyên. Không sửa formErrors, config, gate, API, payload hoặc stage; root đã tự thêm module mới vào strict islands.

Helper giữ chữ ký async focusFirstError với ErrorFocusOptions import type-only. Không có field errors (gồm root-only) thì trả false và không tải formErrors. Khi có lỗi, await helper hiện có với nguyên errors/options nên xử lý reveal, thứ tự, root và focus của đường bình thường giữ nguyên. Nếu chunk/helper bị lỗi, diagnostic giữ cause qua reportBoundaryError; sink lỗi cũng được chặn. Sau timer 0 để React commit, fallback dành cho các field auth đơn giản tìm control có name thuộc lỗi, đúng order/root, bỏ control disabled/hidden hoặc ancestor CSS/aria-hidden/inert; scroll/focus control đầu tương tác được. Không thay thông báo lỗi nội tuyến hoặc thêm toast, không đưa cause kỹ thuật lên UI. Fallback không nhằm thay thế cơ chế reveal/waitForEnabled cho form nhiều tab khác; chỉ ba auth pages đổi caller.

TDD RED `async-auth-focus-red.json` có 6 fail trên helper eager trước thay đổi: hai assertion bắt tải module trước khi có lỗi; bốn nhánh chunk không tải được dừng tại eager dependency import. Không ghi bốn lỗi loader đó thành assertion DOM đã chạy. Sau implementation, GREEN `async-auth-focus-green.json` đạt **33/33, 7 file nguồn hiện hành, exit0** lúc 20:17:19: asyncFormErrors 6 DOM cases, formErrors 10, Login.feedback 1, useAuthMutationKeys 4, authBootstrap 3, AuthCacheSync 5, authCacheSyncStrictMode 4. Các ca mới bao phủ lazy/no-errors, original helper reveal/order/root, import failure focus control đúng/skip hidden-disabled, đợi React commit và giữ inline errors, không có control phù hợp, sink diagnostic ném lỗi không reject task. Expected cause envelope giữ cả Vitest wrapper và original failure; không bỏ assertion cause. CLI exclude .superpowers/**, đã đối chiếu mọi testResults dưới src hiện hành.

`async-auth-focus-lint.json` ghi đúng 5 source/test: 0 lỗi, 0 cảnh báo, exit0. `git diff --check` đúng năm file exit0. Owner báo SOURCE FREEZE trước append tài liệu để root build/checkpoint. Bundle sau boundary mới, full typecheck/build/global gates và E2E ba auth flows trên SHA phát hành chưa được owner kiểm trong lượt này; root sở hữu các bước đó. Không dùng 33 ca để tuyên bố production hoặc bundle threshold đã đạt.


### Review độc lập helper focus Auth tải khi có lỗi G01/G02

Sau source freeze, reviewer chỉ đọc asyncFormErrors.ts, ba import Login/ForgotPassword/ResetPassword, focused tests và delta strict includes được root giao. Không sửa nguồn, gate, suppression, validator, handler, auth, copy hoặc markup. Toàn văn HEAD → working của cả ba page bằng đúng một phép đổi đường dẫn import; proof hash và kết quả nằm trong final-async-auth-focus-scope-proof.json.

Helper chỉ import type ErrorFocusOptions, không đưa runtime formErrors vào bootstrap. Khi không có lỗi trường hoặc chỉ có root error thì không tải helper và không chọn ô ngẫu nhiên. Khi có lỗi, normal path gọi và await đúng helper.focusFirstError(errors, options), giữ root/order/reveal và cùng logic mở phần/focus hiện có. Import hoặc helper thất bại được ghi diagnostics an toàn rồi đợi React tick và dùng đường dự phòng native inputs của ba form Auth. Đường dự phòng giữ thứ tự yêu cầu hoặc thứ tự DOM, giới hạn trong root, bỏ ô hidden/disabled/aria-disabled/inert và ancestor không hiển thị. Lỗi reporter được catch nên không làm detached focus task reject. Không đổi inline errors hoặc gọi mutation; phạm vi fallback này là các ô native của ba page, không tuyên bố thay thế đầy đủ helper cho mọi custom control trên website.

Đã đọc owner async-auth-focus-red.json: sáu ca đỏ gồm hai assertion chứng minh eager loading và bốn controlled loader failures làm eager import không usable trước fallback. Đây không phải sáu lỗi DOM độc lập trên trình duyệt thật. Owner GREEN có 33/33 trong bảy file hiện hành. Reviewer chạy lại đúng các suites với exclude .superpowers/**: `final-async-auth-focus-independent.json` đạt **33/33 ca, 7 file, exit0**: asyncFormErrors 6, Login.feedback 1, useAuthMutationKeys 4, authBootstrap 3, formErrors 10, AuthCacheSync 5 và authCacheSyncStrictMode 4. Các ca mock chunk/diagnostics failure đều settle và không có unhandled error làm runner thất bại.

Reviewer kiểm tsconfig.strict-islands.json: chỉ thêm asyncActionFeedback/errorPageNames/residenceRegistrationKeys/asyncFormErrors vào files; không bớt file, không đổi compiler options hoặc phần cấu hình khác, không tăng baseline. Scoped diff --check helper/test/ba page/config exit0. Review hẹp không có finding nguồn còn mở. Root vẫn sở hữu số đo build/bundle cuối, strict/app/global gates và E2E đúng SHA; suite này chưa xác nhận production.


### Review độc lập leaf validation và writer import cuối của đồng bộ cư trú

Root giao read-only residenceRegistrationValidation.ts, residenceRegistrations.ts và useTamTruKetQuaSync.ts sau freeze. Reviewer tự so AST declaration RegistrationError và maHoSoHopLe với HEAD: cả hai giống nguyên, leaf zero imports, backend import/re-export cùng class và API. Không thay regex, ngưỡng, trim, types hoặc quyền.

`final-residence-validation-scope-proof.json` lưu hash parity phần backend ngoài declarations/imports/coordinator import đã review và phần sync ngoài imports/module load/error-delivery đã review trước. Validation/auth, payload/upsert/onConflict/scope/receipt/reconcile của writer giữ nguyên; listener subscriptions, initial dongBo, dangChay guard, loop/filter, invalidate, ack và success message của sync giữ nguyên. useEffect vẫn đăng ký message/focus/visibility listeners ngay rồi gọi initial dongBo. await import residenceRegistrations nằm trong từng nhánh valid record ngay trước cùng await ghiHoSoTamTru; không lazy listener và không chờ module trước khi gắn listener. Import lỗi đi qua cùng nhánh lỗi giữ mã/dedup thông báo, không ack rằng đã ghi.

Independent `final-residence-validation-independent.json` đạt **20/20 ca, 3 file hiện hành, exit0**, exclude .superpowers/**: useTamTruKetQuaSync 6, residenceRegistrations 8, residenceWriteOutcome 6. Đối chiếu strict files: mới thêm leaf validation ngoài bốn module đã review; không bớt file hoặc đổi compiler options/phần cấu hình khác. Scoped diff --check ba source và strict config exit0. Review hẹp không có finding nguồn còn mở; source không được reviewer chỉnh. Đây là fixture/AST proof, không khẳng định extension trình duyệt thật, bundle/global CI hoặc production đã xác minh; root tiếp tục checkpoint/rebase/build và exact-SHA release proof.


### Review độc lập tích hợp main 9aa sau rebase

Sau freeze chung, reviewer chỉ đọc phần tích hợp với main `9aa3b48b67d1deb5ca9cd29779e326059c017b7e` và task `d729274991b9eb51a161ca5aefb87899b1ca5b87`; không sửa source, index, rebase, gate hoặc nghiệp vụ. Git HEAD quan sát lúc tạo proof là `2b9babf31c63c663f1c490451a83977412d0e214`. Hash các source/test được lưu và đối chiếu lại trước khi ghi kết luận, không có drift.

`final-main9aa-merge-scope-proof.json` là phép kiểm độc lập từ git show và source hiện hành: tám file detailRead/useVoucherDetail/VoucherReadState/voucherSheetState/financeMobile.css/imageCompress/r2Client/uploadDeadline bằng nguyên byte main; 11 helper storage bằng AST main, gồm hạn chờ và cleanup file đến muộn. Prefix nén ảnh/đổi đuôi/type/size và parameters của uploadFileDetailed giữ main; các lời gọi uploadToR2, uploadToStorageWithDeadline, getPublicUrl giữ nguyên đối số/options. Phần thêm là xác nhận receipt đúng đường dẫn, phân biệt từ chối với kết quả chưa rõ, giữ đường dẫn thực để đối chiếu và câu báo đúng tệp thay vì gọi PDF là ảnh.

Finance giữ nguyên bảy function của task, gồm bốn durable mutations và guard receipt/subject. Trong uploadFinanceEvidence, sau chuẩn hóa đúng hai delta đã đọc (main deadline adapter cùng arguments/options và câu timeout cục bộ), AST giữ task: intent validation, tenant, finalize đúng evidence_id/FINALIZED, thứ tự và nhánh lỗi không đổi. Không thêm ghi tiền, đổi idempotency key, payload, filter, auth hay cleanup. Zalo uploadOne/withStoredExtension bằng AST main; sender/hook/ZaloMediaSendError bằng AST task, giữ actual stored path/mime/size cùng request key, partial upload và chặn gửi lại kết quả hàng đợi chưa rõ.

Bốn wrapper chi tiết bằng AST main. Ba caller form/desktop/mobile giữ organization hint của main; bốn guard của form và setDetailVoucher/detailVoucher hai page giữ main. Tám file UI/Zalo auto-merge bằng đúng kết quả merge ba phía không conflict từ base `45149b9b`; đã đọc delta thực và không thấy mất QueryRegion, reason focus, dữ liệu nhập hoặc guard trạng thái. QueryProvider giữ nguyên AST task của xuLyLoiQuery/queryClient, giữ nenBaoLoi/LOI_DOC_MAC_DINH main và ranh giới nguyên từ Safari Load failed. Nhánh schema có hướng tải lại nhưng không kết luận phiên bản trang cũ hơn máy chủ. Không có marker conflict trong nguồn src; scoped git diff --check src đạt.

Hai fixture thành công của main chỉ thay response thành receipt hợp lệ: finalize trả ev-2 FINALIZED, Zalo queue trả một row ID. Toàn bộ expect-chain assertions giữ nguyên (6 và 7); năm test mới khác của main bằng nguyên byte. Query policy được bổ sung kiểm câu phục hồi và không suy đoán phiên bản, không bỏ phân loại Safari/upload/download.

Reviewer chạy mới với `--exclude '.superpowers/**'`: `final-main9aa-merge-independent.json` **210/210 ca, 21 file, exit0** và `final-main9aa-merge-owners-reads-independent.json` **48/48 ca, 6 file, exit0**, không pending/skipped và không nhận test từ archive. Hai lượt không trùng file: tổng **258/258 ca trong 27 file hiện hành**. Bao phủ durable finance, partial evidence/deadline, detail parallel/stale/read state và revise form, stored identity/key/camera/JPEG/R2/deadline/late cleanup, receipt upload/Zalo queue, QueryProvider labels/policy, async fallback và hai mutation owner thực.

Review tích hợp hẹp không có finding nguồn còn mở. Các số trên là fixture/DOM đơn vị và đối chiếu source, không thay thế E2E đúng SHA, vai trò/RLS thật, đối chiếu tiền/concurrency, build/bundle, CI hoặc production. Root tiếp tục các gate và phát hành theo Contract; reviewer không xác nhận đã promote.


### Review hẹp hai câu dự phòng asyncActionFeedback sau tích hợp

Reviewer đọc diff chính xác src/lib/asyncActionFeedback.ts với HEAD `2b9babf31c63c663f1c490451a83977412d0e214`: chỉ hai string description rút gọn, không đổi title, option financial, guards, ID thông báo, lazy import, catch, reporter hoặc luồng delivery. `final-fallback-copy-scope-proof.json` xác nhận nguyên file bằng bản cũ sau khi thay ngược đúng hai string (mỗi string xuất hiện một lần); ba handler reportDeliveryFailure/deliver/notifyActionError cùng AST/hash, safeFallback cùng AST ngoài hai câu, test cùng byte.

Câu tài chính vẫn yêu cầu giữ thông tin đang nhập, đối chiếu phiếu/sổ quỹ và không gửi thêm khi chưa rõ kết quả. Câu thông thường vẫn yêu cầu giữ thông tin và kiểm tra trạng thái; không khẳng định lưu thành công, không hiện lỗi kỹ thuật hoặc thúc đẩy gửi lại. Review copy không có finding. Chạy độc lập đúng một suite hiện hành, exclude .superpowers/**: `final-fallback-copy-independent.json` **7/7 ca, 1 file, exit0**, zero pending/fail. Không chạy suite lớn hoặc sửa source/index. Root sở hữu số đo build/bundle cuối và proof CI/E2E/production đúng SHA; review này không suy ra gate bundle đã đạt.
