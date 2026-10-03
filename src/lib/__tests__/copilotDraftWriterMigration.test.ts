import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIG_DIR = 'supabase/migrations';
const hardeningPath =
  'supabase/migrations/20260830171108_copilot_income_expense_rpc_hardening_v1.sql';
const hardening = existsSync(hardeningPath)
  ? readFileSync(hardeningPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

/**
 * Định nghĩa SỐNG của public.ie_compat_insert_v2 = lần CREATE cuối cùng theo thứ tự timestamp
 * (khuôn liveDefinitionOf — salaryCompletionDate.test.ts). Hàm được forward-fix nhiều lần
 * (20260830183259 bật chế độ nháp Copilot; 20261003151606 chặn lập tay hạng mục chi hệ thống);
 * soi file đã đóng băng thì test xanh vĩnh viễn kể cả khi hàm thật đổi hành vi.
 */
function liveCompatWriter(): string {
  const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.ie_compat_insert_v2\s*\(/i;
  let sql = '';
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    const text = readFileSync(join(MIG_DIR, f), 'utf8').replace(/\r\n/g, '\n');
    const start = text.search(re);
    if (start < 0) continue;
    const end = text.indexOf('$function$;', start);
    sql = text.slice(start, end < 0 ? undefined : end);
  }
  return sql;
}
const migration = liveCompatWriter();

function functionBody(sql: string, name: string): string {
  const start = sql.search(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\s*\\(`, 'i'));
  return start < 0 ? '' : sql.slice(start);
}

describe('Copilot draft writer migration', () => {
  it('adds a forward-only server-recognized draft-only mode to the compat writer', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.ie_compat_insert_v2/i,
    );
    expect(migration).toMatch(/v_draft_marker\s+text/i);
    expect(migration).toMatch(
      /approval_status[\s\S]{0,700}v_copilot_draft[\s\S]{0,700}UNAPPROVED/i,
    );
    expect(migration).toMatch(/v_copilot_draft[\s\S]{0,700}account_id[\s\S]{0,700}NULL/i);
  });

  it('routes the Copilot execute RPC through draft-only mode', () => {
    const body = functionBody(
      hardening,
      'public\\.copilot_execute_income_expense_v1',
    );
    expect(body).toMatch(/INSERT INTO app_private\.copilot_ie_writer_context_v1/i);
    expect(body).toMatch(/copilot_ie_writer_ready_v1/i);
    expect(body).not.toMatch(/set_config\('app\.copilot_draft_marker'/i);
  });

  it('keeps the writer output contract and idempotency guard', () => {
    const body = functionBody(
      hardening,
      'public\\.copilot_execute_income_expense_v1',
    );
    expect(migration).toMatch(/approval_status[\s\S]{0,500}UNAPPROVED/i);
    expect(migration).toMatch(/posting_status[\s\S]{0,500}UNPOSTED/i);
    expect(body).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtextextended/i);
    expect(body).toMatch(/ON CONFLICT\s*\(idempotency_key\)\s*DO NOTHING/i);
    expect(body).toMatch(/orphan|entity_id[\s\S]{0,300}not found/i);
  });

  it('does not trust ambient client-set GUCs for draft capability', () => {
    expect(migration).toMatch(/app_private\.copilot_ie_writer_context_v1/i);
    expect(migration).toMatch(/pg_current_xact_id\(\)/i);
    expect(migration).toMatch(/marker_digest/i);
    expect(migration).not.toMatch(/current_setting\('app\.copilot_writer_context'/i);
    expect(migration).not.toMatch(/current_setting\('app\.copilot_draft_marker'/i);
    expect(migration).not.toMatch(/set_config\('app\.copilot_writer_context'/i);
    expect(migration).not.toMatch(/set_config\('app\.copilot_draft_marker'/i);
  });

  it('forces actor identity and strips every recurrence/lifecycle field in draft mode', () => {
    expect(migration).toMatch(/'user_id'\s*,\s*auth\.uid\(\)/i);
    expect(migration).not.toMatch(/'user_id'\s*,\s*COALESCE\(\(p_row->>'user_id'/i);
    expect(migration).toMatch(/repeat_next_date/i);
    expect(migration).toMatch(/repeat_parent_id/i);
    expect(migration).toMatch(/'account_id'\s*,\s*NULL/i);
    expect(migration).toMatch(/'repeat_cycle'\s*,\s*'NONE'/i);
  });

  it('server-validates and rebuilds the Copilot item allowlist', () => {
    expect(migration).toMatch(/income_expense_types/i);
    expect(migration).toMatch(/system_only/i);
    expect(migration).toMatch(/income_expense_items/i);
    expect(migration).toMatch(/organization_id\s*=\s*v_org/i);
    expect(migration).toMatch(/jsonb_build_object\([\s\S]{0,500}income_expense_type_id/i);
  });

  it('nhánh thường (không phải nháp Copilot) chặn lập tay hạng mục CHI system_only trước mọi lệnh ghi', () => {
    // Danh mục chi chuẩn 03/10/2026: trang Thu chi rơi sang đây khi writer chính trả 0A000.
    expect(migration).toMatch(
      /IF NOT v_copilot_draft AND EXISTS[\s\S]{0,400}system_only[\s\S]{0,200}'expense'[\s\S]{0,400}ie_system_only_manual_blocked/i,
    );
    const guard = migration.search(/ie_system_only_manual_blocked/);
    const firstInsert = migration.search(/INSERT INTO public\.income_expenses\b/i);
    expect(guard).toBeGreaterThan(0);
    expect(firstInsert).toBeGreaterThan(guard);
  });

  // Hai bài về CẤU TRÚC của migration bật chế độ nháp (bảng ngữ cảnh, cờ capability, phát lại
  // được) nằm ở copilotDraftWriterReplay.test.ts — chúng đo chính file đó, không đo hàm writer.
});
