// @vitest-environment jsdom
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({record:vi.fn(),create:vi.fn(),toast:vi.fn()}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-1'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:vi.fn()}}));
vi.mock('@/components/errors/boundaryReporter',()=>({reportBoundaryError:vi.fn()}));
vi.mock('sonner',()=>({toast:{error:mocks.toast,success:vi.fn()}}));
vi.mock('@/lib/contractCommissionFollowup',()=>({recordContractCommissionEvent:vi.fn(),readContractCommissionFollowups:vi.fn(),prepareCommissionCreations:vi.fn(),executeCommissionCreation:mocks.record}));
vi.mock('@/lib/reservationIdentityRpc',()=>({createRoomReservation:mocks.create,updateRoomReservation:vi.fn(),listRoomReservations:vi.fn(),reservationErrorMessage:()=> 'Thông báo an toàn'}));
import {QueryProvider,queryClient} from '@/app/providers/QueryProvider';
import {useRetryCommissionVoucher} from '../useCommissionVoucher';
import {useCreateRoomReservation} from '../useRoomReservations';
beforeEach(()=>{vi.clearAllMocks();queryClient.clear();mocks.record.mockRejectedValue({code:'42501',message:'permission denied'});mocks.create.mockRejectedValue(new TypeError('Failed to fetch'));});
afterEach(()=>{cleanup();queryClient.clear();});
it('leaves saved commission retry failure with the live panel without a global duplicate',async()=>{
 const {result}=renderHook(()=>useRetryCommissionVoucher(),{wrapper:QueryProvider});
 await act(async()=>{await expect(result.current.mutateAsync({contract_id:'contract-1',kind:'broker',request_id:'saved-request'})).rejects.toMatchObject({code:'42501'});});
 expect(mocks.record).toHaveBeenCalledOnce();expect(mocks.toast).not.toHaveBeenCalled();
});
it('leaves a silent quick deposit failure with its modal',async()=>{
 const {result}=renderHook(()=>useCreateRoomReservation({silent:true}),{wrapper:QueryProvider});
 await act(async()=>{await expect(result.current.mutateAsync({roomId:'room-1',customerId:'customer-1',holdUntil:'2026-10-01',idempotencyKey:'reservation-key'})).rejects.toBeInstanceOf(TypeError);});
 expect(mocks.create).toHaveBeenCalledOnce();expect(mocks.toast).not.toHaveBeenCalled();
});
it('preserves the hook owner for existing reservation callers',async()=>{
 const {result}=renderHook(()=>useCreateRoomReservation(),{wrapper:QueryProvider});
 await act(async()=>{await expect(result.current.mutateAsync({roomId:'room-1',customerId:'customer-1',holdUntil:'2026-10-01',idempotencyKey:'reservation-key'})).rejects.toBeInstanceOf(TypeError);});
 expect(mocks.toast).toHaveBeenCalledOnce();expect(mocks.toast).toHaveBeenCalledWith('Thông báo an toàn');
});
