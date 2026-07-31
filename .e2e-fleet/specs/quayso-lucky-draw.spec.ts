import { test, expect } from '@playwright/test';
import { trackConsoleErrors } from './auth';

/**
 * Sự kiện quay số may mắn — trang CÔNG KHAI /quayso (sale không đăng nhập).
 *
 * Dữ liệu do bài tự seed qua Supabase Management API vào org DEMO
 * (dddd0000-…-0001) và tự dọn ở cuối. KHÔNG đụng org thật.
 *
 * Cần env: SUPABASE_PAT (hoặc đọc từ CLAUDE.local.md khi chạy tay).
 */

const PROJECT_REF = 'tryymsxyyckgbrmmvozx';
const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';

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

const TAG = 'E2E-QUAYSO';

interface SeedRow {
  event_id: string;
  codes: { name: string; code: string }[];
}

/** Tạo sự kiện: 2 đội TOP + n đội quay, hẹn giờ sau `secondsFromNow`.
 *
 * PHẢI tách 2 câu lệnh: CTE ghi dữ liệu (`insert … returning`) chạy trên cùng
 * một snapshot nên phần SELECT của CÙNG câu lệnh KHÔNG thấy dòng vừa chèn —
 * gộp lại thì `codes` luôn trả null. */
async function seedEvent(secondsFromNow: number, wheelTeams = 4): Promise<SeedRow> {
  const names = Array.from({ length: wheelTeams }, (_, i) => `${TAG} Đội ${i + 1}`);
  const [{ event_id }] = await sql<{ event_id: string }>(`
    with ev as (
      insert into public.lucky_events (organization_id, title, prize_label, prize_amount, draw_at, created_by)
      values ('${DEMO_ORG}', '${TAG} Trao thưởng', 'Giải may mắn', 500000,
              now() + interval '${secondsFromNow} seconds',
              (select user_id from public.organization_memberships
                where organization_id = '${DEMO_ORG}' and status = 'ACTIVE' limit 1))
      returning id
    ), tops as (
      insert into public.lucky_event_teams (event_id, name, deals, top_rank, top_prize_amount, in_wheel)
      select ev.id, v.name, v.deals, v.rank, v.prize, false from ev,
        (values ('${TAG} Quán quân', 3, 1, 2500000), ('${TAG} Á quân', 2, 2, 1500000))
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

  const [{ codes }] = await sql<{ codes: SeedRow['codes'] }>(`
    select jsonb_agg(jsonb_build_object('name', t.name, 'code', t.code) order by t.created_at) as codes
    from public.lucky_event_teams t
    where t.event_id = '${event_id}' and t.in_wheel;
  `);

  if (!codes?.length) throw new Error('Seed lỗi: không lấy được mã đội.');
  return { event_id, codes };
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

test.describe('Trang công khai /quayso', () => {
  test('mở link thiếu mã: yêu cầu nhập mã, KHÔNG lộ mã đội nào', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const seed = await seedEvent(3600);

    await page.goto(`/quayso?e=${seed.event_id}`);
    await expect(page.getByLabel(/Mã điểm danh của đội/i)).toBeVisible();

    // Payload public không được chứa bất kỳ mã nào
    const html = await page.content();
    for (const { code } of seed.codes) {
      expect(html, `mã ${code} bị lộ ra trang công khai`).not.toContain(code);
    }

    // Vẫn thấy tên đội + đếm ngược
    await expect(page.getByText(seed.codes[0].name)).toBeVisible();
    await expect(page.getByText(/Mở thưởng sau/i)).toBeVisible();

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('nhập mã đúng → điểm danh, đội mình được đánh dấu, mã sai bị từ chối', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const seed = await seedEvent(3600);
    const mine = seed.codes[1];

    await page.goto(`/quayso?e=${seed.event_id}`);

    // Mã sai
    await page.getByLabel(/Mã điểm danh của đội/i).fill('000001');
    await page.getByRole('button', { name: /Điểm danh/i }).click();
    await expect(page.getByText(/Mã không đúng|sự kiện đã đóng/i)).toBeVisible();

    // Mã đúng
    await page.getByLabel(/Mã điểm danh của đội/i).fill(mine.code);
    await page.getByRole('button', { name: /Điểm danh/i }).click();

    // Tên đội xuất hiện cả ở thẻ "đội của bạn" lẫn lưới → khoanh vùng thẻ trên.
    const mineCard = page.locator('.qs-mine');
    await expect(mineCard.getByText(/Đội của bạn/i)).toBeVisible();
    await expect(mineCard.getByText(mine.name)).toBeVisible();
    await expect(mineCard.getByText(/Đã điểm danh ✓/)).toBeVisible();

    // Tiến độ phải là 1/n
    await expect(page.getByText(/^1\/\d+ đội$/)).toBeVisible();

    // Tải lại trang: mã nhớ trong localStorage, không phải nhập lại
    await page.reload();
    await expect(page.getByText(/Đội của bạn/i)).toBeVisible();

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('tới giờ: bánh xe tự quay và công bố đúng đội server chốt', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = trackConsoleErrors(page);
    const seed = await seedEvent(20, 3);

    // Giả lập 3 máy khác đã điểm danh (ghi thẳng DB cho nhanh và tất định)
    await sql(`update public.lucky_event_teams set checked_in_at = now()
               where event_id = '${seed.event_id}' and in_wheel;`);

    // Máy này nhập mã đội 1 để có "đội của bạn"
    await page.goto(`/quayso?e=${seed.event_id}`);
    await page.getByLabel(/Mã điểm danh của đội/i).fill(seed.codes[0].code);
    await page.getByRole('button', { name: /Điểm danh/i }).click();
    await expect(page.getByText(/Đội của bạn/i)).toBeVisible();

    // Chờ tới giờ + bánh xe quay 5.2s + poll
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 60_000 });

    // Đội công bố trên overlay phải KHỚP winner trong DB
    const [{ winner }] = await sql<{ winner: string }>(`
      select t.name as winner from public.lucky_events e
      join public.lucky_event_teams t on t.id = e.winner_team_id
      where e.id = '${seed.event_id}';
    `);
    await expect(page.getByRole('dialog').getByText(winner, { exact: false })).toBeVisible();

    // Đóng overlay, thẻ đội trúng có nhãn "Trúng giải"
    await page.getByRole('button', { name: /Quá đã/i }).click();
    await expect(page.getByText(/Trúng giải/i)).toBeVisible();

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });
});
