# Kiểm chứng hotfix lỗi tạo hoa hồng/thưởng Sale

**Trạng thái tại commit ứng viên `832b4261bcab9a582e39513ac242fd0b1634f175`:** vòng sửa ba finding đã qua scoped rereview; actual scoped E2E TEST và bộ unit toàn app cuối đạt. Popup strict trên source cuối **đỏ do lỗi HTTP 500 ở các đường đọc**; draft PR, schema/app production và smoke production chưa hoàn tất. Tài liệu này không xác nhận đã phát hành.

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

Popup strict trên source cuối, session 21824, **exit 1**: cả hai kiểm tra hành vi direct-create và draft → reopen → sign đều đạt, popup vẫn mở và đóng hai popup tạo **0 commission request**. Gate tổng đỏ vì **8 HTTP 500 thực** ở v2 và các đường đọc contracts, rooms, stats, reservations, read-draft-signing, Sale bonus; console ghi `57014` ở rooms/stats. `cleanup=true`, blocked production `[]`. Draft signing dùng metadata DOCX tổng hợp, chưa kiểm byte/export/download DOCX thật. Popup strict ở checkpoint cũ từng xanh nhưng **không thay thế** verdict đỏ trên source cuối. Backend đang chẩn đoán hẹp bằng phép đọc; chưa có attribution nguyên nhân hoặc fix mới.

Một lượt **chẩn đoán owner** sau đó trên cùng source `832b4261`, session 91045, vẫn **exit 1**: hai hành vi popup tiếp tục đạt, `cleanup=true`, production violations 0, nhưng ba reader cũ (`rooms`, `get_contract_stats`, `list_contract_drafts`) trả HTTP 500 / SQL `57014`; **cả hai** browser request `list_contract_commission_followups_v2` đều HTTP 200. Lượt đỏ 8 lỗi ở trên vẫn giữ nguyên. Trace ghi 11 request khởi đầu trong 58 ms; metrics cùng khoảng có tỷ trọng iowait **36,33–43,51%** trên các delta CPU được cập nhật theo đợt. Đây là tương quan tải, **chưa quy được nguyên nhân** cho SQL riêng, I/O hay hạ tầng; không đổi strict gate thành đạt.

EXPLAIN chỉ đọc, từng reader riêng lẻ sau cleanup trên TEST owner: rooms/building **401,941 ms thực thi / 110,184 ms planning**, 2.892 shared hits/0 reads/15 phòng; hai lần gọi `accessible_building_ids` đều một loop theo scope, không lặp theo từng phòng. Stats **87,833 ms / 48,461 ms**, 433 hits/0 reads; scope helper một loop. Drafts **1,446 ms / 18,631 ms**, nhưng **0 dòng sau cleanup**, nên không chứng minh đường đọc drafts khỏe trong cửa sổ lỗi. Các plan riêng lẻ dưới timeout 8 giây không giải thích ba HTTP `57014` khoảng 10,6 giây khi nhiều request đồng thời. Chưa có fix có quan hệ nhân quả; strict popup tiếp tục chặn phát hành theo Contract §3/11.

Monitor **chỉ đọc** chạy cùng E2E trong 6 phút/161 mẫu: **tuổi truy vấn v2 lớn nhất quan sát trong mẫu là 5,718 giây**, không phải phép đo latency đầy đủ; tối đa **một** phiên v2 active cùng một mẫu. Không lấy mẫu được Lock/I/O wait. Active với wait NULL không chứng minh CPU saturation. Lượt E2E này không có HTTP failure nên không xác định được nguyên nhân các timeout cũ. Những lượt owner/full-core trước vẫn **đỏ** với HTTP 500/503, trong đó có `57014` ở v2 và reader legacy; một lượt scoped đạt không đổi verdict lịch sử hoặc chứng minh mọi đường đọc đã khỏe.

Lượt whole-app unit trước đây **đỏ 9599/9600**, một timeout ở `CustomerFieldSearch`; test đó đã đạt trong lượt focused 133 test riêng. Lượt serial cuối trên source `832b4261`, Node **24.18.0**/`maxWorkers=1`, đúng manifest include/exclude, **exit 0: 685 file và 9.633 test đạt**, **671,20 giây**, không skip hoặc tăng timeout riêng. Đây là kết quả mới; lượt đỏ trước vẫn được giữ là lịch sử, không sửa baseline. Types TEST tạm vẫn không được stage/commit hoặc dùng làm types production.

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

- xử lý/verdict gate popup strict: lượt đầu 8 HTTP 500, lượt chẩn đoán owner kế tiếp còn 3 HTTP 500/`57014`; draft PR cho thay đổi tiền/schema; whole-app unit và review sửa ba finding đã đạt, release SHA sạch vẫn cần xác minh;
- forward migration lane có backup trên SHA sạch đã review;
- sinh metadata/types từ production sau migration, chạy toàn bộ gate trước push và CI;
- promote đúng SHA, xác minh Vercel rồi mới chạy smoke chỉ đọc ở trên;
- ghi kết quả release/smoke thực tế vào đây, không đổi trạng thái sang đạt trước khi có bằng chứng.
