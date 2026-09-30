import * as React from "react";
import {cn} from "@/lib/utils";
import {Input} from "@/components/ui/input";
import {useInputDraftGuard} from '@/lib/inputDraftValidation';
interface NumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>,"value"|"onChange"|"type">{
 value?:number|null;onChange?:(value:number)=>void;allowDecimal?:boolean;min?:number;max?:number;className?:string;
}
function display(value?:number|null){return value!=null&&Number.isFinite(value)&&value!==0?String(value):'';}
export const NumberInput=React.forwardRef<HTMLInputElement,NumberInputProps>(function NumberInput(
 {value,onChange,onBlur,onFocus,allowDecimal=false,min,max,className,placeholder,...rest},ref){
 const [text,setText]=React.useState(()=>display(value));const [error,setError]=React.useState<string>();
 const [focused,setFocused]=React.useState(false);const lastEmitted=React.useRef<number>();
 const inputRef=React.useRef<HTMLInputElement|null>(null);const errorId=React.useId()+'-number-error';
 const setRef=React.useCallback((node:HTMLInputElement|null)=>{inputRef.current=node;if(typeof ref==='function')ref(node);else if(ref)ref.current=node;},[ref]);
 useInputDraftGuard(inputRef,error);
 React.useEffect(()=>{if(focused||error||Object.is(value,lastEmitted.current)||Number.isNaN(value))return;setText(display(value));},[value,focused]);
 const handleChange=(event:React.ChangeEvent<HTMLInputElement>)=>{
  const raw=event.target.value;const normalized=raw.trim().replace(',','.');
  let message:string|undefined;const valid=normalized===''||(allowDecimal?/^-?(?:\d+(?:\.\d+)?|\.\d+)$/:/^-?\d+$/).test(normalized);
  const number=normalized===''?0:Number(normalized);
  if(!valid||!Number.isFinite(number)||Math.abs(number)>Number.MAX_SAFE_INTEGER)message=allowDecimal?'Nhập số hợp lệ, ví dụ 12,5; không nhập chữ.':'Nhập số nguyên hợp lệ; không nhập chữ hoặc số lẻ.';
  else if(min!==undefined&&number<min)message=`Giá trị phải từ ${min.toLocaleString('vi-VN')} trở lên.`;
  else if(max!==undefined&&number>max)message=`Giá trị không được vượt ${max.toLocaleString('vi-VN')}.`;
  setText(raw);setError(message);const next=message?Number.NaN:number;lastEmitted.current=next;onChange?.(next);
 };
 return <div><Input {...rest} ref={setRef} inputMode={allowDecimal?'decimal':'numeric'} placeholder={placeholder??'0'} value={text}
  aria-invalid={error?true:rest['aria-invalid']} aria-describedby={[rest['aria-describedby'],error?errorId:undefined].filter(Boolean).join(' ')||undefined}
  data-input-error={error?'true':undefined} onChange={handleChange} onFocus={e=>{setFocused(true);onFocus?.(e);}} onBlur={e=>{setFocused(false);onBlur?.(e);}} className={cn(className)}/>
  {error&&<p id={errorId} role="alert" className="mt-1 text-sm font-medium text-destructive">{error}</p>}
 </div>;
});
