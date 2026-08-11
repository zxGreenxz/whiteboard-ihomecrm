#!/usr/bin/env node
// Gate: tài liệu người dùng và alias của capability phải đúng như registry khai.
//
// HAI LUẬT
//   (1) `visibility: "public"` ⇒ BẮT BUỘC có `docs.userDoc`, file đó tồn tại, VÀ
//       nó nằm trong sidebar của docs-site. Thiếu vế cuối thì trang vẫn build
//       nhưng không ai tìm ra — tồn tại mà không tồn tại.
//       `visibility: "internal"` ⇒ userDoc có thể null, nhưng phải kèm lý do.
//
//   (2) alias (đường dẫn cũ còn redirect) KHÔNG được xuất hiện ở nav, launcher
//       hay permission picker (acceptance §7). Thêm một alias mà quên luật này thì
//       sinh ra hai mục menu cùng trỏ một trang, hoặc hai dòng quyền cho cùng một
//       bề mặt — và không có gì hỏng để ai đó đi tìm.
//
// LUẬT (2) HIỆN KHÔNG CÓ DỮ LIỆU, VÀ ĐÓ LÀ LÝ DO NÓ ĐƯỢC VIẾT TRƯỚC
//   Đo 11/08/2026: không capability nào khai alias. Gate vẫn cài sẵn để cái bẫy
//   không bao giờ mở ra được. Viết sau — lúc đã có alias — nghĩa là lần đầu tiên
//   luôn không được canh.
//
//   node scripts/check-capability-docs.mjs
//
// Không cần credential. Thoát 0 · 1 khi vi phạm · 3 khi KHÔNG ĐỌC ĐƯỢC.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs } from './lib/bo-chu-thich.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(repoRoot, 'src', 'app', 'capabilities', 'registry.ts');
const SIDEBAR = join(repoRoot, 'docs-site', '.vitepress', 'sidebar.mts');

/** Bóc phần docs/alias của từng capability từ nguồn registry. */
export function docCapability(nguon) {
  const code = boChuThichJs(nguon);
  const ra = [];
  for (const khoi of code.split(/\n\s*\{\s*\n/).slice(1)) {
    const id = /id:\s*"([^"]+)"/.exec(khoi)?.[1];
    if (!id) continue;
    const userDoc = /userDoc:\s*(null|"([^"]*)")/.exec(khoi);
    ra.push({
      id,
      systemDoc: /systemDoc:\s*"([^"]+)"/.exec(khoi)?.[1] ?? null,
      userDoc: userDoc ? (userDoc[1] === 'null' ? null : userDoc[2]) : undefined,
      lyDo: /userDocMienTruVi:\s*\n?\s*"([^"]+)"/.exec(khoi)?.[1] ?? null,
      visibility: /visibility:\s*"([^"]+)"/.exec(khoi)?.[1] ?? null,
      aliases: [...(/aliases:\s*\[([^\]]*)\]/.exec(khoi)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    });
  }
  return ra;
}

/** Đường dẫn `link:` xuất hiện trong sidebar docs-site. */
export function linkTrongSidebar(nguon) {
  return new Set([...boChuThichJs(nguon).matchAll(/link:\s*'([^']+)'/g)].map((m) => m[1]));
}

function main() {
  let caps;
  try {
    caps = docCapability(readFileSync(REGISTRY, 'utf8'));
  } catch (error) {
    console.error(`❌ KHÔNG ĐỌC ĐƯỢC registry: ${error.message}`);
    process.exit(3);
  }
  if (caps.length === 0) {
    console.error('❌ KHÔNG BÓC ĐƯỢC capability nào — bộ bóc hỏng, không phải "registry rỗng".');
    process.exit(3);
  }

  let sidebar;
  try {
    sidebar = linkTrongSidebar(readFileSync(SIDEBAR, 'utf8'));
  } catch (error) {
    console.error(`❌ KHÔNG ĐỌC ĐƯỢC sidebar docs-site: ${error.message}`);
    process.exit(3);
  }
  if (sidebar.size < 50) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: sidebar chỉ có ${sidebar.size} link (đo 11/08/2026: hơn 100).`);
    console.error('   Bộ bóc hỏng thì "userDoc không nằm trong sidebar" là kết luận rỗng.');
    process.exit(3);
  }

  const van = [];

  for (const c of caps) {
    if (c.visibility === null) {
      van.push(`${c.id}: thiếu \`docs.visibility\` ("public" hoặc "internal").`);
      continue;
    }
    if (c.userDoc === undefined) {
      van.push(`${c.id}: thiếu \`docs.userDoc\` (đường dẫn hoặc null).`);
      continue;
    }

    if (c.visibility === 'public') {
      if (!c.userDoc) {
        van.push(`${c.id}: khai \`visibility: "public"\` nhưng \`userDoc\` là null — bề mặt cho người dùng cuối phải có hướng dẫn.`);
        continue;
      }
      if (!existsSync(join(repoRoot, c.userDoc))) {
        van.push(`${c.id}: \`userDoc\` trỏ "${c.userDoc}" nhưng file đó không tồn tại.`);
        continue;
      }
      // Trang có thật mà không nằm trong sidebar thì người dùng không tìm ra —
      // nó tồn tại mà như không.
      const link = `/${c.userDoc.replace(/^docs\/huong-dan-su-dung\//, '').replace(/index\.md$/, '')}`;
      if (![...sidebar].some((l) => l === link || l.replace(/\/$/, '') === link.replace(/\/$/, ''))) {
        van.push(`${c.id}: trang "${c.userDoc}" có thật nhưng KHÔNG nằm trong sidebar docs-site — không ai tìm ra nó.`);
      }
    } else if (!c.userDoc && !c.lyDo) {
      van.push(`${c.id}: \`userDoc: null\` mà không có \`userDocMienTruVi\` — không phân biệt được "đã cân nhắc" với "quên".`);
    }
  }

  // ── Luật (2): alias không được lên bề mặt ────────────────────────────────
  const nav = ['src/components/layout/Sidebar.tsx', 'src/pages/home/launcherTiles.ts', 'src/lib/permissionPages.ts']
    .filter((p) => existsSync(join(repoRoot, p)))
    .map((p) => ({ p, s: readFileSync(join(repoRoot, p), 'utf8') }));
  if (nav.length < 3) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ đọc được ${nav.length}/3 file bề mặt.`);
    process.exit(3);
  }

  let soAlias = 0;
  for (const c of caps) {
    for (const a of c.aliases) {
      soAlias++;
      for (const { p, s } of nav) {
        if (s.includes(`"${a}"`) || s.includes(`'${a}'`)) {
          van.push(`${c.id}: alias "${a}" xuất hiện trong ${p} — alias là đường dẫn CŨ, không được sinh thêm mục nav/quyền.`);
        }
      }
    }
  }

  if (van.length > 0) {
    console.error(`❌ ${van.length} vi phạm hợp đồng tài liệu/alias của capability:\n`);
    for (const v of van) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  const cong = caps.filter((c) => c.visibility === 'public').length;
  console.log(
    `✅ ${caps.length} capability: ${cong} public (userDoc có trong sidebar), ` +
    `${caps.length - cong} internal (userDoc null kèm lý do), ${soAlias} alias.`,
  );
  if (soAlias === 0) {
    // Nói ra thay vì để dấu ✅ tự nói: luật alias hôm nay chưa kiểm gì.
    console.log('   ⚠ Chưa capability nào khai alias — luật (2) cài sẵn, cắn từ alias đầu tiên.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
