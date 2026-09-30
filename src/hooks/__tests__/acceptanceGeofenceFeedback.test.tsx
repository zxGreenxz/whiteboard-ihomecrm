// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const h = vi.hoisted(()=>({rpc:vi.fn(),complete:vi.fn(),close:vi.fn(),session:{session_id:'session-demo',type:'QUICK',started_at:'2026-09-30T01:00:00Z',slot_counts:{},dwell_seconds:0,reqs:{dwell_min_seconds:0,photos_min:2},photos_count:0,checklist:[]}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc}}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'user-demo'}})}));
vi.mock('@/hooks/use-mobile',()=>({useIsMobile:()=>false}));
vi.mock('@/hooks/useJobs',()=>({useCompleteJob:()=>({mutateAsync:h.complete})}));
vi.mock('@/components/tasks/JobCaptureCamera',()=>({default:()=>null}));
vi.mock('@/lib/storage',()=>({uploadFile:vi.fn()}));
vi.mock('@/components/ui/storage-image',()=>({StorageImage:({value}: {value:string})=><img alt="Ảnh đã lưu" src={value}/>}));
vi.mock('@/lib/salaryBonusNotify',()=>({awardAndNotifyJobBonus:vi.fn()}));
vi.mock('@/hooks/useV5TickFromJob',()=>({v5TickFromJob:vi.fn()}));
vi.mock('@/lib/authSession',()=>({getSessionUserId:async()=> 'user-demo'}));
vi.mock('@/hooks/useMyDay',()=>({useStartInspection:()=>({mutateAsync:async()=>h.session}),useSubmitInspectionPhoto:()=>({mutateAsync:vi.fn()}),useCompleteInspection:()=>({mutateAsync:vi.fn()}),useReportDeviceIssue:()=>({mutateAsync:vi.fn()}),fetchGeoOkCount:async()=>0,sha256File:vi.fn()}));
import { useAcceptanceGeofenceConfig } from '../useAcceptanceGeofence';
import TaskCompleteDialog from '@/components/tasks/TaskCompleteDialog';
import InspectionRunner from '@/components/inspections/InspectionRunner';
let client:QueryClient;
beforeEach(()=>{h.rpc.mockReset();h.close.mockReset();client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});});
afterEach(()=>{cleanup();client.clear();});
const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
it('RPC error stays an error instead of becoming a saved default configuration',async()=>{
 const original={code:'42501',message:'permission denied for table settings'};
 h.rpc.mockResolvedValue({data:null,error:original});
 const {result}=renderHook(()=>useAcceptanceGeofenceConfig(),{wrapper});
 await waitFor(()=>expect(result.current.isError).toBe(true));
 expect(result.current.error).toBe(original);expect(result.current.data).toBeUndefined();
});
it.each([null, {}, {enabled:true,radius_m:null}])('missing configuration %j is not treated as loaded default',async data=>{
 h.rpc.mockResolvedValue({data,error:null});
 const {result}=renderHook(()=>useAcceptanceGeofenceConfig(),{wrapper});
 await waitFor(()=>expect(result.current.isError).toBe(true));
});
it.each([{enabled:true,radius_m:70},{enabled:false,radius_m:120}])('valid SQL configuration %j remains valid',async data=>{
 h.rpc.mockResolvedValue({data,error:null});
 const {result}=renderHook(()=>useAcceptanceGeofenceConfig(),{wrapper});
 await waitFor(()=>expect(result.current.isSuccess).toBe(true));
 expect(result.current.data).toEqual({enabled:data.enabled,radiusM:data.radius_m});
});
it('task completion keeps photos and shows configuration retry on read failure',async()=>{
 h.rpc.mockResolvedValueOnce({data:null,error:new Error('Failed to fetch')});
 render(<TaskCompleteDialog open onOpenChange={h.close} onSuccess={()=>{}} job={{id:'job-demo',title:'Kiểm tra phòng',code:'CV1',attachments:['saved.jpg'],buildings:null} as never}/>,{wrapper});
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Chưa tải được cấu hình kiểm tra vị trí'));
 expect(screen.getByAltText('Ảnh đã lưu').getAttribute('src')).toBe('saved.jpg');
 expect(h.close).not.toHaveBeenCalled();
 h.rpc.mockResolvedValueOnce({data:{enabled:true,radius_m:70},error:null});
 fireEvent.click(screen.getByRole('button',{name:'Tải lại'}));
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
});
it('inspection session remains visible beside configuration error',async()=>{
 h.rpc.mockResolvedValue({data:null,error:new Error('Failed to fetch')});
 render(<InspectionRunner open onOpenChange={h.close} buildingId="building-demo" buildingName="Tòa Demo" type="QUICK"/>,{wrapper});
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Chưa tải được cấu hình kiểm tra vị trí'));
 expect(screen.getByRole('button',{name:'Hoàn tất'})).toBeTruthy();
 expect(h.close).not.toHaveBeenCalled();
});
