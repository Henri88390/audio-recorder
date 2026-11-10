import { Mp3Encoder } from '@breezystack/lamejs';

export type QualityId = 'low' | 'medium' | 'high' | 'lossless';
export type FormatId = 'wav' | 'mp3' | 'mp4';

export interface Quality {
  id: QualityId;
  label: string;
  description: string;
  /** null = keep the capture sample rate */
  sampleRate: number | null;
  channels: 1 | 2;
  wavBits: 16 | 24 | 32;
  mp3Kbps: number;
}

export const QUALITIES: Quality[] = [
  { id: 'low', label: 'Low', description: '22.05 kHz mono · MP3 64 kbps / WAV & MP4 16-bit', sampleRate: 22050, channels: 1, wavBits: 16, mp3Kbps: 64 },
  { id: 'medium', label: 'Medium', description: '44.1 kHz stereo · MP3 128 kbps / WAV & MP4 16-bit', sampleRate: 44100, channels: 2, wavBits: 16, mp3Kbps: 128 },
  { id: 'high', label: 'High', description: '48 kHz stereo · MP3 320 kbps / WAV & MP4 24-bit', sampleRate: 48000, channels: 2, wavBits: 24, mp3Kbps: 320 },
  { id: 'lossless', label: 'No loss', description: 'Original sample rate, stereo · WAV & MP4 32-bit float (bit-exact) / MP3 320 kbps', sampleRate: null, channels: 2, wavBits: 32, mp3Kbps: 320 },
];

export const FORMATS: { id: FormatId; label: string; lossless: boolean }[] = [
  { id: 'wav', label: 'WAV (uncompressed)', lossless: true },
  { id: 'mp3', label: 'MP3 (compressed)', lossless: false },
  { id: 'mp4', label: 'MP4 (black video)', lossless: true },
];

const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

export interface Recording {
  channels: Float32Array[];
  sampleRate: number;
}

export function concatChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Resamples and/or downmixes using an OfflineAudioContext. */
async function convert(rec: Recording, sampleRate: number, channels: number): Promise<Float32Array[]> {
  const sameRate = sampleRate === rec.sampleRate;
  if (sameRate && channels === rec.channels.length) return rec.channels;

  if (sameRate && channels === 1) {
    const [l, r = l] = rec.channels;
    const mono = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
    return [mono];
  }

  const length = Math.ceil((rec.channels[0].length * sampleRate) / rec.sampleRate);
  const ctx = new OfflineAudioContext(channels, Math.max(length, 1), sampleRate);
  const buffer = ctx.createBuffer(rec.channels.length, rec.channels[0].length, rec.sampleRate);
  rec.channels.forEach((data, i) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, i));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return Array.from({ length: channels }, (_, i) => rendered.getChannelData(i));
}

/** Gain that brings the loudest sample just below full scale if the signal would otherwise clip. */
function headroomGain(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  return peak > 1 ? 0.98 / peak : 1;
}

/**
 * Float -> signed integer PCM with TPDF dither. Scale is 2^(bits-1), matching mediabunny,
 * so the same integers end up in WAV, MP3 and MP4 exports.
 */
function toIntPcm(channels: Float32Array[], bits: 16 | 24): Int32Array[] {
  const scale = 2 ** (bits - 1);
  const gain = headroomGain(channels);
  return channels.map((ch) => {
    const out = new Int32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const n = Math.round(ch[i] * gain * scale + Math.random() - Math.random());
      out[i] = Math.max(-scale, Math.min(scale - 1, n));
    }
    return out;
  });
}

function encodeWav(channels: Float32Array[], sampleRate: number, bits: 16 | 24 | 32): Blob {
  const numCh = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bits / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));

  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true); // 3 = IEEE float, 1 = PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);

  const ints = bits === 32 ? null : toIntPcm(channels, bits);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      if (!ints) {
        v.setFloat32(o, channels[c][i], true);
      } else if (bits === 16) {
        v.setInt16(o, ints[c][i], true);
      } else {
        const n = ints[c][i];
        v.setUint8(o, n & 0xff);
        v.setUint8(o + 1, (n >> 8) & 0xff);
        v.setUint8(o + 2, (n >> 16) & 0xff);
      }
      o += bytesPerSample;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const yieldToUi = () => new Promise((res) => setTimeout(res, 0));

async function encodeMp3(channels: Float32Array[], sampleRate: number, kbps: number, onProgress: (p: number) => void): Promise<Blob> {
  const encoder = new Mp3Encoder(channels.length, sampleRate, kbps);
  const pcm = toIntPcm(channels, 16).map((ch) => Int16Array.from(ch));
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const block = 1152 * 64;
  const total = pcm[0].length;
  for (let i = 0; i < total; i += block) {
    const l = pcm[0].subarray(i, i + block);
    const r = pcm[1]?.subarray(i, i + block);
    const out = encoder.encodeBuffer(l, r);
    if (out.length) parts.push(new Uint8Array(out));
    onProgress(i / total);
    await yieldToUi();
  }
  const end = encoder.flush();
  if (end.length) parts.push(new Uint8Array(end));
  onProgress(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}

/** MP4 with a black video track and uncompressed PCM audio (same samples as the WAV export). */
async function encodeMp4(channels: Float32Array[], sampleRate: number, bits: 16 | 24 | 32, onProgress: (p: number) => void): Promise<Blob> {
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioSampleSource, AudioSample, canEncodeVideo } = await import('mediabunny');

  // Integer samples are passed as n / 2^(bits-1), which mediabunny converts back to exactly n.
  let planes = channels;
  if (bits !== 32) {
    const scale = 2 ** (bits - 1);
    planes = toIntPcm(channels, bits).map((ch) => Float32Array.from(ch, (n) => n / scale));
  }

  const width = 640;
  const height = 360;
  const videoCodec = (await canEncodeVideo('avc', { width, height })) ? 'avc' : 'vp9';
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, width, height);

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: videoCodec, bitrate: 50_000, keyFrameInterval: 2 });
  const audio = new AudioSampleSource({ codec: bits === 32 ? 'pcm-f32' : bits === 24 ? 'pcm-s24' : 'pcm-s16' });
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();

  const frames = planes[0].length;
  const duration = frames / sampleRate;
  const block = sampleRate; // 1 second per chunk
  for (let start = 0; start < frames; start += block) {
    const len = Math.min(block, frames - start);
    const data = new Float32Array(len * planes.length);
    planes.forEach((p, c) => data.set(p.subarray(start, start + len), c * len));
    const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: planes.length, sampleRate, timestamp: start / sampleRate });
    await audio.add(sample);
    sample.close();

    const t = start / sampleRate;
    await video.add(t, Math.min(1, duration - t));
    onProgress(Math.min(1, (start + len) / frames));
    await yieldToUi();
  }

  await output.finalize();
  return new Blob([output.target.buffer!], { type: 'video/mp4' });
}

export async function exportRecording(
  rec: Recording,
  quality: Quality,
  format: FormatId,
  onProgress: (p: number) => void = () => {},
): Promise<Blob> {
  let rate = quality.sampleRate ?? rec.sampleRate;
  if (format === 'mp3' && !MP3_SAMPLE_RATES.includes(rate)) rate = 48000;
  const data = await convert(rec, rate, quality.channels);
  if (format === 'mp3') return encodeMp3(data, rate, quality.mp3Kbps, onProgress);
  if (format === 'mp4') return encodeMp4(data, rate, quality.wavBits, onProgress);
  return encodeWav(data, rate, quality.wavBits);
}
