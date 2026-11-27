// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import AiRoutingPage from './AiRoutingPage';

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({children}: {children: React.ReactNode}) => <main>{children}</main> }));
vi.mock('@/hooks/useAiRouting', () => ({
  useAiRouting: () => ({ query: { data: {
    enabled: true, ready: { nous:true, '9router':true }, syncErrors: [],
    catalogs: [
      { provider:'nous', models:[{id:'openai/ok',vision:true,verified:true},{id:'openai/broken',vision:true,verified:false}] },
      { provider:'9router', models:[{id:'cx/model[1m]',vision:true,verified:true},{id:'ag/gemini',vision:true,verified:true}] },
    ],
    apps:[{ app:'quick_read', revision:7, routes:[] },{ app:'quick_stt', revision:0, routes:[] }],
  } }, change: { mutate } }),
}));
describe('Nguồn AI', () => {
  it('enables saving only a verified pair, retains its exact IDs and leaves speech on its existing route', () => {
    render(<AiRoutingPage />);
    const card = within(screen.getByRole('region',{ name:'Báo chi nhanh' }));
    const save = card.getByRole('button',{ name:'Lưu lựa chọn' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(card.queryByRole('option',{ name:'openai/broken' })).toBeNull();
    const selects = card.getAllByLabelText('Model');
    fireEvent.change(selects[0], {target:{value:'openai/ok'}});
    fireEvent.change(selects[1], {target:{value:'cx/model[1m]'}});
    fireEvent.click(save);
    expect(mutate).toHaveBeenCalledWith({action:'save',app:'quick_read',revision:7,routes:[{provider:'nous',model:'openai/ok'},{provider:'9router',model:'cx/model[1m]'}]});
    expect(within(screen.getByRole('region',{name:'Chép giọng nói'})).queryByRole('combobox')).toBeNull();
  });
});
