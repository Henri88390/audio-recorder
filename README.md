# Audio Recorder

Audio Recorder is a browser-based app for recording **computer (system) audio**, your **microphone**, or **both mixed together**. Capture audio from a tab, narrate over computer audio, or record a voice note without installing desktop software.

Choose a quality preset, start and stop recording, then download as **WAV**, **MP3**, or **MP4 video** with a black background or an image of your choice. You can edit the file name and output options before, during, or after recording, preview the exported file, and download the same recording in multiple formats.

Recording and encoding happen locally in your browser: the app does not upload your audio to a server. Built with React, TypeScript, and Vite.

## Screenshots

### Recording options

Choose the audio source, quality, output format, and file name.

![Recording controls with computer audio selected, quality presets, and WAV, MP3, and MP4 output options](docs/screenshots/recording-options.png)

### MP4 export and preview

Choose a background image or keep the black background, then download and preview your video.

![Completed microphone recording with MP4 background options, an editable file name, a download button, and a video preview](docs/screenshots/mp4-download.png)

## Features

- Quality presets: Low (22.05 kHz mono), Medium (44.1 kHz), High (48 kHz / 24-bit / 320 kbps), **No loss** (bit-exact 32-bit float WAV).
- Output options (format WAV / MP3 / MP4, MP4 background image, file name) can be set before, during or after recording. After stopping, download — a preview player is shown, and you can change the options and download again from the same recording.
- MP4 contains a still video track — black 640×360 by default, or a **background image** you pick (shown whole at its own aspect ratio, scaled to max 1920px) — and **lossless FLAC audio**: the same 16/24-bit samples as the WAV export (*No loss* is stored as 24-bit, since FLAC has no float format — inaudible difference, ~144 dB dynamic range). It plays in Windows Media Player / Films & TV, Chrome/Edge, Firefox, VLC and ffmpeg-based players.
- MP3 for *No loss* / *High* is encoded at the MP3 maximum (320 kbps CBR, full stereo, original sample rate). Integer conversion uses TPDF dither, and recordings that exceed full scale are scaled down instead of clipped.

## Run locally

```bash
npm install
npm run dev
```

## Test on a phone with ngrok

[ngrok](https://ngrok.com/) creates a public HTTPS tunnel to the development server running on your computer. Open its forwarding URL on your phone to test the local app, including live code updates, without deploying it. HTTPS is required for microphone access on a phone; a plain `http://192.168...` network address is not sufficient.

### Setup (Windows)

1. Install ngrok in PowerShell, then reopen your terminal:

   ```powershell
   winget install --id Ngrok.Ngrok --exact
   ```

2. Create an ngrok account and copy your token from [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken). Configure it locally:

   ```powershell
   ngrok config add-authtoken YOUR_TOKEN
   ```

   Replace `YOUR_TOKEN` with your token. Keep it private: do not commit it or put it in the app.

### Start testing

1. From the project folder, start Vite in one terminal:

   ```powershell
   npm run dev -- --port 5173 --strictPort
   ```

   Check that `http://localhost:5173` opens on your computer.

2. In a second terminal, start the tunnel to the same port:

   ```powershell
   ngrok http 5173
   ```

3. Allow the forwarding **hostname** in `server.allowedHosts` in [vite.config.ts](./vite.config.ts). For example, if ngrok shows `https://your-name.ngrok-free.dev`:

   ```ts
   server: {
     allowedHosts: ['your-name.ngrok-free.dev'],
   },
   ```

   Replace the example with your actual hostname (no `https://` or path), retaining the existing plugins configuration. The config already contains the hostname used during development; update it if your tunnel hostname differs. Do not use `allowedHosts: true`, which disables host protection. Restart Vite if necessary.

4. Open ngrok's **HTTPS forwarding URL** on your phone, allow microphone access, and keep the page open with the screen unlocked. System audio capture generally is not available on mobile.

Keep both terminals running. The tunnel exposes your development app publicly; stop ngrok with **Ctrl+C** when finished. Audio recording and encoding still happen in the phone's browser, not on ngrok.

### Troubleshooting

- **Connection refused:** make sure Vite is running and the port in `ngrok http` matches Vite's port. Check the localhost URL on your computer first.
- **Blocked host / `server.allowedHosts`:** add the exact current forwarding hostname to the allowlist and restart Vite.
- **`navigator.mediaDevices` unavailable:** use the HTTPS forwarding URL in an up-to-date browser, rather than a plain HTTP network URL or an in-app browser.

## Notes

- **Mobile:** microphone recording works in supported, up-to-date mobile browsers over **HTTPS**. The app selects the microphone when screen capture is unavailable. Open the deployed HTTPS URL (not an `http://192.168...` development URL), allow microphone access, and keep the page foregrounded with the screen unlocked. System audio generally cannot be captured on mobile. WAV and MP3 export locally; MP4 export also requires browser video-encoding support, and playback support varies by device. Long recordings can exhaust a phone's memory.
- System audio uses `getDisplayMedia` and works in **Chrome / Edge**. In the share dialog pick *Entire screen* (Windows) or a tab and enable *Share system/tab audio*. Firefox/Safari don't support capturing system audio — use the mic mode there.
- Audio is captured as raw PCM through an AudioWorklet (`public/recorder-worklet.js`) and only encoded on download, so quality/format can be applied losslessly. Raw capture uses ~23 MB per minute of RAM.
