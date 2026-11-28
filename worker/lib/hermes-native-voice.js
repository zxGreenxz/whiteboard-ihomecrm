import { downloadForwardUrl } from './hermes-native-media.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MODELS = new Set(['google/chirp-3', 'elevenlabs/scribe-v2']);

function audioFormat(data) {
  const header = data.toString('latin1', 0, 12);
  if (header.startsWith('OggS')) return 'ogg';
  if (header.startsWith('RIFF') && header.endsWith('WAVE')) return 'wav';
  if (header.slice(4, 8) === 'ftyp') return 'm4a';
  if (data.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return 'aac';
  if (header.startsWith('ID3') || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0 && (data[1] & 6))) return 'mp3';
  throw new Error('unsupported_voice_format');
}

// This credential can only transcribe. The OpenRouter key stays at the Edge.
export function ownerVoiceTranscriber(env, send = fetch) {
  const model = env.HERMES_OWNER_VOICE_MODEL;
  if (!MODELS.has(model)) return null;
  const project = env.SUPABASE_URL;
  const token = env.HERMES_OWNER_VOICE_TOKEN;
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(project) || !token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const endpoint = new URL('/functions/v1/zalo-owner-voice', project);
  return async (url, fetchMedia, active) => {
    const { data } = await downloadForwardUrl(url, { fetchImpl: fetchMedia, maxBytes: MAX_BYTES });
    if (data.length < 12 || !active()) throw new Error('voice_unavailable');
    const format = audioFormat(data);
    const response = await send(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream',
        'x-audio-format': format, 'x-stt-model': model },
      body: data,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('transcription_unavailable'); }
    const result = await response.json();
    if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('empty_transcription');
    return result.text;
  };
}
