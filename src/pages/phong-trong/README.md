# Trang Phòng trống

Trang hiển thị danh sách và sơ đồ phòng cho sale. Có hai đường vào dùng chung giao diện.

| Đường vào | Nguồn dữ liệu |
|---|---|
| Liên kết công khai `/r/:token` | [usePhongTrong](./usePhongTrong.ts) gọi RPC `get_public_available_rooms` với token chia sẻ. Token sai hoặc đã thu hồi có trạng thái lỗi riêng. |
| Màn hình Sale trong ứng dụng | [SalePhongMobilePage](../sale-phong/SalePhongMobilePage.tsx) lấy dữ liệu theo phiên đăng nhập qua [useMyAvailableRooms](../../hooks/useMyAvailableRooms.ts) rồi truyền danh sách tòa vào trang. |

## Khi sửa

- Đường dẫn công khai và bí danh `/phongtrong` được khai báo trong [publicRoutes](../../app/routes/publicRoutes.tsx). [PhongTrongPage](./PhongTrongPage.tsx) điều phối trạng thái tải, lỗi, danh sách rỗng và dữ liệu được truyền sẵn.
- [supabaseData](./supabaseData.ts) ánh xạ dữ liệu phòng và tòa, gồm ảnh, thông tin liên hệ công khai và dữ liệu sơ đồ. [PhongTrongParts](./PhongTrongParts.tsx) hiển thị danh sách, bộ lọc và sơ đồ. [PhongTrongSheet](./PhongTrongSheet.tsx) hiển thị chi tiết phòng.
- Đối chiếu thay đổi về token, dữ liệu rỗng và lỗi mạng với [test trạng thái trang](./__tests__/PhongTrongPage.states.test.tsx). Thay đổi về quyền thao tác có [test phân quyền](./__tests__/PhongTrongPage.permissions.test.tsx).
- Khi cần đổi RPC hoặc schema, dùng [quy trình migration của dự án](../../../docs/engineering/MIGRATION_STRATEGY.md). Kiểm tra trước push theo [Project Contract](../../../docs/engineering/PROJECT_CONTRACT.md#10-hoàn-tất-thay-đổi).
