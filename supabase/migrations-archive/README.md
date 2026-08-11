# migrations-archive

Chứa các file SQL **KHÔNG được apply** theo luồng migration bình thường. **15 file**, tất cả đều
mang state `superseded` trong [`supabase/migration-provenance.json`](../migration-provenance.json).

- `20260617000001_forfeit_full_settlement.sql` — SUPERSEDED (đánh dấu "KHÔNG APPLY RIÊNG"). Logic đã
  gộp vào migration thanh lý sau đó. Giữ để tra cứu lịch sử.
- `migrations-bundle/` — 14 file `apply_*` hand-apply thời kỳ đầu (Apr–May 2026), áp thủ công một
  lần qua Management API, KHÔNG theo timestamp ordering. Đã phản ánh trong DB live. Giữ để tra cứu,
  **TUYỆT ĐỐI KHÔNG replay**.

## Trạng thái thật của ledger — đừng dùng nó làm trạng thái schema

`supabase_migrations.schema_migrations` có **372 dòng, dừng ở version `20260727095000`** (27/07/2026)
— số đo trong `migration-provenance.json` (`ledgerRows`, `ledgerMaxVersion`).

> **Đính chính (08/08/2026):** bản README trước ghi ledger "đứng từ Feb 2026". Sai 5 tháng. Con số
> đúng đọc từ provenance, không phải từ trí nhớ.

Nhưng con số đúng vẫn **không** dùng để suy ra schema đang có gì.
`migration-policy.json → knownLimits` nói thẳng:

> *"Ledger dừng ở 20260727095000 trong khi production có thay đổi muộn hơn. Đừng dùng max(version)
> của ledger làm trạng thái schema."*

Lý do: repo apply migration **trực tiếp qua Management API**, không dùng `supabase db push`, nên
nhiều thay đổi có thật trong DB mà không sinh dòng ledger. Ledger là *một* nguồn bằng chứng, không
phải nguồn chân lý.

## Bốn state, và cái nào chứng minh được gì

Định nghĩa đầy đủ ở `migration-policy.json → states`. Điều dễ hiểu nhầm nhất:

| State | Chứng minh được gì |
|---|---|
| `ledger-applied` | Khớp CHÍNH XÁC (version, name) một dòng ledger — mạnh nhất |
| `catalog-proven` | Object nó CREATE đều có trong catalog production. **Yếu hơn**: chứng minh object TỒN TẠI, không chứng minh CHÍNH FILE NÀY tạo ra nó |
| `superseded` | Nằm trong thư mục này — KHÔNG replay |
| `unknown` | Chưa có bằng chứng máy. **KHÔNG** được suy ra "đã chạy" từ timestamp hay từ việc nó nằm trong repo |

## Xem trạng thái forward lane

```bash
npm run migrations:list-forward                  # toàn bộ migration sau cutoff + trạng thái
npm run migrations:list-forward -- --chua-apply  # chỉ thứ chưa có bằng chứng
npm run gate:migration-provenance                # cưỡng chế: sau cutoff phải có entry
```

`list-forward-migrations` phơi ra **hai chiều lệch**, và chúng khác nhau về mức nguy hiểm:

- **có file, chưa có sổ** — chờ apply hoặc quên ghi sổ; lùi được bằng
  `generate-migration-provenance.mjs --write`
- **có sổ, không có file** — production đã đổi schema theo một file repo không còn mô tả. **Đừng**
  chữa bằng `--write`: lệnh đó tái sinh sổ từ đĩa nên sẽ xoá luôn entry, tức xoá dấu vết. Cách sửa
  đúng là mang file trở lại repo.
