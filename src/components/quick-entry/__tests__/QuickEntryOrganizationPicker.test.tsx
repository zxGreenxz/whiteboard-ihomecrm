// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ org: { selectedOrganizationId: null as string | null, preferenceError: null as string | null, isLoading: false, isError: false, organizations: [{id:'allowed',name:'Công ty của tôi'}], selectOrganization: vi.fn(), refetchOrganizations: vi.fn() } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => h.org }));
import { QuickEntryOrganizationPicker } from '../QuickEntryOrganizationPicker';
afterEach(() => { cleanup(); h.org.selectedOrganizationId=null; h.org.isLoading=false; vi.clearAllMocks(); });
it('offers authorized companies and keeps personal destination clear', () => {
  render(<QuickEntryOrganizationPicker/>);
  expect(screen.getByText(/Khoản cá nhân vẫn lưu vào ví cá nhân/)).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', {name:'Công ty dùng AI'}), {target:{value:'allowed'}});
  expect(h.org.selectOrganization).toHaveBeenCalledExactlyOnceWith('allowed');
});
it('does not prompt while restoring or once selection is present', () => {
  h.org.isLoading=true;
  const view=render(<QuickEntryOrganizationPicker/>);
  expect(screen.queryByRole('combobox')).toBeNull();
  h.org.isLoading=false; h.org.selectedOrganizationId='allowed';
  view.rerender(<QuickEntryOrganizationPicker/>);
  expect(view.container.textContent).toBe('');
});
