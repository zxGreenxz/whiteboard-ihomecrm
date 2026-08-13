---
title: "Ghi chú phiên bản"
description: "Cách xác định tài liệu khớp bản hiện hành và giới hạn của trang /changelog đang dùng dữ liệu tĩnh 2024–2025."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-08-13"
  account: demo
status: published
---

# Ghi chú phiên bản

Bộ hướng dẫn này được rà soát theo code, route, catalog quyền và database production hiện hành tại thời điểm ghi trong `captured.date`. Ngày này là **mốc đối chiếu tài liệu**, không phải số phiên bản sản phẩm và không chứng minh mọi ảnh chụp trên toàn bộ site được tạo lại cùng ngày.

## Nguồn nào đáng tin khi có khác biệt?

Ưu tiên theo thứ tự:

1. Hành vi đang chạy và route trong code hiện hành.
2. Contract/schema, catalog và inventory đo từ database production.
3. Quyền/RLS/RPC đang kiểm ở server.
4. Markdown hướng dẫn và ảnh minh hoạ.
5. Trang `/changelog` trong ứng dụng.

Tài liệu phải được sửa khi lệch các nguồn phía trên; không dùng một ảnh cũ hoặc một dòng changelog để phủ nhận hành vi và dữ liệu đang chạy.

## Giới hạn của `/changelog`

Trang **Lịch sử cập nhật** hiện render một mảng tĩnh nằm trong source `ChangelogPage.tsx`, gồm ba mục:

| Phiên bản hiển thị | Ngày trong mảng tĩnh |
|---|---|
| `v1.0.0` | 15/01/2025 |
| `v0.9.0` | 01/12/2024 |
| `v0.8.0` | 01/11/2024 |

Trang này **không tự đọc commit, migration, deployment, Vercel hay database**, nên không phải release log authoritative và không phản ánh đầy đủ các thay đổi năm 2026. Nội dung tĩnh còn nhắc những cấu trúc cũ như `SUMMARY.md`; hãy xem nó như lịch sử giao diện được đóng gói trong build, không phải bằng chứng về trạng thái hiện tại.

::: warning Không lấy `/changelog` làm mốc “bản mới nhất”
Việc mục trên cùng ghi `v1.0.0 — 15/01/2025` không có nghĩa hệ thống production đang dừng ở bản đó. Khi cần điều tra một thay đổi nghiệp vụ, dùng route/code/schema và lịch sử triển khai nội bộ, rồi đối chiếu tài liệu có `captured.date` mới hơn.
:::

## Cách nhận biết một trang hướng dẫn đã cũ

- Route trong bài tự chuyển sang một route khác, ví dụ `/settings/staff → /settings/members`.
- Bài nói **Đã duyệt** là tiền thật, trong khi Finance V2 yêu cầu `posting_status=POSTED`.
- Bài mô tả báo cáo cọc từ bảng `deposits` như số cọc authoritative, dù nguồn canonical là hạng mục cọc của `income_expenses`.
- Bài mô tả báo cáo Tiền thừa như credit còn lại, dù credit authoritative nằm trong `customer_credit_lots.remaining_amount`.
- Bài suy trạng thái OpenClaw hoặc Network Center chỉ từ mặc định code. Runtime phải đối chiếu đúng deployment; production ngày 13/08/2026 đang hiển thị OpenClaw Zalo.
- Bài coi khu **08 — Kế hoạch phát triển** là tính năng đã phát hành.

Khi gặp một trong các dấu hiệu này, ưu tiên trang hướng dẫn mới có cảnh báo rõ và báo lại theo [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/).

## Phân biệt ba loại nội dung trên site docs

| Loại | Có thể dùng để thao tác production? | Cách nhận biết |
|---|---|---|
| **Hướng dẫn hiện hành** | Có, sau khi kiểm quyền và điều kiện nghiệp vụ. | Nằm trong các nhóm bắt đầu, vận hành, báo cáo, cài đặt, tài khoản; mô tả route và trạng thái hiện hành. |
| **Cảnh báo giới hạn hiện tại** | Có, để tránh tin sai một bề mặt chưa canonical. | Nêu rõ nguồn legacy, route redirect, runtime-off hoặc khoảng trống verification. |
| **Kế hoạch/đề xuất** | Không tự dùng làm chỉ dẫn production. | Nằm ở khu `08-ke-hoach-phat-trien`; phải có banner proposal và chỉ trở thành runtime khi được triển khai/kiểm chứng. |

## Cách báo một sai lệch tài liệu

Gửi đủ:

- URL của trang docs và URL màn hình app.
- Tên mục/câu đang sai.
- Ảnh hoặc video ngắn thể hiện hành vi thật.
- Vai trò, tổ chức/toà và thời điểm kiểm tra.
- Nếu liên quan tiền: id hoá đơn/phiếu, trạng thái phê duyệt, trạng thái posting và sổ quỹ — không gửi mật khẩu.

## Xem trang lịch sử tĩnh trong sandbox

<SandboxTry account="demo.chunha" app-path="/changelog" app-label="Mở Lịch sử cập nhật" view-only>

Bạn có thể mở `/changelog` để xem ba mục tĩnh kể trên. Kết quả mong đợi là hiểu đây là nội dung của build, **không phải danh sách đầy đủ mọi lần phát hành**.

</SandboxTry>

## Quy trình liên quan

- [Giới thiệu hệ thống](/01-bat-dau/gioi-thieu/)
- [Câu hỏi thường gặp](/07-thong-tin-khac/faq/)
- [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/)
- [Kế hoạch phát triển](/08-ke-hoach-phat-trien/)
