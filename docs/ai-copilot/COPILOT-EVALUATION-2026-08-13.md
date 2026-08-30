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

## Addendum remediation — 2026-08-28

Phần dưới đây **không sửa lại verdict lịch sử C01-C40 của lần đo 2026-08-13**. Nó ghi nhận những gì
đã được triển khai và kiểm chứng sau lần đo đó, đồng thời tách rõ bằng chứng static/schema với bằng chứng
chạy hội thoại trên deployment. Vì vậy các dòng FAIL/PARTIAL cũ vẫn là baseline cần rerun, không được tự
đổi thành PASS chỉ vì source đã thay đổi.

### Những gap của lần đo đã được xử lý ở source/schema

| Nhóm baseline | Remediation hiện tại | Mức bằng chứng |
|---|---|---|
| C02/C14/C27 — tìm khách hàng | Thay relation query bằng `copilot_customer_search_v1`; server tự chốt organization/building scope, trả field allowlist và mask SĐT. | Migration đã apply; contract/unit và RPC-surface pass. Chưa rerun hội thoại live. |
| C04/C16 — hợp đồng sắp hết hạn | Thay relation query bằng `copilot_expiring_contracts_v1`; ngày và phạm vi được kiểm ở server. | Migration đã apply; contract/unit pass. Chưa rerun hội thoại live. |
| C06/C18/C25 — lấp đầy | Bổ sung `ty_le_lap_day` dùng `copilot_occupancy_v1` và RPC phòng sắp trống; không còn suy occupancy từ danh sách phòng trống. | Tool registry, migration contract và focused tests pass; routing của model thật chưa được chứng minh. |
| C07/C19 — công nợ | Bổ sung `cong_no_tong_quan` dùng `copilot_invoice_stats_v1`, có empty-state rõ. | Source/static pass; cần golden functional rerun. |
| C08 — tiền cọc | Bổ sung `coc_dang_giu` dùng `copilot_deposit_summary_v1`, lọc theo quyền. | Source/static pass; cần golden functional rerun. |
| C09/C20 — sổ quỹ | Bổ sung `so_quy` dùng `copilot_cashbook_settlement_v2`; output chỉ giữ trường an toàn, không đẩy tên người/ghi chú tự do ra model. | Migration/RPC ACL và unit pass; chưa có role-real live fixture. |
| C28 — ngày tương đối | Context ngày hiện tại được đóng dấu theo `Asia/Ho_Chi_Minh` và đưa vào chat prompt. | Unit pass; cần real-model case để chứng minh model thực sự dùng ngày đó. |
| C40 — xác nhận ghi | Boolean `xac_nhan` đã bị loại khỏi tool schema; preview phát nonce server-side, execute kiểm hash/CAS, tạo draft và audit trong cùng boundary. Client store đã tách intent key. | Static/unit và migration idempotency pass; chưa có live expiry/replay/payload-change/concurrency. |
| Test/CI và drift | Node test được đưa đúng vào matrix; inventory, provider policy, page contract, forbidden-action và golden schema gates đã được nối CI. | Fresh gate pass. |

### Hardening bổ sung sau remediation

- Hai bảng rollout Copilot đã bật RLS và không cấp quyền truy cập trực tiếp cho browser role; availability chỉ
  lộ qua RPC.
- Helper `copilot_org_scope_buildings_v1` đã bị thu hồi `anon EXECUTE`; các wrapper Copilot mới chỉ cấp cho
  `authenticated` và đặt `search_path` tường minh.
- RPC legacy `copilot_cashbook_settlement_v1(uuid,date,date,uuid[])` đã bị thu hồi `authenticated EXECUTE`; đường
  browser còn lại là `copilot_cashbook_settlement_v2` với scope cashbook do server suy ra, nên không còn bypass
  bằng `p_building_ids` của client.
- Rollout flag dùng expected-revision/CAS, advisory lock, transition graph và audit append-only; setter cũ
  không còn là đường ghi hợp lệ.
- Registry hiện có **14 tool: 12 đọc, 1 ghi draft-first, 1 điều hướng UI-control**; số liệu tài liệu được
  sinh từ registry thay vì ghi tay.
- UI-control hiện có page contract tường minh cho `/apartments`, `/invoices`, `/customers`; bộ giải chỉ chấp
  nhận control ID đã khai báo, loại submit/nguy hiểm và `execute_javascript` bị chặn. Sau wiring ngày
  2026-08-28, 7 control pilot đã gắn marker `data-ai-safe` page-qualified; custom combobox/month picker
  có bridge `data-ai-selected` + `change` để cập nhật React state. Đây là bằng chứng source/static và
  focused unit, chưa thay thế browser mutation proof trên deployment.

### Bằng chứng fresh ngày 2026-08-28

| Gate | Kết quả |
|---|---|
| `gate:test-matrix` | `578` file, `11` suite, không test mồ côi |
| Copilot focused Vitest | `24` file, `267/267` test pass |
| Node Copilot contract tests | `19/19` pass |
| `gate:copilot-tools` / routes / pages / provider / E2E files / golden schema | Tất cả pass; `14` tool, `146` route đối chiếu, `113` route non-redirect có account, `5` spec bắt buộc |
| `gate:copilot-safe-controls` + marker contract test | Pass; `7/7` marker page-qualified, không unknown/duplicate/missing; safe-control Vitest `17/17` |
| `gate:rpc-surface` / `gate:definer-acl` / RPC cast | `268` RPC, `0` thiếu, `0` drift, `0` search-path hở, any-cast RPC `0` |
| Typecheck và build | app typecheck, E2E typecheck và `vite build` exit `0` |
| Migration | provenance pass; `27/27` migration được đo idempotency pass |
| ESLint ratchet | `0` lỗi mới so với baseline (`1189` hiện tại / `1201` baseline) |

Các con số trên chứng minh change set hiện tại nhất quán ở source, contract, migration và build. Chúng
**không** thay thế cho browser test trên deployment có SHA được attested.

### Khoảng trống release còn lại

1. Chưa có rerun C01-C40 bằng real model trên preview/deployment đúng SHA; `latencySlaMs` vẫn là
   `pending-owner-approval`, nên chưa có p50/p95/max làm release threshold.
2. Chưa có bằng chứng live cho wrong-organization, revoked membership/entitlement, role thiếu quyền và
   hai tab execute nonce đồng thời; Phase D hiện là matrix/contract, live lane vẫn opt-in vì có ghi DEMO.
3. Marker `data-ai-safe` đã được gắn đủ cho 7 control của ba trang pilot và static/unit gate đã xanh;
   tuy nhiên chưa có browser mutation proof trên deployment đúng SHA. Chưa chứng minh end-to-end
   upload/vision, portal/tooltip, autosave, shadow DOM, iframe và mọi TOCTOU path của UI-control.
4. Page contract mới chỉ bao phủ ba route pilot; `113` route được “accounted” bởi contract hoặc exemption,
   **không có nghĩa Copilot đã điều khiển được 113 route**. Các trang admin/settings/finance/write vẫn bị
   defer theo chủ đích.
5. Hai cảnh báo build không phải blocker Copilot hiện tại nhưng cần theo dõi: `eval` trong bundle
   `@page-agent/page-controller` và dữ liệu Browserslist cũ.

### Verdict sau addendum

Trạng thái đã nâng từ “nhiều lỗi runtime/query và thiếu hàng rào” lên **source/schema đã harden, đủ điều
kiện chạy pilot kiểm soát**. Tuy nhiên vẫn **chưa production-ready và chưa đạt “full-site control cho
superadmin”** vì thiếu bằng chứng live/real-model và vì phạm vi UI-control hiện chỉ là allowlist ba trang.
Cho tới khi các khoảng trống trên được chạy và lưu evidence, chỉ nên bật Copilot cho DEMO/readonly và
draft-first có người bấm xác nhận.

## Addendum production reconciliation — 2026-08-29

### Finding: metadata DEMO làm lệch cửa đối chiếu tiền

Lần chạy trước của `gate:reconcile-money` cho kết quả **A = 5.287.685.737đ**, còn **B/C =
5.285.685.737đ**, lệch đúng **2.000.000đ**. Đây không phải lỗi của `get_income_expense_layer_stats` hay
phân trang FE. Nguồn gốc là tổ chức canonical DEMO
(`dddd0000-0000-4000-8000-000000000001`) đang có `is_demo=false`, trong khi nguồn A lọc theo
`organizations.is_demo=false`; vì vậy A cộng nhầm 5 dòng dữ liệu DEMO mà JWT/RLS của tài khoản kiểm tra
đã ẩn.

Đã xử lý bằng migration forward-only
`supabase/migrations/20260829070000_restore_demo_organization_metadata.sql`, chỉ cập nhật đúng identity
canonical (ID/slug/name/status), fail-closed nếu identity thiếu, và đặt `is_demo=true`. Migration đã apply
qua `npm run migrate:forward` trên project `tryymsxyyckgbrmmvozx`, không sửa migration lịch sử.

### Bằng chứng sau remediation

| Kiểm tra | Kết quả |
|---|---|
| Production readback `organizations` | DEMO `is_demo=true`; org THẬT `aaaa…0001` vẫn `is_demo=false`; không có org TEST trong kết quả readback |
| Backup trước apply | Dump đầy đủ, `586` bảng có dữ liệu; manifest ngoài repo tại `C:\Users\Nguyen Tam\ihomecrm-backups\ihomecrm-full-2026-08-28T20-00-06-479Z.dump.json` |
| Migration evidence | `docs/generated/schema-change-evidence/20260829070000_restore_demo_organization_metadata.json`; SHA SQL `d9309dd4e85ea5bcf8cdda9d4158545f56e6d8c559ae288f805577257801dc87` |
| Migration gates | provenance, idempotency `29/29`, definer ACL và ledger-frozen đều pass |
| `gate:reconcile-money` sau apply | **PASS** — A/B/C cùng `5.285.685.737đ`; `1.077` dòng qua 2 trang + 1 trang rỗng, đã thực sự chạm cap-1000 |

Kết luận của finding này là **metadata drift đã được sửa và cửa đối chiếu tiền hiện xanh**. Nó không làm thay
đổi verdict full-site: Copilot vẫn chưa production-ready cho superadmin vì còn thiếu real-model/live
behavioral proof, role-real wrong-org/replay/concurrency proof, và page-control contract ngoài ba route pilot.

## Addendum test review và provider production readback — 2026-08-29

### Đối chiếu lại kết quả test Copilot

Kết quả test trong tài liệu này đã được dùng làm **baseline hành vi live** và không cần đổi các verdict
C01-C40 lịch sử. Phần remediation 2026-08-28 đã bổ sung đúng các gap mà ma trận test chỉ ra ở source/schema,
nhưng test live chưa được rerun trên deployment đúng build SHA. Vì vậy các điểm sau vẫn là release blocker,
không được suy diễn thành PASS từ việc gate tĩnh xanh:

Có một **lệch số liệu trong chính report cũ**: phần tổng quan ghi C01-C30 là `15 PASS / 7 PARTIAL / 8 FAIL`,
trong khi đếm theo 30 dòng chi tiết cho ra `16 PASS / 7 PARTIAL / 7 FAIL`. Không tự sửa verdict lịch sử;
mọi rerun và biểu đồ release phải lấy **row-level verdict** làm nguồn chuẩn, đồng thời giữ discrepancy này
trong evidence log để tránh so sánh sai giữa các wave.

- Tool có trong registry nhưng model chưa chắc route đúng (`ty_le_lap_day`, `cong_no_tong_quan`,
  `coc_dang_giu`, `so_quy`); cần golden functional rerun, không chỉ kiểm tra schema tool.
- Lỗi một nhánh không được làm mất các nhánh độc lập trong câu hỏi nhiều ý; cần kiểm C25/C26/C27 sau khi
  deploy, gồm cả trường hợp một tool trả lỗi.
- C23 chỉ được coi là đạt khi UI-control thực sự đổi state hoặc chat trả dữ liệu/deep-link rõ ràng; việc
  “đã có page contract” không chứng minh browser mutation.
- C28 phải chứng minh model dùng ngày `Asia/Ho_Chi_Minh`, không chỉ chứng minh prompt có chèn ngày.
- C40 phải chạy negative live cho hết hạn, replay, đổi payload và execute đồng thời; static/unit không đủ.

### Số đo verification fresh ngày 2026-08-29

| Kiểm tra | Kết quả | Ý nghĩa release |
|---|---:|---|
| Copilot/capability/lib Vitest | **213 file, 2.654/2.654 test pass** | Source/unit không có lỗi trong phạm vi đã chạy |
| Copilot inventory/routes/pages/safe-controls/E2E/golden/CSP | **Tất cả gate pass**; 14 tool (12 đọc), 3 route pilot, 7 marker, 5 spec, 30 case schema | Contract tĩnh nhất quán; chưa phải live behavioral proof |
| Migration provenance/idempotency/definer ACL | **Pass**; idempotency **30/30** | Migration source hợp lệ; không chứng minh migration pricing đã apply live |
| RPC surface/arg/cast | **268 RPC, 0 missing/drift; 0 any-cast** | Bề mặt gọi RPC nhất quán với catalog hiện có |
| Build/typecheck | **Pass** (app, E2E, Vite build) | Bundle compile được ở workspace hiện tại |
| ESLint toàn repository | **Fail: 2.452 errors, 322 warnings** | Chủ yếu ngoài Copilot; không được ghi là lint sạch, cần scoped lint/ratchet riêng |

Các gate trên được chạy lại sau khi bổ sung addendum. Cảnh báo `eval` của
`@page-agent/page-controller`, Browserslist cũ và dynamic-import warning vẫn là khoản theo dõi; chưa tự
đổi thành blocker mới nếu chưa chứng minh ảnh hưởng runtime.

### Finding mới: provider pricing policy chưa tồn tại trên production

Readback chỉ-đọc qua Supabase Management API ngày 2026-08-29 cho thấy migration
`supabase/migrations/20260829080000_copilot_provider_pricing_policy_v1.sql` **chưa được apply**. Đây là
finding production riêng, cần tách khỏi kết quả `gate:copilot-provider-policy` (gate đó chỉ kiểm catalog trong
repo):

| Provider | Enabled | Models | Thiếu pricing metadata | Function/trigger policy |
|---|---:|---:|---:|---|
| `9router` | true | 60 | 60 | Không tồn tại / không tồn tại |
| `gemini` | true | 7 | 7 | Không tồn tại / không tồn tại |
| `openrouter` | true | 3 | 3 | Không tồn tại / không tồn tại |

`supabase/migration-provenance.json` ghi migration ở trạng thái `unknown`, không có evidence và liệt kê thiếu
`public.validate_ai_provider_pricing_v1` cùng trigger `public.ai_providers.ai_providers_pricing_policy_v1`;
điều này khớp readback, không phải lỗi của provenance. Do đó không được ghi rằng pricing/cost guard đã bảo vệ
live. Proxy/source đã có logic từ chối model thiếu hoặc `unknown` pricing, nhưng các provider đang bật trên DB
production chưa có metadata để đi qua logic đó một cách hợp lệ.

Tác động rollout cần ghi rõ: migration hiện phân loại 9Router là `self_hosted`, OpenRouter `:free` là `free`,
nhưng các provider còn lại mặc định thành `unknown` và bị tắt nếu đang enabled. Với catalog production hiện
tại, **Gemini sẽ chuyển từ enabled sang disabled** cho tới khi 7 model được xác minh/khai báo pricing tường
minh. Đây là fail-closed đúng hướng, nhưng là thay đổi availability có chủ đích và phải được đưa vào thông báo
rollout/rollback. Nếu edge function chứa pricing guard được deploy trước migration, các model live hiện thiếu
`pricing_mode` có thể bị từ chối `bad_pricing`; vì vậy thứ tự phát hành phải là DB policy/readback trước, proxy
sau, rồi mới web deployment và behavioral E2E.

### Hành động bắt buộc trước khi promote

1. Chốt catalog/pricing của từng model và chấp thuận việc Gemini tạm bị tắt; tạo backup/provenance receipt rồi
   apply migration pricing bằng lane `npm run migrate:forward ... --apply`; không POST SQL trực tiếp và không
   sửa migration lịch sử.
2. Readback lại function, trigger, model catalog và `enabled` state; chạy `gate:migration-provenance`,
   `gate:migration-idempotent`, `gate:definer-acl` và `gate:copilot-provider-policy`.
3. Chỉ sau readback DB xanh mới deploy `llm-proxy` có pricing guard; smoke từng provider/model được phép trước
   khi deploy web. Nếu chưa thể apply, tắt fail-closed các provider cloud đang thiếu pricing (hoặc chỉ bật
   provider có catalog hợp lệ) và giữ Copilot ở DEMO/readonly; không promote full-site.
4. Sau khi provider gate xanh, rerun C01-C40 bằng real model trên deployment có build SHA attested, rồi lưu
   latency p50/p95/max và evidence role/organization/nonce/UI-control trước khi mở rộng allowlist.

### Verdict cập nhật

Kết luận tổng thể **không đổi**: source/schema hiện đã harden đủ để chạy pilot có kiểm soát, nhưng Copilot
**chưa production-ready và chưa đủ sức điều khiển toàn bộ trang web theo yêu cầu superadmin**. Ngoài các gap
live đã nêu, provider pricing chưa apply là blocker trực tiếp của release. Phạm vi an toàn hiện tại vẫn là
DEMO/readonly, allowlist ba route và write draft-first có người xác nhận; không promote production cho tới khi
provider readback và behavioral E2E cùng xanh.

## Addendum verification và fail-closed hardening — 2026-08-30

Wave này kiểm tra lại change set sau khi bổ sung guard rollout/org-scope và migration
loại membership đã bị thu hồi. Các kết quả dưới đây là bằng chứng source/contract mới; không được
suy diễn thành bằng chứng deployment production.

### Bằng chứng fresh

| Kiểm tra | Kết quả |
|---|---|
| Focused Copilot/capability/migration Vitest | `21` file, `264/264` test pass; riêng availability + revocation migration `14/14` pass |
| App/E2E typecheck | `npx tsc -p tsconfig.app.json --noEmit` pass; `npm run typecheck:e2e` pass |
| Vite build | `vite build` pass; còn cảnh báo `eval` của page-controller, Browserslist cũ và dynamic-import |
| Copilot contract gates | tools `14` (12 đọc), page contract `3`, safe marker `7`, E2E spec `5`, golden case `30`, provider policy `3`, CSP pass |
| Migration/RPC gates | provenance pass (`93` migration sau cutoff có entry); idempotency `32/32` đo được pass; definer ACL pass; RPC surface `268`, arg-name pass, any-cast `0` |
| Test-runner wiring | `gate:test-matrix` pass: `584` file, `11` suite, không file mồ côi; 8 test contract Node mới (gồm CSP) chạy bằng `node --test`, không bị giao nhầm cho Vitest |
| Diff hygiene | `git diff --check` pass |

### Hardening được xác nhận ở source

- Registry và PageAgent adapter fail-closed khi snapshot rollout thiếu, stale hoặc thuộc organization khác;
  execute path kiểm tra lại binding và rollout ngay trước khi chạy tool.
- UI-control chỉ được dựng khi có organization, snapshot fresh/đúng org, page contract, rollout `enabled` và
  permission tương ứng; route/rollout được kiểm tra lại trước mỗi step.
- `authorized_scope_v3` và các wrapper Copilot loại membership có `revoked_at`, nên revoke không còn được
  coi là membership active trong scope resolver.
- Provider pricing migration đã phân loại rõ model self-hosted/free và thêm trigger kiểm tra metadata; đây là
  bảo vệ ở source/schema, chưa phải xác nhận migration đã apply trên production.

### Trạng thái release không đổi

Production vẫn bị chặn: chưa có real-model C01-C40 trên deployment đúng SHA, chưa có live proof cho
wrong-org/revocation/entitlement/nonce replay-expiry-concurrency và browser mutation, page contract mới chỉ
bao phủ `/apartments`, `/invoices`, `/customers`, và pricing migration production vẫn ở trạng thái `unknown`
theo readback trước đó. Branch/worktree cũng chưa ở trạng thái sạch để promote. Phạm vi được phép giữ là
DEMO/readonly, UI-control pilot allowlist và write draft-first có người xác nhận.

## Addendum runtime race hardening - 2026-08-30

### Findings closed in source and focused tests

- Pending write confirmations are bound to organization, conversation thread, and chat generation. Scope changes clear the in-memory proposal; stale consume and execute attempts fail closed.
- The UI agent rechecks scope after its dynamic import, so an agent created for an old organization or thread cannot attach after navigation or organization change.
- Semantic UI controls perform a synchronous last-mile page-contract check immediately before DOM mutation, closing the route-change gap between PageAgent step validation and tool dispatch.
- Confirmation intent keys include the conversation thread, preventing identical payloads in separate threads from sharing a confirmation slot.

### Fresh verification

| Check | Result |
|---|---|
| Focused Copilot tests (safe controls, availability, confirmation, registry) | **85/85 pass** |
| App TypeScript | **pass** (`tsc -p tsconfig.app.json --noEmit`) |
| E2E TypeScript | **pass** |
| Vite production build | **pass**; existing page-agent `eval`, old Browserslist data, and dynamic-import warnings remain |
| Copilot contract gates | **pass**: tools, pages, safe markers, provider policy, E2E file inventory, golden schema, forbidden actions, CSP |

### Release interpretation

These changes close client-side race paths only; they do not constitute live browser evidence. Production promotion remains blocked by real-model C01-C40 rerun on an attested SHA, role-real wrong-organization/revocation/nonce negative tests, browser mutation proof, and page contracts beyond the three pilot routes. The approved operating scope remains DEMO/readonly, pilot UI-control, and draft-first writes with explicit user confirmation.

## Addendum production provider readback - 2026-08-30

### Correction to the earlier pricing finding

The earlier 2026-08-29 finding that the provider-pricing migration was still marked unknown is now superseded by a production readback. The forward-only migration supabase/migrations/20260829080000_copilot_provider_pricing_policy_v1.sql was applied on project tryymsxyyckgbrmmvozx at 2026-08-30T07:33:33.872Z, with the backup and receipt recorded in docs/generated/schema-change-evidence/20260829080000_copilot_provider_pricing_policy_v1.json.

| Provider | Enabled | Models | Pricing state | Data class |
|---|---:|---:|---|---|
| 9router | true | 60 | self_hosted (60/60) | cloud |
| openrouter | true | 3 | free (3/3) | cloud |
| gemini | false | 7 | unknown (7/7) | cloud |

The database function public.validate_ai_provider_pricing_v1() and trigger public.ai_providers.ai_providers_pricing_policy_v1 are present. Gemini being disabled is the intended fail-closed result until all seven model prices are explicitly verified; it is an availability change, not an accidental outage.

### Release impact

The provider-pricing database blocker is closed. This does not prove that the current llm-proxy bytes are deployed or that model calls are healthy; proxy deployment and provider smoke tests still require a dedicated reviewed release manifest and readback. The overall verdict remains not production-ready for full-site superadmin control because real-model C01-C40, role/organization/nonce negative cases, browser mutation proof, and page contracts beyond /apartments, /invoices, and /customers are still missing.
