// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {createRef,useState} from 'react';
import {CurrencyInput} from '../currency-input';
import {DateInput} from '../date-input';
import {NumberInput} from '../number-input';
afterEach(cleanup);
it.each(['-100','abc100','1.5','9007199254740992'])('keeps invalid amount %s, marks the actual input and prevents native/noValidate submit',raw=>{
 const save=vi.fn();const change=vi.fn();
 function Form(){const [value,setValue]=useState(800000);return <form noValidate onSubmit={e=>{e.preventDefault();save(value);}}><label htmlFor="amount">Số tiền</label><CurrencyInput id="amount" name="amount" value={value} onChange={n=>{change(n);setValue(n);}}/><button type="submit">Lưu</button></form>;}
 render(<Form/>);const input=screen.getByLabelText('Số tiền') as HTMLInputElement;
 fireEvent.change(input,{target:{value:raw}});fireEvent.blur(input);
 expect(input.value).toBe(raw);expect(input).toHaveProperty('validationMessage',expect.any(String));expect(input.getAttribute('aria-invalid')).toBe('true');
 expect(screen.getByRole('alert').textContent).toMatch(/Số tiền|Nhập số tiền/);expect(Number.isNaN(change.mock.calls[0][0])).toBe(true);
 fireEvent.submit(input.closest('form')!);expect(save).not.toHaveBeenCalled();expect(document.activeElement).toBe(input);
});
it('clears local amount error after correction and forwards the real ref and existing description',()=>{
 const ref=createRef<HTMLInputElement>();const change=vi.fn();
 render(<><CurrencyInput ref={ref} name="amount" value={0} onChange={change} aria-label="Tiền" aria-describedby="hint"/><p id="hint">Tiền phòng</p></>);
 fireEvent.change(ref.current!,{target:{value:'abc100'}});expect(ref.current?.getAttribute('aria-describedby')).toContain('hint');
 fireEvent.change(ref.current!,{target:{value:'1.200.000'}});expect(ref.current?.value).toBe('1.200.000');expect(change).toHaveBeenLastCalledWith(1200000);expect(screen.queryByRole('alert')).toBeNull();expect(ref.current?.validity.valid).toBe(true);
});
it.each(['31/02/2026','01/13/2026','10/10/20','abc'])('keeps invalid date %s rather than restoring a previous date',raw=>{
 const save=vi.fn();const change=vi.fn();
 function Form(){const [value,setValue]=useState('2026-10-10');return <form noValidate onSubmit={e=>{e.preventDefault();save(value);}}><DateInput aria-label="Ngày" value={value} onChange={v=>{change(v);setValue(v);}}/><button type="submit">Lưu</button></form>;}
 render(<Form/>);const input=screen.getByLabelText('Ngày') as HTMLInputElement;
 fireEvent.change(input,{target:{value:raw}});fireEvent.blur(input);
 expect(input.value).toBe(raw);expect(input.getAttribute('aria-invalid')).toBe('true');expect(screen.getByRole('alert').textContent).toContain('ngày');expect(change).not.toHaveBeenCalledWith('2026-10-10');
 fireEvent.submit(input.closest('form')!);expect(save).not.toHaveBeenCalled();expect(document.activeElement).toBe(input);
});
it('accepts a complete valid date and preserves it through controlled rerender',()=>{
 const change=vi.fn();function Form(){const [v,set]=useState('');return <DateInput aria-label="Ngày" value={v} onChange={n=>{change(n);set(n);}}/>;}
 render(<Form/>);const input=screen.getByLabelText('Ngày') as HTMLInputElement;fireEvent.change(input,{target:{value:'29102026'}});fireEvent.blur(input);
 expect(change).toHaveBeenLastCalledWith('2026-10-29');expect(input.value).toBe('29/10/2026');expect(screen.queryByRole('alert')).toBeNull();
});

it('does not lose an invalid amount on blur when a parent rejects the emitted value',()=>{
 render(<CurrencyInput aria-label="Tiền" value={900} onChange={vi.fn()}/>);const input=screen.getByLabelText('Tiền');
 fireEvent.focus(input);fireEvent.change(input,{target:{value:'abc100'}});fireEvent.blur(input);
 expect((input as HTMLInputElement).value).toBe('abc100');expect(input.getAttribute('aria-invalid')).toBe('true');
});

it.each(['-1','1.5','abc2','0','241'])('does not clamp or strip invalid quantity %s before submitting',raw=>{
 const save=vi.fn();const change=vi.fn();function Form(){const [v,set]=useState(2);return <form noValidate onSubmit={e=>{e.preventDefault();save(v);}}><NumberInput aria-label="Số lần" min={1} max={240} value={v} onChange={n=>{change(n);set(n);}}/><button>Lưu</button></form>;}
 render(<Form/>);const input=screen.getByLabelText('Số lần') as HTMLInputElement;fireEvent.change(input,{target:{value:raw}});fireEvent.blur(input);
 expect(input.value).toBe(raw);expect(input.getAttribute('aria-invalid')).toBe('true');expect(Number.isNaN(change.mock.calls[0][0])).toBe(true);
 fireEvent.submit(input.closest('form')!);expect(save).not.toHaveBeenCalled();expect(document.activeElement).toBe(input);
});
it('retains existing decimal and signed-number rules when allowed by the field',()=>{
 const change=vi.fn();render(<NumberInput aria-label="Chỉ số" allowDecimal min={-2} value={0} onChange={change}/>);const input=screen.getByLabelText('Chỉ số');
 fireEvent.change(input,{target:{value:'-1,25'}});expect(change).toHaveBeenLastCalledWith(-1.25);expect(screen.queryByRole('alert')).toBeNull();
});

it('validates every RHF field and focuses an earlier missing field before a later malformed date',async()=>{
 const {useForm}=await import('react-hook-form');const {Form,FormField,FormItem,FormControl,FormMessage}=await import('../form');
 const {zodResolver}=await import('@hookform/resolvers/zod');const {z}=await import('zod');const {waitFor}=await import('@testing-library/react');
 const save=vi.fn();function Fixture(){const form=useForm({resolver:zodResolver(z.object({building:z.string().min(1,'Chọn tòa nhà.'),date:z.string()})),defaultValues:{building:'',date:'2026-10-10'}});
  return <Form {...form}><form noValidate onSubmit={form.handleSubmit(save)}><FormField control={form.control} name="building" render={({field})=><FormItem><FormControl><input {...field} aria-label="Tòa nhà"/></FormControl><FormMessage/></FormItem>}/><FormField control={form.control} name="date" render={({field})=><FormItem><FormControl><DateInput {...field} aria-label="Ngày"/></FormControl><FormMessage/></FormItem>}/><button>Lưu</button></form></Form>;}
 render(<Fixture/>);fireEvent.change(screen.getByLabelText('Ngày'),{target:{value:'31/02/2026'}});fireEvent.submit(screen.getByRole('button',{name:'Lưu'}).closest('form')!);
 await waitFor(()=>expect(document.activeElement).toBe(screen.getByLabelText('Tòa nhà')));expect(screen.getByLabelText('Tòa nhà').getAttribute('aria-invalid')).toBe('true');
 expect(screen.getByText('Chọn tòa nhà.')).toBeTruthy();expect(screen.getByLabelText('Ngày').getAttribute('aria-invalid')).toBe('true');expect(save).not.toHaveBeenCalled();
});
