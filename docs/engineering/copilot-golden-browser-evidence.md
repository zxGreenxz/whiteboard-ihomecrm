# Golden real-model: bằng chứng trình duyệt

Lane real-model cũ chỉ hỏi model chọn tool rồi suy các trường còn lại từ câu hỏi.
Artifact đó là lịch sử định tuyến, không chứng minh hành vi CRM và bị verifier v2 từ chối.
Lane mock vẫn là phép kiểm định tuyến riêng.

## Trạng thái triển khai

`tooling/copilot-golden-scenarios.json` giữ đủ mọi ID của corpus, fixture, prompt và
điều kiện oracle. `executorStatus` phân biệt phần đã viết với phần chưa viết; chưa
có oracle luôn thành `blocked: oracle_not_implemented`. Hiện C01 và C13 có executor
phòng trống thực; C02–C12 và C14–C75 còn thiếu executor/oracle. Đây là phần triển khai
chưa hoàn tất, không phải chỉ thiếu credential. Hai executor hiện có chưa được chạy
với model thật sau thay đổi này.

C13 phân giải duy nhất tên `DEMO Toà A` từ RPC mà actor thực được nhìn thấy, không
dùng ID lịch sử. Oracle so mã phòng và trạng thái rỗng với payload RPC, kiểm tool
result có sang vòng model sau và câu trả lời cuối thực sự render. Thiếu hoặc trùng
fixture thì blocked trước khi hỏi model. Không có write nghiệp vụ được phép.
C13 còn kiểm tham số `toa_nha` phân giải duy nhất về đúng ID tòa trong payload RPC
đầy đủ, danh tính tòa từ header tool result và tên tòa trong câu trả lời. Địa chỉ
dự phòng trong header do mapper sản phẩm sở hữu, oracle không dựng lại nó. Mã phòng
trùng giữa hai tòa không được dùng làm bằng chứng thay cho danh tính tòa.

Các nhóm còn lại cần oracle số liệu riêng theo domain; tài liệu/điều hướng và UI
cần kiểm đích render/quyền; C64–C66 cần chuỗi memory + readback + phục hồi; C67–C75
cần fixture kế hoạch/L5, consent/PIN khi phù hợp, readback và cleanup canonical.
Manifest giữ C12 cho phép hướng dẫn hoặc điều hướng, C67/C68 cho phép kế hoạch an
toàn chưa duyệt, C69 cấm SQL, và ba ca injection PIN vẫn riêng biệt. Những khai báo
này chưa phải bộ thực thi. Không gửi PIN thật cho model.

## Chạy có chủ đích

Nạp các biến fleet từ kho credential theo Contract. Chọn model bằng
`COPILOT_E2E_MODEL`; không đổi model tự động khi provider lỗi. Cần
`FLEET_BASE_URL`, `EXPECTED_SOURCE_SHA`, `COPILOT_REVIEWED_EDGE_DIGEST` và
`COPILOT_DEPLOYED_EDGE_DIGEST`. Hai digest Edge do controller kiểm bằng source
đã review và deployment thực, không lấy nhãn provider thay cho phép kiểm đó.

```text
node scripts/generate-copilot-golden-real-results.mjs --attestation <file.json> --results-out <checkpoint.json>
node scripts/run-copilot-golden-eval.mjs --lane real-model --build-sha <sha> --provider-model <model> --results <checkpoint.json> --out <report.json>
```

Attestation gồm buildSha (40 hex), edgeSourceDigest và deployedEdgeSourceDigest
(64 hex giống nhau), providerModel, organizationId DEMO, corpusDigest,
manifestDigest, fixtureDigest, policyDigest, actorDigest (đều 64 hex), observedAt
(ISO), contextId (định danh context riêng). Hàm `digest()` trong module evidence
là SHA256 của JSON.stringify, không băm bytes/CRLF của file JSON.

fixtureDigest là payload `copilot_available_rooms_v1` trước lượt chat. policyDigest
là `{permissions, availability}` từ RPC cùng actor; bỏ fetched_at/fetchedAt của
availability trước khi băm. actorDigest băm subject JWT. Browser đọc lại và so
những dữ kiện này trước khi gọi model. Không ghi JWT hay payload vào checkpoint.

CLI không nhận `--limit`, credential flag hoặc `--raw-out`. Đường output đã tồn
tại bị từ chối. Checkpoint ghi atomic, lưu tiến độ và journal cleanup. Sau browser
restart chưa có quy tắc chứng minh context/DB giống trước: không tự tái sử dụng
case pass hoặc phát lại case bị ngắt. `resumeRun()` chỉ kiểm được checkpoint chưa
chạy; resume thực thi trong context mới vẫn chưa triển khai. Cần reconcile journal
trước khi tạo run mới; không tự xoá/ghi lại fixture để che mất lần chạy trước.

Thời gian đo từ gửi đến đáp án cuối qua toàn bộ vòng model/tool; humanWaitMs tách
riêng (hai ca đọc hiện tại bằng 0). Chỉ pass được tính vào quantile thành công;
fail/blocked có phân phối riêng. SLA vẫn pending-owner-approval với giá trị null.
Lỗi có cấu trúc trong SSE HTTP 200 cũng dừng các ca chưa gửi: mã quota thành
`quota_exhausted`, mã rate-limit thành `rate_exhausted`; chỉ giữ mã phân loại an
toàn, không giữ thông điệp lỗi upstream. Kiểm hồi quy bằng trình duyệt với server
local tổng hợp: `node --test .e2e-fleet/controlled/golden-provider-stop.test.mjs`.
Full report và job live luôn blocked cho tới khi đủ oracle và SLA được chủ duyệt;
không có miễn trừ như lane mock.

Workflow Copilot E2E có input `golden_attestation` để chạy on-demand. Checkpoint
được đưa vào thư mục artifact đã qua guard credential hiện có. Reporter golden
chỉ in trạng thái, không in lỗi/DOM/call-log; tắt trace/video/screenshot và dọn
artifact Playwright tạm. Checkpoint chỉ nhận danh sách trường an toàn. Nếu tiến
trình bị kill trước cleanup reporter, cần dọn thư mục tạm theo run; không upload
các thư mục tạm này.

## Canonical integration checks (2026-09-07)

The earlier ad-hoc TypeScript command used `--allowJs` without the fleet's
`strict` configuration and was insufficient. Canonical `npm run typecheck:e2e`
reproduced five errors (missing MJS declarations, implicit callback parameters,
and optional buildings losing narrowing inside a callback). The evidence module
now has a concrete `.d.mts` boundary; parsed manifest values are checked before
use, attestation comes from the validated run, and the building array is captured
after validation. Fleet strictness and stream acceptance are unchanged.

`npm run gate:test-matrix` first reproduced two missing Vitest exclusions. After
aligning native membership, it exposed the controlled browser test as an orphan;
the matrix now declares its existing `copilot-e2e.yml` Node/Chromium execution.
Final verification: canonical typecheck passed; matrix passed (537 files, 8 suites);
`npx vitest run src/copilot/__tests__/readonlySmokeOracle.test.ts` passed 47/47;
`node --test scripts/__tests__/copilot-golden-browser-evidence.test.mjs scripts/__tests__/copilot-golden-real-cli.test.mjs .e2e-fleet/controlled/golden-provider-stop.test.mjs`
passed 16/16, including two loopback browser provider-stop proofs. No live model
calls. Full 75-case implementation and SLA remain incomplete/blocked.
