import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
// Execute the external selector through the actual index.html head. Omitting
// its script tag must fail just like removing the executable implementation.
async function boot(route: string) {
  class LocalScripts extends ResourceLoader {
    fetch(url: string) {
      if (new URL(url).pathname === '/pwa-manifest.js') {
        return Promise.resolve(Buffer.from(readFileSync(path.join(root, 'public/pwa-manifest.js')))) as ReturnType<ResourceLoader['fetch']>;
      }
      return null;
    }
  }
  const errors: unknown[] = [];
  const virtualConsole = new VirtualConsole().on('jsdomError', error => errors.push(error));
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://crm.example' + route, runScripts: 'dangerously', resources: new LocalScripts(), virtualConsole });
  await new Promise(resolve => dom.window.addEventListener('load', resolve));
  expect(errors).toEqual([]);
  return dom;
}

function manifest(dom: JSDOM) {
  return dom.window.document.querySelector('link[rel="manifest"]')?.getAttribute('href');
}

describe('pinned personal wallet manifest', () => {
  it.each(['/finance/personal-wallet', '/finance/personal-wallet/?month=2026-10#transactions', '/login?next=%2Ffinance%2Fpersonal-wallet%3Fmonth%3D2026-10%23transactions', '/login?next=%2Ffinance%2Fpersonal-wallet%3Fdiscount%3D10%2525%23summary'])('selects personal install identity on cold boot: %s', async (route) => {
    const dom = await boot(route);
    try {
      expect(manifest(dom)).toBe('/personal-wallet.webmanifest');
      expect(dom.window.document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content')).toBe('Ví cá nhân');
      const file = JSON.parse(readFileSync(path.join(root, 'public', manifest(dom)!), 'utf8'));
      const global = JSON.parse(readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'));
      expect(file.id).toBe('/finance/personal-wallet');
      expect(file.id).not.toBe(global.id);
      expect(file.start_url).toBe('/finance/personal-wallet');
      expect(file.scope).toBe('/');
      for (const icon of file.icons) expect(existsSync(path.join(root, 'public', new URL(icon.src, 'https://crm.example').pathname))).toBe(true);
      expect(file.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    } finally { dom.window.close(); }
  });

  it.each(['/', '/invoices', '/login', '/finance/personal-wallet-other', '/finance/personal-wallet/other', '/login?next=https%3A%2F%2Fevil.example%2Ffinance%2Fpersonal-wallet', '/login?next=%2F%2Fevil.example%2Ffinance%2Fpersonal-wallet', '/login?next=%2Ffinance%252Fpersonal-wallet'])('keeps the CRM identity for unrelated or unsafe entries: %s', async route => {
    const dom = await boot(route);
    try { expect(manifest(dom)).toBe('/manifest.webmanifest'); } finally { dom.window.close(); }
  });

  it('switches both ways after committed SPA navigation and preserves personal identity at login', async () => {
    const dom = await boot('/');
    try {
      for (const [route, expected] of [
        ['/finance/personal-wallet', '/personal-wallet.webmanifest'],
        ['/login?next=%2Ffinance%2Fpersonal-wallet', '/personal-wallet.webmanifest'],
        ['/invoices', '/manifest.webmanifest'],
      ]) {
        dom.window.history.replaceState(null, '', route);
        dom.window.dispatchEvent(new dom.window.Event('pwa-route-change'));
        expect(manifest(dom)).toBe(expected);
      }
      expect(dom.window.document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content')).toBe('CRM');
    } finally { dom.window.close(); }
  });
});
