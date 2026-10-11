// A forwarding job carries row IDs, never a browser-supplied URL or type.
// Read again at delivery time so deleted/hidden/recalled sources cannot be sent.
export async function readForwardSources(job, db) {
  const ids = job.payload?.source_message_ids;
  const targets = job.payload?.message_ids;
  const captionId = job.payload?.caption_message_id;
  if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !id)
      || !Array.isArray(targets) || targets.length !== ids.length + (captionId ? 1 : 0)
      || new Set(targets).size !== targets.length || targets[0] !== job.message_id
      || (captionId && (typeof captionId !== 'string' || targets.at(-1) !== captionId))
      || ids.some(id => targets.includes(id))) throw new Error('Nguồn chuyển tiếp hoặc số tin đích không hợp lệ');
  const rows = [];
  for (const id of ids) {
    const { data, error } = await db.from('zalo_messages')
      .select('id, account_id, organization_id, conversation_id, msg_type, media_url, media_meta, media_label, body, status, hidden_at')
      .eq('id', id).maybeSingle();
    if (error) throw new Error(`FORWARD_DATABASE: không đọc được tin nguồn: ${error.message}`);
    if (!data || data.organization_id !== job.organization_id || data.hidden_at
        || !['sent', 'delivered', 'seen'].includes(data.status)
        || !['image', 'video', 'voice', 'file'].includes(data.msg_type)
        || typeof data.media_url !== 'string' || !data.media_url.trim()) {
      throw new Error('Tin nguồn không còn khả dụng hoặc ngoài phạm vi công ty');
    }
    rows.push(data);
  }
  const first = rows[0];
  if (rows.some(row => row.account_id !== first.account_id || row.conversation_id !== first.conversation_id
      || row.msg_type !== first.msg_type) || (rows.length > 1 && first.msg_type !== 'image')) {
    throw new Error('Chỉ chuyển tiếp một media hoặc một nhóm ảnh cùng hội thoại');
  }
  if (captionId && !((first.msg_type === 'image' && rows.length > 1) || (first.msg_type === 'file' && rows.length === 1))) {
    throw new Error('Chú thích riêng không phù hợp loại media');
  }
  const { data: account, error: accountError } = await db.from('zalo_accounts')
    .select('id, organization_id').eq('id', first.account_id).maybeSingle();
  const { data: conv, error: convError } = await db.from('zalo_conversations')
    .select('id, account_id, organization_id').eq('id', first.conversation_id).maybeSingle();
  if (accountError || convError) throw new Error('FORWARD_DATABASE: không đọc được phạm vi nguồn');
  if (!account || !conv || account.organization_id !== job.organization_id
      || conv.organization_id !== job.organization_id || conv.account_id !== account.id) {
    throw new Error('Hội thoại nguồn ngoài phạm vi công ty');
  }
  return rows;
}
