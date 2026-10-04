// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ disconnect: vi.fn() }));
vi.mock('@/hooks/useBankEmail', () => ({
  useOwnedBankEmailConnections: () => ({ data: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'owner@example.test', status: 'CONNECTED' }], isPending: false, isError: false, refetch: vi.fn() }),
  useDisconnectBankEmail: () => ({ mutateAsync: mocks.disconnect, isPending: false }),
}));

import { BankEmailConnectionManager } from './BankEmailConnectionManager';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('owner Gmail connection management', () => {
  it('keeps disconnect available on the account screen without a business inbox query', async () => {
    mocks.disconnect.mockResolvedValue({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'DISCONNECTED' });
    render(<BankEmailConnectionManager />);
    expect(screen.getByText('owner@example.test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Ngắt Gmail ACB/ }));
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith('cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  });
});
