import {it,expect} from 'vitest';
import {parseSalaryAmount} from '../salaryAmountInput';
it('giữ số tiền đã định dạng, không bỏ dấu âm/chữ/số lẻ',()=>{expect(parseSalaryAmount('8.000.000').value).toBe(8000000);for(const raw of ['-100','abc100','100abc','1.5','1e5','9007199254740992'])expect(parseSalaryAmount(raw).error).toBeTruthy();});
it('âm chỉ hợp lệ ở khoản cho phép âm; rỗng tùy quy tắc đang có',()=>{expect(parseSalaryAmount('-680.000',{allowNegative:true}).value).toBe(-680000);expect(parseSalaryAmount('').value).toBeNull();expect(parseSalaryAmount('',{emptyAsZero:true}).value).toBe(0);expect(parseSalaryAmount('0').value).toBe(0);});
