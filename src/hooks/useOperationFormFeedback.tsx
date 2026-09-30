import { useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { focusFirstError } from '@/lib/formErrors';
import { FinancialWorkflowError, workflowErrorMessage } from '@/lib/financialWorkflow';
import { voucherOutcomeUnknown } from '@/lib/voucherFeedback';
import { friendlyError, type FeedbackOptions } from '@/lib/friendlyError';

/** Keeps the form alive through a real async result, including partial writes. */
export function useOperationFormFeedback(operation: string, options: FeedbackOptions = {}) {
  const form = useForm<Record<string, string>>({shouldFocusError: false});
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const errors = form.formState.errors;
  const field = (name: string) => ({
    ...form.register(name), 'aria-invalid': Boolean(errors[name]),
    'aria-describedby': errors[name] ? `${id}-${name}` : undefined,
    'data-field': name,
  });
  const issue = (name: string) => errors[name]?.message
    ? <p id={`${id}-${name}`} className="text-sm text-red-600" role="alert">{String(errors[name]?.message)}</p> : null;
  const run = async (action: () => unknown | Promise<unknown>, onSuccess: () => void, invalid: Record<string, string | undefined> = {}) => {
    if (pending.current || blocked) return;
    form.clearErrors(); setFailure(undefined);
    const entries = Object.entries(invalid).filter((entry): entry is [string, string] => !!entry[1]);
    if (entries.length) {
      for (const [name, message] of entries) form.setError(name, {type:'validate',message});
      await focusFirstError(Object.fromEntries(entries), {root: root.current});
      return;
    }
    pending.current = true; setSaving(true);
    try { await action(); onSuccess(); }
    catch (error) {
      const feedback = friendlyError(error, `Chưa ${operation}.`, {financial: true, ...options, operation});
      for (const [name, message] of Object.entries(feedback.fieldErrors ?? {})) form.setError(name, {type: 'server', message});
      await focusFirstError(feedback.fieldErrors, {root: root.current});
      setFailure(error);
      setBlocked((error instanceof FinancialWorkflowError && error.outcome !== 'failure') || voucherOutcomeUnknown(error));
    } finally { pending.current = false; setSaving(false); }
  };
  const notice = failure ? <div role="alert" className="m-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
    <p>{failure instanceof FinancialWorkflowError ? workflowErrorMessage(failure, operation) : (() => {const feedback = friendlyError(failure, `Chưa ${operation}.`, {financial: true, ...options, operation}); return `${feedback.title} ${feedback.description}`;})()}</p>
    {failure instanceof FinancialWorkflowError && failure.completed.length > 0 && <ul>{failure.completed.map((item, index) => <li key={index}>{item.label} — mã: {item.id}</li>)}</ul>}
  </div> : null;
  return {root, saving, blocked, field, issue, run, notice, close: (onClose: () => void) => { if (!pending.current) onClose(); }};
}
