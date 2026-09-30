import { toast } from 'sonner';
import { friendlyError } from './friendlyError';

/** UI boundaries keep server diagnostics out of the visible message. */
export function actionErrorMessage(error: unknown, fallback: string): string {
  const result = friendlyError(error, fallback);
  return result.description ? `${result.title.replace(/[.。]+$/, "")}. ${result.description}` : result.title;
}

export function notifyActionError(error: unknown, fallback: string): void {
  const result = friendlyError(error, fallback);
  toast.error(result.title, { description: result.description });
}
