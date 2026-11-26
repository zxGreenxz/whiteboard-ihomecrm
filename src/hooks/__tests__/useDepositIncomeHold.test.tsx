// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDepositIncomeHold } from '../useDepositIncomeHold';

const data = vi.hoisted(() => ({ hold: undefined as {id: string} | null | undefined }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ isSuccess: data.hold !== undefined, data: data.hold }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
afterEach(cleanup);

it.each([null, {id: 'A'}])('giữ đúng đích đã thấy khi phòng có lượt mới giữa lần nhập', first => {
  data.hold = undefined;
  const { result, rerender } = renderHook(({open}) => useDepositIncomeHold('401',open), {initialProps:{open:true}});
  data.hold = first;
  rerender({open:true});
  expect(result.current.destinationChanged).toBe(false);
  data.hold = {id:'B'};
  rerender({open:true});
  expect(result.current.destinationChanged).toBe(true);
  expect(result.current.data).toEqual(first);
  rerender({open:false});
  rerender({open:true});
  expect(result.current.destinationChanged).toBe(false);
  expect(result.current.data).toEqual({id:'B'});
});
