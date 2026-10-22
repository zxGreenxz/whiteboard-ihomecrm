import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const base = 'docs/plans/sale-phong-actions-20261021';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const ui = read('.scratch/quick-room-acceptance-map.json');
const money = read(`${base}/MONEY-ROLE-ACCEPTANCE.json`);
const hermes = read(`${base}/hermes-acceptance-mapping.json`).cases;
const pgLog = readFileSync('test-results/sale-quick-local/quick-final-native.log', 'utf8');
const pgSource = readFileSync('scripts/test-sale-quick-operations.mjs', 'utf8');
const cases = [];
for (const id of new Set(ui.cases.map(c => c.id))) {
  const matches = ui.cases.filter(c => c.id === id);
  if (matches.some(c => c.status !== 'passed')) throw new Error(`UI not passed: ${id}`);
  const title = matches[0].title.replace(/^U\d+ — /, '').replace(/, mobile=(true|false)$/, '');
  const split = title.indexOf(':');
  cases.push({ id, role: split > -1 ? title.slice(0, split) : 'Chủ trọ / quản lý', request: split > -1 ? title.slice(split + 1).trim() : title,
    status: 'passed', layer: 'Component/helper local với backend giả lập', testFile: 'src/components/sale-phong/__tests__/QuickRoomBoard.test.tsx', evidence: 'ui-acceptance-mapping.json', executions: matches.length });
}
for (const c of money) {
  if (c.status !== 'passed') throw new Error(`Money not passed: ${c.id}`);
  cases.push({ ...c, testFile: c.testFile.split('/sale-phong-action-audit-20261021/').pop(), layer: 'Test nghiệp vụ SQL/PGlite, hook hoặc component theo testFile' });
}
for (const c of hermes) {
  if (c.status !== 'passed') throw new Error(`Hermes not passed: ${c.id}`);
  cases.push({ id: c.id, role: c.role, request: c.request, expected: c.expected, status: c.status,
    layer: 'Tool input đã resolve + SQL fixture; không phải hội thoại LLM thật', testFile: 'infra/hermes-broker/sale-owner-requests.test.mjs', evidence: 'hermes-acceptance-results.xml' });
}
for (const match of pgSource.matchAll(/t\.test\('(R\d{2}) ([^']+)'/g)) {
  if (!pgLog.includes(`✔ ${match[1]} `)) throw new Error(`Native PG not passed: ${match[1]}`);
  const request = match[2];
  const role = ['Chủ công ty', 'Chủ trọ', 'Quản lý', 'Sale Admin', 'Sale'].find(r => request.startsWith(r)) ?? 'Chủ trọ / chủ công ty';
  cases.push({ id: match[1], role, request, status: 'passed', layer: 'PostgreSQL 17.10 thật; quyền và writer canonical; claims local',
    testFile: 'scripts/test-sale-quick-operations.mjs', evidence: 'quick-final-native.log' });
}
if (new Set(cases.map(c => c.id)).size !== cases.length || cases.length < 60) throw new Error('Invalid acceptance ID count');
copyFileSync('.scratch/quick-room-acceptance-map.json', `${base}/ui-acceptance-mapping.json`);
copyFileSync('test-results/sale-quick-local/quick-final-native.log', `${base}/quick-final-native.log`);
const report = { createdAt: new Date().toISOString(), distinctCaseIds: cases.length,
  webAndHermesRequests: cases.filter(c => !c.id.startsWith('R')).length,
  databaseCrossChecks: cases.filter(c => c.id.startsWith('R')).length,
  roles: ['Chủ trọ', 'Quản lý', 'Chủ công ty', 'Sale Admin', 'Sale'],
  counting: 'Mỗi ID chỉ tính một lần. Biến thể desktop/mobile, test cha, mutant và chạy lại không tăng số ca. Một nghiệp vụ có thể được kiểm lại ở vai trò/kênh/tầng khác; không phải 103 quy trình hoàn toàn khác nhau.',
  scope: 'Local dữ liệu tổng hợp. Không phải bảo đảm toàn bộ production hoặc kiểm hiểu ngôn ngữ tự nhiên.', cases };
writeFileSync(`${base}/ROLE-ACCEPTANCE.json`, JSON.stringify(report, null, 2) + '\n');
const escape = s => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const rows = cases.map(c => `| ${c.id} | ${escape(c.role)} | ${escape(c.request)} | PASS | ${escape(c.layer)} | [Bằng chứng](${c.evidence}) |`).join('\n');
writeFileSync(`${base}/ROLE-ACCEPTANCE.md`, `# ${cases.length} ca nghiệp vụ — đủ 5 vai trò\n\nGồm ${report.webAndHermesRequests} yêu cầu theo vai trò trên web/Hermes và ${report.databaseCrossChecks} ca đối chiếu quyền/dữ liệu ở PostgreSQL thật. Đã chạy trên local với dữ liệu tổng hợp. Mỗi ID tính một lần; không cộng test cha, số biến thể hay lần chạy lại. Một nghiệp vụ có thể được kiểm lại ở vai trò/kênh/tầng khác, không phải 103 quy trình hoàn toàn khác nhau. PASS chỉ có nghĩa là đạt ở tầng kiểm ghi trong bảng. Bộ này vượt yêu cầu tối thiểu 60 ca, không chứng minh bao phủ mọi nghiệp vụ hoặc production.\n\nVai trò là hồ sơ quyền được cấp theo công ty/tòa, không phải chỉ kiểm tên vai trò. Sale và Sale Admin đều có ca được phép, bị từ chối và bị thu hồi quyền. Mapping tới test nguồn nằm trong [JSON](ROLE-ACCEPTANCE.json).\n\n| Mã | Vai trò | Yêu cầu nghiệp vụ | Kết quả | Tầng đã kiểm | Bằng chứng |\n|---|---|---|---|---|---|\n${rows}\n`);
console.log(`${cases.length} distinct requests; all mapped to passing evidence`);
