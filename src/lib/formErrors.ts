import type { FieldPath, FieldValues, UseFormReturn } from 'react-hook-form';

export interface ErrorFocusOptions {
  root?: HTMLElement | null;
  /** Logical order, including fields in unmounted tabs. Array prefixes are allowed. */
  order?: readonly string[];
  reveal?: (name: string) => void | Promise<void>;
  /** Server callbacks can run before a submitted fieldset or parent dialog is editable. */
  waitForEnabled?: boolean;
}

export function flattenFieldErrors(errors: unknown, prefix = ''): Record<string, string> {
  if (prefix === 'root' || prefix.startsWith('root.')) return {};
  if (typeof errors === 'string') return prefix ? { [prefix]: errors } : {};
  if (!errors || typeof errors !== 'object') return {};
  const record = errors as Record<string, unknown>;
  if (typeof record.message === 'string') return prefix ? { [prefix]: record.message } : {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (['ref', 'type', 'types'].includes(key)) continue;
    Object.assign(result, flattenFieldErrors(value, prefix ? `${prefix}.${key}` : key));
  }
  return result;
}

const controls = 'input:not([type="hidden"]),select,textarea,button,[tabindex]';
function visibleControl(element: HTMLElement): boolean {
  if (element.matches(':disabled,[aria-disabled="true"],input[type="hidden"]') ||
    element.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function fieldNodes(root: ParentNode, name: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[name],[data-field-name]'))
    .filter(node => node.getAttribute('name') === name || node.dataset.fieldName === name);
}

/** Reveal mounted controls through their existing tab/accordion triggers; do not expose responsive copies. */
async function revealMountedField(root:ParentNode,name:string):Promise<void>{
 for(const node of fieldNodes(root,name)){
  const ancestors:HTMLElement[]=[];for(let current:HTMLElement|null=node;current;current=current.parentElement)ancestors.unshift(current);
  for(const ancestor of ancestors){
   if(ancestor instanceof HTMLDetailsElement&&!ancestor.open)ancestor.open=true;
   if(!ancestor.id||visibleControl(ancestor)||!ancestor.matches('[hidden],[data-state="closed"],[role="tabpanel"]'))continue;
   const labelledBy=ancestor.getAttribute('aria-labelledby');
   const trigger=Array.from(root.querySelectorAll<HTMLElement>('[aria-controls],[role="tab"]')).find(candidate=>
    candidate.getAttribute('aria-controls')===ancestor.id||(labelledBy&&candidate.id===labelledBy));
   if(trigger&&visibleControl(trigger)&&!(trigger instanceof HTMLButtonElement&&trigger.type==='submit')){trigger.click();await new Promise<void>(resolve=>setTimeout(resolve,0));}
  }
  if(visibleControl(node))return;
 }
}

/** Opens the first logical section, waits for its controls to mount, then scrolls/focuses. */
export async function focusFirstError(errors: unknown, options: ErrorFocusOptions = {}): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const root = options.root ?? document;
  const names = Object.keys(flattenFieldErrors(errors));
  if (!names.length) return false;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('[name],[data-field-name]'));
  const rank = (name: string) => {
    if (options.order) {
      const index = options.order.findIndex(key => name === key || name.startsWith(`${key}.`));
      if (index >= 0) return index;
      return options.order.length + names.indexOf(name);
    }
    const index = nodes.findIndex(node => node.getAttribute('name') === name || node.dataset.fieldName === name);
    return index >= 0 ? index : nodes.length + names.indexOf(name);
  };
  names.sort((a, b) => rank(a) - rank(b));
  // The empty-name case returned above; sorting preserves the non-empty array.
  const first = names[0]!;
  await options.reveal?.(first);
  // React state updates from reveal/setError must be committed before looking for the ref.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await revealMountedField(root,first);
  const hasInteractableField = () => fieldNodes(root, first).some(node =>
    node.matches(controls) && visibleControl(node) || Array.from(node.querySelectorAll<HTMLElement>(controls)).some(visibleControl));
  if (options.waitForEnabled && fieldNodes(root, first).length && !hasInteractableField()) {
    await new Promise<void>(resolve => {
      const finish = () => { observer.disconnect(); clearTimeout(timeout); resolve(); };
      const observer = new MutationObserver(() => { if (hasInteractableField()) finish(); });
      const timeout = setTimeout(finish, 2_000);
      // Closing a nested dialog can hide the parent above the form root.
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['disabled', 'aria-hidden', 'hidden', 'inert', 'style', 'data-state'] });
    });
    // Let the closing dialog finish restoring focus before focusing the error.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  for (const node of fieldNodes(root, first)) {
    const target = node.matches(controls) && visibleControl(node) ? node :
      Array.from(node.querySelectorAll<HTMLElement>(controls)).find(visibleControl);
    if (!target) continue;
    target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return true;
  }
  return false;
}

export async function applyFeedbackToForm<T extends FieldValues>(
  form: Pick<UseFormReturn<T>, 'setError'>,
  feedback: { description: string; fieldErrors?: Record<string, string> },
  options?: ErrorFocusOptions,
): Promise<boolean> {
  const fields = feedback.fieldErrors ?? {};
  for (const [name, message] of Object.entries(fields)) {
    form.setError(name as FieldPath<T>, { type: 'server', message });
  }
  if (!Object.keys(fields).length) {
    form.setError('root.server', { type: 'server', message: feedback.description });
    return false;
  }
  return focusFirstError(fields, options);
}
