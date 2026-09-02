// `reserve_ai_usage` phải BIẾT công ty nào đang tiêu hạn mức.
//
// LỖ ĐANG VÁ
//   Hàm cũ INSERT vào `ai_usage_logs` mà KHÔNG có `organization_id`. Cột đó là
//   NOT NULL trên thực tế nhờ trigger `trg_autofill_org_strict`
//   (`20260811060000`), và hàm `app_private.autofill_org_strict` chỉ suy được
//   công ty khi người dùng có ĐÚNG MỘT membership ACTIVE — ngược lại nó RAISE
//   23502 và proxy trả 500 `internal`.
//
//   Hôm nay chưa nổ vì cả ba người từng gọi Copilot đều thuộc đúng một công ty.
//   Nhưng Copilot vừa có ô CHỌN công ty (`list_my_copilot_organizations_v1`,
//   `20260814032500`): người đa tổ chức là kịch bản được thiết kế, không phải
//   ngoại lệ. Với họ, mỗi lượt gọi Copilot hoặc chết 500 hoặc — nếu trigger suy
//   được — ghi hạn mức vào một công ty người dùng KHÔNG chọn.
//
//   Suy công ty từ `user_id` là đoán. Người dùng đã nói họ đang làm việc cho ai;
//   con số phải đi vào sổ theo lời đó, không theo suy luận của trigger.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DUONG_DAN =
  'supabase/migrations/20260902132418_copilot_reserve_ai_usage_organization_v1.sql';
const sql = readFileSync(DUONG_DAN, 'utf8').replace(/\r\n/g, '\n');

const CHU_KY_CU = 'public.reserve_ai_usage(uuid, text, text, text, text, numeric)';
const CHU_KY_MOI = 'public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)';
const esc = (s: string) => s.replace(/[().]/g, '\\$&');

describe('đổi chữ ký: DROP bản cũ TRƯỚC khi CREATE bản mới', () => {
  it('có DROP FUNCTION IF EXISTS đúng chữ ký 6 tham số', () => {
    expect(sql).toMatch(
      new RegExp(`DROP\\s+FUNCTION\\s+IF\\s+EXISTS\\s+${esc(CHU_KY_CU)}\\s*;`, 'i'),
    );
  });

  it('CREATE bản 7 tham số, và DROP đứng TRƯỚC nó', () => {
    // Thêm tham số bằng CREATE OR REPLACE là đẻ overload: PostgREST/PostgreSQL
    // chọn theo tham số gửi lên, nên bản cũ vẫn gọi được và vẫn INSERT thiếu
    // `organization_id`. Vá mà để nguyên đường cũ thì không phải vá.
    const iDrop = sql.search(new RegExp(`DROP\\s+FUNCTION\\s+IF\\s+EXISTS\\s+${esc(CHU_KY_CU)}`, 'i'));
    const iCreate = sql.search(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.reserve_ai_usage/i);
    expect(iDrop).toBeGreaterThanOrEqual(0);
    expect(iCreate).toBeGreaterThanOrEqual(0);
    expect(iDrop).toBeLessThan(iCreate);
  });

  it('chữ ký mới khai đủ 7 tham số, `p_organization_id uuid` ở cuối', () => {
    for (const thamSo of [
      'p_user_id uuid',
      'p_feature text',
      'p_provider text',
      'p_model text',
      'p_task_id text',
      'p_est_cost_usd numeric',
      'p_organization_id uuid',
    ]) {
      expect(sql, `chữ ký thiếu ${thamSo}`).toContain(thamSo);
    }
    // Đuôi danh sách tham số: org là tham số CUỐI, thêm vào không xáo thứ tự cũ.
    // (Cho phép chú thích xen giữa — lý do của DEFAULT NULL được ghi ngay tại đó.)
    expect(sql).toMatch(
      /p_est_cost_usd\s+numeric\s*,[\s\S]*?p_organization_id\s+uuid\s+DEFAULT\s+NULL\s*\n?\s*\)/i,
    );
  });

  it('tham số org khai `DEFAULT NULL` — giữ đường lùi cho proxy bản 6 tham số', () => {
    // Không phải để đóng cửa sổ 500 giữa migration và deploy (chỉ deploy proxy
    // NGAY mới đóng được cửa sổ đó). DEFAULT NULL làm hai việc khác:
    //   - rollback RIÊNG llm-proxy về bản 6 tham số không chết PGRST202
    //     "function not found", mà rơi vào `organization_required` (400);
    //   - nhánh `organization_required` ở tầng RPC mới VỚI TỚI ĐƯỢC. Tham số
    //     trần thì PostgREST chặn ở khâu phân giải hàm và nhánh đó là mã chết.
    expect(sql).toMatch(/p_organization_id\s+uuid\s+DEFAULT\s+NULL/i);
    // …và lý do phải nằm trong file, không nằm trong trí nhớ của một người.
    expect(sql).toMatch(/DEFAULT\s+NULL/);
    expect(sql).toMatch(/PGRST202/);
  });

  it('DEFAULT NULL KHÔNG nới lỏng: NULL vẫn RAISE, và đứng trước advisory lock', () => {
    // Nếu ai đó gỡ `RAISE 'organization_required'` vì "đã có default rồi", hàm
    // quay lại đúng lỗ ban đầu: INSERT với organization_id NULL.
    const iRaise = sql.search(/RAISE\s+EXCEPTION\s+'organization_required'/i);
    const iLock = sql.search(/pg_advisory_xact_lock/i);
    expect(iRaise).toBeGreaterThanOrEqual(0);
    expect(iLock).toBeGreaterThan(iRaise);
  });

  it('giữ SECURITY DEFINER kèm search_path cố định', () => {
    expect(sql).toMatch(/LANGUAGE\s+plpgsql\s+SECURITY\s+DEFINER/i);
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public,\s*auth/i);
  });
});

describe('chặn tổ chức rỗng và tổ chức không phải của mình', () => {
  it('p_organization_id NULL → RAISE organization_required', () => {
    expect(sql).toMatch(
      /IF\s+p_organization_id\s+IS\s+NULL\s+THEN\s+RAISE\s+EXCEPTION\s+'organization_required'/i,
    );
  });

  it('không có quyền trên org → RAISE organization_forbidden', () => {
    expect(sql).toMatch(/RAISE\s+EXCEPTION\s+'organization_forbidden'/i);
  });

  it('quyền đo bằng super_admins HOẶC membership ACTIVE trên org ACTIVE', () => {
    expect(sql).toMatch(/FROM\s+public\.super_admins/i);
    expect(sql).toMatch(/public\.organization_memberships/i);
    expect(sql).toMatch(/m\.user_id\s*=\s*p_user_id/i);
    expect(sql).toMatch(/m\.status\s*=\s*'ACTIVE'/i);
    expect(sql).toMatch(/o\.status\s*=\s*'ACTIVE'/i);
  });

  it('super admin KHÔNG mượn được org sandbox — khớp danh bạ 20260814032500', () => {
    // Danh bạ chọn công ty đã loại org sandbox khỏi tầm nhìn super admin. Nếu
    // reserve vẫn nhận, hai lớp nói hai điều khác nhau về cùng một câu hỏi.
    expect(sql).toMatch(/sandbox_org_ids\(\)/i);
  });

  it('kiểm org đứng TRƯỚC INSERT — không để lại dòng pending rác', () => {
    const iKiem = sql.search(/RAISE\s+EXCEPTION\s+'organization_forbidden'/i);
    const iInsert = sql.search(/INSERT\s+INTO\s+public\.ai_usage_logs/i);
    expect(iKiem).toBeGreaterThanOrEqual(0);
    expect(iInsert).toBeGreaterThan(iKiem);
  });
});

describe('reservation ghi đúng công ty', () => {
  it('INSERT có cột organization_id nhận p_organization_id', () => {
    const insert = sql.match(/INSERT\s+INTO\s+public\.ai_usage_logs[\s\S]*?RETURNING/i)?.[0] ?? '';
    expect(insert).toMatch(/organization_id/i);
    expect(insert).toMatch(/p_organization_id/i);
  });

  it('giữ nguyên bộ gate cũ: kill switch, entitlement, permission, rate, 3 cấp quota', () => {
    // Task này CHỈ thêm org. Rơi mất một gate ở đây là mở lại đúng thứ hàm đó
    // sinh ra để canh.
    for (const chuoi of [
      'pg_advisory_xact_lock',
      'ai_copilot_settings',
      'ai_copilot_entitlements',
      'ai_copilot_perms_for',
      'rate_per_min',
      'daily_usd_cap_user',
      'daily_usd_cap_tenant',
      'daily_usd_cap_global',
      'staff_assignments',
    ]) {
      expect(sql, `thân hàm rơi mất ${chuoi}`).toContain(chuoi);
    }
    for (const ma of ['copilot_disabled', 'not_entitled', 'not_permitted', 'rate_limited', 'daily_quota']) {
      expect(sql, `mất mã lỗi ${ma}`).toContain(`'${ma}'`);
    }
  });
});

describe('quyền trên chữ ký mới', () => {
  it('REVOKE PUBLIC/anon/authenticated rồi GRANT service_role', () => {
    // Án lệ: REVOKE ... FROM PUBLIC KHÔNG cắt `anon` trên Supabase — phải gọi
    // tên từng vai. DROP+CREATE xoá sạch ACL cũ nên bước này bắt buộc.
    expect(sql).toMatch(
      new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${esc(CHU_KY_MOI)}\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated;`, 'i'),
    );
    expect(sql).toMatch(
      new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${esc(CHU_KY_MOI)}\\s+TO\\s+service_role;`, 'i'),
    );
  });
});

describe('khối nghiệm thu chỉ soi catalog', () => {
  it('chữ ký mới tồn tại, chữ ký cũ đã biến mất', () => {
    expect(sql).toMatch(
      /to_regprocedure\(\s*'public\.reserve_ai_usage\(uuid,\s*text,\s*text,\s*text,\s*text,\s*numeric,\s*uuid\)'\s*\)\s+IS\s+NULL/i,
    );
    expect(sql).toMatch(
      /to_regprocedure\(\s*'public\.reserve_ai_usage\(uuid,\s*text,\s*text,\s*text,\s*text,\s*numeric\)'\s*\)\s+IS\s+NOT\s+NULL/i,
    );
  });

  it('anon/authenticated KHÔNG gọi được, service_role thì có', () => {
    expect(sql).toMatch(/has_function_privilege\(\s*'anon'\s*,\s*'public\.reserve_ai_usage\(uuid,\s*text,\s*text,\s*text,\s*text,\s*numeric,\s*uuid\)'\s*,\s*'EXECUTE'\s*\)/i);
    expect(sql).toMatch(/has_function_privilege\(\s*'authenticated'\s*,/i);
    expect(sql).toMatch(/has_function_privilege\(\s*'service_role'\s*,/i);
  });

  it('KHÔNG chèn dòng thử vào ai_usage_logs ngoài thân hàm', () => {
    // Bảng này là sổ chi phí: một dòng rác làm lệch đúng con số hạn mức ngày
    // đọc. Khối nghiệm thu vì thế chỉ soi catalog và chạy được trên DB rỗng.
    const ngoaiHam = sql.replace(/AS\s+\$fn\$[\s\S]*?\$fn\$/i, '');
    expect(ngoaiHam).not.toMatch(/INSERT\s+INTO\s+public\.ai_usage_logs/i);
    expect(ngoaiHam).not.toMatch(/SELECT\s+public\.reserve_ai_usage\s*\(/i);
  });
});

describe('hình dạng migration', () => {
  it('đúng MỘT cặp BEGIN/COMMIT kèm lock_timeout', () => {
    const khongChuThich = sql.replace(/--[^\n]*/g, '');
    expect(khongChuThich.match(/^\s*BEGIN;/gm)?.length ?? 0).toBe(1);
    expect(khongChuThich.match(/^\s*COMMIT;/gm)?.length ?? 0).toBe(1);
    expect(sql).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'15s';/i);
  });

  it('mở đầu bằng lý do, không phải chỉ tên hàm', () => {
    expect(sql.slice(0, 2000)).toMatch(/autofill_org_strict|đa tổ chức|hạn mức/i);
  });
});
