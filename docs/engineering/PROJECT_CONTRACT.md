# Project Contract — hướng dẫn chung cho agent

Bắt đầu từ adapter và Contract, rồi tra source. Thường chỉ cần một runbook. Khi tác vụ giao nhiều phạm vi, đọc các mục tương ứng (ví dụ §2 và §4 khi backfill liên quan quyền).

## 1. Dự án và nguồn tra cứu

React/Vite, Supabase, Cloudflare R2 và Network Center. Chọn scope từ diff và source.
[risk-map](../../tooling/risk-map.json) sở hữu tier/review, [test-matrix](../../tooling/test-matrix.json) runner, [runtime-matrix](../../tooling/runtime-matrix.json) runtime, [package.json](../../package.json) lệnh.
Tra [domain](../he-thong/README.md) khi chưa rõ nghiệp vụ. Hermes là trợ lý CRM hiện hành. Một số thành phần nội bộ giữ tên `copilot`. Tra [manifest](../../tooling/deferred-modules.json) cho các test và gate tạm hoãn.

## 2. Phạm vi dữ liệu

Org THẬT chỉ đọc; fixture chỉ ghi DEMO hoặc project TEST riêng và phải dọn. Credential không cấp quyền ghi schema.
Trước thao tác dữ liệu/quyền, tra [môi trường, JWT/RLS và phạm vi toà](DATA_ENVIRONMENTS.md). Không dựng lại clone-org trong production.

## 3. Git, review và phát hành

- Kiểm status, giữ WIP; việc độc lập dùng git worktree. Chỉ stage file cụ thể; cấm `git add -A` / `git add .`.
- Fetch/rebase `origin/main` trước tích hợp; conflict source sửa tay, file máy sinh lấy bản của main rồi chạy lại generator.
- Commit ghi lý do, kiểm chứng và trailer theo adapter. Xem `crossReview` trong plan (§10) trước khi push.
- Nếu `crossReview` bật hoặc thay đổi tiền, quyền, lịch sử migration hay bộ kiểm (workflow, gate, promote, risk-map), push nhánh làm việc và mở draft PR. Review độc lập một lần trên diff cuối và receipts, ghi base/head/kết luận vào PR. Sau sửa chỉ review phần đổi.
- Các thay đổi được phép lên thẳng `main` dùng `git push origin HEAD:main` sau khi kiểm `origin/main` là ancestor của `HEAD`. Không force-push né conflict.
- `main` là Preview. Phát hành qua `npm run promote:production -- --sha <sha>`. Khi đủ bằng chứng, `--apply` cập nhật `production` và chờ Vercel. Kiểm bằng `npm run release:verify`. Không push trực tiếp vào `production`.
- Đổi phát hành phải kiểm `npm run check:external-controls`. Gate đỏ/skip/thiếu bằng chứng không phải đạt; rollback app bằng deployment đã xác minh, không tự rollback schema phá huỷ. Biên nhận E2E chỉ do `npm run e2e:fleet:bien-nhan` sinh, cấm viết tay; promote in biên nhận đã nhận.

## 4. Ghi schema production và backup

Trước thay đổi SQL/RPC/quyền/tiền, đọc [migration runbook](MIGRATION_STRATEGY.md). Ghi schema/backfill đi qua forward lane có backup/biên nhận, kiểm đích, SHA review, digest và catalog trước/sau.
Không dùng PAT ghi thẳng Management API để bỏ lane. Hạ tầng ghim exact runtime/image/action, không bind rộng hoặc retry ngầm thao tác không idempotent; kiểm rollback bằng artifact thật.

## 5. Migration và database

Migration đã merge/deploy là immutable; legacy không replay được. Dựng database bằng baseline + forward lane trên database dùng một lần.

## 6. Generated types

Chỉ sinh types/surfaces khi scope cần theo kế hoạch gate; UI hoặc docs thuần không tự gọi DB. Quy trình atomic trong [migration runbook](MIGRATION_STRATEGY.md#generated-types).
Không sửa generated types bằng tay hoặc redirect generator. Thiếu credential/mạng phải ghi chưa xác minh.

## 7. TypeScript

`npm run typecheck:baseline` kiểm `tsconfig.app.json` theo `ts-baseline.json`; root `tsc --noEmit` không kiểm app.
Module mới strict-clean; không tăng baseline né lỗi. Chi tiết auth/deadlock và cấu trúc ở [bản đồ code](../CODEBASE_STRUCTURE.md).

## 8. Kiểm thử đúng phạm vi

- Test hành vi đổi bằng runner trong manifest. Với UI, kiểm luồng, vai trò và viewport bị ảnh hưởng, lưu ảnh và console.
- CI build/bundle một lần cho đúng candidate. Chỉ build local để chẩn đoán hoặc bổ sung bằng chứng còn thiếu.
- Tiền, quyền, cách ly org, migration và verifier có thể xanh rỗng cần kiểm đột biến; [hướng dẫn kiểm](../CODEBASE_STRUCTURE.md#kiểm-thử) giữ quy trình hash/khôi phục và E2E headless.
- Báo chưa kiểm nếu test bị skip, DEFERRED hoặc thiếu runner.

## 9. Credential

Chỉ dùng `npm run with-cred -- <lệnh>` hoặc `npm run db:query` khi cần credential. Wrapper tìm vault qua `IHOMECRM_VAULT` hoặc `CLAUDE.local.md` tại checkout hiện tại/chính. Không in, sao chép, commit secret hoặc đưa vào biến VITE công khai. Repo public và log không được chứa số tiền production hay tài khoản thật.
Tra tên khóa ở [local-credential-contract](../../tooling/local-credential-contract.json). Chỉ preflight vault ở local khi cần. Báo thao tác bị chặn nếu thiếu khóa, rotate nếu nghi lộ.

## 10. Hoàn tất thay đổi

1. Sau test tập trung, stage đúng file và xem `npm run gate:truoc-push -- --plan` để biết phạm vi, lý do và `crossReview`. Diff chưa phân loại được sẽ chọn phạm vi rộng.
2. Chạy `npm run gate:truoc-push` cho staged diff. Gate dùng lại receipt còn đúng đầu vào. Tránh gọi trùng typecheck, lint và Vitest đã có trong plan. Chỉ dùng `--full` khi cần toàn bộ gate. Khi sửa lỗi local, chạy lại gate cho diff đã sửa.
3. Trên PR, lấy head SHA hiện tại bằng `gh pr view <PR> --json headRefOid --jq .headRefOid`. Chọn run `CI Gates` của PR đó qua `gh run list --workflow ci-gates.yml --event pull_request --commit <head-sha>`. Chờ `gh run watch <run-id> --exit-status`, xác nhận `gate-aggregate` đạt trên đúng head cuối. Nếu cần chạy lại CI Gates trên cùng SHA, chọn **Re-run all jobs** để preflight và receipts cùng attempt.
4. Sau khi lên `main`, chờ `npm run ci:wait -- --sha <sha-tren-main>`. Báo kết quả và phần chưa kiểm, phát hành theo §3. Giữ lock của tiến trình sống và xử lý file untracked của mình trước stage.

## 11. Điều kiện dừng

Khi sai đích, thiếu credential, lệch digest/provenance hoặc gate bắt buộc chưa đạt, giữ bằng chứng lỗi và dừng thao tác phụ thuộc. Tiếp tục phần độc lập. Không nuốt lỗi hoặc nâng baseline để qua gate. Chỉ báo đạt cho phần đã kiểm.

## 12. Tra cứu mã nguồn và GitNexus

Tra file/symbol bằng `rg`, đọc imports/callers và tests. Source, Git diff, contract/harness là căn cứ; graph không chứng minh SQL/RLS hay production.
GitNexus tùy chọn qua `scripts/run-pinned-gitnexus.mjs`, pin ở `tooling/agent-tools.json`; analyze tối đa một lần/task khi cần. Lỗi/hết giờ dùng source; không đưa graph/Understand Anything vào CI hay sinh lại hướng dẫn.

## 13. Hướng dẫn chuyên đề và khoảng trống

Tra [Network Center](../../infra/network-center-worker/README.md) khi làm với worker. Đóng mục trong [known-gaps](../../tooling/known-gaps.yaml) bằng bằng chứng, không chép sự cố cũ thành luật.

## 14. Quy ước code

UI shadcn/Lucide, Tailwind, React Hook Form + Zod; dữ liệu qua hook/service typed, không RPC trực tiếp trong component hoặc thêm cast `any` high-risk.
Giữ loading/error và phân biệt lỗi quyền/validation/concurrency; không trả rỗng che lỗi. Lazy route nặng, đo bundle khi đổi tải trang; file/media đi lớp storage hiện có.
Công thức dùng nhiều nơi hoặc dính tiền/quyền: [hàm SQL chung](../CODEBASE_STRUCTURE.md#công-thức-dùng-chung).
