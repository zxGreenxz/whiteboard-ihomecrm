import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) } },
}));
import { SaleRoomOperationError, saleInventoryAtTime, parseSaleRoomInventory, type SaleRoomPatchReceipt } from '../saleRoomOperations';
import { cancelSaleRoomPolicy, runSaleRoomBatch, saveSaleRoomPolicy, validateSaleBatch, type SaleBatchCommand, type SaleBatchDraft, type SalePolicyRpcInvoker } from '../saleRoomWorkflow';
import { salePolicyIsActive, salePolicyTimeToIso } from '../saleRoomPolicyTypes';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), revision = 'a'.repeat(32);
const campaign = { title: 'Ưu đãi tháng 11', content: 'Giảm 200.000đ tháng đầu', starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' };
const policy = { ...campaign, id: id(90), version: 1, status: 'ACTIVE' as const };
const receipt = { request_id: id(20), room_id: id(2), building_id: id(3), revision: 'b'.repeat(32), policy };
const command = (n: number): SaleBatchCommand => ({ kind: 'patch', label: `Tòa A · ${n}`, input: { roomId: id(n), expectedRevision: revision, requestId: id(n + 100), patch: { rent_price: 3_000_000 + n } } });
const draft = (): SaleBatchDraft => ({ commands: [command(2), command(3), command(4)], results: [] });
const confirmed = (command: SaleBatchCommand): SaleRoomPatchReceipt => ({ room_id: command.input.roomId, request_id: command.input.requestId,
  building_id: id(10), revision: 'b'.repeat(32), updated_at: '2026-10-21T00:00:00Z', fields: command.kind === 'patch' ? command.input.patch : { sale_note: null } });

describe('Bulk updates retain per-room outcomes', () => {
  it.each(['Chủ trọ', 'Quản lý', 'Chủ công ty', 'Sale Admin', 'Sale'])('B01 %s: each permitted room uses its own revision and request identity', async () => {
    const save = vi.fn(async (item: SaleBatchCommand) => confirmed(item)); const persist = vi.fn();
    const result = await runSaleRoomBatch(org, draft(), save, persist);
    expect(save.mock.calls.map(([item]) => item.input)).toEqual(draft().commands.map(item => item.input));
    expect(result.results.map(item => item.status)).toEqual(['applied', 'applied', 'applied']);
    expect(new Set(save.mock.calls.map(([item]) => item.input.requestId)).size).toBe(3);
  });
  it('B02 manager: an obsolete room does not overwrite data or erase successes elsewhere', async () => {
    const save = vi.fn(async (item: SaleBatchCommand) => { if (item.input.roomId === id(3)) throw new SaleRoomOperationError('Đã đổi', 'conflict'); return confirmed(item); });
    const result = await runSaleRoomBatch(org, draft(), save, vi.fn());
    expect(result.results.map(item => item.status)).toEqual(['applied', 'conflict', 'applied']);
    expect(save).toHaveBeenCalledTimes(3);
    await runSaleRoomBatch(org, result, save, vi.fn());
    expect(save).toHaveBeenCalledTimes(3);
  });
  it('B03 sale admin: losing a response stops the remaining rooms; resume uses the unchanged request', async () => {
    const save = vi.fn(async (item: SaleBatchCommand) => confirmed(item));
    save.mockImplementationOnce(async item => confirmed(item)).mockRejectedValueOnce(new TypeError('offline'));
    const first = await runSaleRoomBatch(org, draft(), save, vi.fn());
    expect(first.results.map(item => item.status)).toEqual(['applied', 'unknown']);
    expect(save).toHaveBeenCalledTimes(2);
    const second = await runSaleRoomBatch(org, first, save, vi.fn());
    expect(save.mock.calls[1]).toEqual(save.mock.calls[2]);
    expect(save.mock.calls[3]?.[0].input.roomId).toBe(id(4));
    expect(second.results.every(item => item.status === 'applied')).toBe(true);
  });
  it('B04 owner: the request is durable before any write and disk failure prevents dispatch', async () => {
    const save = vi.fn(async (item: SaleBatchCommand) => confirmed(item));
    await expect(runSaleRoomBatch(org, draft(), save, () => { throw new Error('quota'); })).rejects.toThrow('quota');
    expect(save).not.toHaveBeenCalled();
    const events: string[] = [];
    await runSaleRoomBatch(org, { commands: [command(2)], results: [] }, async item => { events.push('write'); return confirmed(item); }, next => events.push(next.results[0]!.status));
    expect(events).toEqual(['saving', 'write', 'applied']);
  });
  it('B05 company owner: actor/org switch stops subsequent dispatches', async () => {
    let current = true;
    const save = vi.fn(async (item: SaleBatchCommand) => { current = false; return confirmed(item); });
    const result = await runSaleRoomBatch(org, draft(), save, vi.fn(), () => current);
    expect(save).toHaveBeenCalledTimes(1); expect(result.results).toHaveLength(1);
  });
  it('B06 sale: explicit permission revocation remains a rejected item, not success', async () => {
    const result = await runSaleRoomBatch(org, { commands: [command(2)], results: [] }, async () => { throw { code: '42501' }; }, vi.fn());
    expect(result.results[0]?.status).toBe('rejected');
  });
  it.each([
    { commands: [command(2), command(2)], results: [] },
    { commands: [command(2), { ...command(3), input: { ...command(3).input, requestId: command(2).input.requestId } }], results: [] },
    { commands: [command(2), { kind: 'patch', label: 'bad', input: { ...command(3).input, patch: { status: 'AVAILABLE' } } }], results: [] },
    { commands: Array.from({ length: 51 }, (_, index) => command(index + 2)), results: [] },
    { commands: [command(2)], results: [{ roomId: id(9), requestId: command(2).input.requestId, status: 'applied', message: 'fake' }] },
  ])('B07 preflight rejects invalid or ambiguous batches before the first write', async invalid => {
    const save = vi.fn();
    await expect(runSaleRoomBatch(org, invalid as SaleBatchDraft, save, vi.fn())).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it('B08 an interrupted saving state is replayed and an undefined thrown failure is unknown', async () => {
    const interrupted = { commands: [command(2)], results: [{ requestId: id(102), roomId: id(2), status: 'saving' as const, message: '' }] };
    const result = await runSaleRoomBatch(org, interrupted, async () => { throw undefined; }, vi.fn());
    expect(result.results[0]?.status).toBe('unknown');
    expect(validateSaleBatch(org, result).commands).toEqual(interrupted.commands);
  });
  it.each([['unknown', '42501'], ['saving', '40001']] as const)('B09 uncertain %s replay error %s cannot disprove an earlier commit', async (status, code) => {
    const previous: SaleBatchDraft = { ...draft(), results: [{ requestId: id(102), roomId: id(2), status, message: '' }] };
    const replay = vi.fn().mockRejectedValue({ code });
    const result = await runSaleRoomBatch(org, previous, replay, vi.fn());
    expect(result.results[0]?.status).toBe('unknown'); expect(replay).toHaveBeenCalledTimes(1);
    expect(result.commands).toEqual(previous.commands);
  });
});

describe('Timed policy receipts and boundaries', () => {
  const input = { roomId: id(2), requestId: id(20), expectedRevision: revision, policy: campaign };
  it('P01 sale admin: save directly, without a pending approval state', async () => {
    const rpc = vi.fn<SalePolicyRpcInvoker>().mockResolvedValue({ data: receipt, error: null });
    expect(await saveSaleRoomPolicy(rpc, org, input)).toEqual(receipt);
    expect(rpc).toHaveBeenCalledWith('save_room_sale_policy_v1', { p_organization_id: org, p_room_id: id(2), p_request_id: id(20), p_expected_revision: revision, p_policy: campaign });
  });
  it.each([
    { ...receipt, request_id: id(21) }, { ...receipt, room_id: id(3) },
    { ...receipt, policy: { ...policy, content: 'Đổi giá trái ý' } },
    { ...receipt, policy: { ...policy, ends_at: '2027-01-01T00:00:00Z' } },
    { ...receipt, policy: { ...policy, status: 'CANCELLED' } }, null,
  ])('P02 receipt must match room, request, exact content and period', async response => {
    await expect(saveSaleRoomPolicy(async () => ({ data: response, error: null }), org, input)).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it.each([
    { ...campaign, ends_at: campaign.starts_at }, { ...campaign, ends_at: '2026-01-01T00:00:00Z' },
    { ...campaign, content: '' }, { ...campaign, title: 'x'.repeat(121) },
    { ...campaign, approved: true }, { ...campaign, starts_at: '01/11/2026' },
  ])('P03 invalid policy is rejected before dispatch', async value => {
    const rpc = vi.fn();
    await expect(saveSaleRoomPolicy(rpc, org, { ...input, policy: value })).rejects.toMatchObject({ outcome: 'rejected' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('P04 lost acknowledgement is reconciled with the original UUID', async () => {
    const rpc = vi.fn<SalePolicyRpcInvoker>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: receipt, error: null });
    await expect(saveSaleRoomPolicy(rpc, org, input)).rejects.toMatchObject({ outcome: 'unknown' });
    await saveSaleRoomPolicy(rpc, org, input); expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it('P05 cancellation requires the matching policy and its next version', async () => {
    const cancel = { roomId: id(2), policyId: id(90), expectedVersion: 1, requestId: id(20), reason: 'Dừng chương trình' };
    const good = { ...receipt, policy: { ...policy, version: 2, status: 'CANCELLED' } };
    await expect(cancelSaleRoomPolicy(async () => ({ data: good, error: null }), org, cancel)).resolves.toEqual(good);
    await expect(cancelSaleRoomPolicy(async () => ({ data: { ...good, policy: { ...good.policy, version: 3 } }, error: null }), org, cancel)).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it('P06 Vietnam input is timezone-independent and rejects impossible dates', () => {
    expect(salePolicyTimeToIso('2026-11-01T07:00')).toBe('2026-11-01T00:00:00.000Z');
    expect(() => salePolicyTimeToIso('2026-02-30T07:00')).toThrow();
    expect(() => salePolicyTimeToIso('2026-11-01')).toThrow();
  });
  it('P07 exact boundaries include the start and exclude the end, even offline', () => {
    const start = Date.parse(policy.starts_at), end = Date.parse(policy.ends_at);
    expect(salePolicyIsActive(policy, start - 1)).toBe(false);
    expect(salePolicyIsActive(policy, start)).toBe(true);
    expect(salePolicyIsActive(policy, end - 1)).toBe(true);
    expect(salePolicyIsActive(policy, end)).toBe(false);
    expect(salePolicyIsActive({ ...policy, status: 'CANCELLED' }, start)).toBe(false);
  });
  it('P08 quick board, Excel and image data share effective policy; editing always uses base text', () => {
    const data = parseSaleRoomInventory({ server_now: campaign.starts_at,
      buildings: [{ id: id(3), name: 'Tòa A', code: null, district: null, ward: null, address: null, total_floors: 1, images: [] }],
      rooms: [{ id: id(2), building_id: id(3), floor: 1, name: '101', code: null, area: 20, rent_price: 3e6, max_occupants: 2,
        amenities: [], images: [], description: null, sale_note: 'Wifi miễn phí', status_public: 'free', avail_date: null,
        revision, updated_at: campaign.starts_at, policy, capabilities: { edit: true, images: true, pass: false, lock: false, releaseLock: false, deposit: false } }],
    });
    const active = saleInventoryAtTime(data, Date.parse(campaign.starts_at));
    expect(active.rooms[0]?.saleNote).toBe('Wifi miễn phí');
    expect(active.rooms[0]?.room.saleNote).toBe(`Wifi miễn phí\n${campaign.content}`);
    expect(active.buildings[0]?.rooms[0]?.saleNote).toBe(active.rooms[0]?.room.saleNote);
    expect(active.nextPolicyBoundaryAt).toBe('2026-12-01T00:00:00.000Z');
    const expired = saleInventoryAtTime(active, Date.parse(campaign.ends_at));
    expect(expired.rooms[0]?.policy?.status).toBe('EXPIRED');
    expect(expired.buildings[0]?.rooms[0]?.saleNote).toBe('Wifi miễn phí');
    expect(expired.rooms[0]?.activePolicyText).toBeNull();
  });
});
