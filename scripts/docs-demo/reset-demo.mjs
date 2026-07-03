#!/usr/bin/env node
// Gọi tay public.demo_reset() (đường script — nút trên docs đi qua edge fn demo-reset).
import { runSql } from './lib.mjs'

try {
  const r = await runSql(`SELECT public.demo_reset() AS result;`)
  console.log(JSON.stringify(r?.[0]?.result ?? r, null, 2))
} catch (e) {
  if (/COOLDOWN:(\d+)/.test(e.message)) {
    console.error(`⏳ Cooldown — thử lại sau ${e.message.match(/COOLDOWN:(\d+)/)[1]}s`)
  } else {
    console.error('✗', e.message)
  }
  process.exit(1)
}
