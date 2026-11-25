// @vitest-environment jsdom
// Đợt 7 (luật 5, cách D): tờ khai CT01 không phải tiền nên không giữ dấu «chờ đối chiếu». Mã tờ khai do trình duyệt sinh;
// bảng `ct01_declarations` nhận `id` từ trình duyệt và trigger không ghi đè (production 26/11/2026), nên gửi lại ĐÚNG mã cũ
// thì khoá chính chặn bản thứ hai (23505) và đọc đúng mã cho biết lần trước đã ghi chưa.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from './fakeRecordServer';
import type { CT01FormData } from '@/types/customer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQuery: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table) } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { forgetUnconfirmedCt01, useCreateCT01Declaration } from '../useCT01Declarations';

const form = (name = 'Người khai mẫu'): CT01FormData => ({ registration_authority: 'Công an phường mẫu', full_name: name, date_of_birth: '1990-01-01', gender: 'Nam', id_number: '000000000000', family_members: [] });
const save = (data = form()) => (renderHook(() => useCreateCT01Declaration()).result.current as unknown as { mutationFn: (v: { customerId: string; data: CT01FormData }) => Promise<{ id: string }> }).mutationFn({ customerId: 'customer-1', data });
const rows = () => io.server.rows.ct01_declarations ?? [];
const insertedIds = () => io.server.inserts.filter(item => item.table === 'ct01_declarations').map(item => (item.payload as { id: string }).id);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  forgetUnconfirmedCt01();
  io.server = fakeRecordServer();
});

describe('tờ khai CT01 (cách D, không giữ dấu)', () => {
  it('lệnh không tới máy chủ: lần lưu sau gửi lại ĐÚNG mã tờ khai, một tờ khai, không dấu', async () => {
    io.server.failNext('ct01_declarations', 'insert', 'drop-before');
    await expect(save()).rejects.toMatchObject({ outcome: 'unknown' });
    expect(pendingKeys()).toEqual([]);
    const saved = await save();
    expect(insertedIds()).toHaveLength(2);
    expect(new Set(insertedIds()).size).toBe(1);
    expect(saved.id).toBe(insertedIds()[0]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ organization_id: 'org-a', customer_id: 'customer-1', user_id: 'actor' });
  });

  it('tới nhưng mất phản hồi: gửi lại cùng mã bị khoá chính chặn ⇒ đọc đúng mã, trả tờ khai đã ghi, không tạo bản thứ hai', async () => {
    // Ghi xong nhưng mất phản hồi, và lần đọc đúng mã ngay sau đó cũng hỏng: chưa rõ.
    io.server.failNext('ct01_declarations', 'insert', 'drop-after');
    io.server.failNext('ct01_declarations', 'read', 'drop-before');
    await expect(save()).rejects.toMatchObject({ outcome: 'unknown' });
    const saved = await save();
    expect(new Set(insertedIds()).size).toBe(1);
    expect(saved.id).toBe(insertedIds()[0]);
    expect(rows()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu cũ gieo sẵn (khoá chung theo khách): thấy tờ khai quanh giờ kẹt ⇒ chỉ báo «có thể đã lưu» kèm mã, gỡ dấu; lần lưu sau tạo bình thường', async () => {
    const stuckAt = new Date(Date.now() - 10 * 60_000);
    io.server.rows.ct01_declarations = [{ id: 'ct01-legacy', customer_id: 'customer-1', user_id: 'actor', organization_id: 'org-a', created_at: stuckAt.toISOString() }];
    seedLegacyPending({ namespace: 'ct01-declaration-create', userId: 'actor', organizationId: 'actor-scope', businessKey: 'customer-1' }, stuckAt);
    await expect(save()).rejects.toMatchObject({ alreadyRecorded: true, recordIds: ['ct01-legacy'], message: expect.stringContaining('Có thể') });
    expect(insertedIds()).toEqual([]);
    expect(pendingKeys()).toEqual([]);
    await expect(save()).resolves.toMatchObject({ customer_id: 'customer-1' });
    expect(rows()).toHaveLength(2);
  });

  it('dấu cũ gieo sẵn, không có tờ khai nào quanh giờ kẹt: gỡ dấu và lưu ngay', async () => {
    seedLegacyPending({ namespace: 'ct01-declaration-create', userId: 'actor', organizationId: 'actor-scope', businessKey: 'customer-1' }, new Date(Date.now() - 10 * 60_000));
    await expect(save()).resolves.toMatchObject({ customer_id: 'customer-1' });
    expect(rows()).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('máy chủ từ chối rõ: quên mã, lần lưu sau là tờ khai mới (không bị khoá)', async () => {
    const server = io.server;const sent: string[] = [];
    io.server = { ...server, from: (table: string) => table === 'ct01_declarations'
      ? { insert: (payload: { id: string }) => { sent.push(payload.id); return { select: () => ({ single: async () => ({ data: null, error: { code: '23514', message: 'check violation' } }) }) }; } }
      : server.from(table) } as FakeRecordServer;
    await expect(save()).rejects.toMatchObject({ code: '23514' });
    io.server = server;
    await expect(save()).resolves.toMatchObject({ customer_id: 'customer-1' });
    expect(sent).toHaveLength(1);
    expect(insertedIds()).toHaveLength(1);
    expect(insertedIds()[0]).not.toBe(sent[0]);
  });
});
