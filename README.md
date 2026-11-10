# Audio Recorder

Small React + Vite app to record **computer (system) audio**, the **microphone**, or **both mixed**, then download the result.

- Quality presets: Low (22.05 kHz mono), Medium (44.1 kHz), High (48 kHz / 24-bit / 320 kbps), **No loss** (bit-exact 32-bit float WAV).
- Output options (format WAV / MP3 / MP4, MP4 background image, file name) can be set before, during or after recording. After stopping, download — a preview player is shown, and you can change the options and download again from the same recording.
- MP4 contains a still video track — black 640×360 by default, or a **background image** you pick (shown whole at its own aspect ratio, scaled to max 1920px) — and **uncompressed PCM audio**: the same samples as the WAV export (bit-exact 32-bit float for *No loss*). It plays in Chrome/Edge, VLC and ffmpeg-based players; some older players don't support PCM audio inside MP4.
- MP3 for *No loss* / *High* is encoded at the MP3 maximum (320 kbps CBR, full stereo, original sample rate). Integer conversion uses TPDF dither, and recordings that exceed full scale are scaled down instead of clipped.

```bash
npm install
npm run dev
```

## Notes

- System audio uses `getDisplayMedia` and works in **Chrome / Edge**. In the share dialog pick *Entire screen* (Windows) or a tab and enable *Share system/tab audio*. Firefox/Safari don't support capturing system audio — use the mic mode there.
- Audio is captured as raw PCM through an AudioWorklet (`public/recorder-worklet.js`) and only encoded on download, so quality/format can be applied losslessly. Raw capture uses ~23 MB per minute of RAM.
