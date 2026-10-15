import { createGroupOriginReads, createGroupOriginDecisions } from './group-preview-adapter.mjs';

// Fixed external origin. The shared implementation validates exactly eight
// binding keys and uses distinct fixed RPCs; no DM identity is fabricated.
export const createSupabaseExternalGroupReads = options => createGroupOriginReads(options, 'external_mcp');
export const createExternalGroupDecisions = options => createGroupOriginDecisions(options, 'external_mcp');
