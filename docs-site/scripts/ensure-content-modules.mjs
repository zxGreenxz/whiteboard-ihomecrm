// srcDir (docs/huong-dan-su-dung) nằm ngoài docs-site nên node resolution từ file MD
// không thấy node_modules của docs-site. Tạo symlink/junction để mọi bare import
// (vue, vue/server-renderer, ...) resolve tự nhiên — không cần alias thủ công.
// Chạy trước dev/build (đã wire trong package.json). Idempotent.
import { existsSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const target = path.resolve(__dirname, '..', 'node_modules')
const link = path.resolve(__dirname, '..', '..', 'docs', 'huong-dan-su-dung', 'node_modules')

if (existsSync(link)) {
  const st = lstatSync(link)
  if (st.isSymbolicLink()) process.exit(0) // đã có, xong
  // là thư mục thật (không nên xảy ra) — không đụng vào
  console.warn(`⚠ ${link} tồn tại nhưng không phải symlink — bỏ qua`)
  process.exit(0)
}
try {
  // 'junction' hoạt động trên Windows không cần quyền admin; trên Linux là symlink thường
  symlinkSync(target, link, 'junction')
  console.log(`✓ linked ${link} → ${target}`)
} catch (e) {
  console.error(`✗ không tạo được symlink: ${e.message}`)
  process.exit(1)
}
