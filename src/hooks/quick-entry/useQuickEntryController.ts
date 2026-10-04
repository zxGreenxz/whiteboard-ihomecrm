import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { vnTodayISO } from '@/lib/vnDate';
import type { DraftMode } from '@/lib/quickEntry/draft';
import { useQuickEntryRefs } from './useQuickEntryRefs';
import { useQuickEntryFeed } from './useQuickEntryFeed';

/** Mount once in the home screen; share this controller between inline composer and review sheet. */
export function useQuickEntryController(initialMode:DraftMode='personal'){
 const {data:user}=useAuth();const refs=useQuickEntryRefs();const today=vnTodayISO();
 const feed=useQuickEntryFeed({refs,userId:user?.id??null,today});
 const [chosen,setMode]=useState<DraftMode>(initialMode);
 const modes:DraftMode[]=[...(refs.canPersonal?['personal' as const]:[]),...(refs.canCompany?['company' as const]:[])];
 const mode=modes.includes(chosen)?chosen:modes[0]??'personal';
 const loading=refs.permissionsLoading||(mode==='personal'?refs.personalLoading:refs.companyLoading);
 const error=refs.permissionsError||(mode==='personal'?refs.personalError:refs.companyError);
 const ready=!loading&&!error&&modes.length>0&&(mode==='personal'?refs.personalReady:refs.companyReady);
 return {refs,feed,today,mode,modes,setMode,loading,error,ready,userId:user?.id??null};
}
export type QuickEntryController=ReturnType<typeof useQuickEntryController>;
