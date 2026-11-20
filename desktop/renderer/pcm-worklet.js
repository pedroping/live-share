// Audio worklet that plays 16-bit stereo PCM pushed from the main process.
// Wrapped in a function so js/audio.js can load it from a Blob URL (file:// pages
// cannot addModule() a file directly).
function pcmWorkletModule() {
  class PcmPlayer extends AudioWorkletProcessor {
    constructor() {
      super();
      this.capacity = sampleRate * 2; // 2s ring buffer per channel
      this.left = new Float32Array(this.capacity);
      this.right = new Float32Array(this.capacity);
      this.read = 0;
      this.write = 0;
      this.size = 0;
      this.started = false;
      this.target = Math.round(sampleRate * 0.06); // ~60ms latency
      this.max = Math.round(sampleRate * 0.25);
      this.port.onmessage = (e) => {
        if (e.data === 'reset') { this.read = this.write = this.size = 0; this.started = false; return; }
        this.push(new Int16Array(e.data));
      };
    }

    push(samples) {
      const frames = samples.length >> 1;
      for (let i = 0; i < frames; i++) {
        this.left[this.write] = samples[2 * i] / 32768;
        this.right[this.write] = samples[2 * i + 1] / 32768;
        this.write = (this.write + 1) % this.capacity;
      }
      this.size = Math.min(this.capacity, this.size + frames);
      if (this.size > this.max) {
        const drop = this.size - this.target;
        this.read = (this.read + drop) % this.capacity;
        this.size -= drop;
      }
    }

    process(_inputs, outputs) {
      const [outL, outR] = outputs[0];
      const n = outL.length;
      if (!this.started && this.size >= this.target) this.started = true;
      for (let i = 0; i < n; i++) {
        if (this.started && this.size > 0) {
          outL[i] = this.left[this.read];
          outR[i] = this.right[this.read];
          this.read = (this.read + 1) % this.capacity;
          this.size--;
        } else {
          outL[i] = 0;
          outR[i] = 0;
          if (this.size === 0) this.started = false; // rebuffer after underrun
        }
      }
      return true;
    }
  }

  registerProcessor('pcm-player', PcmPlayer);
}
