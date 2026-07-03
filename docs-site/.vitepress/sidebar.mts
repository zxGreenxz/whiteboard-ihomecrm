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
    ],
  },
]
