import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createDisposableOpenClawDatabase } from "../test-openclaw-migrations.mjs";

/**
 * Checks the privileges the BROWSER-FACING definer functions depend on, as the
 * roles that actually hold them.
 *
 * The rest of the SQL suite runs PGlite as superuser, which bypasses every GRANT.
 * That is how five shipped RPCs - openclaw_takeover_conversation_v1,
 * openclaw_release_takeover_v1, openclaw_assign_conversation_v1 and two more -
 * came to SELECT public.organization_memberships while running as
 * `openclaw_function_owner`, a NOLOGIN NOINHERIT NOBYPASSRLS role with no privilege
 * on that table. Every one of them would have raised 42501 on its first real call,
 * and 115 green SQL tests said nothing.
 */
const HARNESS_TIMEOUT = 45_000;

async function withDatabase(operation) {
  const database = await createDisposableOpenClawDatabase({ verifyCli: false });
  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}

/** Runs `sql` as `role`, returning the error message instead of throwing. */
async function attemptAs(database, role, sql) {
  await database.query("begin");
  try {
    await database.query(`set local role ${role}`);
    await database.query(sql);
    return null;
  } catch (error) {
    // Always a string: PGlite does not guarantee `message` is one for every error
    // class, and `.toMatch()` on an object fails with a TypeError that hides which
    // statement was actually refused.
    return String(error?.message ?? error);
  } finally {
    await database.query("rollback");
  }
}

describe("browser RPC privileges under the owning role", () => {
  it("lets the function owner read the memberships its own RPCs join to", async () => {
    await withDatabase(async (database) => {
      expect(
        await attemptAs(
          database,
          "openclaw_function_owner",
          "select 1 from public.organization_memberships limit 1",
        ),
      ).toBeNull();
    });
  }, HARNESS_TIMEOUT);

  it("grants exactly the membership columns the definer bodies actually read", async () => {
    // DERIVED, not restated. The first version of this test listed the four columns
    // the grant happened to contain, so it certified the grant against itself - and
    // stayed green while `member_type` was missing and two shipped legal-hold RPCs
    // raised 42501 for every caller. Column privileges are checked per referenced
    // column and the error names only the table, so nothing points at the culprit.
    const source = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260727060000_openclaw_rpc_surface.sql"),
      "utf8",
    );
    const referenced = new Set(
      [...source.matchAll(/membership[.]([a-z_]+)/gu)].map((match) => match[1]),
    );
    expect(
      referenced.size,
      `no membership column references found; read ${source.length} chars`,
    ).toBeGreaterThan(0);

    await withDatabase(async (database) => {
      for (const column of [...referenced].sort()) {
        expect(
          await attemptAs(
            database,
            "openclaw_function_owner",
            `select ${column} from public.organization_memberships limit 1`,
          ),
          `${column} is read by a definer body but not granted`,
        ).toBeNull();
      }
    });

    // That the grant is a COLUMN LIST cannot be proven at runtime here: the
    // harness's organization_memberships is a five-column stub
    // (scripts/test-openclaw-migrations.mjs) whose columns are exactly the granted
    // set, so `select *` succeeds against it while failing against the real table.
    // Asserted on the statement instead, with the reason stated rather than a
    // runtime check that would quietly mean nothing.
    const grant = source.slice(
      source.indexOf("grant select"),
      source.indexOf("on public.organization_memberships to openclaw_function_owner"),
    );
    expect(grant, "the membership grant must stay a column list").toContain("(");
    for (const column of referenced) {
      expect(grant, `${column} missing from the grant statement`).toContain(column);
    }
  }, HARNESS_TIMEOUT);

  it("grants exactly the organization columns the definer bodies actually read", async () => {
    // Cùng một lỗi với bài trên, khác bảng, bắt được 05/08/2026 — nhưng KHÔNG
    // phải bằng bộ SQL này. Phải gọi RPC thật dưới role `authenticated` trên
    // baseline production mới lòi ra: openclaw_list_my_organizations_v1() là RPC
    // đầu tiên trang gọi, và nó chết `permission denied for table organizations`
    // vì role sở hữu không có quyền nào trên bảng đó — không table, không column.
    //
    // DẪN XUẤT từ thân hàm, không chép tay: một danh sách chép tay sẽ tự chứng
    // nhận chính nó và xanh y như lần `member_type` bị thiếu.
    const source = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260727060000_openclaw_rpc_surface.sql"),
      "utf8",
    );
    const referenced = new Set(
      [...source.matchAll(/\borganization[.]([a-z_]+)/gu)].map((match) => match[1]),
    );
    expect(
      referenced.size,
      `không tìm thấy tham chiếu cột organization nào; đã đọc ${source.length} ký tự`,
    ).toBeGreaterThan(0);

    await withDatabase(async (database) => {
      for (const column of [...referenced].sort()) {
        expect(
          await attemptAs(
            database,
            "openclaw_function_owner",
            `select ${column} from public.organizations limit 1`,
          ),
          `${column} được thân hàm definer đọc nhưng chưa cấp`,
        ).toBeNull();
      }
    });

    // Cùng lý do như bài membership: bảng organizations trong harness là stub,
    // nên "grant này là COLUMN LIST" không chứng minh được lúc chạy. Khẳng định
    // trên câu lệnh, và nói rõ vì sao, thay vì một phép kiểm runtime vô nghĩa.
    const marker = "on public.organizations to openclaw_function_owner";
    const grant = source.slice(source.lastIndexOf("grant select", source.indexOf(marker)), source.indexOf(marker));
    expect(grant, "grant trên organizations phải giữ dạng danh sách cột").toContain("(");
    for (const column of referenced) {
      expect(grant, `${column} thiếu trong câu grant`).toContain(column);
    }
  }, HARNESS_TIMEOUT);

  it("mở RLS cho role sở hữu trên cả hai bảng tổ chức, phạm vi theo người gọi", async () => {
    // GRANT KHÔNG ĐỦ, và đây là nửa nguy hiểm hơn: thiếu policy thì mọi SELECT
    // trả RỖNG chứ không lỗi. Đo trên production 05/08/2026, `set local role`:
    // organizations 3 dòng thật -> role thấy 0; memberships 15 -> 0. Tức bản vá
    // GRANT cho memberships ở migration này CHƯA TỪNG chạy được trên thật, dù
    // có test riêng và test đó xanh (harness dùng bảng stub không policy).
    //
    // Vị từ phải theo NGƯỜI GỌI, không phải `using (true)`: cả 8 đường đọc hai
    // bảng này đều là RPC trình duyệt, không đường nào chạy dưới cron.
    await withDatabase(async (database) => {
      const { rows } = await database.query(
        `select tablename, policyname, qual
           from pg_policies
          where 'openclaw_function_owner' = any(roles)
            and tablename in ('organizations', 'organization_memberships')
          order by tablename`,
      );

      expect(
        rows.map((row) => row.tablename),
        "thiếu policy là role đọc ra rỗng trên production, im lặng",
      ).toEqual(["organization_memberships", "organizations"]);

      for (const row of rows) {
        // `using (true)` ở đây sẽ mở dữ liệu thành viên xuyên tổ chức — chốt
        // rằng vị từ vẫn ràng vào my_org_ids() của người gọi.
        expect(row.qual, `${row.tablename}: vị từ phải ràng theo người gọi`).toContain(
          "my_org_ids",
        );
        expect(row.qual, `${row.tablename}: không được là using(true)`).not.toBe("true");
      }
    });
  }, HARNESS_TIMEOUT);

  it("still keeps that table away from the browser roles", async () => {
    await withDatabase(async (database) => {
      // The grant exists for SECURITY DEFINER bodies, not for callers. A member must
      // not be able to enumerate an organization's roster directly.
      for (const role of ["anon", "authenticated"]) {
        expect(
          await attemptAs(
            database,
            role,
            "select 1 from public.organization_memberships limit 1",
          ),
          role,
        ).toMatch(/permission denied/iu);
      }
    });
  }, HARNESS_TIMEOUT);

  it("grants the function owner nothing beyond reading memberships", async () => {
    await withDatabase(async (database) => {
      // SELECT only: a definer body that could write the roster would be a privilege
      // escalation path out of every OpenClaw RPC.
      for (const statement of [
        "insert into public.organization_memberships(id) values (gen_random_uuid())",
        "update public.organization_memberships set status = status",
        "delete from public.organization_memberships",
      ]) {
        expect(
          await attemptAs(database, "openclaw_function_owner", statement),
          statement,
        ).toMatch(/permission denied/iu);
      }
    });
  }, HARNESS_TIMEOUT);

  it("exposes the takeover reader to authenticated and to nobody else", async () => {
    await withDatabase(async (database) => {
      const denied = await attemptAs(
        database,
        "anon",
        "select public.openclaw_list_takeovers_v1('{}'::jsonb)",
      );
      expect(denied).toMatch(/permission denied/iu);

      // `authenticated` may CALL it; without a JWT the body refuses on its own terms
      // (authentication required), which is a different failure from a missing grant
      // and is what proves the grant landed.
      const called = await attemptAs(
        database,
        "authenticated",
        "select public.openclaw_list_takeovers_v1('{}'::jsonb)",
      );
      expect(called).not.toMatch(/permission denied for function/iu);
    });
  }, HARNESS_TIMEOUT);
});
