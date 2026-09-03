// Hạn mức Copilot phải đo bằng thứ CÓ THẬT trên hoá đơn: token.
//
// LỖ ĐANG VÁ
//   `ai_copilot_settings` có ba cap USD (`daily_usd_cap_user/_tenant/_global`),
//   nhưng cả hai provider đang bật đều báo giá 0: OpenRouter chạy model đuôi
//   `:free` (`pricing_mode = 'free'`), 9Router là `self_hosted` với
//   input_price/output_price ép về 0 (`20260829080000`). Nhân bao nhiêu token
//   với 0 cũng ra 0, nên `v_sum + v_est >= cap` KHÔNG BAO GIỜ đúng — ba cap USD
//   là ba hàng rào bằng giấy. Rào duy nhất còn thật là `rate_per_min`, mà nó chỉ
//   đo SỐ LƯỢT trong 60 giây: 20 lượt/phút × mỗi lượt 100k token vẫn lọt sạch.
//
//   Token thì luôn có thật, kể cả khi giá bằng 0. Nên cap mới đo token/ngày.
//
// VÌ SAO CREATE OR REPLACE Ở ĐÂY LÀ ĐÚNG (khác `20260902132418`)
//   Migration đó THÊM một tham số → chữ ký khác → `CREATE OR REPLACE` sẽ đẻ
//   overload, nên nó phải DROP trước. Ở đây chữ ký GIỮ NGUYÊN 7 tham số, không
//   có overload nào sinh ra, và `CREATE OR REPLACE` còn giữ nguyên ACL (không
//   có cửa sổ nào mà hàm tồn tại nhưng service_role chưa được GRANT lại).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DUONG_DAN = 'supabase/migrations/20260903034632_copilot_daily_token_cap_v1.sql';
const sql = readFileSync(DUONG_DAN, 'utf8').replace(/\r\n/g, '\n');

const CHU_KY = 'public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)';
const CHU_KY_6 = 'public.reserve_ai_usage(uuid, text, text, text, text, numeric)';
const esc = (s: string) => s.replace(/[().]/g, '\\$&');
const SLUG_CHET = 'qwen/qwen3-next-80b-a3b-instruct:free';

describe('hai cột cap token — thêm được trên bảng đã có dữ liệu', () => {
  it('ADD COLUMN IF NOT EXISTS cho cả hai cột', () => {
    // IF NOT EXISTS là điều kiện để migration chạy được lượt hai (gate
    // check-forward-migration-idempotent dán thân file hai lần trong một
    // transaction rồi ROLLBACK).
    for (const cot of ['daily_tokens_cap_user', 'daily_tokens_cap_tenant']) {
      expect(sql, `thiếu ADD COLUMN IF NOT EXISTS ${cot}`).toMatch(
        new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${cot}\\s+int`, 'i'),
      );
    }
  });

  it('cột NOT NULL kèm DEFAULT — dòng singleton đã tồn tại phải có giá trị ngay', () => {
    expect(sql).toMatch(/daily_tokens_cap_user\s+int\s+NOT\s+NULL\s+DEFAULT\s+300000/i);
    expect(sql).toMatch(/daily_tokens_cap_tenant\s+int\s+NOT\s+NULL\s+DEFAULT\s+1500000/i);
  });

  it('ghi rõ 0 = TẮT hạn mức', () => {
    // Cùng quy ước với ba cap USD (`cap > 0` mới so sánh). Không ghi ra thì
    // người sửa cấu hình sẽ đọc 0 là "cấm tuyệt đối".
    expect(sql).toMatch(/0\s*=\s*t(ắ|a)t/i);
  });
});

describe('reserve_ai_usage: cùng chữ ký, chỉ THÊM cửa token', () => {
  it('CREATE OR REPLACE, KHÔNG DROP — chữ ký không đổi thì không được đổi ACL', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.reserve_ai_usage/i);
    expect(sql).not.toMatch(/DROP\s+FUNCTION[^\n]*reserve_ai_usage/i);
  });

  it('vẫn đúng 7 tham số theo đúng thứ tự cũ, org vẫn DEFAULT NULL', () => {
    // Rơi mất `DEFAULT NULL` là biến nhánh `organization_required` ở tầng RPC
    // thành mã chết (PostgREST chặn ngay khâu phân giải hàm) — xem 20260902132418.
    expect(sql).toMatch(
      /p_user_id\s+uuid\s*,[\s\S]*?p_feature\s+text\s*,[\s\S]*?p_provider\s+text\s*,[\s\S]*?p_model\s+text\s*,[\s\S]*?p_task_id\s+text\s*,[\s\S]*?p_est_cost_usd\s+numeric\s*,[\s\S]*?p_organization_id\s+uuid\s+DEFAULT\s+NULL\s*\n?\s*\)/i,
    );
    // Và KHÔNG được đẻ ra bản 6 tham số nào.
    expect(sql).not.toMatch(new RegExp(`CREATE[^\\n]*${esc(CHU_KY_6)}`, 'i'));
  });

  it('giữ SECURITY DEFINER + search_path cố định', () => {
    expect(sql).toMatch(/LANGUAGE\s+plpgsql\s+SECURITY\s+DEFINER/i);
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public,\s*auth/i);
  });

  it('không đánh rơi gate nào của bản trước', () => {
    // Thân hàm được CHÉP lại, nên mọi thứ bản trước canh phải còn nguyên: một
    // dòng rơi ở đây là mở lại đúng lỗ mà migration cũ vừa vá.
    for (const chuoi of [
      'organization_required',
      'organization_forbidden',
      'sandbox_org_ids()',
      'organization_memberships',
      'super_admins',
      'pg_advisory_xact_lock',
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

  it('INSERT vẫn nêu organization_id tường minh', () => {
    const insert = sql.match(/INSERT\s+INTO\s+public\.ai_usage_logs[\s\S]*?RETURNING/i)?.[0] ?? '';
    expect(insert).toMatch(/organization_id/i);
    expect(insert).toMatch(/p_organization_id/i);
  });
});

describe('cửa token: hai cấp, cùng cách tính ngày với cap USD', () => {
  it('RAISE daily_token_quota — mã RIÊNG, không gộp vào daily_quota', () => {
    // Gộp thì người dùng đọc "hết hạn mức USD" trong khi tiền tiêu là 0 đồng, và
    // quản trị không biết phải nới cột nào.
    expect(sql).toMatch(/RAISE\s+EXCEPTION\s+'daily_token_quota'/i);
    expect((sql.match(/RAISE\s+EXCEPTION\s+'daily_token_quota'/gi) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('cộng sum(total_tokens) chứ không cộng chi phí', () => {
    expect(sql).toMatch(/sum\(\s*total_tokens\s*\)/i);
  });

  it('cấp USER đo theo user_id, cấp TENANT đo theo owner_id', () => {
    const than = sql.match(/AS\s+\$fn\$[\s\S]*?\$fn\$/i)?.[0] ?? '';
    expect(than).toMatch(/daily_tokens_cap_user/);
    expect(than).toMatch(/daily_tokens_cap_tenant/);
    const khoiToken = than.match(/-- \(G1-F\)[\s\S]*?(?=-- h\.|INSERT\s+INTO\s+public\.ai_usage_logs)/i)?.[0] ?? '';
    expect(khoiToken, 'khối token phải lọc theo user_id').toMatch(/user_id\s*=\s*p_user_id/);
    expect(khoiToken, 'khối token phải lọc theo owner_id').toMatch(/owner_id\s*=\s*v_owner/);
  });

  it('cùng biên ngày Asia/Ho_Chi_Minh như cap USD', () => {
    // Hai biên ngày khác nhau trong cùng một hàm là hai sự thật về "hôm nay".
    const soLanBienNgay = (sql.match(/created_at\s+AT\s+TIME\s+ZONE\s+'Asia\/Ho_Chi_Minh'\)::date\s*=\s*v_day/gi) ?? []).length;
    expect(soLanBienNgay).toBeGreaterThanOrEqual(5); // 3 cap USD + 2 cap token
    expect(sql).not.toMatch(/AT\s+TIME\s+ZONE\s+'(?!Asia\/Ho_Chi_Minh')/i);
  });

  it('cap = 0 nghĩa là TẮT, không phải chặn sạch', () => {
    expect(sql).toMatch(/daily_tokens_cap_user\s*>\s*0/i);
    expect(sql).toMatch(/daily_tokens_cap_tenant\s*>\s*0/i);
  });

  it('cửa token đứng TRƯỚC INSERT — không để lại dòng pending rác', () => {
    const iToken = sql.search(/RAISE\s+EXCEPTION\s+'daily_token_quota'/i);
    const iInsert = sql.search(/INSERT\s+INTO\s+public\.ai_usage_logs/i);
    expect(iToken).toBeGreaterThanOrEqual(0);
    expect(iInsert).toBeGreaterThan(iToken);
  });

  it('cửa token đứng SAU khi v_owner đã được suy ra', () => {
    // Đo cấp tenant bằng `v_owner` khi biến còn NULL là đo nhầm cả hệ thống.
    const iOwner = sql.search(/IF\s+v_owner\s+IS\s+NULL\s+THEN\s+v_owner\s*:=\s*p_user_id/i);
    const iToken = sql.search(/RAISE\s+EXCEPTION\s+'daily_token_quota'/i);
    expect(iOwner).toBeGreaterThanOrEqual(0);
    expect(iToken).toBeGreaterThan(iOwner);
  });
});

describe('gỡ slug OpenRouter đã chết', () => {
  it('lọc theo id model, không so cả phần tử jsonb', () => {
    // So nguyên phần tử (`models - '{...}'::jsonb`) là buộc vào ĐÚNG hình dạng
    // hôm nay; `20260829080000` vừa nhét thêm khoá `pricing_mode` vào từng phần
    // tử, và lần sau thêm khoá nữa thì phép trừ đó lặng lẽ không khớp gì cả.
    expect(sql).toContain(SLUG_CHET);
    expect(sql).toMatch(/model->>'id'/i);
    expect(sql).toMatch(/jsonb_array_elements\s*\(\s*(public\.ai_providers\.)?models\s*\)/i);
    expect(sql).toMatch(/UPDATE\s+public\.ai_providers/i);
    expect(sql).toMatch(/provider\s*=\s*'openrouter'/i);
  });

  it('giữ pricing_mode của các model còn lại — trigger validate phải qua', () => {
    // `validate_ai_provider_pricing_v1` (`20260829080000`) RAISE nếu một model
    // thiếu `pricing_mode`. Dựng lại mảng bằng jsonb_agg các phần tử NGUYÊN VẸN
    // là cách duy nhất chắc chắn không đánh rơi khoá nào.
    expect(sql).toMatch(/jsonb_agg\s*\(/i);
    expect(sql).not.toMatch(/jsonb_set[\s\S]{0,80}pricing_mode/i);
  });

  it('idempotent: lượt hai không đụng gì', () => {
    // Không có mệnh đề này thì lượt hai vẫn UPDATE (ghi lại y nguyên) và vẫn
    // đánh thức trigger — vô hại nhưng che mất tín hiệu "đã xong".
    expect(sql).toMatch(/EXISTS\s*\([\s\S]{0,200}qwen\/qwen3-next-80b-a3b-instruct:free/i);
  });

  it('default_model không được trỏ vào slug vừa gỡ', () => {
    // Trigger RAISE 'default_model must match a model id'. Sản xuất đang để
    // nemotron (đã tra 03/09/2026), nhưng migration phải tự đứng vững trên một
    // database ai đó vừa đổi default_model bằng tay.
    expect(sql).toMatch(/default_model/i);
    expect(sql).toContain('nvidia/nemotron-3-super-120b-a12b:free');
  });
});

describe('quyền: chữ ký cũ, ACL vẫn phải nói lại tường minh', () => {
  it('REVOKE PUBLIC/anon/authenticated rồi GRANT service_role', () => {
    // Án lệ: REVOKE ... FROM PUBLIC KHÔNG cắt `anon` trên Supabase — phải gọi
    // tên từng vai. CREATE OR REPLACE giữ ACL cũ, nhưng nói lại là cách duy nhất
    // để file này tự đứng vững khi replay lên database dựng từ baseline.
    expect(sql).toMatch(
      new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${esc(CHU_KY)}\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated;`, 'i'),
    );
    expect(sql).toMatch(
      new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${esc(CHU_KY)}\\s+TO\\s+service_role;`, 'i'),
    );
  });
});

describe('khối nghiệm thu chỉ soi catalog', () => {
  it('chữ ký 7 tham số còn đó và KHÔNG mọc thêm bản 6 tham số', () => {
    expect(sql).toMatch(
      /to_regprocedure\(\s*'public\.reserve_ai_usage\(uuid,\s*text,\s*text,\s*text,\s*text,\s*numeric,\s*uuid\)'\s*\)\s+IS\s+NULL/i,
    );
    expect(sql).toMatch(
      /to_regprocedure\(\s*'public\.reserve_ai_usage\(uuid,\s*text,\s*text,\s*text,\s*text,\s*numeric\)'\s*\)\s+IS\s+NOT\s+NULL/i,
    );
  });

  it('soi hai cột mới bằng information_schema, không bằng dữ liệu', () => {
    expect(sql).toMatch(/information_schema\.columns/i);
  });

  it('ACL vẫn được nghiệm thu', () => {
    expect(sql).toMatch(/has_function_privilege\(\s*'anon'\s*,/i);
    expect(sql).toMatch(/has_function_privilege\(\s*'authenticated'\s*,/i);
    expect(sql).toMatch(/has_function_privilege\(\s*'service_role'\s*,/i);
  });

  it('KHÔNG gọi thử hàm, KHÔNG chèn dòng vào sổ chi phí', () => {
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

  it('mở đầu bằng lý do — vì sao cap USD là hàng rào bằng giấy', () => {
    expect(sql.slice(0, 2500)).toMatch(/free|self_hosted|gi(á|a)\s*0|token/i);
  });
});
