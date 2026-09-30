// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {createRef} from 'react';
import {LockedCurrencyInput} from '../locked-currency-input';
afterEach(cleanup);
it.each([true,false])('forwards the field ref and validation metadata when locked=%s',locked=>{
 const ref=createRef<HTMLInputElement>();
 render(<><label htmlFor="rent">Tiền thuê</label><LockedCurrencyInput ref={ref} id="rent" value={100} name="rent_price" locked={locked} onUnlock={vi.fn()} aria-invalid="true" aria-describedby="rent-error"/><p id="rent-error">Kiểm tra tiền thuê</p></>);
 const input=screen.getByRole('textbox',{name:'Tiền thuê'});
 expect(ref.current).toBe(input);expect(input.getAttribute('aria-invalid')).toBe('true');expect(input.getAttribute('aria-describedby')).toBe('rent-error');
 ref.current?.focus();expect(document.activeElement).toBe(input);
});
