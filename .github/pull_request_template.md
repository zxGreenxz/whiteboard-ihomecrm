<!--
Repo này deploy production từ Vercel và chứa sổ sách tiền thật. Template không
phải thủ tục hành chính — nó là chỗ ghi BẰNG CHỨNG đã chạy gì, để lần sau đọc
lại còn biết. Xoá phần không liên quan, đừng để nguyên ô trống.
Bảng rủi ro theo đường dẫn: tooling/risk-map.json
-->

## Mục tiêu

<!-- Một đoạn: sửa gì và VÌ SAO. "Vì sao" quan trọng hơn "sửa gì". -->

## Phạm vi

<!-- File/khu vực đã chạm. Nếu có thay đổi ngoài mục tiêu, nói rõ vì sao gộp vào đây. -->

## Tier rủi ro

<!--
Đừng tự tra tay — chạy `npm run risk:classify` để nó đọc diff so với origin/main,
tra tooling/risk-map.json rồi in tier nghiêm nhất kèm ĐÚNG danh sách gate phải chạy.
Thêm `--json` nếu muốn dán máy đọc được, `--files a.ts,b.sql` nếu chưa commit.

Nó là bộ BÁO CÁO, không phải cửa chặn: nó biết PR này cần gate nào, nhưng KHÔNG
biết bạn đã chạy hay chưa — không có dấu vết nào trong repo để đọc. Phần đánh dấu
bên dưới vẫn là lời khai của bạn.

Một PR có thể thuộc nhiều tier — chọn hết.
-->

- [ ] `docs` — tài liệu
- [ ] `product-surface` — route / nav / launcher
- [ ] `copilot` — tool hoặc tài liệu Copilot đọc
- [ ] `agent-contract` — CLAUDE/AGENTS/AI_RULES/PROJECT_CONTRACT/tooling
- [ ] `money` — **cross-review bắt buộc**
- [ ] `authorization` — **cross-review bắt buộc**
- [ ] `migration` — **cross-review bắt buộc**
- [ ] `infrastructure` — **cross-review bắt buộc**

## Đã chạy gì

<!-- Dán KẾT QUẢ, không phải tên lệnh. "typecheck xanh" không phải bằng chứng. -->

- [ ] `npm run typecheck:baseline` — số fingerprint:
- [ ] Test liên quan (ghi rõ file + số test):
- [ ] `npm run build`
- [ ] Gate theo tier (`gate:*`, xem risk-map):
- [ ] E2E headless nếu đụng UX — console errors đã kiểm:

### Đột biến (bắt buộc nếu thêm/sửa logic có nhánh điều kiện)

<!--
Test xanh chỉ chứng minh test CHẠY, không chứng minh nó BẮT ĐƯỢC lỗi. Cố tình
phá logic, xác nhận đúng test đỏ, rồi hoàn nguyên. Ghi lại đã phá gì và test nào đỏ.
Ba gate gần đây đều có bản đầu bị lỗi mà test xanh không phát hiện.
-->

- Đã phá:
- Test đỏ đúng như mong đợi:
- Đã hoàn nguyên:

## Nếu chạm runtime (`src/`, `api/`, `vite.config.ts`, dependencies)

<!-- Chừng nào Vercel còn deploy từ main thì push = phát hành. -->

- [ ] Đã kiểm **bundle sau build**, không chỉ tin test
      <!-- Vitest và production build khác nhau ở khoản nạp asset: một
           import.meta.glob hỏng vẫn có thể xanh trong test rồi rơi về rỗng. -->

## Nếu chạm database

- [ ] Migration mới, timestamp 14 chữ số duy nhất, **không sửa file cũ**
- [ ] Gate theo loại object (view invoker / stable-fn locks / RLS role thật)
- [ ] `npm run gen:types && npm run types:normalize` nếu đổi schema
- [ ] `npm run catalog:check`
- [ ] Đối chiếu tiền nếu đụng writer tiền
- [ ] **Đã kéo dump trước khi apply** — PITR đang TẮT, RPO ~24 giờ

## Phát hành

- Feature flag:
- Migration cần apply:
- Đường lùi nếu hỏng:
- Dữ liệu bị chạm:

## Chưa xác minh được

<!--
Mục quan trọng nhất của template này. Ghi thẳng phần chưa kiểm được và VÌ SAO
(thiếu công cụ, cần thiết bị thật, cần dữ liệu production…). Im lặng ở đây bị
đọc thành "đã kiểm hết" — đó là cách một khoảng trống trở thành sự cố.
-->
