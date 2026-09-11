---
status: superseded
reviewed: 2026-09-11
last_verified_commit: f783b02d
source_paths:
  - tooling/agent-tools.json
  - scripts/run-pinned-gitnexus.mjs
  - docs/engineering/PROJECT_CONTRACT.md
  - .github/workflows/ci-gates.yml
copilot_ingest: false
risk: normal
---

# ADR-0004 — Tách hai công cụ tri thức: GitNexus và Understand Anything

> **[LỖI THỜI — BỊ THAY THẾ]** Thay bằng: [Project Contract §12](../engineering/PROJECT_CONTRACT.md#12-tra-cứu-mã-nguồn-và-gitnexus). Nội dung dưới đây ghi quyết định cũ, không mô tả quy trình hiện hành.

## Quyết định hiện hành

Từ 11/09/2026, source, Git diff và contract/harness là căn cứ khi sửa code. GitNexus còn là CLI
local tùy chọn cho quan hệ liên file, đi qua wrapper và pin của repo. Understand Anything không còn
nằm trong luồng agent/CI; repo không track `.ua/`, không đăng ký GitNexus bằng MCP cấp project và
không có gate freshness/hygiene/secret dành riêng cho graph.

CI vẫn chạy regression của wrapper để giữ giới hạn argv, repository scope, timeout và tính toàn vẹn
của index local. Các gate tiền, tenant/RLS, migration/backup/provenance, realtime, runtime/test
matrix, strict, promotion và external controls không phụ thuộc graph.

## Quyết định đã bị thay thế

Ngày 07/08/2026, repo từng tách GitNexus local và UA được commit: GitNexus phục vụ impact analysis,
còn UA phục vụ onboarding/domain map. Freshness và hygiene được cưỡng chế bằng policy, sidecar và
hai gate riêng. Các file đó đã bị gỡ; bản lịch sử tại baseline trước khi gỡ vẫn xem được qua
permalink:

- [graph-policy.json tại f783b02d](https://github.com/zxGreenxz/whiteboard-ihomecrm/blob/f783b02dc0d26a6618092ab5354f284682ed3380/tooling/graph-policy.json)
- [UA manifest tại f783b02d](https://github.com/zxGreenxz/whiteboard-ihomecrm/blob/f783b02dc0d26a6618092ab5354f284682ed3380/tooling/graph-manifests/ua.json)
- [freshness gate tại f783b02d](https://github.com/zxGreenxz/whiteboard-ihomecrm/blob/f783b02dc0d26a6618092ab5354f284682ed3380/scripts/check-graph-freshness.mjs)
- [hygiene gate tại f783b02d](https://github.com/zxGreenxz/whiteboard-ihomecrm/blob/f783b02dc0d26a6618092ab5354f284682ed3380/scripts/check-graph-hygiene.mjs)
- [UA metadata tại f783b02d](https://github.com/zxGreenxz/whiteboard-ihomecrm/blob/f783b02dc0d26a6618092ab5354f284682ed3380/.ua/meta.json)

## Lý do thay thế

UA tạo artifact lớn và kéo theo sidecar, gate, CI cùng hướng dẫn phải đồng bộ dù source vẫn là căn
cứ cuối cùng. GitNexus local có ích khi cần callers/callees, nhưng wrapper hiện tự kiểm snapshot và
từ chối query khi index không dùng được; một gate freshness bắt buộc riêng chỉ lặp lại trách nhiệm
đó. Quy trình mới giữ công cụ theo nhu cầu và dùng source fallback khi không có index.

## Hệ quả

- Người không cài GitNexus vẫn sửa và chạy CI bình thường.
- `graph:analyze` chỉ chạy khi câu hỏi thật sự cần graph và index chưa dùng được.
- Sau khi code đổi, kiểm Git diff, import/caller và test liên quan; graph không chứng minh SQL/RLS,
  production hoặc quyền runtime.
- Hồ sơ đo UA/GitNexus cũ vẫn là bằng chứng lịch sử, không phải hướng dẫn đang hoạt động.
