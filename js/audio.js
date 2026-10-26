// Sonification with the Web Audio API. Every rhythm is a continuous "voice" whose
// loudness, brightness or pitch follows one data value. Earthquakes are struck bells.
// All pitches sit in D major pentatonic so the layers never clash.

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

function noiseBuffer(ctx, seconds, color = 'white') {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
  }
  return buf;
}

function reverbImpulse(ctx, seconds = 4) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

export class Sonifier {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.volume = 0.7;
  }

  async start() {
    if (!this.ctx) this.build();
    await this.ctx.resume();
    this.running = true;
    this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.5);
  }

  stop() {
    if (!this.ctx) return;
    this.running = false;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    setTimeout(() => { if (!this.running) this.ctx.suspend(); }, 1200);
  }

  setVolume(v) {
    this.volume = v;
    if (this.ctx && this.running) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  build() {
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);

    // Shared reverb gives everything one acoustic "room".
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = reverbImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    this.reverb.connect(wet).connect(this.master);

    const voiceOut = (sendAmt = 0.5) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.master);
      const send = ctx.createGain();
      send.gain.value = sendAmt;
      g.connect(send).connect(this.reverb);
      return g;
    };
    const osc = (type, freq, dest, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = freq; o.detune.value = detune;
      o.connect(dest); o.start();
      return o;
    };
    const white = noiseBuffer(ctx, 4, 'white');
    const brown = noiseBuffer(ctx, 6, 'brown');
    const loop = (buf, dest) => {
      const s = ctx.createBufferSource();
      s.buffer = buf; s.loop = true; s.connect(dest); s.start();
      return s;
    };

    // --- Sun: a bright open chord by day, a low drone by night.
    this.dayGain = voiceOut(0.6);
    this.dayFilter = ctx.createBiquadFilter();
    this.dayFilter.type = 'lowpass';
    this.dayFilter.frequency.value = 800;
    this.dayFilter.connect(this.dayGain);
    [293.66, 440, 587.33, 739.99].forEach((f, i) => osc(i % 2 ? 'triangle' : 'sine', f, this.dayFilter, i * 3 - 4));

    this.nightGain = voiceOut(0.7);
    const nightFilter = ctx.createBiquadFilter();
    nightFilter.type = 'lowpass';
    nightFilter.frequency.value = 420;
    nightFilter.connect(this.nightGain);
    [73.42, 110, 146.83, 164.81].forEach((f, i) => osc('sawtooth', f, nightFilter, i * 4 - 6));

    // --- Wind: filtered air whose pitch rises with speed, panned with direction.
    this.windGain = voiceOut(0.3);
    this.windPan = ctx.createStereoPanner();
    this.windPan.connect(this.windGain);
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 1.2;
    this.windFilter.frequency.value = 400;
    this.windFilter.connect(this.windPan);
    loop(white, this.windFilter);
    // Gusts: slow random wobble on the filter
    const gustLfo = ctx.createOscillator();
    gustLfo.frequency.value = 0.13;
    this.gustDepth = ctx.createGain();
    this.gustDepth.gain.value = 0;
    gustLfo.connect(this.gustDepth).connect(this.windFilter.frequency);
    gustLfo.start();

    // --- Tide: a deep ocean wash that swells as the water rises.
    this.tideGain = voiceOut(0.4);
    this.tideFilter = ctx.createBiquadFilter();
    this.tideFilter.type = 'lowpass';
    this.tideFilter.frequency.value = 300;
    this.tideFilter.connect(this.tideGain);
    loop(brown, this.tideFilter);
    // Wave-break pulse ~ every 9 s
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.11;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 220;
    swell.connect(swellDepth).connect(this.tideFilter.frequency);
    swell.start();
    this.tideSub = ctx.createGain();
    this.tideSub.gain.value = 0;
    this.tideSub.connect(this.tideGain);
    this.tideSubOsc = osc('sine', 55, this.tideSub);

    // --- Moon: a high glassy shimmer, louder the fuller and higher the moon.
    this.moonGain = voiceOut(0.9);
    const moonTrem = ctx.createGain();
    moonTrem.gain.value = 0.7;
    moonTrem.connect(this.moonGain);
    [1174.66, 1760, 2349.32].forEach((f, i) => osc('sine', f, moonTrem, i * 5));
    const tremLfo = ctx.createOscillator();
    tremLfo.frequency.value = 0.25;
    const tremDepth = ctx.createGain();
    tremDepth.gain.value = 0.3;
    tremLfo.connect(tremDepth).connect(moonTrem.gain);
    tremLfo.start();

    // --- Aurora (Kp): wavering, chorused tones that appear in geomagnetic storms.
    this.auroraGain = voiceOut(0.9);
    const auroraFilter = ctx.createBiquadFilter();
    auroraFilter.type = 'bandpass';
    auroraFilter.Q.value = 4;
    auroraFilter.frequency.value = 900;
    auroraFilter.connect(this.auroraGain);
    [493.88, 659.25, 987.77].forEach((f) => {
      const o = osc('sawtooth', f, auroraFilter);
      const vib = ctx.createOscillator();
      vib.frequency.value = 0.15 + Math.random() * 0.3;
      const vd = ctx.createGain();
      vd.gain.value = 18;
      vib.connect(vd).connect(o.detune);
      vib.start();
    });
    const sweep = ctx.createOscillator();
    sweep.frequency.value = 0.05;
    const sweepDepth = ctx.createGain();
    sweepDepth.gain.value = 500;
    sweep.connect(sweepDepth).connect(auroraFilter.frequency);
    sweep.start();

    // Quake bells feed this bus
    this.quakeBus = voiceOut(0.8);
    this.quakeBus.gain.value = 1;
  }

  // Called a few times per second with the current values at the listening point.
  update(s) {
    if (!this.ctx || !this.running) return;
    const now = this.ctx.currentTime;
    const tc = 0.4;
    const on = (id) => s.sound[id];

    // Sun: day ↔ night crossfade through twilight (-12° to +8°)
    const day = smooth(-12, 8, s.sunAlt);
    const dn = on('daynight') ? 1 : 0;
    this.dayGain.gain.setTargetAtTime(0.06 * day * dn, now, tc);
    this.nightGain.gain.setTargetAtTime(0.035 * (1 - day) * dn, now, tc);
    this.dayFilter.frequency.setTargetAtTime(400 + 3200 * clamp(Math.sin((Math.max(0, s.sunAlt) * Math.PI) / 180)), now, tc);

    // Wind
    const ws = s.windSpeed ?? 0;
    const windLevel = Math.pow(clamp(ws / 18), 0.8);
    this.windGain.gain.setTargetAtTime(on('wind') ? 0.02 + 0.22 * windLevel : 0, now, tc);
    this.windFilter.frequency.setTargetAtTime(180 + ws * 55, now, tc);
    this.gustDepth.gain.setTargetAtTime(40 + (s.gust ?? ws) * 25, now, tc);
    if (s.windDir != null) {
      const u = -Math.sin((s.windDir * Math.PI) / 180); // + when blowing toward the east
      this.windPan.pan.setTargetAtTime(clamp(u * 0.7, -1, 1), now, tc);
    }

    // Tide (0 = low water, 1 = high water)
    if (s.tideNorm != null && on('tides')) {
      this.tideGain.gain.setTargetAtTime(0.08 + 0.32 * s.tideNorm, now, tc);
      this.tideFilter.frequency.setTargetAtTime(160 + 900 * s.tideNorm, now, tc);
      this.tideSub.gain.setTargetAtTime(0.15 * s.tideNorm, now, tc);
      this.tideSubOsc.frequency.setTargetAtTime(s.tideRising ? 55 : 49, now, 2);
    } else this.tideGain.gain.setTargetAtTime(0, now, tc);

    // Moon
    const moonUp = smooth(-4, 10, s.moonAlt);
    this.moonGain.gain.setTargetAtTime(on('moon') ? 0.012 * (0.15 + s.moonFraction) * (0.25 + 0.75 * moonUp) : 0, now, tc);

    // Aurora: silent below Kp 3, full by Kp 7
    const k = s.kp == null ? 0 : smooth(2.5, 7, s.kp);
    this.auroraGain.gain.setTargetAtTime(on('aurora') ? 0.02 * k : 0, now, tc);
  }

  // Strike a bell for an earthquake. Bigger quakes ring lower, longer and louder.
  quake(mag, lon) {
    if (!this.ctx || !this.running) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const m = clamp((mag - 2.5) / 5);
    const scale = [880, 739.99, 587.33, 493.88, 440, 369.99, 293.66, 246.94, 220, 146.83, 110, 73.42];
    const base = scale[Math.round(m * (scale.length - 1))];
    const dur = 1.5 + m * 6;
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(lon / 180, -1, 1) * 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.05 + 0.25 * m, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    g.connect(pan).connect(this.quakeBus);
    [1, 2.76, 5.4, 8.93].forEach((ratio, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = base * ratio;
      const pg = ctx.createGain();
      pg.gain.value = 1 / (i * 1.8 + 1);
      o.connect(pg).connect(g);
      o.start(now);
      o.stop(now + dur + 0.1);
    });
  }
}
