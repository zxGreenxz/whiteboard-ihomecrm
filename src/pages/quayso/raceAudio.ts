/**
 * Âm thanh trường đua cho trò "đua thú" (/quayso).
 *
 * Tổng hợp bằng WebAudio, KHÔNG tải file — trang này người xem mở bằng 4G giữa
 * hội trường, thêm vài trăm KB mp3 là rủi ro không đáng.
 *
 * ── VÌ SAO KHÔNG DÙNG setInterval/setTimeout CHO NHỊP ──────────────────────
 * `setInterval` bị trình duyệt ghìm (throttle) và trôi vài chục ms mỗi nhịp —
 * tai người nghe ra ngay: tiếng vó ngựa nghe "lệt bệt", đếm ngược "3-2-1" không
 * trùng lúc con số đổi trên màn hình. Ở đây mọi nhịp đều đặt lịch trên ĐỒNG HỒ
 * ÂM THANH (`ctx.currentTime`), còn `setInterval` chỉ làm mỗi việc bơm thêm nhịp
 * cho 150ms sắp tới — mẫu "A Tale of Two Clocks" kinh điển.
 *
 * ── KHỚP HÌNH ─────────────────────────────────────────────────────────────
 *  - Đếm ngược: `countdown()` trả về MỐC THỜI GIAN của từng tiếng bíp trên đồng
 *    hồ âm thanh; giao diện đọc `now()` mỗi khung hình để đổi con số. Một nguồn
 *    thời gian duy nhất ⇒ không bao giờ lệch.
 *  - Cán đích / tăng tốc: phát ngay trong khung hình phát hiện sự kiện, độ trễ
 *    dưới một khung hình.
 *
 * Trình duyệt di động CHẶN autoplay: `ctx` chỉ được tạo/resume trong một cử chỉ
 * người dùng. Nên mặc định TẮT TIẾNG, có nút bật — bật sẵn thì đa số máy sẽ im
 * lặng và người dùng tưởng hỏng.
 */

type Ctor = typeof AudioContext;

export class RaceAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  /** Nền đám đông — chạy suốt cuộc đua, dâng dần. */
  private crowdSrc: AudioBufferSourceNode | null = null;
  private crowdGain: GainNode | null = null;

  private timer: number | null = null;
  private nextBeat = 0;
  private beatIdx = 0;
  /** 0 → 1: mức căng thẳng, điều khiển tempo vó chạy + độ ồn khán đài. */
  private tension = 0;

  private muted = true;

  /** Bật/tắt tiếng. Gọi trong cử chỉ người dùng thì mới mở được AudioContext. */
  setMuted(m: boolean): void {
    this.muted = m;
    if (!m) this.ensure();
    if (this.master && this.ctx) {
      // Đổi mượt 60ms — set thẳng gain gây tiếng "bụp".
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(m ? 0 : 0.62, this.ctx.currentTime, 0.02);
    }
    if (!m && this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Đồng hồ âm thanh (giây). 0 khi chưa mở được ngữ cảnh. */
  now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Có ngữ cảnh âm thanh dùng được không (để giao diện biết mà rơi về đồng hồ thường). */
  get ready(): boolean {
    return this.ctx != null && this.ctx.state === 'running';
  }

  private ensure(): void {
    if (this.ctx) return;
    // Đang tắt tiếng thì đừng mở ngữ cảnh: trình duyệt di động chỉ cho mở trong
    // cử chỉ người dùng, mở "phòng hờ" ở đây chỉ tạo ra một ngữ cảnh
    // `suspended` vô dụng. `setMuted(false)` gán cờ TRƯỚC khi gọi hàm này nên
    // lúc người dùng bật tiếng thì nhánh này không chặn.
    if (this.muted) return;
    const w = window as Window & { webkitAudioContext?: Ctor };
    const C: Ctor | undefined = window.AudioContext ?? w.webkitAudioContext;
    if (!C) return;
    try {
      this.ctx = new C();
    } catch {
      return; // máy không cho tạo — chạy câm, không làm vỡ trang
    }
    const g = this.ctx.createGain();
    g.gain.value = this.muted ? 0 : 0.62;
    g.connect(this.ctx.destination);
    this.master = g;

    // Một giây nhiễu trắng, tái sử dụng cho mọi tiếng gõ/ồn.
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, sr, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
  }

  /* ───────────────────────────── viên gạch ───────────────────────────── */

  private tone(freq: number, dur: number, vol: number, type: OscillatorType, at = 0): void {
    if (this.muted) return;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = Math.max(ctx.currentTime, at || ctx.currentTime);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Tiếng gõ/xì bằng nhiễu qua bộ lọc — vó ngựa, vỗ tay, hò reo đều từ đây. */
  private burst(
    freq: number,
    dur: number,
    vol: number,
    q: number,
    at = 0,
    type: BiquadFilterType = 'bandpass',
  ): void {
    if (this.muted) return;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise) return;
    const t = Math.max(ctx.currentTime, at || ctx.currentTime);
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(master);
    s.start(t);
    s.stop(t + dur + 0.02);
  }

  /** Trống trầm — nhịp mạnh nền cho đoạn nước rút. */
  private kick(at: number, vol = 0.5): void {
    if (this.muted) return;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = Math.max(ctx.currentTime, at);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.13);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.24);
  }

  /* ───────────────────────────── sự kiện ────────────────────────────── */

  /**
   * Đếm ngược `n` giây rồi kèn xuất phát.
   * Trả về mảng MỐC trên đồng hồ âm thanh: `[bíp n, …, bíp 1, kèn]`.
   * Giao diện dùng chính mảng này để đổi con số ⇒ tiếng và hình cùng một gốc.
   */
  countdown(n: number): number[] {
    this.ensure();
    const t0 = this.now() + 0.12; // đệm nhỏ cho lệnh kịp vào hàng đợi
    const moc: number[] = [];
    for (let k = 0; k < n; k++) {
      const at = t0 + k;
      moc.push(at);
      // Bíp cao dần cho ra cảm giác dồn.
      this.tone(660 + k * 110, 0.16, 0.22, 'square', at);
      this.kick(at, 0.34);
    }
    moc.push(t0 + n);
    this.postCall(t0 + n);
    return moc;
  }

  /** Kèn "call to post" — mô-típ kèn đồng quen thuộc của trường đua. */
  postCall(at = 0): void {
    this.ensure();
    const t = at || this.now();
    const notes: [number, number, number][] = [
      [523.25, 0.0, 0.16], [659.25, 0.14, 0.16], [783.99, 0.28, 0.16],
      [1046.5, 0.42, 0.3], [783.99, 0.74, 0.14], [1046.5, 0.9, 0.5],
    ];
    for (const [f, off, dur] of notes) {
      this.tone(f, dur, 0.16, 'sawtooth', t + off);
      this.tone(f * 2, dur, 0.05, 'triangle', t + off);
    }
    // Chuông xuất phát.
    this.burst(2600, 0.5, 0.3, 3, t + 0.9, 'highpass');
  }

  /* ─────────────────── nền cuộc đua: vó chạy + khán đài ─────────────────── */

  /** Bắt đầu nền cuộc đua. Gọi đúng lúc đàn thú lao đi. */
  startRace(): void {
    this.ensure();
    this.stopRace();
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise) return; // đang tắt tiếng — không có gì để dựng

    // Nền khán đài: nhiễu qua lọc dải, gain dâng theo `tension`.
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    s.connect(f);
    f.connect(g);
    g.connect(master);
    s.start();
    g.gain.setTargetAtTime(0.07, ctx.currentTime, 0.6);
    this.crowdSrc = s;
    this.crowdGain = g;

    this.tension = 0;
    this.beatIdx = 0;
    this.nextBeat = ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.pump(), 25);
  }

  /**
   * Cập nhật mức căng thẳng 0→1 (thường là tiến độ của con dẫn đầu).
   * Nhịp vó nhanh dần, khán đài ồn dần — đây là chỗ tạo cảm giác "sôi động".
   */
  setTension(x: number): void {
    this.tension = Math.min(1, Math.max(0, x));
    const ctx = this.ctx;
    if (this.crowdGain && ctx) {
      this.crowdGain.gain.setTargetAtTime(0.06 + this.tension * 0.16, ctx.currentTime, 0.35);
    }
  }

  /**
   * Bơm nhịp cho 150ms sắp tới. Nhịp NẰM TRÊN ĐỒNG HỒ ÂM THANH nên không trôi.
   * Khi tắt tiếng thì `tone`/`burst`/`kick` tự chặn, nên vòng này chỉ còn là
   * phép cộng — bật tiếng giữa chừng là vào đúng nhịp ngay, không phải chờ.
   */
  private pump(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const horizon = ctx.currentTime + 0.15;
    // Chu kỳ phi nước đại: 0.60s lúc thong thả → 0.34s lúc nước rút.
    while (this.nextBeat < horizon) {
      const cycle = 0.6 - this.tension * 0.26;
      const at = this.nextBeat;
      // Vó ngựa 4 nhịp: cụp-cụp-cụp — nghỉ.
      const offs = [0, 0.115, 0.205, 0.315].map((o) => o * (cycle / 0.6));
      for (let k = 0; k < offs.length; k++) {
        this.burst(300 + k * 90, 0.075, 0.2 + this.tension * 0.12, 1.1, at + offs[k]);
      }
      // Trống nền vào phách mạnh, chỉ xuất hiện từ giữa cuộc đua trở đi.
      if (this.tension > 0.35) this.kick(at, 0.18 + this.tension * 0.28);
      // Vỗ tay dồn ở đoạn nước rút.
      if (this.tension > 0.62 && this.beatIdx % 2 === 0) {
        this.burst(1800, 0.09, 0.12 + this.tension * 0.14, 0.7, at + offs[2], 'highpass');
      }
      this.beatIdx++;
      this.nextBeat += cycle;
    }
  }

  /** Dừng nền cuộc đua (đàn đã về hoặc rời trang). */
  stopRace(): void {
    if (this.timer != null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const ctx = this.ctx;
    const src = this.crowdSrc;
    const g = this.crowdGain;
    this.crowdSrc = null;
    this.crowdGain = null;
    if (!ctx || !src || !g) return;
    g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.35);
    try {
      src.stop(ctx.currentTime + 1.6);
    } catch {
      /* đã dừng rồi */
    }
  }

  /* ───────────────────────── điểm nhấn trong đua ───────────────────────── */

  /** Một con bứt tốc — tiếng "vút". */
  boost(): void {
    if (this.muted) return;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(1500, t + 0.26);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.26);
    f.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(f);
    f.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.34);
  }

  /** Sát nút — trống dồn + nhịp tim, đi kèm quay chậm bên hình. */
  suspense(): void {
    if (this.muted) return;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let k = 0; k < 14; k++) this.burst(220, 0.05, 0.16, 1.4, t + k * 0.055);
    this.kick(t + 0.02, 0.5);
    this.kick(t + 0.34, 0.5);
  }

  /** Cán đích — kèn + chuông. */
  finish(): void {
    this.ensure();
    const t = this.now();
    for (const [f, off] of [[783.99, 0], [1046.5, 0.09], [1318.5, 0.18]] as const) {
      this.tone(f, 0.5, 0.17, 'sawtooth', t + off);
    }
    this.burst(3000, 0.7, 0.26, 2.5, t, 'highpass');
  }

  /** Reo hò ăn mừng — dùng khi công bố đội trúng. */
  cheer(): void {
    this.ensure();
    const t = this.now();
    // Sóng người: nhiễu dải rộng dâng rồi tan.
    this.burst(1200, 2.2, 0.4, 0.35, t, 'bandpass');
    this.burst(420, 1.8, 0.3, 0.5, t + 0.05);
    // Vỗ tay rời rạc 1,6 giây.
    for (let k = 0; k < 46; k++) {
      this.burst(2200 + Math.random() * 1400, 0.05, 0.1, 0.8, t + Math.random() * 1.6, 'highpass');
    }
    this.postCall(t + 0.15);
  }

  /** Gỡ sạch khi rời trang. */
  dispose(): void {
    this.stopRace();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    if (ctx) {
      // `close()` từ chối khi ngữ cảnh đã đóng sẵn (rời trang hai lần, StrictMode
      // gắn-nhả-gắn ở chế độ dev). Không có gì để quyết định: ngữ cảnh đóng rồi
      // thì mục tiêu của hàm này đã đạt.
      void ctx.close().catch(() => {
        /* đã đóng từ trước — đúng ý muốn */
      });
    }
  }
}
