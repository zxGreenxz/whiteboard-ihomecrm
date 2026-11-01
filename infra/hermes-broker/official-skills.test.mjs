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
import { ACTION_LIST_TOOL, ACTION_RUN_TOOL, ACTION_STATUS_TOOL, needsInput } from './action-contract.mjs';
import { SALE_ACTION_TOOLS } from './sale-action-contract.mjs';
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

test('skill chuẩn giữ luật chặn của SOUL: Sale cấm reservation_* và lock; chặn trước tiền hệ thống; if_required có thể ghi ngay', () => {
  // Thao tác cọc của Sale có tiền và ghi thẳng (sale-action-contract.mjs) ⇒ SOUL dòng 17/20: cọc làm trên web. Mỗi operation reservation_*
  // (kể cả thao tác mới thêm sau này) và lock / release phải nằm trên một dòng "KHÔNG" của skill phòng / Sale.
  const sale = skillText('ihome-crm-phong-sale-nhom');
  const operations = SALE_ACTION_TOOLS.map(tool => tool.name.slice('crm_sale_'.length));
  const forbidden = operations.filter(operation => operation.startsWith('reservation_') || ['room_lock', 'room_release'].includes(operation));
  assert.ok(forbidden.length >= 6, forbidden.join(','));
  for (const operation of forbidden) assert.ok(sale.split('\n').some(line => line.includes(operation) && /KHÔNG/.test(line)), `${operation} chưa bị cấm`);
  assert.match(sale, /Quản lý cọc/);
  // SOUL dòng 15/20: hoa hồng, cọc, phiếu THU, lương… chặn trước — không gọi tool nào, kể cả crm_action_list.
  const core = skillText(CORE_SKILL);
  assert.match(core, /CHẶN TRƯỚC — chỉ khi việc được nhờ chính là LẬP \/ GHI[\s\S]{0,120}không gọi tool nào, kể cả\s+`crm_action_list`/);
  for (const word of ['hoa hồng', 'cọc', 'phiếu THU', 'lương', 'quyết toán']) assert.ok(core.includes(word), word);
  const expenses = skillText(PAGE_SKILLS.expense);
  for (const page of ['Duyệt hoa hồng', 'Quản lý cọc', 'Lương', '/income-expense']) assert.ok(expenses.includes(page), page);
  // Review #369 lượt 3: chặn trước CHỈ khi việc được nhờ là LẬP / GHI khoản tiền; trả phòng kèm bỏ cọc (contract.return forfeit, SOUL
  // dòng 22) và ghi chú vào phiếu đã có (expense.note, kể cả phiếu thu) không bị chặn.
  for (const [name, text] of [['ghi-chung', core], ['thu-chi', expenses]]) {
    assert.match(text, /chỉ khi việc được nhờ chính là LẬP \/ GHI/i, name);
    assert.doesNotMatch(text, /mọi phiếu THU/i, `${name}: không chặn cả ghi chú phiếu thu`);
    assert.match(text, /KHÔNG chặn[\s\S]{0,400}`contract\.return`\s+`forfeit` = true/, `${name}: trả phòng kèm bỏ cọc`);
    assert.match(text, /KHÔNG chặn[\s\S]{0,400}`expense\.note`/, `${name}: ghi chú phiếu`);
  }
  assert.match(skillText(PAGE_SKILLS.contract), /bỏ cọc không kèm trả phòng[\s\S]{0,200}`contract\.return`\s+`forfeit` = true/);
  // Skill nói đúng huongDan invalid_params của máy chủ: sửa phần mình chọn; giá trị có trong lời người dùng ⇒ dùng / ghép nguyên văn;
  // lời không đủ (lý do chỉ "đổi ý") ⇒ hỏi lại, không bịa.
  assert.match(core, /sửa phần MÌNH chọn \(tên \/ kiểu tham số, định dạng ngày,\s+tham số thừa\)/);
  assert.match(core, /cụm người dùng nói về chính giá trị đó ⇒ dùng \/ ghép nguyên văn rồi gọi lại \(không\s+tự thêm câu yêu cầu, tên thao tác, từ đệm\)/);
  assert.match(core, /Máy chủ báo giá trị người dùng nói còn ngắn \/ sai khuôn \(vd lý do chỉ "đổi ý", giữ phòng 8 giờ\), hoặc\s+họ chưa nói ⇒ hỏi lại, không tự đổi, không bịa/);
  // confirm if_required + chính sách DB never ⇒ ghi ngay ở pha auto (action-runtime.mjs).
  assert.match(core, /`confirm: if_required`: máy chủ có thể GHI NGAY/);
  assert.match(core, /`confirm: always`[^\n]*luôn trả bản xem trước/);
});

test('ma trận d31 (01/11): skill không làm bot hỏi lại điều người dùng đã nói; gọi skill_view bằng tên trần', () => {
  const core = skillText(CORE_SKILL), contracts = skillText(PAGE_SKILLS.contract), invoices = skillText(PAGE_SKILLS.invoice);
  // HĐn C06 / HD-M02: luật "mơ hồ ⇒ hỏi một câu" CHỈ cho báo trả (SOUL dòng 22), không còn áp chung cho mọi if_required — nhưng KHÔNG
  // đè các ca hỏi riêng của từng trang (review #377: "giữ 302 tám tiếng" ⇒ hỏi chọn 6 / 12 / 24; người nhận "anh/chị" trơn ⇒ hỏi).
  const tasks = skillText(PAGE_SKILLS.task);
  assert.doesNotMatch(core, /ý còn mơ hồ thì hỏi/);
  assert.match(core, /Hỏi trước khi gọi khi: nói "trả phòng" kèm ngày dọn đi\s+TƯƠNG LAI/);
  assert.match(core, /và các ca hỏi riêng của từng\s+trang \(giá trị có khuôn đóng: giờ giữ phòng khác 6 \/ 12 \/ 24 ⇒ hỏi chọn mức gần nhất; người nhận "anh\/chị" trơn ⇒ hỏi giao cho\s+ai…\)/);
  // Gốc HD-M02: bot tự đếm rồi hỏi. Lý do / nội dung / ghi chú không nằm trong nhóm "hỏi trước"; validator chặn trước SQL nên gọi vẫn an toàn.
  assert.doesNotMatch(core, /giá trị họ nói không hợp khuôn/);
  assert.match(core, /Lý do, nội dung, ghi chú đã nói thì gửi nguyên cụm, không hỏi trước/);
  for (const [name, text] of [['hop-dong', contracts], ['thu-chi', skillText(PAGE_SKILLS.expense)]]) assert.doesNotMatch(text, /ngắn hơn khuôn/, name);
  assert.match(core, /Ngoài các ca đó, không hỏi lại điều người dùng đã nói/);
  assert.match(contracts, /N giờ khác ⇒ hỏi chọn mức gần nhất, không tự đổi/);
  assert.match(tasks, /"anh\/chị" đứng một mình là\s+mơ hồ ⇒ hỏi/);
  // Lý do / nội dung: chỉ cụm người dùng nói VỀ chính giá trị đó (lý do = vì sao); không ghép câu yêu cầu, tên thao tác, chủ ngữ, từ đệm.
  assert.match(core, /dùng NGUYÊN VĂN cụm người dùng nói VỀ chính giá trị đó \(lý do = vì sao, vd "khách ở tiếp"/);
  assert.match(core, /Bot KHÔNG tự ghép thêm câu yêu cầu, tên thao tác \("huỷ báo trả", "gia hạn"\), chủ ngữ hay\s+từ đệm cho đủ ký tự/);
  assert.match(core, /Không tự đếm ký tự trước khi gọi: gửi nguyên cụm, máy chủ báo ngắn thì mới hỏi/);
  // HD-N23: lý do thật có sẵn tên thao tác ⇒ gửi nguyên văn; câu cấm chỉ nhằm việc bot tự ghép.
  assert.match(core, /Cụm họ tự nói có sẵn tên thao tác \("khách gia hạn ở tiếp"\) ⇒ gửi\s+nguyên văn, không cắt, không hỏi lại/);
  assert.match(contracts, /Cụm họ tự nói có sẵn chữ đó \("khách gia hạn ở tiếp"\) ⇒ gửi nguyên văn, không cắt, không hỏi\s+lại/);
  // Ngày mặc định hôm nay CHỈ cho ngày thu của invoice.collect; ngày bắt buộc khác (trả phòng, báo trả, nháp HĐ) ⇒ hỏi.
  assert.doesNotMatch(core, /không nói ngày ⇒ bỏ/);
  assert.match(core, /Ngày thu của `invoice\.collect` không nói ⇒ bỏ \(máy chủ lấy hôm nay\)/);
  assert.match(core, /ngày bắt\s+buộc khác \(trả phòng, báo trả, nháp HĐ\) không nói ⇒ hỏi, không tự lấy hôm nay/);
  assert.match(core, /"trước" \/ "sau" đứng sau số tiền \("ck 2 củ\s+trước"\) là trả trước \/ trả sau, không phải ngày/);
  // HD-M21 / HD-M02: hai việc trong một tin ⇒ làm NGAY trong lượt đó (việc ghi thẳng gọi luôn, việc cần xem trước đưa bản xem trước);
  // lời đồng ý chỉ xác nhận bản xem trước người dùng đã thấy (SOUL dòng 18). Bỏ giữa chừng ⇒ nói rõ việc nào đã ghi, việc nào chưa.
  assert.match(core, /làm lần lượt NGAY trong lượt đó: việc ghi thẳng mà lời đã đủ thì gọi luôn/);
  assert.match(core, /lời đồng ý chỉ xác nhận bản xem trước người\s+dùng đã thấy/);
  assert.match(core, /nói rõ việc nào ĐÃ ghi \(vd báo trả đã ghi thẳng trong cùng tin\) và việc nào CHƯA ghi — chỉ nói "em chưa ghi gì" khi\s+chưa ghi việc nào/);
  // notice_cancel (SOUL dòng 22, review #377): ba lý do cấm + không ghép câu yêu cầu / tên thao tác; "đổi ý" quá ngắn ⇒ hỏi.
  assert.match(contracts, /KHÔNG dùng "theo yêu cầu", "huỷ báo trả", "khách yêu\s+cầu"; bot không tự ghép câu yêu cầu \("302 toà 80 huỷ báo trả"\), tên thao tác hay từ đệm cho đủ ký tự/);
  assert.match(contracts, /Chưa nêu ⇒ hỏi "Khách huỷ báo trả vì sao ạ\?"/);
  // Đáp lại vẫn quá ngắn: không lặp câu hỏi cũ, nói rõ cần chi tiết hơn.
  assert.match(contracts, /Đã nêu ⇒ gửi nguyên cụm, không tự đếm ký tự; máy chủ báo ngắn \(vd "đổi ý"\) ⇒ không lặp câu hỏi cũ, nói rõ cần chi tiết hơn\s+\("Khách đổi ý vì sao ạ\?"\)/);
  // Cùng luật ở các chỗ khác có lý do / nội dung: gia hạn, trả phòng, điều chỉnh hoá đơn, huỷ phiếu chi.
  assert.match(contracts, /bot chỉ không tự ghép "gia hạn" hay câu yêu cầu cho đủ ký tự/);
  assert.match(contracts, /câu yêu cầu\s+\("ghi nhận trả phòng giúp anh"\) không phải nội dung/);
  assert.match(invoices, /lời người dùng nêu VÌ SAO \("anh tính nhầm", "khách xin giảm"\) là lý do ⇒ `reason` nguyên\s+văn, không ghép câu yêu cầu hay tên thao tác cho đủ ký tự/);
  assert.doesNotMatch(invoices, /lời người dùng đã nói là lý do/);
  const expenses = skillText(PAGE_SKILLS.expense);
  assert.doesNotMatch(expenses, /luôn hỏi lý do/);
  assert.match(expenses, /đã nêu vì sao ⇒ gửi nguyên cụm, không tự đếm ký tự; chưa nêu,\s+hoặc máy chủ báo ngắn ⇒ hỏi; bot không tự ghép "huỷ phiếu", câu yêu cầu hay từ đệm cho đủ ký tự/);
  // Ngày bắt buộc từng trang: không tự lấy hôm nay (báo trả, trả phòng, nháp HĐ). "Hôm nay" chỉ có ở ngày thu của invoice.collect.
  assert.match(contracts, /không nói ngày ⇒ hỏi, không tự lấy hôm nay/);
  assert.match(contracts, /hỏi một câu\s+gộp, không tự lấy hôm nay, không bịa note/);
  assert.match(contracts, /Không\s+nói ngày bắt đầu ⇒ hỏi, không tự lấy hôm nay/);
  assert.match(invoices, /ngày thu mặc định hôm nay/);
  // Bỏ giữa chừng khi cùng tin đã ghi việc khác: không nói chung "chưa tạo việc nào".
  assert.match(tasks, /trong cùng tin đã tạo việc khác ⇒ nói rõ việc nào đã tạo, việc nào chưa/);
  assert.match(tasks, /`task_quota_\*` ⇒ chạm hạn mức giao việc qua bot trong một giờ, lệnh này\s+chưa tạo việc nào/);
  // HD-M02: "báo trả <ngày>" gọi ngay; chỉ "trả phòng" + ngày tương lai mới hỏi. Lý do gia hạn "khách ở tiếp" truyền nguyên văn.
  assert.doesNotMatch(contracts, /Ý còn mơ hồ \(ngày dọn đi ở tương lai\)/);
  assert.match(contracts, /Người dùng nói "báo trả <ngày>" ⇒ gọi ngay/);
  assert.match(contracts, /Chỉ khi\s+nói "trả phòng" kèm ngày dọn đi TƯƠNG LAI/);
  assert.match(contracts, /"khách ở tiếp", "khách xin ở thêm", "khách ở lâu dài"\) ⇒ truyền NGUYÊN VĂN làm `reason`, KHÔNG hỏi lại,\s+không tự đếm ký tự/);
  // HD-X11: "trả phòng hôm 3/10, quyết toán sau" ⇒ note = lời người dùng (ví dụ của SOUL dòng 22), gọi ngay.
  assert.match(contracts, /chép nguyên văn vào `note` \(vd "khách trả sớm, quyết toán sau", "quyết toán sau"/);
  assert.match(contracts, /không bịa note/);
  // HĐn C06 (SOUL dòng 24): "ck X trước, còn lại …" = thu một phần hôm nay, không gửi datePhrase. B03: tên sổ chép nguyên văn.
  assert.match(invoices, /"ck X trước, còn lại <cuối tuần \/ sau>" = thu MỘT PHẦN X hôm nay \("trước" = trả trước một phần, KHÔNG phải ngày\): không gửi\s+`datePhrase`/);
  assert.match(invoices, /"vào TK Hiệp" ⇒\s+"TK Hiệp"/);
  // Tên skill: bot hay gọi skill_view với tên dính ký tự lạ ("ihome-crm-hop-dong“}") ⇒ nhắc tên trần ở chỉ mục (DESCRIPTION) và ghi-chung.
  const description = yaml.load(/^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(SKILLS_DIR, 'DESCRIPTION.md'), 'utf8'))[1]).description;
  assert.match(description, /skill_view name = đúng một tên trần \(vd ihome-crm-ghi-chung\), không thêm ký tự/);
  assert.match(core, /`skill_view` với `name` là ĐÚNG MỘT\s+tên trần, vd `ihome-crm-hop-dong`/);
  for (const name of skillDirs()) assert.ok(description.includes(name) || core.includes(`\`${name}\``), `${name}: tên skill phải xuất hiện đúng chữ`);
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
  // crm_action_list là nguồn khuôn tham số; toà / phòng bằng tên; tiền số nguyên VND (giữ trong mô tả crm_action_run).
  assert.match(ACTION_RUN_TOOL.description, /params theo crm_action_list; tên toà\/phòng, tiền số nguyên VND/);
  // invalid_params (SOUL dòng 15 + 22, review #369, ma trận d31): sửa phần bot chọn; giá trị có trong lời người dùng ⇒ dùng / ghép
  // nguyên văn; tham số tuỳ chọn không nói ⇒ bỏ (ngày thu ⇒ hôm nay); chỉ hỏi khi chưa nói / lời không đủ (lý do chỉ "đổi ý"), không bịa.
  // askUser (lưới chặn thu tiền) ⇒ câu hỏi lại, không bao giờ câu "sửa … gọi lại" / "ghép". Lý do khác vẫn hỏi người dùng.
  const fix = needsInput({ action: 'contract.notice_cancel', reason: 'invalid_params', detail: 'Thiếu hoặc sai: reason (8–500 ký tự).' }).huongDan;
  assert.match(fix, /Sửa theo detail rồi gọi lại crm_action_run: phần do bot chọn \(tên \/ kiểu tham số, định dạng ngày, tham số thừa\)/);
  // Review #377: chỉ cụm nói VỀ chính tham số đó — "302 toà 80 huỷ báo trả, đổi ý" không được thành lý do "huỷ báo trả, đổi ý".
  assert.match(fix, /cụm người dùng nói VỀ chính tham số đó \(lý do = vì sao, vd "khách ở tiếp"\) thì dùng hoặc ghép nguyên văn/);
  assert.match(fix, /KHÔNG ghép câu yêu cầu, tên thao tác, chủ ngữ hay từ đệm cho đủ khuôn/);
  assert.match(fix, /tham số tuỳ chọn họ không nói thì bỏ \(vd ngày thu của invoice\.collect ⇒ hôm nay\)/);
  // Giá trị người dùng nói mà ngắn / sai khuôn ("đổi ý"; giữ phòng 8 giờ khi chỉ có 6 / 12 / 24) ⇒ hỏi lại, không tự đổi.
  assert.match(fix, /Giá trị người dùng nói mà ngắn \/ sai khuôn \(vd lý do chỉ "đổi ý", giữ phòng 8 giờ\) hoặc họ chưa nói ⇒ hỏi lại, không tự đổi, không bịa/);
  const ask = needsInput({ action: 'invoice.collect', reason: 'invalid_params', detail: 'Ghi chú nói CHƯA trả', askUser: true }).huongDan;
  assert.match(ask, /^CHƯA ghi\. Hỏi lại người dùng theo detail \(không đoán, không tự điền\)/);
  assert.doesNotMatch(ask, /tự sửa|Sửa theo detail|ghép/);
  assert.match(needsInput({ action: 'task.create', reason: 'name_unresolved' }).huongDan, /Hỏi lại người dùng theo detail/);
  const list = ACTION_LIST_TOOL.description;
  for (const phrase of ['tạo/giao/huỷ việc', 'tao giao huy viec', 'giữ/khoá phòng', 'giu khoa phong', 'gia hạn/báo trả HĐ', 'gia han bao tra hop dong',
    'phiếu chi', 'phieu chi', 'thu tiền hoá đơn', 'thu tien hoa don']) assert.ok(list.includes(phrase), `crm_action_list thiếu "${phrase}"`);
  // tool_search của Hermes: token [A-Za-z0-9]+ chữ thường — dạng không dấu phải ra đủ token.
  const tokens = new Set(list.toLowerCase().match(/[a-z0-9]+/g));
  for (const token of ['tao', 'giao', 'huy', 'viec', 'giu', 'khoa', 'phong', 'gia', 'han', 'bao', 'tra', 'hop', 'dong', 'phieu', 'chi', 'thu', 'tien', 'hoa', 'don'])
    assert.ok(tokens.has(token), `thiếu token ASCII "${token}"`);
});
