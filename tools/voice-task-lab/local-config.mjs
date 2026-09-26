/** Read only the operator-selected lab field; never guess between historical VPS keys. */
export function loadRuntimeConfig(env, readVault) {
  if (env.VOICE_LAB_CAPTURE_ONLY === '1') return null;
  return parseLocalConfig(env, env.NINEROUTER_API_KEY ? '' : readVault());
}

export function parseLocalConfig(env, vault) {
  const matches = [...vault.matchAll(/^VOICE_LAB_NINEROUTER_API_KEY=(sk-[^\s`<>]+)\s*$/gm)];
  if (!env.NINEROUTER_API_KEY && matches.length > 1) {
    throw new Error('Có nhiều khóa Voice Lab cùng nhãn; cần xác định khóa hiện hành trong vault.');
  }
  const apiKey = env.NINEROUTER_API_KEY || matches[0]?.[1];
  if (!apiKey || /[\s<>]/.test(apiKey)) throw new Error('Thiếu VOICE_LAB_NINEROUTER_API_KEY trong vault hoặc NINEROUTER_API_KEY trong process env. Cần khóa đã xác nhận đúng máy chủ.');
  const baseUrl = (env.NINEROUTER_BASE_URL || 'https://ai.chillhome.io.vn/v1').replace(/\/$/, '');
  let url;
  try { url = new URL(baseUrl); }
  catch { throw new Error('Địa chỉ 9Router không hợp lệ.'); }
  if (url.origin !== 'https://ai.chillhome.io.vn' || url.pathname !== '/v1' || url.search || url.hash || url.username || url.password) {
    throw new Error('Địa chỉ 9Router không khớp VPS đã cấu hình cho phòng thử.');
  }
  return { apiKey, baseUrl };
}
