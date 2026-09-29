// Exact request identities present before a harness-owned navigation only.
// Neither mutation requests nor HTTP/console failures are navigation exceptions.
export function createNavigationReadGuard({ appOrigin, testOrigin }) {
  const pending = new Set(), snapshots = new Map();
  let sequence = 0;
  const read = request => {
    const url = new URL(request.url()), method = request.method();
    if (url.origin === appOrigin) return method === 'GET'
      && ['/src/', '/node_modules/', '/@vite/', '/@id/', '/@react-refresh'].some(path => url.pathname.startsWith(path));
    if (url.origin !== testOrigin) return false;
    if (['GET', 'HEAD'].includes(method)) return url.pathname.startsWith('/rest/v1/') && !url.pathname.includes('/rpc/');
    // v2 is a STABLE reader; organizations_v1 is the SELECT-only sidebar roster reader.
    return method === 'POST' && ['/rest/v1/rpc/list_contract_commission_followups_v2',
      '/rest/v1/rpc/business_performance_organizations_v1'].includes(url.pathname);
  };
  return {
    started: request => pending.add(request),
    finished: request => pending.delete(request),
    snapshot: action => {
      const boundary = `${++sequence}:${action}`;
      for (const request of pending) if (read(request)) snapshots.set(request, boundary);
    },
    cancelled: (request, failure, responseStatus) => {
      const boundary = snapshots.get(request);
      if (!boundary || failure !== 'net::ERR_ABORTED' || responseStatus >= 400 || !read(request)) return null;
      return { boundary, path: new URL(request.url()).pathname, method: request.method(), failure, responseStatus };
    },
  };
}
