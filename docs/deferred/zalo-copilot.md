# Zalo và AI Copilot — hồ sơ tạm ngưng

> Tạm ngưng theo yêu cầu ngày 06/10/2026. Chỉ đọc khi người dùng yêu cầu mở lại
> Zalo/Copilot; đây không phải context hoặc backlog phải xử lý của các tác vụ khác.

Phát triển, tối ưu và các phép kiểm chuyên biệt được đưa ra khỏi luồng mặc định.
Phần không chạy phải ghi là **tạm ngưng/chưa kiểm**, không tính là pass hoặc đủ bằng chứng phát hành.
Việc này không xác nhận tình trạng production và không tắt tính năng đang chạy.

## Nguồn giữ lại

Mốc trước khi rút hướng dẫn: `c33ec48ccb17b55cd3e63cc2295e3636d558d6ea`.
Hai README vận hành cũ được giữ nguyên trong Git tại mốc này, gồm inventory, runbook,
giới hạn, bằng chứng và các liên kết mở rộng; đọc lại bằng:

```powershell
git show c33ec48ccb17b55cd3e63cc2295e3636d558d6ea:docs/ai-copilot/README.md
git show c33ec48ccb17b55cd3e63cc2295e3636d558d6ea:docs/zalo/README.md
git show c33ec48ccb17b55cd3e63cc2295e3636d558d6ea:tooling/risk-map.json
git show c33ec48ccb17b55cd3e63cc2295e3636d558d6ea:tooling/known-gaps.yaml
```

Snapshot `risk-map.json` giữ tier Copilot và gate corpus cũ để đối chiếu khi mở lại.
Không phục hồi toàn bộ manifest đè lên các thay đổi mới hơn.

Các nguồn hiện có vẫn giữ trên đĩa để không đổi hành vi ứng dụng:

- [18 — Zalo](../he-thong/18-zalo-chat.md), [21 — AI Copilot](../he-thong/21-ai-copilot.md)
  và [manifest corpus](../he-thong/manifest.json): vẫn thuộc dữ liệu runtime theo manifest,
  dù không còn được dẫn từ mục lục làm việc của agent.
- [Runbook worker Zalo](../zalo/ZALO-WORKER-SETUP.md), `worker/`, `src/copilot/`,
  `supabase/functions/llm-proxy/`: đọc theo đúng phần được giao khi mở lại.
- Plan, audit và evidence cũ giữ làm hồ sơ; không tự thi công lại checklist chưa đóng.

## Quy tắc corpus chuyển từ Contract §8b

[manifest.json](../he-thong/manifest.json) sở hữu `copilotIngest` và `reviewed`;
frontmatter không lặp hai khoá này. File mới phải khai manifest; file bị loại phải có `why`.
`requiredPermission` áp dụng cả kết quả và gợi ý; khi chưa load quyền, chỉ trả tài liệu không gắn quyền.
Chạy `npm run gate:copilot-docs` khi sửa corpus hoặc registry.

Đoạn trên áp dụng khi phạm vi này được mở lại, không yêu cầu chạy gate chuyên biệt
cho công việc khác trong thời gian tạm ngưng.

## Gap chuyên biệt tạm ngưng

Ba mục được đưa khỏi `tooling/known-gaps.yaml` đang hoạt động, chưa được coi là đã đóng:

- `copilot-plan-reconcile-unknown-effect`
- `copilot-approval-badge-system-source-not-exposed`
- `copilot-golden-eval-real-lane-daily-quota`

Snapshot Git ở trên giữ nguyên lý do, hạn rà lại và điều kiện đóng để khôi phục từng mục
khi mở lại. Gap `e2e-copilot-khong-co-trace` vẫn hoạt động: rủi ro mật khẩu trong report/trace
áp dụng cho mọi E2E Fleet, dù id cũ nhắc Copilot.

## Ghi chú chờ đối chiếu

Đây là kết quả đọc source tại mốc trên, chưa phải kiểm runtime:

- `docs/he-thong/99-quy-trinh-tong.md` còn mô tả xác nhận do model tự khai;
  `src/copilot/tools/writeTools.ts` và tài liệu 21 đã mô tả nonce server.
  Khi mở lại, hợp nhất mô tả theo source và bằng chứng mới.
- Tài liệu Zalo còn xen lẫn “chưa có handler media” với phần đã triển khai.
  `src/components/chat-zalo/Composer.tsx` và `worker/lib/queue.js` có đường gửi media;
  phiên worker đang chạy cần xác minh riêng, không suy từ bản web.
- `worker/README.md` chưa nêu đủ khóa phiên bắt buộc; `worker/index.js` từ chối chạy
  khi thiếu/sai `ZALO_SESSION_KEY`. Runbook và `.env.example` có hướng dẫn hiện có.
- README Copilot cũ có khối `COPILOT_TOOL_INVENTORY` do máy sinh. Khi mở lại,
  khôi phục hoặc chọn lại đích tài liệu của generator trước khi bật kiểm inventory.

## Khi người dùng mở lại

1. Chốt phần cần làm; đối chiếu source, manifest và trạng thái triển khai lúc đó.
   Snapshot Git ở trên giúp khôi phục thông tin, không thay sự thật hiện tại.
2. Đưa lại routing và các phép kiểm chuyên biệt phù hợp vào luồng làm việc;
   ghi rõ bằng chứng nào đã cũ, chưa chạy hoặc thiếu điều kiện.
   Danh sách hoãn nằm ở `tooling/deferred-modules.json`, các suite riêng có
   `status: deferred` trong `tooling/test-matrix.json`. Workflow `copilot-e2e.yml`
   đã bỏ cron và khóa job bằng `if: false`; CI thường đã rút các bước chuyên biệt.
   Khôi phục có chọn lọc từ snapshot Git ở trên, rồi kiểm runner thực sự chọn test.
3. Nghiệm thu phần được thay đổi theo Contract và risk-map đang có hiệu lực.
   Không tuyên bố hệ thống đã được kiểm chỉ vì gỡ trạng thái tạm ngưng.
