/**
 * PCM16 worklet: downsample to 16 kHz mono and emit fixed 80 ms frames (1280 samples).
 * Each message includes audioTime (AudioContext currentTime at the start of the chunk)
 * so the main process can keep relative timing consistent within a session.
 * Absolute alignment to external fixture playback still requires an external t_play0
 * (see docs/E2E_BENCHMARK.md).
 */
class Pcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.position = 0;
    this.output = [];
    this.chunkFrames = 1280; // 80 ms @ 16 kHz
    this.framesEmitted = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    const input = channels?.[0];
    if (!input) return true;

    const mono = new Float32Array(input.length);
    for (const channel of channels) {
      for (let i = 0; i < channel.length; i++) mono[i] += channel[i] / channels.length;
    }

    while (this.position < mono.length) {
      const i = Math.floor(this.position);
      const frac = this.position - i;
      const a = mono[i] || 0;
      const b = mono[Math.min(i + 1, mono.length - 1)] || 0;
      this.output.push(Math.max(-1, Math.min(1, a + (b - a) * frac)));
      this.position += this.ratio;
    }
    this.position -= mono.length;

    while (this.output.length >= this.chunkFrames) {
      const pcm = new Int16Array(this.chunkFrames);
      for (let i = 0; i < this.chunkFrames; i++) {
        const sample = this.output[i];
        pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
      }
      this.output.splice(0, this.chunkFrames);
      // audioTime: seconds since AudioContext creation, at the start of this chunk.
      // Convert to ms and pair with wall-clock in the renderer for diagnostics only.
      const audioTimeSec = currentTime - (this.chunkFrames / 16000);
      this.port.postMessage(
        { buffer: pcm.buffer, audioTimeSec, frameIndex: this.framesEmitted },
        [pcm.buffer]
      );
      this.framesEmitted += 1;
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16Processor);
