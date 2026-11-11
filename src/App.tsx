import { useEffect, useRef, useState } from "react";
import {
  FORMATS,
  QUALITIES,
  concatChunks,
  exportRecording,
  loadImage,
  type FormatId,
  type QualityId,
  type Recording,
} from "./lib/audio";

type Source = "system" | "mic" | "both";
type Status = "idle" | "starting" | "recording" | "stopped";

const SOURCES: { id: Source; label: string }[] = [
  { id: "system", label: "🔊 Computer audio" },
  { id: "mic", label: "🎤 Microphone" },
  { id: "both", label: "🔊 + 🎤 Both" },
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
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const fmtSize = (bytes: number) =>
  bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;

/** Strips characters invalid in Windows/macOS/Linux file names and any extension the user typed. */
const sanitizeFileName = (name: string) =>
  name
    .trim()
    .replace(/\.(wav|mp3|mp4)$/i, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "");

export default function App() {
  const supportsSystem =
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const captureError = !window.isSecureContext
    ? "Recording requires HTTPS. Open the secure deployed site; a phone cannot record from an http:// local network address."
    : typeof navigator.mediaDevices?.getUserMedia !== "function"
      ? "Microphone recording is not supported in this browser. Try a current Safari or Chrome browser instead of an in-app browser."
      : typeof AudioContext === "undefined" ||
          typeof AudioWorkletNode === "undefined"
        ? "This browser does not support audio recording. Update your browser and try again."
        : null;
  const [source, setSource] = useState<Source>(
    supportsSystem ? "system" : "mic",
  );
  const [qualityId, setQualityId] = useState<QualityId>("high");
  const [format, setFormat] = useState<FormatId>("mp3");
  const [status, setStatus] = useState<Status>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [exporting, setExporting] = useState<number | null>(null);
  const [download, setDownload] = useState<{
    url: string;
    name: string;
    size: number;
  } | null>(null);
  const [fileName, setFileName] = useState("");
  const autoName = useRef("");
  const [background, setBackground] = useState<{
    file: File;
    url: string;
    width: number;
    height: number;
  } | null>(null);

  const session = useRef<Session | null>(null);
  const timers = useRef<{ raf: number; interval: number }>({
    raf: 0,
    interval: 0,
  });

  const quality = QUALITIES.find((q) => q.id === qualityId)!;
  const effectiveFormat: FormatId = format;
  const baseName = sanitizeFileName(fileName) || "recording";

  useEffect(
    () => () => {
      if (download) URL.revokeObjectURL(download.url);
    },
    [download],
  );
  useEffect(
    () => () => {
      if (background) URL.revokeObjectURL(background.url);
    },
    [background],
  );

  async function pickBackground(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const img = await loadImage(file);
      setBackground({
        file,
        url: URL.createObjectURL(file),
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    } catch {
      setError(
        `“${file.name}” can't be used as an image. Try a JPEG, PNG or WebP file.`,
      );
    }
  }

  async function getStreams(): Promise<MediaStream[]> {
    if (captureError) throw new Error(captureError);
    if (source !== "mic" && !supportsSystem)
      throw new Error(
        "System audio capture is unavailable. Select Microphone.",
      );
    const streams: MediaStream[] = [];
    try {
      if (source !== "mic") {
        // Chrome/Edge require video to be requested; the video track is ignored.
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: RAW_CONSTRAINTS,
          systemAudio: "include",
        } as DisplayMediaStreamOptions);
        if (display.getAudioTracks().length === 0) {
          display.getTracks().forEach((t) => t.stop());
          throw new Error(
            'No audio was shared. Pick "Entire screen" (or a tab) and enable "Share system audio" / "Share tab audio".',
          );
        }
        streams.push(display);
      }
      if (source !== "system") {
        streams.push(
          await navigator.mediaDevices.getUserMedia({ audio: RAW_CONSTRAINTS }),
        );
      }
      return streams;
    } catch (e) {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      throw e;
    }
  }

  async function start() {
    if (session.current || status === "starting") return;
    if (captureError) {
      setError(captureError);
      return;
    }
    setError(null);
    setStatus("starting");
    setRecording(null);
    setDownload(null);
    let ctx: AudioContext | null = null;
    let streams: MediaStream[] = [];
    try {
      ctx = new AudioContext({ latencyHint: "playback" });
      // Unlock audio while the tap still has user activation (required on mobile).
      const resumed = ctx.resume();
      const captured = getStreams();
      const results = await Promise.allSettled([resumed, captured]);
      if (results[1].status === "fulfilled") streams = results[1].value;
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
      await ctx.audioWorklet.addModule("/recorder-worklet.js");

      const node = new AudioWorkletNode(ctx, "recorder-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: "explicit",
      });
      const chunks: Float32Array[][] = [[], []];
      node.port.onmessage = (e: MessageEvent<Float32Array[]>) => {
        e.data.forEach((ch, i) => i < 2 && chunks[i].push(ch));
      };

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      for (const stream of streams) {
        const src = ctx.createMediaStreamSource(
          new MediaStream(stream.getAudioTracks()),
        );
        src.connect(node);
        src.connect(analyser);
        // Stop when the user clicks the browser's "Stop sharing" button.
        stream
          .getTracks()
          .forEach((t) => t.addEventListener("ended", () => stop()));
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
      timers.current.interval = window.setInterval(
        () => setElapsed((performance.now() - startedAt) / 1000),
        250,
      );
      setStatus("recording");
    } catch (e) {
      streams.forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop()),
      );
      if (ctx && ctx.state !== "closed") await ctx.close();
      setStatus("idle");
      if ((e as DOMException).name !== "NotAllowedError")
        setError((e as Error).message);
      else setError("Permission denied or capture cancelled.");
    }
  }

  async function stopSession(): Promise<Recording | null> {
    const s = session.current;
    if (!s) return null;
    session.current = null;
    cancelAnimationFrame(timers.current.raf);
    clearInterval(timers.current.interval);
    s.node.port.postMessage("stop");
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
      setStatus("idle");
      return;
    }
    setRecording(rec);
    const stamp = new Date()
      .toLocaleString("sv")
      .replace(" ", "_")
      .replace(/:/g, "-");
    const newAuto = `recording-${stamp}`;
    // Keep a name the user typed (before or during recording); only refresh the automatic one.
    // Functional update + ref: stop() may run from a stale closure (browser "Stop sharing").
    const prevAuto = autoName.current;
    setFileName((cur) =>
      cur.trim() === "" || cur === prevAuto ? newAuto : cur,
    );
    autoName.current = newAuto;
    setStatus("stopped");
  }

  async function handleDownload() {
    if (!recording) return;
    setExporting(0);
    setError(null);
    try {
      const blob = await exportRecording(
        recording,
        quality,
        effectiveFormat,
        setExporting,
        background?.file ?? null,
      );
      const name = `${baseName}.${effectiveFormat}`;
      const url = URL.createObjectURL(blob);
      setDownload({ url, name, size: blob.size });
      const a = document.createElement("a");
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
    setStatus("idle");
    setElapsed(0);
  }

  const busy = status === "recording" || status === "starting";

  return (
    <main className="card">
      xDDDD
      <h1>🎙️ Audio Recorder</h1>
      <section>
        <h2>1. Source</h2>
        <div className="segmented">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              className={source === s.id ? "active" : ""}
              disabled={busy || (s.id !== "mic" && !supportsSystem)}
              onClick={() => setSource(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {source !== "mic" && (
          <p className="hint">
            When prompted, choose <b>Entire screen</b> (Windows) or a <b>tab</b>{" "}
            and tick <b>Share system/tab audio</b>. Works in Chrome / Edge.
          </p>
        )}
        {!supportsSystem && (
          <p className="hint">
            Microphone recording is available on supported mobile browsers over
            HTTPS. System audio capture requires a supported desktop browser.
            Keep this page open and your screen unlocked while recording.
          </p>
        )}
        {captureError && (
          <p className="error" role="alert">
            {captureError}
          </p>
        )}
      </section>
      <section>
        <h2>2. Quality</h2>
        <div className="options">
          {QUALITIES.map((q) => (
            <label
              key={q.id}
              className={qualityId === q.id ? "option active" : "option"}
            >
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
      <section>
        <h2>3. Output</h2>
        <div className="segmented">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={effectiveFormat === f.id ? "active" : ""}
              disabled={exporting !== null}
              onClick={() => setFormat(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {quality.id === "lossless" && effectiveFormat === "mp3" && (
          <p className="hint">
            MP3 is exported at its maximum quality (320 kbps, full stereo,
            original sample rate) — virtually indistinguishable by ear, but only
            WAV and MP4 are bit-exact.
          </p>
        )}
        {effectiveFormat === "mp4" && (
          <>
            <div className="background">
              <span className="field-label">Background image</span>
              <div className="background-row">
                <div className="thumb">
                  {background ? (
                    <img src={background.url} alt="Selected background" />
                  ) : (
                    <span>Black</span>
                  )}
                </div>
                <div className="background-info">
                  <span className="background-name">
                    {background
                      ? `${background.file.name} (${background.width}×${background.height})`
                      : "No image — black 640×360 video"}
                  </span>
                  <div className="row tight">
                    <label
                      className={`button${exporting !== null ? " disabled" : ""}`}
                    >
                      {background ? "Change image…" : "Choose image…"}
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        disabled={exporting !== null}
                        onChange={(e) => {
                          void pickBackground(e.target.files?.[0]);
                          e.target.value = ""; // allow re-picking the same file
                        }}
                      />
                    </label>
                    {background && (
                      <button
                        onClick={() => setBackground(null)}
                        disabled={exporting !== null}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {background && (
                <p className="hint">
                  The whole image is shown at its own aspect ratio (scaled down
                  to max 1920px).
                </p>
              )}
            </div>
          </>
        )}
        <label className="filename">
          <span>File name</span>
          <span className="filename-input">
            <input
              type="text"
              value={fileName}
              placeholder="Automatic: recording-date_time"
              spellCheck={false}
              disabled={exporting !== null}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleDownload()}
            />
            <span className="ext">.{effectiveFormat}</span>
          </span>
        </label>
      </section>
      <section className="controls">
        {status !== "recording" ? (
          <button
            className="record"
            onClick={start}
            disabled={
              exporting !== null || status === "starting" || !!captureError
            }
          >
            ●{" "}
            {status === "starting"
              ? "Starting…"
              : status === "stopped"
                ? "New recording"
                : "Start recording"}
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
      {status === "stopped" && recording && (
        <section>
          <h2>4. Download</h2>
          <p className="hint">
            Captured{" "}
            {fmtTime(recording.channels[0].length / recording.sampleRate)} at{" "}
            {recording.sampleRate / 1000} kHz
            {download &&
              " — you can change the output options above and download again"}
            .
          </p>
          <div className="row">
            <button
              className="primary"
              onClick={handleDownload}
              disabled={exporting !== null}
            >
              {exporting !== null
                ? `Encoding… ${Math.round(exporting * 100)}%`
                : `⬇ Download .${effectiveFormat}`}
            </button>
            <button onClick={reset} disabled={exporting !== null}>
              Discard
            </button>
          </div>
          {download && (
            <div className="result">
              {download.name.endsWith(".mp4") ? (
                <video controls playsInline src={download.url} />
              ) : (
                <audio controls src={download.url} />
              )}
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
