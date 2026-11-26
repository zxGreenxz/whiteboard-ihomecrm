// @vitest-environment jsdom
// Đợt 8 (luật 5): link công khai (tạo, đổi nhãn, thu hồi, xoá) không còn giữ dấu «chờ đối chiếu». Ba kịch bản cho mỗi
// thao tác: lệnh không tới máy chủ; tới nhưng mất phản hồi; dấu bản trước gieo sẵn. Thu hồi là thao tác BẢO MẬT: sau một
// lần chưa rõ, không bao giờ báo như đã thu hồi; lần bấm sau đọc lại trạng thái link rồi mới quyết gửi.
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { success: io.success, info: io.info, error: io.error } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));

type Hooks = typeof import('../usePublicRoomTokens');
let hooks: Hooks;
type Row = Record<string, unknown>;
const T = 'public_room_share_tokens';
/** btrim(text) của PostgreSQL chỉ cắt dấu cách, không cắt tab / xuống dòng / khoảng trắng Unicode. */
const pgBtrim = (value: string) => value.replace(/^ +| +$/g, '');
const pgLabel = (value: unknown) => { const label = pgBtrim(typeof value === 'string' ? value : ''); return label === '' ? null : label; };
let seq = 0;

/** Máy chủ giả theo thân hàm production create_public_room_token / manage_public_room_token_v1 / list_public_room_tokens_v1. */
function tokenServer(): FakeRecordServer {
  const server = fakeRecordServer();
  const rows = () => (server.rows[T] ??= []);
  server.rpcHandlers.create_public_room_token = (args) => {
    const row: Row = { token: `tk${++seq}`, owner_id: 'actor', organization_id: args.p_organization_id ?? null, label: pgLabel(args.p_label), revoked: false, created_at: new Date().toISOString() };
    rows().push(row);
    return { data: { ...row }, error: null };
  };
  server.rpcHandlers.manage_public_room_token_v1 = (args) => {
    const wanted = args.p_token;
    const row = rows().find(item => item.token === wanted && item.organization_id === args.p_organization_id);
    if (!row) return args.p_action === 'delete' ? { data: { token: args.p_token, removed: false }, error: null } : { data: null, error: { code: 'P0002', message: 'public_room_token_not_found' } };
    if (args.p_action === 'delete') { server.rows[T] = rows().filter(item => item !== row); return { data: { ...row, removed: true }, error: null }; }
    if (args.p_action === 'rename') row.label = pgLabel(args.p_label);
    else row.revoked = args.p_action === 'revoke';
    return { data: { ...row, removed: false }, error: null };
  };
  server.rpcHandlers.list_public_room_tokens_v1 = (args) => ({ data: rows().filter(item => item.organization_id === args.p_organization_id).map(item => ({ ...item, owner_name: null, can_manage: true })), error: null });
  return server;
}
const calls = (action?: string) => io.server.rpcCalls.filter(call => call.name === (action ? 'manage_public_room_token_v1' : 'create_public_room_token') && (!action || call.args.p_action === action)).length;
const link = (token: string) => io.server.rows[T]?.find(row => row.token === token);
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
const seedLink = (token: string, over: Row = {}) => { (io.server.rows[T] ??= []).push({ token, owner_id: 'actor', organization_id: 'org-1', label: 'Sale', revoked: false, created_at: '2026-11-20T00:00:00Z', ...over }); };
const legacy = (businessKey: string) => seedLegacyPending({ namespace: 'public-room-admin', userId: 'actor', organizationId: 'actor-scope', businessKey }, new Date(Date.now() - 10 * 60_000));

beforeEach(async () => {
  vi.clearAllMocks(); localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-1');
  io.server = tokenServer();
  vi.resetModules();
  hooks = await import('../usePublicRoomTokens');
});
afterEach(cleanup);

describe('tạo link', () => {
  it('lệnh không tới máy chủ: báo chưa rõ, KHÔNG để dấu; bấm lại tạo được ngay', async () => {
    io.server.failNext('create_public_room_token', 'rpc', 'drop-before');
    const h = renderHook(() => hooks.useCreatePublicRoomToken({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync('Sale A')).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toEqual([]);
    await act(async () => { await expect(h.result.current.mutateAsync('Sale A')).resolves.toMatchObject({ label: 'Sale A', revoked: false }); });
    expect(io.server.rows[T]).toHaveLength(1);
  });

  it('tới nhưng mất phản hồi: lần bấm sau báo link đã tạo kèm mã, KHÔNG tạo link thứ hai; bấm tiếp mới là link mới', async () => {
    io.server.failNext('create_public_room_token', 'rpc', 'drop-after');
    const h = renderHook(() => hooks.useCreatePublicRoomToken({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync('Sale B')).rejects.toMatchObject({ outcome: 'unknown' }); });
    const first = io.server.rows[T]![0].token as string;
    await act(async () => { await expect(h.result.current.mutateAsync('Sale B')).rejects.toMatchObject({ message: expect.stringContaining(first) }); });
    expect(calls()).toBe(1);
    expect(io.server.rows[T]).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
    // Người dùng đã thấy mã link cũ; bấm thêm lần nữa là ý định tạo link mới.
    await act(async () => { await expect(h.result.current.mutateAsync('Sale B')).resolves.toMatchObject({ label: 'Sale B' }); });
    expect(io.server.rows[T]).toHaveLength(2);
  });

  it('đọc link của lần chưa rõ bị hỏng ⇒ KHÔNG coi là «chưa có»: không tạo, báo chưa rõ; đọc được rồi mới quyết', async () => {
    io.server.failNext('create_public_room_token', 'rpc', 'drop-after');
    const h = renderHook(() => hooks.useCreatePublicRoomToken({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync('Sale E')).rejects.toMatchObject({ outcome: 'unknown' }); });
    io.server.failNext(T, 'read', 'drop-before');
    await act(async () => { await expect(h.result.current.mutateAsync('Sale E')).rejects.toMatchObject({ outcome: 'unknown', message: expect.stringContaining('Chưa kiểm được link') }); });
    expect(calls()).toBe(1);
    const first = io.server.rows[T]![0].token as string;
    await act(async () => { await expect(h.result.current.mutateAsync('Sale E')).rejects.toMatchObject({ outcome: 'failure', message: expect.stringContaining(first) }); });
    expect(calls()).toBe(1);
    expect(io.server.rows[T]).toHaveLength(1);
  });

  it('dấu khoá chung bản trước gieo sẵn: không chặn, tạo xong thì dấu được gỡ', async () => {
    const marker = legacy('token-create');
    const h = renderHook(() => hooks.useCreatePublicRoomToken({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync('Sale C')).resolves.toMatchObject({ label: 'Sale C' }); });
    expect(localStorage.getItem(marker)).toBeNull();
  });

  it('nhãn có ký tự tab / xuống dòng ở đầu cuối: gửi nhãn đã cắt nên biên nhận khớp, không kẹt «chưa rõ»', async () => {
    const h = renderHook(() => hooks.useCreatePublicRoomToken({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync('\tSale D\n')).resolves.toMatchObject({ label: 'Sale D' }); });
    expect(io.server.rpcCalls[0].args).toMatchObject({ p_label: 'Sale D', p_organization_id: 'org-1' });
    await act(async () => { await expect(h.result.current.mutateAsync('\t  ')).resolves.toMatchObject({ label: null }); });
    expect(pendingKeys()).toEqual([]);
  });
});

describe('thu hồi link (bảo mật)', () => {
  it('thu hồi mất phản hồi ⇒ không báo đã thu hồi; bấm lại đọc trạng thái: đã thu hồi thì báo, KHÔNG gửi lệnh thứ hai; đúng một trạng thái', async () => {
    seedLink('room-a');
    io.server.failNext('manage_public_room_token_v1', 'rpc', 'drop-after');
    const h = renderHook(() => hooks.useSetTokenRevoked({ inlineError: true }), { wrapper });
    let first: unknown;
    await act(async () => { first = await h.result.current.mutateAsync({ token: 'room-a', revoked: true }).catch((error: unknown) => error); });
    expect(first).toMatchObject({ outcome: 'unknown', message: expect.stringContaining('có thể vẫn đang hoạt động') });
    expect(io.success).not.toHaveBeenCalled();
    expect(pendingKeys()).toEqual([]);
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-a', revoked: true })).resolves.toMatchObject({ token: 'room-a', revoked: true }); });
    expect(calls('revoke')).toBe(1);
    expect(link('room-a')).toMatchObject({ revoked: true });
    expect(io.success).toHaveBeenCalledOnce();
    expect(String(io.success.mock.calls[0][0])).toContain('thu hồi');
  });

  it('thu hồi không tới máy chủ ⇒ link vẫn hoạt động; bấm lại gửi thu hồi NGAY (không chờ 2 phút)', async () => {
    seedLink('room-b');
    io.server.failNext('manage_public_room_token_v1', 'rpc', 'drop-before');
    const h = renderHook(() => hooks.useSetTokenRevoked({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-b', revoked: true })).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(link('room-b')).toMatchObject({ revoked: false });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-b', revoked: true })).resolves.toMatchObject({ revoked: true }); });
    expect(calls('revoke')).toBe(2);
    expect(link('room-b')).toMatchObject({ revoked: true });
  });

  it('đọc lại trạng thái hỏng ⇒ vẫn gửi thu hồi (thu hồi lặp lại vô hại), không bao giờ coi như đã thu hồi', async () => {
    seedLink('room-c');
    io.server.failNext('manage_public_room_token_v1', 'rpc', 'drop-before');
    const h = renderHook(() => hooks.useSetTokenRevoked({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-c', revoked: true })).rejects.toMatchObject({ outcome: 'unknown' }); });
    io.server.failNext('list_public_room_tokens_v1', 'rpc', 'drop-before');
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-c', revoked: true })).resolves.toMatchObject({ revoked: true }); });
    expect(link('room-c')).toMatchObject({ revoked: true });
  });

  it('dấu bản trước gieo sẵn của link: không chặn; đọc trạng thái, thu hồi, gỡ dấu', async () => {
    seedLink('room-d');
    const marker = legacy('token:room-d');
    const h = renderHook(() => hooks.useSetTokenRevoked({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-d', revoked: true })).resolves.toMatchObject({ revoked: true }); });
    expect(link('room-d')).toMatchObject({ revoked: true });
    expect(localStorage.getItem(marker)).toBeNull();
  });

  it('dấu bản trước của link mà link ĐÃ thu hồi: báo đã thu hồi, không gửi lệnh', async () => {
    seedLink('room-e', { revoked: true });
    legacy('token:room-e');
    const h = renderHook(() => hooks.useSetTokenRevoked({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-e', revoked: true })).resolves.toMatchObject({ revoked: true }); });
    expect(calls('revoke')).toBe(0);
    expect(pendingKeys()).toEqual([]);
  });

  it('khôi phục mất phản hồi rồi bấm lại: một trạng thái hoạt động, không đảo lại', async () => {
    seedLink('room-f', { revoked: true });
    io.server.failNext('manage_public_room_token_v1', 'rpc', 'drop-after');
    const h = renderHook(() => hooks.useSetTokenRevoked({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-f', revoked: false })).rejects.toMatchObject({ outcome: 'unknown' }); });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-f', revoked: false })).resolves.toMatchObject({ revoked: false }); });
    expect(link('room-f')).toMatchObject({ revoked: false });
    expect(calls('restore')).toBe(1);
  });
});

describe('đổi nhãn và xoá link', () => {
  it('đổi nhãn mất phản hồi: bấm lại ghi lại đúng nhãn, không dấu', async () => {
    seedLink('room-g');
    io.server.failNext('manage_public_room_token_v1', 'rpc', 'drop-after');
    const h = renderHook(() => hooks.useUpdateTokenLabel({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-g', label: '\tMới ' })).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(pendingKeys()).toEqual([]);
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-g', label: '\tMới ' })).resolves.toMatchObject({ label: 'Mới' }); });
    expect(link('room-g')).toMatchObject({ label: 'Mới' });
  });

  it('đổi nhãn không tới máy chủ + dấu bản trước: bấm lại lưu được, dấu gỡ', async () => {
    seedLink('room-h');
    const marker = legacy('token:room-h');
    io.server.failNext('manage_public_room_token_v1', 'rpc', 'drop-before');
    const h = renderHook(() => hooks.useUpdateTokenLabel({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-h', label: 'A' })).rejects.toMatchObject({ outcome: 'unknown' }); });
    await act(async () => { await expect(h.result.current.mutateAsync({ token: 'room-h', label: 'A' })).resolves.toMatchObject({ label: 'A' }); });
    expect(localStorage.getItem(marker)).toBeNull();
  });

  it('xoá mất phản hồi: bấm lại báo đã xoá ở lần trước, không dấu', async () => {
    seedLink('room-i');
    io.server.failNext('manage_public_room_token_v1', 'rpc', 'drop-after');
    const h = renderHook(() => hooks.useDeletePublicRoomToken({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync('room-i')).rejects.toMatchObject({ outcome: 'unknown' }); });
    expect(link('room-i')).toBeUndefined();
    await act(async () => { await expect(h.result.current.mutateAsync('room-i')).resolves.toMatchObject({ token: 'room-i', removed: 0 }); });
    expect(pendingKeys()).toEqual([]);
    expect(String(io.info.mock.calls[0]?.[0] ?? io.success.mock.calls[0]?.[0])).toContain('đã được xoá');
  });

  it('xoá không tới máy chủ + dấu bản trước: bấm lại xoá được, dấu gỡ', async () => {
    seedLink('room-j');
    const marker = legacy('token:room-j');
    io.server.failNext('manage_public_room_token_v1', 'rpc', 'drop-before');
    const h = renderHook(() => hooks.useDeletePublicRoomToken({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync('room-j')).rejects.toMatchObject({ outcome: 'unknown' }); });
    await act(async () => { await expect(h.result.current.mutateAsync('room-j')).resolves.toEqual({ token: 'room-j', removed: 1 }); });
    expect(link('room-j')).toBeUndefined();
    expect(localStorage.getItem(marker)).toBeNull();
  });

  it('xoá khớp 0 dòng (link đã không còn): máy chủ trả removed:false ⇒ báo không còn, không lỗi', async () => {
    const h = renderHook(() => hooks.useDeletePublicRoomToken({ inlineError: true }), { wrapper });
    await act(async () => { await expect(h.result.current.mutateAsync('room-k')).resolves.toEqual({ token: 'room-k', removed: 0 }); });
    expect(io.info).toHaveBeenCalledOnce();
  });
});
