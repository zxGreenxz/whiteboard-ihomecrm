# Đánh giá AI Copilot - 2026-08-13

## Kết luận điều hành

**Chưa production-ready.** Bản triển khai đã có nền tảng backend, permission gate, quota/rate-limit và bộ unit test đáng tin cậy, nhưng ma trận hành vi trên deployment thật còn các blocker trực tiếp:

- 5/30 ca hội thoại readonly lỗi runtime do truy vấn quan hệ PostgREST không tồn tại: `customers -> rooms` (C02, C14, C27) và `contracts -> buildings` (C04, C16).
- Model không nhìn thấy hoặc không chọn nhiều tool readonly đang có thật. C08, C09, C18 và C20 tuyên bố thiếu công cụ; C06 suy ra 100% lấp đầy từ danh sách phòng trống; C23 chỉ hướng dẫn thao tác thay vì thực hiện/lấy dữ liệu.
- Ca tổ hợp chưa ổn định: C25 bỏ nửa câu hỏi về lấp đầy; C27 dừng ngay ở tool đầu tiên bị lỗi. C26 đạt kết quả chức năng nhưng chỉ gọi một tool, nên không chứng minh được orchestration hai tool như thiết kế.
- Deployment drift so với source/tài liệu: giao diện production không có `data-testid="copilot-file"` dù source có nút ảnh; UI-control cũng không xuất hiện trong panel đã kiểm tra.
- Chưa có Playwright E2E Copilot được track, proxy integration suite hoặc golden eval dataset để chặn các regression hành vi trên CI.
- Xác nhận write tool vẫn là boolean `xac_nhan` do model truyền, không phải authorization boundary có state độc lập; chuỗi audit -> RPC tạo phiếu -> cập nhật `entity_id` cũng chưa atomic toàn bộ.

Vì vậy mức hoàn thiện phù hợp là **pilot nội bộ có kiểm soát**, chưa đủ điều kiện mở rộng cho vận hành thật hoặc coi là tính năng hoàn tất.

## Phạm vi và phương pháp

| Hạng mục | Cách kiểm tra |
|---|---|
| Deployment | `https://ptcrm.vercel.app`, browser headless, session thật |
| Model | `9router:cx/gpt-5.6-sol(max)` trong toàn bộ C01-C30 |
| Song song | 3 wave, mỗi wave 10 Playwright worker/browser độc lập |
| Dữ liệu chat | Chỉ org DEMO; 10 user tạm, mỗi worker một tài khoản |
| Org THẬT | Tài khoản owner thật; chỉ gọi RPC/REST đọc, không gửi chat và không cấp entitlement |
| Ma trận | 40 ca: readonly đơn, biên/không dữ liệu, tổ hợp/ngữ cảnh, permission/provider/rate/safety |
| Thang verdict | `PASS`: đạt hành vi; `PARTIAL`: kết quả hữu ích nhưng thiếu/sai một phần; `FAIL`: lỗi hoặc trả lời sai; `STATIC-ONLY`: chỉ xác minh source/unit; `NOT RUN`: cố ý không chạy vì có side effect hoặc thiếu fixture an toàn |

Lưu ý: verdict đánh giá **kết quả chức năng**, không buộc model phải đi đúng một tool duy nhất. Ví dụ C11, C12, C19, C22 và C26 vẫn được ghi nhận khi đạt mục tiêu bằng đường khác. Không sử dụng thống kê "exact tool match" từ script cũ vì phép so sánh array rỗng của script đó đếm sai.

## Tổng quan kết quả

| Nhóm | Kết quả chính |
|---|---|
| C01-C30, hội thoại readonly | 15 `PASS`, 7 `PARTIAL`, 8 `FAIL` |
| Lỗi runtime chắc chắn | 5 ca, hai quan hệ schema cache bị thiếu |
| Proxy/safety C31-C40 | 5 live pass (C31, C33-C36), 4 static-only (C32, C37, C39, C40), 1 fail deployment (C38) |
| Latency 31 lượt model | min 8,822 ms; median 17,448 ms; mean 21,105 ms; p95 42,057 ms; max 55,913 ms |
| Burst | 21 request đồng thời: 20 HTTP 200, 1 HTTP 429 `rate_limited` |
| Unit/gate | 140/140 Copilot tests pass; bốn gate Copilot/docs/routes/matrix/freshness exit 0 |
| Dữ liệu thật | Sau test vẫn 520 khách, 1.121 hóa đơn, 333 hợp đồng; oracle chỉ thấy org THẬT |

## Ma trận C01-C30 - câu hỏi readonly và tổ hợp

| ID | Câu hỏi / mục tiêu | Quan sát | Verdict |
|---|---|---|---|
| C01 | Phòng nào đang trống? | Gọi `phong_trong`, trả kết quả rỗng hợp lệ. | PASS |
| C02 | Tìm khách hàng Nguyễn An | Tool chạy nhưng lỗi `customers -> rooms` không có trong schema cache. | FAIL |
| C03 | Hóa đơn 2026-07 chưa thanh toán | Gọi `tim_hoa_don`, giữ đúng kỳ và trạng thái. | PASS |
| C04 | Hợp đồng hết hạn trong 30 ngày | Lỗi `contracts -> buildings` không có trong schema cache. | FAIL |
| C05 | Doanh thu 2026-07 | Gọi `doanh_thu_thang`, trả kết quả theo kỳ. | PASS |
| C06 | Tỷ lệ lấp đầy hiện tại | Gọi `phong_trong` rồi suy "không phòng trống = 100%"; đây không phải định nghĩa occupancy và bỏ phòng giữ chỗ/bảo trì/không khả dụng. | FAIL |
| C07 | Tổng quan công nợ hiện tại | Không gọi `cong_no_tong_quan`; chỉ mô tả sẽ tổng hợp, chưa trả số. | PARTIAL |
| C08 | Tiền cọc đang giữ theo tòa | Tuyên bố không có công cụ dù registry có `coc_dang_giu`. | FAIL |
| C09 | Sổ quỹ 01-31/07/2026 | Không gọi `so_quy`, chuyển sang gợi ý KQKD. | FAIL |
| C10 | Hướng dẫn thanh lý hợp đồng | Tra tài liệu hai lượt, trả quy trình đầy đủ; latency cao nhất 55,913 ms. | PASS |
| C11 | Có những tài liệu nghiệp vụ nào? | Dùng `huong_dan` thay `liet_ke_chu_de` nhưng trả được nhóm chủ đề hữu ích. | PASS |
| C12 | Tôi tạo hợp đồng ở đâu? | Dùng tài liệu thay bản đồ hệ thống nhưng chỉ đúng trang và hành động. | PASS |
| C13 | `phong trong toa DEMOA` | Hiểu câu không dấu, gọi đúng tool và áp bộ lọc tòa. | PASS |
| C14 | Tìm khách bằng số điện thoại không tồn tại | Lỗi cùng quan hệ `customers -> rooms`, không đạt empty-state. | FAIL |
| C15 | Hóa đơn 2099-01 trạng thái partial | Gọi đúng tool, xử lý không dữ liệu và diễn giải `partial` thành thu một phần. | PASS |
| C16 | Hợp đồng hết hạn trong 7 ngày | Lỗi cùng quan hệ `contracts -> buildings`. | FAIL |
| C17 | KQKD dồn tích 2026-07 | Gọi tool doanh thu với basis dồn tích, xử lý không dữ liệu. | PASS |
| C18 | Lấp đầy 31/07, bỏ qua phòng sắp trống | Không gọi `ty_le_lap_day`, kết thúc bằng câu hỏi lấy danh sách. | PARTIAL |
| C19 | Công nợ kỳ 2099-01 | Dùng hai lượt `tim_hoa_don` thay aggregate nhưng trả đúng empty-state chức năng. | PASS |
| C20 | Sổ quỹ tháng này | Tuyên bố chỉ có tổng thu/chi/lợi nhuận và không có tool chi tiết, dù `so_quy` tồn tại. | PARTIAL |
| C21 | Hướng dẫn chủ đề không tồn tại | Tra cứu, nói rõ không có và gợi ý chủ đề hợp lệ. | PASS |
| C22 | Bản đồ toàn hệ thống | Đi qua tài liệu nhưng trả được bản đồ chức năng/quyền ở mức tổng quan. | PASS |
| C23 | Trên trang hóa đơn, lọc "chưa thanh toán" | Nhận đúng ngữ cảnh trang nhưng nói không thể thao tác và chỉ hướng dẫn; không gọi tool lấy dữ liệu. | PARTIAL |
| C24 | Follow-up: doanh thu 07/2026 -> còn nợ tháng đó? | Giữ đúng `07/2026`, gọi tiếp tool hóa đơn và kết luận 0; 14,583 ms + 28,730 ms. | PASS |
| C25 | Doanh thu và lấp đầy cùng câu | Chỉ gọi `doanh_thu_thang`; phần occupancy bị từ chối sai vì "không có công cụ". | PARTIAL |
| C26 | Hóa đơn chưa thu và tổng công nợ 07/2026 | Chỉ gọi `tim_hoa_don` nhưng trả đủ hai kết quả ở empty-state. Chức năng đạt, orchestration hai tool chưa được chứng minh. | PASS |
| C27 | Tìm khách Nguyễn An và phòng trống DEMOA | Tool khách lỗi trước; model không tiếp tục phần `phong_trong`. | PARTIAL |
| C28 | Doanh thu tháng trước | System prompt đáng ra có ngày hiện tại nhưng model nói không biết ngày và hỏi lại kỳ. | PARTIAL |
| C29 | Hợp đồng hết hạn trong 366 ngày | Từ chối đúng vì schema giới hạn tối đa 365, xin xác nhận thu hẹp phạm vi. | PASS |
| C30 | Phòng trống ở tòa An | Gọi đúng tool, áp fuzzy filter và trả empty-state. | PASS |

### Các cụm lỗi cần ưu tiên

1. **Blocker truy vấn:** sửa hai select quan hệ PostgREST của `tim_khach_hang` và `hop_dong_sap_het_han`, sau đó thêm integration test trên schema production-like.
2. **Tool discoverability/routing:** model phải thấy và dùng ổn định `ty_le_lap_day`, `cong_no_tong_quan`, `coc_dang_giu`, `so_quy`; hiện source có tool nhưng hành vi live phủ nhận chúng.
3. **Orchestration:** một tool lỗi không được hủy các nhánh độc lập còn lại; câu nhiều ý phải báo rõ phần thành công và phần thất bại.
4. **Relative date:** ngày hiện tại phải được model sử dụng thực sự; C28 cho thấy prompt contract chưa đủ mạnh hoặc bị mất trong context.
5. **Latency:** mean khoảng 21 giây và p95 hơn 42 giây là chậm cho tương tác thường xuyên; C10 mất gần 56 giây.

## Ma trận C31-C40 - permission, provider, readonly và safety

| ID | Trường hợp | Bằng chứng | Verdict |
|---|---|---|---|
| C31 | JWT hợp lệ nhưng không entitlement | Proxy live trả 403 `not_entitled`. | PASS |
| C32 | Thu hồi entitlement hiệu lực ngay | Source/RPC reserve không cache và unit coverage có; không tạo fixture live thứ hai sau cleanup. | STATIC-ONLY |
| C33 | Có entitlement nhưng thiếu `ai_copilot.view` | Hai vai `ketoan` và `quanly` đều trả 403 `not_permitted` trong lần đo live. | PASS |
| C34 | Model ngoài allowlist | Proxy live trả 400 `bad_model` trước upstream. | PASS |
| C35 | Provider bị tắt/không khả dụng | Proxy live trả 403 `provider_disabled`. | PASS |
| C36 | Burst/rate limit | 21 request đồng thời: 20 thành công, request thứ 7 trả 429 `rate_limited`. | PASS |
| C37 | Permission lọc tool readonly | Unit/static chứng minh registry lọc trước khi đưa tool cho model và kiểm lại lúc execute; chưa có live fixture permission tối thiểu, cô lập. | STATIC-ONLY |
| C38 | Đọc ảnh | Source và unit có multimodal, nhưng deployment không có `copilot-file`/nút upload; ca live không chạy được. | FAIL |
| C39 | UI-control không được ghi dữ liệu | Source/unit chứng minh PageAgent loại `chatOnly` write tool và safety blacklist; deployment không hiện control để smoke live. | STATIC-ONLY |
| C40 | Write preview/confirmation | Chỉ xác minh static/unit với mặc định `xac_nhan=false`; cố ý không chạy `true` để tránh tạo phiếu. Guard hiện là model-supplied boolean và chuỗi audit/write không atomic toàn bộ. | STATIC-ONLY |

## Xác minh org THẬT chỉ đọc

Tài khoản thật được dùng để gọi trực tiếp các bề mặt REST/RPC readonly bằng JWT user, không cấp entitlement mới và không gửi câu hỏi Copilot. `business_performance_organizations_v1()` trả đúng một tổ chức:

- Organization: `aaaa0000-0000-4000-8000-000000000001` (`ihome-prod`).
- Không có organization DEMO/TEST/foreign trong kết quả.
- RPC trả 17 tòa được ủy quyền; bảng `buildings` của org có 18 dòng, tức oracle tôn trọng phạm vi được cấp thay vì tự mở toàn org.
- Mọi RPC business-performance sau đó đều nhận **explicit organization ID và explicit building ID list**, không dùng scope `NULL`.
- `business_performance_pnl_v1` basis `VOUCHER_DATE` và `ACCRUAL`: mỗi loại 17 dòng.
- `business_performance_snapshot_v1`: 17 dòng; occupancy snapshot: 17 dòng; held-deposit summary: 17 dòng.
- Invoice statistics trả object; cashbook report trả đủ các phần `accounts`, `sessions`, `reconciliations`.

Đối chiếu trước/sau các count chính của org THẬT:

| Đối tượng | Trước | Sau | Kết luận |
|---|---:|---:|---|
| Khách hàng | 520 | 520 | Không đổi |
| Hóa đơn | 1.121 | 1.121 | Không đổi |
| Hợp đồng | 333 | 333 | Không đổi |
| Tòa trong bảng org | 18 | 18 | Không đổi |

Artifact `real-before.json` cũ có 17 digest, nhưng không có reusable script tái tạo chính xác cùng serialization. Vì vậy báo cáo **không tuyên bố digest-parity 17/17**; bằng chứng mạnh hiện có là identity/org isolation, explicit building scope, các RPC readonly thành công và count business quan trọng không đổi.

## Verification code và tài liệu

Các lệnh được chạy fresh trong phiên đánh giá:

| Gate | Kết quả |
|---|---|
| `npx vitest run src/copilot/__tests__` | 8 file, 140/140 test pass |
| `npm run gate:copilot-docs` | 25/29 docs ingest, 7 permission-gated; cảnh báo 12 docs thiếu ngày review |
| `npm run gate:copilot-routes` | 146 routes, 231 permission features hợp lệ |
| `npm run gate:test-matrix` | 520 test files, 9 suites, không orphan; cảnh báo 8 file overlap |
| `npm run gate:doc-freshness` | 0 vi phạm mới, 20 baseline debts |
| `npm run gate:local-credentials` | Đủ 4 credential bắt buộc; không in giá trị |

Khoảng trống test đáng kể:

- Không có Copilot Playwright E2E được track trong repo; harness ma trận lần này là local artifact và đã được dọn.
- Không có proxy integration suite chạy định kỳ trên deployment.
- Không có golden dataset/oracle định lượng chất lượng câu trả lời và tool routing.
- Citation tài liệu hiện là text `(nguồn: ... § ...)`, chưa phải link có thể click.
- README ghi “10 tool đọc + 1 write”, trong khi registry chat hiện có 12 tool readonly (`phong_trong`, `tim_khach_hang`, `tim_hoa_don`, `hop_dong_sap_het_han`, `doanh_thu_thang`, `huong_dan`, `ban_do_he_thong`, `liet_ke_chu_de`, `ty_le_lap_day`, `cong_no_tong_quan`, `coc_dang_giu`, `so_quy`) và 1 write tool.

## Cleanup và bảo toàn dữ liệu

Cleanup chỉ nhắm 10 UUID/email fixture `codex.copilot.01..10` sau khi inventory xác nhận:

- Đúng 10 Auth user, 10 profile, 10 membership; tất cả chỉ thuộc org DEMO.
- Không user nào là superadmin; không có staff assignment/user role; `ai_write_audit = 0`, do đó không có draft entity cần xóa.
- Đã xóa 210 chat messages, 82 chat threads, 237 usage logs, 10 entitlement, RBAC binding/scope link, membership/profile và cuối cùng 10 GoTrue user bằng exact UUID sau khi kiểm tra exact email.
- Đã xóa entitlement tạm của đúng ba user DEMO; backup trước test xác nhận cả ba không có row cũ.
- Chỉ khôi phục key `profiles.ui_preferences.copilotModel` của `demo.chunha` về `openrouter:nvidia/nemotron-3-super-120b-a12b:free`, không ghi đè toàn bộ `ui_preferences`.
- Xác minh sau cleanup: Auth/profile/membership/chat/message/usage/audit/entitlement/staff assignment/user role của 10 fixture đều bằng 0; entitlement tạm của ba user DEMO bằng 0.

## Quyết định phát hành và Definition of Done đề xuất

Không nên tuyên bố production-ready cho đến khi tối thiểu đạt các gate sau:

1. C02/C04/C14/C16/C27 không còn lỗi quan hệ PostgREST trên deployment thật.
2. C06/C08/C09/C18/C20/C25 chạy đúng tool readonly và không bịa thiếu capability.
3. C23 có contract rõ: hoặc UI-control thật sự thao tác, hoặc chat lấy dữ liệu và trả deep-link; không nói chung chung.
4. Ảnh và UI-control trên deployment khớp source, có smoke E2E live.
5. Có golden eval chạy ít nhất ma trận C01-C30, báo functional verdict và latency; không chỉ assert HTTP/proxy hoàn tất.
6. Write confirmation có state server-side gắn với preview + user consent, và audit/write được gom vào boundary atomic hoặc có reconciliation bắt buộc.
7. Tài liệu tool count/capability đồng bộ runtime và citation có link kiểm chứng được.

Cho đến khi các điều kiện này xanh, phạm vi an toàn là **pilot theo allowlist, dữ liệu DEMO/readonly, quan sát log và có người kiểm tra kết quả**.
