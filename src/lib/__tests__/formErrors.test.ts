// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusFirstError, flattenFieldErrors } from '../formErrors';

afterEach(() => { document.body.innerHTML = ''; });
describe('form error navigation', () => {
  it('flattens nested row errors without including RHF refs', () => {
    expect(flattenFieldErrors({ items: [{}, { amount: { type: 'min', message: 'Nhập số tiền', ref: document.createElement('input') } }] })).toEqual({ 'items.1.amount': 'Nhập số tiền' });
  });
  it('follows DOM order, including custom select triggers instead of error object order', async () => {
    document.body.innerHTML = '<form><button data-field-name="building_id">Tòa</button><input name="name" /></form>';
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    await focusFirstError({ name: { message: 'Nhập tên' }, building_id: { message: 'Chọn tòa' } });
    expect(document.activeElement?.getAttribute('data-field-name')).toBe('building_id');
    expect(scroll).toHaveBeenCalled();
  });
  it('opens an unmounted earlier tab before focusing instead of skipping to a visible later error', async () => {
    document.body.innerHTML = '<form><input name="later" /></form>';
    const reveal = vi.fn(async (name: string) => {
      if (name === 'first') document.querySelector('form')!.insertAdjacentHTML('afterbegin', '<input name="first" />');
    });
    await focusFirstError({ later: 'Sai', first: 'Thiếu' }, { order: ['first', 'later'], reveal });
    expect(reveal).toHaveBeenCalledWith('first');
    expect(document.activeElement?.getAttribute('name')).toBe('first');
  });
  it('focuses the visible upload button, not its hidden file input, and stays within the form', async () => {
    document.body.innerHTML = '<input name="attachments" /><form><div data-field-name="attachments"><input type="file" hidden /><button>Thêm tệp</button></div></form>';
    await focusFirstError({ attachments: 'Thêm chứng từ' }, { root: document.querySelector('form') });
    expect(document.activeElement?.textContent).toBe('Thêm tệp');
  });
  it('does not focus a random field for system/root errors', async () => {
    document.body.innerHTML = '<input name="name" />';
    expect(await focusFirstError({ root: { server: { message: 'Chưa lưu được' } } })).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
  it('ignores a responsive copy hidden by an ancestor CSS rule', async () => {
    document.body.innerHTML = '<div style="display:none"><input name="price" /></div><div><input name="price" data-testid="visible" /></div>';
    await focusFirstError({price:'Nhập giá'});
    expect(document.activeElement?.getAttribute('data-testid')).toBe('visible');
  });
});

it('opens native collapsed details before focusing the field inside',async()=>{
 document.body.innerHTML='<form><details><summary>Phần thêm</summary><input name="first"/></details><input name="later"/></form>';
 await focusFirstError({later:'Sai',first:'Thiếu'});expect(document.querySelector('details')?.open).toBe(true);expect(document.activeElement?.getAttribute('name')).toBe('first');
});
it('activates a mounted hidden tab panel before focusing its earlier field',async()=>{
 document.body.innerHTML='<form><button type="button" role="tab" id="first-tab" aria-controls="first-panel">Tab đầu</button><div id="first-panel" role="tabpanel" aria-labelledby="first-tab" hidden><input name="first"/></div><input name="later"/></form>';
 document.getElementById('first-tab')!.onclick=()=>{document.getElementById('first-panel')!.hidden=false;};
 await focusFirstError({later:'Sai',first:'Thiếu'},{order:['first','later']});expect(document.activeElement?.getAttribute('name')).toBe('first');
});

it('waits for the submitted fieldset to unlock before focusing a server error', async () => {
  document.body.innerHTML = '<form><fieldset disabled><input name="start_billing_date" /></fieldset></form>';
  const root = document.querySelector('form')!;
  const focus = focusFirstError({start_billing_date:'Kiểm tra ngày tính tiền'}, {root, waitForEnabled:true});
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(document.activeElement).toBe(document.body);
  document.querySelector('fieldset')!.disabled=false;
  expect(await focus).toBe(true);
  expect(document.activeElement?.getAttribute('name')).toBe('start_billing_date');
});

it('waits for a closing confirmation dialog to reveal the parent form before focusing', async () => {
  document.body.innerHTML='<div aria-hidden="true"><form><input name="start_billing_date" /></form></div>';
  const root=document.querySelector('form')!;
  const focus=focusFirstError({start_billing_date:'Kiểm tra ngày'}, {root,waitForEnabled:true});
  await new Promise(resolve=>setTimeout(resolve,20));
  document.querySelector('div')!.removeAttribute('aria-hidden');
  expect(await focus).toBe(true);
  expect(document.activeElement?.getAttribute('name')).toBe('start_billing_date');
});
