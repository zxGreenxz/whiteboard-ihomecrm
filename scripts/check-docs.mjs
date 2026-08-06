#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docs = path.join(repo, 'docs')
const guide = path.join(docs, 'huong-dan-su-dung')
const sidebarPath = path.join(repo, 'docs-site', '.vitepress', 'sidebar.mts')

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

function display(file) {
  return path.relative(repo, file).replaceAll('\\', '/')
}

function targetExists(candidate) {
  if (existsSync(candidate)) return true
  if (!path.extname(candidate)) {
    return existsSync(`${candidate}.md`) || existsSync(path.join(candidate, 'index.md'))
  }
  return false
}

function cleanTarget(raw) {
  let target = raw.trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  target = target.split(/\s+["']/)[0]
  try {
    target = decodeURIComponent(target)
  } catch {
    // Giữ nguyên target để báo lỗi có đường dẫn gốc.
  }
  return target
}

const markdown = []
for await (const file of walk(docs)) {
  if (file.toLowerCase().endsWith('.md')) markdown.push(file)
}

const errors = []
const hashes = new Map()
const linkRe = /!?\[[^\]]*\]\(([^)]+)\)/g

/**
 * Bỏ code block (``` fenced và `inline`) trước khi dò link.
 *
 * Cú pháp markdown-link trùng với nhiều thứ trong mã nguồn. Ca thật đã gặp:
 * dòng PowerShell `[int64](git cat-file -s $helperBlob)` bị nhận là link tới
 * một file tên "git cat-file -s $helperBlob". Báo động giả kiểu này nguy hiểm
 * theo cách riêng — nó dạy người ta bỏ qua output của checker.
 *
 * Thay bằng dòng trống để số dòng không lệch.
 */
function stripCodeBlocks(text) {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ''))
    .replace(/`[^`\n]*`/g, '')
}

for (const file of markdown) {
  const text = await readFile(file, 'utf8')
  const normalized = text.replaceAll('\r\n', '\n').trimEnd()
  const hash = createHash('sha256').update(normalized).digest('hex')
  const duplicate = hashes.get(hash)
  if (duplicate) errors.push(`Nội dung trùng: ${display(duplicate)} = ${display(file)}`)
  else hashes.set(hash, file)

  if (path.basename(file).startsWith('_')) continue

  for (const match of stripCodeBlocks(text).matchAll(linkRe)) {
    const target = cleanTarget(match[1])
    if (!target || /^(https?:|mailto:|tel:|data:|#)/i.test(target)) continue

    const withoutAnchor = target.split('#')[0].split('?')[0]
    if (!withoutAnchor) continue

    const candidates = []
    if (withoutAnchor.startsWith('/')) {
      if (!file.startsWith(guide + path.sep)) continue // app route trong technical docs
      candidates.push(path.join(guide, withoutAnchor.replace(/^\/+/, '')))
    } else {
      candidates.push(path.resolve(path.dirname(file), withoutAnchor))
      candidates.push(path.resolve(repo, withoutAnchor))
    }

    if (!candidates.some(targetExists)) {
      errors.push(`Link hỏng: ${display(file)} -> ${target}`)
    }
  }
}

const sidebar = await readFile(sidebarPath, 'utf8')
for (const match of sidebar.matchAll(/link:\s*['"]([^'"]+)['"]/g)) {
  const link = match[1]
  const page = path.join(guide, link.replace(/^\/+/, ''), 'index.md')
  if (!existsSync(page)) {
    errors.push(`Sidebar thiếu trang: ${link}`)
    continue
  }
  const text = await readFile(page, 'utf8')
  if (!/^status:\s*published\s*$/m.test(text)) {
    errors.push(`Trang sidebar chưa published: ${display(page)}`)
  }
}

if (!existsSync(path.join(docs, 'README.md'))) errors.push('Thiếu docs/README.md')

for (const error of errors) console.error(`x ${error}`)
console.log(`Đã kiểm ${markdown.length} file Markdown; ${errors.length} lỗi.`)
if (errors.length) process.exit(1)
