import { useState } from 'react';
import { Smile } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// Grid emoji tự build — cố ý KHÔNG thêm dependency (package.json chưa có lib
// emoji nào; một bộ chọn gọn phủ 95% nhu cầu chat CSKH).
const GROUPS: { name: string; list: string }[] = [
  { name: 'Hay dùng', list: '😀😄😆🤣😂🙂😉😍🥰😘😜🤗🤔😐😴😭😅😬🙏👍👎👌✌️🤝👏💪❤️💔💯🔥🎉✅❌⭐' },
  { name: 'Cảm xúc', list: '😊☺️😌😎🤩🥳😇🤠😏😒😞😔😟😕🙁😣😖😫😩🥺😢😤😠😡🤬🤯😳🥵🥶😱😨😰😥🤢🤮🤧😷🤒🤕' },
  { name: 'Cử chỉ', list: '👋🤚🖐✋🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆🖕👇☝️👍👎✊👊🤛🤜👏🙌👐🤲🙏✍️💅🤳💪' },
  { name: 'Đồ vật', list: '📱💻⌨️🖥🖨💰💳🧾📦📮📌📍✂️🔑🔒🛠🧰🏠🏢🏬🛏🛋🚪🪟🧹🧺🚿🛁🔌💡📷🎁🛒' },
  { name: 'Khác', list: '🚗🏍🛵🚲✈️🕐📅☀️🌧⛈🌈🎂🍚🍜🍲☕🧋🍺⚽🏀🎮🎵📢⚠️❓❗➡️⬅️✔️' },
];
const RECENT_KEY = 'zalo-recent-emoji';

function getRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    // localStorage hỏng/JSON rác/private mode — "gần đây" chỉ là tiện ích trang
    // trí, rỗng là hành vi đúng, không có nhánh quyền/dữ liệu nào để phân biệt.
    return [];
  }
}
function pushRecent(e: string) {
  const cur = [e, ...getRecents().filter((x) => x !== e)].slice(0, 16);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(cur));
  } catch {
    // private mode / hết quota — mất "gần đây" không ảnh hưởng gì.
  }
}

// Tách chuỗi emoji thành mảng grapheme (emoji ghép giữ nguyên). Intl.Segmenter
// chưa có trong lib TS của repo → guard kiểu; trình duyệt hiện đại đều có.
type SegmenterCtor = new (locale: string, opts: { granularity: 'grapheme' }) => {
  segment(s: string): Iterable<{ segment: string }>;
};
const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
function splitEmoji(s: string): string[] {
  if (Segmenter) {
    return [...new Segmenter('vi', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment).filter((x) => x.trim());
  }
  return Array.from(s).filter((x) => x.trim());
}

interface Props { onPick: (emoji: string) => void }

export default function EmojiPicker({ onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);

  const pick = (e: string) => {
    pushRecent(e);
    onPick(e);
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setRecents(getRecents()); }}>
      <PopoverTrigger asChild>
        <button type="button" title="Emoji" style={{ width: 32, height: 32, border: 'none', background: 'transparent', borderRadius: 7, color: 'hsl(210 10% 45%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Smile size={18} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-2">
        <div className="wz-scroll" style={{ maxHeight: 280, overflowY: 'auto' }}>
          {recents.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'hsl(210 10% 50%)', padding: '4px 4px 2px' }}>Gần đây</div>
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {recents.map((e) => (
                  <button key={`r${e}`} type="button" onClick={() => pick(e)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 20, padding: 4, borderRadius: 6 }}>{e}</button>
                ))}
              </div>
            </div>
          )}
          {GROUPS.map((g) => (
            <div key={g.name}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'hsl(210 10% 50%)', padding: '6px 4px 2px' }}>{g.name}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {splitEmoji(g.list).map((e, i) => (
                  <button key={`${g.name}${i}`} type="button" onClick={() => pick(e)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 20, padding: 4, borderRadius: 6 }}>{e}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
