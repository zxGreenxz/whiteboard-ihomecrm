import { useState } from "react";
import { useSignedUrlQuery } from "@/hooks/useSignedUrl";
import { cn } from "@/lib/utils";

/** Ảnh nhỏ trong phiên kiểm tra; ảnh ngoài bán kính có viền đứt. */
export function StaffThumb({ path, label, outOfRange, className }: {
  path: string;
  label?: string | null;
  outOfRange?: boolean;
  className?: string;
}) {
  const url = useSignedUrlQuery(path, undefined, { errorDisplay: "inline" }).data;
  const [failed, setFailed] = useState(false);
  const content = (
    <div className={cn(
      "relative h-14 overflow-hidden rounded-lg bg-slate-200",
      outOfRange && "border-2 border-dashed border-red-600",
      className,
    )}>
      {url && !failed
        ? <img src={url} alt={label ?? "Ảnh kiểm tra"} loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
        : null}
      {label ? (
        <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 text-[10px] font-semibold text-white">{label}</span>
      ) : null}
    </div>
  );
  return url && !failed ? <a href={url} target="_blank" rel="noreferrer" className="block min-w-0 flex-1">{content}</a> : <div className="min-w-0 flex-1">{content}</div>;
}
