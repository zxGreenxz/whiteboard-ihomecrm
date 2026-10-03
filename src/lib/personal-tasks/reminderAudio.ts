import type { ReminderSettings } from './reminders';

/** Web Audio is unlocked only from the enable / preview button's user gesture. */
export function createReminderAudio() {
  let context: AudioContext | null = null;
  let disposed = false;
  return {
    async unlock() {
      if (disposed) return;
      context ??= new AudioContext();
      if (context.state === 'suspended') await context.resume();
    },
    play(tone: ReminderSettings['tone']) {
      if (disposed || !context || context.state !== 'running' || document.visibilityState !== 'visible') return false;
      const notes = tone === 'tintin' ? [[880, 0, .18], [880, .26, .18]] : tone === 'dingdong' ? [[660, 0, .45], [523, .5, .65]] : [[1047, 0, .9], [1568, .08, .75], [2093, .16, .6]];
      for (const [frequency, offset, duration] of notes) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + offset;
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(.08, start + .01);
        gain.gain.exponentialRampToValueAtTime(.001, start + duration);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(start); oscillator.stop(start + duration + .02);
      }
      return true;
    },
    close() {
      disposed = true;
      if (context && context.state !== 'closed') void context.close().catch(error => { console.warn('Không đóng được bộ phát chuông cá nhân.', error); });
      context = null;
    },
  };
}
