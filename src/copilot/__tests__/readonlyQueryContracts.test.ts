// Customer and expiring-contract tools use the typed server RPC boundary.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc, from } }));

const { buildRegistryDefinitions } = await import('../tools/registry');
import type { PermissionsMap } from '@/lib/permissions';

const SUPER = { __superadmin: true } as unknown as PermissionsMap;
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const ctx = { perms: SUPER, organizationId: ORG };

const tool = (name: string) => {
  const found = buildRegistryDefinitions().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

describe('tim_khach_hang - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_customer_search_v1 with selected org and search text', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_customer_search_v1', {
      p_organization_id: ORG,
      p_search: 'An',
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('formats flat safe rows and masks the phone', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          customer_id: 'c1',
          customer_name: 'Nguyen An',
          phone: '0901234567',
          room_name: 'A101',
          building_name: 'Toa A',
        },
      ],
      error: null,
    });
    const result = await tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx);
    expect(result).toContain('Nguyen An');
    expect(result).toContain('A101');
    expect(result).toContain('Toa A');
    expect(result).not.toContain('0901234567');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(tool('tim_khach_hang').execute({ tu_khoa: 'none' }, ctx)).resolves.toMatch(/kh.ng t.m th.y/i);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('hop_dong_sap_het_han - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_expiring_contracts_v1 with local date and window', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, ctx);
    expect(rpc).toHaveBeenCalledWith(
      'copilot_expiring_contracts_v1',
      expect.objectContaining({ p_organization_id: ORG, p_window_days: 30 }),
    );
    expect(rpc.mock.calls[0][1].p_as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(from).not.toHaveBeenCalled();
  });

  it('formats flat rows with representative name and links', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          contract_id: 'h1',
          contract_number: 'HD001',
          customer_name: 'Nguoi Dai Dien',
          end_date: '2026-09-01',
          effective_end_date: '2026-09-01',
          room_name: 'B202',
          building_name: 'Toa B',
        },
      ],
      error: null,
    });
    const result = await tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, ctx);
    expect(result).toContain('Nguoi Dai Dien');
    expect(result).toContain('B202');
    expect(result).toContain('Toa B');
    expect(result).toContain('/contracts/h1');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(tool('hop_dong_sap_het_han').execute({ so_ngay: 7 }, ctx)).resolves.toContain('7');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('hop_dong_sap_het_han').execute({ so_ngay: 7 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('registry source contract', () => {
  it('does not query customers or contracts from the browser tools', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/copilot/tools/registry.ts', 'utf8'),
    );
    expect(source).toContain("copilot_customer_search_v1");
    expect(source).toContain("copilot_expiring_contracts_v1");
    expect(source).not.toMatch(/\.from\('customers'\)/);
    expect(source).not.toMatch(/\.from\('contracts'\)/);
  });
});
