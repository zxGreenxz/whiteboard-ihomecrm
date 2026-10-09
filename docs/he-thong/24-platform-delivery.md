---
status: current
last_verified_commit: eb7e2208
source_paths:
  - .github/workflows/ci-gates.yml
  - .github/workflows/supabase-migrate.yml
  - .github/workflows/network-center-validation.yml
  - scripts/promote-to-production.mjs
  - scripts/check-production-promotion.mjs
  - scripts/kiem-nhanh-truoc-push.mjs
  - scripts/apply-reviewed-migration.mjs
  - scripts/deploy-edge-fn.mjs
  - scripts/check-external-controls.mjs
  - contracts/surfaces/edge-function-surface.json
  - vercel.json
risk: infrastructure
---

# Phát hành nền tảng

[Project Contract §3–§5](../engineering/PROJECT_CONTRACT.md) sở hữu điều kiện review, credential,
backup và quyền phát hành. Trang này chỉ chỉ ra đường chạy và nguồn kiểm chứng.

## 1. Bốn đường lên production

| Phần thay đổi | Đường phát hành | Bằng chứng |
|---|---|---|
| Web | Push `main` → CI/Preview → `promote:production` → nhánh `production` → Vercel | CI đúng SHA, deployment READY, alias và build SHA trên website |
| Schema | `migrate:forward` qua lane đã review | Backup/receipt, provenance và catalog trước/sau |
| Edge Function | Deploy riêng từng function trong phạm vi | Project ref, revision/digest và kiểm caller/auth |
| Worker/VPS | Rollout theo subsystem | Manifest, preflight, verifier và rollback tương ứng |

Push `main` không tự apply schema, deploy Edge hoặc rollout worker.

## 2. Web và kiểm chứng phát hành

Sau khi commit đã qua CI trên `main`, dùng lệnh trong
[package.json](../../package.json):

```bash
npm run promote:production -- --sha <sha-40-ky-tu>
npm run promote:production -- --sha <sha-40-ky-tu> --apply
```

Lệnh đầu kiểm điều kiện; lệnh thứ hai kiểm lại trước khi fast-forward `production`.
Script kiểm kết quả từng bước CI, kể cả lỗi bị `continue-on-error` che.
`--wait-seconds` chỉ chờ bằng chứng chưa hoàn tất; lỗi thật hoặc không đọc được API vẫn chặn.

Job `production-promotion` xác minh sau push trên nhánh `production`.
Chạy CI thủ công trên `main` không chạy job này, tránh việc CI tự chờ chính nó.
Không push trực tiếp `production` để bỏ qua script. Rollback web dùng deployment cũ đã xác minh.

Cấu hình Vercel nằm ngoài Git; kiểm bằng `npm run check:external-controls`.
Sau phát hành, kiểm READY, alias đích và build SHA thực tế. CI xanh chưa chứng minh website đã đổi.
Docs có project riêng, lấy nội dung từ `docs/huong-dan-su-dung/`; quy tắc bỏ qua build ở
[vercel-ignore-docs.sh](../../docs-site/scripts/vercel-ignore-docs.sh).

## 3. CI và kiểm tra tại máy

[ci-gates.yml](../../.github/workflows/ci-gates.yml) quy định trigger/điều kiện thực thi;
[test-matrix.json](../../tooling/test-matrix.json) quy định test thuộc runner/job nào.

- `quality-gates` chạy gate tĩnh, typecheck và lint; `build-gates` chạy build/bundle/docs;
  `suite-tests` chạy Node, Deno và e2e offline. Ba job chạy song song cùng `vitest-tests`.
- Lệnh dài chia phần (`SHARD_COUNTS` trong gate-registry): phần k chạy ở job `<job>-k`, mỗi phần
  một biên nhận, aggregate đòi đủ mọi phần. Timezone luôn 4 phần, mỗi phần đủ mọi múi giờ và
  vẫn đòi kết quả giống hệt; root Vitest chia 3 phần khi CI chọn từ 200 file trở lên.
- Strict, timezone và secret scan vẫn độc lập. Timezone kiểm cùng tập test dưới các múi giờ đã khai.
- Gate cần credential (realtime, security, types, cross-tenant, reconcile) chỉ chạy ở push/dispatch
  trên main. Lượt PR ghi chúng là "CHƯA KIỂM — chờ main", không tính là đạt; job bị skip vì thiếu
  credential không phải bằng chứng đã kiểm database.
- Lượt push main đầu tiên của SHA đã có lượt PR xanh trong 24 giờ (cùng repo, PR vào main) chỉ dùng
  lại biên nhận `static` khớp gate, lệnh, cây file, base của plan, digest policy/runtime và Node.
  Base lượt PR là đầu main, base lượt main là đầu production, nên ít khi khớp. Gate `external`/`live`
  (gồm timezone) luôn chạy; chạy lại lượt main thì không dùng lại.
- Promote đòi artifact `gate-aggregate` của lượt main đúng SHA có plan phủ dải production..SHA, các
  workflow ngoài mà plan đòi, và mọi lượt main khác của SHA đó đã xong, không bước nào đỏ.
- Network Center có [workflow riêng](../../.github/workflows/network-center-validation.yml).
  Chọn runner và môi trường theo manifest, không chạy lại suite bằng runner khác.

Trước push, stage đúng file source/test của thay đổi rồi chạy `npm run gate:truoc-push`
theo Contract §10. Lệnh sinh artifact theo allowlist; kiểm diff staged trước commit.
Không sửa tay số liệu trong `docs/generated/`; sửa nguồn rồi chạy generator và renderer.
Gộp artifact đúng với commit chức năng để tránh thêm một vòng CI chỉ sửa số.

## 4. Schema, Edge và worker

Schema dùng `npm run migrate:forward -- <file.sql>` để dry-run; thêm `--apply` khi đủ điều kiện.
Lane mặc định tạo và xác minh backup/receipt. Đường bỏ backup yêu cầu token lúc chạy theo
Contract §4; không coi PAT là quyền bỏ lane. CI validation không auto-apply migration.

Edge không gắn với push Git. Tra [README functions](../../supabase/functions/README.md)
và [manifest Edge](../../contracts/surfaces/edge-function-surface.json) để phân biệt source,
deployment và caller. Manifest được cập nhật bởi `surface:edge`, gồm cả bước trong gate trước push;
`gate:edge-surface` đối chiếu với catalog live. Không suy trạng thái deploy từ số thư mục.
Function tắt gateway JWT phải xác thực caller trong thân function.

Worker và scheduler theo [Network Center](../../infra/network-center-worker/README.md).
Vercel Cron khai ở [vercel.json](../../vercel.json); pg_cron và scheduler VPS có trạng thái riêng.
Chỉ thay hoặc xác nhận scheduler khi đã kiểm đúng hệ thống đích; rollback web không rollback database.
