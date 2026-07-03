import type { DefaultTheme } from 'vitepress'

// Sidebar viết tay — tiêu đề có dấu không suy được từ tên file kebab-case.
// Quy tắc: mỗi trang .md mới trong docs/huong-dan-su-dung PHẢI thêm 1 dòng ở đây
// (script images:check sẽ cảnh báo trang mồ côi).
export const sidebar: DefaultTheme.Sidebar = [
  {
    text: '1. Bắt đầu',
    collapsed: false,
    items: [
      { text: 'Giới thiệu hệ thống', link: '/01-bat-dau/gioi-thieu/' },
      { text: 'Sandbox — Môi trường thực hành', link: '/01-bat-dau/sandbox/' },
      { text: 'Đăng nhập & khôi phục mật khẩu', link: '/01-bat-dau/dang-nhap/' },
      { text: 'Làm quen giao diện', link: '/01-bat-dau/lam-quen-giao-dien/' },
      { text: 'Khởi tạo dữ liệu — thứ tự chuẩn', link: '/01-bat-dau/khoi-tao-du-lieu/' },
      { text: 'Bước 1: Tạo khu vực & toà nhà', link: '/01-bat-dau/tao-toa-nha/' },
      { text: 'Bước 2: Tạo tầng & phòng', link: '/01-bat-dau/tao-tang-phong/' },
      { text: 'Bước 3: Dịch vụ & định mức', link: '/01-bat-dau/dich-vu-dinh-muc/' },
      { text: 'Bước 4: Công tơ điện nước', link: '/01-bat-dau/cong-to/' },
      { text: 'Bước 5: Sổ quỹ & loại thu chi', link: '/01-bat-dau/so-quy-loai-thu-chi/' },
      { text: 'Bước 6: Thêm nhân viên & phân quyền', link: '/01-bat-dau/them-nhan-vien/' },
      { text: 'Quy trình: Vòng đời khách thuê', link: '/01-bat-dau/quy-trinh-khach-thue/' },
      { text: 'Quy trình: Chu kỳ thu tiền hàng tháng', link: '/01-bat-dau/quy-trinh-thu-tien/' },
      { text: 'Quy trình: Bàn giao & đối soát', link: '/01-bat-dau/quy-trinh-ban-giao/' },
      { text: 'Quy trình: Thanh lý hợp đồng', link: '/01-bat-dau/quy-trinh-thanh-ly/' },
      { text: 'Quy trình: Chốt tháng tài chính', link: '/01-bat-dau/quy-trinh-chot-thang/' },
    ],
  },
  {
    text: '2. Theo dõi nhanh',
    collapsed: false,
    items: [
      { text: 'Bảng tin', link: '/02-theo-doi-nhanh/bang-tin/' },
      { text: 'Sơ đồ toà nhà', link: '/02-theo-doi-nhanh/so-do-toa-nha/' },
      { text: 'Thông báo', link: '/02-theo-doi-nhanh/thong-bao/' },
      { text: 'Việc của tôi', link: '/02-theo-doi-nhanh/viec-cua-toi/' },
    ],
  },
  {
    text: '3. Quản lý & Vận hành',
    collapsed: false,
    items: [
      {
        text: 'Danh mục dữ liệu',
        collapsed: true,
        items: [
          { text: 'Toà nhà', link: '/03-quan-ly-van-hanh/toa-nha/' },
          { text: 'Căn hộ / Phòng', link: '/03-quan-ly-van-hanh/can-ho-phong/' },
          { text: 'Dịch vụ', link: '/03-quan-ly-van-hanh/dich-vu/' },
        ],
      },
      {
        text: 'Khách hàng',
        collapsed: true,
        items: [
          { text: 'Khách hẹn (Lead)', link: '/03-quan-ly-van-hanh/khach-hen/' },
          { text: 'Đặt cọc giữ chỗ', link: '/03-quan-ly-van-hanh/dat-coc/' },
          { text: 'Hoàn cọc, bỏ cọc', link: '/03-quan-ly-van-hanh/hoan-bo-coc/' },
          { text: 'Hợp đồng — danh sách & ký mới', link: '/03-quan-ly-van-hanh/hop-dong/' },
          { text: 'Chi tiết hợp đồng', link: '/03-quan-ly-van-hanh/hop-dong-chi-tiet/' },
          { text: 'Gia hạn & chuyển phòng', link: '/03-quan-ly-van-hanh/gia-han-chuyen-phong/' },
          { text: 'Thanh lý — Khách rời phòng', link: '/03-quan-ly-van-hanh/thanh-ly-move-out/' },
          { text: 'Thanh lý — Khách bỏ cọc', link: '/03-quan-ly-van-hanh/thanh-ly-forfeit/' },
          { text: 'Cư dân', link: '/03-quan-ly-van-hanh/cu-dan/' },
          { text: 'Hồ sơ & CT01', link: '/03-quan-ly-van-hanh/ho-so-ct01/' },
          { text: 'Phương tiện', link: '/03-quan-ly-van-hanh/phuong-tien/' },
        ],
      },
      {
        text: 'Tài chính',
        collapsed: true,
        items: [
          { text: 'Ghi chỉ số điện nước', link: '/03-quan-ly-van-hanh/ghi-chi-so/' },
          { text: 'Sinh hoá đơn hàng loạt', link: '/03-quan-ly-van-hanh/sinh-hoa-don/' },
          { text: 'Hoá đơn — danh sách & tạo lẻ', link: '/03-quan-ly-van-hanh/hoa-don/' },
          { text: 'Chi tiết & in hoá đơn', link: '/03-quan-ly-van-hanh/hoa-don-chi-tiet/' },
          { text: 'Thu tiền tại hoá đơn', link: '/03-quan-ly-van-hanh/thu-tien-hoa-don/' },
          { text: 'Thu tiền tại phòng (điện thoại)', link: '/03-quan-ly-van-hanh/thu-tien-mobile/' },
          { text: 'Thu chi — tạo phiếu', link: '/03-quan-ly-van-hanh/thu-chi/' },
          { text: 'Sổ quỹ', link: '/03-quan-ly-van-hanh/so-quy/' },
          { text: 'Bàn giao & đối soát', link: '/03-quan-ly-van-hanh/ban-giao-doi-soat/' },
          { text: 'Tiền thừa', link: '/03-quan-ly-van-hanh/tien-thua/' },
          { text: 'Chia lợi nhuận cổ đông', link: '/03-quan-ly-van-hanh/chia-loi-nhuan/' },
          { text: 'Bảng lương quản lý', link: '/03-quan-ly-van-hanh/bang-luong/' },
          { text: 'Lương của tôi', link: '/03-quan-ly-van-hanh/luong-cua-toi/' },
          { text: 'Ví thu chi cá nhân', link: '/03-quan-ly-van-hanh/vi-ca-nhan/' },
        ],
      },
    ],
  },
]
