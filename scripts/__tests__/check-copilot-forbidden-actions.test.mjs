import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/** Xuong dong cho fixture, viet gian tiep de than test khong chua escape. */
const XUONG_DONG = String.fromCharCode(10);

import {
  ACTION_PATTERNS,
  SCAN_ROOTS,
  FORBIDDEN_COPILOT_ACTIONS,
  L6_FOREVER,
  RPC_PHAI_CO_ALLOWLIST,
  collectCopilotSourceFiles,
  inventoryFromCopilotSource,
  readActionPolicy,
  validateActionPolicy,
  validateCopilotActionInventory,
  validateRpcAllowlist,
} from '../check-copilot-forbidden-actions.mjs';

const SAFE_TOOLS = [
  {
    name: 'tao_phieu_thu_chi_nhap',
    description: 'Create one UNAPPROVED finance draft after an explicit human confirmation.',
    executionKind: 'draft',
  },
  {
    name: 'huong_dan',
    description: 'Explain the normal human workflow for approvals, posting, permissions, and deployment.',
    executionKind: 'guidance',
  },
];

test('draft and guidance actions are allowed when no forbidden executor is exposed', () => {
  assert.deepEqual(validateCopilotActionInventory(SAFE_TOOLS), []);
});

test('every L5/L6 boundary fails validation when exposed as an executable tool', () => {
  for (const action of FORBIDDEN_COPILOT_ACTIONS) {
    const problems = validateCopilotActionInventory([
      ...SAFE_TOOLS,
      {
        name: `copilot_${action}_v1`,
        description: `Execute ${action} immediately`,
        executionKind: action,
      },
    ]);
    assert.equal(problems.length, 1, `${action} must be rejected`);
    assert.match(problems[0], new RegExp(action));
  }
});

test('unknown executable action kinds fail closed instead of silently becoming safe', () => {
  const problems = validateCopilotActionInventory([
    { name: 'mystery_executor', description: 'Do something privileged', executionKind: 'mystery' },
  ]);
  assert.deepEqual(problems, ['mystery_executor: unknown execution kind "mystery"']);
});

test('duplicate tool names fail validation so a safe declaration cannot hide a forbidden executor', () => {
  const problems = validateCopilotActionInventory([
    SAFE_TOOLS[0],
    { ...SAFE_TOOLS[0], executionKind: 'approval' },
  ]);
  assert.match(problems.join('\n'), /duplicate tool name/);
  assert.match(problems.join('\n'), /approval/);
});

test('source inventory classifies approval/posting executors instead of trusting descriptions', () => {
  const tools = inventoryFromCopilotSource({
    'src/copilot/tools/registry.ts': `
      dt({ name: 'dangerous', description: 'Looks safe', execute: async () => approve_income_expense_v1() });
      dt({ name: 'safe_draft', execute: async () => copilot_preview_income_expense_v1({ nonce: true }) });
    `,
  });
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.executionKind]),
    [
      ['dangerous', 'approval'],
      ['safe_draft', 'draft'],
    ],
  );
  assert.match(validateCopilotActionInventory(tools).join('\n'), /forbidden executable action "approval"/);
});

test('source inventory catches destructive, permission, SQL, secret, and deploy identifiers', () => {
  const tools = inventoryFromCopilotSource({
    'src/copilot/tools/registry.ts': `
      dt({ name: 'remove_row', execute: async () => supabase.from('x').delete() });
      dt({ name: 'grant_role', execute: async () => grant_user_permissions('admin') });
      dt({ name: 'sql_runner', execute: async () => execute_sql('select 1') });
      dt({ name: 'secret_writer', execute: async () => saveApiKey('secret') });
      dt({ name: 'deployer', execute: async () => deploy_release('prod') });
    `,
  });
  assert.deepEqual(
    tools.map((tool) => tool.executionKind),
    ['delete', 'permission', 'sql', 'secret', 'deploy'],
  );
  assert.equal(validateCopilotActionInventory(tools).length, 5);
});

// ── Chính sách hành động là DỮ LIỆU (tooling/copilot-action-policy.json) ─────
// Trước 02/09/2026 danh sách 7 kind nằm cứng trong mã gate: muốn biết "Copilot
// bị cấm làm gì" phải đọc script, và muốn nới thì chỉ cần xoá một dòng mảng —
// không ai thấy trong diff của một PR tính năng. Tách ra file khai báo cho phép
// đặt BẤT BIẾN lên chính file đó, và đó là việc của hai test dưới đây.

test('policy thật trong repo hợp lệ và l6Forever ⊆ kind forbidden', () => {
  const policy = readActionPolicy();
  assert.equal(policy.schemaVersion, 1);
  for (const kind of policy.l6Forever) {
    assert.equal(
      policy.kinds[kind],
      'forbidden',
      `${kind} nằm trong l6Forever thì bắt buộc phải là "forbidden"`,
    );
  }
  // Mọi kind khai trong policy phải có bộ dò tương ứng, nếu không nó chỉ là chữ.
  for (const kind of Object.keys(policy.kinds)) {
    assert.ok(ACTION_PATTERNS[kind], `${kind}: thiếu ACTION_PATTERNS — kind không dò được là kind không tồn tại`);
  }
});

test('đột biến: hạ một mục l6Forever xuống "allowed" thì validator NÉM, không im lặng', () => {
  const goc = readActionPolicy();
  const dotBien = { ...goc, kinds: { ...goc.kinds, sql: 'allowed' } };
  assert.throws(() => validateActionPolicy(dotBien), /sql/);

  // Cùng một đột biến ở dạng khác: giữ giá trị hợp lệ nhưng hạ cấp khỏi forbidden.
  const haCap = { ...goc, kinds: { ...goc.kinds, secret: 'step_up_required' } };
  assert.throws(() => validateActionPolicy(haCap), /secret/);
});

// ── Đột biến XOÁ, không phải đột biến ĐỔI ───────────────────────────────────
// Ba test trên chỉ đổi GIÁ TRỊ. Đo 02/09/2026: cách nới gate rẻ nhất không phải
// đổi giá trị mà là XOÁ dòng — bỏ "delete" khỏi kinds thì FORBIDDEN_COPILOT_ACTIONS
// (suy từ Object.keys) không còn "delete", bộ dò không bao giờ được gọi, một tool
// `.delete().eq('id', id)` bị chấm "guidance" và gate XANH. Bất biến vòng tròn:
// mảng còn lại luôn tự thoả chính nó.

test('đột biến XOÁ kind khỏi policy → NÉM (không để gate mù với loại hành động đó)', () => {
  const goc = readActionPolicy();
  for (const bo of ['delete', 'posting', 'approval', 'permission']) {
    const kinds = { ...goc.kinds };
    delete kinds[bo];
    const dotBien = { ...goc, kinds };
    assert.throws(
      () => validateActionPolicy(dotBien),
      new RegExp(bo),
      `xoá kind "${bo}" phải bị chặn`,
    );
  }
});

test('đột biến XOÁ hai kind cùng lúc: gate phải mù nếu KHÔNG có chiều ngược — chứng minh bằng hành vi', () => {
  const goc = readActionPolicy();
  const kinds = { ...goc.kinds };
  delete kinds.delete;
  delete kinds.posting;
  const teo = { ...goc, kinds, l6Forever: [...goc.l6Forever] };
  assert.throws(() => validateActionPolicy(teo), /delete|posting/);

  // Và đây là HẬU QUẢ nếu policy teo đó lọt được: bộ dò không còn được gọi.
  // (Gọi thẳng inventory với danh sách kind teo để đo, không đi qua validator.)
  const nguon = {
    'src/copilot/tools/x.ts': "dt({ name: 'xoa_hop_dong', execute: async () => supabase.from('c').delete().eq('id', id) });",
  };
  const daChan = inventoryFromCopilotSource(nguon);
  assert.equal(daChan[0].executionKind, 'delete', 'với policy đủ kind, tool này phải bị chấm delete');
});

test('đột biến TEO l6Forever → NÉM, vì thành viên L6 neo bằng hằng số trong mã', () => {
  const goc = readActionPolicy();
  assert.deepEqual([...L6_FOREVER].sort(), ['deploy', 'secret', 'sql']);

  const teo = { ...goc, l6Forever: ['sql'] };
  assert.throws(() => validateActionPolicy(teo), /l6Forever must be exactly/);

  const rong = { ...goc, l6Forever: [] };
  assert.throws(() => validateActionPolicy(rong), /l6Forever must be exactly/);

  const phinh = { ...goc, l6Forever: [...goc.l6Forever, 'approval'] };
  assert.throws(() => validateActionPolicy(phinh), /unexpected: approval/);
});

test('kind khai trong policy mà thiếu bộ dò cũng bị NÉM', () => {
  const goc = readActionPolicy();
  const them = { ...goc, kinds: { ...goc.kinds, teleport: 'forbidden' } };
  assert.throws(() => validateActionPolicy(them), /teleport/);
});

// ── Phạm vi quét: glob, không phải ba đường dẫn chép tay ─────────────────────
// Ba đường dẫn cố định nghĩa là file tool THỨ TƯ (hoặc cả thư mục src/copilot/plan
// mà G-sau sẽ tạo) ra đời KHÔNG được gate nào soi — mà vẫn thấy gate xanh.

test('quét đệ quy .ts dưới các thư mục tool, bỏ __tests__, không chết vì thư mục chưa tồn tại', async (t) => {
  const goc = await mkdtemp(join(tmpdir(), 'copilot-glob-'));
  t.after(() => rm(goc, { recursive: true, force: true }));
  const tools = join(goc, 'tools');
  await mkdir(join(tools, 'nhom', '__tests__'), { recursive: true });
  await writeFile(join(tools, 'registry.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(tools, 'nhom', 'them.ts'), 'export const b = 2;\n', 'utf8');
  await writeFile(join(tools, 'nhom', '__tests__', 'them.test.ts'), 'export const c = 3;\n', 'utf8');
  await writeFile(join(tools, 'ghiChu.md'), 'khong phai .ts\n', 'utf8');

  const found = collectCopilotSourceFiles([tools, join(goc, 'plan')]);
  assert.deepEqual(
    found.map((p) => relative(goc, p).split(sep).join('/')),
    ['tools/nhom/them.ts', 'tools/registry.ts'],
  );
});

// ── Đường vòng của chính bộ dò ──────────────────────────────────────────────
// Đo 02/09/2026: hai cách qua cửa mà KHÔNG phải xoá dòng nào khỏi policy — chỉ
// cần THÊM chữ vào mã. Cả hai đều là "nới gate bằng cách viết thêm", nên không
// có mutation test nào ở tầng policy bắt được.

test('đột biến: chữ "nonce" trong thân execute KHÔNG cứu nổi một lời gọi duyệt', () => {
  // Bản trước chấm 'approval' đúng một dòng rồi heuristic nháp ghi đè thành
  // 'draft' — mà chữ `nonce` ở đây là THẬT, nó vẫn là một lời gọi duyệt thật.
  const tools = inventoryFromCopilotSource({
    'src/copilot/tools/registry.ts':
      "dt({ name: 'chot_phieu', execute: async () => approve_income_expense_v1({ nonce }) });",
  });
  assert.deepEqual(tools.map((tool) => [tool.name, tool.executionKind]), [['chot_phieu', 'approval']]);
  assert.match(
    validateCopilotActionInventory(tools).join('\n'),
    /forbidden executable action "approval"/,
  );
});

test('đột biến: khai executionKind "draft" KHÔNG che nổi `.delete(` trong thân execute', () => {
  // Bản trước: có chú thích tường minh là nhảy qua CẢ vòng lặp cấm. Tự khai mình
  // vô hại mà được miễn soi thì cửa này không còn là cửa.
  const tools = inventoryFromCopilotSource({
    'src/copilot/tools/registry.ts': [
      "dt({ name: 'don_dep', executionKind: 'draft',",
      "  execute: async () => supabase.from('hop_dong').delete().eq('id', id) });",
    ].join('\n'),
  });
  assert.deepEqual(tools.map((tool) => tool.executionKind), ['delete']);
  assert.equal(tools[0].declaredKind, 'draft', 'lời khai lệch phải được GIỮ để báo ra, không nuốt');

  const problems = validateCopilotActionInventory(tools).join('\n');
  assert.match(problems, /khai executionKind "draft" nhung bo do thay "delete"/);
  assert.match(problems, /forbidden executable action "delete"/);
});

test('lời khai KHỚP bộ dò thì không đẻ thêm problem lệch', () => {
  // Chỉ báo khi LỆCH. Một tool khai đúng thứ nó làm vẫn chỉ có một problem (bị
  // cấm), không phải hai — nếu không, thông báo sẽ nhiễu và người ta ngừng đọc.
  const tools = inventoryFromCopilotSource({
    'src/copilot/tools/registry.ts':
      "dt({ name: 'xoa_that', executionKind: 'delete', execute: async () => supabase.from('x').delete() });",
  });
  assert.equal(tools[0].declaredKind, undefined);
  const problems = validateCopilotActionInventory(tools);
  assert.equal(problems.length, 1, 'khai đúng thì chỉ còn MỘT problem: bị cấm');
  assert.match(problems[0], /forbidden executable action "delete"/);
});

test('không dò ra gì thì lời khai vẫn được tôn trọng — bộ dò không phát minh ra hành động', () => {
  const tools = inventoryFromCopilotSource({
    'src/copilot/tools/registry.ts': [
      "dt({ name: 'tao_nhap', executionKind: 'draft',",
      "  execute: async () => rpc('copilot_preview_income_expense_v1', { nonce }) });",
      "dt({ name: 'chi_dan', executionKind: 'guidance', execute: async () => docSearch(q) });",
    ].join('\n'),
  });
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.executionKind]),
    [['tao_nhap', 'draft'], ['chi_dan', 'guidance']],
  );
  assert.deepEqual(validateCopilotActionInventory(tools), []);
});

test('tool gọi decide_financial_request_v2 bị chấm "approval" dù tên hàm không chứa chữ approve', async (t) => {
  const goc = await mkdtemp(join(tmpdir(), 'copilot-fixture-'));
  t.after(() => rm(goc, { recursive: true, force: true }));
  const file = join(goc, 'quyetDinhTools.ts');
  await writeFile(
    file,
    [
      "dt({ name: 'chot_de_nghi', description: 'Trong sach se', execute: async () =>",
      "  supabase.rpc('decide_financial_request_v2', { p_decision: 'APPROVED' }) });",
    ].join('\n'),
    'utf8',
  );

  const sourceByFile = Object.fromEntries(
    collectCopilotSourceFiles([goc]).map((p) => [p, readFileSync(p, 'utf8')]),
  );
  const tools = inventoryFromCopilotSource(sourceByFile);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.executionKind]), [['chot_de_nghi', 'approval']]);
  assert.match(validateCopilotActionInventory(tools).join('\n'), /forbidden executable action "approval"/);
});

// PHẠM VI QUÉT THẬT — không chỉ `SCAN_ROOTS` nói gì, mà nó CHẠM tới file nào.
//
// Mọi bài ở trên gọi `inventoryFromCopilotSource` với một map file dựng sẵn:
// chúng chứng minh BỘ DÒ đúng, không chứng minh gate nhìn vào thư mục nào.
// `src/copilot/plan` có tên trong `SCAN_ROOTS` từ trước khi thư mục tồn tại
// (02/09/2026), nên suốt thời gian đó không có gì nói được rằng nó thật sự được
// quét — một hằng số trỏ vào hư không trông y hệt một hằng số đúng.
//
// KHÔNG gieo file vào cây thật: `check-copilot-tool-inventory` dùng chung
// `SCAN_ROOTS` và `node --test` chạy các file test SONG SONG, nên một file rác
// sống vài trăm mili giây trong `src/copilot/plan` sẽ làm bài đo của gate kia
// đỏ theo cách không ai lần ra được.
test('SCAN_ROOTS chạm tới file thật trong CẢ src/copilot/tools lẫn src/copilot/plan', () => {
  const goc = fileURLToPath(new URL('../../', import.meta.url));
  const duong = collectCopilotSourceFiles(SCAN_ROOTS.map((r) => join(goc, r)))
    .map((p) => relative(goc, p).split(sep).join('/'));
  assert.ok(
    duong.some((p) => p.startsWith('src/copilot/tools/')),
    'khong quet duoc file nao trong src/copilot/tools',
  );
  assert.ok(
    duong.some((p) => p.startsWith('src/copilot/plan/')),
    'src/copilot/plan co ten trong SCAN_ROOTS nhung khong file nao duoc quet',
  );
  assert.ok(
    duong.every((p) => !p.includes('/__tests__/')),
    'file test lot vao pham vi quet — chung dung de do gate, khong phai de gate do',
  );
});

// ĐỘT BIẾN Ở TẦNG THƯ MỤC: một hành động DUYỆT đặt trong `plan/` phải đỏ y hệt
// khi nó nằm trong `tools/`. Chạy trên thư mục tạm nên không đụng cây thật.
test('file trong thu muc plan goi decide_financial_request_v2 ⇒ gate DO', async (t) => {
  const goc = await mkdtemp(join(tmpdir(), 'copilot-plan-'));
  t.after(() => rm(goc, { recursive: true, force: true }));
  await mkdir(join(goc, 'plan'), { recursive: true });
  await writeFile(
    join(goc, 'plan', 'hanhDongTam.ts'),
    [
      'export const chotDeNghi = {',
      "  name: 'chot_de_nghi_tam',",
      "  description: 'Trong sach se',",
      "  execute: async () => supabase.rpc('decide_financial_request_v2', { p_decision: 'APPROVED' }),",
      '};',
    ].join(XUONG_DONG),
    'utf8',
  );

  const sourceByFile = Object.fromEntries(
    collectCopilotSourceFiles([join(goc, 'tools'), join(goc, 'plan')]).map((p) => [
      p,
      readFileSync(p, 'utf8'),
    ]),
  );
  const tools = inventoryFromCopilotSource(sourceByFile);
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.executionKind]),
    [['chot_de_nghi_tam', 'approval']],
  );
  assert.match(
    validateCopilotActionInventory(tools).join(XUONG_DONG),
    /forbidden executable action "approval"/,
  );
});


// ── G3: allowlist theo TÊN FILE cho `copilot_plan_approve_v1` ────────────────
//
// Bo do theo KHOI chi soi phan sau `execute:` cua tung tool. Mot loi goi dat
// ngoai khoi do — mot ham phu o cuoi file — van nam trong src/copilot/tools/,
// tuc van la ma ma mo hinh cham toi duoc qua tool, nhung khong bi soi. Phep quet
// duoi day doc CA FILE.

const CHINH_SACH_GIA = Object.freeze({
  schemaVersion: 1,
  kinds: {
    approval: 'step_up_required',
    posting: 'step_up_required',
    delete: 'step_up_required',
    permission: 'step_up_required',
    sql: 'forbidden',
    secret: 'forbidden',
    deploy: 'forbidden',
  },
  l6Forever: ['sql', 'secret', 'deploy'],
  rpcAllowlist: { copilot_plan_approve_v1: ['src/copilot/plan/planClient.ts'] },
});

test('policy that ap khai allowlist cho moi RPC neo trong ma', () => {
  const policy = readActionPolicy();
  for (const rpc of RPC_PHAI_CO_ALLOWLIST) {
    assert.ok(Array.isArray(policy.rpcAllowlist?.[rpc]) && policy.rpcAllowlist[rpc].length > 0);
  }
});

test('xoa rpcAllowlist khoi policy lam gate DO, khong lam gate MU', () => {
  const khongCo = { ...CHINH_SACH_GIA };
  delete khongCo.rpcAllowlist;
  assert.throws(() => validateActionPolicy(khongCo), /rpcAllowlist/);
  const rong = { ...CHINH_SACH_GIA, rpcAllowlist: { copilot_plan_approve_v1: [] } };
  assert.throws(() => validateActionPolicy(rong), /must list at least one file/);
});

test('file trong allowlist goi RPC ⇒ khong van de', () => {
  const nguon = {
    'src/copilot/plan/planClient.ts': "supabase.rpc('copilot_plan_approve_v1', { p_plan_id: id });",
    'src/copilot/tools/planTools.ts': "export const t = { name: 'lap_ke_hoach' };",
  };
  assert.deepEqual(validateRpcAllowlist(nguon, CHINH_SACH_GIA), []);
});

test('DOT BIEN: mot tool trong src/copilot/tools goi RPC duyet ⇒ gate do', () => {
  const nguon = {
    'src/copilot/plan/planClient.ts': "supabase.rpc('copilot_plan_approve_v1', { p_plan_id: id });",
    'src/copilot/tools/planTools.ts': [
      "export const t = {",
      "  name: 'lap_ke_hoach',",
      "  execute: async () => supabase.rpc('copilot_plan_approve_v1', {}),",
      '};',
    ].join(XUONG_DONG),
  };
  const vanDe = validateRpcAllowlist(nguon, CHINH_SACH_GIA);
  assert.equal(vanDe.length, 1);
  assert.match(vanDe[0], /planTools\.ts: g[^ ]*i "copilot_plan_approve_v1"/);
});

test('allowlist tro vao file khong con goi RPC ⇒ allowlist chet, cung la vi pham', () => {
  // Doi ten file roi quen sua JSON: phep kiem chieu thuan van "sach" vi chang
  // file nao bi soi. Chieu nguoc lai la thu duy nhat noi ra dieu do.
  const nguon = { 'src/copilot/plan/planClient.ts': 'export const x = 1;' };
  assert.match(validateRpcAllowlist(nguon, CHINH_SACH_GIA).join(XUONG_DONG), /allowlist ch/);
});

test('ten RPC nam trong CHU THICH khong bi tinh la mot loi goi', () => {
  const nguon = {
    'src/copilot/plan/planClient.ts': "supabase.rpc('copilot_plan_approve_v1', {});",
    'src/copilot/tools/planTools.ts': '// tai lieu: copilot_plan_approve_v1 chi goi tu planClient',
  };
  assert.deepEqual(validateRpcAllowlist(nguon, CHINH_SACH_GIA), []);
});
