import { useContext, useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, RotateCcw, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { PopoverContainerContext } from '@/components/ui/popover';
import { SkeletonBar } from '@/components/loading/LoadingState';
import { cn } from '@/lib/utils';
import { PERSONAL_ATTACHMENT_LIMIT, signPersonalAttachment, uploadPersonalAttachment } from '@/lib/personalFinance/personalAttachments';

const TILE='relative h-20 w-20 shrink-0';

/** Grey tile while a private URL is signed or a file uploads; the words are for screen readers only. */
function TileSkeleton({label}:{label:string}){
 return <span role="status" className={TILE}><span className="sr-only">{label}</span><SkeletonBar className="ld-appear h-20 w-20 rounded-md"/></span>;
}

function PrivateImage({ownerId,path,index,onUnlink}:{ownerId:string;path:string;index:number;onUnlink?:()=>void}){
 const [url,setUrl]=useState<string|null>(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0),[open,setOpen]=useState(false);
 // Inside a native modal sheet only its top-layer element is interactive; a body portal would sit under it.
 const container=useContext(PopoverContainerContext);
 const n=index+1;
 useEffect(()=>{let alive=true;setUrl(null);setError(false);void signPersonalAttachment(ownerId,path).then(value=>{if(alive)setUrl(value);}).catch(()=>{if(alive)setError(true);});return()=>{alive=false;};},[ownerId,path,attempt]);
 return <div className={TILE}>
  {error?<>
   <button type="button" onClick={()=>setAttempt(k=>k+1)} className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-destructive/40 bg-destructive/5 text-[11px] text-destructive">
    <RotateCcw className="h-4 w-4" aria-hidden="true"/><span aria-hidden="true">Tải lại</span><span className="sr-only">Thử tải ảnh {n} lại</span>
   </button>
   <span role="alert" className="sr-only">Không tải được ảnh chứng từ.</span>
  </>:url?<button type="button" aria-label={`Xem ảnh chứng từ ${n}`} onClick={()=>setOpen(true)} className="block h-20 w-20 overflow-hidden rounded-md border bg-muted">
   <img src={url} alt={`Ảnh chứng từ ${n}`} onError={()=>setError(true)} className="h-full w-full object-cover"/>
  </button>:<TileSkeleton label={`Đang tải ảnh chứng từ ${n}…`}/>}
  {/* 44px touch target (also the sheet's button minimum) around a small visible badge. */}
  {onUnlink&&<button type="button" aria-label={`Gỡ ảnh chứng từ ${n}`} onClick={onUnlink} className="absolute -right-3 -top-3 grid h-11 w-11 place-items-center">
   <span className="grid h-7 w-7 place-items-center rounded-full border bg-background text-foreground shadow-sm"><X className="h-4 w-4" aria-hidden="true"/></span>
  </button>}
  <Dialog open={open} onOpenChange={setOpen}><DialogContent container={container} aria-describedby={undefined} className="max-w-3xl"><DialogTitle>Ảnh chứng từ {n}</DialogTitle>{url&&!error&&<img src={url} alt="Ảnh chứng từ phóng lớn" onError={()=>{setError(true);setOpen(false);}} className="max-h-[80vh] w-full object-contain"/>}</DialogContent></Dialog>
 </div>;
}

/** A path editor only: durable objects are never deleted or overwritten by this component. */
export function PersonalAttachments(props:{ownerId:string;instanceKey:string;paths:readonly string[];editable:boolean;reservedCount?:number;onChange:(paths:string[])=>void;onBlockedChange:(blocked:boolean)=>void}){
 const [uploading,setUploading]=useState(false),[remaining,setRemaining]=useState<File[]>([]),[error,setError]=useState<string|null>(null);
 const latest=useRef(props);latest.current=props;
 const controller=useRef<AbortController|null>(null),alive=useRef(true),input=useRef<HTMLInputElement|null>(null);
 const generation=useRef({ownerId:props.ownerId,instanceKey:props.instanceKey,epoch:0});
 if(generation.current.ownerId!==props.ownerId||generation.current.instanceKey!==props.instanceKey)generation.current={ownerId:props.ownerId,instanceKey:props.instanceKey,epoch:generation.current.epoch+1};
 useEffect(()=>{alive.current=true;setRemaining([]);setError(null);setUploading(false);latest.current.onBlockedChange(false);return()=>{alive.current=false;controller.current?.abort();controller.current=null;};},[props.ownerId,props.instanceKey]);
 async function upload(files:File[]){
  if(controller.current||!latest.current.editable)return;
  if(latest.current.paths.length+files.length+(latest.current.reservedCount??0)>PERSONAL_ATTACHMENT_LIMIT){setError(`Tối đa ${PERSONAL_ATTACHMENT_LIMIT} ảnh chứng từ.`);return;}
  if(files.some(f=>!['image/jpeg','image/png','image/webp'].includes(f.type))){setError('Chỉ nhận ảnh JPG, PNG hoặc WebP.');return;}
  const epoch=generation.current.epoch,ownerId=props.ownerId,abort=new AbortController();controller.current=abort;
  const active=()=>alive.current&&!abort.signal.aborted&&generation.current.epoch===epoch;
  setUploading(true);setError(null);setRemaining(files);latest.current.onBlockedChange(true);
  let rest=files;
  try{
   for(const file of files){
    const path=await uploadPersonalAttachment(ownerId,file,abort.signal);
    if(!active())return;
    rest=rest.slice(1);setRemaining(rest);
    const paths=[...latest.current.paths,path];
    latest.current={...latest.current,paths};
    latest.current.onChange(paths);
   }
   if(active())latest.current.onBlockedChange(false);
  }catch(e){if(active()){setError(e instanceof Error?e.message:'Không tải được ảnh chứng từ.');setRemaining(rest);}}
  finally{if(active())setUploading(false);if(controller.current===abort)controller.current=null;}
 }
 const count=props.paths.length+(props.reservedCount??0);
 const full=count>=PERSONAL_ATTACHMENT_LIMIT,addDisabled=uploading||!!remaining.length||full;
 return <section aria-label="Ảnh chứng từ" className="space-y-2">
  <p className="text-sm font-medium">Ảnh chứng từ <span className="font-normal text-muted-foreground">({count}/{PERSONAL_ATTACHMENT_LIMIT})</span></p>
  {(props.paths.length>0||uploading)&&<div className="flex flex-wrap gap-3 pr-3 pt-3">
   {props.paths.map((path,index)=><PrivateImage key={`${props.ownerId}/${path}`} ownerId={props.ownerId} path={path} index={index} onUnlink={props.editable&&!uploading&&!remaining.length?()=>props.onChange(props.paths.filter((_,i)=>i!==index)):undefined}/>)}
   {uploading&&remaining.map((file,index)=><TileSkeleton key={index} label={`Đang tải ảnh chứng từ ${props.paths.length+index+1}…`}/>)}
  </div>}
  {props.editable&&<>
   {/* The native input stays the labelled control; the label is only its touch-friendly face. */}
   <label aria-disabled={addDisabled||undefined} className={cn(buttonVariants({variant:'outline',size:'sm'}),'cursor-pointer gap-2 focus-within:ring-2 focus-within:ring-ring',addDisabled&&'pointer-events-none opacity-50')}>
    {uploading?<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true"/>:<ImagePlus className="h-4 w-4" aria-hidden="true"/>}
    <span aria-hidden="true">{uploading?'Đang tải ảnh…':full?'Đã đủ ảnh':'Thêm ảnh'}</span>
    <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp" aria-label="Thêm ảnh chứng từ" disabled={addDisabled} onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';if(files.length)void upload(files);}} className="sr-only"/>
   </label>
   {uploading&&<p role="status" className="sr-only">Đang tải ảnh chứng từ…</p>}
   {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
   {!uploading&&remaining.length>0&&<div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={()=>void upload(remaining)}>Thử tải ảnh lại</Button><Button type="button" variant="ghost" size="sm" onClick={()=>{setRemaining([]);setError(null);props.onBlockedChange(false);}}>Bỏ ảnh chưa tải</Button></div>}
  </>}
 </section>;
}
