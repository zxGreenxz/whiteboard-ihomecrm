/** Deterministic browser coverage of the production React page, hooks, service and request registry.
 * Only auth/background reads are replaced. Recognized finance RPCs are served in memory;
 * every other network write is blocked. Real TEST/database coverage lives in the sibling real spec. */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import loadTailwindConfig from "tailwindcss/loadConfig.js";
import { seed as demoSeed, balance as demoBalance } from "../../public/demos/personal-finance/model.js";
import type {
  Snapshot,
  Mutation,
} from "../../src/lib/personalFinance/contract";
const root = fileURLToPath(new URL("../..", import.meta.url));
const owner = "11111111-1111-4111-8111-111111111111";
const wallet = "22222222-2222-4222-8222-222222222222";
const category = "33333333-3333-4333-8333-333333333333";
const income = "44444444-4444-4444-8444-444444444444";
const saving = "55555555-5555-4555-8555-555555555555";
const companyOrg = "66666666-6666-4666-8666-666666666666";
const companyAccount = "77777777-7777-4777-8777-777777777777";
const companyWallet = "88888888-8888-4888-8888-888888888888";
let server: ViteDevServer, base: string;
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import Page from '@/pages/finance/PersonalWalletPage';import '@/index.css';createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}><Page/></MemoryRouter></QueryClientProvider>);`;
test.describe.configure({ mode: "default" });
test.use({ storageState: { cookies: [], origins: [] }, launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });
test.beforeAll(async () => {
  const virtual = new Map([
    ["virtual:pf-org", `export const useOrganization=()=>({selectedOrganizationId:'${companyOrg}',organization:{name:'Công ty DEMO'},preferenceError:null});`],
    ["virtual:pf-company-transport", `import {supabase} from '@/integrations/supabase/client';export const createCompanyWalletTransport=()=>({rpc:(name,args)=>supabase.rpc(name,args)});`],
    ["virtual:pf-company-perms", `export const useMyPermissions=()=>({data:{income_expenses:{view:true,create:!location.search.includes('readonly')},cashbooks:{create:false}},isLoading:false,error:null});`],
    ["virtual:pf-company-accounts", `export const useAccounts=()=>({data:[{id:'${companyAccount}',organization_id:'${companyOrg}',name:'Sổ ngân hàng DEMO',is_virtual:false}],isLoading:false,error:null});`],
    ["virtual:pf-company-custodians", `export const useCustodianCashbooksV2=()=>({data:[{id:'${companyAccount}',name:'Sổ ngân hàng DEMO'}],isLoading:false,error:null});`],
    [
      "virtual:pf-auth",
      `export const useAuth=()=>({data:{id:'${owner}'},isLoading:false});`,
    ],
    [
      "virtual:pf-session",
      `export const getSessionUser=async()=>({id:'${owner}'});`,
    ],
    [
      "virtual:pf-perms",
      `export const usePersonalFinancePermissions=()=>({data:{view:true,create:!location.search.includes('readonly')&&!location.search.includes('edit-only')&&!location.search.includes('delete-only'),edit:!location.search.includes('readonly')&&!location.search.includes('create-only')&&!location.search.includes('delete-only'),delete:!location.search.includes('readonly')&&!location.search.includes('create-only')&&!location.search.includes('edit-only')},isPending:false});`,
    ],
    [
      "virtual:pf-layout",
      "export default function Layout({children}){return children}",
    ],
    [
      "virtual:pf-shareholders",
      "export const useMyShareholder=()=>({data:null});",
    ],
    [
      "virtual:pf-profit",
      "export const useProfitAllocations=()=>({data:[]});export const useShareholderDistributions=()=>({data:[]});export const computeShareholderSummary=()=>({});",
    ],
    [
      "virtual:pf-client",
      `export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:'${owner}'}}},error:null})},rpc(name,args){const promise=fetch('/__rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args||{})}).then(r=>r.json());promise.setHeader=()=>promise;return promise;}};`,
    ],
    [
      "virtual:pf-refs",
      `import {usePersonalFinance} from '@/hooks/personal-finance/usePersonalFinance';export const rememberAccount=()=>{};export function useQuickEntryRefs(){const q=usePersonalFinance();return {orgId:'demo',loading:q.isLoading,canPersonal:!location.search.includes('readonly')&&!location.search.includes('edit-only')&&!location.search.includes('delete-only'),canCompany:location.search.includes('company'),permissionsLoading:false,permissionsError:null,personalLoading:q.isLoading,personalError:q.error,personalReady:!!q.data,companyLoading:false,companyError:null,companyReady:true,personalWallets:q.data?.wallets||[],personalCategories:q.data?.categories||[],buildings:[],rooms:[],categories:[],cashbooks:[],resolveRefs:{buildings:[],rooms:[],feeAccounts:[]},defaultAccountFor:()=>null};}`,
    ],
    [
      "virtual:pf-save",
      `const deny=()=>{throw Error('Unplanned fixture write')};export const useQuickEntrySave=()=>({savePersonal:deny,saveCompany:deny,uploadPhoto:deny});`,
    ],
    ["virtual:pf-slot", "export const useVoucherSlotWarning=()=>({data:[]});"],
    [
      "virtual:pf-ai",
      `export const QUICK_ENTRY_BASE='/__ai';export const makeCopilotFetch=()=>fetch;export const newTaskId=()=> 'fixture';`,
    ],
  ]);
  server = await createServer({
    configFile: false,
    root,
    cacheDir: path.join(root, ".e2e-fleet/test-results/personal-product-vite"),
    esbuild: { jsx: "automatic" },
    css: {
      postcss: {
        plugins: [
          tailwindcss({
            ...loadTailwindConfig(path.join(root, "tailwind.config.ts")),
            content: [
              path.join(root, "src/**/*.{ts,tsx}").replaceAll("\\", "/"),
            ],
          }),
          autoprefixer(),
        ],
      },
    },
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "react",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "react-dom",
        "react-dom/client",
        "react-router-dom",
        "@tanstack/react-query",
        "react-hook-form",
        "lucide-react",
        "zod",
        "@radix-ui/react-slot",
        "@radix-ui/react-dialog",
      ],
    },
    resolve: {
      alias: [
        { find: "@/lib/companyWallet/transport", replacement: "virtual:pf-company-transport" },
        { find: "@/hooks/useMyPermissions", replacement: "virtual:pf-company-perms" },
        { find: "@/hooks/useAccounts", replacement: "virtual:pf-company-accounts" },
        { find: "@/hooks/income-expenses/financeV2Mutations", replacement: "virtual:pf-company-custodians" },
        { find: "@/hooks/useAuth", replacement: "virtual:pf-auth" },
        { find: "@/contexts/OrganizationContext", replacement: "virtual:pf-org" },
        { find: "@/lib/authSession", replacement: "virtual:pf-session" },
        { find: "@/hooks/personal-finance/usePersonalFinancePermissions", replacement: "virtual:pf-perms" },
        {
          find: "@/components/layout/MainLayout",
          replacement: "virtual:pf-layout",
        },
        {
          find: "@/hooks/useShareholders",
          replacement: "virtual:pf-shareholders",
        },
        {
          find: "@/hooks/useShareholderProfit",
          replacement: "virtual:pf-profit",
        },
        {
          find: "@/integrations/supabase/client",
          replacement: "virtual:pf-client",
        },
        { find: /^(?:.*\/)useQuickEntryRefs$/, replacement: "virtual:pf-refs" },
        { find: /^(?:.*\/)useQuickEntrySave$/, replacement: "virtual:pf-save" },
        {
          find: "@/hooks/useVoucherSlotWarning",
          replacement: "virtual:pf-slot",
        },
        { find: "@/copilot/copilotConfig", replacement: "virtual:pf-ai" },
        { find: "@", replacement: path.join(root, "src") },
      ],
    },
    plugins: [
      {
        name: "personal-product-fixture",
        resolveId(id) {
          if (id === "/__personal.tsx" || virtual.has(id)) return "\0" + id;
        },
        async load(id) {
          if (id === "\0/__personal.tsx")
            return (
              await transformWithEsbuild(entry, "fixture.tsx", {
                loader: "tsx",
                jsx: "automatic",
              })
            ).code;
          return virtual.get(id.slice(1));
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/__personal.html")) return next();
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(
              await vite.transformIndexHtml(
                "/__personal.html",
                '<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__personal.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  base = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
});

test.describe("attachment voice", () => {
  test.use({ permissions: ["microphone"], viewport: { width: 390, height: 844 } });
  for (const entryPoint of ["home", "sheet"]) test(`paperclip ${entryPoint}: select photo, record automatically, send together`, async ({ page }, info) => {
    const o = await open(page);
    const aiRequests: string[] = [], audioRequests: string[] = [];
    await page.route("**/__ai/audio/transcriptions", route => {
      audioRequests.push(route.request().postData() || "");
      return route.fulfill({ json: { text: "cà phê 25k" } });
    });
    page.on("request", request => { if (request.url().endsWith("/__ai/chat/completions")) aiRequests.push(request.postData() || ""); });
    if (entryPoint === "sheet") await nav(page, "Ghi thu chi");
    const trigger = entryPoint === "sheet" ? page.getByRole("dialog", { name: "Ghi thu chi", exact: true }) : page.locator(".pf-launcher-actions");
    const picker = page.waitForEvent("filechooser");
    await trigger.getByRole("button", { name: "Ảnh kèm nội dung", exact: true }).click();
    await (await picker).setFiles({ name: "bill.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=", "base64") });
    const sheet = page.getByRole("dialog", { name: "Ghi thu chi", exact: true });
    await expect(sheet.getByText(/Đang nghe/)).toBeVisible();
    await expect(sheet.getByText(/0:01/)).toBeVisible();
    expect(aiRequests).toHaveLength(0);
    await page.screenshot({ path: info.outputPath(`attachment-${entryPoint}.png`) });
    await sheet.getByRole("button", { name: "Xong", exact: true }).click();
    await expect.poll(() => aiRequests.length).toBe(1);
    expect(audioRequests).toHaveLength(1);
    expect(JSON.parse(audioRequests[0]).data.length).toBeGreaterThan(0);
    expect(aiRequests[0]).toContain("cà phê 25k");
    expect(aiRequests[0]).toContain("data:image/");
    expect(o.writes).toHaveLength(0);
    expect(o.errors).toEqual([]);
    expect(o.blocked).toEqual([]);
  });

  for (const outcome of ["cancel", "denied"]) test(`paperclip ${outcome} keeps the photo without sending`, async ({ page }) => {
    if (outcome === "denied") await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    const o = await open(page), requests: string[] = [];
    page.on("request", request => { if (request.url().includes("/__ai/")) requests.push(request.url()); });
    await nav(page, "Ghi thu chi");
    const sheet = page.getByRole("dialog", { name: "Ghi thu chi", exact: true });
    await sheet.getByLabel("Nội dung khoản chi").fill("Nội dung giữ lại");
    await sheet.getByLabel("Chọn ảnh kèm nội dung").setInputFiles({ name: "bill.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=", "base64") });
    if (outcome === "cancel") {
      await expect(sheet.getByText(/Đang nghe/)).toBeVisible();
      await sheet.getByRole("button", { name: "Huỷ ghi âm" }).click();
    } else await expect(sheet.getByRole("status")).toContainText("Bạn chưa cho phép dùng micro");
    await expect(sheet.getByAltText("Ảnh chờ gửi")).toBeVisible();
    await expect(sheet.getByLabel("Nội dung khoản chi")).toHaveValue("Nội dung giữ lại");
    expect(requests).toEqual([]);
    expect(o.writes).toEqual([]);
    expect(o.errors).toEqual([]);
  });
});

for (const width of [320, 390]) test(`compact finance toolbar ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const o = await open(page);
  await nav(page, "Giao dịch");
  await expect(page.getByRole("button", { name: "Xuất CSV" })).toHaveCount(0);
  const transfer = await page.getByRole("button", { name: "Chuyển ví", exact: true }).boundingBox();
  const settings = page.getByRole("button", { name: "Cài đặt ví cá nhân", exact: true });
  const rect = await settings.boundingBox();
  expect(Math.abs(rect!.y - transfer!.y)).toBeLessThan(2);
  expect(rect!.x).toBeGreaterThan(transfer!.x + transfer!.width);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
  const toolbar = await page.locator(".pf-type-chips").boundingBox();
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(toolbar!.x + toolbar!.width);
  await page.screenshot({ path: info.outputPath(`toolbar-${width}.png`) });
  await settings.click();
  await expect(page.getByRole("button", { name: "Danh mục thu chi", exact: true })).toBeVisible();
  await close(page);
  await nav(page, "Ngân sách");
  await expect(page.getByText(/Hạn mức riêng cho từng danh mục|Các hạn mức lặp lại hằng tháng/)).toHaveCount(0);
  const cards = page.locator(".pf-stack > .pf-card");
  const first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox();
  expect(second!.y - first!.y - first!.height).toBeLessThanOrEqual(12);
  await page.screenshot({ path: info.outputPath(`budget-${width}.png`) });
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});

function fixture(): Snapshot {
  const date = new Date();
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-04`;
  return {
    owner_id: owner,
    schema_version: 1,
    wallets: [
      {
        id: wallet,
        user_id: owner,
        version: 1,
        name: "Tiền mặt",
        kind: "cash",
        icon: "👛",
        opening_balance: 1000000,
        balance: 950000,
        hidden: false,
        is_default: true,
      },
      {
        id: saving,
        user_id: owner,
        version: 1,
        name: "Tiết kiệm",
        kind: "saving",
        icon: "🌱",
        opening_balance: 0,
        balance: 0,
        hidden: true,
        is_default: false,
      },
    ],
    categories: [
      {
        id: category,
        user_id: owner,
        version: 1,
        type: "EXPENSE",
        name: "Ăn uống",
        icon: "🍜",
        color: "#146653",
        hidden: false,
        seed_key: "other",
        legacy_name: null,
      },
      {
        id: income,
        user_id: owner,
        version: 1,
        type: "INCOME",
        name: "Lương",
        icon: "💰",
        color: "#146653",
        hidden: false,
        seed_key: "other-income",
        legacy_name: null,
      },
    ],
    transactions: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        user_id: owner,
        version: 1,
        type: "EXPENSE",
        amount: 50000,
        txn_date: day,
        description: "Cà phê",
        category: "Ăn uống",
        wallet_id: wallet,
        category_id: category,
        resolved_wallet_id: wallet,
        resolved_category_id: category,
        created_at: date.toISOString(),
        updated_at: date.toISOString(),
        deleted_at: null,
      },
    ],
    transfers: [],
    budgets: [],
    goals: [],
  };
}
function approvedDesignFixture(): Snapshot {
  const demo = demoSeed();
  const ids = new Map<string, string>();
  const uuid = (id: string) => {
    if (!ids.has(id)) ids.set(id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
    return ids.get(id)!;
  };
  const row = (id: string) => ({ id: uuid(id), user_id: owner, version: 1 });
  return {
    owner_id: owner, schema_version: 1,
    wallets: demo.wallets.map(w => ({ ...row(w.id), name: w.name, kind: w.id === "bank" ? "bank" : w.id === "cash" ? "cash" : "saving", icon: w.emoji, opening_balance: w.opening, balance: demoBalance(demo, w.id), hidden: false, is_default: w.id === "bank" })),
    categories: demo.categories.map(c => ({ ...row(c.id), name: c.name, type: c.type.toUpperCase(), icon: c.emoji, color: c.color, hidden: false, seed_key: c.id, legacy_name: null })),
    transactions: demo.transactions.map((t, i) => ({ ...row(t.id), type: t.type.toUpperCase(), amount: t.amount, txn_date: t.date, description: t.note, category: demo.categories.find(c => c.id === t.category)!.name, wallet_id: uuid(t.wallet), resolved_wallet_id: uuid(t.wallet), category_id: uuid(t.category), resolved_category_id: uuid(t.category), created_at: new Date(Date.UTC(2026, 9, 4, 12, 0, 59 - i)).toISOString(), updated_at: "2026-10-04T12:00:00Z", deleted_at: null })),
    transfers: [],
    budgets: [{ ...row("monthly"), category_id: null, amount: demo.monthlyLimit, type: "EXPENSE" }, ...demo.budgets.map(b => ({ ...row(b.id), category_id: uuid(b.category), amount: b.amount, type: "EXPENSE" }))],
    goals: demo.goals.map(g => ({ ...row(g.id), name: g.name, icon: g.emoji, target: g.target, target_date: null, wallet_id: uuid("saving"), saved: g.saved })),
  } as Snapshot;
}
async function open(page: Page, mode = "") {
  const state = {
    company: {
      owner_id:owner, organization_id:companyOrg, schema_version:1,
      wallets:[{id:companyWallet,user_id:owner,organization_id:companyOrg,version:1,name:'Ví ngân hàng Công ty',kind:'bank',icon:'🏦',account_id:companyAccount,is_preferred:true,hidden:false,balance:1800000,balance_visible:true,can_use:true,account_name:'Sổ ngân hàng DEMO'}],
      transactions:[{id:'99999999-9999-4999-8999-999999999999',wallet_id:companyWallet,user_id:owner,organization_id:companyOrg,type:'EXPENSE',name:'Vật tư công ty DEMO',total_amount:200000,voucher_date:new Date().toISOString().slice(0,10),approval_status:'APPROVED',posting_status:'POSTED',review_state:null,attachments:[],created_at:new Date().toISOString(),deleted_at:null,code:'PC-DEMO'}],
    },
    snapshot: mode.includes("design") ? approvedDesignFixture() : fixture(),
    lose: false,
    conflict: false,
    readError: mode === "read-error",
    delay: mode === "slow",
  };
  const errors: string[] = [];
  const blocked: string[] = [];
  const writes: Array<{ p_request_key: string; p_payload: Mutation }> = [];
  const receipts = new Map();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== base) {
      if (mode.includes("design") && request.method() === "GET" && ["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) return route.continue();
      blocked.push(request.url());
      return route.abort();
    }
    if (url.pathname === "/__ai/chat/completions")
      return route.fulfill({
        json: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      desc: "cà phê",
                      amount_vnd: 25000,
                      category: "c1",
                      confidence: 1,
                    },
                  ],
                  total_vnd: 25000,
                  date: null,
                  vendor: null,
                  building_mention: null,
                  room_mention: null,
                  customer_code: null,
                  period_start: null,
                  period_end: null,
                }),
              },
            },
          ],
        },
      });
    if (url.pathname.startsWith("/__rpc/")) {
      const name = url.pathname.split("/").pop();
      if(name === 'company_wallet_snapshot') return route.fulfill({json:{data:state.company,error:null}});
      if (name === "personal_finance_bootstrap")
        return route.fulfill({ json: { data: {}, error: null } });
      if (name === "personal_finance_snapshot") {
        if (state.delay) await new Promise((r) => setTimeout(r, 500));
        return route.fulfill({
          json: state.readError
            ? { data: null, error: { code: "XX000", message: "fixture" } }
            : { data: state.snapshot, error: null },
        });
      }
      if (name === "personal_finance_mutate") {
        const body = request.postDataJSON();
        writes.push(body);
        const p = body.p_payload as Mutation;
        if (state.conflict) {
          state.conflict = false;
          return route.fulfill({
            json: {
              data: null,
              error: { code: "PT409", message: "personal_conflict" },
            },
          });
        }
        if (!receipts.has(body.p_request_key)) {
          const [entity, op] = p.action.split(".");
          const collections = {
            wallet: "wallets",
            category: "categories",
            transaction: "transactions",
            transfer: "transfers",
            goal: "goals",
            budget: "budgets",
          } as const;
          const key = collections[entity as keyof typeof collections];
          if (!key) throw Error("Unexpected action");
          const list = state.snapshot[key] as Array<Record<string, unknown>>;
          const old = list.find((r) => r.id === p.id);
          const id = p.id ?? crypto.randomUUID();
          const version = Number(old?.version ?? 0) + 1;
          const row = {
            user_id: owner,
            id,
            version,
            ...(entity === "wallet"
              ? {
                  kind: "cash",
                  icon: "👛",
                  opening_balance: 0,
                  hidden: false,
                  is_default: false,
                  balance: 0,
                }
              : entity === "category"
                ? {
                    icon: "🍜",
                    color: "#146653",
                    hidden: false,
                    seed_key: null,
                    legacy_name: null,
                  }
                : entity === "transaction"
                  ? {
                      category: null,
                      description: null,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                      deleted_at: null,
                    }
                  : entity === "transfer"
                    ? { note: null, goal_id: null, deleted_at: null }
                    : entity === "goal"
                      ? { icon: "🌱", target_date: null, saved: 0 }
                      : entity === "budget"
                        ? { type: "EXPENSE", category_id: null }
                        : {}),
            ...old,
            ...p.data,
          };
          row.version = version;
          if (op === "delete") {
            list.splice(list.indexOf(old!), 1);
            receipts.set(body.p_request_key, {
              owner_id: owner,
              request_key: body.p_request_key,
              action: p.action,
              entities: [{ id, user_id: owner, version, deleted: true }],
            });
          } else {
            if (entity === "transaction") {
              if (!("wallet_id" in row) || !("category_id" in row)) {
                throw new Error(
                  "Fixture transaction is missing wallet/category links",
                );
              }
              Object.assign(row, {
                resolved_wallet_id: row.wallet_id,
                resolved_category_id: row.category_id,
              });
            }
            if (old) list.splice(list.indexOf(old), 1, row);
            else list.push(row);
            receipts.set(body.p_request_key, {
              owner_id: owner,
              request_key: body.p_request_key,
              action: p.action,
              entities: [row],
            });
          }
        }
        if (state.lose) {
          state.lose = false;
          return route.fulfill({
            json: { data: { unconfirmed: true }, error: null },
          });
        }
        return route.fulfill({
          json: { data: receipts.get(body.p_request_key), error: null },
        });
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      blocked.push(request.url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`${base}/__personal.html${mode ? "?" + mode : ""}`);
  if (!state.readError && !state.delay)
    await expect(page.getByTestId("total-balance")).toContainText(mode.includes("design") ? "48.012.000" : "950.000");
  return { state, errors, blocked, writes };
}
async function nav(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Điều hướng ví cá nhân" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function close(page: Page) {
  for (let i = 0; i < 5 && (await page.getByRole("dialog").count()); i++) {
    const dialog = page.getByRole("dialog").last();
    const titleId = await dialog.getAttribute("aria-labelledby");
    await page
      .getByRole("button", { name: /^(Close|Đóng)$/ })
      .last()
      .click();
    await expect(page.locator(`[aria-labelledby="${titleId}"]`)).not.toBeVisible();
  }
}
async function manual(page: Page) {
  await nav(page, "Ghi thu chi");
  await page
    .getByRole("button", { name: "Nhập tay", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Ghi thu chi", exact: true });
}

async function manageCategories(page: Page) {
  await nav(page, "Giao dịch");
  await page.getByRole("button", { name: "Cài đặt ví cá nhân", exact: true }).click();
  await page.getByRole("button", { name: "Danh mục thu chi", exact: true }).click();
}
async function removeWallet(page: Page, name: string) {
  await page.getByRole("button", { name: `Sửa ví ${name}`, exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Xóa ví", exact: true }).click();
}
async function removeCategory(page: Page, name: string) {
  await page.getByRole("button", { name: `Sửa danh mục ${name}`, exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Xóa danh mục", exact: true }).click();
}

for (const width of [390, 1280]) test(`company wallets separate balances, ledger, reports and four payment kinds ${width}`,async({page},info)=>{
  await page.setViewportSize({width,height:844});
  const o=await open(page,'company');
  await page.getByRole('group',{name:'Nhóm ví',exact:true}).getByRole('button',{name:'Công ty',exact:true}).click();
  await expect(page.getByTestId('company-total-balance')).toContainText('1.800.000');
  await expect(page.getByTestId('company-month-totals')).toContainText('200.000');
  await page.screenshot({path:info.outputPath(`company-overview-${width}.png`),fullPage:true});
  await nav(page,'Giao dịch');
  await page.locator('.pf-type-chips').getByRole('button',{name:'Công ty',exact:true}).click();
  await expect(page.getByText('Vật tư công ty DEMO', {exact:true})).toBeVisible();
  await expect(page.getByLabel('Ví công ty',{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath(`company-ledger-${width}.png`),fullPage:true});
  await nav(page,'Báo cáo');
  await page.getByRole('group',{name:'Nhóm ví',exact:true}).getByRole('button',{name:'Công ty',exact:true}).click();
  await expect(page.getByTestId('company-month-totals')).toContainText('200.000');
  await page.getByRole('button',{name:'Cài đặt ví công ty',exact:true}).click();
  await page.getByRole('button',{name:'Sửa ví công ty Ví ngân hàng Công ty'}).click();
  await expect(page.getByLabel('Loại ví công ty')).toHaveText(/Ngân hàng.*Thẻ SP.*Thẻ tín dụng.*Tiền mặt/);
  await page.screenshot({path:info.outputPath(`company-settings-${width}.png`)});
  await close(page);
  await page.getByRole('group',{name:'Nhóm ví',exact:true}).getByRole('button',{name:'Cá nhân',exact:true}).click();
  await expect(page.getByTestId('company-finance')).toHaveCount(0);
  expect(o.errors).toEqual([]);expect(o.blocked).toEqual([]);expect(o.writes).toEqual([]);
});

test("filter sheets apply wallet/category and filtered totals; transfer is discoverable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const o = await open(page);
  o.state.snapshot.transactions.push({ ...o.state.snapshot.transactions[0], id: crypto.randomUUID(), type: "INCOME", amount: 75000, description: "Hoàn tiền", wallet_id: saving, resolved_wallet_id: saving, category_id: income, resolved_category_id: income });
  await page.reload();
  await nav(page, "Giao dịch");
  await page.getByRole("button", { name: "Chi tiêu", exact: true }).click();
  const totals = page.locator(".pf-card > .pf-between.pf-muted");
  await expect(totals).toContainText("Thu 0 ₫");
  await expect(totals).toContainText("Chi 50.000 ₫");
  await page.getByLabel("Tìm giao dịch").fill("50000");
  await expect(page.getByRole("button", { name: "Xem Cà phê", exact: true })).toBeVisible();
  await page.getByLabel("Tìm giao dịch").fill("");
  await page.getByRole("button", { name: "Tất cả", exact: true }).click();
  await page.getByRole("button", { name: "Lọc ví", exact: true }).click();
  await page.getByRole("dialog", { name: "Lọc theo ví", exact: true }).getByRole("button", { name: /Tiết kiệm/ }).click();
  await expect(page.getByRole("button", { name: "Xem Hoàn tiền", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Xem Cà phê", exact: true })).toHaveCount(0);
  await expect(totals).toContainText("Thu 75.000 ₫");
  await expect(totals).toContainText("Chi 0 ₫");
  await page.getByRole("button", { name: "Cài đặt ví cá nhân", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ví & tài khoản", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Danh mục thu chi", exact: true })).toBeVisible();
  await close(page);
  await page.getByRole("button", { name: "Chuyển tiền giữa ví", exact: true }).click();
  const transfer = page.getByRole("dialog", { name: "Chuyển tiền giữa ví", exact: true });
  await transfer.getByLabel("Ví chuyển", { exact: true }).selectOption(wallet);
  await transfer.getByLabel("Ví nhận", { exact: true }).selectOption(wallet);
  await transfer.getByLabel("Số tiền", { exact: true }).fill("50000");
  await transfer.getByRole("button", { name: "Chuyển tiền", exact: true }).click();
  await expect(transfer.getByRole("alert")).toBeVisible();
  expect(o.writes).toHaveLength(0);
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});

test("approved demo: recent transactions and real quick-entry sheet", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const o = await open(page, "company");
  await expect(page.getByText(/Ghi lại thật nhẹ nhàng|Ghi một câu, xong một khoản|Tháng này của bạn/)).toHaveCount(0);
  await expect(page.locator(".pf-launcher-actions button")).toHaveCount(4);
  const recent = page.locator("section").filter({ has: page.getByRole("heading", { name: "Giao dịch gần đây", exact: true }) });
  await expect(recent.getByText("Cà phê", { exact: true })).toBeVisible();
  await recent.getByRole("button", { name: /Xem tất cả/ }).click();
  await expect(page.getByLabel("Tìm giao dịch")).toBeVisible();
  await nav(page, "Ghi thu chi");
  const sheet = page.getByRole("dialog", { name: "Ghi thu chi", exact: true });
  await expect(sheet.getByRole("button", { name: "Ghi nhanh", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Nhập tay", exact: true })).toBeVisible();
  await expect(sheet.locator("textarea")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Gửi", exact: true })).toBeVisible();
  await expect(sheet.getByText(/DEMO|giọng nói mẫu|Chi hai khoản|Nhận lương|Thử hóa đơn/)).toHaveCount(0);
  const rect = await sheet.boundingBox();
  expect(rect!.x).toBe(0);
  expect(Math.abs(rect!.y + rect!.height - 844)).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath("approved-entry-sheet.png") });
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});

for (const width of [320, 390, 1280]) test(`approved demo design comparison ${width}`, async ({ page }, info) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width, height: 844 });
  await page.clock.setFixedTime(new Date("2026-10-04T12:00:00Z"));
  const o = await open(page, "design-company");
  await page.addStyleTag({ url: "https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;450;500;550;600;650;700;750;800&display=swap" });
  await page.evaluate(() => document.fonts.ready);
  for (const screen of ["Tổng quan", "Giao dịch", "Ngân sách", "Báo cáo"]) {
    await nav(page, screen);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`design-${width}-${screen}.png`), fullPage: true, animations: "disabled" });
  }
  await nav(page, "Giao dịch");
  for (const [trigger, title] of [["Lọc ví", "Lọc theo ví"], ["Lọc danh mục", "Lọc theo danh mục"]]) {
    await page.getByRole("button", { name: trigger, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toBeVisible();
    for (const option of await dialog.locator(".pf-filter-option").all()) {
      const rect = await option.boundingBox();
      expect(rect!.height, "Filter rows must not collapse names into vertical letters").toBeLessThanOrEqual(72);
    }
    await page.screenshot({ path: info.outputPath(`design-${width}-${trigger}.png`), animations: "disabled" });
    await close(page);
  }
  await nav(page, "Ghi thu chi");
  const entry = page.getByRole("dialog", { name: "Ghi thu chi", exact: true });
  await page.screenshot({ path: info.outputPath(`design-${width}-entry.png`), animations: "disabled" });
  await entry.getByRole("button", { name: "Nhập tay", exact: true }).click();
  await expect(entry.getByLabel("Số tiền", { exact: true })).toBeVisible();
  await expect(entry.getByRole("button", { name: "Cá nhân", exact: true })).toBeVisible();
  await expect(entry.getByRole("button", { name: "Công ty", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath(`design-${width}-manual.png`), animations: "disabled" });
  await close(page);
  await page.getByRole("button", { name: "Chuyển tiền giữa ví", exact: true }).click();
  await page.screenshot({ path: info.outputPath(`design-${width}-transfer.png`), animations: "disabled" });
  expect(o.writes).toHaveLength(0);
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});

for (const width of [320, 390, 430, 452, 768, 1280])
  test(`four screens and mobile geometry ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const o = await open(page, "company");
    await expect(page.getByTestId("month-expense")).toHaveText("50.000 ₫");
    await expect(page.getByTestId("month-expense")).toBeVisible();
    for (const screen of ["Tổng quan", "Giao dịch", "Ngân sách", "Báo cáo"]) {
      await nav(page, screen);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`${width}-${screen}.png`),
        fullPage: true,
      });
    }
    await nav(page, "Tổng quan");
    const group = page.getByRole("group", { name: "Ghi vào" });
    expect((await group.boundingBox())!.y).toBeGreaterThan(
      (await page.locator(".pf-prompt").boundingBox())!.y,
    );
    for (const button of await page.locator(".pf-launcher-actions button").all()) {
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    expect(o.errors).toEqual([]);
    expect(o.blocked).toEqual([]);
  });
test("manual validation, inline category keeps form, unknown exact replay and version conflict", async ({
  page,
}) => {
  const o = await open(page);
  let dialog = await manual(page);
  await dialog.getByLabel("Số tiền", { exact: true }).fill("12.5");
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(o.writes).toHaveLength(0);
  await dialog.getByLabel("Số tiền", { exact: true }).fill("12000");
  await dialog.getByLabel("Ghi chú").fill("Giữ nội dung");
  await dialog.getByRole("button", { name: "Chọn danh mục", exact: true }).click();
  await page.getByRole("button", { name: "Thêm danh mục", exact: true }).click();
  await page.getByLabel("Tên danh mục").fill("Mới");
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByLabel("Tên danh mục")).not.toBeVisible();
  await expect(dialog.getByLabel("Ghi chú")).toHaveValue("Giữ nội dung");
  await expect(dialog.getByRole("button", { name: "Chọn danh mục", exact: true })).toContainText("Mới");
  o.state.lose = true;
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(
    dialog.getByRole("button", { name: "Gửi lại y nguyên" }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Ghi chú")).toBeDisabled();
  await dialog.getByRole("button", { name: "Gửi lại y nguyên" }).click();
  await expect(dialog).toHaveCount(0);
  expect(o.writes.at(-1)).toEqual(o.writes.at(-2));
  await close(page);
  await nav(page, "Giao dịch");
  await page
    .getByRole("button", { name: "Xem Giữ nội dung", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Chi tiết giao dịch", exact: true });
  await dialog.getByLabel("Ghi chú").fill("Sau xung đột");
  o.state.conflict = true;
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("Dữ liệu đã thay đổi");
  await expect(dialog.getByLabel("Ghi chú")).toHaveValue("Sau xung đột");
  expect(o.writes.at(-1)?.p_payload.expected_version).toBe(1);
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});
test("management, hidden wallet choice, recurring budget, transfer, goal and reports", async ({
  page,
}) => {
  const o = await open(page);
  await page.getByRole("button", { name: "Quản lý ví", exact: true }).click();
  await page.getByRole("button", { name: "Sửa ví Tiền mặt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Xóa ví", exact: true })).toBeDisabled();
  await expect(page.getByText("Ví mặc định cần được giữ lại.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Xác nhận xóa" })).toHaveCount(
    0,
  );
  await close(page);
  let dialog = await manual(page);
  await dialog.getByLabel("Ví thanh toán", { exact: true }).selectOption(saving);
  await dialog.getByLabel("Số tiền", { exact: true }).fill("25000");
  await dialog.getByLabel("Ghi chú").fill("Ví ẩn vẫn dùng");
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(dialog).toHaveCount(0);
  await close(page);
  await nav(page, "Ngân sách");
  await page.getByRole("button", { name: "Thêm hạn mức" }).click();
  dialog = page.getByRole("dialog", { name: "Thêm hạn mức" });
  await dialog.getByLabel("Hạn mức mỗi tháng").fill("10000");
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(page.getByText(/^Vượt /).first()).toBeVisible();
  await page.getByRole("button", { name: "Mục tiêu tiết kiệm", exact: true }).click();
  await page.getByRole("button", { name: "Thêm mục tiêu" }).click();
  dialog = page.getByRole("dialog", { name: "Thêm mục tiêu" });
  await dialog.getByLabel("Tên mục tiêu").fill("Du lịch");
  await dialog.getByLabel("Số tiền mục tiêu").fill("500000");
  await dialog.getByLabel("Ví tích lũy").selectOption(saving);
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Góp tiền Du lịch" }).click();
  dialog = page.getByRole("dialog", { name: "Chuyển tiền giữa ví" });
  await dialog.getByLabel("Số tiền", { exact: true }).fill("100000");
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(o.writes.at(-1)?.p_payload.data?.goal_id).toBeTruthy();
  await nav(page, "Báo cáo");
  await page.locator(".pf-category-report").filter({ hasText: "Ăn uống" }).click();
  await expect(page.getByRole("button", { name: "Lọc danh mục", exact: true })).toContainText("Ăn uống");
  await expect(page.getByText("Cà phê", { exact: true })).toBeVisible();
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});
for (const mode of ["readonly", "create-only", "edit-only", "delete-only"])
  test(`action permissions ${mode}`, async ({ page }) => {
    const o = await open(page, mode);
    await nav(page, "Giao dịch");
    await expect(page.getByText("Cà phê", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Xem Cà phê" }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Xem Cà phê", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "Chi tiết giao dịch", exact: true });
    if (mode === "edit-only") await expect(detail.getByLabel("Ghi chú")).toBeEnabled();
    else await expect(detail.getByLabel("Ghi chú")).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Lưu thay đổi", exact: true })).toHaveCount(mode === "edit-only" ? 1 : 0);
    await expect(detail.getByRole("button", { name: "Xóa giao dịch", exact: true })).toHaveCount(mode === "delete-only" ? 1 : 0);
    await close(page);
    await expect(
      page.getByRole("button", { name: "Xóa giao dịch Cà phê" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Ghi thu chi", exact: true }),
    ).toHaveCount(mode === "create-only" ? 1 : 0);
    await nav(page, "Ngân sách");
    await expect(
      page.getByRole("button", { name: "Thêm hạn mức" }),
    ).toHaveCount(mode === "create-only" ? 1 : 0);
    expect(o.writes).toHaveLength(0);
    expect(o.errors).toEqual([]);
    expect(o.blocked).toEqual([]);
  });

test("draft survives closing sheet; hidden wallet is selectable in shared quick entry", async ({
  page,
}) => {
  const o = await open(page);
  await nav(page, "Ghi thu chi");
  await page.getByLabel("Nội dung khoản chi").fill("cà phê 25k");
  await page.getByRole("button", { name: "Gửi", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Ghi thu chi", exact: true });
  await expect(sheet.getByRole("button", { name: "Lưu vào ví" })).toBeVisible();
  await sheet.getByRole("combobox", { name: "Ví cá nhân" }).click();
  await page.getByRole("option", { name: "Tiết kiệm", exact: true }).click();
  await expect(
    sheet.getByRole("combobox", { name: "Ví cá nhân" }),
  ).toContainText("Tiết kiệm");
  await close(page);
  await nav(page, "Ghi thu chi");
  await expect(
    page.getByRole("combobox", { name: "Ví cá nhân" }),
  ).toContainText("Tiết kiệm");
  expect(o.writes).toHaveLength(0);
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});
test("pending receipt survives reload; readonly cannot replay a formerly authorized request", async ({
  page,
}) => {
  const o = await open(page);
  const dialog = await manual(page);
  await dialog.getByLabel("Số tiền", { exact: true }).fill("30000");
  o.state.lose = true;
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(
    dialog.getByRole("button", { name: "Gửi lại y nguyên" }),
  ).toBeVisible();
  const first = o.writes[0];
  await page.goto(`${base}/__personal.html?readonly`);
  await expect(
    page.getByText("Yêu cầu chưa xác nhận: giao dịch"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Gửi lại y nguyên" }),
  ).toHaveCount(0);
  await page.goto(`${base}/__personal.html`);
  await page.getByRole("button", { name: "Gửi lại y nguyên" }).click();
  await expect(page.getByText("Yêu cầu chưa xác nhận: giao dịch")).toHaveCount(
    0,
  );
  expect(o.writes).toHaveLength(2);
  expect(o.writes[1]).toEqual(first);
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});
test("snapshot error retry and empty month remain distinct", async ({
  page,
}) => {
  const o = await open(page, "read-error");
  await expect(page.getByRole("alert")).toContainText(
    "Không tải được ví cá nhân.",
  );
  await expect(page.getByTestId("total-balance")).toHaveCount(0);
  o.state.readError = false;
  await page.getByRole("button", { name: "Thử lại", exact: true }).click();
  await expect(page.getByTestId("total-balance")).toContainText("950.000");
  await nav(page, "Giao dịch");
  await page.getByLabel("Tháng", { exact: true }).fill("2020-01");
  await expect(page.getByText(/Chưa có giao dịch phù hợp/)).toBeVisible();
  await nav(page, "Báo cáo");
  await expect(page.getByText("Tháng này chưa có khoản chi.")).toBeVisible();
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});
test("legacy fractions and category labels are not resent through new-value validation", async ({
  page,
}) => {
  const o = await open(page);
  o.state.snapshot.transactions[0].amount = 12.125;
  o.state.snapshot.categories[0].name = "😀".repeat(50);
  o.state.snapshot.categories[0].hidden = true;
  await page.reload();
  await nav(page, "Giao dịch");
  await expect(page.getByText("−12,125 ₫", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Xem Cà phê", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "Chi tiết giao dịch", exact: true });
  await dialog.getByLabel("Ghi chú").fill("Ghi chú mới");
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(o.writes.at(-1)?.p_payload.data).toEqual({
    description: "Ghi chú mới",
  });
  await manageCategories(page);
  await page
    .getByRole("button", {
      name: `Sửa danh mục ${"😀".repeat(50)}`,
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", { name: "Sửa danh mục", exact: true });
  await dialog.getByRole("button", { name: "Biểu tượng ☕", exact: true }).click();
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(o.writes.at(-1)?.p_payload.data).toEqual({ icon: "☕" });
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});

test("wallet/category/budget/normal transfer management CRUD preserves linked selections", async ({
  page,
}) => {
  const o = await open(page);
  await page.getByRole("button", { name: "Quản lý ví", exact: true }).click();
  await page.getByRole("button", { name: "Thêm ví", exact: true }).click();
  let d = page.getByRole("dialog", { name: "Thêm ví", exact: true });
  await d.getByLabel("Tên ví").fill("Ví phụ");
  await d.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(d).toHaveCount(0);
  await page
    .getByRole("button", { name: "Sửa ví Ví phụ", exact: true })
    .click();
  d = page.getByRole("dialog", { name: "Sửa ví", exact: true });
  await d.getByLabel("Tên ví").fill("Ví đổi tên");
  await d.getByLabel("Ẩn khỏi tổng quan").check();
  await d.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(d).toHaveCount(0);
  await removeWallet(page, "Ví đổi tên");
  d = page.getByRole("dialog", { name: "Xóa ví", exact: true });
  await d.getByRole("button", { name: "Xác nhận xóa" }).click();
  await expect(d).toHaveCount(0);
  await close(page);
  await nav(page, "Ngân sách");
  await page.getByRole("button", { name: "Thêm hạn mức" }).click();
  d = page.getByRole("dialog", { name: "Thêm hạn mức", exact: true });
  await d.getByLabel("Hạn mức mỗi tháng").fill("80000");
  await d.getByRole("button", { name: "Chọn danh mục", exact: true }).click();
  await page.getByRole("button", { name: "Thêm danh mục", exact: true }).click();
  await page.getByLabel("Tên danh mục").fill("Giải trí");
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByLabel("Tên danh mục")).not.toBeVisible();
  await expect(d.getByLabel("Hạn mức mỗi tháng")).toHaveValue("80000");
  await expect(d.getByRole("button", { name: "Chọn danh mục", exact: true })).toContainText("Giải trí");
  await d.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(d).toHaveCount(0);
  await page.getByRole("button", { name: /^Sửa hạn mức/ }).click();
  d = page.getByRole("dialog", { name: /^Sửa hạn mức/ });
  await d.getByLabel("Hạn mức mỗi tháng").fill("90000");
  await d.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(d).toHaveCount(0);
  await page.getByRole("button", { name: /^Sửa hạn mức/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Xóa hạn mức", exact: true }).click();
  d = page.getByRole("dialog", { name: "Xóa hạn mức", exact: true });
  await d.getByRole("button", { name: "Xác nhận xóa" }).click();
  await expect(d).toHaveCount(0);
  await nav(page, "Giao dịch");
  await manageCategories(page);
  await page
    .getByRole("button", { name: "Sửa danh mục Giải trí", exact: true })
    .click();
  d = page.getByRole("dialog", { name: "Sửa danh mục", exact: true });
  await d.getByLabel("Tên danh mục").fill("Giải trí mới");
  await d.getByLabel("Ẩn khỏi lựa chọn mới").check();
  await d.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(d).toHaveCount(0);
  await removeCategory(page, "Giải trí mới");
  d = page.getByRole("dialog", { name: "Xóa danh mục", exact: true });
  await d.getByRole("button", { name: "Xác nhận xóa" }).click();
  await expect(d).toHaveCount(0);
  await close(page);
  await nav(page, "Giao dịch");
  await page.getByRole("button", { name: "Chuyển tiền giữa ví", exact: true }).click();
  d = page.getByRole("dialog", { name: "Chuyển tiền giữa ví", exact: true });
  await d.getByLabel("Số tiền", { exact: true }).fill("30000");
  await d.getByLabel("Ghi chú").fill("Chuyển thử");
  await d.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(d).toHaveCount(0);
  await close(page);
  await page
    .getByRole("button", { name: "Xem Chuyển thử", exact: true })
    .click();
  d = page.getByRole("dialog", { name: "Chi tiết giao dịch", exact: true });
  await d.getByLabel("Số tiền", { exact: true }).fill("40000");
  await d.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(d).toHaveCount(0);
  await page.getByRole("button", { name: "Xem Chuyển thử", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Xóa chuyển ví", exact: true }).click();
  d = page.getByRole("dialog", { name: "Xóa chuyển ví", exact: true });
  await d.getByRole("button", { name: "Xác nhận xóa" }).click();
  await expect(d).toHaveCount(0);
  expect(new Set(o.writes.map((w) => w.p_payload.action))).toEqual(
    new Set([
      "wallet.create",
      "wallet.update",
      "wallet.delete",
      "category.create",
      "category.update",
      "category.delete",
      "budget.create",
      "budget.update",
      "budget.delete",
      "transfer.create",
      "transfer.update",
      "transfer.delete",
    ]),
  );
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});
test("loading shows no invented balance", async ({ page }) => {
  const o = await open(page, "slow");
  await expect(page.getByText("Đang tải ví cá nhân…")).toBeVisible();
  await expect(page.getByTestId("total-balance")).toHaveCount(0);
  await expect(page.getByTestId("total-balance")).toContainText("950.000");
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});

test("stale snapshot after confirmed mutation stays visible with explicit retry", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const o = await open(page);
  const dialog = await manual(page);
  await dialog.getByLabel("Số tiền", { exact: true }).fill("25000");
  await dialog.getByLabel("Ghi chú").fill("Khoản đã xác nhận");
  o.state.readError = true;
  await dialog.getByRole("button", { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(dialog).toHaveCount(0);
  await close(page);
  await expect(page.getByTestId("total-balance")).toContainText("950.000");
  await expect(
    page.getByRole("alert").filter({ hasText: "Chưa cập nhật được ví" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("stale-snapshot-320.png"),
    fullPage: true,
  });
  expect(o.writes).toHaveLength(1);
  o.state.snapshot.wallets[0].balance = 925000;
  o.state.readError = false;
  await page.getByRole("button", { name: "Tải lại", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("total-balance")).toContainText("925.000");
  await expect(page.getByTestId("month-expense")).toContainText("75.000");
  await nav(page, "Giao dịch");
  await expect(
    page.getByText("Khoản đã xác nhận", { exact: true }),
  ).toBeVisible();
  expect(o.writes).toHaveLength(1);
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});
test("report drilldown distinguishes ID, each legacy label and unclassified buckets", async ({
  page,
}) => {
  const o = await open(page);
  const original = o.state.snapshot.transactions[0];
  for (const [label, description] of [
    ["Nhóm cũ A", "Khoản legacy A"],
    ["Nhóm cũ B", "Khoản legacy B"],
    [null, "Khoản chưa phân loại"],
  ] as const) {
    o.state.snapshot.transactions.push({
      ...original,
      id: crypto.randomUUID(),
      category_id: null,
      resolved_category_id: null,
      category: label,
      description,
    });
  }
  await page.reload();
  await expect(page.getByTestId("total-balance")).toBeVisible();
  for (const [label, description] of [
    ["Ăn uống", "Cà phê"],
    ["Nhóm cũ A", "Khoản legacy A"],
    ["Nhóm cũ B", "Khoản legacy B"],
    ["Chưa phân loại", "Khoản chưa phân loại"],
  ]) {
    await nav(page, "Báo cáo");
    await page.locator(".pf-category-report").filter({ hasText: label }).click();
    await expect(page.getByText("1 giao dịch", { exact: true })).toBeVisible();
    await expect(page.getByText(description, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Lọc danh mục", exact: true })).toContainText(label);
    const selectedCategory = await page.getByRole("button", { name: "Lọc danh mục", exact: true }).textContent();
    await page
      .getByRole("button", { name: "Tháng trước", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Lọc danh mục", exact: true })).toHaveText(selectedCategory!);
    await expect(page.getByText("0 giao dịch", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Tháng sau", exact: true }).click();
    await expect(page.getByText("1 giao dịch", { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Lọc danh mục", exact: true }).click();
  await page.getByRole("dialog", { name: "Lọc theo danh mục", exact: true }).getByRole("button", { name: /Mọi danh mục|Tất cả danh mục/ }).click();
  await expect(page.getByText("4 giao dịch", { exact: true })).toBeVisible();
  expect(o.errors).toEqual([]);
  expect(o.blocked).toEqual([]);
});
