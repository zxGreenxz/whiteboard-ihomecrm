import { AlertTriangle } from "lucide-react";

/** Cảnh báo trong hộp thu hồi / xoá link (link nguồn /phongtrong, link hoạt động cuối của công ty). */
export default function TokenRemovalWarnings({ warnings }: { warnings: readonly string[] }) {
  if (!warnings.length) return null;
  return (
    <div
      role="note"
      aria-label="Cảnh báo trước khi thu hồi hoặc xoá link"
      className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-left text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
    >
      {warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      ))}
    </div>
  );
}
