import { test, expect } from '@playwright/test';
import { trackConsoleErrors } from './auth';

/**
 * Trò ĐUA THÚ trên /quayso (`lucky_events.game = 'race'`).
 *
 * Cùng khuôn với `quayso-lucky-draw.spec.ts`: tự seed vào org DEMO qua Supabase
 * Management API rồi tự dọn. KHÔNG đụng org thật.
 *
 * Điều bài này canh, và cũng là điều dễ vỡ nhất khi thêm trò chơi:
 *   - Trò do CHỦ GIẢI chọn, không phải client tự đoán: `game='race'` thì ra
 *     đường đua, `game='wheel'` thì vẫn ra bánh xe (bài cuối).
 *   - Con thú của đội server đã chốt phải VỀ NHẤT — bất biến của cả trò chơi.
 *   - Cán đích là CÔNG BỐ NGAY, không chờ đàn còn lại về.
 *   - Trước lúc về đích, tên đội trúng KHÔNG được lộ ra HTML.
 *
 * Cần env: SUPABASE_PAT (lấy từ CLAUDE.local.md).
 * Chạy trên bản local khi tính năng chưa lên production:
 *   FLEET_BASE_URL=http://localhost:8080 npx playwright test specs/quayso-dua-thu.spec.ts
 */

const PROJECT_REF = 'tryymsxyyckgbrmmvozx';
const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const TAG = 'E2E-DUATHU';

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
  eventId: string;
  codes: { name: string; code: string }[];
}

/** Chỉ dọn đúng id mình tạo — xem ghi chú GOTCHA ở spec vòng xoay. */
const created: string[] = [];

test.afterAll(async () => {
  if (!created.length) return;
  await sql(`delete from public.lucky_events where id in (${created.map((i) => `'${i}'`).join(',')});`);
});

/** Sự kiện `game=<game>` với `n` đội trên đường đua, giờ mở thưởng đã trôi qua. */
async function seed(game: 'race' | 'wheel', n: number, tenDai = false): Promise<SeedRow> {
  const uniq = `${TAG}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const dem = tenDai ? ' CÔNG TY BẤT ĐỘNG SẢN LIKESROOM 302 — TEAM KINH DOANH MIỀN BẮC' : '';
  const names = Array.from({ length: n }, (_, i) => `${uniq} Đội ${i + 1}${dem}`);
  const [{ event_id }] = await sql<{ event_id: string }>(`
    with ev as (
      insert into public.lucky_events
        (organization_id, title, prize_label, prize_amount, draw_at, game, created_by)
      values ('${DEMO_ORG}', '${uniq}', 'Giải may mắn', 500000,
              now() - interval '120 seconds', '${game}',
              (select user_id from public.organization_memberships
                where organization_id = '${DEMO_ORG}' and status = 'ACTIVE' limit 1))
      returning id
    ), doi as (
      insert into public.lucky_event_teams (event_id, name, deals, checked_in_at)
      select ev.id, x, 1, now() from ev, unnest(array[${names.map((x) => `'${x}'`).join(',')}]) as x
      returning event_id
    )
    select ev.id as event_id from ev, (select count(*) from doi) c;
  `);
  created.push(event_id);

  const [{ codes }] = await sql<{ codes: SeedRow['codes'] }>(`
    select jsonb_agg(jsonb_build_object('name', t.name, 'code', t.code) order by t.name) as codes
    from public.lucky_event_teams t where t.event_id = '${event_id}';
  `);
  if (!codes?.length) throw new Error('Seed lỗi: không lấy được mã đội.');
  return { eventId: event_id, codes };
}

/** Chốt sẵn kết quả về đúng đội `name` — để bài kiểm được người thắng tất định. */
const chotKetQua = (eventId: string, name: string) =>
  sql(`update public.lucky_events set status='drawn', drawn_at=now(),
         winner_team_id=(select id from public.lucky_event_teams
                          where event_id='${eventId}' and name='${name}')
       where id='${eventId}';`);

async function nhapMa(page: import('@playwright/test').Page, code: string) {
  await page.getByLabel(/Mã điểm danh của đội/i).fill(code);
  await page.getByRole('button', { name: /^Điểm danh$/i }).click();
}

test.describe('Đua thú trên /quayso', () => {
  test('sự kiện game=race hiện ĐƯỜNG ĐUA, không hiện bánh xe', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const s = await seed('race', 5);
    await chotKetQua(s.eventId, s.codes[2].name);

    await page.goto(`/quayso?e=${s.eventId}`);
    await nhapMa(page, s.codes[0].code);

    await expect(page.locator('.qs-track')).toBeVisible();
    await expect(page.locator('.qs-wheelbox')).toHaveCount(0);
    // Đủ 5 làn, mỗi làn một con thú, không con nào trùng con nào.
    await expect(page.locator('.qs-lane')).toHaveCount(5);
    const thu = await page.locator('.qs-lane-animal').allInnerTexts();
    expect(thu).toHaveLength(5);
    expect(new Set(thu).size, `con thú bị trùng: ${thu.join(' ')}`).toBe(5);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('vào sau khi đã chốt: đáp án bị giấu cho tới khi cuộc đua kết thúc', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = trackConsoleErrors(page);
    const s = await seed('race', 6);
    const [toi, , , , , thang] = s.codes;
    await chotKetQua(s.eventId, thang.name);

    await page.goto(`/quayso?e=${s.eventId}`);
    await nhapMa(page, toi.code);
    await expect(page.locator('.qs-mine')).toBeVisible();

    // Chưa đua ⇒ chưa được lộ ai trúng.
    const xemLai = page.getByRole('button', { name: /Xem lại cuộc đua/i });
    await expect(xemLai).toBeVisible();
    await expect(page.locator('.qs-lastwin')).toHaveCount(0);
    await expect(page.locator('.qs-winlabel')).toHaveCount(0);

    // Bấm đua → phải qua đếm ngược rồi mới chạy.
    await xemLai.click();
    await expect(page.locator('.qs-track-count')).toBeVisible({ timeout: 5_000 });
    // Ngay giữa cuộc đua vẫn chưa được công bố.
    await expect(page.locator('.qs-track-count')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.qs-lastwin')).toHaveCount(0);

    // Về đích → công bố, và ĐÚNG đội server đã chốt.
    // Mốc là `.qs-lastwin` — bảng công bố của TRANG. Bài này từng soi
    // `.qs-race-win`, một dòng nằm trong chính component đua; dòng đó đã gộp vào
    // bảng của trang khi lên nhiều lượt nên không còn tồn tại.
    await expect(page.locator('.qs-lastwin')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.qs-lastwin')).toContainText(thang.name);
    await expect(page.locator('.qs-winlabel')).toHaveText(/Trúng giải/);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('con thú của đội trúng về NHẤT, và công bố ngay khi nó cán đích', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = trackConsoleErrors(page);
    const s = await seed('race', 8);
    const thang = s.codes[5];
    await chotKetQua(s.eventId, thang.name);

    await page.goto(`/quayso?e=${s.eventId}`);
    await nhapMa(page, s.codes[0].code);

    // CHỤP DOM ĐÚNG KHUNG HÌNH ĐỘI TRÚNG CHẠM VẠCH.
    //
    // Mốc: `paint()` gắn `qs-lane-home` cho làn đội trúng ngay trong khung hình
    // phát hiện cán đích. Cùng khung đó, mỗi làn mang `data-ve-dich` nói nó đã
    // về hay chưa — nhờ vậy bất biến "công bố không chờ cả đàn" đo được TRỰC
    // TIẾP, không phải suy ra từ khoảng cách pixel (khoảng cách co lại khi máy
    // chậm ⇒ bài đỏ vì tải chứ không vì luồng sai; đã dính đúng lỗi này).
    const chup = page.evaluate<{
      tenThang: string | null;
      soVeDich: number;
      viTri: { ten: string; x: number; ve: boolean }[];
    }>(
      () =>
        new Promise((resolve) => {
          const doc = () =>
            Array.from(document.querySelectorAll('.qs-runner')).map((el) => {
              const thu = el.querySelector('.qs-lane-animal');
              return {
                ten: el.querySelector('.qs-lane-chip')?.textContent?.trim() ?? '',
                x: thu ? thu.getBoundingClientRect().right : 0,
                ve: (el as HTMLElement).dataset.veDich === '1',
              };
            });
          const xong = () => {
            const home = document.querySelector('.qs-lane-home');
            if (!home) return;
            obs.disconnect();
            const vi = doc();
            resolve({
              tenThang: home.textContent?.trim() ?? null,
              soVeDich: vi.filter((d) => d.ve).length,
              viTri: vi,
            });
          };
          const obs = new MutationObserver(xong);
          obs.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'data-ve-dich'],
          });
          xong();
        }),
    );

    await page.getByRole('button', { name: /Xem lại cuộc đua/i }).click();
    const kq = await chup;
    const bang = kq.viTri.map((d) => `${d.ten}${d.ve ? '(về)' : ''}=${d.x.toFixed(0)}`).join(' | ');

    // (1) Làn cán đích đầu tiên phải là ĐÚNG đội server đã chốt.
    expect(kq.tenThang, `trạng thái lúc công bố: ${bang}`).toBe(thang.name);

    // (2) CÔNG BỐ NGAY: đúng khung hình đó mới CÓ MỘT làn về đích, cả đàn còn
    //     lại vẫn đang chạy. Bằng số làn nghĩa là đã ngồi chờ nhau — sai luồng.
    expect(kq.soVeDich, `công bố mà ${kq.soVeDich}/8 làn đã về ⇒ chờ nhau: ${bang}`).toBe(1);

    // (3) Nó cũng là con đi xa nhất — không ai vượt mặt.
    const nhat = kq.viTri.find((d) => d.ten === thang.name);
    const khac = kq.viTri.filter((d) => d.ten !== thang.name);
    expect(nhat, `không thấy đội trúng trên đường đua: ${bang}`).toBeTruthy();
    expect(Math.max(...khac.map((d) => d.x)), `thứ tự lúc công bố: ${bang}`)
      .toBeLessThan((nhat as { x: number }).x);

    await expect(page.locator('.qs-lastwin')).toContainText(thang.name);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('KHÔNG hồi quy: tên đội dài vẫn phải chạy được, không đứng im', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = trackConsoleErrors(page);
    // Lỗi đã trả giá: quãng đường chạy được tính bằng
    // `lane.clientWidth - runner.offsetWidth - 30`. Tên đội dài làm khối chạy
    // rộng hơn cả làn ⇒ hiệu số ÂM ⇒ bị kẹp về 0 ⇒ CẢ ĐÀN ĐỨNG IM suốt cuộc đua
    // mà không hề báo lỗi: kết quả vẫn công bố đúng, chỉ là không con nào nhúc
    // nhích. Chữa bằng trần `max-width` neo theo bề rộng làn.
    const s = await seed('race', 6, true);
    const thang = s.codes[3];
    await chotKetQua(s.eventId, thang.name);

    await page.goto(`/quayso?e=${s.eventId}`);
    await nhapMa(page, s.codes[0].code);
    await page.getByRole('button', { name: /Xem lại cuộc đua/i }).click();
    await expect(page.locator('.qs-lastwin')).toBeVisible({ timeout: 60_000 });

    const do1 = await page.locator('.qs-runner').evaluateAll((els) =>
      els.map((el) => {
        const lane = el.parentElement;
        const m = /translate\(([-\d.]+)px/.exec((el as HTMLElement).style.transform || '');
        return {
          duongChay: lane ? lane.clientWidth - (el as HTMLElement).offsetWidth - 30 : -1,
          x: m ? Number(m[1]) : 0,
        };
      }),
    );
    // Đường chạy phải còn chỗ THẬT, và con thú phải thật sự đã đi được quãng đó.
    for (const d of do1) {
      expect(d.duongChay, `khối chạy rộng hơn làn ⇒ quãng đường ${d.duongChay}px`).toBeGreaterThan(40);
    }
    expect(Math.max(...do1.map((d) => d.x)), 'không con nào rời vạch xuất phát').toBeGreaterThan(40);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('KHÔNG hồi quy: sự kiện game=wheel vẫn ra bánh xe như cũ', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const s = await seed('wheel', 4);
    await chotKetQua(s.eventId, s.codes[1].name);

    await page.goto(`/quayso?e=${s.eventId}`);
    await nhapMa(page, s.codes[0].code);

    await expect(page.locator('.qs-wheelbox')).toBeVisible();
    await expect(page.locator('.qs-track')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Xem lại kết quả quay/i })).toBeVisible();
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });
});
