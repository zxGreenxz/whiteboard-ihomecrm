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
      { provider:'nous', models:[{id:'openai/ok',vision:true,verified:true},{id:'openai/unprobed',vision:true,verified:false},{id:'openai/text',text:true,vision:false},{id:'openai/text-2',text:true,vision:false},{id:'openai/model:batch',text:false,vision:false}] },
      { provider:'9router', models:[{id:'cx/model[1m]',vision:true,verified:true},{id:'ag/gemini',vision:true,verified:true}] },
    ],
    apps:[{ app:'quick_read', revision:7, routes:[] },{ app:'quick_stt', revision:0, routes:[] }],
  } }, change: { mutate } }),
}));
describe('Nguồn AI', () => {
  it('offers entitled Nous models before a probe, keeps exact model IDs and excludes batch and speech', () => {
    render(<AiRoutingPage />);
    const card = within(screen.getByRole('region',{ name:'Báo chi nhanh' }));
    const save = card.getByRole('button',{ name:'Lưu lựa chọn' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(card.getByRole('option',{ name:/openai\/unprobed/ })).toBeTruthy();
    expect(card.getAllByRole('option',{ name:/chỉ văn bản/ })).toHaveLength(2);
    expect(card.queryByRole('option',{ name:/batch/ })).toBeNull();
    const selects = card.getAllByLabelText('Model');
    fireEvent.change(selects[0], {target:{value:'openai/unprobed'}});
    fireEvent.change(selects[1], {target:{value:'cx/model[1m]'}});
    fireEvent.click(save);
    expect(mutate).toHaveBeenCalledWith({action:'save',app:'quick_read',revision:7,routes:[{provider:'nous',model:'openai/unprobed'},{provider:'9router',model:'cx/model[1m]'}]});
    fireEvent.change(card.getAllByLabelText('Nguồn')[1], {target:{value:'nous'}});
    fireEvent.change(selects[0], {target:{value:'openai/text'}});
    fireEvent.change(selects[1], {target:{value:'openai/text-2'}});
    expect(save.disabled).toBe(true);
    expect(card.getByRole('status').textContent).toContain('đọc được ảnh');
    expect(within(screen.getByRole('region',{name:'Chép giọng nói'})).queryByRole('combobox')).toBeNull();
  });
});
