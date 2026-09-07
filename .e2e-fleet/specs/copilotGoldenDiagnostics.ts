import { readFileSync } from 'node:fs';

// Read only the fixed source files assembled by buildRegistryDefinitions.
// Do not import the product registry: it initializes the authenticated client.
const toolSources = ['registry.ts','nghiepVuTools.ts','writeTools.ts','planTools.ts','memoryTools.ts'];
const knownTools = new Set(toolSources.flatMap(file => {
  const source = readFileSync(new URL(`../../src/copilot/tools/${file}`, import.meta.url), 'utf8');
  return [...source.matchAll(/^\s*name:\s*'([a-z_][a-z0-9_]*)'/gm)].map(match => match[1]);
}));
if (!['tim_hop_dong','chi_tiet_hop_dong','tim_khach_hang'].every(name => knownTools.has(name))) throw new Error('Golden diagnostic tool sources unavailable');
export function diagnosticToolName(value: unknown): string {
  return typeof value === 'string' && knownTools.has(value) ? value : 'other';
}
const ENDPOINTS = {
  '/rest/v1/rpc/copilot_available_rooms_v1': 'available_rooms',
  '/rest/v1/rpc/copilot_contract_search_v1': 'contract_search',
  '/rest/v1/rpc/copilot_contract_detail_v1': 'contract_detail',
  '/rest/v1/rpc/copilot_customer_search_v1': 'customer_search',
  '/rest/v1/rpc/copilot_invoice_search_v1': 'invoice_search',
  '/rest/v1/rpc/copilot_expiring_contracts_v1': 'expiring_contracts',
  '/rest/v1/rpc/get_my_copilot_availability_v1': 'availability',
  '/rest/v1/rpc/get_my_permissions': 'permissions',
  '/rest/v1/rpc/copilot_memory_list_v1': 'memory_list',
  '/rest/v1/rpc/copilot_memory_upsert_v1': 'memory_upsert',
  '/rest/v1/rpc/copilot_memory_forget_v1': 'memory_forget',
  '/rest/v1/rpc/copilot_plan_create_v1': 'plan_create',
  '/rest/v1/rpc/copilot_plan_execute_step_v1': 'plan_execute',
  '/rest/v1/rpc/copilot_preview_income_expense_v1': 'income_expense_preview',
  '/rest/v1/rpc/copilot_execute_income_expense_v1': 'income_expense_execute',
  '/rest/v1/ai_chat_threads': 'chat_threads',
  '/rest/v1/ai_chat_messages': 'chat_messages',
  '/functions/v1/llm-proxy': 'model',
} as const;
type DiagnosticEndpoint = typeof ENDPOINTS[keyof typeof ENDPOINTS] | 'other_rpc' | 'other_edge' | 'other_rest' | 'other';
const endpointNames = new Set<string>([...Object.values(ENDPOINTS),'other_rpc','other_edge','other_rest','other']);
export function diagnosticEndpoint(value: unknown): DiagnosticEndpoint {
  if (typeof value !== 'string') return 'other';
  let path: string;
  try { path = new URL(value).pathname; } catch { return 'other'; }
  if (Object.hasOwn(ENDPOINTS,path)) return ENDPOINTS[path as keyof typeof ENDPOINTS];
  return path.startsWith('/rest/v1/rpc/') ? 'other_rpc' : path.startsWith('/functions/v1/') ? 'other_edge' : path.startsWith('/rest/v1/') ? 'other_rest' : 'other';
}
export interface GoldenCallDiagnostic {
  endpoint: DiagnosticEndpoint;
  httpStatus: number | null;
  countedAsMutation: boolean;
}
export interface GoldenCallDiagnostics {
  kind: 'golden-call-diagnostics'; caseId: string; tools: string[];
  calls: GoldenCallDiagnostic[]; truncated: boolean;
}
function exactKeys(value: unknown, fields: string[]): value is Record<string,unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key)));
}
/** Independent reporter boundary: validate every field then reconstruct only
 * enum values and counts. Unknown worker strings are suppressed, not relayed. */
export function safeGoldenCallDiagnostics(value: unknown): GoldenCallDiagnostics | undefined {
  if (!exactKeys(value,['kind','caseId','tools','calls','truncated']) || value.kind !== 'golden-call-diagnostics'
    || typeof value.caseId !== 'string' || !/^C(?:0[1-9]|[1-6]\d|7[0-5])$/.test(value.caseId)
    || typeof value.truncated !== 'boolean' || !Array.isArray(value.tools) || value.tools.length > 40
    || !value.tools.every(name => typeof name === 'string' && (name === 'other' || knownTools.has(name)))
    || !Array.isArray(value.calls) || value.calls.length > 60) return;
  const calls: GoldenCallDiagnostic[] = [];
  for (const call of value.calls) {
    if (!exactKeys(call,['endpoint','httpStatus','countedAsMutation']) || typeof call.endpoint !== 'string' || !endpointNames.has(call.endpoint)
      || typeof call.countedAsMutation !== 'boolean'
      || !(call.httpStatus === null || (typeof call.httpStatus === 'number' && Number.isInteger(call.httpStatus) && call.httpStatus >= 100 && call.httpStatus <= 599))) return;
    calls.push({ endpoint: call.endpoint as DiagnosticEndpoint, httpStatus: call.httpStatus as number | null, countedAsMutation: call.countedAsMutation });
  }
  return { kind: 'golden-call-diagnostics', caseId: value.caseId, tools: [...value.tools], calls, truncated: value.truncated };
}
