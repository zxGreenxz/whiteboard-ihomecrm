# Trạng thái triển khai Hermes × iHomeCRM

Cập nhật: 12/10/2026 · Asia/Bangkok. Kế hoạch gốc được duy trì tại [PLAN.md](PLAN.md).

## Điểm tiếp tục

- **Đang làm:** Store, broker và cấp phiên độc lập P2 đã đạt 18/18 trên TEST, đã dọn fixture và xác minh hash đầu vào không đổi. Đang chốt gate/CI của checkpoint, bổ sung HTTP quản lý kết nối và reader dữ liệu phòng. Egress/invalidation/quota đầy đủ của P1 còn mở.
- **P0 đã hiện thực:** inventory chi tiết v2 và đối chiếu catalog TEST chỉ đọc; focused tests và gate local 47/47 đạt. CI checkpoint `494d306a` đã đạt; WIP mới chưa qua gate/CI cuối, bản ghi review ở PR.
- **Chưa hoàn thành:** Mạng cách ly đầy đủ, refresh toàn tuyến/quota model, kết nối/user memory sản phẩm, Hermes tổng, UI hoặc gửi tin thật. P2 đang kiểm code nền; P3 có projection chưa nối tool; P4–P11 chưa triển khai.
- **Worktree:** `C:/Users/Nguyen Tam/codex-worktrees/hermes-crm-foundation-20261012`.
- **Branch:** `codex/hermes-crm-foundation-20261012`.
- **Base:** `7367b7007f096f20471bf1309bc51e0b971439b6` (origin/main sau fetch).
- **Commit checkpoint:** `66acfbdbb226d15371d3e4c18352996093d65fbf`, tree `53561be9f1ca99a1698094c1d2f04068983a7009`: local 47/47 và durable TEST 18/18; đã review/push draft PR. CI runtime của head này dừng ở setup canary; chưa merge/phát hành. Receipt runtime 17/17 cũ dùng image khác và không chứng minh pin hiện tại.
- **Draft PR:** [#165 — nền CRM dùng chung và plan Hermes](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/165). Đọc checks đúng head hiện tại của PR; trạng thái GitHub có thể mới hơn checkpoint này.

## Nhật ký đã xác minh

### Delta TEST sau checkpoint `494d306a`

- Đối chiếu upstream cho thấy digest runtime cũ `32d095e8…` không thuộc receipt phát hành v0.21.6. [Annotated tag chính thức](https://api.github.com/repos/NousResearch/hermes-agent/git/tags/f27cdbce5ab63eafe8633b293a75151409da5769) gắn commit `818c13be…` → index `9774f4f3…` → Linux amd64 `ffa4fbb4…`; đã tự kiểm hash metadata. Đang chuyển pin và chạy lại CI. Receipt upstream chưa ký, revision label trống; không gọi là signed attestation. 17 checks cũ vẫn là lịch sử image cũ, không chứng minh image mới.
- Runtime egress đã thêm canary TCP/DNS IPv4/IPv6, positive trước/sau và bộ đếm nhận gói. Review sửa host listener sang exact gateway; unit mặc định loopback. 19/19 runtime-contract tests tại delta bind đạt; actual Docker cho delta và pin mới còn chờ CI.
- Sau ghim image mới và bổ sung kiểm chuỗi hash receipt, runtime-contract đạt **23/23**. Receipt upstream chưa ký; kiểm metadata không thay cho Docker chạy image mới. Bộ kiểm container mới còn chờ CI Linux.

- Lượt durable store `32ab1850-5bd7-491e-9599-0ee7eb7bd582`: schema/owner, login PostgreSQL riêng + ACL, fixture scope tổ chức và cleanup đạt; 8 ca kích hoạt/lưu phiên chưa đạt (`store_rejected`). Hash nguồn đầu/cuối không đổi. Không diễn giải các ca lỗi thành pass.
- Đã chứng minh nguyên nhân bằng truy vấn chỉ đọc trên TEST: regex ciphertext `{1,87382}` phát SQLSTATE `2201B`. Mẫu thay thế kiểm riêng `char_length` và bộ ký tự base64url cho đúng kết quả tại 0, 1, 87.382, 87.383 ký tự và ký tự sai. Receipt: `.cache/hermes-envelope-regex-proof.json`.
- Hai migration đã apply giữ nguyên. Forward `20261012074002_hermes_envelope_length_guard_v1.sql`, SHA-256 `0f0b4b039fc6af6596df5e0816d3b9c057689979dce2c3fbdb45dcd89141b74d`, đã review độc lập, schema tests 26/26 gồm mutation regression, dry-run và hai lượt ROLLBACK TEST đạt. Apply qua lane thành công với full backup 627 bảng có dữ liệu; receipt ở `.cache/migration-targets/test/hzulujxgonszuleqticb/schema-change-evidence/`. Catalog public không đổi vì sửa helper private; lượt live sau đó xác minh chính xác thân hàm mới, không suy từ catalog public.
- Lượt durable store cuối `2790ccfc-8985-423e-ac98-b462881f4b49`: **12/12 đạt**, gồm login DB riêng + ACL, JWT A/B/superadmin, kích hoạt lặp cùng payload, từ chối payload khác, composite FK, stage/publish, lease hết hạn, thu hồi connection/session và cleanup. Hash nguồn đầu/cuối khớp. Đây là kiểm tuần tự; chưa có broker thật đi xuyên durable authority, refresh provider trong cùng luồng hoặc proof cạnh tranh nhiều transaction.
- Control plane đã đổi sang backend tạo phiên Auth mới bằng đăng nhập độc lập, xác minh cùng user/khác phiên trình duyệt. Cách này đóng khe refresh ngoài lease khi bàn giao lại một phiên đã được quản lý. 20/20 focused tests và review delta đạt; không nhận cặp token từ browser. Chưa có HTTP endpoint/UI hoặc bằng chứng toàn tuyến cuối.
- Refresh manager hỗ trợ hủy theo giai đoạn, cleanup dùng deadline độc lập; sau dispatch không suy lỗi mạng thành global revoke. Manager/adapter 57/57 focused tests và review delta đạt; chưa kiểm provider + DB + broker trong cùng luồng.
- Primitive quản lý kết nối đã có list/context/thu hẹp/thu hồi theo JWT đúng chủ và công ty. Review đóng lỗi trả context quyền cũ và JWT hết hạn trong lần đọc quyền cuối; 28/28 focused tests đạt. Chưa mở HTTP/UI, chưa có management TEST toàn tuyến, phân trang lịch sử hoặc luồng offboarding khi user mất membership.
- Lượt tích hợp broker `b5281a38-d78a-411e-9ca0-39c333ddac93`: 5 đạt/2 lỗi, cleanup đã xác minh. Phép đọc quyền song song gọi cùng phiên kiểm lease chỉ nhận một lệnh, làm fixture tự báo mất lease. Đang sửa bộ kiểm và chạy lại; không tính lượt này là integration pass.
- Sau sửa queue kiểm lease, lượt `adf8b077-5a20-4334-9422-6b6e650b1b87` đạt **17/18**, cleanup xác minh và hash nguồn không đổi. Cách ly broker/user/org, deny input, quota riêng, restrict/revoke và kiểm sau audit đã đạt. Ca cấp phiên mới còn `context_changed`; truy vấn chỉ đọc TLS xác định clock host nhanh hơn TEST khoảng 6,7–6,8 giây, trong khi token mới dùng host + đúng 15 phút nên vượt trần DB. Đang sửa mốc tính hạn theo timestamp prepare của DB, giữ nguyên trần SQL; chưa báo toàn tuyến đạt. Clock receipt `.cache/hermes-test-clock-proof.json`.
- Lượt cuối `247ce314-8e53-4cc2-a62f-01dff37802fc`, lúc `2026-10-12T08:21:34.929Z`: **18/18 đạt**, `cleanupVerified=true`, `inputsUnchanged=true`. Cấp kết nối dùng phiên Auth mới cùng user nhưng khác phiên browser, xuyên qua private store và broker thật trên TEST. Đã kiểm cách ly user/org, scope/context, từ chối input giả, quota tool riêng, hạn chế/thu hồi và kiểm quyền sau audit. Control plane dùng mốc prepare của DB để không vượt trần token 15 phút khi host lệch giờ; focused **25/25** đạt. Harness queue lease **29/29** đạt. Không suy kết quả này thành proof refresh provider + store trong cùng luồng, cạnh tranh nhiều transaction, HTTP/UI, quota model hoặc production.
- Gate checkpoint durable lượt đầu đạt **46/47**, thiếu hồ sơ giải thích ba migration chưa có trên production. Đã bổ sung `migration-unknown-review.json` theo đúng trạng thái chỉ áp dụng TEST; giữ production provenance là `unknown`, không nâng trạng thái dựa trên TEST. Cửa đối chiếu hồ sơ đã đạt; gate cuối đang chạy lại với biên nhận đầu vào không đổi được tái dùng.
- Gate durable cuối **47/47**, 118 giây, tree `53561be9f1ca99a1698094c1d2f04068983a7009`, đã commit/push `66acfbdb` vào PR #165. Review độc lập non-runtime và root review runtime không có P1/P2 mới. Vitest related đạt 2 file; không suy thành full suite. [CI runtime 38224302318](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/38224302318) đã kéo đúng image/config của receipt upstream và kiểm mạng actor riêng, sau đó lỗi `Both live host gateways are required` ở setup canary. Receipt `hermes-p1-1791794033506-91647e` ghi FAILED, input hash không đổi; không báo runtime đạt.
- Delta sửa canary đọc địa chỉ bridge thực tế trên native Linux, giao với subnet Docker đã kiểm; không suy địa chỉ đầu subnet hoặc bind wildcard. Đã thêm bằng chứng network/bridge vào receipt. Runtime unit **24/24**, review độc lập sạch; Docker chạy lại còn chờ. Hai mạng actor vẫn dùng isolated gateway, không thay mức cách ly để vượt kiểm.
- CI runtime checkpoint `b6f98ef8`, [run 38225284882](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/38225284882), vẫn FAILED ở setup với `Actual control bridge is missing`; image và hai mạng actor đã đạt, chưa chạy các phép cách ly. [Mã libuv Linux](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/linux.c#L1832-L1834) bỏ interface thiếu `IFF_RUNNING`; bridge mới chưa có endpoint có thể chưa có carrier. Delta tiếp theo khởi động và kiểm canary trên mạng control trước khi đọc bridge; vẫn yêu cầu địa chỉ host thực, positive trước/sau và bộ đếm. Đây là giả thuyết có căn cứ, chờ CI xác minh, không đổi sang host networking hoặc nới cách ly actor.
- Projection phòng trống: 10/10 focused tests; mutation bỏ scope tòa, lộ field, bỏ deny scope rỗng đều bị bắt. Receipt `.cache/hermes-room-projection-mutation/receipt.json`, source SHA-256 `4e367b03898f12a2bd6be783b1626adb51e17370e1e2390153d0d7747eaa0f97`, input đầu/cuối không đổi. Chưa nối JWT reader hoặc tool vào broker.
- CA công khai của Supabase được ghim theo fingerprint DER; harness xác minh TLS cho cả login quản trị fixture và login private store. Nguồn: [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement) và URL CA được khai trong Supabase Studio. Không tắt kiểm chứng certificate.

| Mốc | Công việc | Kết quả / giới hạn |
| --- | --- | --- |
| 12/10/2026 | Chủ dự án chốt plan và yêu cầu Markdown bàn giao | Đã duyệt cả Hermes riêng + Hermes tổng; không cần hỏi lại nguyên tắc |
| 12/10/2026 | P0.01 tạo worktree sau fetch | Đã tạo đúng nhánh/path; giữ WIP checkout chính |
| 12/10/2026 | Đối chiếu baseline mới | Worker/registry đã đổi; Zalo unit đã được mở lại ở main, Copilot vẫn hoãn. Inventory cần tái sinh |
| 12/10/2026 | Lưu PLAN/STATUS Markdown | Đã ghi kiến trúc, các giai đoạn, thêm T35–T42 cho memory/giám sát; chưa phải kết quả test |
| 12/10/2026 | Inventory tĩnh có thể tái sinh | Generator + snapshot + 15 mutation/behavior tests đạt; chưa có runtime/DB evidence |
| 12/10/2026 | Chuẩn bị dependencies | Root package-lock của worktree và checkout chính cùng SHA-256; node_modules junction dùng existing deps. Không npm install/ci qua junction |
| 12/10/2026 | P1 preflight chỉ đọc | Có git 2.52, Node 22.20, Python 3.12.10, Docker CLI 29.6.2, psql 17.10; không thấy hermes/uv/deno trên PATH. Chưa kiểm daemon/runtime |
| 12/10/2026 | Khôi phục kiểm offline có chọn lọc | Core permission/tool/plan/memory chạy lại; UI/model/live và Zalo fleet vẫn hoãn. Không thay runtime sản phẩm |
| 12/10/2026 | Focused tests trước gate | Core 113/113; routing/registry 50/50; verifier 65/65; inventory 15/15. Đây là các bộ riêng, không suy ra full app hoặc live đạt |
| 12/10/2026 | Gate local lượt đầu | 46/47 đạt; Vitest related lỗi 2 assertion vẫn kỳ vọng Copilot core bị hoãn. Giữ kết quả lỗi, sửa policy regression trước khi chạy lại |
| 12/10/2026 | Review độc lập lượt đầu | Một P2: gate corpus chưa được chọn khi capability visibility/tài liệu nguồn đổi; cần thêm mapping và regression. Chưa kết luận review đạt |
| 12/10/2026 | Sửa delta sau review | 5 ca routing lỗi trước sửa đã đạt sau sửa; focused 76/76 gồm regression 29, routing 13, gate-plan 34. Matrix: 1.295 file active / 16 suite / 0 mồ côi / 75 deferred. Gate cuối và re-review delta đang chờ |
| 12/10/2026 | Gate local sau sửa | 47/47 đạt, exit 0, 76 giây. Có 46 receipts static/suite và output Vitest related 7/7 file; 10 nghĩa vụ CI chưa kiểm local |
| 12/10/2026 | Cross-review kết thúc | Reviewer kiểm source + delta + receipts cùng snapshot, không còn finding P1/P2; không xác nhận runtime/TEST/CI/production |
| 12/10/2026 | Lưu commit code | `c833d379e6f83b1d0a44ca4964f2cbf7e3831ae6`; tree `a05a740f2fc2819f679bbc0795e468567380106b` |
| 12/10/2026 | Lưu checkpoint và mở draft PR | `053b3eca` cập nhật PLAN/STATUS; docs gate 5/5 (không JS/TS để Vitest), reviewer không thấy claim sai; draft PR #165 đã tạo |
| 12/10/2026 | Xác minh lại PR #165 | OPEN/draft, head `386296cb`, các job bắt buộc và aggregate SUCCESS; job bỏ qua theo scope không được coi đã kiểm. Chưa phải release production |
| 12/10/2026 | P0.02 inventory v2 | 67 tool, 32 action, 29 UI capability, 47 page contracts, 6 safe controls; 28/28 focused tests + generator check đạt. Disposition hai tool kế hoạch đã ghi; chưa bật runtime Hermes |
| 12/10/2026 | P0.03 TEST catalog | `BEGIN READ ONLY`, marker TEST hợp lệ; 32/32 registry khớp; 135/135 tên hàm ở schema đúng. 69 cờ enabled/2 disabled trên TEST; không suy ra quyền Hermes hoặc production |
| 12/10/2026 | Comparator catalog | 23/23 tests, gồm empty evidence, registry drift, public/private helper, thiếu ACL, RPC giả; không dùng ledger legacy để yêu cầu replay migration |
| 12/10/2026 | P1 upstream/runtime | Ghim đề xuất Hermes v0.21.6, source `818c13be1dc4fd28987e1e881a9408224afd4535`, image digest cụ thể. Docker Desktop đã khởi động nhưng daemon chưa sẵn sàng; fixture/broker đang hiện thực, chưa có runtime pass |
| 12/10/2026 | Chẩn đoán Docker local | Backend log báo không truy cập được socket `Docker/run/dockerInference` (reparse point cũ 13/08). Thử đổi tên dự phòng bị Windows từ chối; chưa đổi/xóa file, chưa reset Docker. Không coi lần gọi Start-Process là engine đã chạy |
| 12/10/2026 | P1 JWT thử đầu | Lỗi thiếu Content-Profile gây PGRST202; đã giữ receipt lỗi, sửa adapter và regression. Cleanup đã xác minh |
| 12/10/2026 | P1 broker + JWT cuối | Broker 28/28 unit/HTTP; harness 11/11. JWT TEST thật 17/17 với 3 user giả/2 org giả, cleanup=true, active_run=0; 8 hash nguồn đầu/cuối khớp. Không sửa schema hoặc xuất tool phòng |
| 12/10/2026 | Review broker/harness | Sửa khe thời gian sau audit bằng kiểm quyền cuối; SQL timeout không rõ kết quả giữ khóa TEST. Review độc lập harness/inventory/routing không còn P1/P2; gate tổng chưa chạy |
| 12/10/2026 | Hermes MCP client thật | Upstream ghim + MCP 2.0.0 chạy native Python riêng: 4/4 transport checks đạt. Chỉ chứng minh initialize/list/call/revoke; chưa phải AIAgent/container/model/CRM end-to-end |
| 12/10/2026 | Đường kiểm runtime Linux | Thêm workflow Ubuntu 24.04 + Node 24.18.0, container ghim digest, fixture/model giả, không secret CRM. Chờ CI chạy; chỉ upload JSON receipt |
| 12/10/2026 | Gate P0/P1 | Local 47/47 đạt, 215 giây, tree `9740e5d899900caa67547c7a530c82df1fb5afc6`; còn 18 nghĩa vụ CI/live chưa kiểm local. Delta sau đó chỉ chuẩn hóa EOL lock mới và cập nhật tài liệu, gate tái dùng bằng chứng đúng đầu vào |
| 12/10/2026 | Checkpoint P0/P1 cuối | Commit `6ecdc399`, tree `e894e37e`; local 47/47 đạt, 110 giây, 46 receipts + Vitest related 1/1 file. Review xác minh receipts cùng snapshot; đã cập nhật draft PR #165 |
| 12/10/2026 | CI runtime lượt 1 | Run `38209692628` kéo được image ghim và tạo mạng nội bộ; FAIL ở fixture vì upstream khai VOLUME /opt/data sinh anonymous volume. Verifier chặn đúng, chưa chạy AIAgent. Image không có revision label nên chưa chứng minh digest tương ứng source commit |
| 12/10/2026 | Sửa mount runtime | Ba file sửa để override /opt/data bằng tmpfs chỉ đọc và kiểm map tmpfs chính xác, focused 18/18. Gate/push fix ở worktree riêng `hermes-runtime-ci-20261012` để giữ WIP P2; chờ CI mới |
| 12/10/2026 | Bắt đầu nền P2 | Target binding migration lane và crypto/refresh primitive đang code, chưa gọi DB/schema/apply. Chưa có store bền vững hoặc refresh thật |
| 12/10/2026 | CI runtime lượt 2 | Run `38210160244`, head `9691e3b9`: mount đã đạt; AIAgent FAIL do progressive tool search mặc định thay tool CRM bằng bridge. Giữ receipt lỗi, không nới tool allowlist |
| 12/10/2026 | CI runtime lượt 3 | Run `38210992537`, head `005e0d26`: tắt tool_search cho spike, 12/12 checks đạt với AIAgent thật, model/broker giả, inputsUnchanged=true. Digest image khớp; revision label trống nên source provenance chưa xác minh |
| 12/10/2026 | Primitive credential P2 | Crypto/refresh 25/25; review độc lập không còn P1/P2 trong phạm vi module. AES-GCM binding và fence/CAS/lease đã kiểm với store/provider giả; chưa durable storage hoặc refresh thật |
| 12/10/2026 | Model relay P2 | 15/15, review đóng lỗi HTTP200 chứa error/debug bằng response projection. Chỉ gọi proxy hiện có, không retry, request snapshot chống mutation. Chưa route/broker integration hoặc quota live |
| 12/10/2026 | Target lane P2.0 | 33/33 Node + 10/10 backup Node + 30/30 Vitest; review source không còn P1/P2. TEST credentials/evidence riêng, marker/lease, giữ khóa khi write chưa rõ; chưa backup/dry-run/apply TEST thật |
| 12/10/2026 | Gate checkpoint nền P2 | `8bfc0682`, tree `b8ee37ac`: local 47/47, 343 giây; Vitest related 25/25 file, còn 18 nghĩa vụ CI/live chưa kiểm local. Review crypto/relay/target/routing/docs đã khép trong phạm vi. Hai dòng tiến độ docs cũ được sửa ở checkpoint tiếp theo |
| 12/10/2026 | Delta mạng/profile | 23/23 focused, native transport 4/4; mạng riêng A/B và single-host profile lease đã viết, chưa có container CI cho delta. Review sửa race inspect trước container restart sẵn sàng; không coi local tests là runtime pass |
| 12/10/2026 | Gate và CI mạng/profile | `9ad5ca42`, tree `d5998263`: local 47/47, 102 giây; CI run `38212601959` đạt 17/17, 12/12 hash khớp. Peer listener bị chặn qua IPv4/Docker DNS hai chiều; duplicate/đổi chủ/revoke restart bị chặn. Chưa chứng minh mọi host/IPv6 egress |
| 12/10/2026 | Backend transport P2 | Provider refresh 19/19, private store transport 10/10, pool 5/5. Review đã đóng thiếu kiểm session_user, PGOPTIONS ambient và async observer rejection; chưa kết nối PostgreSQL/Auth thật hoặc dựng package triển khai broker |

## Bảng tiến độ

| Gói | Trạng thái | Còn thiếu để đóng |
| --- | --- | --- |
| P0 | Nội dung + focused + local gate đạt | CI/review snapshot cuối và tích hợp PR; không suy inventory thành runtime parity |
| P1 | Đang hiện thực | JWT/broker, MCP, AIAgent, mạng A/B và single-host profile owner với dữ liệu giả đã đạt; còn egress đầy đủ, provenance, refresh, model quota và context invalidation đầy đủ |
| P2 | Tích hợp hẹp TEST đạt 18/18 | Store/broker/cấp phiên độc lập đã kiểm. Còn refresh toàn tuyến, concurrency, vòng đời/HTTP/UI; chưa nghiệm thu khi P1 còn mở. |
| P3 | Đã chuẩn bị projection, chưa mở tool | Còn reader JWT và mapping scope đúng từng quyền; kiểm deny/field/cross-tenant toàn tuyến. Dữ liệu chưa được đưa vào Hermes. |
| P4 | Chưa bắt đầu | Người khác/nhóm/forward không giả danh chủ; không trả lời lặp; một account chỉ có một chủ session. |
| P5 | Chưa bắt đầu | Không tự duyệt; nội dung/đích đổi phải duyệt lại; không báo đã gửi khi chỉ enqueue; không retry mù. |
| P6 | Chưa bắt đầu | Một scheduler; không chạy đôi; dữ liệu mới; không mở rộng nhóm bằng grant cũ. |
| P7 | Chưa bắt đầu | Không lẫn user/org/private-group; thông tin hiện hành lấy CRM; UX xem rõ quyền và trạng thái. |
| P8 | Chưa bắt đầu | Không mất ngầm năng lực; không mở lại action đã gỡ/tắt; các miền nhạy cảm qua kiểm riêng. |
| P9 | Chưa bắt đầu | Giải thích được mọi tác vụ và chi phí; fail closed khi auth lỗi; tắt Hermes không phá queue/lịch độc lập. |
| P10 | Chưa bắt đầu | Các invariant bắt buộc đạt; không có lỗi quyền/side effect chưa xử lý; người dùng hoàn thành luồng không cần kỹ thuật. |
| P11 | Chưa bắt đầu | Không còn luồng mồ côi, job trùng, quota tách đôi hay hai nơi sửa nghiệp vụ; rollback đã diễn tập. |

## WIP phải giữ

- Checkout chính có `docs/doi-chieu/so-quy-686tcb.md` sửa sẵn và nhiều file untracked của việc khác; không đưa vào thay đổi này.
- Worktree mới báo diff `supabase/migrations/20260528000007_drop_beds_fix_rpcs.sql` ngay sau checkout (306 dòng thay; Git cảnh báo CRLF/LF). `git diff --ignore-space-at-eol --numstat` trả rỗng: chênh lệch EOL. Không sửa/restore/stage. Migration legacy immutable, nằm ngoài scope.

## Inventory và kiểm đã có

- Generator: `scripts/generate-hermes-crm-inventory.mjs`.
- Snapshot: [hermes-crm-inventory.generated.json](../../../tooling/hermes-crm-inventory.generated.json); có digest từng file nguồn. Dùng snapshot thay số đếm chép tay ở tài liệu lịch sử.
- Focused command: `node --test scripts/__tests__/generate-hermes-crm-inventory.test.mjs` — 28/28 đạt (agent inventory, 12/10/2026).
- `node scripts/generate-hermes-crm-inventory.mjs --check` — đạt cùng source đầu vào.
- Đã kiểm các mutation: parser mất nguồn, tool trùng, dạng khai báo lạ, permission drift, RPC thiếu và snapshot cũ. Không suy từ các test này rằng quyền runtime đã đúng.
- Snapshot v2 bao phủ scope/input-output/consent/channel/acceptance từng tool/action/capability/page/control. Input lấy từ khai báo schema; output/RPC source có provenance, phần server chưa đo vẫn ghi chưa đo. Không chứng nhận builtin từ thư viện PageAgent ngoài explicit override.
- Hai tool: `lap_ke_hoach` → `migrate_to_gateway`; `thuc_thi_buoc` → `retain_backend_executor`. Đây là disposition triển khai; P1/P3 chứng minh identity, P5 nối thực thi. Cả hai còn `superAdminOnly`; chưa thay quyền runtime hoặc gọi lại engine Copilot.
- Source adapter: `src/copilot/tools/planTools.ts`, `src/copilot/plan/planClient.ts`. Hook `src/copilot/useHangDoiSauDuyet.ts` chưa là queue server bền vững. UI inventory đã đọc createAgent/pageScope/safeControls/uiControlAvailability/safetyGuard và page contracts; DOM runtime chưa đo.
- TEST xác nhận `copilot_available_rooms_v1` cấp EXECUTE cho authenticated, không cấp anon/service_role. JWT fixture đã kiểm scope phòng A/B và membership; đây là control RPC trực tiếp, chưa là tool Hermes được mở.

## Bằng chứng P0.03 có thể tái tạo

Chạy trong worktree, output chỉ lưu cache cục bộ:

```powershell
node scripts/db-query.mjs --env test --file tooling/hermes-crm/catalog-test.sql --json > .cache/hermes-p0/catalog-complete-test.raw.json
node scripts/compare-hermes-crm-catalog.mjs tooling/hermes-crm-inventory.generated.json .cache/hermes-p0/catalog-complete-test.raw.json .cache/hermes-p0/catalog-comparison.json
```

- Thời điểm catalog: `2026-10-12T05:10:35.299091Z`; inventory SHA-256 `f1aa4fa257965ade2ca460fd302d130db4961bfa3585987dc968b83e1d2131b7`; catalog SHA-256 `f462eb8a4345dd14a626acdf89a5b1f2b330cf7f7d4a11be4a1ebbc329fa7c06` (JSON bỏ BOM).
- 135 tên gồm 134 hàm public và `app_private.copilot_plan_submit_voucher_v1`. Helper `maker_submit_v1` cố ý không là public RPC, không cấp EXECUTE cho authenticated/anon/service_role. Không tạo public wrapper để làm báo cáo xanh.
- Sáu dynamic callsite còn nguyên trong inventory: bốn wrapper forwarding và hai tên preview/execute từ catalog. Tên literal tại caller/catalog được thống kê riêng; chưa khẳng định quét mọi lời gọi runtime.
- Ledger có 372 dòng, max `20260727095000`; migration-policy đã đóng băng ledger legacy. Không suy các migration mới chưa deploy từ max này, không replay/backfill ledger.
- Snapshot chỉ quan sát tên/chữ ký/ACL/digest/registry/flags. Chưa chứng minh thân hàm khớp source, RLS với JWT thật, production config hoặc toàn bộ UI/runtime parity.

## Đường tiếp tục P1 sau P0

1. Ghim runtime Hermes, kiểm platform/MCP transport; không suy khả năng chạy từ Python có sẵn.
2. Spike loopback với dữ liệu giả: credential hạn chế → user/org/connection server; hai user thường và superadmin, expiry/revoke/forgery.
3. Kiểm profile/process/file isolation thật, không chỉ tạo hai thư mục; broker secrets ngoài vùng runtime.
4. Đọc DATA_ENVIRONMENTS và dùng guard/lock TEST trước kiểm JWT/RPC thật; thử một tool đọc, không cần model trả phí hay gửi Zalo.
5. `npm run test-env:check` có tạo fixture JWT và chạy Chrome, `--sync` thay TEST; không gọi là preflight chỉ đọc. Helper credential có thể tạo seed vào vault. Chỉ nạp key cần dùng qua lane hiện có, không in/sao chép secret.
6. Ghi ADR và evidence offline/TEST riêng; không dùng giả lập thay JWT/RLS thật.

## Bằng chứng P1 đã có

- JWT receipt cuối: `.cache/hermes-broker-authz.34c60b80-1c82-4920-a9f4-b5b52d69ce8f.json`, lúc `2026-10-12T05:31:27Z`: 17 PASS, cleanup xác minh, inputsUnchanged=true. Harness SHA-256 `169355df224885e46906d4897cf229d057dde69a1d2c5e8b4a974795743c3e9f`; broker `4f2bd4da4dd33f237a8fa7f901a3f4e92b2df39840f9462c94a299882d623c31`.
- Kiểm user A/B, superadmin theo từng org, actor/org giả, membership revoke/expiry, role/superadmin downgrade, read restriction và connection revoke/expiry. Reconnect giữ assistant trong cùng memory store; chưa chứng minh lưu bền qua restart.
- Broker chỉ xuất `crm_auth_context`. Token opaque không là Supabase JWT; raw phiên user ở broker. Không có arbitrary RPC, service-role hoặc chức năng ghi/gửi trong transport.
- Receipt MCP cuối sau chuẩn hóa EOL lock: `.cache/hermes-p1/transport-1791783946200-1eea8c/receipt.json`, `PASSED_TRANSPORT_COMPATIBILITY_ONLY`, 4/4 checks; runtime focused 17/17. Kiểm đúng mã deny cùng HTTP do fixture quan sát, hash đầu/cuối khớp; lỗi backend không được tính thành policy deny đạt.
- Gate P0/P1 cuối lưu ở `.cache/hermes-p1/gate-final-passed/`, tree `e894e37e6fef3d2769f6070c4cf9473b7f5458b0`. Có 46 receipts và Vitest related 1/1 file; không coi đó là 18 nghĩa vụ CI/live đã đạt. Lượt trước giữ ở `gate-code-passed/`, không đổi nhãn.
- Docker local: `.cache/hermes-p1/hermes-p1-1791782870130-8575bb/receipt.json` ghi BLOCKED khi daemon timeout. Chưa pull/run container. Không sửa/reset Windows để thay bằng chứng này.
- Container receipt: `.cache/hermes-p1/ci-38210992537/hermes-p1-1791785241203-4c40eb/receipt.json`, status `PASSED_SYNTHETIC_RUNTIME_PROVENANCE_UNVERIFIED`, 12/12 checks; [CI đúng head 005e0d26](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/38210992537). Kiểm A/B MCP/model turns, mount/tool allowlist, memory/session/token, restart riêng và revoke trước model. Không dùng kết quả này chứng minh live CRM/model/Zalo.
- Receipt 12 checks trên dùng bridge chung, nên không chứng minh chặn peer. Delta sau đó có receipt `.cache/hermes-p1/ci-38212601959/hermes-runtime-receipts-1/hermes-p1-1791786459120-7f9436/receipt.json`: [CI head 9ad5ca42](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/38212601959), 17/17, 12/12 hash khớp, `PASSED_SYNTHETIC_RUNTIME_PROVENANCE_UNVERIFIED`. Hai mạng riêng và single-host owner đã được đo; chưa chứng minh mọi host/IPv6 egress, native CRM-memory purge/regrant, distributed supervisor hoặc quota provider.

## Nền P2 đã viết, chưa nối sản phẩm

- `infra/hermes-broker/session-crypto.mjs`, `refresh-manager.mjs`: mã hóa và điều phối refresh với adapter store/provider được inject. Durable backend dùng fence/CAS; kết quả commit không rõ không được coi là đã thu hồi toàn hệ. Bảng và adapter lưu bền đang được kiểm TEST ở checkpoint bên dưới, chưa nối sản phẩm.
- `infra/hermes-broker/model-relay.mjs`: transport nội bộ dùng `llm-proxy`, server cung cấp user JWT/org/request ID; allowlist model mặc định rỗng. Response chỉ project trường hợp lệ. Proxy hiện tại chưa được chứng minh hard concurrent budget hoặc settlement đúng một lần; không gọi relay test là bằng chứng ngân sách.
- `supabase-refresh-provider.mjs` dùng endpoint Auth cố định, xác minh qua adapter hiện có với byte/deadline cap; không retry provider. `store-transport.mjs` chỉ gọi 11 hàm private đã định danh và kiểm cả login/session principal; write ACK mất trả unknown, không retry ngầm. `store-pool.mjs` bắt TLS verification, role/project binding, giới hạn kết nối/statement và không nhận PGOPTIONS môi trường. Các adapter chưa nối vào broker hoặc DB thật.
- Hai forward migration identity/policy và encrypted store đang đi qua lane TEST; trạng thái mới nhất và biên nhận nằm ở checkpoint bên dưới. Refresh đã chuyển sang STAGED → publish với đối soát cùng claim; checkpoint 25/25 cũ không chứng nhận giao thức mới này. DB mất liên lạc thì caller/jobs phải dừng; chưa có quy trình đối soát tự phục hồi sau crash.
- `scripts/lib/migration-target.mjs` và bốn runner migration/backup/catalog/provenance: `--env test --expected-project-ref <TEST_REF>` ràng buộc cùng đích. Evidence TEST ở `.cache/migration-targets/test/<ref>/`, không thay production inventory/provenance. Không đổi `.temp/project-ref` hoặc alias TEST credential vào tên production.
- Gate nền P2 lưu tại worktree kiểm riêng `C:/Users/Nguyen Tam/codex-worktrees/hermes-runtime-ci-20261012/.cache/hermes-p2/gate-foundation-passed/`; primary đã fast-forward giữ WIP của các phần tiếp theo. Hai repository inventory được generator cập nhật theo bốn test mới, không sửa tay.
- Node backup test phải chạy bằng `node --test`; một lần chọn nhầm Vitest báo no-suite đã được chạy lại đúng runner. Không có DB thật bị thay đổi trong checkpoint code này.

```mermaid
flowchart LR
  A[Đã có: inventory và quyền nền CRM] --> B[Đã kiểm: JWT và Hermes với dữ liệu giả]
  B --> C[Đang làm: cách ly hoàn chỉnh và phiên lưu bền]
  C --> D[Tiếp theo: quyền Đọc / Thao tác và dữ liệu phòng]
  D --> E[Zalo điều khiển, duyệt gửi và lịch]
  E --> F[Memory tổng, mở rộng miền và nghiệm thu]
```

## Việc tiếp theo

Checkpoint đang làm ngày 12/10/2026 (chưa tích hợp hoặc phát hành sản phẩm):

- Auth refresh thật trên TEST đạt **5/5**, receipt `.cache/hermes-refresh-auth.14b27434-2cb9-4538-ad6b-5ecbc326c490.json` lúc `2026-10-12T06:54:19.380Z`. Một user tổng hợp có hai phiên độc lập; refresh Hermes rồi refresh trình duyệt đều giữ đúng user/session. Token lỗi bị từ chối; users/profiles/sessions thử đã dọn sạch. Tám hash nguồn đầu/cuối khớp. Không dùng tài khoản sao chép, không thử UI, durable store hoặc Auth production.
- Harness `scripts/test-hermes-refresh-auth.mjs` có **9/9** kiểm tra offline và review delta sạch. Đã sửa race timeout: theo dõi toàn bộ POST, chờ kết thúc trước cleanup; không xác định được kết quả thì giữ khóa TEST. Receipt chỉ xác nhận kết quả đã đo.
- `store-transport` có **12/12** kiểm tra: SQL ERROR từ chối chắc chắn không bị coi là mất ACK để thử lại; FATAL, lỗi mạng và completion-unknown vẫn đóng quyền. Provider **19/19**, pool **5/5** đã kiểm/review; chưa nối broker sản phẩm.
- Giao thức refresh mới có **49/49** kiểm tra (manager 37 + adapter 12), root review delta và đối chiếu producer SQL. STAGED chưa cho đọc; publish/reconcile cùng claim, giữ nguyên ciphertext, không gọi provider lần hai. Chỉ quarantine có ACK mới báo reconnect xác định; còn lại trả unknown và dừng caller. ACTIVE mới đã commit là quyết định của DB, cần kiểm quyền mới trước đọc; không coi mất ACK là thu hồi toàn hệ. Chưa có chứng minh DB/concurrency/crash hoặc quy trình phục hồi tự động.
- Hai migration mới đã review độc lập, static **23/23**, apply đúng TEST qua forward lane có hai lượt preflight ROLLBACK, backup full và catalog trước/sau. Identity/policy `20261012061447`: digest `ae88a8523c00c4b92deb659ea9cb9a06edfe40ca10f2f3160a90865b820f64a4`, backup 621 bảng có dữ liệu, log `.cache/hermes-p2-identity-apply-test.txt`. Encrypted store `20261012062043`: digest `1d5708a6a4a3d319719b7dd78aa81bc0a9db75a66914d4f047a1ec2137f5bbfd`, backup 627 bảng có dữ liệu, log `.cache/hermes-p2-store-apply-test.txt`. Hai evidence nằm tại cache TEST `schema-change-evidence/`, không ghi schema production. Provenance TEST sau apply nhận đúng hai biên nhận; ledger legacy giữ nguyên.
- Catalog/provenance TEST đã lưu riêng trong `.cache/migration-targets/test/hzulujxgonszuleqticb/`. Catalog hiện đếm bảng public và hàm public/app_private; chưa dùng nó để chứng minh đầy đủ bảng/ACL private mới. `measure-org-leak --env test --expected-project-ref hzulujxgonszuleqticb --write` đã đạt (log `.cache/hermes-p2-org-leak-test.txt`); kiểm bằng role/claims trong transaction, không phải đăng nhập JWT thật. Harness durable store đã có 14/14 kiểm offline và review; chưa chạy DB.
- Gate checkpoint transport lần đầu **11/13**, lần kế **12/13** đều chưa đạt; chẩn đoán docs 13/13, Node 570/570 và 17 file app từng lỗi **346/346** đạt khi giảm số worker. Runner giữ nguyên selection/timeout nhưng giới hạn tối đa hai worker. Gate cuối `.cache/gate-backend-bounded.txt` **47/47** đạt, 96 giây, tree `249e63db2ddad634a3f3f894e89395628630a8ca`; review độc lập không có P1/P2 mới, đã commit/push `494d306a12c4e9bba440eb31c113007206849d14` vào draft PR #165. Tập app-unit vẫn đủ 1119 file nhưng mode all được giao CI theo luật hiện có; local related không chứng minh toàn bộ suite đã đạt. CI đúng head còn đang chạy.
- [CI checkpoint `494d306a`](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/38216879225) đã SUCCESS: app-unit **1119/1119 file, 14029 ca PASS, 1 ca Windows-only không chạy trên Linux** (`with-cred.test.mjs`). Quality/strict/timezone/secret jobs đạt; security/cross-tenant/generated-types và các job bị skip không được tính là đã kiểm. Log app-unit lưu `.cache/hermes-ci-494d306a-vitest.txt`. Kết quả này không chứng minh WIP broker/SQL/harness sau checkpoint.
- Resolver `durable-authority` có 16/16 kiểm offline, review độc lập không có P1/P2 mới: xác minh phiên, đối chiếu membership/version, đọc lại store và kiểm quyền trước/sau. `assistantScopeIds` là ID scope chính sách; `scopesByPermission` là ID tòa/sổ CRM theo từng quyền. Hai miền ID chưa được ánh xạ để mở business tools. Adapter Auth mở rộng có 11/11 kiểm offline và root review; chưa có JWT/RPC thật cho đường mới. Đang nối authority vào dispatcher broker hiện có; khi broker đổi hash, receipt JWT 17/17 cũ chỉ còn bằng chứng lịch sử, phải kiểm delta.
- Delta broker/authority đã nối, **55/55** kiểm tập trung đạt (gồm 28 ca tương thích P1), review độc lập không có P1/P2 mới. JWT TEST kiểm lại với broker hash `d46ec4c56291802316f302d98f945e290e53dfb9db18ad7b82f17aa733028834`: **17/17**, cleanup xác minh, inputsUnchanged=true, receipt `.cache/hermes-broker-authz.f8158417-026a-4850-b521-a6a16fd030b4.json` lúc `2026-10-12T07:28:37.408Z`. Đây là đường P1 còn tương thích, chưa thay bằng chứng durable integration.
- Baseline SQL harness đầu tiên dừng trước fixture do thiếu CA cho TLS pooler: receipt `.cache/hermes-durable-store.de71e186-33cd-4d7e-b642-637d73e42fb0.json`, không đạt. Đối soát chỉ đọc xác nhận active_run/role/user thử đều 0; không xóa marker thủ công. CA chính thức đã được đối chiếu nguồn Supabase và kiểm kết nối đọc với certificate verification bật; đang bổ sung CA vào harness trước chạy lại. Backup full TEST sau hai migration đã có, manifest tại thư mục backup ngoài repo; không commit dump/credential.

1. Gate/review checkpoint code nền P2, push draft và đọc CI đúng head; giữ receipt cũ nếu đầu vào không đổi. CI xanh của head cũ không chứng minh WIP mới.
2. Giữ JWT receipt cuối khi đầu vào không đổi; không chạy lại TEST chỉ để đếm thêm pass. Chưa bật business tools hoặc gửi Zalo.
3. Giữ runtime receipt 17/17 khi hash nguồn còn khớp; tiếp tục invalidation/regrant và egress còn thiếu. Fixture model/MCP không được báo thành CRM/model trả phí đã tích hợp.
4. Chốt ADR auth/network/quota dựa bằng chứng P1, giữ P1 checkbox mở nếu refresh/context invalidation hoặc isolation chưa đạt.

Lưu ý kiểm CI: `npm run ci:wait -- --sha <sha>` chỉ kết luận cho push/workflow_dispatch trên main, không tính run pull_request. Với draft PR dùng `gh pr checks 165 --watch` để đọc checks của PR, không dispatch/rerun main; kết quả PR vẫn chưa phải evidence promote production. `ci:wait` yêu cầu GH_TOKEN trong env; chỉ nạp khóa cần thiết bằng helper vault hiện có, không in token.

## Bàn giao session / agent

Đọc PLAN.md để biết quyết định đã duyệt, rồi STATUS.md để tiếp tục đúng điểm. Không tái tạo plan từ PDF/HTML v1.0 hoặc chạy lại script xuất plan cũ. Cập nhật checkbox trong PLAN và ghi việc thực hiện, kiểm chứng, giới hạn, commit/PR ở STATUS sau mỗi phần.

Evidence local nằm ở `.cache/gate-receipts/` (plan và receipt theo gate) và `.cache/hermes-p0/` trong worktree này. Đây là cache chưa commit; không giả định có khi clone sang máy khác. `focused-summary.json` là bản tổng hợp do agent ghi, không phải receipt gốc của runner. Lượt gate đầu: snapshot tree `ae8744095db7fb65d834aa869b10a2d5cc189047`, kết quả 46/47, lưu tại `.cache/hermes-p0/gate-first-failed/`; snapshot mới phải được kiểm theo Contract.

Lượt code đạt: `.cache/hermes-p0/gate-code-passed/`, tree `a05a740f2fc2819f679bbc0795e468567380106b`, base/head khi chạy là `7367b7007f096f20471bf1309bc51e0b971439b6`. Commit code trên có đúng tree này; không đổi nhãn receipt thành CI hoặc runtime evidence. Tài liệu checkpoint cập nhật sau commit code được kiểm theo phạm vi docs riêng.

Checkpoint P0 cũ `c833d379` có 10 nghĩa vụ chưa kiểm local; không dùng số này cho checkpoint P1. Snapshot P1 mới có 18 nghĩa vụ CI/live như plan receipt; JWT TEST có bằng chứng riêng ở trên. UI/E2E và gửi Zalo thật chưa kiểm.

Không `npm install`/`npm ci` qua node_modules junction hiện tại. Không stage toàn bộ worktree: migration EOL và cache nằm ngoài thay đổi. Khi chuyển worktree/máy, lấy đúng branch/commit đã ghi và cài dependency riêng nếu cần.

Prompt tiếp tục gợi ý: “Đọc docs/plans/hermes-crm/PLAN.md và STATUS.md trên nhánh codex/hermes-crm-foundation-20261012. Giữ WIP, kiểm gate/review delta P0/P1 và CI runtime. Tái dùng JWT receipt còn khớp nguồn; hoàn tất P1 rồi triển khai P2. Mục tiêu vẫn là toàn bộ P0–P11; cập nhật hai file sau mỗi phần.”

## Quy tắc evidence

Source tĩnh không chứng minh runtime; local/TEST không chứng minh production. JWT/RPC và MCP đã có bằng chứng hẹp như trên; chưa có OAuth sản phẩm, cách ly runtime đầy đủ, model usage hoặc gửi Zalo của Hermes. Không mở ghi/gửi dựa trên tài liệu này.
