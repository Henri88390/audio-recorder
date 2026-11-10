import { useEffect, useRef, useState } from 'react';
import {
  FORMATS,
  QUALITIES,
  concatChunks,
  exportRecording,
  type FormatId,
  type QualityId,
  type Recording,
} from './lib/audio';

type Source = 'system' | 'mic' | 'both';
type Status = 'idle' | 'recording' | 'stopped';

const SOURCES: { id: Source; label: string }[] = [
  { id: 'system', label: '🔊 Computer audio' },
  { id: 'mic', label: '🎤 Microphone' },
  { id: 'both', label: '🔊 + 🎤 Both' },
];

const RAW_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

interface Session {
  ctx: AudioContext;
  streams: MediaStream[];
  node: AudioWorkletNode;
  chunks: Float32Array[][];
}

const fmtTime = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const fmtSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;

/** Strips characters invalid in Windows/macOS/Linux file names and any extension the user typed. */
const sanitizeFileName = (name: string) =>
  name
    .trim()
    .replace(/\.(wav|mp3|mp4)$/i, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '');

export default function App() {
  const [source, setSource] = useState<Source>('system');
  const [qualityId, setQualityId] = useState<QualityId>('high');
  const [format, setFormat] = useState<FormatId>('mp3');
  const [status, setStatus] = useState<Status>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [exporting, setExporting] = useState<number | null>(null);
  const [download, setDownload] = useState<{ url: string; name: string; size: number } | null>(null);
  const [fileName, setFileName] = useState('');

  const session = useRef<Session | null>(null);
  const timers = useRef<{ raf: number; interval: number }>({ raf: 0, interval: 0 });

  const quality = QUALITIES.find((q) => q.id === qualityId)!;
  const effectiveFormat: FormatId = format;
  const baseName = sanitizeFileName(fileName) || 'recording';

  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);

  async function getStreams(): Promise<MediaStream[]> {
    const streams: MediaStream[] = [];
    try {
      if (source !== 'mic') {
        // Chrome/Edge require video to be requested; the video track is ignored.
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: RAW_CONSTRAINTS,
          systemAudio: 'include',
        } as DisplayMediaStreamOptions);
        if (display.getAudioTracks().length === 0) {
          display.getTracks().forEach((t) => t.stop());
          throw new Error(
            'No audio was shared. Pick "Entire screen" (or a tab) and enable "Share system audio" / "Share tab audio".',
          );
        }
        streams.push(display);
      }
      if (source !== 'system') {
        streams.push(await navigator.mediaDevices.getUserMedia({ audio: RAW_CONSTRAINTS }));
      }
      return streams;
    } catch (e) {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      throw e;
    }
  }

  async function start() {
    setError(null);
    setRecording(null);
    setDownload(null);
    try {
      const streams = await getStreams();
      const ctx = new AudioContext({ latencyHint: 'playback' });
      await ctx.audioWorklet.addModule('/recorder-worklet.js');

      const node = new AudioWorkletNode(ctx, 'recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      const chunks: Float32Array[][] = [[], []];
      node.port.onmessage = (e: MessageEvent<Float32Array[]>) => {
        e.data.forEach((ch, i) => i < 2 && chunks[i].push(ch));
      };

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      for (const stream of streams) {
        const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        src.connect(node);
        src.connect(analyser);
        // Stop when the user clicks the browser's "Stop sharing" button.
        stream.getTracks().forEach((t) => t.addEventListener('ended', () => stop()));
      }
      // Keep the graph pulling data without playing anything back (avoids feedback).
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);

      session.current = { ctx, streams, node, chunks };

      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        setLevel(peak);
        timers.current.raf = requestAnimationFrame(tick);
      };
      tick();
      const startedAt = performance.now();
      setElapsed(0);
      timers.current.interval = window.setInterval(() => setElapsed((performance.now() - startedAt) / 1000), 250);
      setStatus('recording');
    } catch (e) {
      if ((e as DOMException).name !== 'NotAllowedError') setError((e as Error).message);
      else setError('Permission denied or capture cancelled.');
    }
  }

  async function stopSession(): Promise<Recording | null> {
    const s = session.current;
    if (!s) return null;
    session.current = null;
    cancelAnimationFrame(timers.current.raf);
    clearInterval(timers.current.interval);
    s.node.port.postMessage('stop');
    s.streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
    const sampleRate = s.ctx.sampleRate;
    await s.ctx.close();
    if (s.chunks[0].length === 0) return null;
    return { sampleRate, channels: s.chunks.map(concatChunks) };
  }

  useEffect(() => () => void stopSession(), []);

  async function stop() {
    if (!session.current) return;
    const rec = await stopSession();
    setLevel(0);
    if (!rec) {
      setStatus('idle');
      return;
    }
    setRecording(rec);
    const stamp = new Date().toLocaleString('sv').replace(' ', '_').replace(/:/g, '-');
    setFileName(`recording-${stamp}`);
    setStatus('stopped');
  }

  async function handleDownload() {
    if (!recording) return;
    setExporting(0);
    setError(null);
    try {
      const blob = await exportRecording(recording, quality, effectiveFormat, setExporting);
      const name = `${baseName}.${effectiveFormat}`;
      const url = URL.createObjectURL(blob);
      setDownload({ url, name, size: blob.size });
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
    } catch (e) {
      setError(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(null);
    }
  }

  function reset() {
    setRecording(null);
    setDownload(null);
    setStatus('idle');
    setElapsed(0);
  }

  const supportsSystem = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const busy = status === 'recording';

  return (
    <main className="card">
      <h1>🎙️ Audio Recorder</h1>

      <section>
        <h2>1. Source</h2>
        <div className="segmented">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              className={source === s.id ? 'active' : ''}
              disabled={busy || (s.id !== 'mic' && !supportsSystem)}
              onClick={() => setSource(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {source !== 'mic' && (
          <p className="hint">
            When prompted, choose <b>Entire screen</b> (Windows) or a <b>tab</b> and tick <b>Share system/tab audio</b>.
            Works in Chrome / Edge.
          </p>
        )}
      </section>

      <section>
        <h2>2. Quality</h2>
        <div className="options">
          {QUALITIES.map((q) => (
            <label key={q.id} className={qualityId === q.id ? 'option active' : 'option'}>
              <input
                type="radio"
                name="quality"
                checked={qualityId === q.id}
                disabled={busy || exporting !== null}
                onChange={() => setQualityId(q.id)}
              />
              <span>
                <b>{q.label}</b>
                <small>{q.description}</small>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="controls">
        {status !== 'recording' ? (
          <button className="record" onClick={start} disabled={exporting !== null}>
            ● {status === 'stopped' ? 'New recording' : 'Start recording'}
          </button>
        ) : (
          <button className="stop" onClick={stop}>
            ■ Stop
          </button>
        )}
        <div className="timer">
          {busy && <span className="dot" />}
          {fmtTime(elapsed)}
        </div>
        <div className="meter">
          <div style={{ width: `${Math.min(100, level * 100)}%` }} />
        </div>
      </section>

      {status === 'stopped' && recording && (
        <section>
          <h2>3. Format &amp; download</h2>
          <p className="hint">
            Captured {fmtTime(recording.channels[0].length / recording.sampleRate)} at {recording.sampleRate / 1000} kHz.
          </p>
          <div className="segmented">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                className={effectiveFormat === f.id ? 'active' : ''}
                disabled={exporting !== null}
                onClick={() => setFormat(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {quality.id === 'lossless' && effectiveFormat === 'mp3' && (
            <p className="hint">
              MP3 is exported at its maximum quality (320 kbps, full stereo, original sample rate) — virtually
              indistinguishable by ear, but only WAV and MP4 are bit-exact.
            </p>
          )}
          {effectiveFormat === 'mp4' && (
            <p className="hint">
              Black 640×360 video with uncompressed PCM audio ({quality.wavBits === 32 ? '32-bit float' : `${quality.wavBits}-bit`}) —
              identical sound to the WAV. Plays in Chrome/Edge, VLC and ffmpeg-based players; some older players may not support PCM audio in MP4.
            </p>
          )}
          {download && <p className="hint">You can switch format and download again.</p>}
          <label className="filename">
            <span>File name</span>
            <span className="filename-input">
              <input
                type="text"
                value={fileName}
                placeholder="recording"
                spellCheck={false}
                disabled={exporting !== null}
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleDownload()}
              />
              <span className="ext">.{effectiveFormat}</span>
            </span>
          </label>
          <div className="row">
            <button className="primary" onClick={handleDownload} disabled={exporting !== null}>
              {exporting !== null ? `Encoding… ${Math.round(exporting * 100)}%` : `⬇ Download .${effectiveFormat}`}
            </button>
            <button onClick={reset} disabled={exporting !== null}>
              Discard
            </button>
          </div>
          {download && (
            <div className="result">
              <audio controls src={download.url} />
              <a href={download.url} download={download.name}>
                {download.name} ({fmtSize(download.size)})
              </a>
            </div>
          )}
        </section>
      )}

      {error && <p className="error">{error}</p>}
    </main>
  );
}
