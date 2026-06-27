import { StorageImage } from "@/components/ui/storage-image";
import ImageUploadZone from "@/components/customers/ImageUploadZone";
import { X, Star } from "lucide-react";

/**
 * Grid ảnh sale 3 cột cho mobile: ảnh hiện có (đặt bìa = phần tử đầu, xoá) + ô
 * upload (ImageUploadZone) để thêm nhiều ảnh. Thứ tự mảng = thứ tự hiển thị.
 */
export default function MobileImageGrid({
  value, onChange, bucket = "room-sale-images",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  bucket?: string;
}) {
  const imgs = value ?? [];
  const removeAt = (i: number) => onChange(imgs.filter((_, idx) => idx !== i));
  const toFront = (i: number) => {
    if (i === 0) return;
    const next = [...imgs];
    const [x] = next.splice(i, 1);
    next.unshift(x);
    onChange(next);
  };

  return (
    <div>
      {imgs.length > 0 && (
        <div className="sp-imggrid" style={{ marginBottom: 10 }}>
          {imgs.map((url, i) => (
            <div key={url + i} className="sp-imgcell">
              <StorageImage value={url} alt={`Ảnh ${i + 1}`} />
              {i === 0 ? (
                <span className="cover">Ảnh bìa</span>
              ) : (
                <button className="rm" style={{ left: 5, right: "auto", background: "rgba(31,122,82,.85)" }} title="Đặt làm bìa" onClick={() => toFront(i)}>
                  <Star size={12} />
                </button>
              )}
              <button className="rm" title="Xoá ảnh" onClick={() => removeAt(i)}><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <ImageUploadZone
        label=""
        value=""
        multiple
        onChange={(url) => { if (url) onChange([...imgs, url]); }}
        onAddMany={(urls) => { if (urls.length) onChange([...imgs, ...urls]); }}
        bucket={bucket}
        accept="image/png,image/jpeg,image/jpg,image/webp"
        maxSizeMB={5}
      />
    </div>
  );
}
