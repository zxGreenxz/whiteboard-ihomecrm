import { StorageImage } from "@/components/ui/storage-image";
import { Button } from "@/components/ui/button";
import ImageUploadZone from "@/components/customers/ImageUploadZone";
import { X, ArrowLeft, ArrowRight, Star } from "lucide-react";

/**
 * Editor mảng ảnh: hiển thị grid ảnh hiện có (xoá / sắp xếp / đặt ảnh bìa) + 1 ô
 * upload (luôn rỗng để thêm tiếp). Thứ tự mảng = thứ tự hiển thị; phần tử đầu = ảnh bìa.
 * Tái dùng cho cả phòng và toà nhà. Ảnh lưu dạng URL công khai (bucket room-sale-images).
 */
export default function SaleImageManager({
  value, onChange, bucket = "room-sale-images",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  bucket?: string;
}) {
  const imgs = value ?? [];

  const removeAt = (i: number) => onChange(imgs.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= imgs.length) return;
    const next = [...imgs];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const toFront = (i: number) => {
    if (i === 0) return;
    const next = [...imgs];
    const [x] = next.splice(i, 1);
    next.unshift(x);
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {imgs.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {imgs.map((url, i) => (
            <div key={url + i} className="relative group rounded-lg border overflow-hidden">
              <StorageImage value={url} alt={`Ảnh ${i + 1}`} className="w-full h-28 object-cover" />
              {i === 0 && (
                <span className="absolute top-1 left-1 text-[10px] bg-primary text-primary-foreground rounded px-1.5 py-0.5">
                  Ảnh bìa
                </span>
              )}
              <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-black/45 py-0.5 opacity-0 group-hover:opacity-100 transition">
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-white hover:text-white hover:bg-white/20"
                  title="Sang trái" onClick={() => move(i, -1)} disabled={i === 0}>
                  <ArrowLeft className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-white hover:text-white hover:bg-white/20"
                  title="Đặt làm ảnh bìa" onClick={() => toFront(i)} disabled={i === 0}>
                  <Star className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-white hover:text-white hover:bg-white/20"
                  title="Sang phải" onClick={() => move(i, 1)} disabled={i === imgs.length - 1}>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
              <button type="button" onClick={() => removeAt(i)} title="Xoá ảnh"
                className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <ImageUploadZone
        label="Thêm ảnh"
        value=""
        onChange={(url) => { if (url) onChange([...imgs, url]); }}
        bucket={bucket}
        accept="image/png,image/jpeg,image/jpg,image/webp"
        maxSizeMB={5}
      />
    </div>
  );
}
