# Project Contract — hướng dẫn chung cho agent

Áp dụng cho mọi agent làm việc trong repo. `AGENTS.md` và `CLAUDE.md` chỉ chứa cách dùng tool riêng.
Đọc file này một lần, rồi đọc mã và hướng dẫn đúng khu vực đang sửa.
Manifest được liên kết dưới đây sở hữu cấu hình và số liệu; không sao chép chúng thành luật thứ hai.

## 1. Dự án và nguồn tra cứu

iHomeCRM quản lý cho thuê và sổ sách đang vận hành: React/Vite, Supabase, Vercel,
Cloudflare R2, worker Zalo và Network Center.

| Cần biết | Nguồn |
|---|---|
| Phạm vi rủi ro, gate tối thiểu, review độc lập | [risk-map.json](../../tooling/risk-map.json) |
| Phiên bản Node/Deno và package con | [runtime-matrix.json](../../tooling/runtime-matrix.json) |
| Test nào chạy bằng runner nào, ở job nào | [test-matrix.json](../../tooling/test-matrix.json) |
| Tên lệnh đang tồn tại | [package.json](../../package.json) |
| RPC/Edge/realtime và dữ liệu kiểm kê | [surfaces](../../contracts/surfaces/), [generated](../generated/) |
| Nghiệp vụ đang dùng | [docs/he-thong](../he-thong/README.md) |

Không đưa nhật ký sự cố đã đóng hoặc số lượng bảng/test/migration vào hướng dẫn chung.
Lịch sử nằm trong Git; số đo nằm trong manifest hoặc bằng chứng của lần chạy.

## 2. Phạm vi dữ liệu

Ba tổ chức dùng chung database; org TEST chứa bản sao dữ liệu thật.

| Org | ID | Quyền thao tác của agent |
|---|---|---|
| THẬT | `aaaa0000-0000-4000-8000-000000000001` | Chỉ đọc dữ liệu nghiệp vụ |
| DEMO | `dddd0000-0000-4000-8000-000000000001` | Đọc/ghi fixture, tự dọn |
| TEST | `cccc0000-0000-4000-8000-000000000001` | Đọc/ghi để thử tính năng |

- Bảng mới có `organization_id` và RLS phải có policy `<bảng>_hide_sandbox_admin`.
  Bọc phép so sandbox bằng `COALESCE(…, false)` để xử lý đúng dòng NULL.
- SECURITY DEFINER cần tự kiểm quyền: lọc toà qua `can_access_building()` /
  `accessible_building_ids()`; không tự thêm lối tắt `is_super_admin() OR …`.
- Kiểm rò bằng `npm run gate:sandbox-leak`: số bảng rò phải bằng 0; mẫu số theo lần đo.
  Chạy tại checkout đã cấu hình vault và Supabase link; snapshot còn đọc trực tiếp file local.
- E2E chỉ ghi DEMO. Đồng bộ TEST theo [clone-org/README](../../scripts/clone-org/README.md).
- Thay schema production theo §4–5; quyền thử dữ liệu không thay thế quyền đổi schema.

## 3. Git, review và phát hành

- Hạng mục độc lập hoặc dài hơi dùng `git worktree` riêng từ `origin/main`.
  Kiểm `git status` trước khi sửa; giữ nguyên công việc dở dang của phiên khác.
- Commit theo `feat(scope): …`, `fix(scope): …`, `chore(scope): …`; ghi thay đổi, lý do và kiểm chứng.
  Trailer theo adapter agent. Chỉ stage file cụ thể; cấm `git add -A` / `git add .`.
- Trước khi tích hợp: fetch, rebase lên `origin/main`; giải conflict mã nguồn bằng tay.
  Với file máy sinh: lấy bản của main rồi chạy lại generator, kiểm diff trước khi stage.
- Push thường dùng `git push origin HEAD:main`; kiểm trước bằng
  `git merge-base --is-ancestor origin/main HEAD`. Không force-push để vượt conflict.
- Thay đổi tiền, phân quyền, lịch sử migration cần draft PR để review trước khi vào main.
  Review độc lập theo `crossReview` của risk-map.
  PR ghi số đo và gate đã chạy; chưa mở được PR thì báo rõ, không tuyên bố đã mở.
- App phát hành từ nhánh `production`; `main` tạo Preview.
  Docs có cấu hình deploy riêng: kiểm `npm run check:external-controls` khi thay đổi phát hành,
  không suy ra cấu hình hiện tại từ ảnh chụp hoặc số đo cũ.
- Agent được tự commit/push và promote khi đủ bằng chứng. Dùng
  `npm run promote:production -- --sha <sha>` để kiểm CI của đúng commit;
  thêm `--apply` để phát hành sau khi đạt. Không push trực tiếp để bỏ qua kiểm tra.
- Gate đỏ, chưa xong, thiếu bằng chứng hoặc lỗi bị nuốt bởi `continue-on-error` không phải đạt.
  Job kiểm nhánh production chạy sau push; nó không ngăn Vercel nhận một push sai.
- Rollback app bằng deployment đã xác minh trước đó; không rollback schema phá huỷ tự động.
- Hạ tầng: ghim exact image/action/runtime; không bind rộng hoặc retry ngầm thao tác không idempotent.
  Ghi digest/actor/SHA, giữ secret ngoài log/artifact, kiểm rollback bằng artifact thật.

## 4. Ghi schema production và backup

- Dùng `npm run migrate:forward -- <file.sql>` (dry-run mặc định) và `--apply` khi thực thi.
  Không dùng PAT trong vault để ghi thẳng qua Management API, bỏ qua lane.
- Lane mặc định tạo backup và kiểm dump trước khi tự cấp biên nhận apply.
  Đường bỏ backup `--khong-backup "<lý do>"` cần promotion token
  `IHOMECRM_PROMOTION_TOKEN` nhập lúc chạy; không lấy token này từ vault.
- Kiểm đúng project/org/environment, cây làm việc sạch trong worktree đang thao tác, SHA đã review,
  provenance/digest và catalog trước/sau. Thiếu hoặc lệch bằng chứng thì dừng apply.
- Backup cho thao tác schema/backfill ngoài lane: dùng
  `node scripts/backup-before-schema.mjs --reason "<thao tác>"` trước khi ghi.
  Dump và manifest ở `%USERPROFILE%/ihomecrm-backups/`, ngoài Git.
- PITR là rủi ro đã đăng ký trong [known-gaps.yaml](../../tooling/known-gaps.yaml).
  Dump phải đủ điều kiện restore; diễn tập với role/policy Supabase, không chỉ đếm bảng.

## 5. Migration và database

- Cấp tên bằng `node scripts/tao-ten-migration.mjs <slug>`; không chọn timestamp bằng tay.
  Migration mới ở `supabase/migrations/`, immutable sau merge/deploy.
- Stage migration trước `npm run provenance:generate` vì generator đọc index.
  Chạy `npm run gate:migration-provenance`; cutoff và trạng thái lấy từ
  [migration-policy.json](../../supabase/migration-policy.json) và manifest provenance.
- Legacy history **KHÔNG replay được** (có trùng version và file đã hand-apply).
  Không chạy `supabase db push` để phát hành; không replay `migrations-archive/`,
  sửa/đổi tên file đã deploy, hoặc sửa ledger cho lịch sử trông sạch.
- Dựng database mới theo [MIGRATION_STRATEGY.md](MIGRATION_STRATEGY.md):
  baseline đã ghim + forward lane, kiểm trên database dùng một lần.
- Migration phải idempotent. Restore/replay dùng database dùng một lần; một số harness CI có PAT
  kiểm database đích trong ROLLBACK. CI không auto-apply/commit migration production.

| Thay đổi | Kiểm chứng |
|---|---|
| VIEW | `node scripts/check-view-invoker.mjs`; giữ `security_invoker=true` khi CREATE OR REPLACE |
| FUNCTION/RPC | `node scripts/check-stable-fn-locks.mjs`, ACL/owner/search_path và gọi qua PostgREST |
| RLS/POLICY | Harness role thật + JWT, ca được phép và ca cross-tenant bị từ chối |
| Tiền | Cả `npm run gate:reconcile-money` và `npm run gate:reconcile-money-v2`; idempotency + concurrency |
| Schema | Catalog/surface liên quan và generated types (§6) |
| Edge deploy | Kiểm project ref/org thật, cây sạch; ghi SHA đã review + digest bundle trước deploy |

Hàm lấy khoá dòng phải `VOLATILE`: STABLE/IMMUTABLE gọi qua PostgREST có thể lỗi `25006`
dù chạy SQL trực tiếp đạt. Đối chiếu tiền phải bắt cap-1000, không lấy tổng trang đầu làm tổng thật.
Reconcile v1 kiểm phạm vi đọc qua JWT/RLS; v2 kiểm số dư posting. Giữ cả hai khi các đường đọc còn dùng.

## 6. Generated types

```bash
npm run gen:types
npm run types:normalize
npm run types:check
```

Generator tự ghi atomic vào `src/integrations/supabase/types.ts` và thêm header.
Không redirect đầu ra, không sửa generated types bằng tay.
Normalizer bỏ partition runtime theo [generated-types-policy.json](../../supabase/generated-types-policy.json).
`gate:truoc-push` gọi các bước này; thiếu credential/mạng phải báo phần chưa xác minh.

## 7. TypeScript

- Dùng `npm run typecheck:baseline`: không thêm fingerprint vào `ts-baseline.json`.
- Typecheck app trực tiếp: `npx tsc --noEmit -p tsconfig.app.json`.
  Root `tsc --noEmit` không đi theo project references nên không kiểm app.
- Module mới phải strict-clean; tăng strict theo island, không flip toàn repo hoặc tăng baseline để né lỗi.
- Listener `src/app/providers/AuthCacheSync.tsx` chỉ chạy đồng bộ:
  không `await supabase.*` trong callback auth vì có thể deadlock; đăng ký/huỷ trong effect.

## 8. Kiểm thử đúng phạm vi

- Tra runner/lệnh trong test-matrix; không suy rằng mọi test dưới `supabase/functions/` đều chạy Deno.
- Runtime lấy từ runtime-matrix; giữ `deno.lock` của từng function.
  Package con cần `npm ci --prefix <package>` trước test để tránh lấy nhầm thư viện root.
- Chạy test liên quan; thay runtime/UI cần typecheck, build và kiểm bundle.
  Tài liệu hoặc script thuần không cần E2E toàn app.
- Nếu đổi UX, chạy E2E headless cho luồng và vai trò bị ảnh hưởng, kiểm console errors.
- E2E: vào `.e2e-fleet/`, chạy `npx playwright test specs/<file>.spec.ts`, mặc định headless.
  Mật khẩu qua `FLEET_PASS_*`; kiểm console errors; chỉ ghi DEMO và dọn fixture.
  Chỉ bật `FLEET_HEADED=1` khi user yêu cầu hiện trình duyệt.
- Kiểm đột biến bắt buộc cho invariant tiền, phân quyền, cách ly org, migration và gate có thể báo xanh rỗng.
  Dùng `scripts/dot-bien.mjs`: xác nhận hash đổi, suite đỏ đúng lý do, khôi phục trong finally và kiểm hash.
  Ghi neo/digest/kết quả; mã thoát 0 = đạt, 1 = gate bỏ lọt, 3 = không kiểm được.
- Gate quét mã phải bỏ chú thích bằng `scripts/lib/bo-chu-thich.mjs`;
  test phải chứng minh chuỗi trong comment không làm gate báo đạt.
- Giữ LF cho shebang theo `.gitattributes`. Không tính suite bị skip hoặc thiếu runner là pass.

## 8b. Tài liệu AI Copilot

[manifest.json](../he-thong/manifest.json) sở hữu `copilotIngest` và `reviewed`;
frontmatter không lặp hai khoá này. File mới phải khai manifest; file bị loại phải có `why`.
`requiredPermission` áp dụng cả kết quả và gợi ý; khi chưa load quyền, chỉ trả tài liệu không gắn quyền.
Chạy `npm run gate:copilot-docs` khi sửa corpus hoặc registry.

## 9. Credential

- Vault duy nhất là `CLAUDE.local.md` ở checkout chính, bị gitignore; agent được đọc lúc task cần.
  Trong worktree, nạp đúng credential cần dùng vào process env từ vault chính; không tạo bản sao.
- Không commit secret, tạo vault thứ hai, in cả file/token ra log, chat, artifact hoặc commit.
  Biến VITE công khai không phải chỗ để lưu secret.
- Tên credential và preflight: [local-credential-contract.json](../../tooling/local-credential-contract.json).
  Chạy `npm run gate:local-credentials` tại checkout có vault khi cần;
  không chạy preflight vault local trên CI.
- Thiếu/hết hạn credential: báo đúng khả năng bị chặn, không lách bằng key khác.
  Thêm credential cần cập nhật manifest; nghi lộ thì rotate và cập nhật vault.
- Quyền ghi schema theo §4; có credential không tự cấp quyền ghi dữ liệu org THẬT.

## 10. Hoàn tất thay đổi

1. Xác định scope/risk, đọc source và phụ thuộc liên quan; sửa đúng nguyên nhân.
2. Chạy test/gate theo §5–8 và risk-map; sửa lỗi rồi kiểm lại.
3. Chạy `npm run gate:truoc-push`; docs/script thuần có thể dùng `-- --khong-dao-strict`.
   Lệnh tự sinh và stage artifact theo allowlist, rồi chạy gate tĩnh.
   Kiểm cả diff được stage; cảnh báo thiếu credential không chứng minh schema đã khớp.
4. Báo kết quả cụ thể và phần chưa kiểm; commit/push/review/phát hành theo §3.

Gate có lock theo worktree; không xoá lock của tiến trình còn sống.
File untracked của mình có cảnh báo phải xử lý trước khi stage.
Không mở rộng kiểm thử lặp lại khi không có thay đổi, lỗi mới hoặc nghi vấn chưa giải quyết.

## 11. Điều kiện dừng

Dừng thao tác phụ thuộc khi sai đích, thiếu credential, lệch digest/provenance hoặc gate bắt buộc chưa đạt.
Giữ nguyên bằng chứng lỗi và nêu giới hạn xác minh; tiếp tục phần độc lập trong phạm vi được giao.
Không hạ kiểm soát, tăng baseline hoặc nuốt lỗi chỉ để CI xanh.

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

## 13. Hướng dẫn chuyên đề và khoảng trống

Chỉ đọc chuyên đề khi nhiệm vụ cần:
[migration](MIGRATION_STRATEGY.md), [dữ liệu/org](DATA_ENVIRONMENTS.md),
[Network Center](../../infra/network-center-worker/README.md).

Khoảng trống đang mở ở [known-gaps.yaml](../../tooling/known-gaps.yaml).
`npm run gate:known-gaps` báo cáo; `node scripts/check-known-gaps.mjs --strict` dùng khi rà định kỳ.
Đóng bằng kết quả kiểm chứng; gia hạn phải có lý do mới. Không chép gap/sự cố đã đóng sang adapter.

## 14. Quy ước code

- UI dùng shadcn/ui, Lucide; form dùng React Hook Form + Zod.
- Dữ liệu qua hook/domain service có loading/error state; không gọi RPC trực tiếp trong component.
  High-risk dùng wrapper typed, validate kết quả tại boundary; không thêm RPC cast `any`.
  Kiểm bằng `npm run gate:rpc-cast`.
- Tailwind mặc định; CSS riêng phải cô lập và có lý do. File/media theo lớp storage R2 hiện có.
- Sonner/error boundary cho phản hồi; phân biệt permission, validation, concurrency, conflict, internal.
  Không biến lỗi thành dữ liệu rỗng hoặc hiển thị chi tiết kỹ thuật cho người dùng.
- Lazy load route/component nặng, đo bundle khi đổi tải trang.
- Đặt route ở `src/app/routes/`, capability ở `src/app/capabilities/`, page ở `src/pages/`,
  UI domain ở `src/components/`, data hook ở `src/hooks/`, tiện ích/schema ở `src/lib/`.
