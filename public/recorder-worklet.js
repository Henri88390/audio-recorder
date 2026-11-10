// Copies raw PCM frames from the audio graph to the main thread (lossless capture).
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.recording = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (this.recording && input && input.length > 0) {
      const channels = input.map((ch) => ch.slice());
      this.port.postMessage(channels, channels.map((c) => c.buffer));
    }
    return this.recording;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
