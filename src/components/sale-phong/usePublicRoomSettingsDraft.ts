import {useEffect,useRef,useState} from 'react';
import {useHotlines} from '@/hooks/useHotlines';
import {usePublicRoomSettings,useUpsertPublicRoomSettings,PUBLIC_ROOM_SETTINGS_DEFAULTS,type PublicRoomSettings} from '@/hooks/usePublicRoomSettings';
import {focusFirstError} from '@/lib/formErrors';
import {actionErrorMessage} from '@/lib/actionFeedback';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
export function usePublicRoomSettingsDraft(){
 const settings=usePublicRoomSettings();const hotlines=useHotlines();const mutation=useUpsertPublicRoomSettings({inlineError:true});
 const root=useRef<HTMLDivElement>(null);const dirty=useRef(false);
 const [form,setForm]=useState<PublicRoomSettings>(PUBLIC_ROOM_SETTINGS_DEFAULTS);const [days,setDays]=useState('30');
 const [errors,setErrors]=useState<Record<string,string>>({});const [writeError,setWriteError]=useState('');const [blocked,setBlocked]=useState(false);
 useEffect(()=>{if(settings.data&&!dirty.current){setForm(settings.data);setDays(String(settings.data.soon_days));}},[settings.data]);
 const set=<K extends keyof PublicRoomSettings>(key:K,value:PublicRoomSettings[K])=>{dirty.current=true;setForm(current=>({...current,[key]:value}));setErrors(current=>({...current,[key]:''}));};
 const changeDays=(raw:string)=>{dirty.current=true;setDays(raw);setErrors(current=>({...current,soon_days:''}));};
 const canSave=!blocked&&!settings.isError&&!hotlines.isError&&settings.data!==undefined&&hotlines.data!==undefined;
 const save=async()=>{
  if(!canSave||mutation.isPending)return;
  const next:Record<string,string>={};const value=Number(days);
  if(!/^\d+$/.test(days)||!Number.isInteger(value)||value<0||value>365)next.soon_days='Nhập số ngày nguyên từ 0 đến 365.';
  if(form.hotline_id&&!hotlines.data?.some(h=>h.id===form.hotline_id))next.hotline_id='Chọn hotline hiện có hoặc dùng mặc định.';
  setErrors(next);if(Object.keys(next).length){await focusFirstError(next,{root:root.current??undefined});return;}
  setWriteError('');try{await mutation.mutateAsync({...form,soon_days:value});dirty.current=false;setForm(current=>({...current,soon_days:value}));}
  catch(error){setWriteError(actionErrorMessage(error,'Chưa lưu được cài đặt hiển thị.'));if(error instanceof FinancialWorkflowError&&error.outcome!=='failure')setBlocked(true);}
 };
 return {settings,hotlines,mutation,root,form,days,errors,writeError,canSave,set,changeDays,save};
}
