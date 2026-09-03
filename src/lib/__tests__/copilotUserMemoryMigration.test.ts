// Contract test for the G1-D2 migration: `public.ai_user_memory` + three RPCs.
//
// The table and its functions cannot be exercised from vitest (they need a
// cluster and a JWT), so what is asserted here is the half a reviewer forgets
// first and no type system catches: the row-level boundary, the cap that makes
// the cap real, the ACL, and the input validation.
//
// The failure mode being guarded is quiet. Nothing here raises an error when it
// is wrong: a policy written `organization_id = ANY(my_org_ids())` INSTEAD of
// `user_id = auth.uid()` still returns rows, still looks like a working feature,
// and hands one colleague another colleague's private notes.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260903012621_ai_user_memory_v1.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

/**
 * SQL with `--` line comments removed.
 *
 * Every assertion below runs on this, not on the raw file. The header EXPLAINS
 * each rule at length, so a grep over the raw text would be satisfied by the
 * explanation alone — delete the code, keep the paragraph, test still green.
 */
function boCommentSql(source: string): string {
  return source.replace(/--[^\n]*/g, '');
}

/** Body of one `CREATE OR REPLACE FUNCTION public.<name>` up to the next one. */
function thanHam(source: string, name: string): string {
  const start = source.search(new RegExp(`create or replace function public\\.${name}\\s*\\(`, 'i'));
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/CREATE OR REPLACE FUNCTION/i);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/mi);
  const ends = [nextFn, acl].filter((index) => index >= 0);
  return ends.length === 0 ? source.slice(start) : source.slice(start, start + 1 + Math.min(...ends));
}

const sql = boCommentSql(migration);

const RPC = [
  { ten: 'copilot_memory_upsert_v1', chuKy: 'uuid, text, text' },
  { ten: 'copilot_memory_forget_v1', chuKy: 'uuid, text' },
  { ten: 'copilot_memory_list_v1', chuKy: 'uuid' },
] as const;

describe('migration ai_user_memory — có mặt và đúng khuôn', () => {
  it('file migration tồn tại', () => {
    expect(migration.length).toBeGreaterThan(2000);
  });

  it('một cặp BEGIN/COMMIT kèm lock_timeout', () => {
    expect(sql.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '15s'/);
  });

  it('chạy được lượt hai: mọi đối tượng đều tạo có điều kiện', () => {
    // Idempotent không phải chuyện lịch sự — Restore Drill replay TOÀN BỘ ledger
    // lên một DB rỗng, và một `CREATE TABLE` trần sẽ làm cả lượt replay chết ở
    // đây, kéo theo mọi migration sau nó.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ai_user_memory/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS ai_user_memory_owner_key_uidx/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS ai_user_memory_owner_updated_idx/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS ai_user_memory_own/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_ai_user_memory_cap/);
    expect(sql).not.toMatch(/CREATE TABLE public\.ai_user_memory/);
  });
});

describe('ranh giới hàng — của TÔI, trong công ty TÔI thuộc về', () => {
  it('RLS bật và có đúng policy own-row', () => {
    expect(sql).toMatch(/ALTER TABLE public\.ai_user_memory ENABLE ROW LEVEL SECURITY/);
    const policy = sql.slice(sql.indexOf('CREATE POLICY ai_user_memory_own'));
    expect(policy).toMatch(/USING \(user_id = \(SELECT auth\.uid\(\)\)\)/);
    // WITH CHECK phải mang CẢ HAI vế. Chỉ `user_id` thì một hàng của chính mình
    // vẫn ghi được với `organization_id` của công ty người ta không thuộc về.
    expect(policy).toMatch(/WITH CHECK \(\s*user_id = \(SELECT auth\.uid\(\)\)/);
    expect(policy).toMatch(/organization_id = ANY \(public\.my_org_ids\(\)\)/);
  });

  it('anon không đọc được bảng, authenticated chỉ có DML (RLS lọc hàng)', () => {
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.ai_user_memory FROM PUBLIC/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.ai_user_memory FROM anon/);
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.ai_user_memory TO authenticated/,
    );
    expect(sql).not.toMatch(/GRANT[^;]*ON TABLE public\.ai_user_memory TO anon/);
  });

  it('organization_id NOT NULL và có FK — không có ghi nhớ "không thuộc công ty nào"', () => {
    expect(sql).toMatch(
      /organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(/user_id\s+uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
  });

  it('UNIQUE (user, org, key) — ghi nhớ là GHI ĐÈ, không chồng chất', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ai_user_memory_owner_key_uidx\s*\n?\s*ON public\.ai_user_memory \(user_id, organization_id, key\)/,
    );
  });
});

describe('luật nội dung — khoá, độ dài, nguồn', () => {
  it('CHECK khoá theo đúng khuôn ^[a-z0-9_]{1,40}$', () => {
    expect(sql).toMatch(/CONSTRAINT ai_user_memory_key_format_chk\s*\n?\s*CHECK \(key ~ '\^\[a-z0-9_\]\{1,40\}\$'\)/);
  });

  it('CHECK giá trị 1..500 ký tự', () => {
    expect(sql).toMatch(/CHECK \(char_length\(value\) BETWEEN 1 AND 500\)/);
  });

  it('CHECK source chỉ nhận user/copilot', () => {
    expect(sql).toMatch(/CHECK \(source IN \('user', 'copilot'\)\)/);
  });
});

describe('trần 30 mục — cưỡng chế ở TRIGGER, không chỉ ở RPC', () => {
  const cap = thanHam(sql, 'ai_user_memory_cap_v1');

  it('có trigger BEFORE INSERT gắn vào bảng', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER trg_ai_user_memory_cap\s*\n?\s*BEFORE INSERT ON public\.ai_user_memory/,
    );
  });

  it('trigger đếm các khoá KHÁC — upsert khoá đã có không bị chặn', () => {
    // Đếm cả khoá đang ghi thì người dùng đủ 30 mục không sửa nổi mục họ đang có.
    expect(cap).toMatch(/m\.key <> NEW\.key/);
    expect(cap).toMatch(/IF v_khac >= 30 THEN/);
    expect(cap).toMatch(/memory_limit_reached/);
  });

  it('trần là một CON SỐ trong mã, không phải lời hứa trong chú thích', () => {
    expect(cap.replace(/\s+/g, ' ')).toContain('>= 30');
  });
});

describe('ba RPC — SECURITY INVOKER, search_path, ACL tường minh', () => {
  for (const { ten, chuKy } of RPC) {
    describe(ten, () => {
      const than = thanHam(sql, ten);

      it('tồn tại và là SECURITY INVOKER', () => {
        expect(than.length).toBeGreaterThan(200);
        expect(than).toMatch(/SECURITY INVOKER/);
        expect(than).not.toMatch(/SECURITY DEFINER/);
      });

      it('ghim search_path', () => {
        expect(than).toMatch(/SET search_path = pg_catalog, public/);
      });

      it('chặn khách vãng lai và công ty ngoài phạm vi', () => {
        expect(than).toMatch(/v_actor uuid := auth\.uid\(\)/);
        expect(than).toMatch(/IF v_actor IS NULL THEN\s*\n\s*RAISE EXCEPTION 'not_permitted'/);
        expect(than).toMatch(/organization_required/);
        expect(than).toMatch(/NOT \(p_organization_id = ANY \(public\.my_org_ids\(\)\)\)/);
      });

      it('mọi câu lệnh trong hàm đều neo vào v_actor', () => {
        // Bỏ vế này là mở đúng cánh cửa RLS đang đóng: hàm INVOKER vẫn bị RLS
        // chặn, nhưng một hàm quên `user_id` sẽ đọc/ghi nhầm khi ai đó đổi hàm
        // sang DEFINER về sau — và đó là thay đổi một dòng.
        expect(than).toMatch(/user_id = v_actor|\(user_id, organization_id, key, value, source\)/);
      });

      it('ACL: REVOKE PUBLIC + anon, GRANT EXECUTE cho authenticated', () => {
        const sig = `public\\.${ten}\\(${chuKy.replace(/, /g, ', ')}\\)`;
        expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`));
        expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM anon`));
        expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated`));
        expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO anon`));
      });
    });
  }

  it('tên hàm "quên" KHÔNG chứa từ khoá mà cửa chặn hành-động-cấm dò', () => {
    // `scripts/check-copilot-forbidden-actions.mjs` dò `delete|remove|xoa|xóa`
    // ngay trong thân `execute:` của tool. Một RPC tên `copilot_memory_delete_v1`
    // sẽ làm tool `quen` bị chấm là hành động XOÁ bị cấm — đúng theo luật của
    // cửa chặn, dù việc nó làm là bỏ một ghi chú của chính người dùng. Tên
    // `forget` là cách giữ cả hai: cửa chặn vẫn nghiêm, tool vẫn tồn tại.
    expect(sql).toMatch(/copilot_memory_forget_v1/);
    expect(sql).not.toMatch(/copilot_memory_delete_v1/);
  });

  it('upsert ghi đè theo UNIQUE, không đẻ hàng thứ hai', () => {
    const than = thanHam(sql, 'copilot_memory_upsert_v1');
    expect(than).toMatch(/ON CONFLICT \(user_id, organization_id, key\) DO UPDATE/);
    expect(than).toMatch(/updated_at = now\(\)/);
  });

  it('forget: khoá không tồn tại KHÔNG phải lỗi', () => {
    const than = thanHam(sql, 'copilot_memory_forget_v1');
    expect(than).toMatch(/'found', v_so > 0/);
    expect(than).not.toMatch(/khong_tim_thay|not_found/);
  });

  it('list: STABLE, cắt 30 mục và sắp thứ tự TRONG jsonb_agg', () => {
    const than = thanHam(sql, 'copilot_memory_list_v1');
    expect(than).toMatch(/\bSTABLE\b/);
    expect(than).toMatch(/LIMIT 30/);
    expect(than).toMatch(/ORDER BY s\.updated_at DESC\s*\n?\s*\)/);
  });
});

describe('nghiệm thu chỉ soi catalog — chạy được trên DB rỗng', () => {
  const khoi = sql.slice(sql.indexOf('DO $nghiem_thu$'));

  it('không đọc dữ liệu nghiệp vụ nào', () => {
    expect(khoi).not.toMatch(/FROM public\.(?!ai_user_memory\b)[a-z_]+/);
    expect(khoi).toMatch(/to_regclass\('public\.ai_user_memory'\)/);
    expect(khoi).toMatch(/pg_policy/);
    expect(khoi).toMatch(/pg_trigger/);
  });

  it('khẳng định RLS, policy, trigger, unique và ACL của cả ba RPC', () => {
    expect(khoi).toMatch(/relrowsecurity/);
    expect(khoi).toMatch(/ai_user_memory_own/);
    expect(khoi).toMatch(/trg_ai_user_memory_cap/);
    expect(khoi).toMatch(/ai_user_memory_owner_key_uidx/);
    for (const { ten } of RPC) expect(khoi).toContain(ten);
    expect(khoi).toMatch(/has_function_privilege\('anon'/);
    expect(khoi).toMatch(/has_table_privilege\('anon'/);
  });

  it('đòi migration nền đã chạy trước', () => {
    expect(khoi).toMatch(/my_org_ids missing/);
  });
});
