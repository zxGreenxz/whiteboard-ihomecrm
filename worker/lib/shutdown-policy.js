// =============================================================
// shutdown-policy.js — chính sách THOÁT tiến trình của worker.
//
// Vì sao tách riêng (sự cố 12→13/11/2026): mất lease thì worker dừng mọi phiên
// và nhả lease nhưng KHÔNG thoát ⇒ container vẫn "Up", Docker không dựng lại,
// Zalo câm 33 giờ; SIGTERM sau đó cũng bị bỏ qua vì "đang dừng rồi".
//   · mất lease            → dọn xong là thoát mã ≠ 0 để restart policy dựng
//                            tiến trình mới (tiến trình mới tự giành lại lease);
//   · tín hiệu             → dọn xong thoát mã 0, như cũ;
//   · dọn quá hạn chót     → buộc thoát mã ≠ 0, không bao giờ treo;
//   · tín hiệu khi đang dừng → thoát ngay, không lặng lẽ bỏ qua. Ngoại lệ duy
//                            nhất: đang dừng THEO TÍN HIỆU mà hạn chót chưa bật
//                            (còn drain provider native, còn giữ lease) thì vẫn
//                            chờ — runbook native cấm cắt bước đó.
// exit/timers/log được tiêm vào để test không phải giết tiến trình thật.
// =============================================================

// Đủ cho 10s chờ job đang gửi + một lượt nhả lease; ngắn hơn TTL lease (30s).
export const SHUTDOWN_DEADLINE_MS = 25_000;
// Ctrl-C qua `npm start` giao CÙNG một tín hiệu hai lần (terminal + npm chuyển
// tiếp) cách nhau vài ms — đó không phải lệnh "thoát ngay" của người vận hành.
export const SIGNAL_REPEAT_MS = 1_000;

export function createShutdownPolicy({
  cleanup,
  exit = (code) => process.exit(code),
  setExitCode = (code) => { process.exitCode = code; },
  timers = { setTimeout, clearTimeout },
  // Đồng hồ đơn điệu: giờ hệ thống bị chỉnh lùi không được nuốt tín hiệu lặp.
  now = () => performance.now(),
  log = () => {},
  deadlineMs = SHUTDOWN_DEADLINE_MS,
  signalRepeatMs = SIGNAL_REPEAT_MS,
} = {}) {
  let started = null; // { reason: 'signal' | 'lease-lost', at }
  let code = 0;
  let deadline = null;
  let exited = false;

  const finish = (exitCode) => {
    if (exited) return;
    exited = true;
    timers.clearTimeout(deadline);
    exit(exitCode);
  };
  // exitCode đặt sớm: nếu event loop tự cạn trước khi dọn xong thì mã thoát vẫn ≠ 0.
  const fail = () => { code = 1; setExitCode(1); };
  const armDeadline = () => {
    if (deadline !== null || exited) return;
    deadline = timers.setTimeout(() => {
      log(`quá ${Math.round(deadlineMs / 1000)}s chưa dừng xong — buộc thoát.`);
      finish(1);
    }, deadlineMs);
    deadline?.unref?.(); // không bao giờ giữ một tiến trình khoẻ ở lại
  };

  async function run(reason) {
    started = { reason, at: now() };
    try {
      await cleanup({ reason, armDeadline });
    } catch (error) {
      fail();
      log('lỗi khi dừng — vẫn thoát:', error?.message || error);
    }
    if (code !== 0) log(`đã dừng — thoát mã ${code}.`);
    finish(code);
  }

  return {
    // Hạn chót của đường tín hiệu do cleanup tự bật (sau khi drain provider
    // native xong — runbook native cho phép bước đó chờ không hạn).
    onSignal(signal) {
      if (!started) return run('signal');
      if (started.reason === 'signal') {
        const elapsed = now() - started.at;
        const duplicate = elapsed >= 0 && elapsed < signalRepeatMs;
        // Chưa bật hạn chót = còn drain provider native và còn giữ lease: chạy
        // lại `stop` lúc này không được cắt drain (kênh native sẽ bị quarantine).
        if (deadline === null) {
          if (!duplicate) log(`nhận ${signal} khi đang chờ provider kết thúc — vẫn chờ, không ép thoát.`);
          return undefined;
        }
        if (duplicate) return undefined;
      }
      log(`nhận ${signal} khi đang dừng — thoát ngay.`);
      return finish(1);
    },
    // Hết lease là hết lý do chờ: hạn chót chạy ngay, kể cả khi đang dừng theo tín hiệu.
    onLeaseLost() {
      fail();
      armDeadline();
      if (started) return undefined;
      return run('lease-lost');
    },
  };
}
