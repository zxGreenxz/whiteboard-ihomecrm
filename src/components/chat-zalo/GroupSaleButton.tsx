import type { ZaloConversation } from './types';

export interface GroupSaleAction {
  toggle: (conversation: ZaloConversation) => void;
  pending: boolean;
}

export default function GroupSaleButton({ conv, action }: { conv: ZaloConversation; action?: GroupSaleAction }) {
  if (!conv.isGroup) return null;
  const marked = conv.isSalePartner;
  if (!action) return marked ? <span className="text-xs font-semibold text-emerald-700">Nhóm sale</span> : null;
  const label = marked ? 'Bỏ đánh dấu nhóm sale' : 'Đánh dấu nhóm sale';
  return (
    <button type="button" aria-label={`${label}: ${conv.name}`} aria-pressed={marked} title={label}
      disabled={action.pending} className="shrink-0 rounded border px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
      onClick={(event) => { event.stopPropagation(); action.toggle(conv); }}>
      {marked ? '✓ Nhóm sale' : '+ Đánh dấu sale'}
    </button>
  );
}
