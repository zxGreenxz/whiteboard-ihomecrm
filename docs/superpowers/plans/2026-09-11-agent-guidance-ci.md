# Plan chuẩn hoá hướng dẫn agent và ổn định CI

> Khi có hạng mục implementation mới, dùng `superpowers:subagent-driven-development` hoặc `superpowers:executing-plans` theo từng đầu việc đã duyệt.

**Goal:** Hướng dẫn ngắn, đúng nguồn; sửa nguyên nhân CI lỗi lặp; phát hành bằng bằng chứng của đúng commit.
**Architecture:** Project Contract giữ luật chung, adapter chỉ giữ cách dùng tool; manifest sở hữu cấu hình; regression test bảo vệ các quyết định của gate.
**Tech stack:** Node, GitHub Actions, Vitest, node:test, PostgreSQL; runtime từng package/job theo [runtime-matrix](../../../tooling/runtime-matrix.json).
**Mốc đối chiếu:** `e0fdcd52df017df97d5ef48ca8d000717027a728`, ngày 11/09/2026 (UTC+7).
**Trạng thái:** Các sửa lỗi tại mốc trên đã phát hành. R2 phát hiện thêm lỗi strict đọc cấu hình chưa stage; bản sửa bổ sung đi cùng plan này. Không thi công lại phần đã đạt.

## Ràng buộc chung

- Phạm vi: AGENTS/CLAUDE/AI_RULES, hướng dẫn engineering, CI và script liên quan lỗi gần đây; không mở rộng thành thiết kế lại nghiệp vụ.
- Luật vận hành lấy từ [Project Contract](../../engineering/PROJECT_CONTRACT.md); plan này không phải đầu vào bắt buộc mỗi phiên agent.
- Giữ WIP trong checkout chính; sửa độc lập trong worktree. Chỉ stage file sở hữu, không tăng baseline lỗi hoặc nuốt lỗi để qua gate.
- OpenClaw đã nghỉ dùng: bỏ hướng dẫn vận hành thừa; migration, baseline và ledger lịch sử giữ nguyên. Network Center còn hoạt động.
- THẬT chỉ đọc dữ liệu nghiệp vụ; harness Network Center/restore dùng database dùng một lần. Một số gate CI có PAT kiểm database đích trong ROLLBACK theo Contract; không gọi tất cả CI là disposable. Nghiệm thu plan không apply schema hay ghi dữ liệu thật.
- Review phải đối chiếu source và bằng chứng chạy. Nếu không có graph mới, dùng source/manifest/harness và ghi rõ giới hạn; không suy luận từ graph bị từ chối.
- Lệnh dưới đây chạy tại root repo với runtime đúng job. Trên Windows kiểm Node thực của npm/npx; shim PowerShell có thể gọi Node hệ thống khác PATH. Các lệnh test dùng trực tiếp `node` để tránh nhầm runner.

## Thứ tự và đầu ra

| Mã | Công việc | Phụ thuộc | Đầu ra/điều kiện đạt |
|---|---|---|---|
| P1 | Đối chiếu luật và rút tài liệu | Mốc Git sạch | Một nguồn luật, adapter ngắn, lệnh/link hợp lệ |
| P2 | Phân loại lỗi CI gần đây | P1, metadata và log CI | Nhóm theo nguyên nhân; phân biệt đã sửa trước đợt này và cần vá |
| P3 | Khôi phục gate Network Center | P2 | 20 ca đúng danh tính JWT; lỗi thật làm CI đỏ; teardown sạch |
| P4 | Sửa phạm vi module strict | P2 | Push/PR/index được kiểm đúng, hai module thiếu đã strict-clean |
| P5 | Sửa bằng chứng release/control | P2 | Pending không thành success; một lần đo control, artifact mới |
| P6 | Xác minh backup và đóng gap | P2 | Backup thành công; chỉ đóng gap có bằng chứng đủ |
| P7 | Nghiệm thu và phát hành | P1–P6 | Gate đúng scope, main CI xong, promote đúng SHA, deployment READY |
| R1→R2 | Hai vòng review plan trung lập | Bản plan đầy đủ; R2 sau sửa R1 | Mỗi nhận xét có đối chiếu và xử lý; không còn lỗi quan trọng |

P3–P6 độc lập, có thể điều tra ở worktree riêng. Tích hợp một đợt sau review để tránh tạo nhiều lượt CI chỉ vì sửa từng lỗi nhỏ.

## P1 — Hướng dẫn và kiểm tra chống lệch

**Files:** `AGENTS.md`, `CLAUDE.md`, `AI_RULES.md`, `docs/engineering/PROJECT_CONTRACT.md`, `README.md`, `docs/engineering/MIGRATION_STRATEGY.md`, `docs/engineering/DATA_ENVIRONMENTS.md`, `docs/decisions/ADR-0003-agent-pr-only.md`, `.github/pull_request_template.md`; `scripts/check-agent-contract.mjs`, `scripts/check-doc-counts.mjs`, manifest liên quan.
**Đầu vào → đầu ra:** Luật cũ + script/workflow thực → luật còn hiệu lực và reference đúng; số liệu thay đổi thuộc manifest.

- [x] Đối chiếu credential, schema/backup, runtime, review, graph, E2E và phát hành; bỏ các câu mâu thuẫn hoặc kể lại lỗi đã đóng.
- [x] Bốn hướng dẫn chính giảm 1.170→270 dòng (77%). Đây là số đo của mốc trên, không phải mục tiêu số dòng cho mọi lần sửa sau.
- [x] Gate kiểm adapter trỏ Contract, lệnh npm tồn tại, link nội bộ, giới hạn độ dài và invariant hiển thị; HTML comment không thay thế luật thật.
- [x] Regression phải bắt lệnh npm không tồn tại và invariant chỉ còn trong comment; không xoá invariant để đạt ngân sách dòng.

```sh
node --test scripts/__tests__/check-agent-contract.test.mjs
node scripts/check-agent-contract.mjs
node scripts/check-doc-counts.mjs
```

Mở lại khi đổi một trong các luật/script được tham chiếu hoặc gate báo drift. Không thêm nhật ký lỗi vào adapter.

## P2 — Phân loại lỗi bằng log

**Files/nguồn:** `.github/workflows/`, test/script của bước lỗi, Git history và GitHub Actions.
**Đầu vào → đầu ra:** Run ID + SHA + failed step + log → nguyên nhân, hồi quy và bằng chứng đóng.

- [x] Snapshot điều tra từ 08/09 10:26:05 đến 10/09 17:28:59 UTC ghi 150 run, 41 failure, trước rerun backup. Đây là workflow run, không phải 41 bug khác nhau hay số failure hiện tại.
- [x] Copilot, dependency audit, realtime fixture và restore Storage shim đã sửa trước đợt này. Migration đã áp dụng được xử lý bằng ngoại lệ ghim và preflight; không gọi SQL lịch sử đã thành idempotent, không sửa lại lịch sử.
- [x] Các lỗi còn thật được giao P3–P6: JWT fixture, mốc strict, bằng chứng promote, API protection, artifact và credential backup.
- [x] Lưu bằng chứng theo commit/run; không tạo một checklist sự cố dài trong hướng dẫn mỗi phiên.

Khi có failure mới: đọc đúng log của SHA lỗi, tái hiện bằng regression nhỏ; chỉ mở rộng test khi source hoặc kết quả tạo nghi vấn mới. Không kết luận từ màu xanh tổng nếu bước đã bị nuốt hoặc không chạy.

| Nhóm | Run lỗi / SHA / bước | Bản sửa → bằng chứng xác nhận |
|---|---|---|
| Copilot | [34366418406](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34366418406), `88d250c4`, quality-gates/Vitest: 4 assertion rollout/scope/seed | `7781956f`; [34368313773](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34368313773) Vitest bước 22 đạt; workflow còn đỏ vì audit dependency riêng |
| Dependency audit | [34368313773](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34368313773), `7781956f`, bước phân tầng lỗ hổng: xmldom high | `67ca0e7e` nâng 0.9.10→0.9.12 và bỏ ngoại lệ cũ; [34374209695](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34374209695), `2852276a`, audit bước 8 đạt |
| Realtime fixture | [34389100916](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34389100916), `cb671808`, Vitest subscription list và timezone | `b9cea469`; [34390042144](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34390042144) Vitest bước 22, timezone bước 6 đạt; regression ở `src/hooks/__tests__/useRealtimeDataSync.test.ts` |
| Migration đã áp dụng | [34394725428](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34394725428), `0364a6a8`, security-gates/idempotency: 42P07 bảng settlement đã có | `c123d839` + `899f847c` ghim digest/lỗi/project và thêm preflight; [34396714392](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34396714392), `90d89b28`, idempotency bước 11 đạt; không mở ngoại lệ cho migration mới |
| Restore Storage shim | [34430424463](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34430424463), `82510478`, restore-drill/forward replay thiếu schema storage | `3df3749d`; [34431457578](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34431457578), `045830ee`, shim bước 7 và replay bước 9 đạt; `scripts/test-platform-storage-shim.mjs` |

## P3 — Network Center

**Files:** `scripts/test-cross-tenant.mjs`, `.github/workflows/network-center-validation.yml`, `tooling/known-gaps.yaml`; harness hỗ trợ ở `scripts/network-center-disposable-db.mjs`.
**Đầu vào → đầu ra:** Role/actor fixture → cả claim riêng và JSON claims thống nhất, `auth.uid()`/`auth.role()` đúng trước mỗi nhóm quyền.

- [x] Đồng bộ claim subject/role và JSON; clear subject của anon; xác minh identity trước kiểm allow/deny.
- [x] Gỡ cơ chế chỉ warning khi matrix lỗi; giữ isolation, runner/runtime từng job và kiểm teardown.
- [x] Đủ 20/20 ca, có positive control và cross-tenant denial; mutation thiếu subject phải đỏ đúng lỗi identity.

```sh
node --test scripts/__tests__/network-center-local-cluster.test.mjs scripts/__tests__/network-center-cross-tenant-target.test.mjs
node scripts/test-cross-tenant.mjs --local-cluster
```

Lệnh local-cluster cần PostgreSQL server/client local; `POSTGRES_BIN` trỏ thư mục chứa `initdb`, `pg_ctl`, `psql`. Thiếu công cụ là chưa kiểm được. CI Network Center là bằng chứng riêng cho Linux và worker PowerShell Windows; không suy tương thích mọi runtime từ một lần chạy local.

## P4 — Strict phải bắt đúng phần code mới

**Files:** `scripts/check-new-modules-strict.mjs`, test cùng tên, `tsconfig.strict-islands.json`, `tooling/strict-islands-baseline.json`.
**Đầu vào → đầu ra:** `push.before`/`pull_request.base.sha` hoặc `--base` → module mới từ merge-base đến index, đối chiếu cấu hình strict trong cùng index; đăng ký strict không thay đổi logic tiền.

- [x] `--base` ưu tiên; payload thiếu, SHA không có, zero SHA hoặc shallow clone không được rơi về phép so rỗng rồi báo đạt.
- [x] File đã stage bị kiểm trước commit; untracked WIP chỉ cảnh báo local và bị kiểm trên CI.
- [x] Bổ sung `src/hooks/income-expenses/supplements.ts`, `src/lib/incomeExpenseSupplement.ts`; generator khoá thêm file đã strict-clean, không tăng lỗi cho phép.
- [x] Test Git repo thật: origin/main đã bằng HEAD vẫn bắt thiếu strict, PR base, explicit base, staged/untracked và mốc hỏng; đột biến bỏ event base hoặc index phải đỏ.
- [x] Bổ sung sau R2: đọc config bằng `git show :tsconfig.strict-islands.json`; thiếu config trong index phải exit 3. Hướng dẫn lỗi nhắc stage config sau khi typecheck. Ba regression tái hiện đỏ trước sửa, 23/23 test đạt sau sửa; đột biến đọc lại working tree bị bắt và khôi phục đúng digest (`989527ecbb96` → `dd14a50e14ba` → `989527ecbb96`).

```sh
node node_modules/vitest/vitest.mjs run scripts/__tests__/check-new-modules-strict.test.mjs
node scripts/check-new-modules-strict.mjs --base 5f91152f1f54b10034c61dc850375f6ff8541aa2^
node scripts/check-strict-islands.mjs
node scripts/check-ts-baseline.mjs
```

Mốc lịch sử trên tái hiện đúng lỗi đã tìm thấy; kiểm một thay đổi mới phải dùng mốc của thay đổi mới. Bắt buộc strict/typecheck đạt, không chỉ kiểm tên file đã có trong config.

## P5 — Bằng chứng CI và control

**Files:** `scripts/promote-to-production.mjs`, `scripts/check-external-controls.mjs`, hai workflow CI/external-controls và các regression tương ứng.
**Đầu vào → đầu ra:** Runs/jobs/steps đúng SHA + snapshot control gốc → verdict phát hành hoặc lỗi rõ ràng và artifact mới.

- [x] Promote đòi CI chính `.github/workflows/ci-gates.yml` trên main hoàn tất, có bước thực thi thành công; kiểm cả lỗi bị `continue-on-error` che.
- [x] Pending/không có job/không có step không phải đạt. Chờ tối đa 420 giây khi được yêu cầu; lỗi thật/API error không được retry như pending. Response thiếu trang dữ liệu phải từ chối.
- [x] Protection API 403 được đối chiếu metadata `main.protected === false`; true/thiếu dữ liệu/lỗi vẫn chưa xác minh. Không cấp thêm token rộng chỉ để kiểm absence.
- [x] Control đo một lần: so snapshot gốc trước ghi, dùng `--output` riêng trong runner.temp; drift exit 1, không đọc được baseline exit 3; API lỗi không được upload snapshot cũ thành bằng chứng mới.

```sh
node --test scripts/__tests__/check-external-controls.test.mjs
node node_modules/vitest/vitest.mjs run scripts/__tests__/promote-to-production.test.mjs scripts/__tests__/external-controls-drift.test.mjs scripts/__tests__/check-workflow-paths.test.mjs
```

Đột biến phải bắt được: chấp nhận evidence rỗng, cho workflow không liên quan thay CI chính, và ghi snapshot trước khi so. Job production kiểm sau push chỉ là cảnh báo; preflight trước `--apply` mới là trình tự phát hành hợp lệ.

## P6 — Backup và khoảng trống

**Files/nguồn:** `.github/workflows/org-context-backup.yml`, `scripts/backup-before-schema.mjs`, `tooling/known-gaps.yaml`, credential contract; Actions secret không nằm trong Git.

- [x] Credential backup sai đã được xác minh bằng truy vấn chỉ đọc, đồng bộ riêng secret cần thiết và chạy lại backup thành công; không xoay mật khẩu database hoặc ghi dữ liệu để chữa lỗi xác thực.
- [x] Đóng gap Network Center bằng matrix đạt; đóng digest org NULL sau hai lần đo người dùng thật liên tiếp, không dựa vào tên job cross-tenant.
- [x] Giữ các gap chưa có bằng chứng hoàn tất, gồm branch protection, PITR và restore lên Supabase thật. Green CI PostgreSQL trần không đóng gap Supabase.

```sh
node scripts/check-known-gaps.mjs --strict
```

Chỉ mở lại credential khi lỗi xác thực được tái hiện; không đồng bộ secret hoặc chạy full backup mỗi lần sửa tài liệu. Mỗi schema/backfill thật vẫn theo lane/backup trong Contract.

## P7 — Nghiệm thu đúng phạm vi

- [x] Chạy suite thuộc phần sửa bằng runner của [test-matrix](../../../tooling/test-matrix.json); strict/typecheck riêng khi đổi phạm vi TypeScript.
- [x] Chạy `npm run gate:truoc-push -- --khong-dao-strict` sau khi strict đã kiểm riêng; xem diff generator và index. Cảnh báo thiếu credential của generator live không phải bằng chứng schema khớp.
- [x] Tích hợp commit, chờ CI main của đúng SHA và workflow liên quan. E2E chỉ bắt buộc khi đổi UX; GET 200 không được gọi là nghiệm thu toàn bộ nghiệp vụ.
- [x] Preflight promote của `e0fdcd52` đã đọc 16 job/165 bước; production cùng SHA, Vercel app READY, alias gán thành công và trang chủ HTTP 200.

| Bằng chứng | Kết quả tại mốc đối chiếu |
|---|---|
| [CI main 34513219298](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34513219298) | Success: strict, types drift, bảo mật, múi giờ, build và test theo điều kiện job |
| [Network Center 34513219217](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34513219217) | Success cả ba job; matrix 20/20 |
| [External controls 34513254476](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34513254476) | Success; artifact đo lúc 18:16:32 UTC ngày 10/09 |
| [Backup 34508482559](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34508482559) | Rerun success trên SHA `8a83ece9` sau sửa secret; script backup không đổi trong đợt `e0fdcd52` |
| [Production CI 34514047063](https://github.com/zxGreenxz/whiteboard-ihomecrm/actions/runs/34514047063) | Promotion gate success; không chạy lặp toàn bộ app suite |

Trạng thái trên chỉ chứng minh mốc đã ghi. Khi HEAD hoặc control thay đổi phải lấy bằng chứng mới đúng phạm vi. Bản sửa gate sau R2 cần chạy suite strict 23 ca, gate trước push, CI main và preflight promote của commit mới; không chạy lại backup hoặc matrix Network Center không liên quan. Không chạy lại/deploy chỉ vì bổ sung biên bản plan.

## Hai vòng kiểm plan trung lập

- [x] R1: reviewer mới đối chiếu source, phát hiện đường dẫn test sai và bảng lỗi thiếu trace tới run/step; đã sửa đường dẫn, kiểm 21/21 test và bổ sung P2 trước R2.
- [x] R2: reviewer khác tái hiện lỗi cấu hình strict chưa stage; sau sửa, reviewer chạy độc lập 23/23 test, mốc lịch sử và diff check, không còn P1/P2. Bản nội dung được kiểm có SHA256 `157594c6cb9c80f6fa9b2cd526dff5d71df9c92964521de95600feb4147e713b`. Reviewer dùng Node 24.19.0; tác giả dùng đúng Node 24.18.0 của app CI và kiểm mutation. Reviewer không có GitHub auth; Actions/deployment do tác giả xác minh riêng sau push.
- [x] Chốt plan: đủ P1–P7, lệnh npm/đường dẫn/link tồn tại, hai vòng độc lập đã xử lý nhận xét. CI và deployment của bản sửa R2 phải lấy từ commit mới theo P7, không dùng màu xanh của baseline thay thế.
