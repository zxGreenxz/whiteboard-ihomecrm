import { test, expect } from '@playwright/test';
import { trackConsoleErrors } from './auth';

/**
 * SỰ KIỆN CHIA NHIỀU LƯỢT — mỗi lượt vài suất, đua xong lượt này mới sang lượt
 * sau (đêm tổng kết: 100K×3 → 200K×2 → 500K×1).
 *
 * Bốn điều bài này canh, đều là chỗ dễ vỡ khi lên nhiều lượt:
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

/** Gọi RPC công khai đúng như trình duyệt gọi (anon), để kiểm luật phía server. */
async function rpc(fn: string, args: Record<string, unknown>) {
  const [{ out }] = await sql<{ out: unknown }>(
    `select public.${fn}(${Object.values(args)
      .map((v) => (typeof v === 'number' ? String(v) : `'${String(v)}'`))
      .join(',')}) as out;`,
  );
  return out as { ok: boolean; reason?: string; rounds?: { ordinal: number; status: string }[] };
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
  test('server: không cho nhảy cóc lượt, và gọi lại đúng lượt là idempotent', async () => {
    const s = await seed();

    // Nhảy thẳng lượt 2 khi lượt 1 chưa quay → phải từ chối.
    const nhayCoc = await rpc('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 2 });
    expect(nhayCoc.ok, 'server cho nhảy cóc lượt').toBe(false);
    expect(nhayCoc.reason).toBe('previous_round_pending');

    // Chốt lượt 1.
    const l1 = await rpc('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 1 });
    expect(l1.ok).toBe(true);
    const [{ n1 }] = await sql<{ n1: number }>(`
      select count(*)::int as n1 from public.lucky_round_winners w
      join public.lucky_event_rounds r on r.id = w.round_id
      where r.event_id = '${s.eventId}' and r.ordinal = 1;`);
    expect(n1).toBe(3);

    // Gọi lại đúng lượt 1 → KHÔNG được bốc thêm lần nữa.
    await rpc('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 1 });
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
      const r = await rpc('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: k });
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
      const r = await rpc('lucky_draw_round_v1', { p_event: event_id, p_ordinal: k });
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

    for (const k of [1, 2, 3]) {
      const nut = page.getByRole('button', { name: /Bắt đầu lượt 1|^▶ Lượt/ });
      await expect(nut).toBeVisible({ timeout: 20_000 });
      await nut.click();

      // Đang đua thì CHƯA được lộ kết quả lượt này.
      await expect(page.locator('.qs-track-count')).toBeVisible({ timeout: 6_000 });
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

    // Có dải giải, nhưng KHÔNG có nút mở lượt — quyền đó thuộc màn chiếu.
    await expect(page.locator('.qs-prize')).toHaveCount(6);
    await expect(page.getByRole('button', { name: /Bắt đầu lượt|^▶ Lượt/ })).toHaveCount(0);
    await expect(page.getByText(/Chờ ban tổ chức mở lượt 1/)).toBeVisible();
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
    await rpc('lucky_draw_round_v1', { p_event: s.eventId, p_ordinal: 1 });

    await expect(page.locator('.qs-track-count')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Kết quả lượt 1')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.qs-prize-done')).toHaveCount(3);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });
});
