// Kiểm sống bộ điền trên CỔNG THẬT, KHÔNG lưu/nộp: nối vào Chrome đã đăng nhập VNeID
// (do ~/tamtru-recorder/recorder.cjs mở, cổng CDP 9333), mở tab form mới, nạp
// fill-engine.js, chạy run() với gói mẫu + ảnh mẫu, đọc lại giá trị, chụp màn hình,
// rồi đóng tab (bỏ form). Dùng: node extensions/tam-tru/test/live-fill.mjs [cdpUrl]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.cwd(), 'node_modules/playwright'));

const CDP = process.argv[2] || 'http://127.0.0.1:9333';
const FORM_URL = 'https://dichvucong.dancuquocgia.gov.vn/portal/p/home/dang-ky-tam-tru.html'
  + '?ma_thu_tuc=1.004194&TT=TAMTRU_01&TT_NAME=%C4%90%C4%83ng%20k%C3%BD%20t%E1%BA%A1m%20tr%C3%BA';
const OUT_DIR = resolve(process.env.LIVE_FILL_OUT || join(process.env.USERPROFILE || '.', 'tamtru-recorder', 'out'));
const ENGINE = readFileSync(resolve(process.cwd(), 'extensions/tam-tru/fill-engine.js'), 'utf8');
const SAMPLE_PNG = readFileSync(resolve(process.cwd(), 'extensions/tam-tru/icons/icon128.png'));

const payload = {
  version: 1, createdAt: new Date().toISOString(), customerId: 'live-test', buildingName: '950NK', roomNumber: 'MADRID 4',
  receive: { provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Hạnh Thông' },
  person: { fullName: 'Nguyễn Gia Bình', dob: '18/10/2008', genderCode: '2', idNumber: '034208012538', phone: '0843181008', email: '' },
  address: '950/65 Nguyễn Kiệm, Khu Phố 14', household: { relationshipCode: 'CH01' }, tempResidentTo: '15/09/2028', attachments: [],
};
const dataUrl = 'data:image/png;base64,' + SAMPLE_PNG.toString('base64');
const files = [
  { kind: 'CT01', name: 'test-ct01.png', type: 'image/png', dataUrl },
  { kind: 'LEASE', name: 'test-hopdong.png', type: 'image/png', dataUrl },
  { kind: 'OWNERSHIP', name: 'test-chuquyen1.png', type: 'image/png', dataUrl },
  { kind: 'OWNERSHIP', name: 'test-chuquyen2.png', type: 'image/png', dataUrl },
];

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
const page = await context.newPage();
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
try {
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!/dang-ky-tam-tru\.html/.test(page.url())) throw new Error('Không vào được form (đang ở ' + page.url() + ') — phiên VNeID đã hết?');
  await page.waitForFunction(() => { const s = document.getElementById('cboRECEIVE_ADDR_CITY_CODE'); return !!s && s.options.length > 1; }, null, { timeout: 60000 });
  await page.addScriptTag({ content: ENGINE });
  const t0 = Date.now();
  const result = await page.evaluate(async ({ payload, files }) => {
    const progress = [];
    let error = null;
    try { await window.__ihomeTamTru.run(payload, files, (p) => progress.push(p)); }
    catch (e) { error = String((e && e.message) || e); }
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
    const sel = (id) => { const el = document.getElementById(id); return el && el.selectedOptions[0] ? el.selectedOptions[0].text : null; };
    const rows = Array.from(document.querySelectorAll('#tblGiayToDinhKem tbody tr')).map((tr, i) => ({
      i, name: (document.getElementById('lblFILE_TYPE_NAME' + i) || {}).value || tr.textContent.trim().slice(0, 60),
      checked: !!(document.getElementById('chkIS_COMPULSORY' + i) || {}).checked,
      fileType: v('cboFILE_TYPE' + i), files: ((document.getElementById('fileUpload' + i) || {}).files || []).length,
      soLuong: v('txtNUM_OF_PAPER' + i),
    }));
    return {
      error, progress,
      values: {
        tinh: sel('cboRECEIVE_ADDR_CITY_CODE'), phuong: sel('cboRECEIVE_ADDR_VILLAGE_CODE'), coQuan: v('txtRECEIVE_ORG_ADDRESS'),
        thuTuc: v('cboBPROC_TYPE_CODE'), truongHop: v('cboBPROC_CASE_CODE'),
        lapHoMoi: !!document.getElementById('chkNEW_REGISTRATION')?.checked, khaiHo: !!document.getElementById('chkIS_NOT_CHANGED_PERSON')?.checked,
        hoTen: v('txtFULLNAME'), dinhDang: v('cboDATE_FORMAT'), ngaySinh: v('txtDOB'), gioiTinh: sel('cboGENDER_CODE'),
        cccd: v('txtIDENTIFIER_NUMBER'), sdt: v('txtPHONE_NUMBER'), email: v('txtEMAIL'),
        diaChi: v('txtSUGGEST_ADDRESS'), chuHo: v('txtHH_PERSON_FULLNAME'), quanHe: sel('cboHH_PERSON_RELATIONSHIP_CODE'),
        cccdChuHo: v('txtHH_PERSON_IDENTIFIER_NUMBER'), noiDung: v('txtCHANGED_NOTE'), hanDen: v('txtTEMP_RESIDENT_TO'),
        truongHopDinhKem: v('txtBPROC_CASE_NEW_CODE'), chiuTrachNhiem: !!document.getElementById('chkCHECK_LIABILITY')?.checked,
      },
      rows,
    };
  }, { payload, files });
  result.ms = Date.now() - t0;
  result.dialogs = dialogs;
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shot = join(OUT_DIR, `live-fill-${stamp}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  writeFileSync(join(OUT_DIR, `live-fill-${stamp}.json`), JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ ...result, screenshot: shot }, null, 1));
} finally {
  // Bỏ form: đóng tab, không Lưu nháp / Nộp.
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
