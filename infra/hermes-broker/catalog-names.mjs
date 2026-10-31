// Tên connector có thể quảng bá cho mô hình — tool, mã thao tác ghi, mã báo cáo — và tên tool đã nghỉ hưu kèm thay thế. Rút từ
// chính các module (định nghĩa tool của broker, danh mục thao tác mà server.mjs nạp, sổ báo cáo W2, bảng nghỉ hưu của từng họ),
// không chép danh sách tay. Dùng cho test hướng dẫn chuẩn (infra/hermes-skills, official-skills.test.mjs) và cổng kiểm học tập
// (đối chiếu skill / bộ nhớ Hermes tự học với connector hiện hành). Giữ nguyên tên các hàm export: nơi khác import đúng tên.
// external-group-mount.mjs nạp TRƯỚC broker.mjs (nó import ngược broker.mjs; như full-grant-broker.fixture.mjs) và mọi phép
// tính chạy lười trong hàm, không lúc nạp module.
import { EXTERNAL_GROUP_TOOLS } from './external-group-mount.mjs';
import { toolDefinitions } from './broker.mjs';
import { ACTION_PAGES, createActionCatalog } from './action-catalog.mjs';
import { ACTION_RUN_TOOL, ACTION_STATUS_TOOL, ACTION_TOOL_SHAPE, actionTools } from './action-contract.mjs';
import { ACTION_PAGE_CATALOGS, PRODUCTION_ACTIONS } from './action-page-catalogs.mjs';
import { TASK_TOOLS } from './task-contract.mjs';
import { TASK_INPUT_TOOLS, taskActionOperation } from './task-input-contract.mjs';
import { TASK_RETIRED_BY } from './task-actions-contract.mjs';
import { EXPENSE_RETIRED_TOOLS } from './expense-actions-contract.mjs';
import { SCHEDULE_RETIRED_BY, SCHEDULE_TOOLS, scheduleOperation } from './schedule-contract.mjs';
import { W2 } from './wave2-registry.mjs';

void EXTERNAL_GROUP_TOOLS;

const frozenSorted = values => Object.freeze([...new Set(values)].sort());
let cache;
function compute() {
  if (cache) return cache;
  // Mọi thao tác connector nạp được: production + mọi trang actionPages (như server.mjs khi bật hết). Thao tác thử probe.* (chỉ
  // connector TEST) không thuộc nghiệp vụ nên không có ở đây.
  const catalog = createActionCatalog([...PRODUCTION_ACTIONS, ...Object.values(ACTION_PAGE_CATALOGS).flat()]);
  // Tool cũ …_status ⇒ crm_action_status (tra theo requestId); còn lại ⇒ crm_action_run với thao tác thay.
  const viaActions = (name, action) => Object.freeze(name.endsWith('_status')
    ? { tool: ACTION_STATUS_TOOL.name, action } : { tool: ACTION_RUN_TOOL.name, action });
  const retired = {};
  // Công việc: thao tác SỐNG thay họ tool cũ (TASK_RETIRED_BY; broker ẩn + từ chối theo danh mục sống — production sống từ 29/10).
  for (const tool of [...TASK_TOOLS, ...TASK_INPUT_TOOLS]) {
    const operation = taskActionOperation(tool.name);
    if (Object.hasOwn(TASK_RETIRED_BY, operation)) retired[tool.name] = viaActions(tool.name, TASK_RETIRED_BY[operation]);
  }
  // Thu chi: họ crm_expense_* đã gỡ khỏi connector (TC1).
  for (const [name, action] of Object.entries(EXPENSE_RETIRED_TOOLS)) retired[name] = viaActions(name, action);
  // Lịch chữ cũ: create/update nghỉ (P6.06), lịch gửi ảnh phòng trống đi qua crm_zalo_broadcast_*.
  for (const tool of SCHEDULE_TOOLS) {
    const operation = scheduleOperation(tool.name);
    if (Object.hasOwn(SCHEDULE_RETIRED_BY, operation)) retired[tool.name] = Object.freeze({ tool: SCHEDULE_RETIRED_BY[operation] });
  }
  const retiredNames = Object.freeze(Object.fromEntries(Object.keys(retired).sort().map(name => [name, retired[name]])));
  const definitions = toolDefinitions();
  const all = [...definitions.keys(), ...actionTools(catalog, ACTION_TOOL_SHAPE).map(tool => tool.name)];
  // report=… còn là enum riêng của vài tool đọc khác (crm_read_occupancy_report upcoming, crm_read_invoice_report stats): khi kiểm
  // chữ, nhận các giá trị đó chỉ trên dòng có nhắc chính tool ấy.
  const reportEnums = Object.freeze(Object.fromEntries([...definitions].map(([name, tool]) => [name, tool.inputSchema?.properties?.report?.enum])
    .filter(([, values]) => Array.isArray(values)).map(([name, values]) => [name, Object.freeze([...values])])));
  cache = Object.freeze({
    tools: frozenSorted(all.filter(name => !Object.hasOwn(retiredNames, name))),
    actions: frozenSorted(catalog.ids),
    reports: frozenSorted(Object.keys(W2.reports)),
    reportEnums,
    retired: retiredNames,
  });
  return cache;
}

/** Tên tool hiện hành connector có thể quảng bá (mọi họ, mọi quyền; khuôn tool thao tác đang dùng), trừ tên nghỉ hưu. Mảng sắp xếp, đông cứng. */
export function catalogToolNames() { return compute().tools; }
/** Mã thao tác ghi (crm_action_run action) của danh mục production + mọi trang actionPages. Mảng sắp xếp, đông cứng. */
export function catalogActionIds() { return compute().actions; }
/** Mã báo cáo của crm_read_report (sổ W2). Mảng sắp xếp, đông cứng. */
export function catalogReportIds() { return compute().reports; }
/** Tên tool nghỉ hưu → thay thế: { [tênCũ]: { tool, action? } } — tool là tên hiện hành, action là mã thao tác (nếu đi qua crm_action_*). */
export function retiredToolNames() { return compute().retired; }

// Mẫu nhận diện tên trong văn bản. Tên tool: không đứng sau chữ/số (mcp__ihomecrm__crm_x vẫn nhận crm_x), không kết thúc bằng "_".
// Mã thao tác: <trang>.<thao tác> với mọi trang khung thao tác biết (ACTION_PAGES, gồm cả probe — không thuộc danh mục nghiệp vụ nên
// bị báo lạ). Mã báo cáo: report=<mã> hoặc "report": "<mã>".
const TOOL_MENTION = /(?<![A-Za-z0-9])crm_[a-z0-9_]*[a-z0-9]/g;
const ACTION_MENTION = new RegExp(`(?<![A-Za-z0-9_.])(?:${ACTION_PAGES.join('|')})\\.[a-z][a-z0-9_]*[a-z0-9]`, 'g');
const REPORT_MENTION = /\breport\s*=\s*["'`]?([a-z][a-z0-9_]*)|"report"\s*:\s*"([a-z][a-z0-9_]*)"/g;
const uniqueMatches = (text, pattern, pick = match => match[0]) => [...new Set([...text.matchAll(pattern)].map(pick))];

/** Tên tool / mã thao tác / mã báo cáo nhắc trong text (mỗi tên một lần, theo thứ tự xuất hiện). */
export function findCatalogMentions(text) {
  if (typeof text !== 'string') throw new TypeError('text_required');
  return { tools: uniqueMatches(text, TOOL_MENTION), actions: uniqueMatches(text, ACTION_MENTION),
    reports: uniqueMatches(text, REPORT_MENTION, match => match[1] ?? match[2]) };
}

/** Kiểm từng dòng của text: tên tool / mã thao tác / mã báo cáo phải có trong danh mục hiện hành (mã báo cáo: sổ W2, hoặc enum
 * report của tool đọc khác được nhắc cùng dòng); tên tool nghỉ hưu chỉ được nhắc trên dòng có cả tool thay (và mã thao tác thay).
 * Trả [{ line, kind, name, expected? }] — rỗng là đạt. kind: unknown_tool | retired_without_replacement | unknown_action | unknown_report. */
export function checkCatalogMentions(text) {
  if (typeof text !== 'string') throw new TypeError('text_required');
  const { tools, actions, reports: w2, reportEnums, retired } = compute();
  const problems = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const found = findCatalogMentions(line);
    const reports = new Set([...w2, ...found.tools.flatMap(name => reportEnums[name] ?? [])]);
    for (const name of found.tools) {
      if (Object.hasOwn(retired, name)) {
        const { tool, action } = retired[name];
        if (!found.tools.includes(tool) || (action !== undefined && !found.actions.includes(action))) {
          problems.push({ line: index + 1, kind: 'retired_without_replacement', name, expected: action === undefined ? tool : `${tool} ${action}` });
        }
      } else if (!tools.includes(name)) problems.push({ line: index + 1, kind: 'unknown_tool', name });
    }
    for (const name of found.actions) if (!actions.includes(name)) problems.push({ line: index + 1, kind: 'unknown_action', name });
    for (const name of found.reports) if (!reports.has(name)) problems.push({ line: index + 1, kind: 'unknown_report', name });
  });
  return problems;
}
