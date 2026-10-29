// All sounds are made live with the Web Audio API; there are no sound files.
export class Sound {
  constructor() {
    this.ctx = null;
    this.side = 1;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(ctx.destination);

    // A loop of white noise, shaped into wind and snow hiss.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const loop = (type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start();
      return { f, g };
    };
    this.wind = loop('bandpass', 400, 0.6);
    this.hiss = loop('highpass', 2500, 0.5);
  }

  update(speed, carve, grounded) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, speed / 35);
    this.wind.g.gain.setTargetAtTime(s * s * 0.35, t, 0.15);
    this.wind.f.frequency.setTargetAtTime(250 + s * 900, t, 0.15);
    const h = grounded ? Math.min(1, speed / 15) * (0.05 + carve * 0.25) : 0;
    this.hiss.g.gain.setTargetAtTime(h, t, 0.05);
  }

  // The star "ding": two quick bright notes, panned left then right.
  star() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.side = -this.side;
    if (pan) { pan.pan.value = this.side * 0.6; pan.connect(this.master); }
    [[1568, 0], [2093, 0.06]].forEach(([freq, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(0.22, t + dt + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.35);
      o.connect(g); g.connect(pan || this.master);
      o.start(t + dt); o.stop(t + dt + 0.4);
    });
  }

  thump(strength = 1, pitch = 90) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(pitch * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(pitch * 0.5, t + 0.25);
    g.gain.setValueAtTime(0.5 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.32);
    this.burst(0.25 * strength, 0.2, 1200);
  }

  burst(vol, len, freq) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random()); src.stop(t + len + 0.05);
  }

  jump() { this.burst(0.18, 0.15, 3000); }
  land() { this.thump(0.6); }
  crash() { this.thump(1, 60); this.burst(0.5, 0.6, 900); }
  finish() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [523, 659, 784, 1047].forEach((freq, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t + i * 0.12);
      g.gain.linearRampToValueAtTime(0.2, t + i * 0.12 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.6);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.7);
    });
  }
}
