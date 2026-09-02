// Chi phí một lượt gọi AI không được phép ÂM, và provider `mock` không được bật.
//
// Hai lỗ cùng nằm trên một đường: `x-mock-cost: -5` đi qua proxy vào thẳng
// `finalize_ai_usage(..., p_cost_usd => -5, ...)`, hàm ghi nguyên số đó vào
// `ai_usage_logs.cost_usd`, và `reserve_ai_usage` cộng cột ấy để so với hạn mức
// ngày. Một số âm ở đó không phải "ghi sai một dòng" — nó HOÀN LẠI hạn mức, nên
// ai gọi được proxy là tự nạp thêm quota cho mình.
//
// Vá ở proxy (G0-A, index.ts `clampMockCost`) là lớp thứ nhất. Lớp này ở DB, vì
// `finalize_ai_usage` không chỉ có một người gọi và cột đó không chỉ có một
// đường vào: hàm clamp, và một CHECK canh cả những đường chưa ai nghĩ tới.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DUONG_DAN = 'supabase/migrations/20260902123939_copilot_mock_off_finalize_clamp_v1.sql';
const sql = readFileSync(DUONG_DAN, 'utf8').replace(/\r\n/g, '\n');

/** Chữ ký PHẢI giữ nguyên — đổi là PostgREST sinh overload và chọn nhầm. */
const CHU_KY = 'public.finalize_ai_usage(uuid, int, int, int, int, numeric, int, text, text)';

describe('tắt provider mock', () => {
  it('UPDATE ai_providers về enabled = false', () => {
    expect(sql).toMatch(
      /UPDATE\s+public\.ai_providers\s+SET\s+enabled\s*=\s*false\s+WHERE\s+provider\s*=\s*'mock'/i,
    );
  });

  it('KHÔNG xoá dòng mock — chỉ tắt', () => {
    // Xoá dòng làm mọi `ai_usage_logs` cũ trỏ provider 'mock' mất chỗ tra cứu,
    // và migration sẽ không idempotent theo hướng có ích (bật lại tay rồi chạy
    // lại thì không còn gì để tắt).
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.ai_providers/i);
  });
});

describe('finalize_ai_usage clamp chi phí về >= 0', () => {
  it('ghi cost_usd bằng GREATEST(COALESCE(p_cost_usd, 0), 0)', () => {
    expect(sql).toMatch(/cost_usd\s*=\s*GREATEST\(\s*COALESCE\(\s*p_cost_usd\s*,\s*0\s*\)\s*,\s*0\s*\)/i);
  });

  it('KHÔNG còn đường ghi thẳng p_cost_usd', () => {
    expect(sql).not.toMatch(/cost_usd\s*=\s*p_cost_usd/i);
  });

  it('giữ NGUYÊN chữ ký cũ — không đẻ overload', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.finalize_ai_usage\s*\(/i);
    expect(sql).not.toMatch(/DROP\s+FUNCTION[^;]*finalize_ai_usage/i);
    for (const thamSo of [
      'p_id uuid',
      'p_prompt_tokens int',
      'p_completion_tokens int',
      'p_total_tokens int',
      'p_cached_tokens int',
      'p_cost_usd numeric',
      'p_latency_ms int',
      'p_status text',
      'p_error text',
    ]) {
      expect(sql, `chữ ký thiếu ${thamSo}`).toContain(thamSo);
    }
  });

  it('giữ SECURITY DEFINER kèm search_path cố định', () => {
    expect(sql).toMatch(/LANGUAGE\s+plpgsql\s+SECURITY\s+DEFINER/i);
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public/i);
  });

  it('lặp lại REVOKE anon/authenticated rồi GRANT service_role', () => {
    // CREATE OR REPLACE giữ ACL cũ, nhưng migration phải tự đứng được: chạy trên
    // DB dựng lại từ baseline thì ACL cũ không tồn tại (án lệ REVOKE ... FROM
    // PUBLIC không cắt anon trên Supabase).
    const revoke = new RegExp(
      `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${CHU_KY.replace(/[().]/g, '\\$&')}\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated;`,
      'i',
    );
    expect(sql).toMatch(revoke);
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.finalize_ai_usage\([^)]*\)\s+TO\s+service_role;/i);
  });
});

describe('CHECK chặn cost âm ở tầng bảng', () => {
  it('thêm ràng buộc NOT VALID trong DO-guard rồi VALIDATE riêng', () => {
    expect(sql).toMatch(/ai_usage_logs_cost_usd_khong_am/);
    expect(sql).toMatch(
      /CHECK\s*\(\s*cost_usd\s+IS\s+NULL\s+OR\s+cost_usd\s*>=\s*0\s*\)\s*NOT\s+VALID/i,
    );
    expect(sql).toMatch(/VALIDATE\s+CONSTRAINT\s+ai_usage_logs_cost_usd_khong_am/i);
  });

  it('chạy được HAI LẦN: cả ADD lẫn VALIDATE đều có guard catalog', () => {
    expect(sql).toMatch(
      /IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint[\s\S]{0,200}conname\s*=\s*'ai_usage_logs_cost_usd_khong_am'/i,
    );
    expect(sql).toMatch(/convalidated/i);
  });
});

describe('khối nghiệm thu chỉ soi catalog', () => {
  it('kiểm ràng buộc, quyền anon và trạng thái mock', () => {
    expect(sql).toMatch(/FROM\s+pg_constraint/i);
    expect(sql).toMatch(
      /has_function_privilege\(\s*'anon'\s*,\s*'public\.finalize_ai_usage\(uuid,\s*int,\s*int,\s*int,\s*int,\s*numeric,\s*int,\s*text,\s*text\)'\s*,\s*'EXECUTE'\s*\)/i,
    );
    expect(sql).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.ai_providers\s+WHERE\s+provider\s*=\s*'mock'\s+AND\s+enabled\s*\)/i);
  });

  it('KHÔNG chèn dòng thử vào ai_usage_logs — nghiệm thu phải chạy trên DB rỗng', () => {
    // Bảng này là sổ chi phí. Một phép thử sống để lại dòng rác trong đó làm
    // lệch chính con số mà hạn mức ngày đọc.
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.ai_usage_logs/i);
  });
});

describe('hình dạng migration', () => {
  it('đúng MỘT cặp BEGIN/COMMIT kèm lock_timeout', () => {
    const khongChuThich = sql.replace(/--[^\n]*/g, '');
    expect(khongChuThich.match(/^\s*BEGIN;/gm)?.length ?? 0).toBe(1);
    expect(khongChuThich.match(/^\s*COMMIT;/gm)?.length ?? 0).toBe(1);
    expect(sql).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'15s';/i);
  });

  it('mở đầu bằng lý do, không phải chỉ tên bảng', () => {
    expect(sql.slice(0, 2000)).toMatch(/x-mock-cost|hạn mức|quota/i);
  });
});
