import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTION_PATH, CAPABILITY_PATH, assertSnapshotMatches, buildInventory,
  readInventorySources, serializeInventory, withoutComments,
} from '../generate-hermes-crm-inventory.mjs';
import { docTool, phanLoai } from '../check-copilot-tool-inventory.mjs';

const sources = readInventorySources();
const inventory = buildInventory(sources);
const toolPath = 'src/copilot/tools/registry.ts';
const replaceSource = (path, before, after) => {
  assert.ok(sources[path].includes(before), `Mutation anchor thiếu: ${before}`);
  return { ...sources, [path]: sources[path].replace(before, after) };
};

test('reuses existing scanner/counts and keeps the snapshot non-authoritative', () => {
  const existing = docTool(Object.fromEntries(Object.entries(sources).filter(([path]) => path.startsWith('src/copilot/tools/') || path.startsWith('src/copilot/plan/')).map(([path, text]) => [path, withoutComments(text)])));
  assert.equal(inventory.summary.toolCount, existing.length);
  assert.deepEqual(inventory.tools.map((tool) => [tool.id, tool.legacyCategory, tool.permission]), existing.map((tool) => [tool.ten, phanLoai(tool), tool.quyen]));
  assert.equal(inventory.authority.grantsRuntimeAccess, false);
  assert.equal(inventory.authority.databaseReadPerformed, false);
  assert.ok(inventory.tools.every((tool) => tool.hermesExposure === 'not_implemented'));
});

test('separates proposal, orchestration and own-row memory from read/navigation', () => {
  const get = (id) => inventory.tools.find((tool) => tool.id === id);
  assert.equal(get('phong_trong').semanticCategory, 'read');
  assert.equal(get('mo_trang').disposition, 'retain_ui');
  assert.equal(get('ghi_nho').semanticCategory, 'memory_mutation');
  assert.match(get('ghi_nho').migrationNote, /chưa có Hermes tổng/);
  assert.equal(get('lap_ke_hoach').disposition, 'undecided');
  assert.equal(get('thuc_thi_buoc').flags.superAdminOnly, true);
  assert.equal(get('tao_phieu_thu_chi_nhap').actionId, 'income_expense.create_draft');
  assert.equal(get('tao_phieu_thu_chi_nhap').semanticCategory, 'write_proposal');
});

test('catalog captures retired actions, sensitive approval and external effects', () => {
  const get = (id) => inventory.actions.find((action) => action.id === id);
  assert.equal(get('termination.hoan_coc').disposition, 'retired');
  assert.equal(get('role.upsert').pinAlways, true);
  assert.equal(get('zalo.broadcast').externalEffect, true);
  assert.equal(get('zalo.broadcast').consentRequired, 'step_up');
  assert.equal(get('zalo.broadcast').permission, 'chat_zalo.send');
  assert.equal(get('invoice.duyet').externalEffect, false);
});

test('capability relationships are only source evidence, never a grant', () => {
  const room = inventory.tools.find((tool) => tool.id === 'phong_trong');
  assert.deepEqual(room.relatedCapabilities, [{ id: 'rooms', match: 'same_permission_only' }]);
  const knowledge = inventory.tools.find((tool) => tool.id === 'huong_dan');
  assert.equal(knowledge.permission, null);
  assert.equal(knowledge.permissionEvidence, 'unresolved_or_absent_review_required');
  assert.ok(inventory.capabilities.every((capability) => capability.disposition === 'retain_ui'));
});

test('deterministic regeneration ignores input order and checkout line endings', () => {
  const reordered = Object.fromEntries(Object.entries(sources).reverse().map(([path, text]) => [path, text.replace(/\r?\n/g, '\r\n')]));
  assert.equal(serializeInventory(buildInventory(reordered)), serializeInventory(inventory));
  assertSnapshotMatches(serializeInventory(inventory).replace(/\n/g, '\r\n'), serializeInventory(inventory));
});

test('MUTATION: missing catalog cannot silently become an empty report', () => {
  assert.throws(() => buildInventory({ ...sources, [ACTION_PATH]: '' }), /Không đo được/);
  assert.throws(() => buildInventory({ ...sources, [CAPABILITY_PATH]: 'export const CAPABILITIES = [];'}), /Không đo được/);
});

test('MUTATION: action permission drift from a tool fails generation', () => {
  const changed = replaceSource(ACTION_PATH, "permission: { module: 'income_expenses', action: 'create' }", "permission: { module: 'income_expenses', action: 'edit' }");
  assert.throws(() => buildInventory(changed), /Quyền tool\/action lệch/);
});

test('MUTATION: duplicate tool names fail instead of shrinking the inventory', () => {
  const changed = replaceSource(toolPath, "name: 'danh_sach_cong_to'", "name: 'danh_sach_khu_vuc'");
  assert.throws(() => buildInventory(changed), /Tool trùng/);
});

test('MUTATION: declaration syntax outside the reused scanner is rejected', () => {
  const changed = replaceSource(toolPath, "name: 'phong_trong'", 'name: "phong_trong"');
  assert.throws(() => buildInventory(changed), /Hình dạng khai báo tool lệch/);
});

test('MUTATION: removing all tools fails the measured-count floor', () => {
  const changed = Object.fromEntries(Object.entries(sources).map(([path, text]) => [path, path.startsWith('src/copilot/tools/') ? '' : text]));
  assert.throws(() => buildInventory(changed), /Không đo được tools/);
});

test('MUTATION: stale snapshot fails when a source permission changes', () => {
  const changed = replaceSource(toolPath, "requiredPermission: { module: 'rooms', action: 'view' }", "requiredPermission: { module: 'rooms', action: 'edit' }");
  const expected = serializeInventory(buildInventory(changed));
  assert.throws(() => assertSnapshotMatches(serializeInventory(inventory), expected), /Inventory lệch source/);
});

test('MUTATION: comment-only fake metadata does not add tools or permissions', () => {
  const comment = "\n// name: 'fake_tool', requiredPermission: { module: 'secret', action: 'view' }\n";
  const changed = buildInventory({ ...sources, [toolPath]: sources[toolPath] + comment });
  assert.deepEqual(changed.tools, inventory.tools);
  assert.notDeepEqual(changed.sources, inventory.sources, 'source digest still records comment changes');
  const preserved = 'const url = "https://example.test/path"; // comment';
  assert.ok(withoutComments(preserved).includes('"https://example.test/path"'));
});

test('MUTATION: newly discovered write tool requires a migration decision', () => {
  const changed = buildInventory({ ...sources, 'src/copilot/tools/extraAgentTool.ts': "const extra = { name: 'extra_agent_tool', chatOnly: true, requiredPermission: { module: 'rooms', action: 'edit' }, execute: () => null };" });
  const tool = changed.tools.find((entry) => entry.id === 'extra_agent_tool');
  assert.equal(tool.disposition, 'undecided');
  assert.equal(tool.semanticCategory, 'unclassified');
  assert.equal(tool.hermesExposure, 'not_implemented');
});

test('MUTATION: missing required action RPC fails closed', () => {
  const changed = replaceSource(ACTION_PATH, "previewRpc: 'copilot_preview_income_expense_v1'", "previewRpc: PREVIEW_FROM_DYNAMIC_SOURCE");
  assert.throws(() => buildInventory(changed), /Không đo được previewRpc/);
});

test('unresolved rollout expressions remain explicit instead of guessed', () => {
  const tool = inventory.tools.find((entry) => entry.id === 'lap_ke_hoach');
  assert.equal(tool.rollout.key, null);
  assert.equal(tool.rollout.symbol, 'KHOA_ROLLOUT_KE_HOACH');
  assert.equal(tool.rollout.resolution, 'expression_unresolved');
});
