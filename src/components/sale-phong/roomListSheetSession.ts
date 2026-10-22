import { z } from 'zod';
import type { Room } from '@/pages/phong-trong/sampleData';
import type { PublicRoomSettings } from '@/hooks/usePublicRoomSettings';
import type { SheetRoomRequest } from '@/hooks/useSaveRoomListSheet';
import { saleRoomPatchSchema } from '@/lib/saleRoomOperations';
import { EMPTY_SHEET_EDITS, type SheetEdits } from './roomListSheetDraft';

export interface SheetSession {
  edits: SheetEdits;
  bases: Record<string, { room: Room; revision: string }>;
  phoneBases: Record<string, string | null>;
  requests: Record<string, SheetRoomRequest & { outcome?: 'unknown' | 'conflict' | 'rejected' }>;
  account?: { form: PublicRoomSettings; days: string; original: PublicRoomSettings };
  hotline?: string;
}
export const newSheetSession = (): SheetSession => ({ edits: EMPTY_SHEET_EDITS, bases: {}, phoneBases: {}, requests: {} });
const textMap = z.record(z.string());
const roomSchema = z.object({
  id: z.string(), buildingId: z.string(), code: z.string(), price: z.number(), area: z.number(),
  type: z.string(), amenities: z.array(z.string()), status: z.enum(['free', 'soon', 'rented', 'pass', 'locked']),
  saleNote: z.string().nullable().optional(), saleStatusNote: z.string().nullable().optional(), saleFactKey: z.string().nullable().optional(),
}).passthrough();
const settingsSchema = z.object({ soon_days: z.number(), show_rented: z.boolean(), hotline_id: z.string().nullable(), sale_policy: z.string().nullable() });
const sessionSchema = z.object({
  edits: z.object({ phones: textMap, policies: textMap, prices: textMap, types: textMap, amenities: textMap, statuses: textMap }),
  bases: z.record(z.object({ room: roomSchema, revision: z.string().regex(/^[a-f0-9]{32}$/) })),
  phoneBases: z.record(z.string().nullable()),
  requests: z.record(z.object({ input: z.object({ roomId: z.string().uuid(), requestId: z.string().uuid(), expectedRevision: z.string().regex(/^[a-f0-9]{32}$/), patch: saleRoomPatchSchema }),
    keys: z.array(z.string()), outcome: z.enum(['unknown', 'conflict', 'rejected']).optional() })),
  account: z.object({ form: settingsSchema, days: z.string(), original: settingsSchema }).optional(),
  hotline: z.string().optional(),
});
export function readSheetSession(key: string): SheetSession {
  try {
    const parsed = sessionSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
    if (parsed.success) {
      const restored = parsed.data as unknown as SheetSession;
      // A prepared request can have reached the server before the tab disappeared.
      // Reconcile that exact identity even when no catch/finally callback ran.
      return { ...restored, requests: Object.fromEntries(Object.entries(restored.requests)
        .map(([id, request]) => [id, { ...request, outcome: request.outcome ?? 'unknown' }])) };
    }
  } catch {
    // Optional local draft cache may be malformed or unavailable; fresh server data remains authoritative.
  }
  return newSheetSession();
}
