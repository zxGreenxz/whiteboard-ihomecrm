// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  listCustomerDossierFiles: vi.fn(),
  listBuildingOwnershipFiles: vi.fn(),
  uploadDossierFile: vi.fn(),
  removeDossierFile: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@/lib/residenceDossierFiles', () => ({
  listCustomerDossierFiles: boundary.listCustomerDossierFiles,
  listBuildingOwnershipFiles: boundary.listBuildingOwnershipFiles,
  uploadDossierFile: boundary.uploadDossierFile,
  removeDossierFile: boundary.removeDossierFile,
}));
vi.mock('sonner', () => ({ toast: { error: boundary.toastError, success: vi.fn() } }));

import { useCustomerDossierFiles, useDossierFileMutations, residenceDossierKeys } from '../useResidenceDossierFiles';

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useResidenceDossierFiles', () => {
  beforeEach(() => {
    boundary.listCustomerDossierFiles.mockReset().mockResolvedValue([{ id: 'f1', kind: 'CT01' }]);
    boundary.uploadDossierFile.mockReset().mockResolvedValue({ id: 'f2' });
    boundary.removeDossierFile.mockReset().mockResolvedValue(undefined);
    boundary.toastError.mockReset();
  });

  it('liệt kê ảnh của khách và làm mới sau khi tải lên', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => ({
      list: useCustomerDossierFiles('c1'),
      mut: useDossierFileMutations({ customerId: 'c1', buildingId: 'b1' }),
    }), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.list.data).toEqual([{ id: 'f1', kind: 'CT01' }]));
    expect(boundary.listCustomerDossierFiles).toHaveBeenCalledWith('c1');

    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    await act(async () => { await result.current.mut.upload.mutateAsync({ kind: 'CT01', contractId: 'ct1', file }); });
    expect(boundary.uploadDossierFile).toHaveBeenCalledWith({ kind: 'CT01', buildingId: 'b1', customerId: 'c1', contractId: 'ct1', file });
    await waitFor(() => expect(boundary.listCustomerDossierFiles).toHaveBeenCalledTimes(2));
    expect(client.getQueryState(residenceDossierKeys.building('b1'))).toBeUndefined();
  });

  it('xoá mềm rồi làm mới; lỗi được toast', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { result } = renderHook(() => useDossierFileMutations({ buildingId: 'b1' }), { wrapper: wrapper(client) });
    await act(async () => { await result.current.remove.mutateAsync('f1'); });
    expect(boundary.removeDossierFile).toHaveBeenCalledWith('f1');

    boundary.uploadDossierFile.mockRejectedValueOnce(new Error('Ảnh tối đa 15MB.'));
    await act(async () => {
      await result.current.upload.mutateAsync({ kind: 'OWNERSHIP', file: new File(['x'], 'g.png', { type: 'image/png' }) }).catch(() => undefined);
    });
    expect(boundary.toastError).toHaveBeenCalledWith('Ảnh tối đa 15MB.');
  });
});
