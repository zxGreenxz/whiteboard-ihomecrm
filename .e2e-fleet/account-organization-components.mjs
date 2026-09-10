// Actual account pages, organization provider and CSS with local I/O fixtures.
// No live account or database writes. Run: node .e2e-fleet/account-organization-components.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright';

const root = process.cwd();
const output = path.join(root, '.tmp-account-organization');
await mkdir(output, { recursive: true });
const storageKey = 'ihomecrm.selectedOrganizationId';
const companyA = 'dddd0000-0000-4000-8000-000000000001';
const companyB = 'dddd0000-0000-4000-8000-000000000002';
const modules = {
  '@/hooks/useAuth': `export const useAuth = () => ({data:{id:'demo-user'},isLoading:false,isError:false}); export const useLogout = () => ({mutate(){},isPending:false});`,
  '@/hooks/useProfile': `export const useProfile = () => ({data:{full_name:'Người dùng thử',email:'demo@example.test'},isLoading:false}); export const useUpdateProfile = () => ({mutate(){},isPending:false}); export const useUploadAvatar = useUpdateProfile; export const useChangePassword = useUpdateProfile;`,
  '@/hooks/useMyPermissions': `export const useMyPermissions = () => ({data:{}});`,
  '@/hooks/useClipboardImagePaste': `export const useClipboardImagePaste = () => ({});`,
  '@/lib/push': `export const isPushSupported = () => false; export const isSubscribed = async () => false; export const enablePush = async () => 'default'; export const disablePush = async () => {};`,
  '@/components/layout/MainLayout': `export default function Layout({children}) { return <main className="p-6">{children}</main>; }`,
  '@/components/notifications/NotificationPreferencesCard': `export default function Component() { return null; }`,
  '@/components/notifications/PushNotificationSettings': `export default function Component() { return null; }`,
  '@/integrations/supabase/client': `export const supabase = {rpc:async name => {
    if(name !== 'list_my_copilot_organizations_v1') throw new Error('Unexpected RPC: '+name);
    return {data:{organizations:[{id:'${companyA}',name:'Công ty DEMO A'},{id:'${companyB}',name:'Công ty DEMO B'}]},error:null};
  }};`,
};
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { OrganizationProvider, useOrganization } from '@/contexts/OrganizationContext';
import ProfilePage from '@/pages/account/ProfilePage';
import '@/index.css';
function Scope() { const {selectedOrganizationId} = useOrganization(); return <output data-testid="scope" hidden>{selectedOrganizationId}</output>; }
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
    <MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}><OrganizationProvider><ProfilePage/><Scope/></OrganizationProvider></MemoryRouter>
  </QueryClientProvider>
);`;
const server = await createServer({
  root, configFile: false, cacheDir: path.join(output, '.vite'),
  optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-router-dom', '@tanstack/react-query', 'lucide-react', 'sonner', '@radix-ui/react-select', '@radix-ui/react-label', '@radix-ui/react-slot', '@radix-ui/react-avatar', '@radix-ui/react-separator'] },
  resolve: { alias: [
    ...Object.keys(modules).map((name, index) => ({ find: name, replacement: `virtual:account-mock-${index}` })),
    { find: '@', replacement: path.join(root, 'src') },
  ] },
  plugins: [{
    name: 'account-organization-fixture',
    resolveId(id) {
      if (id === '/__account_fixture.tsx') return '\0account-fixture';
      if (id.startsWith('virtual:account-mock-')) return `\0${id}`;
    },
    async load(id) {
      const text = id === '\0account-fixture' ? fixture : id.startsWith('\0virtual:account-mock-') ? Object.values(modules)[Number(id.split('-').at(-1))] : undefined;
      if (text) return (await transformWithEsbuild(text, 'account-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code;
    },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__account_fixture.html')) return next();
        const html = '<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__account_fixture.tsx"></script></body></html>';
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__account_fixture.html', html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, strictPort: true },
});
let browser;
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__account_fixture.html`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  for (const viewport of [{width:1440,height:1000}, {width:390,height:844}, {width:360,height:800}]) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.goto(url, { waitUntil: 'commit', timeout: 60_000 });
    const dropdown = page.getByRole('combobox', {name:'Công ty đang chọn'});
    await dropdown.waitFor({state:'visible'});
    assert.equal(await dropdown.isEnabled(), true);
    if (viewport.width < 768) await dropdown.selectOption(companyB);
    else {
      await dropdown.click();
      await page.getByRole('option', {name:'Công ty DEMO B',exact:true}).click();
    }
    await page.waitForFunction(id => document.querySelector('[data-testid="scope"]').textContent === id, companyB);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), companyB);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(id => document.querySelector('[data-testid="scope"]')?.textContent === id, companyB);
    if (viewport.width < 768) assert.equal(await dropdown.inputValue(), companyB);
    else assert.match(await dropdown.textContent(), /Công ty DEMO B/);
    const box = await dropdown.boundingBox();
    assert.ok(box && box.width > 150 && box.x >= 0 && box.x + box.width <= viewport.width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path:path.join(output, `account-${viewport.width}.png`),fullPage:false,animations:'disabled'});
    if (viewport.width < 768) await dropdown.selectOption(companyA);
    else {
      await dropdown.click();
      await page.getByRole('option', {name:'Công ty DEMO A',exact:true}).click();
    }
    await page.waitForFunction(id => document.querySelector('[data-testid="scope"]').textContent === id, companyA);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), companyA);
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}px: choose, reload, change, scope, viewport, no page errors`);
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
