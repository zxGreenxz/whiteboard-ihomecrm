// Helper THUẦN dựng danh sách item render cho MessageList:
//   • divider NGÀY (theo createdAt, múi giờ trình duyệt)
//   • divider "Tin nhắn chưa đọc" (chốt tại thời điểm mở thread)
//   • gom ALBUM: ≥2 ảnh liên tiếp cùng chiều trong ≤60s → 1 grid
//   • cờ gom NHÓM: tin liên tiếp cùng chiều trong ≤5 phút → bớt meta-row
// Không side-effect — unit-test được (threadItems.test.ts).
import type { ZaloMessage } from './types';

export type ThreadItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'album'; key: string; items: ZaloMessage[]; grouped: boolean; lastOfGroup: boolean }
  | { kind: 'msg'; key: string; m: ZaloMessage; grouped: boolean; lastOfGroup: boolean };

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const ALBUM_WINDOW_MS = 60 * 1000;

function dayKey(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - that.getTime()) / 86400000);
  if (diff <= 0) return 'Hôm nay';
  if (diff === 1) return 'Hôm qua';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function tsOf(m: ZaloMessage): number {
  return m.createdAt ? new Date(m.createdAt).getTime() : 0;
}

function sameGroup(a: ZaloMessage, b: ZaloMessage): boolean {
  if (a.dir !== b.dir) return false;
  if (a.type === 'sys' || b.type === 'sys') return false;
  const ta = tsOf(a); const tb = tsOf(b);
  if (!ta || !tb) return false;
  return Math.abs(tb - ta) <= GROUP_WINDOW_MS;
}

function canAlbum(a: ZaloMessage, b: ZaloMessage): boolean {
  if (a.type !== 'image' || b.type !== 'image') return false;
  if (a.dir !== b.dir) return false;
  const ta = tsOf(a); const tb = tsOf(b);
  if (!ta || !tb) return false;
  return Math.abs(tb - ta) <= ALBUM_WINDOW_MS;
}

/**
 * @param messages  tin đã sắp TĂNG dần theo thời gian
 * @param unreadCount  số tin chưa đọc chốt lúc mở thread (0 = không vẽ divider)
 */
export function buildThreadItems(messages: ZaloMessage[], unreadCount = 0): ThreadItem[] {
  const out: ThreadItem[] = [];
  let lastDay = '';

  // Vị trí divider chưa đọc: trước tin 'in' thứ (n - unreadCount) tính từ cuối.
  let unreadAt = -1;
  if (unreadCount > 0) {
    let seen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.dir === 'in') {
        seen++;
        if (seen === unreadCount) { unreadAt = i; break; }
      }
    }
  }

  // Gom album trước (đi tuần tự, gộp dải ảnh liên tiếp)
  type Chunk = { album: ZaloMessage[] } | { one: ZaloMessage };
  const chunks: Chunk[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.type === 'image') {
      const run: ZaloMessage[] = [m];
      // divider chưa đọc không được rơi vào giữa album — cắt album tại đó
      while (i + 1 < messages.length && (i + 1) !== unreadAt) {
        const tail = run[run.length - 1];
        const next = messages[i + 1];
        if (!tail || !next || !canAlbum(tail, next)) break;
        run.push(next);
        i++;
      }
      if (run.length >= 2) { chunks.push({ album: run }); continue; }
      chunks.push({ one: m });
      continue;
    }
    chunks.push({ one: m });
  }

  // Duyệt chunk → chèn divider ngày/chưa đọc + tính cờ gom nhóm.
  // (Album do vòng trên tạo luôn ≥2 phần tử nên firstOf/lastOf không thể rỗng;
  //  guard dưới đây thoả noUncheckedIndexedAccess, không phải nhánh chạy thật.)
  const firstOf = (c: Chunk): ZaloMessage | undefined => ('album' in c ? c.album[0] : c.one);
  const lastOf = (c: Chunk): ZaloMessage | undefined => ('album' in c ? c.album[c.album.length - 1] : c.one);
  let msgIndex = 0; // index của tin ĐẦU chunk trong mảng messages

  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    if (!c) continue;
    const first = firstOf(c);
    const clast = lastOf(c);
    if (!first || !clast) continue;
    const size = 'album' in c ? c.album.length : 1;

    const dk = dayKey(first.createdAt);
    if (dk && dk !== lastDay) {
      lastDay = dk;
      out.push({ kind: 'day', key: `day_${dk}`, label: dayLabel(first.createdAt) });
    }
    if (unreadAt >= 0 && msgIndex === unreadAt) {
      out.push({ kind: 'unread', key: 'unread_divider' });
    }

    const prevChunk = ci > 0 ? chunks[ci - 1] : undefined;
    const nextChunk = ci + 1 < chunks.length ? chunks[ci + 1] : undefined;
    const prev = prevChunk ? lastOf(prevChunk) : null;
    const next = nextChunk ? firstOf(nextChunk) : null;
    // divider (ngày/chưa đọc) phá chuỗi gom nhóm
    const brokeBefore = (dk && out.length && out[out.length - 1]?.kind === 'day')
      || (out.length && out[out.length - 1]?.kind === 'unread');
    const grouped = !!prev && !brokeBefore && sameGroup(prev, first);
    const nextDk = next ? dayKey(next.createdAt) : '';
    const nextBreaks = !next || (nextDk && nextDk !== dk) || (unreadAt >= 0 && msgIndex + size === unreadAt);
    const lastOfGroup = !!nextBreaks || !next || !sameGroup(clast, next);

    if ('album' in c) {
      out.push({ kind: 'album', key: `alb_${first.id || msgIndex}`, items: c.album, grouped, lastOfGroup });
    } else {
      out.push({ kind: 'msg', key: String(c.one.id || c.one.cliId || `i${msgIndex}`), m: c.one, grouped, lastOfGroup });
    }
    msgIndex += size;
  }
  return out;
}

/** Bỏ dấu tiếng Việt + thường hoá — cho tìm trong hội thoại. */
export function normalizeVn(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}
