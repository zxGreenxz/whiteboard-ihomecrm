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
    ],
  },
]
