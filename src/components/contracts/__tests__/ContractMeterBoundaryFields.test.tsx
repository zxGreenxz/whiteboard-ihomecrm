// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractMeterBoundaryFields } from '../ContractMeterBoundaryFields';
const state=vi.hoisted(()=>({data:[{id:'meter-a',status:'ACTIVE',meter_type:'ELECTRICITY',code:'D01'}],isPending:false,isError:false}));
vi.mock('@/hooks/useMeters',()=>({useMeters:()=>({...state,refetch:vi.fn()})}));
afterEach(cleanup);
describe('physical handover fields',()=>{
  it('allows missing outgoing readings without inventing zero',async()=>{
    const changed=vi.fn();render(<ContractMeterBoundaryFields roomId="room-a" allowMissing onChange={changed} />);
    await waitFor(()=>expect(changed).toHaveBeenLastCalledWith({state:'MISSING',reason:expect.any(String)}));
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });
  it('requires an explicit incoming reading and treats zero as a real value',async()=>{
    const changed=vi.fn();render(<ContractMeterBoundaryFields roomId="room-a" onChange={changed} />);
    await waitFor(()=>expect(changed).toHaveBeenLastCalledWith(null));
    fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'0'}});
    await waitFor(()=>expect(changed).toHaveBeenLastCalledWith({state:'VERIFIED',readings:[{meterId:'meter-a',reading:0,measuredAt:expect.any(String)}]}));
    fireEvent.change(screen.getByRole('spinbutton'),{target:{value:''}});
    await waitFor(()=>expect(changed).toHaveBeenLastCalledWith(null));
  });
});
