// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DepositScheduleFields, emptyDepositSchedule } from '../DepositScheduleFields';
vi.mock('@/components/ui/date-input',()=>({DateInput:(p: {value:string;onChange:(v:string)=>void;'aria-label':string})=>
  <input aria-label={p['aria-label']} value={p.value} onChange={e=>p.onChange(e.target.value)}/>}));
function Dates({date}:{date:string}){
  const [value,setValue]=useState(emptyDepositSchedule);
  return <DepositScheduleFields voucherDate={date} value={value} onChange={setValue}/>;
}
it('synchronizes hold dates until a manual change and offsets from the corrected voucher date',()=>{
  const view=render(<Dates date="2026-11-25"/>);
  const hold=screen.getByLabelText('Giữ chỗ đến'), move=screen.getByLabelText('Ngày dự kiến vào'), topup=screen.getByLabelText('Ngày bổ sung cọc');
  fireEvent.change(hold,{target:{value:'2026-11-30'}});
  expect(move).toHaveProperty('value','2026-11-30');
  fireEvent.change(move,{target:{value:'2026-12-01'}});
  fireEvent.change(hold,{target:{value:''}});
  expect(move).toHaveProperty('value','2026-12-01');
  for(const [offset,expected] of [[3,'2026-11-28'],[4,'2026-11-29'],[5,'2026-11-30'],[6,'2026-12-01'],[7,'2026-12-02']]){
    fireEvent.click(screen.getByRole('button',{name:'Sau ngày phiếu '+offset+' ngày'}));
    expect(topup).toHaveProperty('value',expected);
  }
  view.rerender(<Dates date="2026-12-31"/>);
  expect(topup).toHaveProperty('value','2027-01-07');
  fireEvent.change(topup,{target:{value:'2027-01-09'}});
  view.rerender(<Dates date="2027-01-20"/>);
  expect(topup).toHaveProperty('value','2027-01-09');
});
