// Kiểu dữ liệu cho trang Chat Zalo — dùng chung cho mock (Phần 1) và hook
// Supabase (Phần 2). Shape bám sát `CONVS` trong design `Chat Zalo.dc.html`.

export type ToneKey = 'emerald' | 'blue' | 'purple' | 'orange' | 'rose' | 'slate';
export type TagKey = 'success' | 'info' | 'debt' | 'danger' | 'warning' | 'purple' | 'neutral';
export type ProfileKind = 'tenant' | 'lead' | 'broker';
export type MsgTick = 'seen' | 'sent';
export type FilterKey = 'all' | 'unread' | 'tenant' | 'lead';
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
  // shared
  staff?: ZaloStaff;
  tags?: ZaloTag[];
}

export interface ZaloMessage {
  /** 'sys' = thông báo hệ thống/tự động; 'image' = ảnh; bỏ trống = text */
  type?: 'sys' | 'image';
  dir?: 'in' | 'out';
  text?: string;
  /** nhãn ảnh (type='image') */
  label?: string;
  /** tông gradient ảnh: 'neutral' | 'room' | 'warm' */
  imgTone?: string;
  /** giờ HH:MM — tin hệ thống (type='sys') có thể bỏ trống */
  time?: string;
  tick?: MsgTick;
  /** emoji reaction */
  react?: string;
  reply?: { name: string; text: string };
}

export interface ZaloConversation {
  id: string;
  accountId?: string | null;
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
