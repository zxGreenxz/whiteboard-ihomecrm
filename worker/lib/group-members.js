// Only sender identity is cached, inside the already org/account-scoped conversation.
// Read the latest 1,000 senders at startup; live/history events fill later gaps.
const DAY = 86_400_000;
const uid = value => typeof value === 'string' && /^[1-9]\d*(?:_\d+)?$/.test(value) ? value.split('_')[0] : null;
const name = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';
function avatar(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { return ['https:', 'http:'].includes(new URL(value).protocol) ? value : undefined; } catch { return undefined; }
}

export function createGroupMemberSync({ db, now = Date.now }) {
  // Live listeners, history proxies and reconnects must share the same write lock.
  const cache = new Map();
  return function sync({ api, accountId, orgId, conversationId, senderIds = [], includeHistory = false, group = null }) {
    if (!api || !accountId || !orgId || !conversationId) return Promise.reject(new Error('Missing group member scope'));
    const key = `${orgId}:${accountId}:${conversationId}`;
    const prior = cache.get(key) || { known: new Set(), at: 0, pending: Promise.resolve() };
    const ids = [...new Set(senderIds.map(uid).filter(Boolean))];
    if (!includeHistory && !group && now() - prior.at < DAY && ids.every(id => prior.known.has(id))) return prior.pending;
    const job = prior.pending.catch(() => {}).then(async () => {
      if (!includeHistory && !group && now() - prior.at < DAY && ids.every(id => prior.known.has(id))) return;
      // Supabase applies filters after select/update, so build each operation explicitly.
      const { data: conv, error } = await db.from('zalo_conversations').select('profile')
        .eq('id', conversationId).eq('account_id', accountId).eq('organization_id', orgId).eq('thread_type', 'group').maybeSingle();
      if (error) throw new Error(`Read group members: ${error.message}`);
      if (!conv) throw new Error('Group member conversation scope not found');
      const current = conv.profile && typeof conv.profile === 'object' ? conv.profile : {};
      const members = { ...(current.memberProfiles || {}) };
      const wanted = new Set(ids);
      if (includeHistory) {
        const history = await db.from('zalo_messages').select('sender_uid:zalo_raw->>uidFrom')
          .eq('conversation_id', conversationId).eq('account_id', accountId).eq('organization_id', orgId)
          .is('hidden_at', null)
          .order('created_at', { ascending: false }).limit(1000);
        if (history.error) throw new Error(`Read group senders: ${history.error.message}`);
        for (const row of history.data || []) { const id = uid(row.sender_uid); if (id) wanted.add(id); }
      }
      const fresh = now() - Date.parse(current.memberProfilesUpdatedAt || '') < DAY;
      const needed = [...wanted].filter(id => !fresh || !members[id]?.name || !members[id]?.avatarUrl);
      // Current group info often already includes complete profiles; use it before another provider read.
      const supplied = new Map((group?.currentMems || []).map(p => [uid(p.id), p]));
      const save = (id, p) => {
        if (!p || (p.id != null && uid(p.id) !== id)) return;
        const displayName = name(p.displayName) || name(p.dName) || name(p.zaloName);
        const image = avatar(p.avatar) || avatar(p.avatar_25);
        if (displayName || image) members[id] = { ...(members[id] || {}), ...(displayName ? { name: displayName } : {}), ...(image ? { avatarUrl: image } : {}) };
      };
      for (const id of needed) save(id, supplied.get(id));
      const fetchIds = needed.filter(id => !supplied.get(id) || !members[id]?.name || !members[id]?.avatarUrl);
      for (let start = 0; start < fetchIds.length; start += 50) {
        const batch = fetchIds.slice(start, start + 50);
        const response = await api.getGroupMembersInfo(batch);
        for (const [rawId, p] of Object.entries(response?.profiles || {})) {
          const id = uid(rawId);
          if (id && batch.includes(id)) save(id, p);
        }
      }
      const profile = { ...current,
        ...(group ? { isGroup: true, members: group.totalMember || group.memberIds?.length || null, desc: group.desc || null, memberIds: group.memberIds?.slice(0, 500) || null } : {}),
        memberProfiles: members, memberProfilesUpdatedAt: new Date(now()).toISOString(),
      };
      const written = await db.from('zalo_conversations').update({ profile })
        .eq('id', conversationId).eq('account_id', accountId).eq('organization_id', orgId).eq('thread_type', 'group').select('id');
      if (written.error || !written.data?.length) throw new Error(`Write group members: ${written.error?.message || 'scope changed'}`);
      prior.known = new Set(Object.keys(members).filter(id => members[id]?.name && members[id]?.avatarUrl));
      prior.at = now();
    });
    prior.pending = job;
    cache.set(key, prior);
    return job;
  };
}
