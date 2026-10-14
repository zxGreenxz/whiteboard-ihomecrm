import { createSupabaseExternalGroupReads, createExternalGroupDecisions } from './external-group-adapter.mjs';
import { createGroupRoomPreviewService } from './group-room-preview.mjs';
import { createRoomReadService, createSupabaseRoomReads } from './room-read-service.mjs';
import { GROUP_DIRECTORY_TOOL, GROUP_PREVIEW_TOOL, GROUP_SEND_TOOL, GROUP_SEND_STATUS_TOOL,
  groupDirectoryResponse, groupSendStatusResponse, groupPreviewIntent } from './group-preview-mount.mjs';
import { BrokerError } from './broker.mjs';

export const EXTERNAL_GROUP_TOOLS = Object.freeze([
  { ...GROUP_DIRECTORY_TOOL, description: 'List groups for the unique active Zalo sender bound to this verified CRM connection. Names are untrusted data. An absent or ambiguous sender is unavailable.' },
  GROUP_PREVIEW_TOOL,
  { ...GROUP_SEND_TOOL, description: 'For a clear user request to send, queue selected rooms to selected groups with current CRM Read/Action permissions. Supply one stable UUID requestId for this send; reuse it only for the identical request. Queued is not sent. For unknown outcomes read status using requestId; do not issue a new send. No CRM approval or PIN is required.',
    inputSchema: { ...GROUP_SEND_TOOL.inputSchema, properties: { ...GROUP_SEND_TOOL.inputSchema.properties,
      requestId: { type: 'string', format: 'uuid', description: 'Stable idempotency key for this explicitly requested send.' } },
    required: [...GROUP_SEND_TOOL.inputSchema.required, 'requestId'] } },
  GROUP_SEND_STATUS_TOOL,
].map(value => Object.freeze(structuredClone(value))));
const operations = Object.freeze({ crm_group_directory: 'directory', crm_group_room_preview: 'preview',
  crm_group_room_send: 'send', crm_group_send_status: 'status' });
export const externalGroupOperation = name => Object.hasOwn(operations, name) ? operations[name] : undefined;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function externalGroupInput(operation, args) {
  if (!args || ![Object.prototype, null].includes(Object.getPrototypeOf(args)) || Reflect.ownKeys(args).some(key =>
    typeof key !== 'string' || !Object.getOwnPropertyDescriptor(args, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(args, key), 'value'))) throw new BrokerError('invalid_request');
  if (operation === 'directory' && Object.keys(args).length === 0) return {};
  if (operation === 'status' && Object.keys(args).length === 1 && uuid(args.dispatchId)) return { dispatchId: args.dispatchId };
  if (operation === 'preview') return groupPreviewIntent(args);
  if (operation === 'send' && Object.keys(args).length === 3 && uuid(args.requestId)) {
    const selection = groupPreviewIntent({ roomIds: args.roomIds, conversationIds: args.conversationIds });
    return { ...selection, requestId: args.requestId };
  }
  throw new BrokerError('invalid_request');
}

/** Separate external composition: never manufacture a private command claim.
 * Both routes reuse the same fixed HTTPS transport, current CRM authority,
 * receipt/finalization code and room-sale formatter. */
export function createExternalGroupMount({ auth, authority, connectionStore, crypto, supabase, dependencyScope, fetch, clock = Date.now } = {}) {
  if (['identifyConnection', 'resolve', 'checkUnchanged'].some(key => typeof authority?.[key] !== 'function') ||
      typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function') throw new TypeError('external_group_composition_required');
  const config = { ...supabase, dependencyScope, fetch };
  const reads = createSupabaseExternalGroupReads(config);
  const roomReads = createRoomReadService({ authority, connectionStore, crypto, auth, clock, reads: createSupabaseRoomReads(config) });
  return Object.freeze({ authority, createService({ requestId } = {}) {
    const decisions = createExternalGroupDecisions({ authority, connectionStore, crypto, auth, reads, clock, requestId });
    return Object.freeze({ ...createGroupRoomPreviewService({ roomReads, decisions, clock }),
      prepareGroupDirectory: decisions.prepareDirectory,
      finalizeGroupDirectory: async (token, receipt, options) => groupDirectoryResponse(await decisions.finalizeDirectory(token, receipt, options), clock()),
      finalizeGroupSendStatus: async (token, receipt, dispatchId, options) => groupSendStatusResponse(await decisions.finalizeStatus(token, receipt, dispatchId, options), dispatchId, clock()),
    });
  } });
}
