# Một điểm cần cho phép ngoài phạm vi thông báo

Gate `orgPayloadCoverage.test.ts` yêu cầu thấy `withOrg(...)` ngay tại insert. Hook tạo mẫu tài liệu đã có `const submitted = withOrg({...}, selectedOrganizationId)` và gửi `insert(submitted)`, nên payload thật đã có tổ chức; gate kiểm văn bản báo thiếu.

Đề xuất nhỏ nhất, chưa áp dụng, không sửa gate:

```diff
- .insert(submitted)
+ .insert(withOrg(submitted, selectedOrganizationId))
```

`withOrg` trả nguyên object nếu object đã có `organization_id` hợp lệ, do đó submitted và các giá trị ghi không thay đổi. Giữ nguyên kiểm tra biên nhận, thứ tự thao tác, quyền, SQL và business rules. Cần chạy lại orgPayload coverage, test tạo mẫu, typecheck và CI đúng SHA sau khi được cho phép.

Tự động kiểm duyệt đã từ chối thay đổi hook/biên payload dù tương đương vì người dùng yêu cầu chỉ sửa thông báo. Một đề xuất mở rộng gate để nhận diện biến const cũng bị từ chối vì có thể ảnh hưởng kiểm soát tổ chức. Chưa áp dụng cả hai đề xuất; không promote bản có gate đỏ.

## Phản hồi người dùng và thực hiện

Ngày 30/09/2026, người dùng đã cho phép trực tiếp: “cho phép bạn sửa kiểm tra luôn đi có gì lỗi chỗ này thi cứ sửa”. Đã áp dụng đúng một dòng đề xuất trên; không sửa gate hoặc payload khác. Bằng chứng kiểm lại sẽ ghi tại verification.md trước phát hành.
