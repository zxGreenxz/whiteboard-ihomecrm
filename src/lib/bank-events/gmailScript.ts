/**
 * Script Apps Script chạy trong tài khoản Google của chủ: đọc email ngân hàng rồi đẩy về địa chỉ nhận của CRM.
 * CRM không giữ mật khẩu Gmail; script chỉ mang khóa nguồn, thu hồi hoặc cấp lại được trên trang Biến động số dư.
 * File thuần (không import) để test Deno của bank-event-ingest chạy đúng script này qua handler thật.
 */
export const GMAIL_SCRIPT_VERSION = 'gmail-script-1';
export const GMAIL_BANK_DOMAINS = [
  'acb.com.vn', 'vietcombank.com.vn', 'techcombank.com.vn', 'mbbank.com.vn', 'vpbank.com.vn', 'bidv.com.vn',
  'vietinbank.vn', 'tpb.vn', 'tpbank.com.vn', 'vib.com.vn', 'sacombank.com', 'hdbank.com.vn', 'shb.com.vn',
  'msb.com.vn', 'ocb.com.vn', 'seabank.com.vn', 'agribank.com.vn', 'eximbank.com.vn', 'lpbank.com.vn',
  'timo.vn', 'cake.vn',
] as const;
export interface GmailScriptOptions { ingestUrl: string; token: string; label: string; includeBanks: boolean }

const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} _/-]{0,59}$/u;
/** Nhãn Gmail dạng tìm kiếm: chữ thường, khoảng trắng và "/" thành "-". Rỗng là không lọc theo nhãn. */
export function gmailLabelQuery(label: string): string | null {
  const value = label.trim();
  if (!value) return '';
  if (!LABEL.test(value)) return null;
  return value.toLowerCase().replace(/[\s/]+/g, '-');
}

/** Điều kiện tìm thư; null khi cấu hình không lấy được thư nào hoặc nhãn không hợp lệ. */
export function gmailSearchQuery({ label, includeBanks }: Pick<GmailScriptOptions, 'label' | 'includeBanks'>): string | null {
  const labelQuery = gmailLabelQuery(label);
  if (labelQuery === null) return null;
  const parts = [includeBanks ? `from:(${GMAIL_BANK_DOMAINS.join(' OR ')})` : '', labelQuery ? `label:${labelQuery}` : ''].filter(Boolean);
  if (!parts.length) return null;
  return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
}

export function buildGmailScript(options: GmailScriptOptions): string {
  const query = gmailSearchQuery(options);
  if (!query) throw new Error('Cần chọn email ngân hàng hoặc một nhãn Gmail hợp lệ.');
  if (!/^https:\/\/[^\s"'\\]+$/.test(options.ingestUrl)) throw new Error('Địa chỉ nhận phải là HTTPS.');
  if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error('Khóa kết nối không hợp lệ.');
  const config = JSON.stringify({ diaChiNhan: options.ingestUrl, khoa: options.token, truyVan: query, phienBan: GMAIL_SCRIPT_VERSION }, null, 2);
  return `// iHome CRM · chuyển email biến động số dư từ Gmail về CRM (${GMAIL_SCRIPT_VERSION})
// Cài: dán toàn bộ vào script.google.com (Dự án mới), chọn hàm caiDat rồi bấm Chạy và cấp quyền.
// Gỡ: chọn hàm goCaiDat rồi bấm Chạy. Script chứa khóa kết nối: không chia sẻ; lộ khóa thì Cấp lại khóa trên CRM.
var CAU_HINH = ${config};
var GIO_VN_MS = 7 * 3600 * 1000;
var DEM_BAT_DAU = 30;   // 00:30 giờ Việt Nam (phút trong ngày)
var DEM_KET_THUC = 390; // 06:30
var TRAN_GIAY = 3600;   // Google cho 90 phút/ngày: dùng quá 60 phút thì chuyển 5 phút/lần tới hết ngày
var CHONG_LECH_MS = 10 * 60 * 1000;
var BAO_SONG_MS = 10 * 60 * 1000;
var NHIP = { 'day-1m': 1, 'night-10m': 10, 'saver-5m': 5 };

function caiDat() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('maThietBi')) p.setProperty('maThietBi', Utilities.getUuid());
  if (!p.getProperty('conTro')) p.setProperty('conTro', String(Date.now() - 24 * 3600 * 1000));
  p.deleteProperty('nhip');
  quetGmail();
}

function goCaiDat() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  PropertiesService.getScriptProperties().deleteAllProperties();
}

function quetGmail() {
  var batDau = Date.now();
  var khoa = LockService.getScriptLock();
  if (!khoa.tryLock(1000)) return;
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperties();
  if (!s.maThietBi) s.maThietBi = Utilities.getUuid();
  try {
    guiThuMoi_(s);
  } finally {
    try {
      var giay = thoiGianDaDung_(s) + (Date.now() - batDau) / 1000;
      dieuChinhNhip_(s, giay);
      baoSong_(s, giay);
    } finally {
      var tong = thoiGianDaDung_(s) + (Date.now() - batDau) / 1000 + 0.5;
      s.thoiGian = JSON.stringify({ ngay: ngayVN_(Date.now()), giay: Math.round(tong * 10) / 10 });
      p.setProperties(s);
      khoa.releaseLock();
    }
  }
}

function guiThuMoi_(s) {
  var conTro = Number(s.conTro || Date.now() - 24 * 3600 * 1000);
  var luc = Date.now();
  var tu = conTro - CHONG_LECH_MS;
  var luong = GmailApp.search(CAU_HINH.truyVan + ' after:' + Math.floor(tu / 1000), 0, 50);
  var daGui = JSON.parse(s.daGui || '{}');
  var thu = [];
  GmailApp.getMessagesForThreads(luong).forEach(function (ds) {
    ds.forEach(function (m) { if (m.getDate().getTime() >= tu && !daGui[m.getId()]) thu.push(m); });
  });
  thu.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });
  var xong = true;
  try {
    for (var i = 0; i < thu.length; i++) {
      var ketQua = gui_(thanhTin_(thu[i], s.maThietBi));
      if (ketQua === 'thu-lai') { xong = false; break; }
      if (ketQua === 'bo-qua') console.warn('CRM không nhận thư ' + thu[i].getId() + '; bỏ qua để không gửi lại mãi.');
      daGui[thu[i].getId()] = Date.now();
    }
  } catch (loi) {
    xong = false;
    throw loi;
  } finally {
    var giu = Date.now() - 2 * 86400000;
    Object.keys(daGui).forEach(function (k) { if (daGui[k] < giu) delete daGui[k]; });
    s.daGui = JSON.stringify(daGui);
    if (xong && luong.length < 50) s.conTro = String(luc);
  }
}

function thanhTin_(m, maThietBi) {
  var id = bam_('gmail:' + m.getId());
  return { schemaVersion: 1, event: 'email.received', id: id, deviceId: maThietBi, receivedAt: m.getDate().toISOString(),
    from: cat_(m.getFrom(), 512), subject: cat_(m.getSubject(), 1024),
    body: cat_(String(m.getPlainBody() || '').replace(/\\r/g, '').replace(/[ \\t\\u00a0]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim(), 8192) };
}

function gui_(tin) {
  var r = UrlFetchApp.fetch(CAU_HINH.diaChiNhan, {
    method: 'post', contentType: 'application/json; charset=utf-8', muteHttpExceptions: true, followRedirects: false,
    headers: { Authorization: 'Bearer ' + CAU_HINH.khoa, 'X-Idempotency-Key': tin.id },
    payload: Utilities.newBlob('').setDataFromString(JSON.stringify(tin), 'UTF-8').getBytes()
  });
  var ma = r.getResponseCode();
  if (ma === 200 || ma === 201) return 'xong';
  if (ma === 401 || ma === 403) throw new Error('CRM từ chối khóa kết nối (HTTP ' + ma + '). Nguồn Gmail đã bị tạm dừng, thu hồi hoặc cấp lại khóa: lấy script mới trên trang Biến động số dư.');
  if (ma === 409) throw new Error('CRM báo xung đột (HTTP 409): đang có bản script khác dùng khóa này. Chạy goCaiDat ở bản cũ hoặc cấp lại khóa.');
  if (ma === 400 || ma === 413 || ma === 415) return 'bo-qua';
  return 'thu-lai';
}

function baoSong_(s, giay) {
  var bayGio = Date.now();
  if (bayGio - Number(s.baoSongLuc || 0) < BAO_SONG_MS && s.nhipDaBao === s.nhip) return;
  var tin = { schemaVersion: 1, event: 'gateway.heartbeat', id: bam_('heartbeat:' + s.maThietBi + ':' + bayGio), deviceId: s.maThietBi,
    receivedAt: new Date(bayGio).toISOString(), channel: 'gmail', appVersion: CAU_HINH.phienBan, schedule: s.nhip,
    usedSecondsToday: Math.min(86400, Math.round(giay)) };
  if (gui_(tin) === 'xong') { s.baoSongLuc = String(bayGio); s.nhipDaBao = s.nhip; }
}

function nhipMongMuon_(giay) {
  var phut = phutVN_(Date.now());
  if (phut >= DEM_BAT_DAU && phut < DEM_KET_THUC) return 'night-10m';
  return giay >= TRAN_GIAY ? 'saver-5m' : 'day-1m';
}

function dieuChinhNhip_(s, giay) {
  var muon = nhipMongMuon_(giay);
  if (s.nhip === muon) return;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'quetGmail') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('quetGmail').timeBased().everyMinutes(NHIP[muon]).create();
  // Hẹn đúng 06:30 để quay lại 1 phút/lần, không phải chờ hết chu kỳ 10 phút.
  if (muon === 'night-10m') ScriptApp.newTrigger('quetGmail').timeBased().at(new Date(hetDem_())).create();
  s.nhip = muon;
}

function hetDem_() {
  var bayGio = Date.now();
  var dauNgay = Math.floor((bayGio + GIO_VN_MS) / 86400000) * 86400000 - GIO_VN_MS;
  var het = dauNgay + DEM_KET_THUC * 60000;
  return het > bayGio ? het : het + 86400000;
}

function thoiGianDaDung_(s) {
  var g = JSON.parse(s.thoiGian || '{}');
  return g.ngay === ngayVN_(Date.now()) ? Number(g.giay) || 0 : 0;
}

function ngayVN_(ms) { return new Date(ms + GIO_VN_MS).toISOString().slice(0, 10); }
function phutVN_(ms) { var d = new Date(ms + GIO_VN_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

function bam_(chuoi) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, chuoi, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

// Cắt theo số byte UTF-8 mà CRM nhận, thay ký tự UTF-16 hỏng bằng U+FFFD để không bị từ chối.
function cat_(chuoi, toiDa) {
  chuoi = String(chuoi || '');
  var ra = '', bytes = 0;
  for (var i = 0; i < chuoi.length; i++) {
    var c = chuoi.charCodeAt(i), ky = chuoi.charAt(i), n;
    if (c >= 0xd800 && c <= 0xdbff) {
      var d = chuoi.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { ky = chuoi.substr(i, 2); n = 4; i++; } else { ky = '\\ufffd'; n = 3; }
    } else if (c >= 0xdc00 && c <= 0xdfff) { ky = '\\ufffd'; n = 3; }
    else n = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes + n > toiDa) break;
    ra += ky; bytes += n;
  }
  return ra;
}
`;
}
