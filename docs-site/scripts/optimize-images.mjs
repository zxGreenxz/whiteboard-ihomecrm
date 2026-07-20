#!/usr/bin/env node
/**
 * optimize-images.mjs — pipeline ảnh docs.
 *
 * Chế độ mặc định: đọc PNG thô từ docs-site/.inbox/<nhom>/<trang>/buoc-NN-<slug>.png
 *   → resize (chỉ thu nhỏ, max-width 1440) → WebP q=80
 *   → ghi vào docs/huong-dan-su-dung/<nhom>/<trang>/images/buoc-NN-<slug>.webp
 *   → xoá PNG nguồn, in bảng size trước/sau.
 *   Từ chối output > 300KB (phải chụp element thay vì full màn).
 *
 * Chế độ --check: không convert; quét toàn bộ MD trong docs/huong-dan-su-dung:
 *   - ảnh được tham chiếu mà file không tồn tại  → lỗi
 *   - file ảnh tồn tại mà không MD nào tham chiếu → cảnh báo (ảnh mồ côi)
 *   - trang .md không có mặt trong sidebar.mts   → cảnh báo (trang mồ côi)
 *   Exit 1 nếu có lỗi.
 */
import { readdir, readFile, mkdir, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_SITE = path.resolve(__dirname, '..')
const INBOX = path.join(DOCS_SITE, '.inbox')
const CONTENT = path.resolve(DOCS_SITE, '..', 'docs', 'huong-dan-su-dung')
const SIDEBAR = path.join(DOCS_SITE, '.vitepress', 'sidebar.mts')

const MAX_WIDTH = 1440
const QUALITY = 80
const HARD_LIMIT = 300 * 1024 // 300KB — từ chối, phải chụp lại gọn hơn

async function* walk(dir, exts) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p, exts)
    else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) yield p
  }
}

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(0)}KB`
}

async function convert() {
  const { default: sharp } = await import('sharp')
  const pngs = []
  for await (const p of walk(INBOX, ['.png'])) pngs.push(p)
  if (!pngs.length) {
    console.log(`Không có PNG nào trong ${INBOX}`)
    return
  }
  let failed = 0
  for (const src of pngs) {
    // .inbox/<nhom>/<trang>/buoc-NN-slug.png → <nhom>/<trang>/images/buoc-NN-slug.webp
    const rel = path.relative(INBOX, src)
    const parts = rel.split(path.sep)
    const file = parts.pop()
    const outDir = path.join(CONTENT, ...parts, 'images')
    const out = path.join(outDir, file.replace(/\.png$/i, '.webp'))
    await mkdir(outDir, { recursive: true })
    const inSize = (await stat(src)).size
    await sharp(src)
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: QUALITY, effort: 6 })
      .toFile(out)
    let outSize = (await stat(out)).size
    if (outSize > HARD_LIMIT) {
      // thử nén mạnh hơn một nấc trước khi từ chối
      await sharp(src)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: 70, effort: 6 })
        .toFile(out)
      outSize = (await stat(out)).size
    }
    if (outSize > HARD_LIMIT) {
      await unlink(out)
      console.error(
        `✗ TỪ CHỐI ${rel}: ${fmtKB(outSize)} > 300KB — chụp element/vùng nhỏ hơn thay vì full màn`
      )
      failed++
      continue
    }
    await unlink(src)
    console.log(`✓ ${rel} ${fmtKB(inSize)} → ${path.relative(CONTENT, out)} ${fmtKB(outSize)}`)
  }
  if (failed) process.exit(1)
}

async function check() {
  const errors = []
  const warnings = []
  const referenced = new Set()

  const mdFiles = []
  for await (const p of walk(CONTENT, ['.md'])) mdFiles.push(p)

  // 1. Ảnh tham chiếu trong MD phải tồn tại
  const imgRe = /!\[[^\]]*\]\(([^)]+)\)/g
  for (const md of mdFiles) {
    if (path.basename(md).startsWith('_')) continue // template bị exclude khỏi build
    const text = await readFile(md, 'utf8')
    for (const m of text.matchAll(imgRe)) {
      const ref = m[1].split(/[?#]/)[0]
      if (/^https?:\/\//.test(ref)) continue
      const target = ref.startsWith('/')
        ? path.join(CONTENT, 'public', ref)
        : path.resolve(path.dirname(md), ref)
      referenced.add(path.normalize(target).toLowerCase())
      if (!existsSync(target)) {
        errors.push(`Ảnh thiếu: ${path.relative(CONTENT, md)} → ${ref}`)
      }
    }
  }

  // 2. Ảnh mồ côi (tồn tại nhưng không MD nào nhắc)
  for await (const img of walk(CONTENT, ['.webp', '.png', '.jpg', '.jpeg'])) {
    if (!referenced.has(path.normalize(img).toLowerCase())) {
      warnings.push(`Ảnh mồ côi: ${path.relative(CONTENT, img)}`)
    }
  }

  // 3. Trang .md không có trong sidebar (bỏ index.md và _*.md)
  const sidebarText = await readFile(SIDEBAR, 'utf8')
  for (const md of mdFiles) {
    const base = path.basename(md)
    if (base.startsWith('_')) continue
    if (path.resolve(md) === path.resolve(CONTENT, 'index.md')) continue // trang chủ không cần trong sidebar
    const text = await readFile(md, 'utf8')
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? ''
    if (/^kind:\s*redirect\s*$/m.test(frontmatter) || /^sidebar:\s*false\s*$/m.test(frontmatter)) continue
    const link =
      '/' +
      path
        .relative(CONTENT, md)
        .replace(/\\/g, '/')
        .replace(/index\.md$/, '')
        .replace(/\.md$/, '')
    if (!sidebarText.includes(`'${link}'`) && !sidebarText.includes(`"${link}"`)) {
      warnings.push(`Trang chưa có trong sidebar.mts: ${link}`)
    }
  }

  for (const w of warnings) console.warn(`⚠ ${w}`)
  for (const e of errors) console.error(`✗ ${e}`)
  console.log(
    `\nCheck xong: ${mdFiles.length} trang MD, ${errors.length} lỗi, ${warnings.length} cảnh báo`
  )
  if (errors.length) process.exit(1)
}

if (process.argv.includes('--check')) await check()
else await convert()
