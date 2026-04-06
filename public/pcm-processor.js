class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._bufferSize = 4096; // 256ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0]; // mono, 128 samples per render quantum

    // Accumulate samples
    const newBuffer = new Float32Array(this._buffer.length + channel.length);
    newBuffer.set(this._buffer);
    newBuffer.set(channel, this._buffer.length);
    this._buffer = newBuffer;

    // Cap at 4x target to prevent memory leaks in long sessions
    if (this._buffer.length > this._bufferSize * 4) {
      this._buffer = this._buffer.slice(this._buffer.length - this._bufferSize);
    }

    // When we have enough, convert Float32 → Int16 and send
    while (this._buffer.length >= this._bufferSize) {
      const chunk = this._buffer.slice(0, this._bufferSize);
      this._buffer = this._buffer.slice(this._bufferSize);

      const int16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      this.port.postMessage(int16.buffer, [int16.buffer]);
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
