import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { sidebar } from './sidebar.mts'

// Bỏ dấu tiếng Việt để "hop dong" tìm ra "hợp đồng"
const stripDiacritics = (term: string) =>
  term
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()

export default withMermaid(
  defineConfig({
    lang: 'vi-VN',
    title: 'ptcrm — Hướng dẫn sử dụng',
    description: 'Tài liệu nội bộ hệ thống quản lý cho thuê ptcrm',
    srcDir: '../docs/huong-dan-su-dung',
    srcExclude: ['**/_*.md'],
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: false,
    // srcDir nằm ngoài docs-site: bare imports từ file MD resolve qua symlink
    // docs/huong-dan-su-dung/node_modules → docs-site/node_modules (scripts/ensure-content-modules.mjs)
    vite: {
      resolve: { dedupe: ['vue'] },
      optimizeDeps: { include: ['mermaid', 'dayjs', '@braintree/sanitize-url'] },
    },
    head: [['meta', { name: 'robots', content: 'noindex, nofollow' }]],
    themeConfig: {
      sidebar,
      outline: { level: [2, 3], label: 'Trên trang này' },
      docFooter: { prev: 'Trang trước', next: 'Trang sau' },
      darkModeSwitchLabel: 'Giao diện',
      lightModeSwitchTitle: 'Chuyển sang giao diện sáng',
      darkModeSwitchTitle: 'Chuyển sang giao diện tối',
      sidebarMenuLabel: 'Mục lục',
      returnToTopLabel: 'Lên đầu trang',
      lastUpdated: { text: 'Cập nhật lần cuối' },
      notFound: {
        title: 'Không tìm thấy trang',
        quote: 'Trang bạn tìm không tồn tại hoặc đã được di chuyển.',
        linkText: 'Về trang chủ',
      },
      search: {
        provider: 'local',
        options: {
          miniSearch: {
            options: { processTerm: stripDiacritics },
            searchOptions: { processTerm: stripDiacritics },
          },
          translations: {
            button: { buttonText: 'Tìm kiếm', buttonAriaLabel: 'Tìm kiếm' },
            modal: {
              displayDetails: 'Hiện chi tiết',
              resetButtonTitle: 'Xóa từ khóa',
              backButtonTitle: 'Đóng tìm kiếm',
              noResultsText: 'Không tìm thấy kết quả cho',
              footer: {
                selectText: 'chọn',
                selectKeyAriaLabel: 'enter',
                navigateText: 'di chuyển',
                navigateUpKeyAriaLabel: 'mũi tên lên',
                navigateDownKeyAriaLabel: 'mũi tên xuống',
                closeText: 'đóng',
                closeKeyAriaLabel: 'esc',
              },
            },
          },
        },
      },
    },
    mermaid: {},
  })
)
