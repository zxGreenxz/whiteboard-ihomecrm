import { test, expect } from '@playwright/test';
import { trackConsoleErrors } from './auth';

/**
 * SỰ KIỆN CHIA NHIỀU LƯỢT — mỗi lượt vài suất, đua xong lượt này mới sang lượt
 * sau (đêm tổng kết: 100K×3 → 200K×2 → 500K×1).
 *
 * Bốn điều bài này canh, đều là chỗ dễ vỡ khi lên nhiều lượt:
 *
 *  0. CHỐT LƯỢT LÀ QUYỀN QUẢN TRỊ: gọi bằng khoá `anon` (đúng thứ trình duyệt
 *     người lạ có) phải BỊ TỪ CHỐI. Đây là hàng rào thật; việc giao diện công
 *     khai không có nút chỉ là phép lịch sự, RPC gọi thẳng được.
 *
 *  1. KHÔNG NHẢY CÓC: `lucky_draw_round_v1` phải từ chối khi lượt trước chưa
 *     xong, và phải IDEMPOTENT khi gọi lại đúng lượt đã chốt. Không có hai tính
 *     chất này thì hai máy cùng bấm sẽ cháy một lượt chưa ai kịp xem.
 *
 *  2. KHÔNG LỘ ĐÁP ÁN: server trả kết quả cả lượt ngay lúc chốt, nên nếu giao
 *     diện đọc thẳng ra thì tên vé trúng hiện trước khi con thú kịp chạy.
 *
 *  3. MỘT VÉ TRÚNG NHIỀU LẦN ĐƯỢC: mỗi lượt bốc lại từ toàn bộ vé đã điểm danh.
 *     Đây là thể lệ, không phải lỗi.
 *
 *  4. CỘNG SỔ THEO SALE: một sale ôm nhiều vé thì gộp thành một dòng, và tổng
 *     phải khớp đúng tiền đã khai.
 *
 * Cần env: SUPABASE_PAT (lấy từ CLAUDE.local.md).
 */

const PROJECT_REF = 'tryymsxyyckgbrmmvozx';
const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const TAG = 'E2E-NHIEULUOT';

function pat(): string {
  const v = process.env.SUPABASE_PAT;
  if (!v) throw new Error('Thiếu env SUPABASE_PAT (lấy từ CLAUDE.local.md).');
  return v;
}

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Management API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

/**
 * Gọi RPC VỚI TƯ CÁCH QUẢN TRỊ — mô phỏng đúng việc chủ giải bấm ở
 * `/quayso/admin`.
 *
 * Từ 23/08/2026 `lucky_draw_round_v1` đòi quyền quản trị, nên gọi trần qua
 * Management API không còn ăn: role ở đó không có `auth.uid()` nên
 * `lucky_is_event_admin_v1` trả false và hàm đáp `forbidden`. Muốn giả lập một
 * quản trị thật thì phải nạp claim JWT của một thành viên ACTIVE trong org, y
 * như PostgREST làm khi người ta đăng nhập.
 */
async function rpcAdmin(fn: string, args: Record<string, unknown>) {
  const doiSo = Object.values(args)
    .map((v) => (typeof v === 'number' ? String(v) : `'${String(v)}'`))
    .join(',');
  const [{ out }] = await sql<{ out: unknown }>(`
    select set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', (select user_id from public.organization_memberships
                 where organization_id = '${DEMO_ORG}' and status = 'ACTIVE'
                   and member_type in ('OWNER','STAFF') limit 1),
        'role', 'authenticated')::text,
      false);
    select public.${fn}(${doiSo}) as out;`);
  return out as { ok: boolean; reason?: string };
}

/**
 * Gọi RPC bằng ĐÚNG khoá `anon` mà trình duyệt người lạ cầm — không phải qua
 * Management API (service role bỏ qua mọi GRANT, nên không kiểm được quyền).
 */
async function rpcAnon(fn: string, body: Record<string, unknown>) {
  const url = process.env.SUPABASE_URL ?? 'https://tryymsxyyckgbrmmvozx.supabase.co';
  const key = process.env.SUPABASE_ANON_KEY;
  if (!key) throw new Error('Thiếu env SUPABASE_ANON_KEY (lấy từ .env: VITE_SUPABASE_PUBLISHABLE_KEY).');
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Profile': 'public',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  return { http: r.status, body: await r.text() };
}

const created: string[] = [];
test.afterAll(async () => {
  if (!created.length) return;
  await sql(`delete from public.lucky_events where id in (${created.map((i) => `'${i}'`).join(',')});`);
});

/** 9 vé (2 vé cùng sale 1392QT) + thể lệ 3 lượt như đêm tổng kết. */
async function seed(): Promise<{ eventId: string; slug: string }> {
  const uniq = `${TAG}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const slug = `e2e-nl-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 32);
  const ve = [
    ['HK 302', '1392QT'], ['HK 405', '1392QT'], ['FAMSTAY 102', '32PVC'],
    ['HP HOME 102', '80DS3'], ['STAR L04', '1392'], ['FPHOUSE 201', '1392'],
    ['RINNING 201', '331PHI'], ['CLOUD L06', '1392QT'], ['LIKESROOM 302', '158PVC'],
  ];
  const [{ event_id }] = await sql<{ event_id: string }>(`
    insert into public.lucky_events
      (organization_id, title, prize_label, prize_amount, draw_at, game, race_seconds, slug, created_by)
    values ('${DEMO_ORG}', '${uniq}', 'Giải may mắn', 500000, null, 'race', 8, '${slug}',
            (select user_id from public.organization_memberships
              where organization_id = '${DEMO_ORG}' and status = 'ACTIVE' limit 1))
    returning id as event_id;`);
  created.push(event_id);

  await sql(`insert into public.lucky_event_teams (event_id, name, sale, deals, checked_in_at) values
    ${ve.map(([n, s]) => `('${event_id}','${n}','${s}',1,now())`).join(',')};`);
  await sql(`insert into public.lucky_event_rounds (event_id, ordinal, label, amount, winners_count) values
    ('${event_id}',1,'',100000,3), ('${event_id}',2,'',200000,2), ('${event_id}',3,'',500000,1);`);

  return { eventId: event_id, slug };
}

test.describe('Sự kiện nhiều lượt trên /quayso', () => {
  test('HÀNG RÀO: người lạ cầm link KHÔNG mở được lượt', async () => {
    const s = await seed();

    // Đúng thứ trình duyệt người lạ có: khoá anon công khai.
    const r = await rpcAnon('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 1 });
    expect(
      r.http === 401 || r.http === 403 || /forbidden|permission denied/i.test(r.body),
      `anon vẫn mở được lượt! http=${r.http} body=${r.body.slice(0, 200)}`,
    ).toBe(true);

    // Và không được đốt mất lượt nào.
    const [{ conCho }] = await sql<{ conCho: number }>(`
      select count(*)::int as "conCho" from public.lucky_event_rounds
      where event_id = '${s.eventId}' and status = 'pending';`);
    expect(conCho, 'người lạ bấm xong mà lượt bị chốt mất').toBe(3);
  });

  test('HÀNG RÀO: quay tay sự kiện MỘT GIẢI cũng đòi quản trị', async () => {
    const uniq = `${TAG}-TAY-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [{ event_id }] = await sql<{ event_id: string }>(`
      insert into public.lucky_events
        (organization_id, title, prize_label, prize_amount, draw_at, game, created_by)
      values ('${DEMO_ORG}', '${uniq}', 'Giải may mắn', 100000, null, 'wheel',
              (select user_id from public.organization_memberships
                where organization_id = '${DEMO_ORG}' and status = 'ACTIVE' limit 1))
      returning id as event_id;`);
    created.push(event_id);
    await sql(`insert into public.lucky_event_teams (event_id, name, deals, checked_in_at)
               values ('${event_id}', 'VE A', 1, now());`);

    // draw_at NULL = quay tay ⇒ anon phải bị từ chối.
    const r = await rpcAnon('lucky_draw_v1', { p_event: event_id });
    expect(/forbidden/i.test(r.body) || r.http === 401 || r.http === 403,
      `anon quay tay được! http=${r.http} body=${r.body.slice(0, 200)}`).toBe(true);

    const [{ st }] = await sql<{ st: string }>(
      `select status as st from public.lucky_events where id = '${event_id}';`);
    expect(st, 'sự kiện bị người lạ chốt mất').toBe('open');
  });

  test('KHÔNG chặn nhầm: hẹn giờ + đã tới giờ thì trang công khai VẪN tự quay được', async () => {
    // Đây là cơ chế "quay tự động đúng giờ" mà trang điểm danh dựa vào. Siết
    // quyền mà chặn luôn đường này là giết một tính năng đang chạy.
    const uniq = `${TAG}-GIO-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [{ event_id }] = await sql<{ event_id: string }>(`
      insert into public.lucky_events
        (organization_id, title, prize_label, prize_amount, draw_at, game, created_by)
      values ('${DEMO_ORG}', '${uniq}', 'Giải may mắn', 100000,
              now() - interval '60 seconds', 'wheel',
              (select user_id from public.organization_memberships
                where organization_id = '${DEMO_ORG}' and status = 'ACTIVE' limit 1))
      returning id as event_id;`);
    created.push(event_id);
    await sql(`insert into public.lucky_event_teams (event_id, name, deals, checked_in_at)
               values ('${event_id}', 'VE A', 1, now());`);

    const r = await rpcAnon('lucky_draw_v1', { p_event: event_id });
    expect(r.http, `hẹn giờ mà anon vẫn bị chặn: ${r.body.slice(0, 200)}`).toBe(200);
    expect(r.body).toContain('"ok": true');

    const [{ st }] = await sql<{ st: string }>(
      `select status as st from public.lucky_events where id = '${event_id}';`);
    expect(st).toBe('drawn');
  });

  test('server: không cho nhảy cóc lượt, và gọi lại đúng lượt là idempotent', async () => {
    const s = await seed();

    // Nhảy thẳng lượt 2 khi lượt 1 chưa quay → phải từ chối.
    const nhayCoc = await rpcAdmin('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 2 });
    expect(nhayCoc.ok, 'server cho nhảy cóc lượt').toBe(false);
    expect(nhayCoc.reason).toBe('previous_round_pending');

    // Chốt lượt 1.
    const l1 = await rpcAdmin('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 1 });
    expect(l1.ok).toBe(true);
    const [{ n1 }] = await sql<{ n1: number }>(`
      select count(*)::int as n1 from public.lucky_round_winners w
      join public.lucky_event_rounds r on r.id = w.round_id
      where r.event_id = '${s.eventId}' and r.ordinal = 1;`);
    expect(n1).toBe(3);

    // Gọi lại đúng lượt 1 → KHÔNG được bốc thêm lần nữa.
    await rpcAdmin('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 1 });
    const [{ n1b }] = await sql<{ n1b: number }>(`
      select count(*)::int as n1b from public.lucky_round_winners w
      join public.lucky_event_rounds r on r.id = w.round_id
      where r.event_id = '${s.eventId}' and r.ordinal = 1;`);
    expect(n1b, 'gọi lại đã bốc thêm lần nữa ⇒ không idempotent').toBe(3);

    // Trong CÙNG một lượt, ba suất phải là ba vé khác nhau.
    const [{ khac }] = await sql<{ khac: number }>(`
      select count(distinct w.team_id)::int as khac from public.lucky_round_winners w
      join public.lucky_event_rounds r on r.id = w.round_id
      where r.event_id = '${s.eventId}' and r.ordinal = 1;`);
    expect(khac).toBe(3);
  });

  test('server: chốt hết lượt thì đóng sổ, winner_team_id trỏ giải cao nhất', async () => {
    const s = await seed();
    for (const k of [1, 2, 3]) {
      const r = await rpcAdmin('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: k });
      expect(r.ok, `lượt ${k} chốt lỗi: ${r.reason}`).toBe(true);
    }
    const [row] = await sql<{ status: string; khop: boolean; tong: number }>(`
      select e.status,
             e.winner_team_id = (
               select w.team_id from public.lucky_round_winners w
               join public.lucky_event_rounds r on r.id = w.round_id
               where r.event_id = e.id order by r.ordinal desc, w.position asc limit 1) as khop,
             (select sum(w.amount)::int from public.lucky_round_winners w where w.event_id = e.id) as tong
      from public.lucky_events e where e.id = '${s.eventId}';`);
    expect(row.status).toBe('drawn');
    expect(row.khop, 'winner_team_id không trỏ vé trúng giải cao nhất').toBe(true);
    // 100K×3 + 200K×2 + 500K×1 = 1.200.000
    expect(row.tong).toBe(1_200_000);
  });

  test('THỂ LỆ: một vé trúng được nhiều lượt — lượt sau bốc lại từ toàn bộ vé', async () => {
    // Chứng minh TẤT ĐỊNH thay vì trông chờ may rủi: một vé duy nhất, hai lượt
    // mỗi lượt một suất. Nếu server loại vé đã trúng thì lượt 2 sẽ không có ai —
    // và đó chính là điều thể lệ CẤM ("1 người trúng được nhiều giải").
    const uniq = `${TAG}-LAP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [{ event_id }] = await sql<{ event_id: string }>(`
      insert into public.lucky_events
        (organization_id, title, prize_label, prize_amount, draw_at, game, created_by)
      values ('${DEMO_ORG}', '${uniq}', 'Giải may mắn', 100000, null, 'race',
              (select user_id from public.organization_memberships
                where organization_id = '${DEMO_ORG}' and status = 'ACTIVE' limit 1))
      returning id as event_id;`);
    created.push(event_id);
    await sql(`insert into public.lucky_event_teams (event_id, name, sale, deals, checked_in_at)
               values ('${event_id}', 'VE DUY NHAT', 'SALE1', 1, now());`);
    await sql(`insert into public.lucky_event_rounds (event_id, ordinal, label, amount, winners_count)
               values ('${event_id}',1,'',100000,1), ('${event_id}',2,'',200000,1);`);

    for (const k of [1, 2]) {
      const r = await rpcAdmin('lucky_draw_round_v1', { p_event: event_id, p_ordinal: k });
      expect(r.ok, `lượt ${k} lỗi: ${r.reason}`).toBe(true);
    }

    const [row] = await sql<{ so_suat: number; so_ve: number; tong: number }>(`
      select count(*)::int as so_suat,
             count(distinct team_id)::int as so_ve,
             sum(amount)::int as tong
      from public.lucky_round_winners where event_id = '${event_id}';`);
    expect(row.so_suat, 'lượt 2 không trao được suất nào ⇒ server đã loại vé đã trúng').toBe(2);
    expect(row.so_ve, 'hai suất phải cùng một vé vì chỉ có một vé').toBe(1);
    expect(row.tong).toBe(300_000);
  });

  test('màn chiếu: chạy hết 3 lượt liên tiếp, ra bảng vàng cộng theo sale', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page);
    const s = await seed();

    await page.goto(`/quayso/${s.slug}/quay`);

    // Dải giải: 6 ô, tất cả đang "chờ" — chưa ô nào lộ tên.
    await expect(page.locator('.qs-prize')).toHaveCount(6);
    await expect(page.locator('.qs-prize-done')).toHaveCount(0);
    expect(await page.content()).not.toContain('🏅');

    // Màn chiếu KHÔNG có nút mở lượt — chủ giải bấm ở trang quản trị.
    await expect(page.getByRole('button', { name: /Bắt đầu lượt|^▶ Lượt/ })).toHaveCount(0);

    for (const k of [1, 2, 3]) {
      await expect(page.getByText(new RegExp(`Chờ ban tổ chức mở lượt ${k}`)))
        .toBeVisible({ timeout: 20_000 });

      // Chủ giải mở lượt ở NƠI KHÁC (trang quản trị); màn chiếu phải tự bám theo.
      await rpcAdmin('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: k });

      // Đang đua thì CHƯA được lộ kết quả lượt này.
      await expect(page.locator('.qs-track-count')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.qs-prize-done')).toHaveCount(k === 1 ? 0 : k === 2 ? 3 : 5);

      if (k < 3) {
        await expect(page.getByText(`Kết quả lượt ${k}`)).toBeVisible({ timeout: 60_000 });
      } else {
        await expect(page.getByText(/Bảng vàng/)).toBeVisible({ timeout: 60_000 });
      }
    }

    // Hết lượt: 6 ô giải đều đã có chủ.
    await expect(page.locator('.qs-prize-done')).toHaveCount(6);

    // Bảng vàng đủ 6 dòng, và bảng cộng sổ khớp đúng 1.200.000đ.
    await expect(page.locator('.qs-goldboard .qs-roundwin-row')).toHaveCount(6);
    const tally = (await page.locator('.qs-tally').innerText()).replace('🎉', '').trim();
    const tong = tally.split('·')
      .map((x) => x.split(':')[1]?.trim() ?? '')
      .reduce((sum, v) => sum + (v.endsWith('K') ? Number(v.slice(0, -1)) * 1000 : 0), 0);
    expect(tong, `bảng cộng sổ lệch: ${tally}`).toBe(1_200_000);

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('người xem KHÔNG có nút chốt lượt — chỉ chờ ban tổ chức', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const s = await seed();

    // Vào bằng mã của một vé để qua cửa điểm danh.
    const [{ code }] = await sql<{ code: string }>(
      `select code from public.lucky_event_teams where event_id = '${s.eventId}' limit 1;`);

    await page.goto(`/quayso/${s.slug}`);
    await page.getByLabel(/Mã điểm danh của đội/i).fill(code);
    await page.getByRole('button', { name: /^Điểm danh$/i }).click();
    await expect(page.locator('.qs-mine')).toBeVisible();

    // Có dải giải, nhưng KHÔNG có nút mở lượt — quyền đó chỉ ở trang quản trị.
    await expect(page.locator('.qs-prize')).toHaveCount(6);
    await expect(page.getByRole('button', { name: /Bắt đầu lượt|^▶ Lượt/ })).toHaveCount(0);
    await expect(page.getByText(/Chờ ban tổ chức mở lượt 1/)).toBeVisible();
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('ban tổ chức ĐẶT LẠI giữa chừng: trang người xem quay về lượt 1, không đứng im', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = trackConsoleErrors(page);
    const s = await seed();
    const [{ code }] = await sql<{ code: string }>(
      `select code from public.lucky_event_teams where event_id = '${s.eventId}' limit 1;`);

    await page.goto(`/quayso/${s.slug}`);
    await page.getByLabel(/Mã điểm danh của đội/i).fill(code);
    await page.getByRole('button', { name: /^Điểm danh$/i }).click();

    // Diễn xong lượt 1 trên máy người xem.
    await rpcAdmin('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 1 });
    await expect(page.getByText('Kết quả lượt 1')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.qs-prize-done')).toHaveCount(3);

    // Ban tổ chức huỷ kết quả (đúng việc `lucky_admin_reset_draw_v1` làm).
    await sql(`delete from public.lucky_round_winners where event_id = '${s.eventId}';`);
    await sql(`update public.lucky_event_rounds set status='pending', drawn_at=null
               where event_id = '${s.eventId}';`);
    await sql(`update public.lucky_events set status='open', winner_team_id=null, drawn_at=null
               where id = '${s.eventId}';`);

    // Máy này phải QUÊN phần đã diễn, không thì lượt 1 chốt lại nó sẽ đứng im.
    await expect(page.locator('.qs-prize-done')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(/Chờ ban tổ chức mở lượt 1/)).toBeVisible();

    // Chốt lại lượt 1 → phải diễn lại được.
    await rpcAdmin('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 1 });
    await expect(page.getByText('Kết quả lượt 1')).toBeVisible({ timeout: 60_000 });
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('người xem tự diễn lại lượt mà ban tổ chức vừa chốt', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    const s = await seed();
    const [{ code }] = await sql<{ code: string }>(
      `select code from public.lucky_event_teams where event_id = '${s.eventId}' limit 1;`);

    await page.goto(`/quayso/${s.slug}`);
    await page.getByLabel(/Mã điểm danh của đội/i).fill(code);
    await page.getByRole('button', { name: /^Điểm danh$/i }).click();
    await expect(page.getByText(/Chờ ban tổ chức mở lượt 1/)).toBeVisible();

    // Ban tổ chức chốt lượt 1 ở nơi khác → trang này tự bắt được qua poll.
    await rpcAdmin('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 1 });

    await expect(page.locator('.qs-track-count')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Kết quả lượt 1')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.qs-prize-done')).toHaveCount(3);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });
});
