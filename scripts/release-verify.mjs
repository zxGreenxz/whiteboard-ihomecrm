#!/usr/bin/env node
// Xác minh phát hành: production Vercel thật sự phục vụ đúng commit vừa promote.
//
// VÌ SAO CẦN
//   `git push production` thành công KHÔNG có nghĩa người dùng đang chạy commit
//   đó: Vercel có thể lỡ webhook, build đỏ, hoặc alias chưa trỏ sang. Cùng SHA
//   còn sinh deployment của project docs (ptcrm-docs) — đọc nhầm project là xanh giả.
//
//   npm run release:verify -- --sha <sha> [--wait-seconds 900]
//
// Chỉ ĐỌC: Vercel API (VERCEL_TOKEN) và trang công khai.
// Thoát 0 khớp · 1 deployment đỏ hoặc trang chạy commit khác · 3 chưa kiểm được/hết giờ.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VERCEL_PROJECT = 'ihomecrm';
export const PRODUCTION_URL = 'https://ptcrm.vercel.app/';
export const MAX_WAIT_SECONDS = 1800;

const gitDefault = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** SHA ngắn khớp `head_sha=` của GitHub với không gì cả; luôn phân giải ra 40 ký tự. */
export function resolveCommitSha(input, git = gitDefault) {
  if (typeof input !== 'string' || !input || input.startsWith('-')) throw new Error('--sha cần một commit.');
  let sha = '';
  try { sha = git(['rev-parse', '--verify', '--quiet', `${input}^{commit}`]); } catch { sha = ''; }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Không phân giải được "${input}" thành commit đủ 40 ký tự trong clone này — git fetch origin rồi thử lại.`);
  }
  return sha;
}

export function docBuildSha(html) {
  const tag = /<meta\b[^>]*\bname=["']build-sha["'][^>]*>/i.exec(String(html ?? ''))?.[0];
  return tag ? (/\bcontent=["']([^"']*)["']/i.exec(tag)?.[1] ?? null) : null;
}

/** Deployment production mới nhất của ĐÚNG project cho đúng SHA. */
export function chonDeployment(deployments, sha) {
  return (deployments ?? [])
    .filter((d) => d.name === VERCEL_PROJECT && d.target === 'production' && d.meta?.githubCommitSha === sha)
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0] ?? null;
}

/** Một lần quan sát. `done` = kết luận cuối; còn lại là đang chờ. */
async function quanSat({ sha, projectId, api, request, now }) {
  const short = sha.slice(0, 12);
  const { deployments } = await api(`/v6/deployments?projectId=${projectId}&target=production&limit=20`);
  const deployment = chonDeployment(deployments, sha);
  if (!deployment) return { message: `Vercel chưa có deployment production của ${VERCEL_PROJECT} cho ${short}` };
  const state = deployment.state ?? deployment.readyState;
  if (['ERROR', 'CANCELED'].includes(state)) return { done: true, code: 1, message: `Deployment ${VERCEL_PROJECT} của ${short} kết thúc ${state}` };
  if (state !== 'READY') return { message: `Deployment ${VERCEL_PROJECT} của ${short} đang ${state ?? 'không rõ trạng thái'}` };
  const page = await request(`${PRODUCTION_URL}?release-verify=${now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!page.ok) return { message: `Deployment READY nhưng ${PRODUCTION_URL} trả HTTP ${page.status}` };
  const live = docBuildSha(await page.text());
  if (live === sha) return { done: true, code: 0, message: `${PRODUCTION_URL} phục vụ đúng ${short} (deployment READY)` };
  return { mismatch: true, message: `Deployment READY nhưng ${PRODUCTION_URL} đang chạy ${live ? live.slice(0, 12) : '(không có meta build-sha)'}` };
}

/** Chờ có giới hạn tới khi production phục vụ đúng SHA. Không ghi gì lên Vercel. */
export async function verifyVercelRelease({ sha, token, request = fetch, waitMs = 900_000, pollMs = 15_000, now = Date.now, sleep = delay, log = console.log }) {
  if (!token) return { code: 3, message: 'Thiếu VERCEL_TOKEN — CHƯA xác minh production đang chạy commit nào.' };
  const api = async (path) => {
    const res = await request(`https://api.vercel.com${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Vercel API ${res.status}`);
    return res.json();
  };
  const deadline = now() + waitMs;
  let last = null;
  try {
    const project = await api(`/v9/projects/${VERCEL_PROJECT}`);
    if (project?.name !== VERCEL_PROJECT || !project.id) return { code: 3, message: `Không thấy project Vercel "${VERCEL_PROJECT}".` };
    for (;;) {
      const step = await quanSat({ sha, projectId: project.id, api, request, now });
      if (step.done) return { code: step.code, message: step.message };
      const remaining = deadline - now();
      if (remaining <= 0) return { code: step.mismatch ? 1 : 3, message: `Hết giờ chờ: ${step.message}` };
      if (step.message !== last) log(`  ${step.message}; chờ tiếp tối đa ${Math.ceil(remaining / 1000)} giây.`);
      last = step.message;
      await sleep(Math.min(pollMs, remaining));
    }
  } catch (error) {
    return { code: 3, message: `KHÔNG KIỂM ĐƯỢC: ${error.message}` };
  }
}

export function parseWaitSeconds(argv, fallback) {
  const i = argv.indexOf('--wait-seconds');
  const value = i < 0 ? fallback : Number(argv[i + 1]);
  if (!Number.isInteger(value) || value < 0 || value > MAX_WAIT_SECONDS) throw new Error(`--wait-seconds phải là số nguyên từ 0 đến ${MAX_WAIT_SECONDS}.`);
  return value;
}

export function inKetQua({ code, message }) {
  (code === 0 ? console.log : console.error)(`${code === 0 ? '✅' : '❌'} ${message}`);
}

async function main(argv) {
  let sha;
  let waitSeconds;
  try {
    const i = argv.indexOf('--sha');
    sha = resolveCommitSha(i >= 0 ? argv[i + 1] : undefined);
    waitSeconds = parseWaitSeconds(argv, 900);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 3;
    return;
  }
  console.log(`Xác minh production (${VERCEL_PROJECT}) phục vụ ${sha.slice(0, 12)}, chờ tối đa ${waitSeconds} giây.`);
  const result = await verifyVercelRelease({ sha, token: process.env.VERCEL_TOKEN, waitMs: waitSeconds * 1000 });
  inKetQua(result);
  process.exitCode = result.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
