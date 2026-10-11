// Session teardown must remove the map entry BEFORE stop(): the old listener
// may synchronously emit "closed" and must never tear down a replacement.
export function stopAccountSession(accountId, sessions) {
  const session = sessions.get(accountId);
  if (!session) return false;
  sessions.delete(accountId);
  try { session.api.listener.stop(); } catch { /* already closed */ }
  return true;
}

export function reconcileAccountSessions(accounts, sessions) {
  const current = new Map(accounts.map((account) => [account.id, account]));
  const stopped = [];
  for (const [id] of sessions) {
    // A fresh QR request replaces an existing session too. Missing accounts
    // are removed only after the caller has confirmed the DB query succeeded.
    if (current.get(id)?.status !== 'connected') {
      stopAccountSession(id, sessions);
      stopped.push(id);
    }
  }
  return stopped;
}

export function isCurrentLogin(account, latest, viaQR = false) {
  if (!latest || latest.id !== account.id || latest.organization_id !== account.organization_id) return false;
  const allowed = viaQR ? ['connecting', 'waiting_scan'] : ['connected', 'error'];
  return allowed.includes(latest.status)
    && (latest.login_requested_at || null) === (account.login_requested_at || null);
}
