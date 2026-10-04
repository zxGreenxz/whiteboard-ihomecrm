import { z } from 'zod';
import { mutationSchema, normalizeMutation, type Mutation, type Receipt } from './contract';
import { PersonalFinanceError, mapFinanceError } from './service';

const pendingSchema = z.object({
  ownerId: z.string().uuid(),
  requestKey: z.string().uuid(),
  payload: mutationSchema,
});
export type PendingRequest = z.infer<typeof pendingSchema>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const prefix = 'ihome:personal-finance:pending:';
const flights = new Map<string, Promise<Receipt>>();
const listeners = new Set<() => void>();
export const subscribePending = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
const changed = () => listeners.forEach(fn => fn());

export function createPendingRequests(storage: StoragePort, actor: () => Promise<string | null>) {
  const storageKey = (owner: string, key: string) => `${prefix}${owner}:${key}`;
  const read = (ownerId: string, key: string): PendingRequest | null => {
    const raw = storage.getItem(storageKey(ownerId, key));
    if (!raw) return null;
    try {
      const result = pendingSchema.parse(JSON.parse(raw));
      if (result.ownerId !== ownerId || result.requestKey !== key) throw Error();
      return result;
    } catch {
      throw new PersonalFinanceError('internal', 'Yêu cầu đang chờ trên máy bị lỗi. Giữ nguyên nháp và kiểm tra ví trước khi nhập lại.');
    }
  };
  const list = (ownerId: string): PendingRequest[] => {
    const start = `${prefix}${ownerId}:`;
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
    return keys.flatMap(key => {
      if (!key?.startsWith(start)) return [];
      const request = read(ownerId, key.slice(start.length));
      return request ? [request] : [];
    });
  };
  const assertActor = async (ownerId: string) => {
    if(await actor()!==ownerId) throw new PersonalFinanceError('permission', 'Phiên đăng nhập đã thay đổi. Yêu cầu vẫn được giữ cho chủ ví.', null, true);
  };
  const prepare = (ownerId: string, input: unknown, requestKey:string=crypto.randomUUID()): PendingRequest => {
    const request = pendingSchema.parse({ ownerId, requestKey, payload: normalizeMutation(input) });
    const existing = read(ownerId, requestKey);
    if (existing) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(request.payload)) {
        throw new PersonalFinanceError('conflict', 'Yêu cầu đang chờ chỉ được gửi lại y nguyên.', null, true);
      }
      return existing;
    }
    // One storage key per operation also prevents two tabs from overwriting each other's requests.
    // Persist synchronously BEFORE any request; blocked storage must fail closed.
    storage.setItem(storageKey(ownerId, requestKey), JSON.stringify(request));
    changed();
    return request;
  };
  const remove = (request: PendingRequest) => {
    storage.removeItem(storageKey(request.ownerId, request.requestKey));
    changed();
  };
  const run = (pending: PendingRequest, send: (key: string, payload: Mutation) => Promise<Receipt>): Promise<Receipt> => {
    const flightKey = `${pending.ownerId}:${pending.requestKey}`;
    const current = flights.get(flightKey);
    if (current) {
      prepare(pending.ownerId, pending.payload, pending.requestKey);
      return current;
    }
    const work = (async () => {
      await assertActor(pending.ownerId);
      const saved = prepare(pending.ownerId, pending.payload, pending.requestKey);
      try {
        await assertActor(saved.ownerId);
        const receipt = await send(saved.requestKey, saved.payload);
        await assertActor(saved.ownerId);
        remove(saved);
        return receipt;
      } catch (error) {
        const mapped = mapFinanceError(error);
        if (!mapped.outcomeUnknown && mapped.kind !== 'network' && mapped.kind !== 'internal') remove(saved);
        throw mapped;
      }
    })().finally(() => { flights.delete(flightKey); });
    flights.set(flightKey, work);
    return work;
  };
  return { list, prepare, run };
}
