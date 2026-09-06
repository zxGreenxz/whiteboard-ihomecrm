#!/usr/bin/env node
// Read-only G5-E evidence audit. See docs/engineering/copilot-ledger-audit.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2);
    out[key] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

function readEnvFile() {
  const env = readFileSync(join(repoRoot, '.env'), 'utf8');
  return {
    url: env.match(/VITE_SUPABASE_URL="([^"]+)"/)?.[1],
    apikey: env.match(/VITE_SUPABASE_PUBLISHABLE_KEY="([^"]+)"/)?.[1],
  };
}

class Client {
  constructor(url, apikey) {
    this.url = url;
    this.apikey = apikey;
  }

  async login(email, password) {
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: this.apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.access_token) {
      throw new Error(`Đăng nhập ${email} thất bại (HTTP ${res.status}).`);
    }
    return body.access_token;
  }

  async rpc(jwt, name, args) {
    const res = await fetch(`${this.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: this.apikey,
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'public',
        'Accept-Profile': 'public',
      },
      body: JSON.stringify(args ?? {}),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  async table(jwt, path) {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      headers: { apikey: this.apikey, Authorization: `Bearer ${jwt}`, 'Accept-Profile': 'public' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Đọc ${path} trả HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}


// PostgreSQL timestamps carry microseconds; Date alone loses the paging boundary.
function instant(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('invalid_timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('invalid_timestamp');
  const micros = (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(0, 6);
  return BigInt(Math.floor(ms / 1000)) * 1000000n + BigInt(micros);
}
function registryMap(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('registry_missing');
  const map = new Map();
  for (const r of rows) {
    if (!r || typeof r.action_id !== 'string' || !r.action_id || map.has(r.action_id) ||
        !['nonce_abi_v1', 'maker_submit_v1', 'direct_l5_v1'].includes(r.executor_kind) ||
        !['L3', 'L4', 'L5'].includes(r.risk) || typeof r.grantable !== 'boolean' || typeof r.pin_always !== 'boolean' ||
        (r.executor_kind === 'direct_l5_v1' && r.risk !== 'L5')) throw new Error('registry_malformed');
    map.set(r.action_id, r);
  }
  if (![...map.values()].some(r => r.executor_kind === 'direct_l5_v1')) throw new Error('registry_no_direct_l5');
  return map;
}

export async function doiChieuSo(client, jwtSys, { org, days = 14, since, until }) {
  const upper = until ?? new Date().toISOString();
  const lower = since ?? new Date(Date.parse(upper) - days * 86400000).toISOString();
  if (instant(lower) >= instant(upper) || instant(upper) - instant(lower) > 366n * 86400000000n) throw new Error('invalid_window');
  const findings = { unintendedWrite: [], duplicate: [], wrongOrg: [], wrongActor: [], incomplete: [] };
  const add = (kind, reason, r = {}) => findings[kind].push({ reason, id: r.id ?? null, action_id: r.action_id ?? null });
  let registry, registrySignature, missingSteps, ledgerRows = 0, auditRows = 0;
  const seenDuplicates = new Set();
  const duplicate = r => { const key = r.audit_id ?? r.id; if (!seenDuplicates.has(key)) { seenDuplicates.add(key); add('duplicate', 'multiple_execution_records', r); } };
  for (const stream of ['ledger', 'audit']) {
    let cursor = null, fetched = 0, total;
    const seen = new Set();
    try {
      while (true) {
        const response = await client.rpc(jwtSys, 'copilot_ledger_audit_page_v1', {
          p_organization_id: org, p_since: lower, p_until: upper, p_stream: stream,
          p_after_at: cursor?.created_at ?? null, p_after_id: cursor?.id ?? null, p_limit: 200,
        });
        if (response.status !== 200) throw new Error(`source_http_${response.status}`);
        const b = response.body;
        if (!b || b.version !== 1 || !Array.isArray(b.rows) || b.rows.length > 200 || !Number.isSafeInteger(b.total) || b.total < 0 ||
            !Number.isSafeInteger(b.missing_step_ledger) || b.missing_step_ledger < 0) throw new Error('source_malformed');
        const map = registryMap(b.registry);
        const signature = JSON.stringify(b.registry);
        if (registrySignature && signature !== registrySignature) throw new Error('registry_changed_during_audit');
        registrySignature = signature; registry = map;
        if (total !== undefined && total !== b.total) throw new Error('window_changed_during_audit');
        if (missingSteps !== undefined && missingSteps !== b.missing_step_ledger) throw new Error('step_coverage_changed_during_audit');
        missingSteps = b.missing_step_ledger; total = b.total;
        for (const r of b.rows) {
          const time = instant(r.created_at);
          if (typeof r.id !== 'string' || seen.has(r.id) || time < instant(lower) || time >= instant(upper) ||
              (cursor && (time < instant(cursor.created_at) || (time === instant(cursor.created_at) && r.id <= cursor.id)))) throw new Error('page_order_or_bounds_invalid');
          seen.add(r.id); cursor = r; fetched++;
          if (stream === 'ledger') ledgerRows++; else auditRows++;
          if (r.organization_id !== org) { add('wrongOrg', 'source_org_mismatch', r); continue; }
          if (stream === 'audit') {
            if (r.duplicate_key === true || r.duplicate_executions === true) duplicate(r);
            else if (r.duplicate_key !== false || r.duplicate_executions !== false) add('incomplete', 'audit_duplicate_evidence_missing', r);
            const reg = registry.get(r.action_id);
            if (!reg) add('incomplete', 'audit_action_absent_from_registry', r);
            if (reg?.executor_kind === 'direct_l5_v1' && (r.action_executions !== 1 || r.step_links < 1)) add('incomplete', 'audit_ledger_coverage_gap', r);
            continue;
          }
          if (r.plan_id) {
            if (r.plan_present !== true) add('incomplete', 'plan_missing_historical', r);
            else for (const [field, kind] of [['plan_actor_matches', 'wrongActor'], ['plan_org_matches', 'wrongOrg']]) {
              if (r[field] === false) add(kind, field, r);
              else if (r[field] !== true) add('incomplete', `${field}_missing`, r);
            }
          }
          if (!['step_done', 'action_executed'].includes(r.event)) continue;
          const reg = registry.get(r.action_id);
          if (!reg) { add('incomplete', 'action_absent_from_registry', r); continue; }
          if (r.entity_evidence === 'mismatch') add('wrongOrg', 'entity_org_mismatch', r);
          else if (!['match', 'not_applicable'].includes(r.entity_evidence)) add('incomplete', `entity_${r.entity_evidence ?? 'missing'}`, r);
          if (r.duplicate_executions === true) duplicate(r);
          else if (r.duplicate_executions !== false) add('incomplete', 'execution_duplicate_evidence_missing', r);
          if (reg.executor_kind !== 'direct_l5_v1') continue;
          if (r.audit_present !== true) add('incomplete', 'audit_missing_historical', r);
          else if (r.audit_matches === false) {
            if (r.audit_org_matches === false) add('wrongOrg', 'audit_org_mismatch', r);
            if (r.audit_actor_matches === false) add('wrongActor', 'audit_actor_mismatch', r);
            if (r.audit_org_matches !== false && r.audit_actor_matches !== false) add('incomplete', 'audit_action_or_entity_mismatch', r);
          }
          else if (r.audit_matches !== true) add('incomplete', 'audit_match_evidence_missing', r);
          if (r.action_executions !== 1 || !Number.isInteger(r.step_links) || r.step_links < 1) add('incomplete', 'execution_step_coverage_gap', r);
          if (r.has_after_digest !== true) add('incomplete', 'readback_evidence_missing_historical', r);
          // Wrapper events intentionally use click. Consent belongs to the correlated plan step.
          if (r.event !== 'step_done') continue;
          const validKind = r.consent_kind === 'step_up' ||
            (r.consent_kind === 'standing_grant' && reg.grantable && !reg.pin_always);
          if (r.consent_kind == null) add('incomplete', 'consent_kind_missing_historical', r);
          else if (!validKind || r.consent_evidence === 'invalid') add('unintendedWrite', 'invalid_direct_l5_consent', r);
          else if (r.consent_evidence !== 'valid') add('incomplete', 'consent_source_missing_historical', r);
          if (!r.plan_id) add('incomplete', 'plan_missing_historical', r);
          else if (r.plan_present === true) {
            for (const [field, kind] of [['plan_consent_matches', 'unintendedWrite']]) {
              if (r[field] === false) add(kind, field, r);
              else if (r[field] !== true) add('incomplete', `${field}_missing`, r);
            }
          }
        }
        if (b.rows.length < 200) { if (fetched !== total) throw new Error('window_row_count_mismatch'); break; }
        if (fetched > total) throw new Error('window_row_count_mismatch');
      }
    } catch (e) { add('incomplete', `${stream}:${e.message}`); }
  }
  if (missingSteps > 0) add('incomplete', `done_steps_without_matching_ledger:${missingSteps}`);
  const counts = Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length]));
  const violations = counts.unintendedWrite + counts.duplicate + counts.wrongOrg + counts.wrongActor;
  return { organizationId: org, windowSince: lower, windowUntil: upper, windowSemantics: '[since, until)',
    status: violations ? 'violations' : counts.incomplete ? 'incomplete' : 'clean',
    evidenceComplete: counts.incomplete === 0, canaryDurationVerified: false,
    directL5Actions: registry ? [...registry.values()].filter(r => r.executor_kind === 'direct_l5_v1').map(r => r.action_id) : [],
    ledgerRowsFetched: ledgerRows, ledgerRowsInWindow: ledgerRows, auditRowsInWindow: auditRows,
    counts, ...findings,
    notes: ['A bounded historical query does not establish an active canary duration.',
      'Missing historical evidence is incomplete, not a proven unintended write.',
      'Execution records and idempotency are checked; action_executed alone does not prove a new business effect.',
      'Registry and entity state are current; this audit does not reconstruct historical policy or arbitrary business effects.'],
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const org = args.org, days = Number(args.days ?? 14);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(org ?? '') || !Number.isFinite(days) || days <= 0 || days > 365) throw new Error('invalid_org_or_days');
  const email = args['sysadmin-email'] || process.env.COPILOT_LEDGER_AUDIT_SYSADMIN_EMAIL;
  const password = args['sysadmin-password'] || process.env.COPILOT_LEDGER_AUDIT_SYSADMIN_PASSWORD;
  if (!email || !password) throw new Error('missing_authenticated_superadmin_credentials');
  const { url, apikey } = readEnvFile();
  if (!url || !apikey) throw new Error('missing_supabase_configuration');
  const client = new Client(url, apikey);
  const jwt = await client.login(email, password);
  const report = await doiChieuSo(client, jwt, { org, days, since: args.since, until: args.until });
  console.log(JSON.stringify(report, null, 2));
  if (args.out) { const path = resolve(repoRoot, args.out); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + '\n'); }
  process.exitCode = report.status === 'violations' ? 2 : report.status === 'incomplete' ? 3 : 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { console.error('Audit failed before evidence could be produced. Check configuration, bounds and authentication.'); process.exitCode = 1; });
}
