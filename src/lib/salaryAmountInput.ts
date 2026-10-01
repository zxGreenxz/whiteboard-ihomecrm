import {parseCurrencyAmount,typedAmountText} from './currencyAmountInput';
export const parseSalaryAmount=parseCurrencyAmount;
export function formatSalaryAmountInput(raw:string,options:{allowNegative?:boolean}={}):string{const parsed=parseSalaryAmount(raw,options);return parsed.value==null?raw:parsed.value.toLocaleString('vi-VN');}
/** onChange of an input displayed through formatSalaryAmountInput(state): keystrokes regroup instead of turning 1.000 + 0 into an error. */
export function typedSalaryAmount(state:string,event:{target:HTMLInputElement;nativeEvent:Event},options:{allowNegative?:boolean}={}):string{return typedAmountText(formatSalaryAmountInput(state,options),event,options);}
