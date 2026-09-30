// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import MaterialUsageItemsEditor from '../MaterialUsageItemsEditor';
import { focusFirstError } from '@/lib/formErrors';

vi.mock('@/hooks/useMaterials', () => ({ useMaterials: () => ({ data: [] }) }));
afterEach(cleanup);

it('shows row errors and focuses the missing material picker', async () => {
  const errors = { 'materials.0.material_id': 'Chọn vật tư.', 'materials.0.quantity': 'Nhập số lượng vật tư lớn hơn 0.' };
  const view = render(<MaterialUsageItemsEditor items={[{ key: 'row-1', material_id: null, quantity: '' }]}
    errors={errors} onItemsChange={vi.fn()} />);
  expect(screen.getByText('Chọn vật tư.')).toBeTruthy();
  expect(screen.getByText('Nhập số lượng vật tư lớn hơn 0.')).toBeTruthy();
  expect(await focusFirstError(errors, { root: view.container })).toBe(true);
  expect(document.activeElement?.getAttribute('role')).toBe('combobox');
  expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
});
