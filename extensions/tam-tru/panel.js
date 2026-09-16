// Bảng nổi trên form Đăng ký tạm trú: hiện gói đang chờ, tải ảnh, giao cho
// fill-engine (MAIN world) điền, và báo tiến độ. Không bao giờ bấm Lưu nháp/Nộp.
(() => {
  if (new URLSearchParams(location.search).has('id')) return; // đang sửa nháp: không tự điền
  if (document.getElementById('ihome-tamtru-panel')) return;

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r));
    } catch (e) { resolve(null); }
  });

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  let pending = null;
  let panel, body, steps, actions, fillBtn, anhBox;

  const NHAN_LOAI = { CT01: 'Tờ khai CT01', LEASE: 'Hợp đồng thuê', OWNERSHIP: 'Chỗ ở hợp pháp' };

  /** Ảnh thu nhỏ để người dùng nhìn thấy ĐÚNG ảnh nào sắp đính kèm, không chỉ tên tệp. */
  function veAnh(files) {
    anhBox.textContent = '';
    if (!files || files.length === 0) return;
    const theoLoai = {};
    files.forEach((f) => { (theoLoai[f.kind] = theoLoai[f.kind] || []).push(f); });
    for (const kind of ['CT01', 'LEASE', 'OWNERSHIP']) {
      const nhom = theoLoai[kind];
      if (!nhom) continue;
      const khoi = el('div', 'ihome-tamtru-nhom');
      khoi.appendChild(el('div', 'ihome-tamtru-nhom-ten', (NHAN_LOAI[kind] || kind) + ' (' + nhom.length + ')'));
      const hang = el('div', 'ihome-tamtru-hang');
      nhom.forEach((f) => {
        const o = el('figure', 'ihome-tamtru-anh');
        const img = document.createElement('img');
        img.src = f.dataUrl;
        img.alt = f.name;
        img.title = f.name + ' — bấm để xem to';
        img.addEventListener('click', () => window.open(f.dataUrl, '_blank'));
        o.appendChild(img);
        o.appendChild(el('figcaption', null, f.name));
        hang.appendChild(o);
      });
      khoi.appendChild(hang);
      anhBox.appendChild(khoi);
    }
  }

  function setStatus(text, kind) {
    body.textContent = '';
    const p = el('p', 'ihome-tamtru-status ' + (kind || ''), text);
    body.appendChild(p);
  }

  function addStep(d) {
    let li = steps.querySelector('[data-step="' + CSS.escape(d.step) + '"]');
    if (!li) {
      li = el('li');
      li.dataset.step = d.step;
      li.appendChild(el('span', 'ihome-tamtru-step-name', d.step));
      li.appendChild(el('span', 'ihome-tamtru-step-msg', ''));
      steps.appendChild(li);
    }
    li.className = d.ok ? (d.partial ? 'running' : 'ok') : 'fail';
    if (d.message) li.querySelector('.ihome-tamtru-step-msg').textContent = d.message;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function loadFile(a) {
    const viaBackground = await send({ type: 'FETCH_FILE', url: a.url });
    if (viaBackground && viaBackground.ok) return { kind: a.kind, name: a.fileName, type: viaBackground.type || a.contentType, dataUrl: viaBackground.dataUrl };
    const res = await fetch(a.url);
    if (!res.ok) throw new Error('Không tải được ảnh ' + a.fileName + ' (HTTP ' + res.status + ')');
    const blob = await res.blob();
    return { kind: a.kind, name: a.fileName, type: blob.type || a.contentType, dataUrl: await blobToDataUrl(blob) };
  }

  async function fill() {
    const payload = pending.payload;
    fillBtn.disabled = true;
    steps.textContent = '';
    setStatus('Đang tải ' + payload.attachments.length + ' ảnh đính kèm…', 'info');
    let files;
    try {
      files = await Promise.all(payload.attachments.map(loadFile));
    } catch (e) {
      setStatus(String((e && e.message) || e), 'error');
      fillBtn.disabled = false;
      return;
    }
    veAnh(files);
    setStatus('Đang điền form…', 'info');
    window.postMessage({ type: 'IHOME_TAMTRU_RUN', payload, files }, location.origin);
  }

  /** Cổng vừa nhận hồ sơ: gắn mã với khách của gói đang chờ rồi gửi về CRM. */
  function daNop(d) {
    const p = pending && pending.payload;
    if (!p || !d.submCode) return;
    send({
      type: 'TAM_TRU_DA_NOP',
      ketQua: {
        submCode: d.submCode,
        receiveOrg: d.receiveOrg || '',
        tempResidentFrom: d.tempResidentFrom || '',
        tempResidentTo: d.tempResidentTo || p.tempResidentTo || '',
        submittedAt: d.submittedAt || new Date().toISOString(),
        customerId: p.customerId,
        buildingId: p.buildingId,
        organizationId: p.organizationId,
        contractId: p.contractId,
        buildingName: p.buildingName,
        fullName: p.person && p.person.fullName,
      },
    });
    if (panel && body) {
      setStatus('Đã nộp. Mã hồ sơ ' + d.submCode + ' — CRM sẽ ghi vào hồ sơ khách khi bạn quay lại tab CRM.', 'ok');
    }
  }

  function finish(d) {
    if (d.ok) {
      setStatus('Đã điền xong. Kiểm tra lại từng mục, tick "Tôi xin chịu trách nhiệm" rồi bấm Nộp hồ sơ (hoặc Lưu nháp).', 'ok');
      send({ type: 'CLEAR_PENDING' });
      fillBtn.textContent = 'Điền lại';
    } else {
      setStatus('Dừng ở một bước: ' + (d.message || 'lỗi không rõ') + '. Phần đã điền vẫn giữ nguyên, bạn có thể tự bổ sung.', 'error');
    }
    fillBtn.disabled = false;
  }

  function render() {
    const p = pending.payload;
    panel = el('div');
    panel.id = 'ihome-tamtru-panel';
    const head = el('div', 'ihome-tamtru-head');
    head.appendChild(el('strong', null, 'iHome Tạm trú'));
    const close = el('button', 'ihome-tamtru-close', '×');
    close.type = 'button';
    close.title = 'Ẩn bảng';
    close.addEventListener('click', () => panel.remove());
    head.appendChild(close);
    panel.appendChild(head);

    const info = el('div', 'ihome-tamtru-info');
    info.appendChild(el('div', null, 'Khách: ' + p.person.fullName + ' · CCCD ' + p.person.idNumber));
    info.appendChild(el('div', null, 'Toà ' + p.buildingName + ' · Phòng ' + p.roomNumber + ' · ' + p.receive.wardName));
    info.appendChild(el('div', null, 'Hạn tạm trú đến ' + p.tempResidentTo + ' · ' + p.attachments.length + ' ảnh đính kèm'));
    panel.appendChild(info);

    body = el('div', 'ihome-tamtru-body');
    setStatus('Bấm "Điền ngay" để tool điền toàn bộ form. Bạn vẫn tự kiểm tra và bấm Nộp.', 'info');
    panel.appendChild(body);

    anhBox = el('div', 'ihome-tamtru-anhbox');
    panel.appendChild(anhBox);

    steps = el('ol', 'ihome-tamtru-steps');
    panel.appendChild(steps);

    actions = el('div', 'ihome-tamtru-actions');
    fillBtn = el('button', 'ihome-tamtru-primary', 'Điền ngay');
    fillBtn.type = 'button';
    fillBtn.addEventListener('click', () => { fill(); });
    const dismiss = el('button', 'ihome-tamtru-secondary', 'Bỏ gói này');
    dismiss.type = 'button';
    dismiss.addEventListener('click', async () => { await send({ type: 'CLEAR_PENDING' }); panel.remove(); });
    actions.appendChild(fillBtn);
    actions.appendChild(dismiss);
    panel.appendChild(actions);
    document.body.appendChild(panel);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.type === 'IHOME_TAMTRU_PROGRESS') addStep(ev.data);
    if (ev.data.type === 'IHOME_TAMTRU_DONE') finish(ev.data);
    if (ev.data.type === 'IHOME_TAMTRU_DA_NOP') daNop(ev.data);
  });

  (async () => {
    pending = await send({ type: 'GET_PENDING' });
    if (!pending || !pending.payload) return;
    if (document.body) render(); else document.addEventListener('DOMContentLoaded', render);
  })();
})();
