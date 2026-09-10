# Môi trường dữ liệu

ID và quyền ghi của THẬT/DEMO/TEST nằm ở [Project Contract](PROJECT_CONTRACT.md) §2.
Ba org dùng chung database; TEST có bản sao dữ liệu thật, cần bảo vệ như dữ liệu thật.

## Cơ chế cách ly cần kiểm

- `organizations.is_demo` là cờ phân loại, không tự cưỡng chế quyền.
- Membership, RLS và các hàm phân quyền quyết định tập dữ liệu người dùng được đọc.
- Policy `*_hide_demo_admin` nhận diện dữ liệu DEMO theo helper hiện hành;
  `*_hide_sandbox_admin` giấu sandbox theo org. Không coi hai họ policy là đồng nghĩa.
- Với `organization_id IS NULL`, dùng predicate xử lý NULL đúng; không để phép phủ định NULL
  giấu nhầm dòng hợp lệ.
- SECURITY DEFINER phải tự kiểm scope; RLS của bảng không thay thế kiểm quyền trong hàm.
- Kiểm truy vấn bằng role + JWT thật, gồm cả ca được phép và ca khác org bị chặn.
  Kết quả SELECT bằng postgres không chứng minh cách ly người dùng.

## Đồng bộ và xác minh

Thực hiện theo [clone-org/README](../../scripts/clone-org/README.md); fixture E2E dùng DEMO.
Không đổi tài khoản/owner email để lách giới hạn org.

```bash
npm run gate:sandbox-leak
```

[snapshot.mjs](../../scripts/clone-org/snapshot.mjs) phân biệt:

| Kết quả | Ý nghĩa |
|---|---|
| Có dòng org TEST nhìn thấy từ tài khoản thật | Rò rỉ, phải sửa |
| Không có GRANT SELECT (`42501`) | Bị chặn ở quyền bảng |
| Truy vấn khác lỗi hoặc danh sách đo không đủ | Chưa kiểm được; không phải pass |
| Không rò, đủ phép đo | Đạt trong phạm vi đã kiểm |

Số dòng trước/sau chỉ giúp phát hiện biến động, không thay phép đo rò.
Schema và dữ liệu có thể đổi ngoài Git: dùng catalog, SQL harness và evidence mới nhất.
