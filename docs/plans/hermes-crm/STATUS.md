# Trạng thái triển khai Hermes × iHomeCRM

Cập nhật: 12/10/2026 · Asia/Bangkok. Kế hoạch gốc được duy trì tại [PLAN.md](PLAN.md).

## Điểm tiếp tục

- **Đang làm:** P0 — còn P0.02 inventory chi tiết và P0.03 đối chiếu catalog TEST.
- **Đã có code + kiểm local + review:** P0.01 baseline, phần inventory tĩnh, P0.04 runner có chọn lọc, P0.05 câu hỏi/projection dự kiến.
- **Chưa làm:** tích hợp runtime/auth Hermes, schema/kết nối/user memory, Hermes tổng, UI hoặc gửi tin thật.
- **Worktree:** `C:/Users/Nguyen Tam/codex-worktrees/hermes-crm-foundation-20261012`.
- **Branch:** `codex/hermes-crm-foundation-20261012`.
- **Base:** `7367b7007f096f20471bf1309bc51e0b971439b6` (origin/main sau fetch).
- **Commit code:** `c833d379e6f83b1d0a44ca4964f2cbf7e3831ae6` (tree trùng snapshot local đã kiểm). Chưa merge/phát hành; CI còn phải xác nhận đúng head của draft PR.

## Nhật ký đã xác minh

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

## Bảng tiến độ

| Gói | Trạng thái | Còn thiếu để đóng |
| --- | --- | --- |
| P0 | Đã xong một phần | P0.02: manifest chi tiết/UI controls; P0.03: đối chiếu catalog TEST. P0.04 đã có code, local và review; CI/merge còn chờ |
| P1 | Chưa bắt đầu | Cho phép đúng ca hợp lệ; mọi ca giả danh/cross-org bị chặn; không có đường gọi vòng qua gateway. |
| P2 | Chưa bắt đầu | Tắt Hermes không ảnh hưởng user; không cấp quá quyền; revoke chặn request mới và invalidates context. |
| P3 | Chưa bắt đầu | Đọc đúng dữ liệu; deny không trả rỗng giả; không lộ trường nội bộ/cross-tenant. Dữ liệu không vào context dùng chung; ngân sách, timeout và dừng khẩn cấp đã có hiệu lực. |
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
- Focused command: `node --test scripts/__tests__/generate-hermes-crm-inventory.test.mjs` — 15/15 đạt (agent inventory, 12/10/2026).
- `node scripts/generate-hermes-crm-inventory.mjs --check` — đạt cùng source đầu vào.
- Đã kiểm các mutation: parser mất nguồn, tool trùng, dạng khai báo lạ, permission drift, RPC thiếu và snapshot cũ. Không suy từ các test này rằng quyền runtime đã đúng.
- Snapshot mới bao phủ khai báo tool/action và metadata UI capability; chưa là inventory đầy đủ mọi PageAgent/UI control, scope/input-output/consent/channel/acceptance theo từng dòng của PLAN §07. P0.02 còn mở.
- Hai tool điều phối kế hoạch đang ghi `adapter_decision_required`. Hướng đề xuất: `lap_ke_hoach` qua adapter đề xuất, giữ create/preview/schema/action registry; `thuc_thi_buoc` do executor CRM xử lý sau duyệt qua queue. P1/P3 chứng minh contract và identity, P5 nối thực thi; không gọi lại Copilot chat engine. Chưa đổi disposition trong snapshot khi chưa có contract/evidence.
- Source adapter: `src/copilot/tools/planTools.ts:223,258,292,313`, `src/copilot/plan/planClient.ts:306,425,483,632`. Hai tool hiện `superAdminOnly`; không tự bỏ hạn chế đó khi mở cho user thường. Hook `src/copilot/useHangDoiSauDuyet.ts:58` chưa là queue server bền vững. Coverage UI còn cần `createAgent.ts`, `pageScope.ts`, `safeControls.ts`, `uiControlAvailability.ts`, `safetyGuard.ts` và `COPILOT_PAGE_CONTRACTS`.
- RPC scope source cho `copilot_available_rooms_v1` đòi authenticated và server scope; đường scope còn kiểm membership. Chưa chứng minh superadmin thực tế vào hai org hoặc TEST catalog đồng bộ.

## Đường tiếp tục P1 sau P0

1. Ghim runtime Hermes, kiểm platform/MCP transport; không suy khả năng chạy từ Python có sẵn.
2. Spike loopback với dữ liệu giả: credential hạn chế → user/org/connection server; hai user thường và superadmin, expiry/revoke/forgery.
3. Kiểm profile/process/file isolation thật, không chỉ tạo hai thư mục; broker secrets ngoài vùng runtime.
4. Đọc DATA_ENVIRONMENTS và dùng guard/lock TEST trước kiểm JWT/RPC thật; thử một tool đọc, không cần model trả phí hay gửi Zalo.
5. `npm run test-env:check` có tạo fixture JWT và chạy Chrome, `--sync` thay TEST; không gọi là preflight chỉ đọc. Helper credential có thể tạo seed vào vault. Chỉ nạp key cần dùng qua lane hiện có, không in/sao chép secret.
6. Ghi ADR và evidence offline/TEST riêng; không dùng giả lập thay JWT/RLS thật.

## Việc tiếp theo

1. Kiểm CI đúng head của draft PR trên nhánh đã ghi; CI chưa xanh thì không merge/phát hành. Không chạy lại các phép kiểm có đầu vào không đổi chỉ để tạo thêm evidence.
2. Hoàn thiện P0.02: metadata chi tiết từng năng lực/UI control; ghi disposition đề xuất hai tool kế hoạch và công việc chứng minh adapter P1/P3, không bật chỉ vì có trong snapshot.
3. Hoàn thiện P0.03: đọc DATA_ENVIRONMENTS rồi đối chiếu TEST/catalog và runtime flags theo lane đọc. Không dùng helper tự ghi fixture khi định làm kiểm chỉ đọc.
4. Chuyển P1 khi cửa P0 đạt; P1 preflight vừa qua chưa phải thực thi tích hợp. P1 sẽ chứng minh auth/cách ly trước khi mở dữ liệu và công cụ thực thi.

## Bàn giao session / agent

Đọc PLAN.md để biết quyết định đã duyệt, rồi STATUS.md để tiếp tục đúng điểm. Không tái tạo plan từ PDF/HTML v1.0 hoặc chạy lại script xuất plan cũ. Cập nhật checkbox trong PLAN và ghi việc thực hiện, kiểm chứng, giới hạn, commit/PR ở STATUS sau mỗi phần.

Evidence local nằm ở `.cache/gate-receipts/` (plan và receipt theo gate) và `.cache/hermes-p0/` trong worktree này. Đây là cache chưa commit; không giả định có khi clone sang máy khác. `focused-summary.json` là bản tổng hợp do agent ghi, không phải receipt gốc của runner. Lượt gate đầu: snapshot tree `ae8744095db7fb65d834aa869b10a2d5cc189047`, kết quả 46/47, lưu tại `.cache/hermes-p0/gate-first-failed/`; snapshot mới phải được kiểm theo Contract.

Lượt code đạt: `.cache/hermes-p0/gate-code-passed/`, tree `a05a740f2fc2819f679bbc0795e468567380106b`, base/head khi chạy là `7367b7007f096f20471bf1309bc51e0b971439b6`. Commit code trên có đúng tree này; không đổi nhãn receipt thành CI hoặc runtime evidence. Tài liệu checkpoint cập nhật sau commit code được kiểm theo phạm vi docs riêng.

10 nghĩa vụ chưa kiểm local: app-build, bundle-inventory, check-dependency-audit, check-timezone, docs-build, secret-scan, suite:app-unit và 3 suite edge-deno (bank-events, llm-proxy, quick-entry). UI/E2E, TEST/JWT/RLS và gửi Zalo thật chưa kiểm trong đợt này.

Không `npm install`/`npm ci` qua node_modules junction hiện tại. Không stage toàn bộ worktree: migration EOL và cache nằm ngoài thay đổi. Khi chuyển worktree/máy, lấy đúng branch/commit đã ghi và cài dependency riêng nếu cần.

Prompt tiếp tục gợi ý: “Đọc docs/plans/hermes-crm/PLAN.md và STATUS.md trên nhánh codex/hermes-crm-foundation-20261012. Giữ WIP, xác minh CI hiện tại, tiếp tục P0.02/P0.03; cập nhật hai file sau mỗi phần, không làm lại phần đã có bằng chứng còn hiệu lực.”

## Quy tắc evidence

Source tĩnh không chứng minh runtime; local test không chứng minh production. Chưa có bằng chứng JWT/RLS, RPC live, OAuth/MCP, cách ly profile, model usage hoặc gửi Zalo của Hermes. Không mở ghi/gửi dựa trên tài liệu này.
