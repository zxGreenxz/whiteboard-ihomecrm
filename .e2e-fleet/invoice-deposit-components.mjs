/**
 * Headless component fixtures only: actual invoice component and CSS, no API
 * or accounting writes. This is not a substitute for DEMO RPC/end-to-end checks.
 * node .e2e-fleet/invoice-deposit-components.mjs [--root <checkout>] [--output <dir>]
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const root = path.resolve(option('--root', process.cwd()));
const output = path.resolve(option('--output', path.join(root, '.tmp-invoice-deposit-components')));
await mkdir(output, { recursive: true });
const entry = '\0invoice-deposit-fixture.tsx';
const backend = '\0invoice-deposit-backend';
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import EditInvoiceDialog from '@/components/invoices/EditInvoiceDialog';
import '@/index.css';
const invoice = {
 id:'dddd0000-0000-4000-8000-000000000101', invoice_number:'DEMO-DEPOSIT-FIXTURE',
 building_id:'dddd0000-0000-4000-8000-000000000102', room_id:null,
 contract_id:'dddd0000-0000-4000-8000-000000000103', status:'APPROVED', paid_amount:0,
 billing_month:'2026-09', issue_date:'2026-09-01', due_date:'2026-09-05',
 notes:'Ghi chú cũ', previous_debt:0, previous_debt_sources:[], discount_amount:0,
 invoice_items:[
  {id:'rent',type:'RENT',accounting_class:'REVENUE',description:'Tiền thuê',unit_price:5290000,quantity:1,amount:5290000},
  {id:'deposit',type:'OTHER',accounting_class:'DEPOSIT',description:'Tiền cọc',unit_price:2200000,quantity:1,amount:2200000},
 ]
};
createRoot(document.getElementById('root')).render(<EditInvoiceDialog open onOpenChange={()=>{}} invoice={invoice} />);
`;
const server = await createServer({
  configFile: false, root, cacheDir: path.join(output, '.vite'),
  optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', '@radix-ui/react-dialog', '@radix-ui/react-select', 'react-hook-form', '@hookform/resolvers/zod', 'zod', 'lucide-react', 'sonner'] },
  resolve: { alias: [
    { find: '@/hooks/useInvoices', replacement: 'virtual:invoice-deposit-hooks' },
    { find: '@/hooks/useBuildingServices', replacement: 'virtual:invoice-deposit-services' },
    { find: '@/integrations/supabase/client', replacement: 'virtual:invoice-deposit-backend' },
    { find: '@', replacement: path.join(root, 'src') },
  ] },
  plugins: [{
    name: 'invoice-deposit-components-fixture',
    resolveId(id) {
      if (id === 'virtual:invoice-deposit-hooks' || id === 'virtual:invoice-deposit-services') return '\0' + id;
      if (id === '/__deposit_fixture.tsx') return entry;
      if (id === 'virtual:invoice-deposit-backend') return backend;
    },
    async load(id) {
      if (id === '\0virtual:invoice-deposit-hooks') return `export const useUpdateInvoice=()=>({isPending:false,mutate:payload=>{window.__submitted=payload}});export const useExcessAmount=()=>({data:0});`;
      if (id === '\0virtual:invoice-deposit-services') return `const data=[];export const useBuildingServices=()=>({data});`;
      if (id === entry) return (await transformWithEsbuild(fixture, 'invoice-deposit-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code;
      if (id === backend) return "export const supabase = new Proxy({}, {get(){throw new Error('Backend access forbidden in component fixture')}});";
    },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__deposit_fixture.html')) return next();
        const html = '<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__deposit_fixture.tsx"></script></body></html>';
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__deposit_fixture.html', html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, strictPort: true },
});
await server.listen();
const address = server.httpServer.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const evidence = [];
const checks = [];
try {
  for (const viewport of [{width:375,height:812}, {width:1280,height:900}]) {
    const page = await browser.newPage({ viewport, locale: 'vi-VN' });
    const errors = [];
    page.on('console', message => { if(message.type()==='error') errors.push(message.text()); });
    const externalRequests = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Fixture page error:', error.message); });
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) {
        externalRequests.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    const save = async () => {
      await page.getByRole('button', {name:'Cập nhật', exact:true}).click();
      await page.waitForFunction(() => !!window.__submitted);
      return page.evaluate(() => window.__submitted.formData);
    };
    const screenshot = async name => {
      const filename = path.join(output, `${name}-${viewport.width}.png`);
      await page.screenshot({path:filename, animations:'disabled'});
      const dimensions = await page.locator('[role=dialog]').evaluate(element => {
        const r=element.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth};
      });
      const overflow = dimensions.scrollWidth > dimensions.clientWidth || dimensions.x < 0 || dimensions.width > viewport.width;
      evidence.push({name,viewport,screenshot:filename,dimensions,overflow});
      console.log(JSON.stringify({name,viewport,dimensions,overflow}));
      assert.equal(overflow,false,'dialog has no horizontal overflow');
    };
    await page.goto(`${base}/__deposit_fixture.html`, {waitUntil:'networkidle'});
    await page.getByLabel('Ghi chú', {exact:true}).fill('Chỉ sửa ghi chú');
    const first=await save();
    assert.equal(first.notes,'Chỉ sửa ghi chú');
    assert.deepEqual(first.items.find(item=>item.description==='Tiền cọc'), {
      service_id:null,type:'OTHER',accounting_class:'DEPOSIT',description:'Tiền cọc',
      unit_price:2200000,quantity:1,coefficient:1,sort_order:1,
    });
    await screenshot('notes-only');
    await page.evaluate(()=>{window.__submitted=null});
    await page.getByRole('button',{name:'Xóa khoản thu'}).click();
    await page.getByRole('button',{name:'Thêm',exact:true}).click();
    await page.getByRole('combobox').click();
    await page.getByRole('option',{name:'Tiền cọc',exact:true}).waitFor();
    await screenshot('deposit-selector');
    await page.getByRole('option',{name:'Tiền cọc',exact:true}).click();
    const row=page.locator('tr').filter({has:page.getByRole('combobox')});
    await row.locator('input').nth(2).fill('2300000');
    const second=await save();
    const deposit=second.items.find(item=>item.description==='Tiền cọc');
    assert.equal(deposit.type,'OTHER');assert.equal(deposit.accounting_class,'DEPOSIT');assert.equal(deposit.unit_price,2300000);
    await screenshot('readded-deposit');
    assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
    checks.push({viewport,notesOnly:'PASS',actualRadixSelect:'PASS',deleteReadd:'PASS',amountEdit:'PASS',writes:0,errors,externalRequests});
    console.log(JSON.stringify(checks.at(-1)));
    await page.close();
  }
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify({fixtureOnly:true,root,checks,evidence}, null, 2));
} finally {
  await browser.close();
  await server.close();
}
