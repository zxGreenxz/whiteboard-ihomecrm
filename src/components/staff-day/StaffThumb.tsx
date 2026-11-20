import { useState } from "react";
import { AttachmentLightbox } from "@/components/ui/attachment-lightbox";
import { useSignedUrlQuery } from "@/hooks/useSignedUrl";
import type { SessionPhoto } from "@/lib/staffDay";
import { cn } from "@/lib/utils";

function StaffThumb({ photo, onOpen }: {
  photo: SessionPhoto;
  onOpen: () => void;
}) {
  const url = useSignedUrlQuery(photo.path, undefined, { errorDisplay: "inline" }).data;
  const [failed, setFailed] = useState(false);
  const label = photo.label ?? photo.slot;
  return (
    <button
      type="button"
      aria-label={label ? `Xem ảnh ${label}` : "Xem ảnh kiểm tra"}
      onClick={onOpen}
      className={cn(
        "relative min-w-0 flex-1 overflow-hidden rounded-lg bg-slate-200 text-left",
        photo.geofence_status === "out_of_range" && "border-2 border-dashed border-red-600",
      )}
    >
      {url && !failed
        ? <img src={url} alt={label ?? "Ảnh kiểm tra"} loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
        : null}
      {label ? (
        <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 text-[10px] font-semibold text-white">{label}</span>
      ) : null}
    </button>
  );
}

export function StaffPhotoGallery({ photos, limit, className }: {
  photos: readonly SessionPhoto[];
  limit: number;
  className?: string;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const shown = photos.slice(0, limit);
  const more = photos.length - shown.length;
  if (!photos.length) return null;

  return (
    <div className={cn("flex h-14 gap-1", className)} role="group" aria-label="Ảnh đã chụp trong phiên">
      {shown.map((photo, i) => (
        <StaffThumb key={photo.path} photo={photo} onOpen={() => setIndex(i)} />
      ))}
      {more > 0 && (
        <button
          type="button"
          aria-label={`Xem thêm ${more} ảnh`}
          className="min-w-0 flex-1 rounded-lg border border-dashed border-slate-300 bg-slate-100 text-[11px] font-semibold text-muted-foreground"
          onClick={() => setIndex(shown.length)}
        >
          +{more}
        </button>
      )}
      {index !== null && (
        <AttachmentLightbox attachments={photos.map(photo => photo.path)} index={index} onIndexChange={setIndex} />
      )}
    </div>
  );
}
