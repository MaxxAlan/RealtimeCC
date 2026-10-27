class Pcm16Processor extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.position = 0; this.output = []; this.chunkFrames = 1280; }
  process(inputs, outputs) {
    const channels = inputs[0];
    const input = channels?.[0];
    if (!input) return true;
    const mono = input.length === 0 ? input : new Float32Array(input.length);
    for (const channel of channels) for (let i = 0; i < channel.length; i++) mono[i] += channel[i] / channels.length;
    while (this.position < mono.length) {
      const i = Math.floor(this.position); const frac = this.position - i;
      const a = mono[i] || 0; const b = mono[Math.min(i + 1, mono.length - 1)] || 0;
      this.output.push(Math.max(-1, Math.min(1, a + (b - a) * frac)));
      this.position += this.ratio;
    }
    this.position -= mono.length;
    while (this.output.length >= this.chunkFrames) {
      const pcm = new Int16Array(this.chunkFrames);
      for (let i = 0; i < this.chunkFrames; i++) { const sample = this.output[i]; pcm[i] = sample < 0 ? sample * 32768 : sample * 32767; }
      this.output.splice(0, this.chunkFrames);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16Processor);
