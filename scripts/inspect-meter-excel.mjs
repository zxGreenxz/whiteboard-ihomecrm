// Quick read of a sample xlsx to see header layout and where Chỉ số cuối column lives.
// Run: node scripts/inspect-meter-excel.mjs "dataexcel/481NVK.xlsx"
import * as XLSX from 'xlsx/xlsx.mjs';
import * as fs from 'node:fs';
import path from 'node:path';
XLSX.set_fs(fs);

const file = process.argv[2] || 'dataexcel/481NVK.xlsx';
const buf = fs.readFileSync(path.resolve(file));
const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  console.log(`\n=== Sheet: ${name} (${rows.length} rows) ===`);
  rows.slice(0, 25).forEach((r, i) => console.log(String(i).padStart(2, '0'), JSON.stringify(r)));
}
