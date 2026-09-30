import * as React from "react";
import {cn} from "@/lib/utils";
import {Input} from "@/components/ui/input";
import {parseCurrencyAmount} from '@/lib/currencyAmountInput';
import {useInputDraftGuard} from '@/lib/inputDraftValidation';

interface CurrencyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>,"value"|"onChange"|"type">{
 value?:number|null;onChange?:(value:number)=>void;suffix?:boolean;className?:string;
 /** Only set where the existing business rule permits signed amounts. */
 allowNegative?:boolean;
}
function display(value?:number|null){return value!=null&&Number.isFinite(value)&&value!==0?value.toLocaleString('vi-VN'):'';}
export const CurrencyInput=React.forwardRef<HTMLInputElement,CurrencyInputProps>(function CurrencyInput(
 {value,onChange,onBlur,suffix=true,className,placeholder,allowNegative=false,...rest},ref){
 const [text,setText]=React.useState(()=>display(value));const [error,setError]=React.useState<string>();
 const [focused,setFocused]=React.useState(false);const lastEmitted=React.useRef<number|undefined>();
 const inputRef=React.useRef<HTMLInputElement|null>(null);const errorId=React.useId()+'-currency-error';
 const setRef=React.useCallback((node:HTMLInputElement|null)=>{inputRef.current=node;if(typeof ref==='function')ref(node);else if(ref)ref.current=node;},[ref]);
 useInputDraftGuard(inputRef,error);
 React.useEffect(()=>{
  if(Object.is(value,lastEmitted.current)||focused||Number.isNaN(value)||error)return;
  setText(display(value));setError(undefined);
 },[value,focused]);
 const handleChange=(e:React.ChangeEvent<HTMLInputElement>)=>{
  const raw=e.target.value;const parsed=parseCurrencyAmount(raw,{allowNegative,emptyAsZero:true});
  setText(parsed.value==null?raw:raw.trim()===''?'':parsed.value.toLocaleString('vi-VN'));setError(parsed.error);
  const next=parsed.value??Number.NaN;lastEmitted.current=next;onChange?.(next);
 };
 const describedBy=[rest['aria-describedby'],error?errorId:undefined].filter(Boolean).join(' ')||undefined;
 return <div className="relative w-full">
  <div className="relative"><Input {...rest} ref={setRef} inputMode="numeric" placeholder={placeholder??'0'} value={text}
   aria-invalid={error?true:rest['aria-invalid']} aria-describedby={describedBy} data-input-error={error?'true':undefined}
   onChange={handleChange} onFocus={e=>{setFocused(true);rest.onFocus?.(e);}} onBlur={e=>{setFocused(false);onBlur?.(e);}}
   className={cn(suffix?'pr-8':undefined,className)}/>
   {suffix&&<span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">đ</span>}
  </div>
  {error&&<p id={errorId} role="alert" className="mt-1 text-sm font-medium text-destructive">{error}</p>}
 </div>;
});
