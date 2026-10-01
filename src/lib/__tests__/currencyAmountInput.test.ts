import {expect,it} from 'vitest';
import {caretAfterDigits,parseCurrencyAmount,regroupTypedAmount} from '../currencyAmountInput';
it('regroups digits typed or deleted inside text the field grouped itself',()=>{
 expect(regroupTypedAmount('1.000','1.0000',{inputType:'insertText',data:'0'})).toBe('10000');
 expect(parseCurrencyAmount(regroupTypedAmount('1.000','1.0000')).value).toBe(10000);
 expect(regroupTypedAmount('-1.000','-1.0000',{allowNegative:true})).toBe('-10000');
 expect(regroupTypedAmount('15.500.000','15.00.000',{inputType:'deleteContentBackward',data:null})).toBe('1500000');
 expect(regroupTypedAmount('','1000')).toBe('1000');
 expect(regroupTypedAmount('0','05',{inputType:'insertText',data:'5'})).toBe('05');
});
it('leaves pasted, replaced or multi-character separators and text the field did not group for the strict parser',()=>{
 for(const [previous,raw,inputType,data] of [['1.000','1.5','insertFromPaste',null],['1.000','1.000.','insertText','.'],['1.000','1.000,5','insertText',',5'],['1.000','1.5','insertText','1.5'],['1.000','1.5','insertReplacementText',null],['','1.5','',null],['1.','1.5','',null],['1.0000','1.00000','',null],['abc','abc1','',null],['-1.000','-1.0000','',null]] as const)
  expect(regroupTypedAmount(previous,raw,{inputType,data})).toBe(raw);
});
it('keeps zeros left by deleting the leading digit so the next digit restores the amount',()=>{
 expect(regroupTypedAmount('1.000.000','.000.000',{inputType:'deleteContentBackward',data:null})).toBe('.000.000');
 expect(regroupTypedAmount('10.000','0.000',{inputType:'deleteContentBackward',data:null})).toBe('0.000');
 for(const raw of ['.000.000','0.000','01.000'])expect(parseCurrencyAmount(raw).error).toBeTruthy();
 expect(parseCurrencyAmount('2.000.000').value).toBe(2000000);expect(parseCurrencyAmount('0').value).toBe(0);
});
it('places the caret by digit count, before the next digit after a forward delete',()=>{
 expect(caretAfterDigits('1.500.000',2)).toBe(3);expect(caretAfterDigits('15.500.000',3)).toBe(4);
 expect(caretAfterDigits('-1.000',0)).toBe(1);expect(caretAfterDigits('10',5)).toBe(2);
 expect(caretAfterDigits('1.000',1,true)).toBe(2);expect(caretAfterDigits('100',1,true)).toBe(1);expect(caretAfterDigits('100',3,true)).toBe(3);
});
