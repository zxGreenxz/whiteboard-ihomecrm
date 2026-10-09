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
// Cài: dán toàn bộ vào script.google.com, chọn hàm caiDat rồi bấm Chạy và cấp quyền.
// Gỡ: chọn hàm goCaiDat rồi bấm Chạy. Script chứa khóa kết nối: không chia sẻ; lộ khóa thì Cấp lại khóa trên CRM.
var CAU_HINH = ${config};
var GIO_VN_MS = 7 * 3600 * 1000;
var DEM_BAT_DAU = 30;   // 00:30 giờ Việt Nam (phút trong ngày)
var DEM_KET_THUC = 390; // 06:30
var TRAN_GIAY = 3600;   // Google cho 90 phút/ngày: dùng quá 60 phút thì chuyển 5 phút/lần tới hết ngày
var CHONG_LECH_MS = 10 * 60 * 1000;    // tìm lùi 10 phút theo giờ Gmail nhận thư
var THU_TRE_MS = 6 * 3600 * 1000;      // thư ghi giờ gửi sớm hơn giờ tới hộp thư tối đa 6 giờ vẫn được lấy
var NGAN_SACH_MS = 4 * 60 * 1000;      // Google dừng cứng ở 6 phút: mỗi lượt chỉ gửi trong 4 phút rồi để lượt sau
var BAO_SONG_MS = 10 * 60 * 1000;
var TRANG = 50, TOI_DA_TRANG = 20;
var MANH_DA_GUI = 5, MOI_MANH = 200;   // mỗi ô nhớ của Google tối đa 9 KB: chia danh sách thư đã gửi ra 5 ô
var NHIP = { 'day-1m': 1, 'night-10m': 10, 'saver-5m': 5, 'key-30m': 30 };
var LOI_KHOA = 'CRM từ chối khóa kết nối: nguồn Gmail đang tạm dừng, đã thu hồi hoặc đã cấp lại khóa. Script tự giãn 30 phút/lần; nếu đã cấp lại khóa, dán script mới từ trang Biến động số dư.';
var LOI_THIET_BI = 'CRM báo nguồn Gmail này đang gắn với một bản script khác. Trên trang Biến động số dư bấm Cấp lại khóa cho nguồn này rồi dán script mới (cấp lại khóa gỡ bản cũ); chạy goCaiDat ở bản cũ nếu còn.';
var LOI_DINH_DANG = 'CRM không nhận định dạng thư (HTTP 400). Script có thể đã cũ hoặc nguồn không phải loại Gmail: lấy script mới trên trang Biến động số dư.';

function caiDat() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('maThietBi')) p.setProperty('maThietBi', Utilities.getUuid());
  if (!p.getProperty('conTro')) p.setProperty('conTro', String(Date.now() - 24 * 3600 * 1000));
  p.deleteProperty('nhip');
  p.deleteProperty('khoaLoi');
  quetGmail();
}

// Gỡ trigger và trạng thái; giữ mã thiết bị để cài lại trong cùng dự án không bị CRM coi là bản script khác.
function goCaiDat() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var p = PropertiesService.getScriptProperties();
  var ma = p.getProperty('maThietBi');
  p.deleteAllProperties();
  if (ma) p.setProperty('maThietBi', ma);
}

function quetGmail() {
  var batDau = Date.now();
  var khoa = LockService.getScriptLock();
  if (!khoa.tryLock(1000)) return;
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperties();
  if (!s.maThietBi) s.maThietBi = Utilities.getUuid();
  var luu = function () { p.setProperties(s); };
  var loi = null;
  try { guiThuMoi_(s, batDau, luu); } catch (e) { loi = e; }
  try {
    var giay = thoiGianDaDung_(s) + (Date.now() - batDau) / 1000;
    // Lỗi mạng khi báo sống không được chặn việc đổi nhịp: đổi nhịp xong mới ném lại.
    try { baoSong_(s, giay); } catch (e) { loi = loi || e; }
    dieuChinhNhip_(s, giay);
  } finally {
    var tong = thoiGianDaDung_(s) + (Date.now() - batDau) / 1000 + 0.5;
    s.thoiGian = JSON.stringify({ ngay: ngayVN_(Date.now()), giay: Math.round(tong * 10) / 10 });
    luu();
    khoa.releaseLock();
  }
  if (loi) throw loi;
}

// Gmail trả luồng mới nhất trước, mỗi trang 50: lật hết trang (tối đa 1000 luồng) trong khoảng [tu, den).
function timLuong_(tu, den) {
  var truyVan = CAU_HINH.truyVan + ' after:' + Math.floor(tu / 1000) + (den ? ' before:' + Math.ceil(den / 1000) : '');
  var luong = [];
  for (var trang = 0; trang < TOI_DA_TRANG; trang++) {
    var mot = GmailApp.search(truyVan, trang * TRANG, TRANG);
    luong = luong.concat(mot);
    if (mot.length < TRANG) return { luong: luong, du: true };
  }
  return { luong: luong, du: false };
}

function guiThuMoi_(s, batDau, luu) {
  var conTro = Number(s.conTro || Date.now() - 24 * 3600 * 1000);
  var luc = Date.now();
  var tu = conTro - CHONG_LECH_MS;
  // Quá 1000 luồng thì thu hẹp về lát thời gian cũ nhất để luôn đi từ cũ tới mới, không bỏ lại luồng cũ.
  var den = luc, kq = timLuong_(tu, null);
  while (!kq.du && den - tu > 2 * CHONG_LECH_MS) { den = tu + Math.floor((den - tu) / 2); kq = timLuong_(tu, den); }
  if (!kq.du) console.warn('Quá ' + TRANG * TOI_DA_TRANG + ' luồng thư trong 20 phút; có thể bỏ sót thư cũ nhất.');
  var daGui = docDaGui_(s);
  var thu = [];
  GmailApp.getMessagesForThreads(kq.luong).forEach(function (ds) {
    ds.forEach(function (m) { if (m.getDate().getTime() >= tu - THU_TRE_MS && !daGui[m.getId()]) thu.push(m); });
  });
  thu.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });
  var xong = kq.du, moc = conTro, thietBi = null;
  try {
    for (var i = 0; i < thu.length; i++) {
      if (Date.now() - batDau > NGAN_SACH_MS) { xong = false; break; }
      var m = thu[i], ketQua = gui_(thanhTin_(m, s.maThietBi));
      if (ketQua === 'khoa') { s.khoaLoi = String(Date.now()); throw new Error(LOI_KHOA); }
      if (ketQua === 'sai-dang') throw new Error(LOI_DINH_DANG);
      // 409 có hai nghĩa: thư này đã lưu với nội dung khác (giữ bản đã lưu) hoặc khóa đang gắn bản script khác.
      if (ketQua === 'xung-dot') {
        if (thietBi === null) thietBi = guiBaoSong_(s, thoiGianDaDung_(s)) === 'xong';
        if (!thietBi) { s.khoaLoi = String(Date.now()); throw new Error(LOI_THIET_BI); }
      }
      if (ketQua === 'thu-lai') { xong = false; break; }
      if (ketQua === 'qua-lon') console.warn('Thư ' + m.getId() + ' quá lớn, CRM không nhận.');
      s.khoaLoi = ''; // setProperties chỉ ghi gộp: xoá cờ bằng chuỗi rỗng, không bằng delete
      daGui[m.getId()] = m.getDate().getTime();
      // Thư ghi giờ tương lai không được kéo con trỏ vượt quá khoảng đã quét.
      moc = Math.max(moc, Math.min(m.getDate().getTime(), den));
      if (i % 20 === 19) { ghiDaGui_(s, daGui, tu); luu(); }
    }
  } catch (loi) {
    xong = false;
    throw loi;
  } finally {
    ghiDaGui_(s, daGui, tu);
    s.conTro = String(xong ? Math.max(conTro, den) : moc);
  }
}

function thanhTin_(m, maThietBi) {
  return { schemaVersion: 1, event: 'email.received', id: bam_('gmail:' + m.getId()), deviceId: maThietBi,
    receivedAt: m.getDate().toISOString(), from: cat_(m.getFrom(), 512), subject: cat_(m.getSubject(), 1024),
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
  if (ma === 401 || ma === 403) return 'khoa';
  if (ma === 409) return 'xung-dot';
  if (ma === 413) return 'qua-lon';
  if (ma === 400 || ma === 415 || ma === 422) return 'sai-dang';
  return 'thu-lai';
}

function baoSong_(s, giay) {
  if (!s.khoaLoi && Date.now() - Number(s.baoSongLuc || 0) < BAO_SONG_MS && s.nhipDaBao === nhipKhoe_(giay)) return;
  guiBaoSong_(s, giay);
}

function guiBaoSong_(s, giay) {
  var bayGio = Date.now(), nhip = nhipKhoe_(giay);
  var ketQua = gui_({ schemaVersion: 1, event: 'gateway.heartbeat', id: bam_('heartbeat:' + s.maThietBi + ':' + bayGio),
    deviceId: s.maThietBi, receivedAt: new Date(bayGio).toISOString(), channel: 'gmail', appVersion: CAU_HINH.phienBan,
    schedule: nhip, usedSecondsToday: Math.min(86400, Math.round(giay)) });
  if (ketQua === 'xong') { s.baoSongLuc = String(bayGio); s.nhipDaBao = nhip; s.khoaLoi = ''; }
  if (ketQua === 'khoa') s.khoaLoi = String(bayGio);
  return ketQua;
}

function nhipKhoe_(giay) {
  var phut = phutVN_(Date.now());
  if (phut >= DEM_BAT_DAU && phut < DEM_KET_THUC) return 'night-10m';
  return giay >= TRAN_GIAY ? 'saver-5m' : 'day-1m';
}

function nhipMongMuon_(s, giay) { return s.khoaLoi ? 'key-30m' : nhipKhoe_(giay); }

// Tạo trigger mới trước rồi mới xoá trigger cũ: tạo lỗi thì script vẫn chạy theo nhịp cũ và thử lại lượt sau.
function dieuChinhNhip_(s, giay) {
  var muon = nhipMongMuon_(s, giay);
  if (s.nhip === muon) return;
  var cu = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'quetGmail'; });
  ScriptApp.newTrigger('quetGmail').timeBased().everyMinutes(NHIP[muon]).create();
  // Hẹn đúng 06:30 để quay lại 1 phút/lần, không phải chờ hết chu kỳ 10 phút.
  if (muon === 'night-10m') ScriptApp.newTrigger('quetGmail').timeBased().at(new Date(hetDem_())).create();
  cu.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  s.nhip = muon;
}

function hetDem_() {
  var bayGio = Date.now();
  var dauNgay = Math.floor((bayGio + GIO_VN_MS) / 86400000) * 86400000 - GIO_VN_MS;
  var het = dauNgay + DEM_KET_THUC * 60000;
  return het > bayGio ? het : het + 86400000;
}

// Chỉ giữ thư còn có thể quay lại cửa sổ quét (mới hơn tu − 7 giờ), mới nhất trước, tối đa 5 × 200 thư.
function docDaGui_(s) {
  var ra = {};
  for (var i = 0; i < MANH_DA_GUI; i++) {
    String(s['daGui' + i] || '').split(';').forEach(function (muc) {
      var c = muc.split(',');
      if (c.length === 2) ra[c[0]] = Number(c[1]);
    });
  }
  return ra;
}

function ghiDaGui_(s, daGui, tu) {
  var giu = tu - THU_TRE_MS - 3600000;
  var ds = Object.keys(daGui).filter(function (k) { return daGui[k] >= giu; })
    .sort(function (a, b) { return daGui[b] - daGui[a]; }).slice(0, MANH_DA_GUI * MOI_MANH);
  for (var i = 0; i < MANH_DA_GUI; i++) {
    s['daGui' + i] = ds.slice(i * MOI_MANH, (i + 1) * MOI_MANH).map(function (k) { return k + ',' + daGui[k]; }).join(';');
  }
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
