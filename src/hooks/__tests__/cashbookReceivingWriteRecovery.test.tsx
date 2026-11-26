// @vitest-environment jsdom
// Đợt 8 (luật 5): sửa sổ quỹ, sổ tiền mặt riêng, sổ nhận tiền của toà là thao tác ĐẶT GIÁ TRỊ (đọc thân hàm production
// 26/11/2026): update_cashbook_metadata_v1 khoá công ty rồi đặt giá trị tuyệt đối cho sổ chưa lưu trữ;
// set_personal_cash_book_v1 khoá công ty + dòng đang hiệu lực, chỉ đổi khi khác; set_building_receiving_cashbooks_v1 đặt
// cả bộ (sổ mặc định + sổ phụ) trong một giao dịch. Chạy lại cho cùng kết quả ⇒ không giữ dấu, chưa rõ thì báo và cho
// lưu lại. Dấu `cashbook-lifecycle` bản trước có thể là của sửa sổ HOẶC của lưu trữ trước khi tách (đợt 5): sửa sổ thành
// công chứng tỏ sổ chưa lưu trữ (hàm sửa chỉ nhận sổ `deleted_at is null`), tức lần lưu trữ cũ chưa ghi ⇒ gỡ. Sửa bị từ
// chối (sổ đã lưu trữ) thì dấu giữ nguyên và lưu trữ đúng sổ đó vẫn bị chặn qua hộp cảnh báo.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, seedLegacyPending, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/actionFeedback', () => ({ notifyActionError: vi.fn() }));

import { useDeleteAccount, useUpdateAccount } from '../useAccounts';
import { useSetBuildingReceivingCashbooks, useSetPersonalCashBook } from '../useReceivingCashbooks';
import { RepeatableWriteUnknownError } from '@/lib/financialWorkflow';

type Writer = (input: unknown) => Promise<unknown>;
const writerOf = (hook: unknown) => (hook as { mutationFn: Writer }).mutationFn;
const TEN_PHUT = 10 * 60_000;
const calls = (name: string) => io.server.rpcCalls.filter(call => call.name === name).length;

/** Dấu bản trước có tên thao tác (bản đợt 1–7 lưu tên thao tác vào dấu). */
function seedNamed(scope: { namespace: string; userId: string; organizationId: string; businessKey: string }, operation: string) {
  const key = seedLegacyPending(scope, new Date(Date.now() - TEN_PHUT));
  const row = JSON.parse(localStorage.getItem(key) ?? '{}');
  localStorage.setItem(key, JSON.stringify({ ...row, operation }));
  return key;
}

const bookValues = { name: 'Sổ A mới', description: 'Ghi chú', initial_amount: 500, initial_date: '2026-10-01', quick_default_building_id: null, is_default: false };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  io.server = fakeRecordServer();
  io.server.rows.accounts = [
    { id: 'book1', name: 'Sổ A', description: null, initial_amount: 0, initial_date: '2026-09-30', deleted_at: null },
    { id: 'book2', name: 'Sổ B', description: null, initial_amount: 0, initial_date: '2026-09-30', deleted_at: null },
    { id: 'book-gone', name: 'Sổ đã lưu trữ', deleted_at: '2026-11-01T00:00:00Z' },
  ];
  // Giả update_cashbook_metadata_v1: chỉ sổ chưa lưu trữ; đặt giá trị tuyệt đối.
  io.server.rpcHandlers.update_cashbook_metadata_v1 = args => {
    const row = io.server.rows.accounts.find(item => item.id === args.p_cashbook_id && !item.deleted_at);
    if (!row) return { data: null, error: { code: '42501', message: 'Không tìm thấy sổ quỹ' } };
    Object.assign(row, { name: args.p_name, description: args.p_description, initial_amount: args.p_initial_amount, initial_date: args.p_initial_date });
    return { data: { cashbook_id: row.id }, error: null };
  };
  io.server.rpcHandlers.archive_cashbook_v1 = args => {
    const row = io.server.rows.accounts.find(item => item.id === args.p_cashbook_id && !item.deleted_at);
    if (!row) return { data: null, error: { code: '42501', message: 'Không tìm thấy sổ quỹ' } };
    row.deleted_at = new Date().toISOString();
    return { data: { cashbook_id: row.id, archived: true }, error: null };
  };
  // Giả set_personal_cash_book_v1: dòng lịch sử theo thành viên, chỉ đóng/mở dòng khi khác sổ đang cài.
  io.server.rows.personal_cash_books = [];
  io.server.rpcHandlers.set_personal_cash_book_v1 = args => {
    const rows = io.server.rows.personal_cash_books;
    const current = rows.find(row => row.membership_id === args.p_membership_id && row.valid_to === null);
    const next = (args.p_account_id ?? null) as string | null;
    if ((current?.account_id ?? null) !== next) {
      if (current) current.valid_to = new Date().toISOString();
      if (next) rows.push({ id: `pcb-${rows.length + 1}`, membership_id: args.p_membership_id, account_id: next, valid_to: null });
    }
    return { data: { membershipId: args.p_membership_id, personalCashBook: next ? { id: next, name: `Sổ ${next}` } : null }, error: null };
  };
  // Giả set_building_receiving_cashbooks_v1: đặt cả bộ (mặc định + danh sách phụ) trong một lần.
  io.server.rows.building_receiving = [];
  io.server.rows.buildings = [{ id: 'b1', default_account_id_tk: null }];
  io.server.rpcHandlers.set_building_receiving_cashbooks_v1 = args => {
    const extras = [...new Set((args.p_extra_account_ids as string[]) ?? [])].filter(id => id !== args.p_default_account_id);
    io.server.rows.buildings[0].default_account_id_tk = args.p_default_account_id ?? null;
    io.server.rows.building_receiving = [
      ...io.server.rows.building_receiving.filter(row => !(row.building_id === args.p_building_id && row.method === args.p_method)),
      ...extras.map(account_id => ({ id: `brc-${account_id}`, building_id: args.p_building_id, method: args.p_method, account_id })),
    ];
    return { data: { buildingId: args.p_building_id, method: args.p_method, defaultAccountId: args.p_default_account_id ?? null, extraAccountIds: extras }, error: null };
  };
});

describe('sửa sổ quỹ (update_cashbook_metadata_v1, cách A)', () => {
  const update = () => writerOf(renderHook(() => useUpdateAccount({ silent: true })).result.current);

  it('lệnh không tới máy chủ: báo chưa rõ, không để dấu, bấm lại ghi được', async () => {
    io.server.failNext('update_cashbook_metadata_v1', 'rpc', 'drop-before');
    await expect(update()({ id: 'book1', values: bookValues })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await expect(update()({ id: 'book1', values: bookValues })).resolves.toBeUndefined();
    expect(io.server.rows.accounts[0]).toMatchObject({ name: 'Sổ A mới', initial_amount: 500, initial_date: '2026-10-01' });
    expect(calls('update_cashbook_metadata_v1')).toBe(2);
  });

  it('tới nhưng mất phản hồi: bấm lại đặt đúng giá trị đó một lần nữa, không để dấu', async () => {
    io.server.failNext('update_cashbook_metadata_v1', 'rpc', 'drop-after');
    await expect(update()({ id: 'book1', values: bookValues })).rejects.toMatchObject({ outcome: 'unknown', repeatable: true });
    expect(io.server.rows.accounts[0]).toMatchObject({ name: 'Sổ A mới', initial_amount: 500 });
    await expect(update()({ id: 'book1', values: bookValues })).resolves.toBeUndefined();
    expect(io.server.rows.accounts[0]).toMatchObject({ name: 'Sổ A mới', initial_amount: 500, initial_date: '2026-10-01' });
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước của chính sửa sổ (có tên thao tác): không chặn, gỡ sau lần sửa thành công', async () => {
    seedNamed({ namespace: 'cashbook-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'book1' }, 'lưu thay đổi sổ quỹ');
    await expect(update()({ id: 'book1', values: bookValues })).resolves.toBeUndefined();
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước không tên (sửa hoặc lưu trữ bản trước): sửa thành công ⇒ gỡ; lưu trữ sau đó gửi đúng một lần', async () => {
    seedLegacyPending({ namespace: 'cashbook-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'book1' }, new Date(Date.now() - TEN_PHUT));
    await expect(update()({ id: 'book1', values: bookValues })).resolves.toBeUndefined();
    expect(pendingKeys()).toEqual([]);
    const archive = writerOf(renderHook(() => useDeleteAccount()).result.current);
    await expect(archive('book1')).resolves.toBeUndefined();
    expect(calls('archive_cashbook_v1')).toBe(1);
  });

  it('dấu bản trước mang tên LƯU TRỮ: sổ còn hoạt động nên lần lưu trữ đó chưa ghi; sửa thành công gỡ dấu', async () => {
    seedNamed({ namespace: 'cashbook-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'book1' }, 'xóa sổ quỹ');
    await expect(update()({ id: 'book1', values: bookValues })).resolves.toBeUndefined();
    expect(pendingKeys()).toEqual([]);
  });

  it('sổ đã lưu trữ (sửa bị từ chối): dấu bản trước giữ nguyên, lưu trữ đúng sổ đó vẫn bị chặn qua hộp cảnh báo', async () => {
    const key = seedLegacyPending({ namespace: 'cashbook-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'book-gone' }, new Date(Date.now() - TEN_PHUT));
    await expect(update()({ id: 'book-gone', values: bookValues })).rejects.toMatchObject({ code: '42501' });
    expect(pendingKeys()).toEqual([key]);
    const archive = writerOf(renderHook(() => useDeleteAccount()).result.current);
    await expect(archive('book-gone')).rejects.toMatchObject({ message: expect.stringContaining('đối chiếu') });
    expect(calls('archive_cashbook_v1')).toBe(0);
  });

  it('dấu bản trước của sổ KHÁC không bị gỡ và vẫn chặn lưu trữ sổ đó', async () => {
    const key = seedLegacyPending({ namespace: 'cashbook-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'book2' }, new Date(Date.now() - TEN_PHUT));
    await expect(update()({ id: 'book1', values: bookValues })).resolves.toBeUndefined();
    expect(pendingKeys()).toEqual([key]);
    const archive = writerOf(renderHook(() => useDeleteAccount()).result.current);
    await expect(archive('book2')).rejects.toBeTruthy();
    expect(calls('archive_cashbook_v1')).toBe(0);
  });

  it('dấu bản trước chưa «kết thúc» (dưới 2 phút, lượt cũ có thể còn chạy): sửa không bị chặn nhưng không gỡ dấu', async () => {
    const key = seedLegacyPending({ namespace: 'cashbook-lifecycle', userId: 'actor', organizationId: 'actor-scope', businessKey: 'book1' }, new Date(Date.now() - 30_000));
    await expect(update()({ id: 'book1', values: bookValues })).resolves.toBeUndefined();
    expect(pendingKeys()).toEqual([key]);
  });

  it('sửa sổ chưa rõ không để dấu nên không chặn lưu trữ sổ đó', async () => {
    io.server.failNext('update_cashbook_metadata_v1', 'rpc', 'drop-before');
    await expect(update()({ id: 'book2', values: bookValues })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    const archive = writerOf(renderHook(() => useDeleteAccount()).result.current);
    await expect(archive('book2')).resolves.toBeUndefined();
    expect(calls('archive_cashbook_v1')).toBe(1);
  });

  it('sổ đã lưu trữ (máy chủ không ghi gì): từ chối rõ, không để dấu', async () => {
    const error = await update()({ id: 'book-gone', values: bookValues }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: '42501' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });

  it('biên nhận sai mã sổ không phải thành công (chưa rõ), không để dấu', async () => {
    io.server.rpcHandlers.update_cashbook_metadata_v1 = () => ({ data: { cashbook_id: 'book2' }, error: null });
    await expect(update()({ id: 'book1', values: bookValues })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('sổ tiền mặt riêng (set_personal_cash_book_v1, cách A)', () => {
  const save = () => writerOf(renderHook(() => useSetPersonalCashBook()).result.current);
  const active = () => io.server.rows.personal_cash_books.filter(row => row.valid_to === null);

  it('lệnh không tới máy chủ: báo chưa rõ, không để dấu, bấm lại ghi được', async () => {
    io.server.failNext('set_personal_cash_book_v1', 'rpc', 'drop-before');
    await expect(save()({ membershipId: 'm1', accountId: 'acc1' })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await expect(save()({ membershipId: 'm1', accountId: 'acc1' })).resolves.toMatchObject({ personalCashBook: { id: 'acc1' } });
    expect(active()).toEqual([expect.objectContaining({ account_id: 'acc1' })]);
  });

  it('tới nhưng mất phản hồi: bấm lại cho đúng một sổ đang hiệu lực, không thêm dòng lịch sử', async () => {
    io.server.failNext('set_personal_cash_book_v1', 'rpc', 'drop-after');
    await expect(save()({ membershipId: 'm1', accountId: 'acc1' })).rejects.toMatchObject({ outcome: 'unknown', repeatable: true });
    await expect(save()({ membershipId: 'm1', accountId: 'acc1' })).resolves.toMatchObject({ personalCashBook: { id: 'acc1' } });
    expect(io.server.rows.personal_cash_books).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước gieo sẵn: không chặn, gỡ sau lần lưu thành công', async () => {
    seedLegacyPending({ namespace: 'receiving-personal', userId: 'actor', organizationId: 'actor-scope', businessKey: 'm1' }, new Date(Date.now() - TEN_PHUT));
    await expect(save()({ membershipId: 'm1', accountId: 'acc1' })).resolves.toMatchObject({ membershipId: 'm1' });
    expect(pendingKeys()).toEqual([]);
  });

  it('máy chủ từ chối rõ (không phải chủ công ty): lời từ chối đi nguyên, không để dấu, không gỡ dấu bản trước', async () => {
    const key = seedLegacyPending({ namespace: 'receiving-personal', userId: 'actor', organizationId: 'actor-scope', businessKey: 'm1' }, new Date(Date.now() - TEN_PHUT));
    io.server.rpcHandlers.set_personal_cash_book_v1 = () => ({ data: null, error: { code: '42501', message: 'Chỉ chủ công ty cài được sổ nhận tiền' } });
    const error = await save()({ membershipId: 'm1', accountId: 'acc1' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: '42501' });
    expect(error).not.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([key]);
  });

  it('biên nhận sai sổ không phải thành công: chưa rõ, không để dấu, bấm lại được', async () => {
    io.server.rpcHandlers.set_personal_cash_book_v1 = () => ({ data: { membershipId: 'm1', personalCashBook: { id: 'acc9', name: 'Sổ khác' } }, error: null });
    await expect(save()({ membershipId: 'm1', accountId: 'acc1' })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    await expect(save()({ membershipId: 'm1', accountId: 'acc1' })).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(calls('set_personal_cash_book_v1')).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });
});

describe('sổ nhận tiền của toà (set_building_receiving_cashbooks_v1, cách A đặt cả bộ)', () => {
  const save = () => writerOf(renderHook(() => useSetBuildingReceivingCashbooks()).result.current);
  const input = { buildingId: 'b1', method: 'TK' as const, defaultAccountId: 'acc1', extraAccountIds: ['acc2', 'acc3'] };
  const extras = () => io.server.rows.building_receiving.map(row => row.account_id).sort();

  it('lệnh không tới máy chủ: báo chưa rõ, không để dấu, bấm lại ghi được', async () => {
    io.server.failNext('set_building_receiving_cashbooks_v1', 'rpc', 'drop-before');
    await expect(save()(input)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
    await expect(save()(input)).resolves.toMatchObject({ defaultAccountId: 'acc1' });
    expect(extras()).toEqual(['acc2', 'acc3']);
  });

  it('tới nhưng mất phản hồi: bấm lại cho đúng một bộ sổ, không nhân đôi sổ phụ', async () => {
    io.server.failNext('set_building_receiving_cashbooks_v1', 'rpc', 'drop-after');
    await expect(save()(input)).rejects.toMatchObject({ outcome: 'unknown', repeatable: true });
    await expect(save()(input)).resolves.toMatchObject({ extraAccountIds: ['acc2', 'acc3'] });
    expect(extras()).toEqual(['acc2', 'acc3']);
    expect(io.server.rows.buildings[0].default_account_id_tk).toBe('acc1');
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước gieo sẵn (khoá toà + hình thức): không chặn, gỡ sau lần lưu thành công', async () => {
    seedLegacyPending({ namespace: 'receiving-building', userId: 'actor', organizationId: 'actor-scope', businessKey: 'b1TK' }, new Date(Date.now() - TEN_PHUT));
    await expect(save()(input)).resolves.toMatchObject({ buildingId: 'b1' });
    expect(pendingKeys()).toEqual([]);
  });

  it('biên nhận thiếu sổ phụ không phải thành công: chưa rõ, không để dấu', async () => {
    io.server.rpcHandlers.set_building_receiving_cashbooks_v1 = args => ({ data: { buildingId: args.p_building_id, method: args.p_method, defaultAccountId: 'acc1', extraAccountIds: ['acc2'] }, error: null });
    await expect(save()(input)).rejects.toBeInstanceOf(RepeatableWriteUnknownError);
    expect(pendingKeys()).toEqual([]);
  });
});
