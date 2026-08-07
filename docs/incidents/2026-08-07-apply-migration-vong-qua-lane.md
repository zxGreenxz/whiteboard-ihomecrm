---
status: current
reviewed: 2026-08-07
last_verified_commit: 354489b6
source_paths:
  - scripts/apply-reviewed-migration.mjs
  - scripts/apply-sql.mjs
  - scripts/apply-migration.mjs
  - scripts/check-management-api-writes.mjs
  - scripts/check-migration-ledger-frozen.mjs
  - scripts/check-forward-migration-idempotent.mjs
  - supabase/migrations/20260807140000_ie_guard_handover_scope.sql
  - tooling/known-gaps.yaml
copilot_ingest: false
risk: infrastructure
---

# 2026-08-07 — Migration đi vòng qua lane chính thức

**Mức độ:** không có thiệt hại dữ liệu · rủi ro đã nhận là cao
**Thời gian:** 07/08/2026, trong ngày
**Ai phát hiện:** chủ dự án, khi rà lại sau khi việc đã xong

---

## Chuyện gì đã xảy ra

Migration `20260807140000_ie_guard_handover_scope.sql` được apply lên production
bằng cách POST thẳng nội dung SQL tới Management API
(`/v1/projects/{ref}/database/query`), thay vì đi qua `npm run migrate:forward`.

Đường đó bỏ qua toàn bộ bốn lớp chặn của lane: kiểm cutoff, kiểm entry provenance,
so digest, và **backup trước khi đổi schema**.

Sau đó mới phát hiện repo có lane chính thức.

## Thiệt hại thực tế: không có

Thay đổi thuần cộng thêm (một nhánh guard + bọc hai hàm). Preflight md5 khớp 100 %.
Dry-run lại qua lane chính thức: xanh. Không mất dữ liệu, không hỏng gì.

## Rủi ro đã nhận: cao, và không đo được tại thời điểm bấm

PITR đang **TẮT** (quyết định có chủ ý, ghi ở `known-gaps.yaml#pitr-disabled-accepted-risk`).
Không có bản dump chụp ngay trước lúc apply, đường lùi gần nhất là bản sao hằng
ngày của Supabase — tức **mất tối đa ~24 giờ sổ sách tiền thật**.

> "Hoá ra không sao" và "lúc đó an toàn" là hai câu khác nhau.
> Nếu nhánh guard khoá nhầm bảng, hoặc hai hàm bọc lệch chữ ký, thì đường lùi là
> một ngày làm việc.

---

## Nguyên nhân gốc: HAI lỗi, cùng trong một hàm

Cả hai nằm ở `goTransactionCuaFile()` — đoạn bóc cặp `BEGIN;`/`COMMIT;` của file
trước khi bọc lại. Lỗi thứ nhất nặng hơn nhiều, và tôi đã bỏ sót nó ở bản đầu của
tài liệu này.

### Lỗi 1 — "DRY-RUN" đã GHI THẬT lên production

Postgres **không có transaction lồng**. Mọi migration của dự án đều tự mở
`BEGIN; … COMMIT;`. Bọc thêm một lớp `BEGIN…ROLLBACK` ra ngoài không tạo lớp thứ
hai: lệnh `BEGIN` thứ hai chỉ ném cảnh báo rồi bị bỏ qua, còn `COMMIT` **bên
trong** đóng luôn transaction **ngoài**. `ROLLBACK` cuối cùng rơi vào chỗ không
còn transaction nào — thành no-op.

Kết quả: dòng chữ `Chế độ : DRY-RUN (bọc ROLLBACK)` in ra màn hình **trong khi dữ
liệu đã ghi thật**. Một policy RLS đã vào production qua đúng con đường được quảng
cáo là an toàn nhất, đi vòng qua cả cửa promotion token lẫn cửa backup.

> Đây là kiểu hỏng tệ nhất trong cả sự cố: không phải một cửa chặn từ chối nhầm,
> mà là một cửa chặn **nói dối về việc nó đã làm gì**.

### Lỗi 2 — lane từ chối migration hợp lệ

**Người apply không cẩu thả. Lane từ chối một migration hoàn toàn hợp lệ.**

`scripts/apply-reviewed-migration.mjs` bóc cặp `BEGIN;`/`COMMIT;` do file tự mở,
bằng cách tìm lệnh kết thúc transaction đứng một mình trên một dòng:

```js
const CAU_LENH_KET_THUC = /^[ \t]*(COMMIT|ROLLBACK|END)[ \t]*;[ \t]*$/gm;
```

Comment ngay cạnh đó đã lường trước rằng plpgsql cũng có `BEGIN` — và cố ý không
khớp nó, vì `BEGIN` của plpgsql **không có dấu chấm phẩy**.

Nhưng `END` của plpgsql thì **có**:

```sql
CREATE OR REPLACE FUNCTION public.vi_du() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
END;          -- ← runner đọc dòng này là "kết thúc transaction"
$$;
```

Kết quả: runner đếm 3 lệnh kết thúc trong file (`END;`, `END;`, `COMMIT;`), kết
luận file sai định dạng, và từ chối.

### Mức lan — đo được, không phải phỏng đoán

| | |
|---|---|
| Migration sau cutoff `20260805120000` | 4 |
| **Bị lane từ chối SAI** | **3** |

Ba file: `20260806090000_commission_voucher_attachments`,
`20260807140000_ie_guard_handover_scope`, `20260807160000_chung_building_org_scope`.

Nghĩa là lane **không nuốt nổi migration nào định nghĩa hàm plpgsql** — gần như
mọi migration của repo này.

> Một cửa chặn từ chối nhầm việc hợp lệ sẽ **luôn** bị đi vòng, và mọi luật viết
> thêm về nó đều vô nghĩa cho tới khi nó mở được.

---

## Vì sao không có gì phát hiện ra

Luật "chỉ đổi schema qua `migrate:forward`" đã nằm trong Contract từ trước. Nó
không giúp gì, vì nó **chỉ là chữ**:

- `check-no-auto-apply.mjs` chỉ canh `supabase db push` trong khối `run:` của
  GitHub workflow — không nói gì về Management API.
- `scripts/apply-sql.mjs <file.sql>` là **đúng một lệnh**, không kiểm gì.

Và ledger `supabase_migrations.schema_migrations` — nguồn bằng chứng cho 351 khẳng
định `ledger-applied` trong provenance — không có ai canh.

---

## Đã sửa

| Việc | Ở đâu |
|---|---|
| Bóc transaction bỏ qua vùng dollar-quote | `cheDollarQuote()` trong lane |
| 8 ca (vitest) phủ cả hai lỗi | `scripts/__tests__/apply-reviewed-migration.test.mjs` |
| 7 ca (node:test) phủ thêm: hai hàm plpgsql/file, tag `$fn$`, dollar-quote mở-không-đóng | `scripts/__tests__/apply-reviewed-migration-transaction.test.mjs` |
| Chặn caller GHI mới ngoài lane | `scripts/check-management-api-writes.mjs` |
| Hai đường thô đòi promotion token | `apply-sql.mjs`, `apply-migration.mjs` |
| Canh ledger không bị viết lại | `scripts/check-migration-ledger-frozen.mjs` |
| Kiểm chứng idempotency thay vì tin lời khai | `scripts/check-forward-migration-idempotent.mjs` |
| Lane tự chạy được, biên nhận backup thay token | `apply-reviewed-migration.mjs` |

### Một chỗ tôi đo sai khi viết tài liệu này

Bản đầu ghi "vùng bóc transaction có ĐÚNG MỘT test, không ca nào chạm plpgsql".
Sai cả hai vế. File `scripts/__tests__/apply-reviewed-migration.test.mjs` là
**vitest**, còn tôi chạy `node --test` lên nó — trình chạy đó không hiểu
`describe()` nên đếm cả file thành một. Chạy đúng bằng vitest: **8 ca**, và một
trong số đó tên là *"KHÔNG nhầm `END;` của thân plpgsql là lệnh đóng transaction"*.

Bài học nhỏ nhưng đúng chủ đề của chính sự cố này: **một phép đo sai làm bằng
chứng thì tệ hơn không đo**. Tôi suýt ghi vào sổ sự cố rằng vùng code đó không có
test, trong khi nó có bộ test tốt hơn bộ của tôi ở vài ca.

### Hợp thức hoá

Đã apply lại qua lane chính thức:

```
backup      144s · 24,2 MB · 567 bảng có dữ liệu
giấy phép   bien-nhan-backup · 64283433567f5238
provenance  catalog-proven (bằng chứng: hai hàm nó định nghĩa có thật trên server)
```

Idempotency kiểm chứng sau: **4/4** migration sau cutoff chạy lại được lần hai.

---

## Bài học

**1. Một luật không có cửa chặn là một lời đề nghị.**
Luật này nằm trong Contract nhiều tuần và không ngăn được gì.

**2. Trước khi trách người đi đường tắt, hỏi xem đường chính có mở không.**
Phản xạ đầu tiên là siết luật. Nhưng siết một luật mà cửa chính đang đóng chỉ tạo
thêm áp lực đi vòng. Nguyên nhân gốc nằm ở một biểu thức chính quy.

**3. Một cửa chặn nói dối về việc nó đã làm gì là loại hỏng tệ nhất.**
"DRY-RUN (bọc ROLLBACK)" in ra màn hình trong khi dữ liệu đã ghi. Người chạy không
có cách nào biết. Mọi lớp bảo vệ phía sau đều vô nghĩa khi lớp đầu tiên báo cáo sai.

**4. Tự động hoá phải cưỡng chế thứ ĐO ĐƯỢC, không phải thứ nghe cho yên tâm.**
Token cũ gộp "có người dừng lại nhìn" với "có điểm khôi phục nếu hỏng". Với PITR
tắt, chỉ vế sau quyết định thiệt hại — và người gõ token chưa bao giờ tạo ra bản
dump đó. Luật mới cưỡng chế đúng vế sau, và ở một chiều còn chặt hơn.

---

## Còn mở

- **PITR vẫn tắt.** Rủi ro được chấp nhận có chủ ý — `known-gaps.yaml#pitr-disabled-accepted-risk`.
- **Không còn ai xem lại NỘI DUNG migration** trước khi nó chạm production. Ba lớp
  còn lại (cutoff, provenance, digest) kiểm *xuất xứ*, không kiểm *ý định*. Đây là
  cái giá của việc tự động hoá hoàn toàn, và nó là một lựa chọn, không phải sơ suất.
- **Idempotency mới phủ lớp lỗi NÉM.** Lớp ghi đè im lặng (`INSERT` thiếu
  `ON CONFLICT` chèn hai dòng) cần database dùng-một-lần để so trạng thái từng lượt.
