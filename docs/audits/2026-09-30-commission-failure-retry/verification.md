# Kiểm chứng hotfix lỗi tạo hoa hồng/thưởng Sale

**Trạng thái tại commit ứng viên `832b4261bcab9a582e39513ac242fd0b1634f175`:** vòng sửa ba finding đã qua scoped rereview; actual scoped E2E TEST và bộ unit toàn app cuối đạt. Popup OWNER strict mới nhất trên cùng source **đạt với TEST pool 2**; các lượt HTTP 500/503 trước giữ nguyên lịch sử đỏ. Bằng chứng Realtime DDL/reload/catalog timeout và ranh giới watcher Supabase vẫn cần theo dõi; lượt đạt không chứng minh mọi timeout đã có attribution. Schema production đã áp qua forward lane có backup; full prepush đạt sau guard receipt nhỏ. Draft PR, CI, app và smoke production còn chờ tại checkpoint này. Tài liệu này không xác nhận đã phát hành.

## Mục tiêu và phạm vi

Hotfix lưu bằng chứng trước khi phát hành phiếu hoa hồng hoặc thưởng Sale, cho phép đối chiếu/tạo lại đúng yêu cầu đã lưu mà không nhân đôi phiếu. Lỗi chỉ hiện tại hai vị trí:

1. dưới hành động **Tạo phiếu hoa hồng** trong chi tiết hợp đồng trên desktop và mobile;
2. trong làn **Cần rà soát** hiện hữu của **Hợp đồng & quyết toán**.

Không có lần tạo thì không suy ra lỗi. Production aggregate **chỉ đọc, chạy mới ngày 30/09/2026**, đếm **682** cặp hợp đồng/loại chưa có event tạo và chưa có phiếu, và **0** event tương ứng; 682 này **không phải lỗi**. Yêu cầu chỉ vào hàng đợi khi có lần thực thi đã ghi nhận lỗi, hoặc sau 5 phút vẫn chưa xác minh được kết quả. Không backfill lỗi cho hợp đồng cũ hoặc đổi 682 mục thành PENDING dưới tên khác. Số lỗi tạo tách khỏi tổng tiền phiếu, tiền đã chi và công nợ.

## Bằng chứng source và kiểm thử hiện có

Các số đo dưới đây được ghi trực tiếp để checkout sạch không phụ thuộc báo cáo làm việc bị ignore. Chúng là bằng chứng source/TEST theo từng commit, chưa phải bằng chứng production.

| Phạm vi | Commit ứng viên | Lệnh/kết quả đã ghi |
|---|---|---|
| Backend, migration, retry và bộ đếm theo loại | `fc98a2f7` (gồm `fd260295`, fix lifecycle `8e0b4077`) | Focused SQL/boundary cuối: **30/30**; `scripts/test-commission-failure-retry.mjs --env test`: actual JWT/PostgREST trên TEST đã đạt ở vòng backend, và smoke bộ đếm read-only sau đó đạt **6 ca**; mutation bộ đếm làm suite đỏ rồi được khôi phục; `npm run typecheck:baseline`: **PASS, 0 fingerprint mới**; provenance migration: **PASS**. |
| UI hai vị trí, retry và phục hồi phân trang | `eafe50e1` (trên checkpoint `1ce0a4dd`) | `npx vitest run src/components/contracts/__tests__/ContractCommissionFollowupPanel.test.tsx src/components/contracts/__tests__/CommissionVoucherModal.test.tsx src/components/contracts/__tests__/ContractWorkspaceTabList.test.tsx src/components/contracts/__tests__/ContractDraftWorkspace.commission.test.tsx src/components/thu-tien/contract-settlement/__tests__/ContractSettlementSection.test.tsx src/components/contracts/detail/__tests__/ContractDetailView.mobileSettlement.test.tsx src/hooks/__tests__/useCreateCommissionVoucher.followup.test.tsx scripts/__tests__/commission-e2e-network.test.ts --maxWorkers=2`: **8 file, 135 test đạt**. Hai fixture source vừa chạm được chạy lại sau chỉnh dependency/EOF: **2 file, 72 test đạt**. `npx tsc --noEmit -p tsconfig.app.json`: exit 0 với types TEST tạm; targeted ESLint và `git diff --check`: exit 0. Build/bundle đạt ở checkpoint trước (`npm run build`: 4961 module; `npm run gate:bundle`: exit 0), chưa được gọi là lần build mới sau fix round 1. |
| Browser TEST trước final fix | `eafe50e1` | Popup strict: **đạt** — direct-create và draft-sign đều giữ popup, đóng popup tạo 0 commission request, unexpected console/network/production = 0, cleanup thành công. Core `--skip-settlement`: cả **5 kiểm tra hành vi đạt**, nhưng gate tổng vẫn **đỏ** vì 9 phản hồi HTTP 500/503 và console error tương ứng; một read v2 bị hủy đúng ranh giới reload được ghi riêng và không miễn các lỗi HTTP. Lần Settlement owner trước đó cũng vẫn **đỏ** vì các HTTP 500 từ reader cũ. Không có lần chạy lặp để lấy xanh. |

Các SHA ở bảng là checkpoint **trước rebase**, không hàm ý kiểm thử đã chạy lại sau rebase: `fd260295 → 4f03a56b`, `8e0b4077 → fbcf56a1`, `fc98a2f7 → 6d6f39a3`, `1ce0a4dd → b3d308ec`, `eafe50e1 → 67f19e26`. Bằng chứng final fix/E2E mới trên ứng viên hiện tại được ghi ở các mục bên dưới.

Types đang có trong worktree được sinh từ TEST và chứa thay đổi rent-support ngoài hotfix; không được commit hoặc dùng làm types production. Ở checkpoint `eafe50e1`, E2E UI đầy đủ và review toàn nhánh còn chờ; kết quả E2E/review trên ứng viên cuối được ghi bên dưới, còn các lỗi HTTP trước đó giữ nguyên bằng chứng đỏ.

## Vòng sửa ba finding của final review (base `4d01d1ba`)

Ý định QL nay được lưu bằng `manager_id` trong payload riêng của yêu cầu. Chỉ fresh canonical creation mới gọi assignment hiện hữu, trong cùng financial subtransaction, trước khi ghi COMPLETED; lỗi assignment rollback phiếu và giữ lỗi/yêu cầu để retry. ALREADY_EXISTS và receipt replay không gán lại manager/account. Không đổi quyền, công thức lương, duyệt hay posting. Modal tách loại đã lưu khỏi loại còn nhập mới: saved kind chỉ có Tạo lại đúng identity; fresh read đổi sang saved/processing sẽ chặn phần form xung đột.

Bằng chứng vòng sửa trên TEST `hzulujxgonszuleqticb`:

- RED trước source fix cho SQL manager payload, hook boundary và UI saved/new; GREEN **169 test / 9 file** tập trung. Log giữ cảnh báo Router và lỗi import động cố ý của bài error-boundary hiện hữu; không suy ra console browser sạch.
- Migration áp hai lần TEST; actual JWT **23/23** gồm canonical failure, assignment denial/rollback, cả broker/sale chọn manager khác nhau cạnh tranh, replay không đổi winner, interrupted/new-session retry và scope/redaction/cancellation/alias cũ. Hai mutation bỏ assignment hoặc cho assignment ở replay đều bị suite bắt đỏ, digest khôi phục. SQL SHA256: `2ae63fa284e2df5bc8af9314ab9ac88432c6e4311e9377f1fc8c49bcb20cadde`.
- Hai money gates chạy sau cleanup bằng full-scope owner JWT TEST: v1 **5.784.524.013 VND**, SQL = RPC = 1165 dòng phân trang; v2 **20 sổ thực**, 3741 posting / 4 trang, SQL = phân trang **2.684.308.004 VND**.
- Node **24.18.0** cho lượt xác minh cuối: typecheck baseline **0 fingerprint**, targeted ESLint sạch, build **4958 module**, bundle **564 chunk / entry 235 kB / 99 trang lazy**. Provenance official (SQL stage trước generator, production catalog chỉ đọc), RPC-cast, Copilot docs và truy vấn stable-fn-locks trên TEST đều đạt. Types TEST tạm không stage/commit.

Lượt JWT mở rộng đầu tiên thất bại do harness đọc sai tên cột posting và cleanup gọi sai tên bảng audit; đã giữ log lỗi, dọn exact-ID 12 hợp đồng/14 phiếu/2 manager users cùng configs/2 accounts trước chạy lại. Lượt sau đạt 23/23 và kiểm không còn fixture nghiệp vụ. Giữ nguyên **8 dòng audit append-only** tổng hai lượt, cùng guard/hash chain; không tuyên bố đã xóa mọi dòng và không tắt audit guard để dọn. Lượt đỏ/recovery và hai mutation được giữ thành bằng chứng riêng, không gộp vào PASS 23/23.

Lượt final fix tự nó chưa chạy lại browser hoặc toàn bộ app unit. Sau commit, scoped rereview của diff `4d01d1ba..832b4261` xác nhận cả **3 Important đã được giải quyết**, không có Critical/Important mới: replay không gán QL lại cho phiếu thắng; saved kind không còn form editable âm thầm execute payload cũ; QL chọn cho broker/Sale được lưu trong exact private payload và áp dụng trong financial subtransaction của fresh creation. Còn **1 Minor chưa sửa**: saved notice trong `CommissionVoucherModal.tsx:495` in nguyên `last_reason` SQL khi modal còn mở. Hai vị trí cảnh báo chính đã dùng formatter lý do an toàn; Minor này không được tính là lỗi tiền/quyền mới và được ghi nhận cho lượt sửa form rent-support tiếp theo.

## E2E phối hợp cuối trên TEST tại `832b4261`

Chạy headless với **STAFF biệt lập chỉ được cấp một toà**, session 27439 **exit 0, 7 kiểm tra đạt**. JWT thấy/được quản lý fixture đúng quyền và không đọc được hợp đồng toà khác. Danh sách Hợp đồng desktop không có panel/tab rà soát thứ ba. Lỗi canonical writer thật được lưu qua reload mà không bịa phiếu; làn **Cần rà soát** hiện hữu hiển thị lỗi tách khỏi tổng phiếu. Bấm **Tạo lại** từ làn này thực thi đúng saved request, tạo **một phiếu** và queue hết sau reload. Vị trí mobile đạt. Ở kịch bản khác, server đã commit nhưng browser mất response; reload/replay trả cùng receipt và chỉ **một phiếu** cho yêu cầu đó.

Report có `unexpectedNetwork=[]`, `console=[]`, blocked production `[]`. Lỗi mạng được chủ động tiêm cho execute và một read bị huỷ đúng ranh giới navigation được phân loại riêng; không tính chúng là sự cố bất ngờ. `cleanup=true`: hai phiếu thuộc **hai kịch bản** đã dọn, cùng actor, hai account và fixture liên quan; số generated types thêm là 0. Controller đã xem ảnh chi tiết và làn Cần rà soát: vị trí đúng. Ảnh làn còn legacy read loading nên **không chứng minh** tổng tiền legacy đã tải khỏe.

Popup strict trên source cuối, session 21824, **exit 1**: cả hai kiểm tra hành vi direct-create và draft → reopen → sign đều đạt, popup vẫn mở và đóng hai popup tạo **0 commission request**. Gate tổng đỏ vì **8 HTTP 500 thực** ở v2 và các đường đọc contracts, rooms, stats, reservations, read-draft-signing, Sale bonus; console ghi `57014` ở rooms/stats. `cleanup=true`, blocked production `[]`. Draft signing dùng metadata DOCX tổng hợp, chưa kiểm byte/export/download DOCX thật. Popup strict ở checkpoint cũ từng xanh nhưng **không thay thế** verdict đỏ của session 21824; lượt mới trên cùng source với TEST pool 2 được ghi riêng bên dưới. Ở checkpoint này, backend mới chẩn đoán hẹp bằng phép đọc; bằng chứng bổ sung và giới hạn attribution được ghi bên dưới.

Một lượt **chẩn đoán owner** sau đó trên cùng source `832b4261`, session 91045, vẫn **exit 1**: hai hành vi popup tiếp tục đạt, `cleanup=true`, production violations 0, nhưng ba reader cũ (`rooms`, `get_contract_stats`, `list_contract_drafts`) trả HTTP 500 / SQL `57014`; **cả hai** browser request `list_contract_commission_followups_v2` đều HTTP 200. Lượt đỏ 8 lỗi ở trên vẫn giữ nguyên. Trace ghi 11 request khởi đầu trong 58 ms; metrics cùng khoảng có tỷ trọng iowait **36,33–43,51%** trên các delta CPU được cập nhật theo đợt. Đây là tương quan tải, **chưa quy được nguyên nhân** cho SQL riêng, I/O hay hạ tầng; không đổi strict gate thành đạt.

EXPLAIN chỉ đọc, từng reader riêng lẻ sau cleanup trên TEST owner: rooms/building **401,941 ms thực thi / 110,184 ms planning**, 2.892 shared hits/0 reads/15 phòng; hai lần gọi `accessible_building_ids` đều một loop theo scope, không lặp theo từng phòng. Stats **87,833 ms / 48,461 ms**, 433 hits/0 reads; scope helper một loop. Drafts **1,446 ms / 18,631 ms**, nhưng **0 dòng sau cleanup**, nên không chứng minh đường đọc drafts khỏe trong cửa sổ lỗi. Các plan riêng lẻ dưới timeout 8 giây không giải thích ba HTTP `57014` khoảng 10,6 giây khi nhiều request đồng thời. Tại checkpoint đó chưa có fix có quan hệ nhân quả và strict popup tiếp tục chặn phát hành theo Contract §3/11.

Monitor **chỉ đọc** chạy cùng E2E trong 6 phút/161 mẫu: **tuổi truy vấn v2 lớn nhất quan sát trong mẫu là 5,718 giây**, không phải phép đo latency đầy đủ; tối đa **một** phiên v2 active cùng một mẫu. Không lấy mẫu được Lock/I/O wait. Active với wait NULL không chứng minh CPU saturation. Lượt E2E này không có HTTP failure nên không xác định được nguyên nhân các timeout cũ. Những lượt owner/full-core trước vẫn **đỏ** với HTTP 500/503, trong đó có `57014` ở v2 và reader legacy; một lượt scoped đạt không đổi verdict lịch sử hoặc chứng minh mọi đường đọc đã khỏe.

Lượt whole-app unit trước đây **đỏ 9599/9600**, một timeout ở `CustomerFieldSearch`; test đó đã đạt trong lượt focused 133 test riêng. Lượt serial cuối trên source `832b4261`, Node **24.18.0**/`maxWorkers=1`, đúng manifest include/exclude, **exit 0: 685 file và 9.633 test đạt**, **671,20 giây**, không skip hoặc tăng timeout riêng. Đây là kết quả mới; lượt đỏ trước vẫn được giữ là lịch sử, không sửa baseline. Types TEST tạm vẫn không được stage/commit hoặc dùng làm types production.

## Bằng chứng bổ sung và ranh giới owner — 30/09/2026

Source tài chính vẫn là commit đã review `832b4261`; HEAD checkpoint tài liệu là `24253d9b`. Các mốc trace dưới đây là **UTC ngày 29/09/2026** (ngày 30/09 theo múi giờ dự án). Browser và log dịch vụ có clock khác nhau, nên không ghép chúng thành latency end-to-end duy nhất.

Replay chỉ đọc cùng OWNER lúc **20:16:24.256–20:16:25.928**, một lần 10 reader đồng thời, đều HTTP **200/206**, **698,780–1670,544 ms**, không có `57014`; lượt bounded2 có điều kiện đã bỏ vì không có lỗi. Đây chỉ là **10/11 reader**, bỏ signing snapshot vì draft đã dọn, dùng hợp đồng đã tồn tại và payload dựng lại từ frozen source. Không có fixture write, full UI, ký draft, Realtime startup hay refetch sau mutation; kết quả này **không phải full E2E** hoặc bằng chứng strict popup đã đạt.

Full-popup OWNER resource trace tiếp theo (session 78601), **20:19:32.600–20:21:27.992**, vẫn **exit 1**: hai hành vi direct-create và draft → reopen → sign đạt, đóng cả hai popup tạo **0 commission request**, `cleanup=true`, production violations 0. Có **5 HTTP failure thực**:

| Reader | Browser bắt đầu UTC | HTTP / code | Duration |
|---|---|---|---:|
| `rooms` | 20:19:56.906 | 503 / `PGRST002` | 1931,632 ms |
| `contracts` | 20:20:26.693 | 500 / `57014` | 15688,610 ms |
| `rooms` | 20:20:26.697 | 500 / `57014` | 9816,623 ms |
| `sale_bonus_status_v1` | 20:20:26.723 | 500 / `57014` | 15307,490 ms |
| `list_contract_commission_followups_v2` | 20:20:26.723 | 500 / `57014` | 15306,595 ms |

Browser v2 trước ký đạt HTTP 200/1421,355 ms và refetch sau lỗi đạt HTTP 200/6266,706 ms; thành công sau không xóa lỗi trước. Artifact ignored là `outputs/commission-failure-retry/owner-resource-trace/final-popup-owner-trace.json`; bảng trên tự chứa các số đo cần cho checkout sạch.

Monitor `owner-resource-trace/resource-metrics.json` có **33 lần scrape** từ **20:18:58.024–20:24:59.032**; một HTTP 500 là **dữ liệu thiếu**, không tính bằng 0. RAM gauge **426.258.432 byte / 426,3 MB thập phân**. MemAvailable từ 158,6 MB trước browser xuống 76,2 MB ở counter mới quan sát lúc 20:20:46; swap-used từ 636,3 lên 694,0 MB. Cửa sổ counter đó tăng pswpin/pswpout **84.529/103.215**, major faults **105.183**, nvme0 read/write **1.055.244.288/425.967.616 byte**, weighted I/O **388,790 giây**; iowait chiếm **34,82%** tổng delta CPU hai core. Counter lặp khoảng một phút, nên thời điểm quan sát không phải ranh giới đo chính xác. Đây là **tương quan paging/I/O trong cửa sổ lỗi**, chưa định danh process/SQL, chưa chứng minh OOM, CPU saturation hay paging là nguyên nhân của từng request. Không đổi page counters sang byte khi chưa biết page size; weighted I/O không phải latency của một RPC.

Log dịch vụ và catalog chỉ đọc bổ sung được chuỗi cơ chế cụ thể cho lỗi schema cache:

1. Websocket Realtime HTTP 101 lúc **20:19:38.631**; `realtime_logs` ghi tenant initializing, reconcile migrations 0 ms và **Creating partitions for realtime.messages** lúc **20:19:39.069**.
2. Installed `extensions.pgrst_ddl_watch()` bắt `CREATE TABLE`/`ALTER TABLE` và chỉ loại schema `pg_temp`, không loại `realtime` hoặc giới hạn API schemas; DDL partition nội bộ vì thế có đường phát `NOTIFY pgrst, 'reload schema'`. `pgrst_drop_watch()` cũng không có schema allowlist.
3. PostgREST ghi **5 dòng received reload** lúc **20:19:39.217–20:19:39.245**. Đây là số log rows, chưa ánh xạ được thành 5 DDL/transaction hoặc sender riêng.
4. PostgreSQL log ghi **PostgREST 14.5 / authenticator**, catalog SELECT **5257 ký tự**, SQL `57014` lúc **20:19:47.568**; PostgREST ghi failed schema-cache load lúc **20:19:47.707**, rồi `PGRST002`. Hai lần query cache kế tiếp tải lại được trong **2233,3/2315,6 ms**.

Các phép đọc này xác định nguyên nhân trực tiếp của `PGRST002` là **catalog-query timeout**, và nối được đầu mối runtime Realtime với watcher rộng. Chưa có log statement/sender từng DDL để ánh xạ 1:1 thông báo; **không quy bốn `57014` ở burst ký muộn lúc 20:20:26 hoàn toàn cho DDL/reload**. Fixture call chain đã kiểm không có DDL/NOTIFY; đường Network Center partition maintenance tìm trong catalog trước đó chưa được ghi là caller thực tế ở cửa sổ này. Artifact ignored dùng để đối chiếu là `reload-service-origin.json`, `reload-runtime-origin.json`, `test-cache-lifecycle.json` và catalog watcher; các số đo cần thiết đã ghi trực tiếp ở đây.

Role kết nối hiện tại `postgres` **không superuser, không thành viên `supabase_admin`**; hai watcher và hai event trigger tương ứng đều do **`supabase_admin` sở hữu**, được bật. Đây là **ranh giới owner bên ngoài dự án**, chưa có quyền/fix đã xác minh để thay managed watcher. Bản [nháp hỗ trợ Supabase](supabase-support-draft.md) bằng tiếng Anh đã chuẩn bị nhưng **chưa gửi**, đề nghị provider tránh reload vì internal Realtime partition DDL mà vẫn giữ invalidation cho API schema/dependency hợp lệ, và điều tra catalog timeout cùng bốn timeout đọc muộn. [Issue Supabase #50043](https://github.com/supabase/supabase/issues/50043) là báo cáo tương tự; trạng thái đóng vì inactivity không chứng minh đã có fix cho project này.

Experiment giảm pool TEST xuống 2 ban đầu **ABORT trước thay đổi**: bước preflight PATCH lại giá trị gốc `db_pool=null` lúc **20:38:14.259** bị HTTP **400**; chưa bao giờ đặt pool 2 và không chạy browser mới. Readback **20:39:01.716**, HTTP 200, xác minh config không đổi (`postAbortReadback.unchanged=true` trong `owner-pool2-trace/experiment.json`). Không gọi lượt này là thử nghiệm pool 2 hoặc bằng chứng cải thiện.

Controller sau đó giữ lead phép thử numeric TEST có giới hạn: preflight 10 (effective capacity gốc trong service log) rồi 2. Lượt lúc **02:20 ngày 30/09 UTC** đã thay TEST pool 10 → 2, nhưng wrapper local dùng `file://` cho Node Windows bị `MODULE_NOT_FOUND` **trước browser/fixture/metrics**; `finally` khôi phục explicit numeric **10**, GET xác minh. Đây là lỗi runner, **không phải lỗi E2E sản phẩm hoặc kết quả giả thuyết pool**. Sau lượt abort này metadata là 10, cùng effective capacity gốc 10; không ghi là đã khôi phục nguyên null vì API đã từ chối null. Raw `owner-pool2-numeric-trace/experiment.json` và `run.log` được giữ; controller đã sửa ignored wrapper bằng `fileURLToPath` và thực hiện một actual full-popup strict giữ nguyên assertion, có report đạt được ghi tiếp bên dưới.

Chưa có schema/app production thay đổi; chưa đổi timeout, compute, managed watcher hoặc assertion. Ranh giới owner watcher vẫn cần provider xử lý nếu cần sửa cơ chế đó. Lượt strict mới dưới đây giải quyết blocker popup hiện tại theo điều kiện TEST đã ghi; Task 3/phát hành còn các bước bắt buộc.

## Full-popup OWNER strict đạt với TEST pool 2 — 30/09/2026

Controller chạy một lượt actual sau sửa ignored runner, giữ frozen source `832b4261` và cùng full OWNER org scope, không giảm assertion hoặc đổi auth/timeout/schema. Report `owner-pool2-executed-trace/final-popup-owner-trace.json` bắt đầu **02:21:31.427**, kết thúc **02:22:44.269 UTC ngày 30/09**; child browser **exit 0**, hai kiểm tra direct-create và draft → reopen → sign đạt, đóng popup tạo 0 commission request. `errors=[]`, `network=[]`, `blockedProduction=[]`, `cleanup=true`; không có trace HTTP 5xx. Đây là **full popup strict đạt thực tế**, không phải replay chỉ đọc hoặc lỗi wrapper được bỏ qua. DOCX vẫn chỉ là metadata tổng hợp; chưa kiểm byte/export/download.

Experiment thực thi có preflight numeric 10 được API chấp nhận; PATCH pool 2 **02:21:28.685**, GET **02:21:29.142** và **02:22:44.712** xác minh pool **2**. Các config còn lại giữ nguyên: API schemas/search path, max rows 1000, acquisition timeout 10 giây. `kept=true`, không rollback: TEST hiện giữ pool 2 theo quyết định controller cho phép thử tài nguyên có giới hạn. Rollback đã chấp nhận là explicit 10, cùng effective capacity gốc trong log; null metadata không thể phục hồi bằng API đã thử. Monitor child kết thúc exit 0 **02:25:31.468**; chưa dùng metrics của lượt mới để tuyên bố causal attribution.

Official service log của lượt đạt (`owner-pool2-executed-trace/cache-log.json`) vẫn ghi **cold Realtime tenant startup/Creating partitions lúc 02:21:40.654**, **5 received reload rows 02:21:40.760–02:21:41.200**, pool initialized max **2**. Cache query sau reload đạt **2867,3 ms** rồi **1015,0 ms**, tải **282 relations/810 functions**, không có failure trong log thu được. Monitor mới có **22 mẫu đều HTTP 200**; browser request duration lớn nhất trong trace **1963,333 ms**. Đường internal DDL/reload vì vậy vẫn hiện diện ở lượt đạt. **Marker phiên bản trong replication-slot Realtime đổi từ 2.138.1 ở lượt đỏ sang 2.139.0 ở lượt đạt**; đây là confound dịch vụ ngoài thay đổi pool, nên không thể quy PASS chỉ cho pool 2. Lượt actual vẫn là bằng chứng strict validation trên cùng app source và assertion, theo các điều kiện đã ghi.
Điều kiện này **giải quyết blocker strict popup hiện tại** và hoàn tất composite Task 2 cùng bằng chứng focused/type/build, scoped STAFF retry/lost-response và review đã ghi. Các lượt đỏ trước vẫn là đỏ theo điều kiện lúc chạy. Một lượt đạt với pool 2 là bằng chứng validation trong cấu hình TEST này, **không chứng minh watcher rộng đã được sửa, pool là nguyên nhân duy nhất của mọi timeout, hoặc production cần đổi pool**. Không có production config/schema/app write. Bản nháp Supabase vẫn chưa gửi và là đầu mối vấn đề managed watcher; hiện không chặn tiếp tục các bước phát hành còn lại của Task 3.

## Schema production và gate trước push — 30/09/2026

Forward lane chạy trên HEAD sạch `60d7d0f5f5ff6881a687019cbfb0b23db39730b5`, đúng SQL digest đã review, áp thành công lúc **02:43:44.875 UTC** vào production `tryymsxyyckgbrmmvozx`. Backup full mặc định có **568 TABLE DATA**, SHA256 `13fc376a56bd62b40ebd9fd0206e7b53b02ccb046468d1e8227b6777d80579f4`; file/biên nhận nằm ngoài Git và được receipt forward lane liên kết. Catalog đổi `6585604196e7…` → `f46e68346e40…`; kiểm RLS/security_invoker/search_path không có object hở. Receipt và provenance được sinh qua tooling chính thức, không sửa SQL hoặc ledger legacy.

Types production được generator atomic/normalizer sinh lại, chỉ thêm **82 dòng commission**, không chứa TEST rent-support. Lượt full prepush đầu đỏ vì 3 lỗi `noUncheckedIndexedAccess` tại receipt `[0]`. Guard `!request` được thêm trước so khớp contract/kind; boundary vốn đã kiểm đủ receipt/identity nên không đổi payload, retry hay luồng kinh tế. **21 test hook/boundary đạt**; review độc lập hẹp không có finding mới. Các E2E/money/full-unit ở trên gắn với source `832b4261`; không đổi chúng thành kết quả mới trên commit guard.

Full prepush cuối không dùng skip flag, Node **24.18.0**, **exit 0: 44 gate xanh trong 407 giây**, gồm strict islands, lint ratchet và `measure-org-leak`. Catalog check production đạt; stable function gate không có hàm đọc lấy khóa dòng; typecheck baseline **0 fingerprint**. Build/bundle cuối, draft PR, CI main, promotion và smoke còn phải chốt bằng kết quả thực tế trước khi báo app đã phát hành. Kiểm external controls mới xác nhận hai Vercel project vẫn theo nhánh `production`, app cũ `f854e75a` READY; branch protection là khoảng trống GitHub Free đã đăng ký.

## Smoke production chỉ đọc — chưa chạy

Sau khi controller xác nhận migration và app đã phát hành đúng cùng SHA, chạy từ root repo:

```powershell
$env:EXPECTED_PRODUCTION_SHA='<full-40-hex-sha>'
node outputs/commission-failure-retry/production-readonly-smoke.mjs --run-after-release
```

Script từ chối chạy nếu thiếu cờ hoặc SHA đầy đủ, so khớp thẻ `build-sha` trước đăng nhập, chỉ cho phép auth cần thiết, các REST read và danh sách RPC đọc đã duyệt (gồm `list_contract_commission_followups_v2`). Mọi business write bị chặn và làm gate đỏ. Script chọn một hợp đồng từ dữ liệu danh sách mà tài khoản hiện tại được phép đọc; không tạo lỗi, phiếu, hợp đồng hay fixture.

Phép kiểm dự kiến: không còn panel lỗi chung trên danh sách Hợp đồng desktop/mobile và Hợp đồng & quyết toán; chi tiết hợp đồng vẫn có hành động tạo bình thường; hợp đồng không có lần thử không bị bịa lỗi; làn Cần rà soát hiện hữu vẫn truy cập được. Console error, page error, HTTP 5xx, read failure hoặc write attempt đều làm smoke thất bại. Ảnh chụp được che dữ liệu động và chỉ lưu dưới thư mục ignored để controller kiểm trực quan.

Giới hạn: smoke không bấm **Tạo phiếu hoa hồng** hoặc **Tạo lại**, không xác minh mutation trên production và không chứng minh nhánh lỗi khi production không có lỗi thật. Kết quả chỉ có giá trị với SHA được truyền và tài khoản production đã cấp quyền đọc.

## Việc phát hành còn chờ

Ở checkpoint bàn giao tài liệu này, controller đã chạy dry-run forward lane cho `20260929154941_commission_failure_retry.sql`, digest `2ae63fa284e2df5bc8af9314ab9ac88432c6e4311e9377f1fc8c49bcb20cadde`. Lượt CLI đầu in SQL dry-run đạt/đã ROLLBACK nhưng tiến trình Node 24 trên Windows bị `UV_HANDLE_CLOSING` khi forced exit, **exit 1**, giữ `release-migration-dry.log`; không tính lượt đó là process gate xanh. Ignored wrapper `run-forward-lane-drained.mjs` nhập nguyên official lane SHA256 `8d0f1a28cd442c0b2a794f7713af564be4f5b35de6be95f366a986b38c2a7f33`, giữ `process.exitCode` và để handles thoát tự nhiên: tên migration sai vẫn **exit 1**, đúng file dry-run **exit 0/ROLLBACK** (`release-lane-negative-drained.log`, `release-migration-dry-drained.log`). Không sửa source/script lane gốc hoặc đổi gate; **chưa apply production** tại checkpoint này.

- popup strict mới nhất đã đạt với TEST pool 2; giữ lịch sử đỏ và giới hạn attribution, managed watcher chưa sửa; chuẩn bị draft PR cho thay đổi tiền/schema và xác minh release SHA sạch;
- forward migration lane có backup trên SHA sạch đã review;
- sinh metadata/types từ production sau migration, chạy toàn bộ gate trước push và CI;
- promote đúng SHA, xác minh Vercel rồi mới chạy smoke chỉ đọc ở trên;
- ghi kết quả release/smoke thực tế vào đây, không đổi trạng thái sang đạt trước khi có bằng chứng.

## Checkpoint phát hành bổ sung — 30/09/2026

Hotfix app đã được tích hợp vào main qua draft PR #95, HEAD `3b06805db3a7862f7c12c5fe80f90fa1c1b242ae`; source/SQL không đổi sau rebase và merge metadata. PR đã merged, nhưng **app chưa promote production**. Full prepush sau rebase đạt 44 gate / 318 giây; CI đúng HEAD trên main hoàn tất với vitest, strict, generated types, realtime, timezone và cross-tenant đạt, hai step bắt buộc đỏ. Promotion helper từ chối, không push production.

- `dependency-audit` CI sạch: 649 packages, 22 advisory, 5 roots có thể vào bundle, 0 cài đặt-prod, 17 chỉ-dev; blocker duy nhất là acknowledgment XLSX hết hạn. Các 16 mục MỚI trong phép đo local đến từ npm ls trên junction extraneous, không phải lỗi CI sạch; không dùng JSON tree lỗi để kết luận exposure. Gate/scanner cleanup và refresh thư viện khác nằm ngoài hotfix này.
- `migration-idempotent` dừng trước candidate vì catalog retirement còn ghim definition ngày 21/09. Probe chỉ đọc catalog thật xác nhận 44 function/5 trigger/role vắng; duy nhất canonical create_commission_voucher đổi md5 `c134aa5857144c2b8f66145f0e9feab5` → `b65e6b702fdf0a8fc0f15a36a519f453`, giữ owner/ACL. Phép thay source trong hotfix đã review tạo chính xác hash đó; SQL deployed/biên nhận không sửa.

Delta bổ sung chuẩn bị: vendored SheetJS CE 0.20.3 từ nguồn chính thức, SHA256 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`, lock SRI cùng byte; archive 2.409.319 bytes/26 regular files/Apache-2.0/no lifecycle hooks. Chỉ XLSX và tám transitive cũ đổi; chỉ acknowledgment đã vá được bỏ, không gia hạn hoặc thêm fingerprint. Source imports vẫn lazy. Node24 npm ci chạy cây riêng không junction, 560 packages / 3 phút; checkout chính giữ nguyên dependencies. Chi tiết nguồn và giới hạn digest trong `vendor/README.md`.

Compatibility suite dùng SheetJS thật: initial RED đúng old0.18.5 affected range; sau vá **44/44** trên ba file đạt, gồm13 ca đọc 10 archive XLS/XLSX tạo bởi0.18.5, parser hợp đồng/cư dân/chỉ số/thu chi, Unicode/text IDs/tiền VND có dấu/ngày/chu kỳ/headerrow4/validationrow, truncatedZIP và ghi/đọc workbook bytes. Không truy vấn/ghi Supabase.

Registry forwardSuccessions mới chỉ1signature, pin before/after MD5/owner/ACL, exact file/digest/receipt/project và chronology sau compensation. Receipt mới bắt definition mới, từ chối old OR new; removed helpers/triggers/role và các witness khác giữ nguyên. Reviewer độc lập không Critical/Important/Minor. Source tests RED trước implementation; sau policy **82/82** ở hai file gate/mốc đạt, gồm fullCLI offline bắt compensation failclosed;9/9 mutation qua dot-bien bắt guard bị gỡ và khôi phục sourceSHA256 `22467130e5549431aba631bb1d740a8c8ad6e4718b62211abc5fed379f7bbff7`.

Automatic approval review ban đầu từ chối probe/policy/bulk npm metadata trong agent riêng. Root bổ sung Contract user-deploy authorization, receipt/ref pin, hash-only catalog, tests và review: probe/policy narrow được xét lại cho phép; không retry bulk npm audit đã bị từ chối. Fresh audit của bản vá phải được chốt bằng CI thật. Không đọc businessdata/write production qua các bước này.

Scoped live retirement đạt; ngoại lệ pinned reservation-deposit vẫn EXEMPT, không chuyển thành idempotent PASS. **Full hoặc explicit replay compensation immutable vẫn bị guard từ chối body mới**, đã chứng minh bằng offline CLI; không nới guard hoặc fake chứng nhận cache. Candidate hotfix đã có TEST hai lượt và production forward-lane dry hai lượt trước apply. Delta gate này không miễn phép đo candidate. Typecheck baseline0 đạt; buildNode24 đạt4952modules/40,27giây, XLSXchunk499,55kBlazy. Bundle/prepush cuối, CI mới, promotion và readonly production smoke còn chờ. Không coi sự tồn tại source/receipt là app live.

Lượt prepush bổ sung cuối: **44/44 đạt trong330giây**, không skip; bằng chứng wrapper tự/Nodecon đều**24.18.0**. Bốn artifact máy sinh chỉ thêm số file source/test đã quét và các entry mới; productiontypes không đổi, SQL deployedSHA giữ nguyên. Bundle557chunks/entry234kB/98pageslazy đạt; docs330MD/0linkerrors. Externalcontrols đọc lại xác nhận2projectdeploy từproduction/7envnames và app cũf854READY; branchprotection vẫn là known gapGitHubFree, không thay settings. Commit bổ sung/CI exactSHA/promotion/readonlysmoke vẫn phải hoàn tất.
