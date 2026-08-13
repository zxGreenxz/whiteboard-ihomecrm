// =============================================================
// ctx.js — trạng thái + tiện ích DÙNG CHUNG của worker Zalo.
// Mọi module lib/* import từ đây để tránh vòng lặp import chéo.
// =============================================================
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_DIR = path.join(__dirname, '..');
dotenv.config({ path: path.join(WORKER_DIR, '.env') });

export const SESSION_DIR = path.join(WORKER_DIR, 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

export const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZALO_SESSION_KEY, WORKER_ORG_IDS } = process.env;

export const sb = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

export const POLL_MS = 2000;

// Lọc org (tuỳ chọn): WORKER_ORG_IDS="uuid1,uuid2" → worker CHỈ phục vụ các
// công ty này. Để trống = phục vụ tất cả (tách bạch dữ liệu đã nằm ở DB).
export const ORG_FILTER = (WORKER_ORG_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ── Trạng thái in-memory ──
// account_id -> { api, ownId, connectedAt, probeFails, sessionSavedAt, nextProactiveAt }
export const sessions = new Map();
// account_id đang chạy login (QR hoặc cookie) — chống double-login
export const loggingIn = new Set();
// account_id -> { attempts, nextAt, kicks, cooldownUntil, gaveUp }
export const reloginState = new Map();
// account_id -> organization_id (nạp lại mỗi tick từ zalo_accounts)
export const orgCache = new Map();

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }

export async function setAccount(id, patch) {
  const { error } = await sb.from('zalo_accounts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) log('setAccount error', id, error.message);
}

export function orgOf(accountId) {
  return orgCache.get(accountId) || null;
}

// Cô lập "thiết bị" đa-nick: mỗi nick một user-agent THẬT, cố định theo account_id.
// (imei = randomUUID + MD5(UA) nên UA khác ⇒ imei khác; cookie tách theo file phiên.)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
export function uaFor(accountId) {
  let h = 0;
  const s = String(accountId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return USER_AGENTS[h % USER_AGENTS.length];
}

// ── Web Push: gọi edge function send-push (service role) — fire & forget ──
export async function notifyPush({ userId, title, body, url, tag }) {
  if (!userId) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ userId, title, body, url, tag }),
    });
    if (!res.ok) log('notifyPush http', res.status);
  } catch (e) { log('notifyPush error', e?.message || e); }
}
