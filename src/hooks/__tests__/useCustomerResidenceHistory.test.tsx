// @vitest-environment jsdom
import React from 'react';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({ org: 'org-a', read: vi.fn() }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: h.org }) }));
vi.mock('@/lib/customerResidenceHistory', () => ({ readResidenceSummaries: h.read, readResidenceHistory: vi.fn() }));
import { useCustomerResidenceSummaries } from '../useCustomerResidenceHistory';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('batches only current page subjects and never reuses the previous organization summary', async () => {
  h.read.mockImplementation(async (org: string, ids: string[]) => ids.map(customer_id => ({ customer_id, scope: org })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: {
    children: React.ReactNode;
  }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook(({ ids }) => useCustomerResidenceSummaries(ids), { initialProps: { ids: ['c2', 'c1'] }, wrapper });
  await waitFor(() => expect(result.current.data).toEqual([{ customer_id: 'c1', scope: 'org-a' }, { customer_id: 'c2', scope: 'org-a' }]));
  expect(h.read.mock.calls).toEqual([['org-a', ['c1', 'c2']]]);
  h.org = 'org-b';
  rerender({ ids: ['c3'] });
  expect(result.current.data).toBeUndefined();
  await waitFor(() => expect(result.current.data).toEqual([{ customer_id: 'c3', scope: 'org-b' }]));
  expect(h.read.mock.calls).toHaveLength(2);
});
