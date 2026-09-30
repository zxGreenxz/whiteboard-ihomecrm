import {parseCurrencyAmount} from './currencyAmountInput';
export const parseSalaryAmount=parseCurrencyAmount;
export function formatSalaryAmountInput(raw:string,options:{allowNegative?:boolean}={}):string{const parsed=parseSalaryAmount(raw,options);return parsed.value==null?raw:parsed.value.toLocaleString('vi-VN');}
