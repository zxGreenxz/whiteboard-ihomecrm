import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {supabase} from '@/integrations/supabase/client';
import type {Database} from '@/integrations/supabase/types';
import {useOrganization} from '@/contexts/OrganizationContext';
import {createRoomReservation,listRoomReservations,updateRoomReservation,reservationErrorMessage,type CreateRoomReservationInput,type UpdateRoomReservationInput,type RoomReservationFilters,type ReservationRpcInvoker} from '@/lib/reservationIdentityRpc';
type Functions=Database['public']['Functions'];
const invoke:ReservationRpcInvoker=(name,args)=>{switch(name){
 case 'create_room_reservation_v1':return supabase.rpc('create_room_reservation_v1',args as Functions['create_room_reservation_v1']['Args']);
 case 'update_room_reservation_v1':return supabase.rpc('update_room_reservation_v1',args as Functions['update_room_reservation_v1']['Args']);
 case 'list_room_reservations_v1':return supabase.rpc('list_room_reservations_v1',args as Functions['list_room_reservations_v1']['Args']);
}};
export function useRoomReservations(filters:RoomReservationFilters={},enabled=true){const{selectedOrganizationId}=useOrganization();return useQuery({queryKey:['room-reservations',selectedOrganizationId,filters],queryFn:()=>listRoomReservations(invoke,selectedOrganizationId!,filters),enabled:enabled&&!!selectedOrganizationId,retry:false,refetchInterval:60_000});}
function useReservationMutation<Input>(fn:(org:string,input:Input)=>ReturnType<typeof createRoomReservation>){const{selectedOrganizationId}=useOrganization();const cache=useQueryClient();return useMutation({mutationFn:(input:Input)=>{if(!selectedOrganizationId)throw{code:'42501',message:'Chưa chọn tổ chức'};return fn(selectedOrganizationId,input);},retry:false,onError:error=>toast.error(reservationErrorMessage(error)),onSuccess:async r=>{toast.success(r.status==='CANCELLED'?'Đã hủy giữ chỗ':r.receipts.length?'Đã lưu giữ chỗ và nguồn cọc':'Đã giữ chỗ • Chưa thu tiền');await Promise.all(['room-reservations','phong-trong','rooms','my-available-rooms','income-expenses','deposits','reservation-hold-deadlines'].map(k=>cache.invalidateQueries({queryKey:[k]})));}});}
export function useCreateRoomReservation(){return useReservationMutation((org:string,input:CreateRoomReservationInput)=>createRoomReservation(invoke,org,input));}
export function useUpdateRoomReservation(){return useReservationMutation((org:string,input:UpdateRoomReservationInput)=>updateRoomReservation(invoke,org,input));}
