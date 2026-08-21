import { test, expect } from '@playwright/test';
import { trackConsoleErrors } from './auth';

/**
 * Sự kiện quay số may mắn — trang CÔNG KHAI /quayso (sale không đăng nhập).
 *
 * Dữ liệu do bài tự seed qua Supabase Management API vào org DEMO
 * (dddd0000-…-0001) và tự dọn ở cuối. KHÔNG đụng org thật.
 *
 * Cần env: SUPABASE_PAT (lấy từ CLAUDE.local.md).
 */

const PROJECT_REF = 'tryymsxyyckgbrmmvozx';
const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const TAG = 'E2E-QUAYSO';

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

interface SeedRow {
  event_id: string;
  codes: { name: string; code: string }[];
}

/** Sự kiện do CHÍNH worker này tạo.
 *
 * GOTCHA: `delete … where title like '<TAG>%'` là sai — Playwright chạy mỗi test
 * ở một worker riêng, `afterAll` chạy MỘT LẦN MỖI WORKER, nên worker xong trước
 * sẽ xoá luôn sự kiện của worker đang chạy → test kia thấy `not_found`, trang
 * trắng, chờ dialog tới hết giờ. Chỉ dọn đúng id mình tạo. */
const createdEvents: string[] = [];

test.afterAll(async () => {
  if (!createdEvents.length) return;
  const ids = createdEvents.map((id) => `'${id}'`).join(',');
  await sql(`delete from public.lucky_events where id in (${ids});`);
});

/** Tạo sự kiện: 2 đội TOP + n đội quay, hẹn giờ sau `secondsFromNow` (âm = đã qua).
 *
 * PHẢI tách 2 câu lệnh: CTE ghi dữ liệu (`insert … returning`) chạy trên cùng
 * một snapshot nên phần SELECT của CÙNG câu lệnh KHÔNG thấy dòng vừa chèn —
 * gộp lại thì `codes` luôn trả null. */
async function seedEvent(secondsFromNow: number, wheelTeams = 4): Promise<SeedRow> {
  const uniq = `${TAG}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const names = Array.from({ length: wheelTeams }, (_, i) => `${uniq} Đội ${i + 1}`);
  const [{ event_id }] = await sql<{ event_id: string }>(`
    with ev as (
      insert into public.lucky_events (organization_id, title, prize_label, prize_amount, draw_at, created_by)
      values ('${DEMO_ORG}', '${uniq}', 'Giải may mắn', 500000,
              now() + interval '${secondsFromNow} seconds',
              (select user_id from public.organization_memberships
                where organization_id = '${DEMO_ORG}' and status = 'ACTIVE' limit 1))
      returning id
    ), tops as (
      insert into public.lucky_event_teams (event_id, name, deals, top_rank, top_prize_amount, in_wheel)
      select ev.id, v.name, v.deals, v.rank, v.prize, false from ev,
        (values ('${uniq} Quán quân', 3, 1, 2500000), ('${uniq} Á quân', 2, 2, 1500000))
        as v(name, deals, rank, prize)
      returning event_id
    ), wheel as (
      insert into public.lucky_event_teams (event_id, name, deals)
      select ev.id, n, 1 from ev, unnest(array[${names.map((n) => `'${n}'`).join(',')}]) as n
      returning event_id
    )
    select ev.id as event_id from ev,
      (select count(*) from tops) a, (select count(*) from wheel) b;
  `);
  createdEvents.push(event_id);

  const [{ codes }] = await sql<{ codes: SeedRow['codes'] }>(`
    select jsonb_agg(jsonb_build_object('name', t.name, 'code', t.code) order by t.name) as codes
    from public.lucky_event_teams t
    where t.event_id = '${event_id}' and t.in_wheel;
  `);
  if (!codes?.length) throw new Error('Seed lỗi: không lấy được mã đội.');
  return { event_id, codes };
}

const checkIn = (eventId: string, names: string[]) =>
  sql(`update public.lucky_event_teams set checked_in_at = now()
       where event_id = '${eventId}' and name in (${names.map((n) => `'${n}'`).join(',')});`);

async function enterCode(page: import('@playwright/test').Page, code: string) {
  await page.getByLabel(/Mã điểm danh của đội/i).fill(code);
  await page.getByRole('button', { name: /^Điểm danh$/i }).click();
}

test.describe('Trang công khai /quayso', () => {
  test('mở link thiếu mã: yêu cầu nhập mã, KHÔNG lộ mã đội nào', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const seed = await seedEvent(3600);

    await page.goto(`/quayso?e=${seed.event_id}`);
    await expect(page.getByLabel(/Mã điểm danh của đội/i)).toBeVisible();

    const html = await page.content();
    for (const { code } of seed.codes) {
      expect(html, `mã ${code} bị lộ ra trang công khai`).not.toContain(code);
    }

    await expect(page.getByText(seed.codes[0].name)).toBeVisible();
    await expect(page.getByText(/Mở thưởng sau/i)).toBeVisible();
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('nhập mã đúng → điểm danh; mã sai bị từ chối', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const seed = await seedEvent(3600);
    const mine = seed.codes[1];

    await page.goto(`/quayso?e=${seed.event_id}`);

    await enterCode(page, '000001');
    await expect(page.getByText(/Mã không đúng|sự kiện đã đóng/i)).toBeVisible();

    await enterCode(page, mine.code);
    const mineCard = page.locator('.qs-mine');
    // Câu chữ đổi ở 0227e86d: "Đội của bạn" → "Bạn đang điểm danh với tư cách đội".
    await expect(mineCard.getByText(/tư cách đội/i)).toBeVisible();
    await expect(mineCard.getByText(mine.name)).toBeVisible();
    await expect(page.getByText(/^1\/\d+ đội$/)).toBeVisible();

    // Mã nhớ trong localStorage → tải lại không phải nhập lại
    await page.reload();
    await expect(page.locator('.qs-mine').getByText(/tư cách đội/i)).toBeVisible();
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('quá giờ mở thưởng: đội chưa điểm danh bị từ chối "đã trễ giờ"', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const seed = await seedEvent(-60, 2);          // giờ quay đã trôi qua
    await checkIn(seed.event_id, [seed.codes[0].name]);   // đội 1 kịp điểm danh

    await page.goto(`/quayso?e=${seed.event_id}`);

    // Đội 2 chưa điểm danh → chặn
    await enterCode(page, seed.codes[1].code);
    await expect(page.getByText(/Đã trễ giờ điểm danh/i)).toBeVisible();

    // Đội 1 đã điểm danh từ trước → vẫn vào xem được
    await enterCode(page, seed.codes[0].code);
    await expect(page.locator('.qs-mine').getByText(seed.codes[0].name)).toBeVisible();
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('xem trực tiếp: bánh xe tự quay, đội TRÚNG thấy popup chúc mừng', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    // Chỉ 1 đội trên bánh xe → server buộc phải chọn đúng đội đó ⇒ tất định.
    const seed = await seedEvent(25, 1);
    await checkIn(seed.event_id, [seed.codes[0].name]);

    await page.goto(`/quayso?e=${seed.event_id}`);
    await enterCode(page, seed.codes[0].code);
    await expect(page.locator('.qs-mine')).toBeVisible();

    // Trước khi bánh xe dừng, tên đội trúng KHÔNG được lộ
    await expect(page.locator('.qs-lastwin')).toHaveCount(0);

    // Tới giờ → tự quay → popup vì chính đội mình trúng
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('dialog').getByText(seed.codes[0].name)).toBeVisible();
    await expect(page.getByRole('dialog').getByText(/đội bạn/i)).toBeVisible();

    await page.getByRole('button', { name: /Quá đã/i }).click();
    await expect(page.locator('.qs-winlabel')).toHaveText(/Trúng giải/);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('vào sau khi đã quay: chờ bấm "Xem lại", đội THUA thấy popup cổ vũ', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    const seed = await seedEvent(-120, 3);
    const [me, , winnerTeam] = seed.codes;
    await checkIn(seed.event_id, [me.name, winnerTeam.name]);

    // Chốt sẵn kết quả: đội trúng KHÔNG phải đội mình → mình là đội thua.
    await sql(`
      update public.lucky_events set status = 'drawn', drawn_at = now(),
        winner_team_id = (select id from public.lucky_event_teams
                          where event_id = '${seed.event_id}' and name = '${winnerTeam.name}')
      where id = '${seed.event_id}';
    `);

    await page.goto(`/quayso?e=${seed.event_id}`);
    await enterCode(page, me.code);
    await expect(page.locator('.qs-mine')).toBeVisible();

    // Vào sau ⇒ bánh xe đứng yên, đáp án bị giấu, có nút xem lại
    const replay = page.getByRole('button', { name: /Xem lại kết quả quay/i });
    await expect(replay).toBeVisible();
    await expect(page.locator('.qs-lastwin')).toHaveCount(0);
    await expect(page.locator('.qs-winlabel')).toHaveCount(0);
    expect(await page.content()).not.toContain('Chúc mừng');

    // Bấm xem lại → bánh xe quay rồi mới công bố
    await replay.click();
    await expect(page.locator('.qs-lastwin')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.qs-lastwin')).toContainText(winnerTeam.name);

    // Mình là đội THUA → VẪN có popup, nhưng là lời cổ vũ chứ không phải ăn mừng.
    // Bài này từng đòi "tuyệt đối không có popup"; hành vi đã đổi CÓ CHỦ Ý ở
    // c5c84c8a (chính commit đó chỉnh câu chữ trong popup đội chưa trúng) — im
    // lặng với đội thua làm người ta hụt hẫng. Bài cũ đỏ suốt trên production.
    const hop = page.getByRole('dialog');
    await expect(hop).toBeVisible();
    await expect(hop).toContainText(/lần sau nhé/i);
    // Nhưng tuyệt đối không được là popup ăn mừng, và không nêu tên đội trúng.
    await expect(hop.getByRole('button', { name: /Quá đã/i })).toHaveCount(0);
    await expect(hop).not.toContainText(winnerTeam.name);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });
});
