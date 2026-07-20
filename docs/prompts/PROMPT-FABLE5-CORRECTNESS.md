# Prompt (Fable 5) — Rà soát tính đúng đắn dữ liệu & tối ưu code

> Bản rút gọn của `PROMPT-HOI-DONG-PHAN-TICH-THUC-TE.md`, chỉnh cho **Fable 5**.
> Phạm vi cố ý **BỎ nhánh bảo mật** (RLS/RBAC/SECURITY DEFINER/Storage/Auth/anon exposure)
> — chủ dự án tự review riêng. Prompt này chỉ lo **correctness nghiệp vụ, dòng tiền,
> atomicity/idempotency/concurrency, migration drift, silent failure, cap-1000, timezone
> và tối ưu hiệu năng/maintainability**.
>
> Đây là công việc **coding & data-integrity thường quy** trên repo do chính chủ sở hữu,
> có quyền đọc code và truy vấn database read-only. Không phải khai thác lỗ hổng.

---

## Cách dùng nhanh

1. Điền khối **Đầu vào** (để `AUTO` nếu muốn agent tự chọn).
2. Dán khối **PROMPT BẮT ĐẦU** vào agent đang mở tại thư mục gốc repo.
3. Cấp quyền: đọc code, chạy lệnh Git an toàn, truy vấn DB **read-only** (SELECT/metadata).
4. `MODE=PROPOSE` để chỉ đề xuất; `MODE=IMPLEMENT_SAFE` để cho phép sửa những thay đổi an toàn.

---

# PROMPT BẮT ĐẦU

Bạn là một kỹ sư senior rà soát repo này để tìm và sửa **lỗi tính đúng đắn dữ liệu và điểm
tối ưu**. Đây là công việc bảo trì phần mềm bình thường trên codebase của chính người yêu cầu.
Mọi kết luận quan trọng phải dựa trên **bằng chứng truy ngược được** (code hiện hành, định nghĩa
live DB, hoặc dữ liệu/query live) — không suy ra hành vi hệ thống chỉ từ tên hàm, comment hay tài liệu.

## 1. Đầu vào

```text
CENTRAL_QUESTION = {{AUTO hoặc câu hỏi trung tâm về correctness/hiệu năng}}
SCOPE            = {{AUTO hoặc domain/luồng/file}}
MODE             = {{PROPOSE | IMPLEMENT_SAFE}}
DEPTH            = {{FOCUSED | DOMAIN | SYSTEM_WIDE}}
LIVE_DB_ACCESS   = {{AVAILABLE_READ_ONLY | UNAVAILABLE}}
OUTPUT_PATH      = {{docs/ra-soat-YYYY-MM-DD.md hoặc để trống = in ra màn hình}}
```

Nếu `AUTO`: chọn luồng end-to-end có blast radius lớn nhất về **tiền/trạng thái nghiệp vụ**
(ưu tiên thu tiền, cọc/doanh thu, lương/lợi nhuận, chỉ số/hoá đơn), nêu rõ phần cố ý không khảo sát.

## 2. Câu hỏi cần trả lời

1. **Hệ thống thật sự đang làm gì?** — đường chạy thực từ UI → hook → Supabase/RPC → table/view → báo cáo.
2. **Có đúng nghiệp vụ không?** — state transition, công thức, bất biến bảo toàn tổng, side effect.
3. **Có bền vững không?** — atomicity, concurrency, idempotency, retry, migration drift, cron.
4. **Người dùng có thấy lỗi không?** — loading/error/empty, `catch → []`, mutation không check `.error`, toast sai.
5. **Nên làm gì tiếp?** — xếp hạng theo rủi ro, giá trị, effort, rollback, acceptance criteria.

> **Ngoài phạm vi (bỏ qua):** RLS/RBAC, SECURITY DEFINER scope, grants/anon exposure, Storage/Auth
> policy, tenant isolation, PII leak. Nếu vô tình gặp vấn đề bảo mật, chỉ **ghi 1 dòng ghi chú**
> "→ để chủ tự review bảo mật" rồi tiếp tục; KHÔNG phân tích sâu, KHÔNG sửa.

## 3. Quy tắc bằng chứng

Gắn nhãn mỗi nhận định đáng kể:

- **FACT** — xác minh trực tiếp bằng code hiện hành / định nghĩa live DB / dữ liệu-query live / tái hiện runtime.
- **INFERENCE** — suy luận từ nhiều FACT (nêu chuỗi suy luận).
- **HYPOTHESIS** — nghi vấn chưa kiểm chứng (chưa được coi là bug xác nhận).
- **UNKNOWN** — thiếu dữ liệu/quyền; nêu cách đóng khoảng trống.

Chuẩn trích dẫn: `path/to/file.ts:120-168` + tên hàm/hook; hoặc `schema.object_name` + signature/định nghĩa;
hoặc mô tả SQL read-only + số dòng/tổng + timestamp. Không dùng "có vẻ/thường là/theo tài liệu" trong kết luận cuối.

Thứ tự đối chiếu nguồn sự thật (báo **DRIFT** khi mâu thuẫn): runtime → live DB → working tree → HEAD/deploy → migrations/types → docs.

## 4. Hàng rào an toàn

- **DB production chỉ đọc:** chỉ `SELECT`/`WITH ... SELECT`/metadata (`pg_catalog`/`information_schema`).
  KHÔNG `INSERT/UPDATE/DELETE/ALTER/DROP/CREATE`, KHÔNG gọi RPC ghi, KHÔNG thao tác Storage/Auth,
  KHÔNG gọi hàm volatile trong SELECT. Dùng `LIMIT`/scope thời gian cho query chi tiết; aggregate
  quan trọng phải chạy `COUNT/SUM/GROUP BY` trong SQL (tránh chỉ tổng 1.000 dòng đầu ở client).
- **Không mutate production để "thử".** Cần seed/mutation để tái hiện thì chỉ đề xuất kế hoạch.
- **Migration:** nếu cần schema change, chỉ **viết file** `supabase/migrations/` để chủ tự apply — KHÔNG apply lên live.
- **Secret/PII:** đọc credential từ local/env trong runtime; KHÔNG in PAT/JWT/service-role/password/connection-string
  hay tên/SĐT/CCCD/số tài khoản khách vào output. Dùng ID rút gọn + aggregate.
- **Quyền sửa code:**
  - `PROPOSE`: chỉ đề xuất + patch mẫu, không đổi implementation.
  - `IMPLEMENT_SAFE`: được sửa những thay đổi **an toàn, không đổi hành vi ngoài ý muốn** (vd loại double-write,
    thêm atomic increment/lock, chuẩn hoá aggregate thay client-reduce, phân biệt error-state vs empty-state,
    check `.error` còn thiếu, thêm index thiếu qua migration file). Sau mỗi cụm sửa phải chạy
    `npx tsc --noEmit -p tsconfig.app.json` + `npx vitest run --dir src` và báo kết quả.
    KHÔNG refactor lớn/đổi kiến trúc nếu chưa được duyệt.

## 5. Quy trình

**Vòng 0 — Đóng băng hiện trường:** đọc `CLAUDE.md`/`CLAUDE.local.md`; ghi branch, `git rev-parse HEAD`,
`git status --short`, diff chưa commit. Không reset/stash/checkout thay đổi của người dùng.

**Vòng 1 — Khảo sát:** map đường chạy trong SCOPE; nêu 5–10 giả thuyết rủi ro (correctness/perf) + query read-only cần chạy.

**Vòng 2 — Bản đồ end-to-end:** với mỗi bước ghi rõ: client hay server, cùng transaction hay nhiều bước rời,
sync hay async, source-of-truth hay mirror/snapshot, nơi lỗi có thể bị nuốt/retry.

**Vòng 3 — Kiểm chứng:** đọc chính xác hàm/hook + mọi caller/callee; search toàn repo tránh kết luận từ dead-code.
Đối chiếu live DB: column/type/default/check/FK; function signature/body/volatility/search_path; trigger order;
view definition; index/unique/partial; migration live-vs-file; row count/status distribution/orphan/duplicate/aggregate invariant.

**Vòng 4 — Sửa (nếu IMPLEMENT_SAFE):** áp dụng fix an toàn, chạy typecheck+test, ghi lại từng file đã đổi.

## 6. Checklist bug-class (chỉ correctness/perf — repo này)

- **Dòng tiền:** payment và phiếu ledger có cùng transaction; retry có duplicate; mirror client có partial write.
- **Canonical ledger:** báo cáo nào đọc ledger vs cộng trực tiếp payment/invoice; có double count.
- **Cọc/doanh thu/cấn trừ/tiền thối/credit:** nhận diện bằng cột hay bằng tên/mô tả; `kqkd`/allocation bảo toàn tổng;
  **excess_amounts có bị ghi 2 lần** (RPC tự ghi + hook ghi lại).
- **Kỳ kế toán:** period lock thật ở DB; backdate/update/delete có lệch snapshot đã chốt.
- **Concurrency:** recompute dùng full `SUM` / row lock / advisory lock hay read-modify-write dễ lost update;
  idempotency có DB uniqueness hay chỉ lookup-trước-lock.
- **Migration drift:** file đã commit chưa live, live đã apply thiếu file, function bị bản cũ redefine, generated types trôi.
- **Soft delete/FK:** aggregate có lọc `deleted_at`; `ON DELETE CASCADE` mất chứng từ/audit.
- **Timezone VN:** default ngày trước 07:00, cuối tháng, parse `YYYY-MM-DD`, UTC vs `Asia/Ho_Chi_Minh`.
- **Cap 1.000 dòng:** aggregate/pagination/export chỉ đọc trang đầu.
- **UI silent failure:** query lỗi trả `[]`, mutation không throw, toast thành công trước khi mọi bước xong.
- **Cache:** query key thiếu filter/owner, invalidate sai key, stale sau mutation.
- **Cron/worker:** job có idempotency/dedup/lock; chạy browser hay server.
- **Perf/bundle:** N+1 query, chunk lớn, static+dynamic import conflict, list-reduce nặng ở client.

## 7. Invariant gợi ý (điều chỉnh theo schema live)

```text
1. Số đã thu của HĐ = tổng payment hợp lệ − tiền thối/đảo tương ứng.
2. Mỗi payment tiền thật có đúng số phiếu ledger theo thiết kế; không payment mồ côi.
3. Tổng phân bổ hạng mục của 1 phiếu = tổng phiếu (trong sai số làm tròn).
4. excess_amounts của 1 payment = đúng phần overpay, KHÔNG nhân đôi.
5. Số dư sổ = đầu kỳ + thu APPROVED − chi APPROVED (đủ account leg).
6. Snapshot/chốt kỳ không đổi khi mutation backdate bị cấm.
7. Một phòng ≤ 1 hợp đồng hiệu lực cùng khoảng thời gian.
8. Trạng thái invoice/contract/room nhất quán với dữ liệu nguồn, không chỉ do client set.
9. Retry cùng idempotency key không tạo thêm chứng từ.
10. Report tiền = SQL SUM (không lệch do cap 1.000 dòng client-reduce).
```

## 8. Định dạng báo cáo

In tại `OUTPUT_PATH` nếu được tạo file, ngược lại trả thẳng trong câu trả lời:

1. **Header:** ngày giờ+timezone, branch/HEAD/status, deployed hash (hoặc UNKNOWN), live DB access + thời điểm đối chiếu, mode/depth/scope.
2. **Executive summary:** 5–10 bullet trả lời câu hỏi trung tâm + 3 rủi ro correctness/perf lớn nhất + mức tin cậy + có DRIFT không.
3. **Bản đồ đường chạy:** bảng/mermaid end-to-end, đánh dấu transaction boundary + source of truth.
4. **Bảng phát hiện:**

   | ID | Severity (P0–P3) | Confidence | Trạng thái | Phát hiện | Bằng chứng (file:line / object) | Ảnh hưởng | Query/reproducer | Root cause | Hướng xử lý |
   |---|---|---|---|---|---|---|---|---|---|

   - Mỗi ID một root cause; tách bug hiện tại khỏi tech debt.
   - Nêu dữ liệu lịch sử có thể sai + **cách đo** (không tự backfill).
   - Lỗi chỉ ở working tree chưa deploy → ghi "release blocker", đừng nói production đã hỏng.
5. **Bảng drift:** Object | Working tree | HEAD/deploy | Live DB/runtime | Types/docs | Tác động | Hành động.
6. **Invariant + SQL read-only đã/đề xuất chạy** (số anomaly/aggregate, không dump khách).
7. **Nếu IMPLEMENT_SAFE:** danh sách file đã sửa + tóm tắt thay đổi + kết quả typecheck/test.
8. **Test plan:** happy / partial-boundary-rounding-null / retry-double-submit-network / concurrency /
   soft-delete-cancel / timezone-end-of-month / legacy data / mobile console-network. Mỗi test: setup, action, expected, lớp test.
9. **Kế hoạch hành động theo lớp:** Containment → Correctness fix → Data reconciliation (cần duyệt riêng) →
   Hardening (transaction/lock/idempotency/constraint/observability) → Perf → Refactor (sau cùng).
   Mỗi hành động: dependency, effort, rủi ro, rollback, acceptance criteria.
10. **UNKNOWN / minority opinion / rejected hypotheses.**

## 9. Tiêu chuẩn hoàn tất

- [ ] Đã đọc instruction repo + đóng băng Git state.
- [ ] Đã phân biệt working tree / HEAD-deploy / live DB / docs.
- [ ] Đã truy vết ≥1 luồng end-to-end thật.
- [ ] Mọi P0/P1 correctness có bằng chứng cụ thể.
- [ ] Kết luận tiền có invariant/query hoặc ví dụ số.
- [ ] Không secret/PII trong output.
- [ ] Không mutation production; migration mới chỉ ở dạng file.
- [ ] (IMPLEMENT_SAFE) typecheck + test xanh sau khi sửa.
- [ ] Có drift / unknown / rejected / test plan / kế hoạch theo lớp.
- [ ] Không tuyên bố "đã hoạt động" nếu chưa kiểm chứng runtime.
- [ ] Vấn đề bảo mật (nếu gặp) chỉ ghi chú 1 dòng, để chủ tự review.

## 10. Cách mở phiên

1. In ngắn **Hồ sơ phiên** + giới hạn quyền.
2. Công bố câu hỏi trung tâm/phạm vi đã chuẩn hoá (kèm dòng "phạm vi bỏ qua bảo mật").
3. Chạy Vòng 0–1 bằng công cụ; chưa kết luận sớm.
4. Công bố danh sách giả thuyết correctness/perf.
5. Sau Vòng 3 (và Vòng 4 nếu sửa) mới viết bảng phát hiện + kế hoạch.

Văn phong kỹ thuật, thẳng, súc tích. Ưu tiên bảng/số/trích dẫn. Thiếu bằng chứng thì nói **UNKNOWN**.

# PROMPT KẾT THÚC

---

## Mẫu đầu vào cho iHomeCRM (toàn hệ thống, cho phép sửa an toàn)

```text
CENTRAL_QUESTION = Hệ thống có điểm nào làm sai tiền, ghi nửa chừng (không atomic), trùng lặp khi retry,
                   lệch báo cáo do cap-1000, hay nuốt lỗi âm thầm không? Chỗ nào tối ưu được an toàn?
SCOPE            = Cọc → hợp đồng → chỉ số → hoá đơn → thu tiền → sổ quỹ/bàn giao → lương/lợi nhuận + cron nền
MODE             = IMPLEMENT_SAFE
DEPTH            = SYSTEM_WIDE
LIVE_DB_ACCESS   = AVAILABLE_READ_ONLY
OUTPUT_PATH      = docs/ra-soat-correctness-YYYY-MM-DD.md
```

> Bỏ qua toàn bộ RLS/RBAC/SECURITY DEFINER/Storage/Auth — chủ dự án tự review bảo mật sau.

## Mẫu đầu vào cho một tính năng cụ thể (chỉ đề xuất)

```text
CENTRAL_QUESTION = Luồng {{tên tính năng}} có đúng nghiệp vụ, atomic, idempotent và hiển thị lỗi trung thực không?
SCOPE            = {{route}} → {{dialog}} → {{hook}} → {{RPC/table}} → {{trigger/view/report}}
MODE             = PROPOSE
DEPTH            = FOCUSED
LIVE_DB_ACCESS   = AVAILABLE_READ_ONLY
OUTPUT_PATH      = (in ra màn hình)
```
