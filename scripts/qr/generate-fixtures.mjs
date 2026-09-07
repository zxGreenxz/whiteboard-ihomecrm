import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { chromium } from 'playwright';

const root = process.cwd();
const manifest = JSON.parse(await fs.readFile(path.join(root, 'test/fixtures/qr/manifest.json'), 'utf8'));
const output = path.resolve(process.argv[2] || path.join(root, 'test/fixtures/qr/generated'));
await fs.mkdir(output, { recursive: true });

const escapeXml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const compressed = [];
for (const item of manifest.cases) {
  let body;
  if (!item.payload) {
    body = '<rect width="100%" height="100%" fill="#eee"/><text x="40" y="100" font-size="34">SYNTHETIC CARD — NO QR</text>';
  } else {
    const qr = await QRCode.toString(item.payload, { type: 'svg', errorCorrectionLevel: item.ecc, margin: 4 });
    const inner = qr.replace(/^.*?<svg[^>]*>|<\/svg>\s*$/gs, '');
    const qrViewBox = qr.match(/viewBox="([^"]+)"/)?.[1];
    if (!qrViewBox) throw new Error(`Missing QR viewBox for ${item.caseId}`);
    const card = item.sourceGroup === 'whole-card';
    const width = card ? 1600 : 520;
    const height = card ? 1000 : 520;
    const size = card ? 310 : 480;
    const x = card ? 25 : 20;
    const y = card ? 25 : 20;
    const transform = item.variant === 'rotated' ? `rotate(7 ${width / 2} ${height / 2})` : '';
    const filter = item.variant === 'blurred' ? 'filter="url(#blur)"' : item.variant === 'cornerCompressed' ? 'filter="url(#soft)"' : '';
    const opacity = item.variant === 'lowContrast' ? 'opacity="0.38"' : '';
    body = `<defs><filter id="blur"><feGaussianBlur stdDeviation="0.45"/></filter><filter id="soft"><feGaussianBlur stdDeviation="0.22"/></filter></defs><rect width="100%" height="100%" fill="#f5f1e8"/><text x="520" y="180" font-size="32">SYNTHETIC TEST CARD</text><g transform="${transform}"><svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${qrViewBox}" ${filter} ${opacity}>${inner}</svg></g><text x="520" y="240" font-size="20">${escapeXml(item.caseId)}</text>`;
    const svgPath = path.join(output, `${item.caseId}.svg`);
    await fs.writeFile(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`);
    if (item.variant === 'cornerCompressed') compressed.push({ item, svgPath, width, height });
    continue;
  }
  await fs.writeFile(path.join(output, `${item.caseId}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">${body}</svg>`);
}
if (compressed.length) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const { item, svgPath, width, height } of compressed) {
      await page.setViewportSize({ width, height });
      await page.goto(`file:///${svgPath.replace(/\\/g, '/')}`);
      await page.screenshot({ path: path.join(output, `${item.caseId}.jpg`), type: 'jpeg', quality: 42 });
      await fs.rm(svgPath);
    }
  } finally { await browser.close(); }
}
console.log(JSON.stringify({ output, count: manifest.cases.length }));
