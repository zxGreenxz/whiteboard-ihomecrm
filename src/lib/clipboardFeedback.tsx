import { toast } from 'sonner';

/** A failed clipboard write leaves a selectable copy; never reports success early. */
export async function copyTextWithFeedback(text: string, label: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Đã sao chép ${label}.`);
    return true;
  } catch {
    toast.custom(id => <div role="alert" className="w-80 rounded-lg border bg-background p-4 shadow-lg">
      <p className="font-medium">Chưa sao chép được {label}.</p>
      <p className="my-2 text-sm">Bạn có thể chọn và sao chép nội dung bên dưới.</p>
      <textarea aria-label={`Nội dung ${label} để sao chép`} readOnly value={text} onFocus={event => event.currentTarget.select()} className="min-h-20 w-full rounded border p-2 text-sm" />
      <button type="button" className="mt-2 text-sm underline" onClick={() => toast.dismiss(id)}>Đóng</button>
    </div>, { duration: Infinity });
    return false;
  }
}
