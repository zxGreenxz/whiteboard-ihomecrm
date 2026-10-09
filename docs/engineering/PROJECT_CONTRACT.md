# Project Contract — hướng dẫn chung cho agent

Đọc adapter của agent và file này một lần; chỉ mở thêm một tài liệu domain/runbook khi cần, rồi tra source.
Không tự đọc audit mới nhất, plan cũ hoặc lần theo toàn bộ liên kết. Luật chung ở đây; chi tiết chỉ ở nguồn được dẫn.
Copilot vẫn tạm ngưng theo [hồ sơ riêng](../deferred/zalo-copilot.md); chỉ mở khi user yêu cầu. Zalo mở lại từ 10/10/2026 (cùng hồ sơ): test đơn vị chạy lại, e2e fleet `chat-zalo` còn hoãn.

## 1. Dự án và nguồn tra cứu

React/Vite, Supabase, Cloudflare R2 và Network Center. Chọn scope từ diff và source.
[risk-map](../../tooling/risk-map.json) sở hữu tier/review; [test-matrix](../../tooling/test-matrix.json) sở hữu runner; [runtime-matrix](../../tooling/runtime-matrix.json) sở hữu runtime; [package.json](../../package.json) sở hữu lệnh.
Chỉ đọc [một domain](../he-thong/README.md) nếu chưa rõ nghiệp vụ; manifest và evidence thay số đếm chép tay.

## 2. Phạm vi dữ liệu

Org THẬT chỉ đọc; fixture chỉ ghi DEMO hoặc project TEST riêng và phải dọn. Credential không cấp quyền ghi schema.
Trước thao tác dữ liệu/quyền, đọc [DATA_ENVIRONMENTS](DATA_ENVIRONMENTS.md): ID đích, JWT/RLS và scope toà; không dựng lại clone-org trong production.

## 3. Git, review và phát hành

- Kiểm status, giữ WIP; việc độc lập dùng git worktree. Chỉ stage file cụ thể; cấm `git add -A` / `git add .`.
- Fetch/rebase `origin/main` trước tích hợp; conflict source sửa tay, file máy sinh lấy bản của main rồi chạy lại generator.
- Commit nêu lý do/kiểm chứng; trailer theo adapter. Push `git push origin HEAD:main` sau kiểm ancestor; không force-push né conflict.
- Tiền, quyền, lịch sử migration và bộ kiểm (workflow, gate, promote, risk-map) cần draft PR. Theo `crossReview`: review một lần trên diff cuối và receipts, ghi base/head/kết luận vào PR, không chạy lại gate; sửa xong chỉ re-review phần sửa.
- `main` là Preview; app phát hành từ `production` qua `npm run promote:production -- --sha <sha>`, chỉ thêm `--apply` khi đủ bằng chứng (tự chờ Vercel; kiểm lại bằng `npm run release:verify`). Không push trực tiếp bỏ lane.
- Đổi phát hành phải kiểm `npm run check:external-controls`. Gate đỏ/skip/thiếu bằng chứng không phải đạt; rollback app bằng deployment đã xác minh, không tự rollback schema phá huỷ.

## 4. Ghi schema production và backup

Trước schema/backfill đọc [migration runbook](MIGRATION_STRATEGY.md). Chỉ dùng forward lane có backup/biên nhận; kiểm đích, SHA review, digest và catalog trước/sau. Thiếu bằng chứng thì dừng apply.
Không dùng PAT ghi thẳng Management API để bỏ lane. Hạ tầng ghim exact runtime/image/action, không bind rộng hoặc retry ngầm thao tác không idempotent; kiểm rollback bằng artifact thật.

## 5. Migration và database

Migration đã merge/deploy là immutable; legacy không replay được. Dựng database bằng baseline + forward lane trên database dùng một lần.
Runbook sở hữu tên migration, provenance, idempotency, PostgREST/JWT/RLS, kiểm tiền v1/v2 và volatility; mở trước khi sửa SQL/RPC/quyền/tiền.

## 6. Generated types

Chỉ sinh types/surfaces khi scope cần theo kế hoạch gate; UI hoặc docs thuần không tự gọi DB. Quy trình atomic trong [migration runbook](MIGRATION_STRATEGY.md#generated-types).
Không sửa generated types bằng tay hoặc redirect generator. Thiếu credential/mạng phải ghi chưa xác minh.

## 7. TypeScript

`npm run typecheck:baseline` kiểm `tsconfig.app.json` theo `ts-baseline.json`; root `tsc --noEmit` không kiểm app.
Module mới strict-clean; không tăng baseline né lỗi. Chi tiết auth/deadlock và cấu trúc ở [bản đồ code](../CODEBASE_STRUCTURE.md).

## 8. Kiểm thử đúng phạm vi

- Test hành vi bị đổi bằng runner trong manifest. Sửa UI kiểm luồng/vai trò và viewport bị ảnh hưởng, ảnh chụp cùng console; không mặc định quét desktop lẫn mobile hay E2E toàn app.
- Build/bundle ở CI một lần cho đúng candidate; local chỉ chạy khi cần chẩn đoán hoặc thiếu bằng chứng. Không dựng lại bản không đổi chỉ để báo xong.
- Tiền, quyền, cách ly org, migration và verifier có thể xanh rỗng cần kiểm đột biến; [hướng dẫn kiểm](../CODEBASE_STRUCTURE.md#kiểm-thử) giữ quy trình hash/khôi phục và E2E headless.
- Test bị skip/DEFERRED hoặc thiếu runner vẫn là chưa kiểm. Không hạ kiểm soát để CI xanh.

## 9. Credential

Vault duy nhất `CLAUDE.local.md` ở checkout chính, bị ignore. Chỉ nạp khóa cần dùng vào process env (`npm run with-cred -- <lệnh>`; đọc DB bằng `npm run db:query`), không sao chép/in/commit secret; VITE công khai không chứa secret. Repo public: không đưa số tiền production hay tài khoản thật vào code, docs, test, log.
Tên khóa ở [local-credential-contract](../../tooling/local-credential-contract.json); preflight local chỉ khi thao tác cần, không chạy vault preflight trên CI. Thiếu/hết hạn thì báo đúng khả năng bị chặn; nghi lộ phải rotate.

## 10. Hoàn tất thay đổi

1. Stage đúng file sau focused tests; xem `npm run gate:truoc-push -- --plan` để biết scope, lệnh và lý do chọn. Mặc định đọc staged diff; fallback bảo thủ khi không phân loại được.
2. Chạy `npm run gate:truoc-push` cho kế hoạch đó; `--full` chỉ khi cần toàn bộ active gates. Không chạy riêng typecheck/strict/lint rồi lặp lại cùng phép kiểm trong gate. Chờ CI bằng `npm run ci:wait -- --sha <sha>`, không vòng sleep/dispatch.
3. Cửa đỏ: sửa và chạy đúng kiểm bị ảnh hưởng. Giữ receipt xanh của đầu vào không đổi; chỉ kiểm lại khi source/dependency thay, có lỗi mới hoặc nghi vấn cụ thể. Không mặc định full rerun.
4. Báo kết quả, phạm vi, phần chưa kiểm; review/phát hành theo §3. Gate lock thuộc worktree: không xoá lock của tiến trình sống; xử lý untracked của mình trước stage.

## 11. Điều kiện dừng

Dừng thao tác phụ thuộc khi sai đích, thiếu credential, lệch digest/provenance hoặc gate bắt buộc chưa đạt; giữ bằng chứng lỗi, tiếp tục phần độc lập.
Không nuốt lỗi, tăng baseline hoặc gọi phần chưa đo là pass. Quyền thử dữ liệu không thay quyền đổi schema.

## 12. Tra cứu mã nguồn và GitNexus

Tra file/symbol bằng `rg`, đọc imports/callers và tests. Source, Git diff, contract/harness là căn cứ; graph không chứng minh SQL/RLS hay production.
GitNexus tùy chọn qua `scripts/run-pinned-gitnexus.mjs`, pin ở `tooling/agent-tools.json`; chỉ analyze khi thật cần và tối đa một lần/task. Lỗi/hết giờ dùng source; không đưa graph/Understand Anything vào CI hay sinh lại hướng dẫn.

## 13. Hướng dẫn chuyên đề và khoảng trống

Chỉ mở runbook theo thao tác: [migration](MIGRATION_STRATEGY.md), [dữ liệu/org](DATA_ENVIRONMENTS.md), [Network Center](../../infra/network-center-worker/README.md).
[known-gaps](../../tooling/known-gaps.yaml) là khoảng trống hoạt động; đóng bằng evidence, không chép sự cố cũ thành luật. Plan/audit là snapshot, chỉ đọc khi task cần.

## 14. Quy ước code

UI shadcn/Lucide, Tailwind, React Hook Form + Zod; dữ liệu qua hook/service typed, không RPC trực tiếp trong component hoặc thêm cast `any` high-risk.
Giữ loading/error và phân biệt lỗi quyền/validation/concurrency; không trả rỗng che lỗi. Lazy route nặng, đo bundle khi đổi tải trang; file/media đi lớp storage hiện có.
