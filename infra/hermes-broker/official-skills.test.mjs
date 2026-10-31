// Hướng dẫn chuẩn CRM cho Hermes (infra/hermes-skills, sự cố 31/10: bot tìm tool đã nghỉ crm_task_create theo skill tự học).
// Đổi tool / thao tác của connector mà quên sửa skill chuẩn ⇒ test này đỏ: mọi tên tool crm_…, mã thao tác <trang>.<thao tác> và
// mã báo cáo report=… nhắc trong skill phải có trong danh mục rút từ module thật (catalog-names.mjs); tên tool nghỉ hưu chỉ được
// nhắc kèm tool thay; mỗi trang có skill nêu đủ thao tác của trang; frontmatter hợp luật Hermes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { fullGrantBroker } from './full-grant-broker.fixture.mjs';
import { catalogActionIds, catalogReportIds, catalogToolNames, checkCatalogMentions, findCatalogMentions, retiredToolNames } from './catalog-names.mjs';
import { createActionCatalog } from './action-catalog.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { ACTION_LIST_TOOL, ACTION_RUN_TOOL, ACTION_STATUS_TOOL } from './action-contract.mjs';
import { ACTION_PAGE_CATALOGS, PRODUCTION_ACTIONS } from './action-page-catalogs.mjs';
import { W2 } from './wave2-registry.mjs';

const SKILLS_DIR = fileURLToPath(new URL('../hermes-skills/', import.meta.url));
// Luật Hermes (đọc 31/10 trong container hermes-owner): tools/skill_manager_tool.py _validate_frontmatter (name + description,
// description ≤ 1024), VALID_NAME_RE + MAX_NAME_LENGTH 64, agent/skill_utils.SKILL_PROMPT_DESC_LIMIT = 60 (chỉ mục skill cắt mô
// tả dài hơn), tools/skill_linter.py (name = tên thư mục, mục "When to Use", thân ≤ 24 000 ký tự, không gọi tên lệnh shell).
const DESC_LIMIT = 60, BODY_LIMIT = 24_000;
const SKILL_NAME = /^ihome-crm-[a-z0-9][a-z0-9-]*$/;
const PAGE_SKILLS = Object.freeze({ task: 'ihome-crm-cong-viec', contract: 'ihome-crm-hop-dong', invoice: 'ihome-crm-hoa-don', expense: 'ihome-crm-thu-chi' });
const CORE_SKILL = 'ihome-crm-ghi-chung';
const service = { async prepareAction() { return Object.freeze({}); }, async finalizeAction() { return { kind: 'applied', result: {} }; } };

/** Lỗi frontmatter của một SKILL.md (dir = tên thư mục; null với DESCRIPTION.md). Rỗng là hợp lệ. */
function frontmatterProblems(text, dir) {
  const problems = [];
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return ['không mở đầu bằng frontmatter --- … ---'];
  let data;
  try { data = yaml.load(match[1]); } catch (error) { return [`YAML lỗi: ${error.message.split('\n')[0]}`]; }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return ['frontmatter không phải mapping'];
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) problems.push('thiếu description');
  if (dir === null) return problems;
  if (data.name !== dir) problems.push(`name '${data.name}' khác tên thư mục '${dir}'`);
  if (typeof data.name !== 'string' || !SKILL_NAME.test(data.name) || data.name.length > 64) problems.push('name sai khuôn ihome-crm-…');
  if ([...description].length > DESC_LIMIT) problems.push(`description ${[...description].length} ký tự > ${DESC_LIMIT}`);
  if (description && !description.endsWith('.')) problems.push('description phải là một câu kết thúc bằng dấu chấm');
  const body = match[2];
  if (!body.trim()) problems.push('thân rỗng');
  if (body.length > BODY_LIMIT) problems.push(`thân ${body.length} ký tự > ${BODY_LIMIT}`);
  if (!/^## When to Use$/m.test(body)) problems.push('thiếu mục "## When to Use"');
  if (/`(?:grep|rg|cat|head|tail|sed|awk|find|ls)\b/.test(body)) problems.push('nhắc lệnh shell trong văn (Hermes skill_linter)');
  return problems;
}

const skillDirs = () => readdirSync(SKILLS_DIR).filter(name => statSync(join(SKILLS_DIR, name)).isDirectory()).sort();
const skillText = name => readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');

test('danh mục tên rút từ module thật: khớp tools/list của kết nối đủ quyền, tên nghỉ hưu bị ẩn và bị từ chối', async t => {
  const tools = catalogToolNames(), actions = catalogActionIds(), retired = retiredToolNames();
  assert.ok(Object.isFrozen(tools) && Object.isFrozen(actions) && Object.isFrozen(retired));
  // Danh mục thao tác = đúng cái server.mjs nạp khi bật mọi trang actionPages (không có probe.* của connector TEST).
  const loaded = createActionCatalog([...PRODUCTION_ACTIONS, ...Object.values(ACTION_PAGE_CATALOGS).flat()]);
  assert.deepEqual([...actions], [...loaded.ids].sort());
  assert.ok(actions.includes('task.create') && actions.includes('contract.room_lock') && !actions.some(id => id.startsWith('probe.')));
  assert.deepEqual([...catalogReportIds()], Object.keys(W2.reports).sort());
  // Sự cố 31/10: hai tên bot đã tìm phải nằm trong bảng nghỉ hưu, kèm thay thế đúng.
  assert.deepEqual(retired.crm_task_create, { tool: 'crm_action_run', action: 'task.create' });
  assert.deepEqual(retired.crm_task_input_options, { tool: 'crm_action_run', action: 'task.create' });
  for (const [name, { tool, action }] of Object.entries(retired)) {
    assert.ok(!tools.includes(name), `${name} nghỉ hưu mà còn trong danh mục`);
    assert.ok(tools.includes(tool), `${name} → ${tool} không có trong danh mục`);
    if (action !== undefined) assert.ok(actions.includes(action), `${name} → ${action} không có`);
  }
  // Kết nối giữ mọi khoá + danh mục thao tác production đầy đủ: tools/list đúng bằng danh mục, gọi thẳng tên nghỉ hưu bị từ chối.
  const { broker, token } = fullGrantBroker(t, undefined, { actions: createActionRuntime({ catalog: loaded, service }) });
  const listed = (await broker.listTools(token)).tools.map(tool => tool.name).sort();
  assert.deepEqual(listed, [...tools]);
  for (const name of Object.keys(retired)) {
    await assert.rejects(broker.callTool(token, name, {}), error => error.code === 'tool_not_available', `${name} gọi thẳng phải bị từ chối`);
  }
});

test('skill chuẩn: chỉ thư mục ihome-crm-*, frontmatter hợp luật Hermes, có DESCRIPTION.md của nhóm', () => {
  const dirs = skillDirs();
  assert.ok(dirs.length >= 6, `chỉ có ${dirs.length} skill`);
  for (const dir of dirs) {
    assert.match(dir, SKILL_NAME, `thư mục lạ trong infra/hermes-skills: ${dir}`);
    assert.ok(existsSync(join(SKILLS_DIR, dir, 'SKILL.md')), `${dir} thiếu SKILL.md`);
    assert.deepEqual(readdirSync(join(SKILLS_DIR, dir)), ['SKILL.md'], `${dir}: deploy.sh chỉ chép SKILL.md`);
    assert.deepEqual(frontmatterProblems(skillText(dir), dir), [], dir);
  }
  for (const name of [CORE_SKILL, ...Object.values(PAGE_SKILLS)]) assert.ok(dirs.includes(name), `thiếu skill ${name}`);
  assert.deepEqual(frontmatterProblems(readFileSync(join(SKILLS_DIR, 'DESCRIPTION.md'), 'utf8'), null), []);
});

test('skill chuẩn: mọi tên tool / mã thao tác / mã báo cáo nhắc tới đều có thật; đủ bảng nghỉ hưu và đủ thao tác từng trang', () => {
  const texts = Object.fromEntries(skillDirs().map(dir => [dir, skillText(dir)]));
  texts['DESCRIPTION.md'] = readFileSync(join(SKILLS_DIR, 'DESCRIPTION.md'), 'utf8');
  for (const [name, text] of Object.entries(texts)) assert.deepEqual(checkCatalogMentions(text), [], name);
  // Tên tool nghỉ hưu: bảng của skill chung nêu đủ (mỗi dòng kèm tool thay — checkCatalogMentions bảo đảm).
  const core = findCatalogMentions(texts[CORE_SKILL]).tools;
  for (const name of Object.keys(retiredToolNames())) assert.ok(core.includes(name), `${CORE_SKILL} thiếu dòng nghỉ hưu ${name}`);
  // Mỗi trang có thao tác ghi phải có skill riêng nêu đủ mã thao tác của trang (trang mới ⇒ thêm skill + PAGE_SKILLS).
  for (const id of catalogActionIds()) {
    const page = id.split('.')[0];
    assert.ok(Object.hasOwn(PAGE_SKILLS, page), `trang ${page} chưa có skill chuẩn`);
    assert.ok(findCatalogMentions(texts[PAGE_SKILLS[page]]).actions.includes(id), `${PAGE_SKILLS[page]} thiếu ${id}`);
  }
  // Câu ưu tiên + luật "không kết luận không có khi chưa gọi crm_action_list".
  assert.match(texts[CORE_SKILL], /hướng dẫn CHUẨN/);
  assert.match(texts[CORE_SKILL], /Skill tự học[^.]*lỗi thời/);
  assert.match(texts[CORE_SKILL], /Tên tool và mã thao tác chỉ lấy từ kết quả\s+`crm_action_list`/);
  assert.match(texts[CORE_SKILL], /tìm\s+không thấy KHÔNG có nghĩa là không ghi được/);
  for (const dir of skillDirs().filter(name => name !== CORE_SKILL)) assert.match(texts[dir], /Hướng dẫn chuẩn, cùng connector; khác skill tự học thì theo đây/, dir);
});

test('bộ kiểm bắt được tên sai (tên đoán, tên nghỉ hưu trơn, mã thao tác / báo cáo lạ, frontmatter hỏng)', () => {
  const kinds = text => checkCatalogMentions(text).map(problem => `${problem.kind}:${problem.name}`);
  assert.deepEqual(kinds('Tạo việc bằng crm_task_create'), ['retired_without_replacement:crm_task_create']);
  assert.deepEqual(kinds('Dùng `crm_task_create` → `crm_action_run` action `task.create`'), []);
  assert.deepEqual(kinds('crm_task_status → crm_action_run'), ['retired_without_replacement:crm_task_status'], 'tool thay sai');
  assert.deepEqual(kinds('gọi crm_task_creat rồi crm_action_*'), ['unknown_tool:crm_task_creat', 'unknown_tool:crm_action']);
  assert.deepEqual(kinds('action task.creat, contract.room_hold'), ['unknown_action:task.creat', 'unknown_action:contract.room_hold']);
  assert.deepEqual(kinds('crm_read_report report=re_vacant_room'), ['unknown_report:re_vacant_room']);
  assert.deepEqual(kinds('crm_read_report report=upcoming'), ['unknown_report:upcoming'], 'enum của tool khác chỉ nhận khi nhắc tool đó');
  assert.deepEqual(kinds('thao tác thử probe.note'), ['unknown_action:probe.note'], 'probe.* chỉ có ở connector TEST');
  assert.deepEqual(kinds('crm_sale_action operation=room_lock'), [], 'operation của crm_sale_action không phải tên tool');
  assert.deepEqual(kinds('crm_sale_room_lock'), ['unknown_tool:crm_sale_room_lock'], 'tên nội bộ của Sale không gọi thẳng được');
  assert.deepEqual(kinds('mcp__ihomecrm__crm_action_run; crm_read_occupancy_report report=upcoming; {"report": "rooms"}'), []);
  // Đột biến trên chính skill thật: đổi một tên tool / một mã thao tác ⇒ bộ kiểm báo đúng chỗ.
  const core = skillText(CORE_SKILL);
  assert.ok(kinds(core.replace('`crm_action_status`', '`crm_action_state`')).includes('unknown_tool:crm_action_state'));
  const tasks = skillText(PAGE_SKILLS.task);
  assert.ok(kinds(tasks.replace('task.recurring_pause', 'task.recurring_stop')).includes('unknown_action:task.recurring_stop'));
  // Frontmatter hỏng / mô tả quá dài / tên lệch thư mục.
  assert.deepEqual(frontmatterProblems('# không có frontmatter', 'ihome-crm-x'), ['không mở đầu bằng frontmatter --- … ---']);
  const long = `---\nname: ihome-crm-x\ndescription: "${'a'.repeat(61)}."\n---\n\n## When to Use\nx\n`;
  assert.deepEqual(frontmatterProblems(long, 'ihome-crm-x'), ['description 62 ký tự > 60']);
  assert.deepEqual(frontmatterProblems(long.replace('a'.repeat(61), 'Ngắn'), 'ihome-crm-y'), ["name 'ihome-crm-x' khác tên thư mục 'ihome-crm-y'"]);
  assert.deepEqual(frontmatterProblems('---\nname: ihome-crm-x\ndescription: Tạo việc: giao.\n---\n\n## When to Use\nx\n', 'ihome-crm-x').length, 1, 'dấu ":" trần trong YAML');
});

test('mô tả crm_action_*: nêu đủ tên tool cũ được thay + từ khoá ý định có dấu và không dấu (BM25 ASCII)', () => {
  const describedBy = { [ACTION_RUN_TOOL.name]: ACTION_RUN_TOOL.description, [ACTION_STATUS_TOOL.name]: ACTION_STATUS_TOOL.description };
  let covered = 0;
  for (const [name, { tool }] of Object.entries(retiredToolNames())) {
    if (!Object.hasOwn(describedBy, tool)) continue;
    assert.ok(describedBy[tool].includes(name), `mô tả ${tool} thiếu tên cũ ${name}`);
    covered += 1;
  }
  assert.ok(covered >= 8, `chỉ ${covered} tên cũ đi qua crm_action_*`);
  const list = ACTION_LIST_TOOL.description;
  for (const phrase of ['tạo/giao/huỷ việc', 'tao giao huy viec', 'giữ/khoá phòng', 'giu khoa phong', 'gia hạn/báo trả HĐ', 'gia han bao tra hop dong',
    'phiếu chi', 'phieu chi', 'thu tiền hoá đơn', 'thu tien hoa don']) assert.ok(list.includes(phrase), `crm_action_list thiếu "${phrase}"`);
  // tool_search của Hermes: token [A-Za-z0-9]+ chữ thường — dạng không dấu phải ra đủ token.
  const tokens = new Set(list.toLowerCase().match(/[a-z0-9]+/g));
  for (const token of ['tao', 'giao', 'huy', 'viec', 'giu', 'khoa', 'phong', 'gia', 'han', 'bao', 'tra', 'hop', 'dong', 'phieu', 'chi', 'thu', 'tien', 'hoa', 'don'])
    assert.ok(tokens.has(token), `thiếu token ASCII "${token}"`);
});
