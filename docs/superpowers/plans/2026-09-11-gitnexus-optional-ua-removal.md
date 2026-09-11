# Kế hoạch tối ưu GitNexus, bỏ UA và đồng bộ hướng dẫn agent/CI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Các bước dùng checkbox để theo dõi. Các bước 1–5 đã triển khai và kiểm chứng local; phát hành cần CI và deployment đúng SHA ở mục 5. Số đo thực tế ở docs/audits/GITNEXUS-OPTIONAL-2026-09-11.md.

**Goal:** Bỏ Understand Anything khỏi repo và luồng agent/CI; giữ GitNexus dưới dạng CLI tùy chọn, hữu ích cho quan hệ mã nguồn, không tạo vòng cập nhật hoặc hướng dẫn trùng lặp.

**Architecture:** Source, Git diff và contract/harness hiện có là đường làm việc mặc định. GitNexus chỉ chạy khi câu hỏi cần quan hệ giữa nhiều file; wrapper ghim phiên bản kiểm đúng nguồn tại lúc truy vấn. Project Contract sở hữu luật chung; adapter AI chỉ giữ phần riêng của client.

**Tech Stack:** Node.js theo runtime-matrix, Git, GitNexus 1.6.9, node:test, Vitest, GitHub Actions; không thêm dịch vụ, scheduler hoặc cơ sở dữ liệu thay thế UA.

## 1. Căn cứ và quyết định

### Đã kiểm chứng ngày 11/09/2026

- Checkout được rà: `5a836b0146f15558a2f2abee530c4c304f3b81bc`. AGENTS/CLAUDE/AI_RULES/Contract hiện lần lượt 20/16/3/231 dòng. Gate agent-contract và 19 test hiện đạt, nhưng vẫn cưỡng chế chính sách graph cũ.
- `.ua/` có 5 file tracked, khoảng 9,86 MiB. CI mới nhất vẫn báo UA cũ 444 commit và GitNexus MISSING; đây là cảnh báo lặp, không phải lỗi ứng dụng.
- Index GitNexus ở checkout chính khoảng 476,81 MiB, embeddings = 0. Một số worktree khác có index mới hơn; không suy index main cũ thành mọi phiên đều không dùng GitNexus.
- Registry có 36 mục cùng tên repo; kết quả liệt kê đầy đủ khoảng 300.831 ký tự vì lặp các worktree. CLI phải chỉ đúng đường dẫn, không tìm repo bằng danh sách này.
- Cấu hình `--skills` hiện bị GitNexus OR vào `force`: bỏ qua thoát sớm khi không đổi và incremental DB writeback. Parse cache vẫn hoạt động. Thêm `--index-only` mà không bỏ `--skills` không chữa được vấn đề này.
- Hai bước dựng graph trên Linux CI đo được 84 và 87 giây. Khi chốt thiết kế chưa có benchmark Windows; số đo local sau triển khai nằm trong báo cáo audit, không cam kết cập nhật luôn xong trong hai phút.
- Mẫu bốn câu hỏi: graph đúng các quan hệ TS được đối chiếu; truy tìm RPC string sang SQL cần tìm nguồn trực tiếp. Có câu graph ngắn hơn source, có câu dài hơn. Chưa đo token tính phí hoặc chi phí hoàn thành toàn task.
- Rà 30 run: 22 success, 4 failure cũ đã có bằng chứng tiếp nối xanh, 3 cancelled, 1 skipped. Main và production cùng SHA trên đều xanh. Không phát hiện lỗi đang hoạt động trong mẫu này.
- Tại lúc kiểm tra, cả main/production không được branch protection bảo vệ; rulesets gồm kế thừa trả rỗng. Promotion kiểm workflow CI theo path, không ghim tên hai job graph. Đây là snapshot, phải kiểm lại trước đổi job.

Bằng chứng CI: [main](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34551631794), [production](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34552070568), [index 84 giây](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34509989310), [index 87 giây](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34507388279).

### Quyết định triển khai

| Hạng mục | Hành vi sau sửa |
|---|---|
| Understand Anything | Bỏ artifact, pin, gate, workflow và luật bắt buộc khỏi repo. Không gỡ plugin cá nhân toàn máy. |
| GitNexus | CLI gọi khi cần; bỏ MCP theo dự án và các skill local đang ép graph-first. |
| Thời điểm dùng | Hữu ích cho callers/callees/trace/refactor nhiều file. Sửa file đã biết, tài liệu, CI, SQL/RLS dùng source trước. |
| Cập nhật | Không dựng ở đầu mọi task hoặc sau mỗi lần lưu. Agent được tự thử một lần khi thực sự cần graph mà index chưa dùng được. |
| Ngân sách tự dựng | Tối đa 120 giây cho một lần thử, tính cả khởi động công cụ. Đây là trần chờ, không phải cam kết hoàn tất. Hết giờ/lỗi thì chuyển source; không thử lại trong cùng task. |
| Cập nhật thêm | Chỉ khi người dùng yêu cầu rõ. Lệnh analyze cho phép timeout tối đa 900 giây cho lần chạy chủ động hoặc benchmark. |
| Sau khi code đổi | Không dùng graph cũ như graph hiện hành. Mặc định kiểm Git diff/source/test; không bắt dựng lại để kết thúc task. |
| `detect-changes` | Gỡ alias và luật bắt buộc; dùng Git diff và kiểm phụ thuộc trực tiếp sau sửa. Tránh duy trì ngoại lệ graph cũ cho một lệnh riêng. |
| CI/production | Không cài hoặc dựng GitNexus, không yêu cầu UA/index để xanh. Giữ các gate bảo vệ sản phẩm và phát hành. |

**Giới hạn chung:** Giữ WIP hiện có; chỉ stage file cụ thể. Không đổi API ứng dụng, database, migration lịch sử, runtime hoặc hạ gate tiền/phân quyền để dọn graph. Không tự bật embeddings/LLM/wiki. Không tạo một lớp chỉ mục mới để bù UA. Không biến kế hoạch này thành tài liệu bắt đọc mỗi task.

## 2. Hợp đồng CLI và hướng dẫn sau sửa

### Giao diện CLI

Giữ `graph:analyze`, `graph:status`, `graph:impact`; thêm `graph:query`, `graph:context`, `graph:trace`. Các alias đều gọi `scripts/run-pinned-gitnexus.mjs`. Gỡ `graph:detect-changes` và ba alias `gate:graph-*` sau khi tháo hết caller/test.

```text
npm run graph:query -- "contract creation"
npm run graph:context -- buildCreateContractRpcArgs --file src/lib/contractCreateRpc.ts
npm run graph:impact -- buildCreateContractRpcArgs --file src/lib/contractCreateRpc.ts
npm run graph:trace -- createContractV2 normalizeDateOnly
npm run graph:status
npm run graph:analyze
npm run graph:analyze -- --timeout-ms 900000   # chạy chủ động, không phải mặc định agent
```

- Wrapper hỗ trợ `help`, `smoke`, `status`, `analyze`, `query`, `context`, `impact`, `trace`; từ chối subcommand khác. Bỏ MCP/server/wiki/augment/cypher và chuyển tiếp tùy ý khỏi giao diện dự án.
- `query`: mặc định limit 5; `context`: limit 20; `impact`: depth 2, limit 20; `trace`: depth 6. Không thêm `--content` mặc định. Agent tăng phạm vi khi kết quả cụ thể đòi hỏi; kết quả giới hạn không chứng minh ngoài phạm vi không có ảnh hưởng. Validate limit/depth là số nguyên dương; không để giá trị sai trở thành unlimited như cách upstream hiện xử lý.
- `status` chỉ báo trạng thái index, không cài hoặc dựng. Query tự kiểm khả dụng; hướng dẫn không bắt gọi status rồi freshness rồi query cho cùng câu hỏi.
- Mã thoát: `0` lệnh hoàn thành; `2` index/công cụ chưa dùng được hoặc query lỗi, cần source fallback; `64` đối số sai. Phân biệt lỗi với kết quả hợp lệ không tìm thấy symbol. Không trả `{ impactedCount: 0 }` cho lỗi.
- Query giới hạn 30 giây. Dùng giới hạn native để giảm output; không cắt chuỗi JSON giữa chừng. Ghi rõ limit/depth đã áp dụng kể cả native không có cờ truncated; không bịa tổng số phần bị bỏ. Log wrapper ở stderr, kết quả JSON ở stdout. Lỗi JSON/native, kể cả process exit 0 nhưng payload có lỗi, phải thành unavailable; không diễn giải thành kết quả đầy đủ.
- Query không tự cài, reindex hoặc retry. Chỉ `analyze`/`smoke` được giải quyết lần cài pin khi cần. Đường query chỉ dùng pin đã có trong cache/cài đặt local, không truy cập registry để lấy bản mới.
- `--timeout-ms` là cờ của wrapper, không chuyển sang upstream; số nguyên trong khoảng 1.000–900.000. Mặc định analyze 120.000; query không nhận cờ tăng trần.

### Nội dung đích cho Contract §12

```markdown
## 12. Tra cứu mã nguồn và GitNexus

Source, Git diff và contract/harness là căn cứ khi sửa code. GitNexus là CLI tùy chọn
để tìm callers/callees và luồng qua nhiều file; không chứng minh SQL/RLS hoặc production.
Không dùng Understand Anything trong luồng agent/CI của repo.

- Tra file/symbol đã biết bằng `rg`; đọc source quanh kết quả trước khi sửa.
- Khi cần quan hệ liên file, dùng `graph:query`, `graph:context`, `graph:impact` hoặc
  `graph:trace` trong package.json. Wrapper tự kiểm index; không cần gate freshness riêng.
- Chỉ gọi `graph:analyze` nếu câu hỏi thực sự cần graph và index chưa dùng được.
  Mỗi task tối đa một lần tự dựng với timeout mặc định; lỗi/hết giờ thì dùng source.
  Không tự dựng sau mỗi lần sửa, trước commit hoặc chỉ vì task thuộc nhóm high-risk.
- Sau khi code đổi, graph là bản chụp cũ; kiểm Git diff, imports/callers và test liên quan.
  RPC/Edge/realtime, SQL, quyền và tiền luôn đối chiếu manifest/source/harness hiện có.
- Dùng wrapper ghim ở `scripts/run-pinned-gitnexus.mjs`; cấu hình trong
  `tooling/agent-tools.json`. Không commit index hoặc để tool sinh lại hướng dẫn agent.
```

Adapter AGENTS/CLAUDE chỉ liên kết §12; không chép bảng lệnh, timeout hoặc quy trình graph. AI_RULES tiếp tục là con trỏ §14. Giữ các giới hạn độ dài hiện có; không thêm một file luật Cursor/skill khác chỉ để lặp lại Contract.

## 3. Các bước triển khai

### Task 1 — Chốt baseline và đo chi phí thực

**Nơi làm:** worktree riêng `codex/gitnexus-optional-ua-removal` từ origin/main mới nhất. Không benchmark/index hoặc sửa tracked code của đợt này trong checkout có WIP. Bước 5 riêng biệt được dọn chọn lọc cấu hình client tại checkout chính sau khi đối chiếu từng file, sao lưu phần sửa tay và giữ WIP khác.

- [x] Fetch, ghi SHA và `git status`; kiểm lại required checks/rulesets, PR mở trên hai nhánh org/backup trước khi xoá job chuyên biệt. Không đổi cấu hình bảo vệ remote trong task này.
- [x] Lấy baseline cấu hình cũ trên worktree thử; sau bước 2 chạy lại cấu hình mới trên worktree thử thứ hai từ cùng SHA nguồn. Dùng cùng runtime và npm cache đã cài pin. Không copy index từ worktree khác rồi tuyên bố index đúng đích. Bước 1 mở việc đo; hoàn tất so sánh sau bước 2 trước tích hợp.
- [x] Mỗi cấu hình đo một lần chưa có index và hai lần source không đổi. Với cấu hình mới, đo thêm hai lần thay đổi nhỏ trong TS rồi cập nhật. Thay đổi chỉ ở fixture/worktree thử, không production.
- [x] Tách thời gian cài công cụ khỏi dựng index; ghi thời gian toàn lệnh, kích thước index, số file/node/edge, embeddings, file hướng dẫn bị sinh/sửa. Đo query và kiểm độ mới riêng. Không lấy dung lượng skill trên đĩa làm token bị nạp mỗi lượt.
- [x] Lặp bốn câu hỏi đã đối chiếu: callers của `calculateContractDepositBalance`; helpers của `buildCreateContractRpcArgs`; trace `createContractV2` đến `normalizeDateOnly`; RPC `append_income_expense_supplement_v1` đến migration/ACL. So đúng nguồn cùng SHA, thời gian và độ dài output với `rg`/đọc source.
- [x] Nếu sau tối ưu local chưa dựng xong trong 120 giây, giữ source fallback; không âm thầm nới timeout tự động. Ghi số đo trong bằng chứng bàn giao/PR, không thêm benchmark bắt buộc vào mỗi lần CI.

**Đầu ra:** baseline tái kiểm được và kết quả so sánh. Không có mục tiêu tiết kiệm token theo phần trăm khi chưa đo bằng tokenizer/usage thực của model.

### Task 2 — Làm wrapper GitNexus nhỏ và đúng

**Files:** sửa `scripts/run-pinned-gitnexus.mjs`, `tooling/agent-tools.json`, `package.json`; thêm `scripts/lib/gitnexus-state.mjs`, `scripts/__tests__/run-pinned-gitnexus.test.mjs`; thêm `.gitnexusignore`.

**Phân trách nhiệm:** wrapper xử lý đối số/chạy process/kết quả; module state chỉ đo snapshot và kiểm index, không query graph hay quyết định risk. Test dùng fixture Git và process giả; có một lượt smoke thật trên pin ngoài CI thường ngày.

- [x] Sửa cấu hình analyze thành `['--index-only', '--skip-agents-md', '--worker-timeout', '60']`. Giữ pin 1.6.9, bỏ toàn bộ phần Understand Anything và văn kể lịch sử trong agent-tools. Không bật embeddings/PDG.
- [x] Wrapper luôn ép index-only, từ chối cờ sinh skills hoặc đổi scope analyze trái hợp đồng. Chỉ ép force một lần khi thiếu provenance tương thích hoặc đổi schema snapshot/pin/scope/config; không đóng dấu mới lên DB cũ qua nhánh already-up-to-date. Delta source bình thường vẫn dùng incremental; không chèn force vào mọi analyze. Help/version không chạy nhánh ghi manifest.
- [x] Chạy subprocess bằng argv, không nối query/path thành chuỗi shell. Query chạy trực tiếp `process.execPath` + đường dẫn tuyệt đối tới `gitnexus/dist/cli/index.js` của pin đã cài, với `shell:false`; không chuyển query qua npm exec/npx vì npm có thể mở shell cho bin. Node + npm CLI chỉ phục vụ lấy pin ở analyze/smoke. Phân giải bản cài một lần, kiểm package.json thực tế và lưu locator local; nếu locator mất/sai version thì unavailable, không quét hoặc cài lại ở từng query. Kiểm cả gọi qua npm script lẫn node trực tiếp, dấu cách và ký tự shell.
- [x] Cố định realpath của repo/worktree chứa wrapper. Từ chối `--repo`, `-r`, `--repo=`, `--branch` hoặc positional path làm đổi đích. Đăng ký analyze bằng alias xác định từ hash realpath; query vẫn dùng absolute repo path. Không list toàn registry hoặc xoá registry của worktree khác.
- [x] `.gitnexusignore` loại `.ua/`, `.agents/`, `.claude/`, `.codex/` và artifact graph khỏi scope graph; không loại source runtime, RPC, config hoặc migration chỉ để giảm thời gian. Bản pin hỗ trợ `.gitnexusignore`; file này hiện chưa có trong repo.
- [x] Kiểm cấu hình hiệu lực từ CLI, `.gitnexusrc` và env: từ chối bật embeddings/PDG, bỏ gitignore hoặc đổi scope/kích thước ngoài hợp đồng. Scanner và analyzer phải dùng cùng options/env đã chuẩn hóa; không chỉ kiểm analyzeArgs. Không ghi giá trị credential vào config digest/log.
- [x] Đo snapshot theo scope của pin: dùng lại `createIgnoreFilter`, glob `**/*` với `dot:false`/`nodir:true` và giới hạn kích thước đã resolve của đúng bản cài; adapter tự stat/read/hash nghiêm ngặt. Không gọi thẳng `walkRepositoryPaths` rồi tin nó đầy đủ: hàm này hiện nuốt stat reject. Không viết lại bộ ignore riêng. Hash nội dung thật và path đã sắp xếp, bao gồm file mới chưa commit, đổi tên và xoá; theo dõi file vượt giới hạn để nhận ra khi nó đi vào scope. Lỗi đọc/stat, path thoát realpath repo hoặc thiếu export của pin là unavailable.
- [x] Config digest gồm wrapper/state, agent-tools, ignore và cấu hình resolve liên quan. Không chỉ so HEAD hoặc số commit: nội dung file có thể đổi mà HEAD/status chữ `M` vẫn giữ nguyên. Index cũ không có schema snapshot mới được coi là cần cập nhật một lần.
- [x] Analyze và query dùng chung một lock exclusive local theo realpath worktree; busy thì trả ngay, không xếp hàng lặp. Trong lock, analyze lấy snapshot và đánh dấu manifest không còn hợp lệ trước khi ghi index. Sau thành công kiểm metadata native, DB tồn tại, đúng repo/pin/config và snapshot trước/sau bằng nhau rồi mới ghi manifest atomic.
- [x] Manifest local schema 2 chứa `repoPath`, `baseCommit`, `toolVersion`, `configDigest`, `sourceDigest`, dấu metadata native, locator tool và thời điểm hoàn tất. Metadata chuẩn của pin là `.gitnexus/gitnexus.json`; `meta.json` chỉ là mirror. Dấu native gồm `repoPath`, `indexedAt`, schema, digest fileHashes và capability cần cho lệnh; không có `incrementalInProgress`. toolVersion phải lấy từ package thật vì metadata không chứa trường đó. Không chứa source, credential hoặc map hash lớn. Không viết mới khi chỉ chạy `analyze --help`, khi tool exit 0 nhưng không có DB/metadata, hoặc source đổi trong lúc chạy.
- [x] Trong lock, query kiểm manifest/DB/metadata/snapshot trước chạy; kiểm lại snapshot và metadata stamp trước trả kết quả. Index hỏng, sai version/worktree/config hoặc source lệch thì không trả kết quả như fresh. Nếu source/index đổi trong lúc query, bỏ kết quả và báo unavailable; chỉ so source là chưa đủ vì index có thể bị ghi lại với cùng source.
- [x] Dùng một deadline monotonic cho toàn thao tác: analyze bao gồm resolve/install, snapshot trước, tool và snapshot sau; query bao gồm cả hai lần kiểm source. Timeout dừng cả process con thuộc lần chạy này; chỉ giải phóng lock đúng chủ sở hữu sau khi xác nhận cây process đã dừng. Giữ index không hợp lệ khi chạy dở. Không xoá lock/process của phiên khác. Một lần lỗi không kéo theo tự clean, reinstall hoặc rebuild vòng lặp; không thêm cache mtime/size để lách chi phí kiểm source.

**Interfaces nội bộ:** `captureSnapshot(repoRoot, toolInstallation)` trả `{sourceDigest, configDigest}` hoặc lỗi có mã; `inspectIndex(repoRoot, snapshot)` trả `{status: 'ready'|'missing'|'stale'|'invalid'|'busy', reason, baseCommit}`. `ready` chỉ xác nhận index khớp snapshot, không chứng nhận code đúng hoặc graph đủ mọi quan hệ.

### Task 3 — Gỡ UA và nối lại CI/test đồng bộ

**Files:** `.ua/` (5 file tracked), `tooling/graph-manifests/ua.json`, `tooling/graph-policy.json`, `scripts/check-graph-{freshness,hygiene,secrets}.mjs`, hai test graph cũ, `.github/workflows/ci-gates.yml`, `tooling/test-matrix.json`, `.gitignore`, `scripts/check-agent-contract.mjs`.

- [x] Gỡ năm artifact UA, sidecar, policy cũ và ba script gate; gỡ hai test chỉ kiểm governance/secret của artifact đã bỏ. Chuyển kiểm không track graph artifact sang gate agent-contract đang có; không tạo một workflow graph mới.
- [x] Bỏ riêng step secret/PII UA; giữ gitleaks toàn lịch sử và các exemption hẹp cho graph đã nằm trong Git history. Giữ fetch-depth phục vụ các phép kiểm lịch sử còn tồn tại.
- [x] Bỏ graph hygiene/freshness. Giữ nguyên thực thi kiểm realtime publication; đổi job `realtime-and-knowledge-gates` thành `realtime-gates` sau khi snapshot required checks xác nhận không bị ghim. Nếu lúc triển khai không xác minh được hoặc phát sinh required context, giữ ID cũ và ghi rõ lý do; không tạo job xanh rỗng.
- [x] Gỡ `organization-impact-review` chuyên hai nhánh cũ cùng bước build, query, copy manifest/verdict và upload graph artifact. Nếu có required context mới hoặc PR đang dùng nó như bằng chứng bắt buộc, chưa gỡ job đó cho tới khi đối chiếu/chuyển yêu cầu cụ thể; không xoá yêu cầu review nghiệp vụ.
- [x] Tháo cả bốn neo của test governance: matrix includes/excludes, lệnh node:test và exclusion Vitest. Đăng ký test wrapper mới đúng bốn neo ấy. Test secrets cũ thuộc Vitest auto-discovery; không để import/caller chết sót lại.
- [x] Ignore toàn `.ua/`, giữ `.gitnexus/`; rút comment dài. Gỡ ignore verdict cũ sau khi không còn writer. Chỉ ignore các thư mục skill sinh tự động cần thiết, không ignore toàn bộ `.agents` để che WIP khác.
- [x] Giữ gate tiền, tenant/RLS, migration/backup/provenance, realtime, runtime/test-matrix, strict, production promotion và external-controls. Không gộp chỉ vì tên gần nhau: kiểm gate và test gate có vai trò khác nhau.

**Điều kiện đạt:** clean checkout không có UA, GitNexus hoặc index vẫn chạy CI bình thường. Không còn cảnh báo UA STALE/GitNexus MISSING trong CI; không bỏ mất bước realtime thật.

### Task 4 — Đồng bộ toàn bộ hướng dẫn đang hoạt động

**Files:** `docs/engineering/PROJECT_CONTRACT.md`, `AGENTS.md`, `CLAUDE.md`, `AI_RULES.md`, `scripts/check-agent-contract.mjs` và test hiện có; `docs/README.md`, `docs/CODEBASE_STRUCTURE.md`, `docs/he-thong/24-platform-delivery.md`, ADR-0004, trạng thái tooling liên quan; `.mcp.json`.

- [x] Thay §12 bằng hợp đồng ở mục 2; bỏ luật refresh graph PR riêng ở §3. AGENTS/CLAUDE bỏ đăng ký MCP và trỏ về §12. Xoá `.mcp.json` nếu sau khi bỏ GitNexus không còn server nào khác.
- [x] Sửa ba invariant cũ buộc graph/detect_changes/MCP trong check-agent-contract. Thay bằng kiểm wrapper/pin/alias thật, adapter trỏ Contract, artifact UA/GitNexus không tracked và không có cấu hình bắt buộc graph trong luồng coding/CI. Giữ toàn bộ invariant bảo vệ dữ liệu, generated types và phát hành.
- [x] Không kiểm câu chữ y hệt đoạn văn mới để tạo một bản luật thứ hai. Test cấu hình và hành vi vi phạm: mất wrapper, alias chết, track graph, tái bật MCP dự án hoặc sinh skill mặc định phải bị bắt; comment lịch sử không thay kiểm cấu hình.
- [x] Cập nhật mục lục và bản đồ code để người không dùng graph tìm được route/capability, hook/service, RPC/Edge/realtime manifest, SQL/migration và test runner bằng các nguồn hiện có. Không thêm graph tự chế hoặc một danh sách toàn bộ symbol bằng tay.
- [x] ADR-0004 chuyển trạng thái đã được thay thế, liên kết Contract mới; source_paths chỉ trỏ file còn tồn tại. Link lịch sử đến file đã gỡ đổi sang permalink tại SHA baseline. Rà docs cũ vì thêm banner không tự chữa broken links.
- [x] Cập nhật riêng các trường trạng thái hiện hành của `tooling/program-status.json`/`tooling/plan-remaining.json` nếu chúng vẫn nói UA/MCP là quy trình đang dùng; giữ bằng chứng lịch sử và backlog không liên quan. Không thêm known-gap cho công cụ đã chủ động bỏ.
- [x] Rút comment kể lịch sử trong workflow migration/CI thành lý do hiện tại; giữ exact runtime và npm ci. README Network Center chỉ rút đoạn kể sự cố thành invariant heartbeat/backoff và ví dụ OpenClaw không liên quan thành tên trung tính; giữ kill switch, rollback và hướng dẫn vận hành còn đúng.
- [x] Không xoá source/tables/migration hoặc tài liệu lịch sử chỉ vì chứa chữ OpenClaw/Network Center. Nếu gặp lỗi đang hoạt động, ghi trigger và test tái hiện trước khi đề xuất sửa; không biến đợt dọn hướng dẫn thành refactor subsystem.

### Task 5 — Dọn cấu hình local để client thực sự dùng luật mới

**Phạm vi local đã thấy:** `.codex/config.toml`; `.agents/skills/generated`, `.agents/skills/gitnexus`; `.claude/skills/generated`, `.claude/skills/gitnexus`. Mỗi cây skills hiện có 20 domain skill + 6 workflow skill. Các thư mục là bản sao thật, không phải symlink.

- [x] Kiểm lại từng đường dẫn và diff local trước xử lý. Chỉ gỡ stanza MCP GitNexus trong config dự án; giữ nguyên env, credential và cấu hình client khác. Không in toàn config.
- [x] Cho nghỉ đúng các file skill sinh tự động đã đối chiếu, vì chúng còn ép graph-first và có lệnh ngoài wrapper. Nếu có sửa tay, lưu bản sao chọn lọc ngoài vùng auto-discovery trước khi gỡ; không xoá nguyên `.agents`, `.claude` hoặc `.codex`.
- [x] Không cài lại một bộ skill thay thế. Contract và CLI help đã đủ. Không gỡ plugin UA/global MCP hoặc registry/index của dự án khác.
- [x] Xác minh bằng phiên client mới: không tự đưa GitNexus MCP và các skill project cũ vào danh mục. Phiên đang chạy có thể còn giữ catalog đã nạp; không tuyên bố thay file làm context cũ biến mất ngay.

**Đầu ra:** cleanup local là bước riêng, không stage untracked settings hoặc secret. Ghi đúng mục đã dọn và mục global nằm ngoài phạm vi.

## 4. Kiểm thử và tiêu chí nghiệm thu

### Regression bắt buộc cho wrapper/gate

| Ca thử | Kết quả phải có |
|---|---|
| Chưa cài công cụ/không index, chạy query | Unavailable ngắn; không download/reindex; source fallback dùng được. |
| Chỉ có manifest; mất DB; metadata hỏng; sai pin/config/realpath | Không trả kết quả graph như fresh. |
| Thêm caller ở file untracked; sửa cùng file hai lần khi status vẫn M; xoá/rename | Snapshot khác, graph cũ bị từ chối. |
| Source đổi trong lúc analyze/query; analyze thất bại/hết giờ | Không ghi manifest fresh hoặc trả kết quả cũ. |
| Cùng SHA nhưng worktree khác; repo override dạng dấu bằng/ngắn; branch override | Từ chối đổi đích. |
| `analyze --help`, tool exit 0 nhưng thiếu artifact | Không đóng dấu index đã dựng. |
| Index hợp lệ và source không đổi | Query đúng symbol/đường dẫn; không phân tích lại. |
| Hai analyze đồng thời; process timeout | Chỉ một writer; dừng đúng process của mình, không để lock giả còn hiệu lực. |
| Windows path có khoảng trắng, query có `&`, `|`, `$()`, backtick, dấu nháy | Đối số được giữ nguyên, không thực thi như shell. |
| Analyze cấu hình mới | Không sinh/sửa AGENTS, CLAUDE, skills, MCP/hooks; embeddings vẫn tắt. |
| Cố force-add UA/GitNexus; alias cũ còn được gọi; Node test lọt Vitest | Gate liên quan phải đỏ đúng lý do. |

Thực hiện mutation có kiểm hash/khôi phục cho guard có thể báo xanh rỗng: bỏ kiểm sourceDigest, bỏ kiểm DB và bỏ kiểm đúng repo phải làm test đỏ. Không viết test chỉ kiểm một chuỗi xuất hiện trong code.

### Lệnh xác minh sau triển khai

```bash
node --test scripts/__tests__/run-pinned-gitnexus.test.mjs scripts/__tests__/check-agent-contract.test.mjs
node node_modules/vitest/vitest.mjs run scripts/__tests__/check-workflow-paths.test.mjs scripts/__tests__/check-test-matrix.test.mjs scripts/__tests__/check-test-matrix-declarations.test.mjs
npm run gate:agent-contract
npm run gate:test-matrix
npm run gate:runtime-matrix
node scripts/check-workflow-paths.mjs
npm run docs:check:links
node scripts/check-doc-counts.mjs
npm run gate:docs-views
```

- Chạy bằng runtime đúng matrix. Sau lượt test liên quan đạt, chỉ chạy thêm khi có thay đổi/lỗi mới; không lặp toàn bộ sau mỗi chỉnh câu chữ.
- Kiểm real GitNexus local một lượt cấu hình mới và benchmark mục 3. Trong CI thường chỉ chạy regression wrapper bằng fixture/stub, không dựng graph toàn repo.
- Trước tích hợp chạy `npm run gate:truoc-push -- --khong-dao-strict` trong worktree của task; generator có thể ghi/stage artifact theo allowlist nên phải kiểm cả staged diff. Không cần E2E toàn app cho scope tài liệu/tooling/CI này.
- CI trên đúng SHA phải xanh và realtime publication thực sự chạy. Không lấy skipped/biến mất làm bằng chứng test đã đạt. Main/production đã xanh ở baseline không thay thế kiểm SHA mới.
- Không có thay đổi ngoài phạm vi trong diff: ứng dụng, migration, env/credential, WIP khác. Không công bố đã tiết kiệm token nếu chỉ đo số ký tự output.

## 5. Thứ tự tích hợp và bàn giao

- [x] Triển khai theo thứ tự 1 → 2 → 3+4 → 5; bước 3 và 4 phải tích hợp cùng nhau để không có commit chính thức với hướng dẫn gọi script đã bị xoá. Bước 5 chỉ chạy sau khi luật/CLI mới đã được kiểm.
- [x] Review độc lập phần wrapper/freshness và phần CI/contract. Reviewer kiểm kỹ WIP, false-fresh, Windows subprocess, runner wiring, required check identity và link lịch sử.
- [x] Bàn giao số đo trước/sau, danh sách gate đã chạy, khoản tiết kiệm đã đo và giới hạn của graph. Việc không dùng graph vẫn phải truy được bốn câu hỏi mẫu bằng source/manifest/test.
- [ ] Khi triển khai được yêu cầu, tích hợp theo Contract §3; nếu phát hành app dùng promotion lane với CI đúng SHA. Không cần schema migration hoặc deploy worker cho đợt này.
- [ ] Rollback bằng revert các commit tooling/docs của đợt này; không khôi phục UA chỉ để một gate cũ xanh, không xoá index/registry của worktree khác. Nếu GitNexus chưa ổn, để unavailable và tiếp tục đường source.

**Định nghĩa hoàn tất:** UA không còn là dependency của repo/CI/agent; GitNexus không tự chạy thường trực và không sinh luật; query không tin index sai/cũ; hướng dẫn ngắn, đúng lệnh, một nguồn luật; các kiểm soát production còn hoạt động và đã được kiểm trên SHA triển khai.

**Rà soát bản kế hoạch:** Đã nhận review riêng về wrapper/index và CI/tài liệu. Đã sửa các điểm scanner nuốt lỗi, shell Windows, metadata chuẩn, migration snapshot qua fast path, deadline toàn thao tác, lock writer/query và phạm vi dọn local. Review triển khai riêng cho wrapper và CI/tài liệu đã đóng các lỗi phát hiện; số đo, regression và giới hạn native được ghi trong báo cáo audit.
