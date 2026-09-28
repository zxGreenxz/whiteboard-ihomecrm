import {supabase} from '@/integrations/supabase/client';
import type {Database} from '@/integrations/supabase/types';
import {createRoomReservation,type CreateRoomReservationInput,type ReservationRpcInvoker} from '@/lib/reservationIdentityRpc';
/** Compatibility entry point requires selected organization and concrete
 * customer. No guessed money, actor-as-party or fail-open. */
export function tryPlaceRoomHold(organizationId:string,input:CreateRoomReservationInput){
 const invoke:ReservationRpcInvoker=(_name,args)=>supabase.rpc('create_room_reservation_v1',args as Database['public']['Functions']['create_room_reservation_v1']['Args']);
 return createRoomReservation(invoke,organizationId,input);
}
