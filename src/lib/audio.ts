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
  { id: 'lossless', label: 'No loss', description: 'Original sample rate, stereo · WAV 32-bit float (bit-exact) / MP4 24-bit lossless / MP3 320 kbps', sampleRate: null, channels: 2, wavBits: 32, mp3Kbps: 320 },
];

export const FORMATS: { id: FormatId; label: string; lossless: boolean }[] = [
  { id: 'wav', label: 'WAV (uncompressed)', lossless: true },
  { id: 'mp3', label: 'MP3 (compressed)', lossless: false },
  { id: 'mp4', label: 'MP4 (video)', lossless: true },
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

const MAX_VIDEO_SIDE = 1920;

/** Decodes an image file (JPEG, PNG, WebP, GIF, AVIF, SVG…). Rejects if the browser can't read it. */
export async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('Image has no size');
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Video frame size: the image's own aspect ratio, longest side capped, even dimensions (required by H.264). */
function frameSize(img: HTMLImageElement | null): { width: number; height: number } {
  if (!img) return { width: 640, height: 360 };
  const scale = Math.min(1, MAX_VIDEO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(img.naturalWidth), height: even(img.naturalHeight) };
}

/**
 * MP4 with a still video track (black, or the given background image) and lossless FLAC audio
 * (same integer samples as the 16/24-bit WAV; 32-bit float sources become 24-bit, as FLAC has no float).
 * FLAC-in-MP4 plays in browsers and Windows Media Player, unlike raw PCM-in-MP4.
 */
async function encodeMp4(
  channels: Float32Array[],
  sampleRate: number,
  bits: 16 | 24 | 32,
  background: Blob | null,
  onProgress: (p: number) => void,
): Promise<Blob> {
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, EncodedAudioPacketSource, EncodedPacket, canEncodeVideo } = await import('mediabunny');
  const { encodeFlac } = await import('./flac');

  const flacBits = bits === 16 ? 16 : 24;
  const flac = await encodeFlac(toIntPcm(channels, flacBits), sampleRate, flacBits, (p) => onProgress(p * 0.8));

  const img = background ? await loadImage(background) : null;
  const { width, height } = frameSize(img);
  const videoCodec = (await canEncodeVideo('avc', { width, height })) ? 'avc' : 'vp9';
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000'; // also behind transparent images
  g.fillRect(0, 0, width, height);
  if (img) {
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, width, height);
  }

  // The picture never changes, so only key frames carry data: give them a generous budget.
  const bitrate = img ? Math.round(width * height * 4) : 50_000;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: videoCodec, bitrate, keyFrameInterval: 10 });
  const audio = new EncodedAudioPacketSource('flac');
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();

  const duration = channels[0].length / sampleRate;
  const meta = { decoderConfig: { codec: 'flac', numberOfChannels: channels.length, sampleRate, description: flac.description } };
  let next = 0;
  for (let t = 0; t < duration; t += 1) {
    for (; next < flac.frames.length && flac.frames[next].timestamp < t + 1; next++) {
      const f = flac.frames[next];
      await audio.add(new EncodedPacket(f.data, 'key', f.timestamp, f.duration), next === 0 ? meta : undefined);
    }
    await video.add(t, Math.min(1, duration - t));
    onProgress(0.8 + 0.2 * Math.min(1, (t + 1) / duration));
    await yieldToUi();
  }

  await output.finalize();
  const bytes = new Uint8Array(output.target.buffer!);
  setFlacSampleSize(bytes, flacBits);
  return new Blob([bytes], { type: 'video/mp4' });
}

/**
 * mediabunny always writes samplesize=16 in the 'fLaC' sample entry, but FLAC-in-ISOBMFF requires the
 * real bit depth there; Windows Media Foundation decodes 24-bit audio as 16-bit noise otherwise.
 */
function setFlacSampleSize(mp4: Uint8Array, bits: number) {
  const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
  // The moov box precedes mdat (fastStart), so the first 'fLaC' + 6 reserved zero bytes is the sample entry.
  for (let i = 4; i + 24 < mp4.length; i++) {
    if (mp4[i] === 0x66 && mp4[i + 1] === 0x4c && mp4[i + 2] === 0x61 && mp4[i + 3] === 0x43 && view.getUint32(i + 4) === 0 && view.getUint16(i + 8) === 0) {
      // type(4) reserved(6) data_ref_index(2) version(2) revision(2) vendor(4) channelcount(2) -> samplesize
      view.setUint16(i + 22, bits);
      return;
    }
  }
  throw new Error('FLAC sample entry not found in MP4');
}

export async function exportRecording(
  rec: Recording,
  quality: Quality,
  format: FormatId,
  onProgress: (p: number) => void = () => {},
  background: Blob | null = null,
): Promise<Blob> {
  let rate = quality.sampleRate ?? rec.sampleRate;
  if (format === 'mp3' && !MP3_SAMPLE_RATES.includes(rate)) rate = 48000;
  const data = await convert(rec, rate, quality.channels);
  if (format === 'mp3') return encodeMp3(data, rate, quality.mp3Kbps, onProgress);
  if (format === 'mp4') return encodeMp4(data, rate, quality.wavBits, background, onProgress);
  return encodeWav(data, rate, quality.wavBits);
}
