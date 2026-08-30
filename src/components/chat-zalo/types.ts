// Kiểu dữ liệu cho trang Chat Zalo — dùng chung cho mock (Phần 1) và hook
// Supabase (Phần 2). Shape bám sát `CONVS` trong design `Chat Zalo.dc.html`.

export type ToneKey = 'emerald' | 'blue' | 'purple' | 'orange' | 'rose' | 'slate';
export type TagKey = 'success' | 'info' | 'debt' | 'danger' | 'warning' | 'purple' | 'neutral';
export type ProfileKind = 'tenant' | 'lead' | 'broker' | 'unknown';
export type MsgTick = 'seen' | 'sent' | 'pending' | 'failed';
export type FilterKey = 'all' | 'unread' | 'tenant' | 'lead' | 'contacts';
export type RightTab = 'info' | 'auto';

export interface ZaloTag {
  /** label */ l: string;
  /** tone key */ t: TagKey;
}

export interface ZaloStaff {
  name: string;
  role: string;
  initials: string;
  tone: ToneKey;
}

export interface ZaloProfile {
  kind: ProfileKind;
  // tenant + lead
  room?: string;
  roomSub?: string;
  price?: string;
  // tenant
  contractCode?: string;
  contractTerm?: string;
  contractStatus?: string;
  debt?: { amount: string; overdue: string; note: string };
  issue?: { text: string };
  // lead
  stage?: string;
  source?: string;
  // broker
  company?: string;
  phone?: string;
  rooms?: string;
  stats?: { label: string; value: string }[];
  // Zalo thật (danh bạ/nhóm chưa phân loại)
  isGroup?: boolean;
  members?: number | null;
  desc?: string | null;
  // shared
  staff?: ZaloStaff;
  tags?: ZaloTag[];
}

export interface ZaloMessage {
  /** id dòng DB (để thả reaction / thu hồi). Tin lạc quan chưa có id. */
  id?: string;
  /** 'sys' = hệ thống; media theo loại; bỏ trống = text */
  type?: 'sys' | 'image' | 'video' | 'voice' | 'file' | 'sticker';
  dir?: 'in' | 'out';
  text?: string;
  /** nhãn ảnh/video/tên tệp */
  label?: string;
  /** URL media (CDN Zalo cho chiều nhận; bucket tự host cho chiều gửi) */
  mediaUrl?: string | null;
  /** ảnh poster cho video */
  videoThumb?: string | null;
  /** tông gradient ảnh: 'neutral' | 'room' | 'warm' */
  imgTone?: string;
  /** metadata media: {duration_ms,size,mime,filename,width,height,...} */
  mediaMeta?: Record<string, unknown> | null;
  /** giờ HH:MM — tin hệ thống (type='sys') có thể bỏ trống */
  time?: string;
  /** ISO timestamp gốc — cho divider ngày + gom nhóm tin liên tiếp */
  createdAt?: string;
  tick?: MsgTick;
  /** emoji reaction */
  react?: string;
  reply?: { name: string; text: string };
  /** khoá idempotency client — khớp bubble lạc quan ↔ dòng thật */
  cliId?: string;
  /** URL objectURL cục bộ khi đang upload (bubble lạc quan media) */
  localUrl?: string;
}

export interface ZaloLabel {
  labelId: number;
  name: string;
  color?: string | null;
  emoji?: string | null;
}

export interface ZaloConversation {
  id: string;
  accountId?: string | null;
  labelIds?: number[];
  name: string;
  initials: string;
  avatarUrl?: string | null;
  tone: ToneKey;
  time: string;
  sub: string;
  subTone?: ToneKey | null;
  preview: string;
  unread: number;
  listTag?: ZaloTag | null;
  online: boolean;
  headerTag: ZaloTag;
  headerSub: string;
  phone: string;
  day: string;
  profile: ZaloProfile;
  messages: ZaloMessage[];
  /** tiện ích hội thoại */
  pinned: boolean;
  muted: boolean;
  markedUnread: boolean;
  /** đã có tin nhắn nào chưa (null = danh bạ thuần, chưa từng nhắn) */
  hasMessages: boolean;
  isGroup: boolean;
  /** Đánh dấu tay: hội thoại này là sale/môi giới. Điều kiện để nhận tin phòng
   *  trống định kỳ và để được tự động trả lời. */
  isSalePartner: boolean;
  /** liên kết CRM (null = chưa gắn) */
  customerId?: string | null;
  leadId?: string | null;
  contractId?: string | null;
  roomId?: string | null;
}

export interface ZaloAutomations {
  /** "Gửi ảnh phòng trống" */
  broadcastOn: boolean;
  /** "Tự động trả lời" */
  autoReplyOn: boolean;
}

export type AccountStatus = 'connected' | 'disconnected' | 'error' | 'connecting' | 'waiting_scan';

export interface ZaloAccount {
  id: string;
  name: string;
  kind: 'personal' | 'oa';
  status: AccountStatus;
  zaloUid?: string | null;
  avatarUrl?: string | null;
  /** data URL ảnh QR (worker ghi khi chờ quét) */
  qrData?: string | null;
  lastError?: string | null;
}
