import { expect, test, type Page } from '@playwright/test';

import { login, trackConsoleErrors } from './auth';

/**
 * Tạo hợp đồng QUA GIAO DIỆN → modal "Tạo phiếu chi hoa hồng" mở → gõ vào form
 * → chờ qua trần debounce của hub realtime → prefill phải được gọi ĐÚNG MỘT LẦN
 * và thứ vừa gõ phải còn nguyên.
 *
 * BUG 15/09/2026 (người dùng thật báo): ký hợp đồng xong, modal hoa hồng bật
 * lên, đang điền dở thì form tự xoá sạch; có lần kẹt luôn ở dòng "Đang tải thông
 * tin hợp đồng..." với nút Tạo phiếu mờ.
 *
 * Chuỗi nguyên nhân:
 *   1. `create_contract_v2` ghi ≥5 bảng nằm trong publication realtime
 *      (contracts, contract_customers, contract_services, income_expenses +
 *      items, invoices + items, rooms) trong CÙNG một giao dịch.
 *   2. Hub `useRealtimeDataSync` nhận event, debounce 800 ms với trần 2,4 s, rồi
 *      invalidate theo descriptor. Descriptor `income_expenses` khai nhầm khoá
 *      prefill của modal hoa hồng — trong khi prefill không đọc bảng đó.
 *   3. Cú tải lại đó LỖI (5xx/timeout giữa cơn bão, hoặc PGRST116) thì hook cũ
 *      `return null` trong trạng thái THÀNH CÔNG: không retry, không báo gì.
 *      `prefill` thành rỗng ⇒ modal rơi về nhánh "Đang tải thông tin hợp
 *      đồng...", nút Tạo phiếu mờ, và ở lại đó vĩnh viễn.
 *   4. Khi một lượt tải sau đó thành công, `prefill` là một OBJECT MỚI ⇒ effect
 *      seed cũ (phụ thuộc identity của object) mồi lại từ đầu, xoá sạch tên môi
 *      giới, số tài khoản, ngân hàng, ảnh và số tiền người dùng đã nhập.
 *
 * ĐÍNH CHÍNH MỘT MẮT XÍCH, đo thật 15/09/2026 trên production: một lượt tải lại
 * THÀNH CÔNG mà dữ liệu y hệt thì KHÔNG làm mất chữ — react-query có
 * `structuralSharing`, dữ liệu không đổi thì nó trả về đúng object cũ nên effect
 * không chạy lại. Bản đầu của bài test này dựa vào đó và xanh trên chính bản
 * CHƯA VÁ (đã nghe WebSocket để xác nhận prefill có tải lại thật). Cửa vỡ nằm ở
 * lượt tải lại HỎNG, nên bài test phải dựng đúng tình huống đó.
 *
 * CÁCH DỰNG: sau khi gõ, chặn ĐÚNG những request prefill và cho chúng hỏng. Nếu
 * descriptor không còn đánh thức prefill nữa thì không có request nào để chặn —
 * đó chính là trạng thái đã vá, và bài đi qua êm. Nếu khoá kia quay lại,
 * request xuất hiện, bị chặn, và modal phải chịu được: không mất chữ, không kẹt.
 *
 * VÌ SAO PHẢI LÀ BÀI UI. `commission-voucher-per-section.spec.ts` gọi thẳng
 * PostgREST nên không có React, không có hub realtime, không có effect seed —
 * nó xanh suốt trong khi bug vẫn đang xảy ra với người dùng.
 *
 * CHỜ 4 GIÂY LÀ CỐ Ý, KHÔNG PHẢI NGỦ CHO CHẮC. Trần debounce là 2,4 s tính từ
 * event cuối; 4 s là qua trần đó với một khoảng dự phòng. Rút xuống dưới 2,4 s
 * là bài test mất khả năng bắt lỗi mà vẫn xanh.
 *
 * CHỈ ghi org DEMO dddd0000-…0001. Không tạo phiếu hoa hồng nào (bấm "Bỏ qua").
 * Fixture tự dọn: xoá mềm hoá đơn + hợp đồng, trả phòng về trạng thái cũ.
 *
 * Chạy:
 *   cd .e2e-fleet && FLEET_PASS_CHUNHA=… SUPABASE_MGMT_PAT=… \
 *     npx playwright test specs/contract-create-then-commission.spec.ts
 */

const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';

/** Trần debounce của hub realtime là 2,4 s — chờ vượt qua nó rồi mới đo. */
const QUA_TRAN_DEBOUNCE_MS = 4_000;

const TEN_MOI_GIOI = 'E2E Môi giới Bình Minh';
const SO_TAI_KHOAN = '0123456789';

async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\/rest\/v1\//.test(r.url()), { timeout: 45_000 });
  const h = req.headers();
  return { base: new URL(req.url()).origin, apikey: h['apikey'], auth: h['authorization'] };
}
type SbAuth = Awaited<ReturnType<typeof captureSupabaseAuth>>;

async function sbGet(a: SbAuth, path: string) {
  const r = await fetch(`${a.base}/rest/v1/${path}`, {
    headers: { apikey: a.apikey, Authorization: a.auth, 'Accept-Profile': 'public' },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbRpc(a: SbAuth, name: string, body: unknown) {
  const r = await fetch(`${a.base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: a.apikey,
      Authorization: a.auth,
      'Content-Type': 'application/json',
      'Content-Profile': 'public',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, ok: r.ok, json, text };
}

/** SQL qua Management API — CHỈ để dọn fixture. Không dùng để lách writer. */
async function mgmtQuery(sql: string): Promise<unknown[]> {
  const pat = process.env.SUPABASE_MGMT_PAT;
  const ref = process.env.SUPABASE_PROJECT_REF || 'tryymsxyyckgbrmmvozx';
  if (!pat) {
    throw new Error(
      'Thiếu SUPABASE_MGMT_PAT — cần để dọn hợp đồng fixture. PAT nằm ở CLAUDE.local.md, KHÔNG commit.',
    );
  }
  // Management API có hạn mức tần suất. Bỏ qua một lần 429 ở bước dọn nghĩa là
  // để lại một hợp đồng ACTIVE và một phòng OCCUPIED trong org DEMO — đã xảy ra
  // thật 15/09/2026, phải dọn tay sau đó. Nên thử lại, đừng bỏ cuộc ngay.
  let last = '';
  for (let lan = 0; lan < 4; lan += 1) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
    if (r.ok) return r.json();
    last = `${r.status} ${await r.text()}`;
    if (r.status !== 429) break;
    await new Promise((done) => setTimeout(done, 2_000 * (lan + 1)));
  }
  throw new Error(`mgmt query → ${last}`);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** DateInput nhận chuỗi số rồi tự chèn dấu gạch: 15092026 → 15/09/2026. */
const ddmmyyyy = (isoDate: string) =>
  isoDate.slice(8, 10) + isoDate.slice(5, 7) + isoDate.slice(0, 4);
const addDays = (base: string, days: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
/** Ngày cuối tháng chứa `base` — kỳ tính tiền tháng đầu bắt buộc phủ hết tháng. */
const cuoiThang = (base: string) => {
  const d = new Date(`${base}T00:00:00Z`);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};

test('tạo HĐ qua UI → modal hoa hồng giữ nguyên thứ người dùng đang gõ', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = trackConsoleErrors(page);

  /**
   * Mọi request mang đúng chữ ký truy vấn của `useCommissionPrefill`. Khớp hẹp
   * theo danh sách cột chứ không theo bảng: trang nền cũng đang đọc `contracts`.
   */
  const prefillRequests: string[] = [];
  page.on('request', (r) => {
    if (/\/rest\/v1\/contracts\?select=id%2Ccontract_number%2Csigned_date/.test(r.url())) {
      prefillRequests.push(new Date().toISOString().slice(11, 23));
    }
  });

  let contractId: string | null = null;
  let roomId: string | null = null;
  let roomStatus0: string | null = null;
  let depositVoucherIds: string[] = [];
  let auth: SbAuth | null = null;

  try {
    await login(page, 'chunha');
    const nav = page.goto('/contracts');
    auth = await captureSupabaseAuth(page);
    await nav;

    // ── 1. Chọn phòng DEMO trống SẠCH: không HĐ ACTIVE, không phiếu cọc mồ côi
    const buildings = (await sbGet(
      auth,
      `buildings?select=id,name&organization_id=eq.${DEMO_ORG}&deleted_at=is.null`,
    )) as { id: string; name: string }[];
    expect(buildings.length, 'org DEMO phải có toà nhà').toBeGreaterThan(0);
    const buildingById = new Map(buildings.map((b) => [b.id, b.name]));

    const rooms = (await sbGet(
      auth,
      `rooms?select=id,name,status,building_id&building_id=in.(${buildings
        .map((b) => b.id)
        .join(',')})&status=eq.AVAILABLE&deleted_at=is.null`,
    )) as { id: string; name: string; status: string; building_id: string }[];
    const activeContracts = (await sbGet(
      auth,
      `contracts?select=room_id&status=eq.ACTIVE&deleted_at=is.null&organization_id=eq.${DEMO_ORG}`,
    )) as { room_id: string }[];
    const orphanDeposits = (await sbGet(
      auth,
      `income_expenses?select=room_id&organization_id=eq.${DEMO_ORG}&type=eq.INCOME` +
        `&approval_status=eq.APPROVED&contract_id=is.null&deleted_at=is.null&room_id=not.is.null`,
    )) as { room_id: string }[];
    const busy = new Set([
      ...activeContracts.map((c) => c.room_id),
      ...orphanDeposits.map((v) => v.room_id),
    ]);
    const candidates = rooms.filter((r) => !busy.has(r.id) && buildingById.has(r.building_id));
    expect(candidates.length, 'cần ít nhất 1 phòng DEMO trống sạch để ký HĐ').toBeGreaterThan(0);
    const room = candidates[Math.floor(Math.random() * candidates.length)];
    roomId = room.id;
    roomStatus0 = room.status;
    const buildingName = buildingById.get(room.building_id)!;

    const [customer] = (await sbGet(
      auth,
      `customers?select=id,full_name&organization_id=eq.${DEMO_ORG}&deleted_at=is.null&limit=1`,
    )) as { id: string; full_name: string }[];
    expect(customer, 'org DEMO phải có khách hàng').toBeTruthy();

    // ── 2. Mở form "Tạo hợp đồng mới" ────────────────────────────────────────
    const search = page.getByPlaceholder('Tìm theo mã HĐ, tên khách, SĐT, tên phòng...');
    await expect(search).toBeVisible({ timeout: 45_000 });
    await search.locator('xpath=../..').locator('button:has(svg.lucide-plus)').first().click();

    const form = page.getByRole('dialog').filter({
      has: page.getByRole('heading', { name: 'Tạo hợp đồng mới' }),
    });
    await expect(form).toBeVisible();

    // Toà nhà + phòng
    await form.getByRole('combobox').first().click();
    await page.getByRole('option', { name: buildingName, exact: true }).click();
    await form.getByRole('combobox').nth(1).click();
    await page
      .getByRole('option', { name: new RegExp(`^${room.name}( ·.*)?$`) })
      .first()
      .click();

    // Khách hàng
    await form.getByRole('button', { name: 'Thêm khách hàng' }).click();
    const picker = page.getByRole('dialog').filter({
      has: page.getByRole('heading', { name: 'Chọn khách hàng' }),
    });
    await expect(picker).toBeVisible();
    await picker.getByPlaceholder('Tìm theo tên, SĐT, CCCD...').fill(customer.full_name);
    await picker.locator('label').filter({ hasText: customer.full_name }).first().click();
    await picker.getByRole('button', { name: /^Xác nhận/ }).click();
    await expect(picker).toBeHidden();

    // Ngày bắt đầu / hạn hợp đồng
    const today = iso(new Date());
    await form.locator('input[name="start_date"]').fill(ddmmyyyy(today));
    await form.locator('input[name="end_date"]').fill(ddmmyyyy(addDays(today, 365)));

    // Kỳ tính tiền tháng đầu PHẢI phủ hết tháng, nếu không `useContractSubmit`
    // chặn ngay trước khi gọi RPC ("chọn Đến ngày tối thiểu <cuối tháng>") và
    // modal hoa hồng không bao giờ mở. Bỏ trống hai ô này thì mặc định là
    // start..start = 1 ngày, tức luôn vi phạm.
    await form.locator('input[name="start_billing_date"]').fill(ddmmyyyy(today));
    await form.locator('input[name="end_billing_date"]').fill(ddmmyyyy(cuoiThang(today)));

    /*
     * MỘT DÒNG CỌC TIỀN MẶT — KHÔNG PHẢI ĐỂ CHO GIỐNG THẬT.
     *
     * Đây là thứ làm cho bài test có khả năng đỏ. `create_contract_v2` chỉ ghi
     * vào `income_expenses` khi có phiếu thu cọc, mà `income_expenses` đúng là
     * bảng mang khoá prefill bị khai nhầm. Đo thật 15/09/2026: bản đầu của bài
     * này để cọc 0 đ, nghe WebSocket thấy sự kiện của contracts/rooms/invoices
     * nhưng KHÔNG có income_expenses — nên nó xanh cả trên bản chưa vá.
     *
     * Cọc đóng đủ bằng tiền mặt ⇒ không thiếu cọc ⇒ nút Lưu không bị hàng rào
     * nợ cọc khoá. Sổ quỹ để trống ⇒ phiếu phi tiền mặt, không sinh bút toán,
     * dọn fixture gọn.
     */
    const tienThue = await form.locator('input[name="rent_price"]').inputValue();
    await form.getByRole('button', { name: 'Thêm lần cọc' }).click();
    // Bám vào chính khối chứa nút "Thêm lần cọc" (`.last()` = khối trong cùng).
    // Chọn `div.rounded-md.border.p-3` trên cả form sẽ trúng dòng xem trước hoá
    // đơn — đã dính một lần.
    const khoiCoc = form
      .locator('div.space-y-3:has(button:has-text("Thêm lần cọc"))')
      .last();
    await khoiCoc
      .locator('div.rounded-md.border.p-3')
      .first()
      .locator('input')
      .first()
      .fill(tienThue.replace(/\D/g, ''));

    // ── 3. Lưu → modal hoa hồng phải tự mở ───────────────────────────────────
    await form.getByRole('button', { name: 'Lưu', exact: true }).click();

    const modal = page.getByRole('dialog').filter({
      has: page.getByRole('heading', { name: 'Tạo phiếu chi hoa hồng' }),
    });
    await expect(modal).toBeVisible({ timeout: 60_000 });

    /*
     * GÕ NGAY LẬP TỨC — thứ tự ở đây là một phần của phép đo.
     *
     * Hub debounce 800 ms kể từ sự kiện cuối, mà sự kiện đến ngay lúc RPC commit
     * (tức ngay trước khi modal hiện). Bản trước của bài này tra cứu hợp đồng và
     * phiếu cọc qua REST TRƯỚC khi gõ; hai vòng mạng đó tốn hơn một giây, nên cơn
     * bão đã xả xong trước khi có chữ nào trong ô — và bài test xanh trên đúng
     * bản chưa vá mà nó phải bắt. Đo thật 15/09/2026 trên production.
     *
     * Việc sổ sách để sau, lúc đã gõ xong.
     */
    const oTenMG = modal.getByPlaceholder('Tên công ty / cá nhân môi giới');
    await expect(oTenMG).toBeVisible();
    await oTenMG.fill(TEN_MOI_GIOI);

    // `.first()` = khối mục 2 (Đơn vị môi giới); mục 3 (Thưởng Sale) có ô cùng
    // nhãn nên thứ tự DOM là thứ phân biệt duy nhất.
    const oSoTK = modal
      .locator('div.space-y-1:has(label:text-is("Số tài khoản"))')
      .locator('input')
      .first();
    await oSoTK.fill(SO_TAI_KHOAN);

    const oSoTien = modal
      .locator('div.space-y-1:has(label:has-text("Số tiền hoa hồng"))')
      .locator('input')
      .first();

    const created = (await sbGet(
      auth,
      `contracts?select=id&room_id=eq.${room.id}&status=eq.ACTIVE&deleted_at=is.null` +
        `&order=created_at.desc&limit=1`,
    )) as { id: string }[];
    contractId = created[0]?.id ?? null;
    expect(contractId, 'phải tìm được hợp đồng vừa tạo để dọn fixture').toBeTruthy();

    // Phiếu thu cọc do create_contract_v2 sinh ra. Không có nó thì cơn bão
    // realtime KHÔNG chạm `income_expenses` và bài test mất khả năng bắt bug —
    // nên đây là assert, không phải bước dọn dẹp.
    depositVoucherIds = (
      (await sbGet(auth, `income_expenses?select=id&contract_id=eq.${contractId}`)) as {
        id: string;
      }[]
    ).map((v) => v.id);
    expect(
      depositVoucherIds.length,
      'phải có phiếu thu cọc — không có thì bài test không còn chạm đường gây lỗi',
    ).toBeGreaterThan(0);

    const soTienTruoc = await oSoTien.inputValue();

    // ── 4. Chờ qua trần debounce của hub ─────────────────────────────────────
    await page.waitForTimeout(QUA_TRAN_DEBOUNCE_MS);

    /*
     * BẤT BIẾN CHÍNH, VÀ LÀ THỨ DUY NHẤT ĐO ĐƯỢC CHẮC CHẮN: prefill được gọi
     * ĐÚNG MỘT LẦN.
     *
     * Ba bản trước của bài này đo hậu quả (chữ trong ô) và đều xanh trên chính
     * bản chưa vá. Lý do, đo thật 15/09/2026:
     *   - Một lượt tải lại THÀNH CÔNG với dữ liệu y hệt không đổi identity
     *     (react-query có structuralSharing) nên effect seed không chạy lại.
     *   - Còn lượt tải lại HỎNG thì phải rơi đúng vào lúc người dùng đang gõ.
     *     Cơn bão realtime đến gần như cùng lúc modal mở: hai lần chạy liên
     *     tiếp cho 3 lượt và 0 lượt. Đó là tung đồng xu, không phải phép đo.
     *
     * Nên bài này chốt NGUYÊN NHÂN thay vì hậu quả: prefill là ảnh chụp hợp
     * đồng vừa tạo, không có lý do gì để nó được tải lại lần hai khi modal đang
     * mở. Đếm được, không phụ thuộc tốc độ máy. Hai lượt trở lên nghĩa là khoá
     * prefill đã quay lại descriptor realtime, và cánh cửa làm mất dữ liệu
     * người dùng mở lại — dù lần chạy này có mất chữ hay không.
     */
    expect(
      prefillRequests.length,
      `prefill phải được gọi đúng 1 lần; đếm được ${prefillRequests.length}. ` +
        'Nhiều hơn 1 = có gì đó đang đánh thức ["commission-prefill"] trong lúc ' +
        'người dùng điền form (xem src/hooks/realtime/finance.ts).',
    ).toBe(1);

    // ── 5. Hệ quả: không mất chữ, không quay về dòng chờ ─────────────────────
    await expect(
      modal.getByText('Đang tải thông tin hợp đồng...'),
      'một lượt tải lại hỏng KHÔNG được đẩy modal về dòng chờ — đó là cách nó kẹt ' +
        'vĩnh viễn ở bản cũ (lỗi bị nuốt thành data rỗng trong trạng thái thành công)',
    ).toBeHidden();
    await expect(oTenMG, 'tên đơn vị môi giới bị xoá = bug 15/09 tái phát').toHaveValue(
      TEN_MOI_GIOI,
    );
    await expect(oSoTK, 'số tài khoản bị xoá = bug 15/09 tái phát').toHaveValue(SO_TAI_KHOAN);
    expect(await oSoTien.inputValue(), 'số tiền hoa hồng không được tự nhảy').toBe(soTienTruoc);

    // Nút tạo phiếu phải bấm được (không kẹt vì prefill mất dữ liệu).
    await expect(modal.getByRole('button', { name: 'Tạo phiếu chi' })).toBeEnabled();

    // ── 6. Bỏ qua — bài này KHÔNG tạo phiếu hoa hồng ─────────────────────────
    await modal.getByRole('button', { name: 'Bỏ qua' }).click();
    await expect(modal).toBeHidden();

    expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
  } finally {
    // Phiếu "bắn realtime": huỷ qua đúng đường nghiệp vụ trước, SQL chỉ là lưới
    // an toàn nếu RPC không chạy được.
    if (auth && depositVoucherIds.length > 0) {
      await sbRpc(auth, 'ie_compat_cancel_v2', {
        p_ids: depositVoucherIds,
        p_reason: 'e2e contract-create-then-commission cleanup',
      }).catch(() => undefined);
    }
    const sql: string[] = [];
    if (contractId) {
      sql.push(`update public.invoices set deleted_at = now() where contract_id = '${contractId}';`);
      sql.push(
        `update public.contracts set deleted_at = now(), status = 'TERMINATED' where id = '${contractId}';`,
      );
    }
    for (const vid of depositVoucherIds) {
      // Phiếu canonical: cấp token lifecycle trong CÙNG transaction rồi xoá mềm
      // — đúng allowlist của guard, không tắt trigger nào.
      sql.push(
        `do $cleanup$ begin
           insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
           values ('${vid}', pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
           on conflict (income_expense_id) do update
             set xid = excluded.xid, purpose = excluded.purpose, granted_at = now();
           update public.income_expenses
              set approval_status = 'CANCELLED',
                  review_state = 'RESOLVED',
                  cancellation_kind = coalesce(cancellation_kind, 'COMPAT_BATCH_CANCEL'),
                  deleted_at = now()
            where id = '${vid}' and deleted_at is null;
         end $cleanup$;`,
      );
    }
    if (roomId && roomStatus0) {
      sql.push(`update public.rooms set status = '${roomStatus0}' where id = '${roomId}';`);
    }
    for (const stmt of sql) {
      try {
        await mgmtQuery(stmt);
      } catch (e) {
        console.error('[cleanup] bỏ qua lỗi:', (e as Error).message.slice(0, 300));
      }
    }
    await ctx.close();
  }
});
