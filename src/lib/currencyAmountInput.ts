/** Whole-dong parsing preserves invalid input instead of silently changing its value. A grouped amount never starts with 0 ("0.000", "01.000"). */
export function parseCurrencyAmount(raw:string,options:{allowNegative?:boolean;emptyAsZero?:boolean}={}):{value:number|null;error?:string}{
 const text=raw.trim();
 if(!text)return options.emptyAsZero?{value:0}:{value:null,error:'Nhập số tiền.'};
 const negative=text.startsWith('-');const unsigned=negative?text.slice(1):text;
 if(negative&&!options.allowNegative)return {value:null,error:'Số tiền không được âm.'};
 if(!/^(?:\d+|[1-9]\d{0,2}(?:[., ]\d{3})+)$/.test(unsigned))return {value:null,error:'Nhập số tiền nguyên theo đồng, ví dụ 800.000; không nhập chữ hoặc số lẻ.'};
 const value=Number(unsigned.replace(/[., ]/g,''))*(negative?-1:1);
 return Number.isSafeInteger(value)?{value}:{value:null,error:'Số tiền quá lớn. Kiểm tra lại số tiền.'};
}

type AmountEdit={inputType?:string;data?:string|null;allowNegative?:boolean};

/**
 * A keystroke inside text the field grouped itself only adds or removes digits, so every dot left is ours:
 * drop them and let the caller regroup ("1.000" + "0" → "10000"). Pasted, replaced or multi-character text carrying
 * separators stays strict, and so does a leading digit deleted down to zeros (".000.000" waits for its new first digit).
 */
export function regroupTypedAmount(previous:string,raw:string,{inputType='',data,allowNegative=false}:AmountEdit={}):string{
 if(inputType.startsWith('insertFrom')||inputType==='insertReplacementText')return raw;
 if(inputType==='insertText'&&data!=null&&!/^\d*$/.test(data))return raw;
 const prior=parseCurrencyAmount(previous,{allowNegative,emptyAsZero:true});
 if(prior.value==null||(previous!==''&&prior.value.toLocaleString('vi-VN')!==previous))return raw;
 let start=0;while(start<previous.length&&start<raw.length&&previous[start]===raw[start])start++;
 let end=0;while(end<previous.length-start&&end<raw.length-start&&previous[previous.length-1-end]===raw[raw.length-1-end])end++;
 if(!/^\d*$/.test(raw.slice(start,raw.length-end)))return raw;
 const regrouped=raw.replace(/\./g,'');
 return prior.value!==0&&/^-?0\d/.test(regrouped)?raw:regrouped;
}

/** Caret index after the first `digits` digits; with beforeNext, right before the following digit so Delete moves past a dot. */
export function caretAfterDigits(text:string,digits:number,beforeNext=false):number{
 if(digits<=0&&!beforeNext)return text.startsWith('-')?1:0;
 for(let i=0,seen=0;i<text.length;i++){
  if(!/\d/.test(text.charAt(i)))continue;
  if(beforeNext&&seen===digits)return i;
  if(++seen===digits&&!beforeNext)return i+1;
 }
 return text.length;
}

/**
 * onChange of a grouped amount input: returns the text to parse and, once React has written the regrouped value
 * (it flushes controlled inputs before microtasks), puts the caret back by the same digit instead of the end.
 */
export function typedAmountText(previous:string,event:{target:HTMLInputElement;nativeEvent:Event},options:{allowNegative?:boolean}={}):string{
 const node=event.target,raw=node.value,caret=node.selectionStart;const {inputType,data}=event.nativeEvent as InputEvent;
 if(caret!=null){
  const before=raw.slice(0,caret).replace(/\D/g,'').length;
  const droppedZeros=Math.min(before,raw.replace(/\D/g,'').match(/^0+(?=\d)/)?.[0].length??0);
  const forward=inputType==='deleteContentForward';
  queueMicrotask(()=>{if(node.value===raw||node.ownerDocument.activeElement!==node)return;const at=caretAfterDigits(node.value,before-droppedZeros,forward);node.setSelectionRange(at,at);});
 }
 return regroupTypedAmount(previous,raw,{inputType,data,allowNegative:options.allowNegative});
}
