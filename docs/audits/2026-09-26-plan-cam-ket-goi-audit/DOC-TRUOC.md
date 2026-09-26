# Gói gửi audit — Plan cỗ máy chi theo cam kết (26/09/2026)

## Đọc theo thứ tự

1. **`docs/plans/PLAN-CO-MAY-CHI-THEO-CAM-KET-2026-09-26.md` — đối tượng audit.**
   §0 nói cách kiểm từng loại khẳng định · §11 là 10 câu mời phản biện · Phụ lục A/B/C là chứng cứ.
2. `docs/audits/2026-09-26-plan-cam-ket-goi-audit/do-nen-26-09.json` — số đo sống, mốc **26/09/2026 12:09**
   giờ VN, đọc chỉ-đọc qua session pooler.
3. `docs/audits/2026-09-26-plan-cam-ket-goi-audit/md5-ham-26-09.json` — `md5(pg_get_functiondef)` của 16 hàm
   plan nhắc tới, cùng mốc.
4. `do-nen.cjs` / `do-nen2.cjs` — **script đo nguyên văn**, chạy lại được (xem "Chạy lại số đo" bên dưới).
5. Bối cảnh: `docs/plans/PLAN-MOT-LUONG-THU-CHI-2026-09-23.md` (**đã bị thay**, banner ở đầu file nói rõ cái
   gì đổi) · `docs/engineering/PROJECT_CONTRACT.md`.
6. Trang trình bày cho quản lý/kế toán, cùng nội dung bỏ phần kỹ thuật:
   <https://claude.ai/artifact/DEYWvELzPkyt8BVRiqLZCf>

## Bối cảnh cần biết trước khi đọc

- **Nền mã:** `origin/main` = `origin/production` = **`e1a0d2ac`** (25/09/2026).
  ⚠ **Checkout local của máy chủ nhà đang tụt ~192 commit** so với `origin/main`; plan đọc thẳng `origin/main`,
  không đọc cây làm việc. Người audit nên `git fetch` rồi đọc theo ref, không đọc file trong worktree.
- **Nền số:** production `tryymsxyyckgbrmmvozx`, org THẬT `aaaa0000-0000-4000-8000-000000000001`.
- **Chưa file nào trong gói được commit** lúc đóng gói (26/09/2026, giờ máy). Nếu agent audit chạy trong
  worktree riêng thì **không thấy** các file untracked này — phải chạy ở chính thư mục dự án.
- **Không nén zip** theo tiền lệ 23/09.

## Cái gì đã đổi so với gói audit 23/09

Đây là **bản thay thế**, không phải bản cập nhật. Ba thứ đổi bản chất:

| | 23/09 | 26/09 |
|---|---|---|
| Đích kiến trúc | gom bảy luật về **một hàm luật** + bảng chính sách riêng | **một bộ máy quyết định** + luật khai **trên hạng mục** + **ba kiểu chi** |
| Chống chi trùng | một giai đoạn riêng (G2, cỡ M, bảng claim) | **bỏ** — hệ quả của cam kết |
| Chọn sổ | dựng cơ chế mới (`accounts.function_key`) | mở rộng **"Sổ nhận tiền"** đã ship 25/09 |

Và 5 mục của plan cũ **đã được vá** trong khoảng 23–25/09 mà plan cũ chưa biết (§3.1 bản mới).

## Điểm plan tự khai là yếu — mời soi trước

Plan §0 tự nêu ba điều, nhắc lại ở đây để người audit không phải tìm:

1. **Chưa có nhánh phản biện độc lập.** Cùng một agent viết bản phê bình plan cũ rồi tự viết bản thay thế.
2. **Số nền 26/09 không phải bản chạy lại đầy đủ** của Phụ lục A plan cũ — chỉ đo lại phần plan mới dựa vào.
3. **Mô hình "theo cam kết" là quyết định nghiệp vụ của chủ**, không phải kết luận từ đo đạc.

Thêm hai chỗ plan tự đánh dấu là thiếu, nằm trong §11:

- **§11 câu 3:** bỏ khoá khe rồi thì hai phiếu cùng lúc đọc cùng một số dư cam kết — plan **chưa viết khoá**
  vào §4.3. Plan tự nhận đây là thiếu sót.
- **§11 câu 2:** `income_expense_types` có RLS mở hoàn toàn; đặt luật lên bảng đó thì ai cũng sửa được. Plan
  nói "quyền sửa cột luật tách riêng" nhưng **chưa chỉ ra cơ chế tách**.

## Chạy lại số đo

Script tự đọc mật khẩu từ `CLAUDE.local.md`, **không nhận mật khẩu trên dòng lệnh**. Chỉ `SELECT`, bọc
`BEGIN READ ONLY … ROLLBACK`, mỗi câu một `SAVEPOINT`.

```
NODE_PATH="<repo>/node_modules" node do-nen.cjs
NODE_PATH="<repo>/node_modules" node do-nen2.cjs
```

`pg` chỉ có trong `node_modules` của repo nên `NODE_PATH` là bắt buộc. Script đặt
`pg.types.setTypeParser(1082, v => v)` vì node-pg đọc `DATE` lệch một ngày.

## Nội dung nhạy cảm

Gói có **dữ liệu nội bộ**: số tiền tổng hợp, số phiếu, tên hạng mục, tên toà.
**Không có** mật khẩu, khoá API, token — đã quét bằng 7 mẫu (Supabase PAT, GitHub token, API key, Vercel
token, Cloudflare token, mật khẩu DB, `password:` literal): **sạch**.
Không có mã phiếu cụ thể hay tên nhân viên trong các file JSON.

## SHA-256 từng file

| File | SHA-256 |
|---|---|
| `docs/plans/PLAN-CO-MAY-CHI-THEO-CAM-KET-2026-09-26.md` | `72ae574acc5ac99a8e1d907df171a4bb3c6e6b976f5e3cd15d4f297771c53252` |
| `docs/plans/PLAN-MOT-LUONG-THU-CHI-2026-09-23.md` | `592da4f5abf5c7375a748a20bf671f6e9ea393d886327aa3e9af23b062d27f11` |
| `docs/audits/2026-09-26-plan-cam-ket-goi-audit/do-nen-26-09.json` | `ed6f06011f1af4013a9ad8c7c890eb0f0fed67a4e5ad3692e61f2879b74a58c2` |
| `docs/audits/2026-09-26-plan-cam-ket-goi-audit/md5-ham-26-09.json` | `48e2ecce4f4d882fdcee583e79de6d0adee2c8a930258ab40b04fe61983172dd` |
| `docs/audits/2026-09-26-plan-cam-ket-goi-audit/do-nen.cjs` | `d9738ea15bc48505c0eeb073d2f6cdd29d971b7436a15c598af1ee972eb6db2a` |
| `docs/audits/2026-09-26-plan-cam-ket-goi-audit/do-nen2.cjs` | `dd6f9f1cf6caf6c3788ed1a9adf53a84fcc08ff86d3ca397701ebb42050e9a00` |
| `docs/engineering/PROJECT_CONTRACT.md` | `163edf77f42f60058ad2ba0c873a491d3c62797d8f5cb4c6a83b50dc12a48d09` |

> SHA của `PLAN-MOT-LUONG-THU-CHI-2026-09-23.md` **đã đổi** so với gói 23/09
> (`7d663277db3cf299…`) — chỉ vì thêm banner "ĐÃ BỊ THAY" ở đầu file, nội dung §1–§11 và phụ lục
> **không đụng một ký tự**. Kiểm bằng `git diff` nếu cần.

## Điều mong người audit trả về

Theo tiền lệ 21/09 và 23/09: một thư mục `docs/audits/<ngày>-plan-cam-ket-audit/` gồm nhận xét theo từng
mục, **ghim SHA-256 bản plan đã đọc**, và nêu rõ chỗ nào là "chặn thi hành" chứ không chỉ là góp ý.
Ưu tiên ba câu: **§11 câu 1** (trần điện nước có kích không), **§11 câu 2** (RLS bảng hạng mục), **§11 câu 3**
(khoá chống đua khi bỏ khoá khe).
