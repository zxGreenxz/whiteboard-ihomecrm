/** Whole-dong parsing preserves invalid input instead of silently changing its value. */
export function parseCurrencyAmount(raw:string,options:{allowNegative?:boolean;emptyAsZero?:boolean}={}):{value:number|null;error?:string}{
 const text=raw.trim();
 if(!text)return options.emptyAsZero?{value:0}:{value:null,error:'Nhập số tiền.'};
 const negative=text.startsWith('-');const unsigned=negative?text.slice(1):text;
 if(negative&&!options.allowNegative)return {value:null,error:'Số tiền không được âm.'};
 if(!/^(?:\d+|\d{1,3}(?:[., ]\d{3})+)$/.test(unsigned))return {value:null,error:'Nhập số tiền nguyên theo đồng, ví dụ 800.000; không nhập chữ hoặc số lẻ.'};
 const value=Number(unsigned.replace(/[., ]/g,''))*(negative?-1:1);
 return Number.isSafeInteger(value)?{value}:{value:null,error:'Số tiền quá lớn. Kiểm tra lại số tiền.'};
}
