# Kiểm chứng và phát hành

Phạm vi: đúng kế hoạch sửa phản hồi A–I, không đổi quy tắc tiền, quyền duyệt hoặc schema. Cây checkout chính và migration legacy có sẵn được giữ nguyên.

187 nhóm có bản ghi nguồn/bằng chứng ở `plan-status.json`; mỗi điểm AST có trạng thái ở `feedback-decisions.json`. Số điểm khảo sát không phải số lỗi độc lập. Các bảng trước/sau nằm trong tài liệu từng nhóm.

## Kiểm thử đã chạy trước tích hợp

- Lỗi kỳ đầu hợp đồng và form phiếu trống có ca regression nguồn/DOM. Bộ lỗi từng trường gồm ngày, tháng, tiền, ô chọn, tệp, tab/phần ẩn và dòng động.
- Root chạy độc lập I01 mobile 21/21; import hợp đồng và ownership thanh lý 88/88; push 38/38; bộ truy vấn cuối gồm thống kê hợp đồng, thanh lý và kỳ hạn cọc đạt. Báo cáo chi tiết chọn lọc tại `focused-evidence.json`. Các suite chồng nhau không được cộng thành số test duy nhất.
- Đối chiếu tiền v1: 1.171 dòng, tổng 5.799.257.813, SQL/RPC/JWT/RLS khớp, kiểm pagination cap-1000.
- Đối chiếu tiền v2: 20 sổ legacy/v2 khớp; 3.770 dòng/4 trang, tổng 2.678.302.183 khớp SQL. Không dùng trang đầu làm tổng.
- Mutation tiền/quyền đã ghi digest, RED đúng lý do và restore; không sửa SQL production.

## Tích hợp

Main 45149b9b đã gỡ voice-lab; H20 là nguồn không còn dùng, không đưa tính năng cũ trở lại. Giữ luồng prepare/retry phiếu hoa hồng và vị trí panel của main; chỉ nối phản hồi an toàn và giữ biểu mẫu. Dependency xlsx vendor của main được giữ, node_modules worktree riêng.

## Giới hạn kiểm chứng

Unit/DOM dùng mô phỏng có kiểm soát; chưa xem mọi nhánh máy chủ, mọi vai và mọi thao tác trong 187 nhóm là E2E đạt. Không gửi Zalo/email/push thật và không tác động hạ tầng. Không ghi dữ liệu nghiệp vụ org thật. Một số luồng nhiều bước vẫn chưa atomic ở backend; phản hồi nói phần đã lưu/unknown và giữ ID để tránh lặp, không tuyên bố đã sửa tính toàn vẹn backend. Push pending cleanup chỉ được kiểm trong caller đang mở; reload/multitab và provider thật chưa kiểm.

Final app/baseline/strict/full suites/build/bundle/gate và E2E đúng SHA sẽ ghi dưới đây trước phát hành.

## Điểm kiểm tra trước rà soát lại writer (30/09/2026, 17:14)

- Full `vitest run src`: 10.830 đạt / 10.831 ca, còn 1 ca đỏ tại orgPayloadCoverage cho insert biến submitted trong hook mẫu tài liệu. Không coi lượt này là xanh. Đề xuất một dòng chưa áp dụng nằm trong review-required.md; cần phản hồi của người dùng do tự động kiểm duyệt từ chối biên payload.
- App TypeScript exit0 sau typed guard dịch vụ tòa; baseline0 fingerprint; E2E TypeScript exit0. Lint ratchet0 lỗi mới (942 lỗi legacy/2619 file, baseline1087), không sửa baseline.
- Đây là snapshot trước review phạm vi cuối của quota/vật tư, không phải bằng chứng cho bản phát hành cuối. Review cuối yêu cầu phục hồi writer/order/identity/payload/cleanup của main trong bốn file; giữ thêm receipts, safe feedback, draft/ID và barrier của kế hoạch. Cần chạy lại test/type/lint sau khi nguồn đó đóng băng.
- Kiểm kê ở snapshot này: 1298 file nguồn, 1862 điểm gọi, 0 chưa phân loại; 187 nhóm kế hoạch có bản ghi. Cần tái sinh sau mọi sửa nguồn cuối.
- Chưa push nhánh, chưa mở PR, chưa chạy E2E Preview đúng SHA hoặc promote production. Không dùng điểm kiểm tra này để cho phép phát hành.

## Kiểm lại nguồn hiện hành (30/09/2026, trước tích hợp main mới)

- Mẫu tài liệu: người dùng đã cho phép đúng một dòng đề xuất; `orgPayloadCoverage` và helper/org/template receipts đạt 66/66. Không sửa gate hoặc payload nghiệp vụ khác.
- B03 focus: DOM fieldset khóa và parent dialog còn aria-hidden có RED trước sửa; bộ nguồn hiện hành 32/32 sau sửa. Review độc lập B03/template/residence đạt 106/106 trên 9 file. Bản E2E local nhãn working-6ed43de kiểm 10/10, không skip/flaky: desktop/mobile form thu chi trống, ngày kỳ đầu local/server (mock đúng một writer, biên bằng nhau vẫn gửi), tải lỗi theo 4 vai DEMO, giữ console/pageerror diagnostics. Không gọi bản local này là Preview đúng SHA.
- Typecheck app và E2E exit0 sau focus. Strict noUncheckedIndexedAccess đã exit0 sau 15 sửa typing với parity JavaScript/probe, không tăng baseline.
- Lượt full src thứ hai đạt 10.956/10.967, 11 đỏ (1 org scanner trước phép một dòng, 10 ca khác). Chạy riêng sáu file có 10 ca đỏ đó với maxWorkers=2 đạt 132/132, không đổi assertion/timeout. Cần lượt full cuối trên nguồn đóng băng, không dùng tổng hợp lượt này để coi full xanh.
- Một số focused name-pattern trước đây lẫn 5 ca từ archive main dưới .superpowers; final-independent-review.md đã sửa counts thành chỉ nguồn hiện hành. Lượt full kiểm xác nhận không có archive; các lượt sau đều exclude .superpowers/**.
- Đối chiếu writer main và receipts đã khép các finding F04/F07/F09/F11/F12/F18-F20; không thay order/payload/filter/cleanup/rules tiền.
- Bundle còn đỏ ở snapshot trước tải động helper mới: entry277kB, threshold230KiB +5%. Bản archive main đo bundle thực là 9aa3b48b (ZIP provenance), entry240.141 byte, nằm trong ngưỡng. Không chỉnh baseline/config để vượt gate; số đo cuối sẽ cập nhật sau source freeze.
- Origin/main đã có cải thiện đọc phiếu/chứng từ/ảnh sau base45149; phải giữ khi rebase, chạy lại gate và E2E đúng SHA. Chưa push/draft PR/promote production ở snapshot này.


## Chốt kiểm kê helper tải động (30/09/2026, 20:22, trước rebase main mới)

Source freeze tại HEAD6ed43de và working tree hiện hành: 1.303 file nguồn, 1.866 điểm gọi AST (913 notification,193 diagnostic log,406 useQuery,351 useMutation,3 useInfiniteQuery). Master có 0 chưa phân loại và 0 ID hết hiệu lực. Đã đọc riêng16 call mới, thay12 ID cũ; các ID query/writer không đổi giữ quyết định cũ. Không đánh hoàn tất theo file. Snapshot/source hash và mapping cũ→mới nằm tại artifact ignored notification-async-inventory/reconciliation-proof.json; inventory và review queue đã sinh lại bằng tooling/audit-user-feedback.mjs.

- A01/A07/G01/G23: asyncActionFeedback chỉ import friendlyError khi có lỗi; primary dùng cùng converter title/description/options. Import/converter/sink failure có safe fallback, cause diagnostic, không unhandled rejection. Hai sink dùng cùng delivery ID khi primary có thể đã publish, không tạo thông báo thứ hai từ fallback. Financial unknown giữ đầu vào/đối chiếu trước gửi thêm; không tự replay writer. useAuth chỉ đổi4 generic onError (register không còn nguồn live), giữ special invalid credentials; useNotifications chỉ đổi import. AST proof ngoài feedback của hai hook giống HEAD.
- A05/A07: QueryProvider tải nhãn ở lỗi đọc, dùng fallback dữ liệu của mục đang mở khi import hỏng; silent/inline/dedupe/retry đọc1 và mutation retry:false giữ nguyên. MutationCache bỏ qua caller đã có owner; notifyActionError giữ operation/financial. Không đưa queryKey/raw cause ngoài UI hoặc thử lại writer.
- A13: ErrorBoundary chỉ tải bảng tên41 route khi bắt lỗi; pending/rejected import dùng đang mở, custom fallback/explicit pageName và chunk reload budget giữ nguyên. Independent101/101 kiểm parity tên trang và nhánh chunk; không xem DOM mock như browser reload thật.
- I13/nguồn quyền quản trị: AdminOnlyRoute chỉ tải QueryRegion ở nhánh read failure, fallback vẫn hiện alert/Tải lại. Error read không mở nội dung quản trị từ cached true hoặc chuyển hướng như confirmed false; criteria/loading/redirect/children cũ giữ nguyên. DOM10 case trong bootstrap239/239, không thay permissions/API.
- Tạm trú: residenceRegistrationKeys chuyển vào leaf, hook re-export giữ API và key tuple nguyên mẫu. TamTru tải recordWriteMessage chỉ ở catch; failure giữ mã/kiểm lịch sử, không acknowledge hồ sơ chưa có receipt. Registration coordinator vẫn await trước upsert; target/org/user/order/payload giữ nguyên theo review/probe.
- G01/G02 focus: asyncFormErrors chỉ tải helper sau lỗi, diagnostic qua reportBoundaryError nên scanner không tạo call ID. Ba form Auth chỉ đổi import, validators/handlers/markup giữ nguyên; fallback chờ DOM rồi focus input lỗi hiện/khả dụng trong root, không đổi auth/writer. Owner33/33 và independent33/33, không cộng hai lượt thành66 ca.
- main giữ window.load rồi tải module push; callback đăng ký cũ chạy một lần, import/registration failure chỉ diagnostic, không unhandled. Probe3 chế độ của actual callback và4 key probes nằm trong final-notification-bootstrap-scope-proof.json. Splash watchdog,4500ms hide và chunk guard giữ nguyên; chưa phải browser service worker thật.

Bằng chứng mới chỉ từ src hiện hành: async/Auth/notifications83/83 (14 file), bootstrap độc lập239/239 (12 file), mutation-owner2/2 (2 file), A13 độc lập101/101 (3 file), admin/query-region17/17 (2 file), residence leaf20/20 (3 file), async focus owner33/33 và độc lập33/33 (7 file mỗi lượt). Các bộ chồng nhau được ghi riêng tại focused-evidence.json, không cộng thành tổng duy nhất. Các report name-pattern cũ lẫn archive dưới .superpowers không dùng làm proof source hiện hành.

Bundle trước leaf keys là251.114 byte; lượt sau async focus lúc20:19 là249.866 byte, vẫn vượt ngưỡng247.384,2 byte và gate:bundle exit1. Artifact notification-keys-lazy-bundle.txt và notification-auth-focus-lazy-bundle.txt giữ snapshot đỏ; không đổi baseline/gate. Build đỏ/xanh riêng không thay thế gate bundle. App/strict/full/E2E/gates cuối phải chạy lại sau rebase main; origin/main9aa3b48b có voucher read state/deadline/media/camera cần giữ. Chưa push/draft PR/Preview đúng SHA/promote production tại lượt docs này. E2E local10/10 trước đó chỉ áp dụng đúng kịch bản đã ghi, không nghiệm thu mọi nhánh tải động mới.


Bổ sung leaf validation tạm trú sau freeze20:25: RegistrationError class và maHoSoHopLe giữ nguyên, residenceRegistrations import/re-export cùng API; listener vẫn đăng ký ngay và await import writer trước cùng ghiHoSoTamTru/payload/guard/ack. Đã đọc3 file nguồn và leaf, không có call AST mới; focused residence-validation-import-final.json20/20 trên3 suite src. Snapshot1303file/1866call/0pending/0stale master, source hash ghi trong feedback-inventory.json và ignored reconciliation-proof.json. Build/gate sau leaf này do root kiểm, không suy đã xanh từ20 test.


Điểm chốt docs20:27: final-residence-validation-independent.json đạt20/20 trên cùng3 suite src, ghi riêng lượt owner20/20 và không cộng thành40 ca. final-residence-validation-scope-proof.json có exact AST cho class/validator, same-class re-export, writer/listener body parity và strict leaf thêm0 removal/options unchanged. Bundle notification-bootstrap-freeze-bundle.txt sau leaf là247.543 byte, vẫn vượt247.384,2 byte (158,8 byte), gate exit1; snapshot251.114 và249.866 phía trên giữ lịch sử. Chưa production, chờ gate sau rebase/source cuối của root.


## Chốt docs sau rebase main9aa (30/09/2026)

Rebase đã hoàn tất, HEAD2b9babf31c63c663f1c490451a83977412d0e214 dựa trên origin/main9aa3b48b67d1deb5ca9cd29779e326059c017b7e. Nguồn đã freeze. Lượt docs chỉ đọc source và cập nhật ledger/artifact, không sửa writer/auth/rules/gate/baseline, không stage. Full src maxWorkers2 của root (session18929) đã kết thúc: notification-post-rebase-full-src.json đạt11050/11050,0failed/0pending,884file src hiện hành và0archive. Lượt này trước hai string copy cuối; delta copy được owner7/7 và independent7/7 kiểm riêng sau đó, không gọi focused là full.

Inventory hiện hành:1.306 file nguồn/1.868 call (913 notification,195 log,406 useQuery,351 useMutation,3 useInfiniteQuery),0 needs-review/0 stale master;140 flag đã có quyết định/evidence. Đã đọc riêng5 call mới và thay3 ID cũ: query chi tiết deadline30s + tổ chức gợi ý, query đợt deadline45s, timeout upload FinanceV2 và2 diagnostic late-cleanup. Master/owner/plan callIds remap theo các call này, không đánh hoàn tất cả file. Source hash 0c2cc345f6311e59fcfcc0d6f110eb232991173e079519008bb3e524e0770675; mapping và proof current-source tại artifact ignored notification-postmain-inventory/postmain-reconciliation-proof.json.

- FinanceV2 giữ deadline main cùng upload options; task intent-ID validation/exact FINALIZED receipt và4 durable hooks/requestKey giữ. Timeout local có lý do quá lâu + giữ tệp/đối chiếu, generic error vẫn safe owner. Fixture success dùng ev-2/FINALIZED; mọi assertion main deadline/null/noFinalize/uploadoptions/finalize giữ. RED19/20 chỉ mất timeout reason trước sửa, GREEN131/131 (10srcfiles), ESLint2files0/0 và diffcheck.
- Main đọc phiếu dùng organizationIdHint để chạy sớm, allSettled xét header RLS trước lỗi song song; hint sai đọc lại theo org thật. Deadline30s/45s, meta.silent, VoucherReadState/useSheetStill/CSS, loading/tap/stale guards giữ.5 helper exact main text,4wrapper +3hint/staleguard same main AST; nội dung QueryRegion/history/invoice/account errors và draft/reason focus của task giữ. Proof finance-main-merge-parity.json.
- Storage/Zalo giữ main stored path/MIME/size/extension/compression, auth/deadline/late cleanup, R2/imageCompress nguyên main; task media sender request/partial IDs/unknown barrier giữ.2 cleanup log chỉ diagnostic, không fake cleanup success hoặc toast nền. owner45/45 (9srcfiles), scope proof rebase-storage-zalo-scope-proof.json. Không gửi media/provider/live writes ở lượt review.
- Provider giữ Safari Load failed/LOI_DOC_MAC_DINH và main reload recovery; câu internal invariant chỉ lỗi hệ thống/tải lại trang, không đoán frontend/backend version. Task async query labels/mutation-owner giữ. Root34/34 trên2srcfiles; notification-main-read-recovery-red/green có RED→GREEN.
- Root rút safeFallback copy tại asyncActionFeedback/TamTru, vẫn giữ input, đối chiếu phiếu+sổ/mã hồ sơ, không gửi thêm khi chưa rõ kết quả. Same ID/once-per-submCode/cause diagnostic/ack confirmed IDs và bounded fallback giữ; notification-fallback-copy-final.json13/13 current2srcfiles. Hai string description cuối asyncActionFeedback có owner notification-fallback-copy-bundle-final.json7/7 và independent final-fallback-copy-independent.json7/7 trên cùng1srcfile, không cộng thành14. final-fallback-copy-scope-proof.json xác nhận ba handler/ID/options và test giữ nguyên, chỉ copy thay đổi.

Review độc lập sau merge: final-main9aa-merge-independent.json210/210 trên21srcfiles và final-main9aa-merge-owners-reads-independent.json48/48 trên6srcfiles (helper/receipt/owner/canonical read). Hai lượt independent210/48 không trùng file, đạt258/258 trên27file; final-independent-review.md ghi scope/limits. focused-evidence.json ghi owner131/storage45/root34/fallback13 và independent210/48 cùng copy7/7 theo từng lượt; các lượt owner/reviewer khác có suite chồng nhau nên không cộng thành tổng duy nhất. Mọi đường dẫn report được kiểm thuộc src hiện hành, exclude archive.

Các số bundle251114/249866/247543byte đỏ phía trên là snapshot trước rebase và giữ lịch sử. Sau main merge, snapshot247465byte vẫn đỏ; hai string description cuối đưa entry dist/assets/index-nW608_pw.js xuống247379byte, dưới ngưỡng baseline235604×1,05=247384,2byte. notification-final-build.txt build thành công; notification-final-bundle.txt PASS với588chunk/98trang lazy, không đổi gate/baseline. App/E2E typecheck root session35238 exit0, artifacts notification-post-rebase-app-types.txt và notification-post-rebase-e2e-types.txt không có lỗi TS. Full Contract gate session72843 đang chạy; chưa coi gate tổng đã xanh. E2E local10/10 trước đây vẫn chỉ cho các kịch bản đã ghi, chưa thay bằng E2E Preview đúng SHA sau main merge. Chưa push/draft PR/promote production tại điểm chốt docs này.


Kiểm nhất quán plan cuối: sửa9 tham chiếu ID lịch sử còn sót trước rebase bằng đọc đúng enclosing caller, giữ quyết định root hiện hành. Gồm area assign1, building services mutation1 và success toast cũ đã bỏ1, services/quota4, unapprove/cancel2. Success toast không còn source được gỡ khỏi plan, không tạo call thay thế. estate-core/finance owner pruned9 obsolete; master vẫn đủ1868ID,0stale/0pending,187nhóm plan không còn callIds lỗi thời. Exact mapping/source evidence nằm trong postmain-reconciliation-proof.json; đây là sửa tài liệu theo nguồn đã freeze, không thêm thay đổi writer hoặc blanket classification. DOC FREEZE: inventory/hash/owner/master/reviewqueue/plan/focused/verification đã đồng bộ; root tiếp tục gate tổng và phát hành đúng SHA.

## Gate cuối trước PR (30/09/2026)

Source đã freeze ở snapshot0c2cc345f6311e59fcfcc0d6f110eb232991173e079519008bb3e524e0770675. `notification-post-rebase-prepush.txt` chạy đầy đủ, exit0:44gate xanh trong321s, gồm strict islands/lint ratchet và measure-org-leak với credential đọc catalog; không dùng cờ bỏ strict/org. Generator chỉ stage2MD đúng allowlist (repository-inventory/rpc-surface), không stage migration legacy. `notification-post-rebase-type-baseline.txt` exit0,0fingerprint; app và E2E typecheck exit0. Build/bundle exit0:588chunks/98lazy, actualentry247379byte dưới ngưỡng247384.2byte; baseline/gate không đổi. Review độc lập merge258/25827file + delta2copy7/7, handlers/guards unchanged. Fullsrc11050/11050884files trước delta2description; sau delta test cùng helper owner7/7 và independent7/7, không suy cộng thành full mới.

Đây là bằng chứng local source/DOM/gate; chưa là Preview đúng SHA, CI mọi step đúng commit hoặc production READY. Các bước phát hành tiếp tục sau commit và draft PR. Migration dở dang giữ nguyên SHA2561e3c7fba6c2748532d1fef3ad546aeec270ea684a09cd66bb7641e8e3fe224c5, ngoài index.