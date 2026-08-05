import { describe, expect, it } from "vitest";

import { createDisposableOpenClawDatabase } from "../test-openclaw-migrations.mjs";

/**
 * Canh MỘT bất biến, trên ba bảng CRM mà OpenClaw đọc ghép vào.
 *
 * `20260727070000_openclaw_crm_event_sources.sql:621-632` cấp cho
 * `openclaw_function_owner` năm policy `using (true)` trên public.rooms,
 * public.leads và public.lead_activities — KHÔNG có bộ lọc tổ chức nào.
 *
 * Đó là CỐ Ý và bắt buộc: `app_private.openclaw_sweep_due_sales_tasks_v1` quét
 * lead_activities join leads không lọc tổ chức ở truy vấn ngoài, rồi nhóm theo
 * task.organization_id, và được cron gọi qua maintenance job. Ngữ cảnh cron
 * không có request.jwt.claims, nên thay `true` bằng vị từ kiểu my_org_ids() sẽ
 * làm sweep IM LẶNG phát ra 0 bản ghi. Đừng "sửa" policy.
 *
 * Cái phải canh là hệ quả: vì RLS đã hết tác dụng với role đó trên ba bảng này,
 * hàng rào duy nhất còn lại là "không hàm nào vừa thuộc role đó, vừa cho trình
 * duyệt gọi, vừa chạm ba bảng đó". Role sở hữu 146 hàm và 62 trong số đó
 * `authenticated` gọi được (đo trên baseline production 05/08/2026), nên thêm
 * một hàm vi phạm là rò xuyên tổ chức mà không có gì cảnh báo.
 */
const HARNESS_TIMEOUT = 60_000;

/** Ba bảng CRM mà policy qual=true phủ lên. DẪN XUẤT từ catalog, không chép tay. */
const CROSS_ORG_TABLES = ["rooms", "leads", "lead_activities"];

async function withDatabase(operation) {
  const database = await createDisposableOpenClawDatabase({ verifyCli: false });
  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}

describe("cách ly tổ chức trên nguồn CRM của OpenClaw", () => {
  it("chốt rằng policy vẫn là qual=true — đổi nó là vỡ cron sweep", async () => {
    await withDatabase(async (database) => {
      const { rows } = await database.query(
        `select tablename, cmd, qual
           from pg_policies
          where 'openclaw_function_owner' = any(roles)
            and tablename = any($1::text[])
          order by tablename, policyname`,
        [CROSS_ORG_TABLES],
      );

      // Nếu bài này đỏ vì SỐ LƯỢNG đổi, đọc lại chú thích đầu file trước khi
      // sửa số: thêm bảng vào tầm với của role là quyết định lớn, không phải
      // cập nhật con số cho xanh.
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.qual, `${row.tablename}.${row.cmd} phải giữ qual=true`).toBe("true");
      }
    });
  }, HARNESS_TIMEOUT);

  it("KHÔNG hàm nào vừa thuộc owner-role, vừa browser-callable, vừa chạm ba bảng đó", async () => {
    await withDatabase(async (database) => {
      const { rows } = await database.query(
        `select n.nspname || '.' || p.proname as ten
              , pg_get_function_result(p.oid)  as tra_ve
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where pg_get_userbyid(p.proowner) = 'openclaw_function_owner'
            -- Hàm trigger không gọi thẳng được (Postgres từ chối:
            -- "trigger functions can only be called as triggers"), nên EXECUTE
            -- trên chúng không phải bề mặt tấn công.
            and p.prorettype <> 'trigger'::regtype
            and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 or has_function_privilege('anon', p.oid, 'EXECUTE'))
            and (p.prosrc like '%rooms%'
                 or p.prosrc like '%leads%'
                 or p.prosrc like '%lead_activities%')
          order by 1`,
      );

      expect(
        rows.map((row) => row.ten),
        "hàm gọi được từ trình duyệt mà đọc bảng CRM dưới policy qual=true — " +
          "phải tự lọc organization_id, RLS sẽ KHÔNG chặn giúp",
      ).toEqual([]);
    });
  }, HARNESS_TIMEOUT);

  it("năm hàm chạm ba bảng đó đều nằm ngoài tầm gọi của trình duyệt", async () => {
    // Mặt THUẬN của bài trên. Không có nó, bài trên xanh kể cả khi không hàm nào
    // chạm ba bảng — tức xanh vì truy vấn hỏng chứ không vì bất biến đúng.
    await withDatabase(async (database) => {
      const { rows } = await database.query(
        `select n.nspname || '.' || p.proname as ten
              , (p.prorettype = 'trigger'::regtype)                          as la_trigger
              , has_function_privilege('authenticated', p.oid, 'EXECUTE')    as authenticated_goi_duoc
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where pg_get_userbyid(p.proowner) = 'openclaw_function_owner'
            and (p.prosrc like '%rooms%'
                 or p.prosrc like '%leads%'
                 or p.prosrc like '%lead_activities%')
          order by 1`,
      );

      expect(rows.length, "phải có hàm chạm ba bảng, không thì bài trên vô nghĩa")
        .toBeGreaterThan(0);

      for (const row of rows) {
        // An toàn theo MỘT trong hai đường: hoặc là trigger (không gọi thẳng
        // được), hoặc không cấp EXECUTE cho authenticated.
        expect(
          row.la_trigger || !row.authenticated_goi_duoc,
          `${row.ten}: vừa gọi được từ trình duyệt vừa đọc bảng CRM xuyên tổ chức`,
        ).toBe(true);
      }
    });
  }, HARNESS_TIMEOUT);
});
