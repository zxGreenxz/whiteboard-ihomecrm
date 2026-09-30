import { z } from 'zod';
import { FinancialPendingStorageError } from './financialPending';
import type { LuckyProof } from './luckyDrawApi';

const schema = z.array(z.object({ path: z.string().min(1), name: z.string().min(1), at: z.string().optional() })).max(10);
const key = (eventId: string, teamId: string) => 'ihome:lucky-proof-pending:v1:' + [eventId, teamId].map(encodeURIComponent).join(':');
export function readPendingLuckyProofs(eventId: string, teamId: string): LuckyProof[] {
  try {
    const raw = localStorage.getItem(key(eventId, teamId));
    if (!raw) return [];
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.some(p => !p.path.startsWith(eventId + '/')) || new Set(parsed.data.map(p => p.path)).size !== parsed.data.length) throw new FinancialPendingStorageError();
    return parsed.data.map(p=>({path:p.path,name:p.name,...(p.at?{at:p.at}:{})}));
  } catch { throw new FinancialPendingStorageError(); }
}
function write(eventId: string, teamId: string, paths: LuckyProof[]) {
  try {
    if (paths.length) localStorage.setItem(key(eventId, teamId), JSON.stringify(paths));
    else localStorage.removeItem(key(eventId, teamId));
  } catch { throw new FinancialPendingStorageError(); }
}
export function retainUploadedLuckyProof(eventId: string, teamId: string, proof: LuckyProof): LuckyProof[] {
  if (!proof.path.startsWith(eventId + '/')) throw new FinancialPendingStorageError();
  const prior = readPendingLuckyProofs(eventId, teamId);
  const next = [...new Map([...prior, proof].map(p => [p.path, p])).values()];
  write(eventId, teamId, next);
  return next;
}
export function confirmPendingLuckyProofs(eventId: string, teamId: string, confirmed: readonly LuckyProof[]): LuckyProof[] {
  const next = readPendingLuckyProofs(eventId, teamId).filter(p => !confirmed.some(saved => saved.path === p.path));
  write(eventId, teamId, next);
  return next;
}


// Planned uploads are distinct from positive upload receipts and must never be attached blindly.
export function readUnconfirmedLuckyUploads(eventId: string, teamId: string): LuckyProof[] {
  return readPendingLuckyProofs(eventId, 'upload:' + teamId);
}
export function retainPlannedLuckyUpload(eventId: string, teamId: string, proof: LuckyProof): LuckyProof[] {
  return retainUploadedLuckyProof(eventId, 'upload:' + teamId, proof);
}
export function confirmPlannedLuckyUpload(eventId: string, teamId: string, proof: LuckyProof): LuckyProof[] {
  return confirmPendingLuckyProofs(eventId, 'upload:' + teamId, [proof]);
}
