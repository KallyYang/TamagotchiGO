var soundRegisters = {
  0x06: true,
  0x60: true,
  0x62: true,
  0x64: true,
  0x65: true,
};

function AudioOutput() {
  this.Context = window.AudioContext || window.webkitAudioContext;
  this.supported = Boolean(this.Context);
  this.enabled = false;
  this.context = null;
  this.master = null;
  this.fallbackAudioUrl = null;
  this.registers = {};
  this.keyFallbackTimer = null;
  this.lastSpuEventAt = -1;
  this.lastPulseAt = -1;
}

AudioOutput.prototype.toggle = function () {
  this.enabled = !this.enabled;

  if (this.enabled) {
    this.unlock(this.playTestPulse.bind(this));
  } else if (this.master) {
    this.master.gain.value = 0;
  }

  return this.enabled;
};

AudioOutput.prototype.unlock = function (ready) {
  var resumed,
    that = this;

  if (!this.supported) {
    return false;
  }

  if (!this.context) {
    this.context = new this.Context();
    this.master = this.context.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.context.destination);
  } else if (this.enabled && this.master) {
    this.master.gain.value = 0.22;
  }

  if (this.context.state === "suspended") {
    resumed = this.context.resume();
    if (ready && resumed && resumed.then) {
      resumed.then(function () {
        ready.call(that);
      });
    }
    return true;
  }

  if (ready) {
    ready.call(this);
  }

  return true;
};

AudioOutput.prototype.playTestPulse = function () {
  this.playTone(880, 0.22, 0.18);
  this.playTone(1320, 0.18, 0.16, 0.12);
  this.playFallbackPulse();
};

AudioOutput.prototype.playKey = function (code) {
  var that = this,
    frequency = {
      65: 1040,
      83: 1040,
      68: 1040,
    }[code];

  if (!this.enabled || !frequency) {
    return;
  }

  clearTimeout(this.keyFallbackTimer);
  this.keyFallbackTimer = setTimeout(function () {
    that.unlock(function () {
      if (this.currentTime() - this.lastSpuEventAt > 0.12) {
        this.playTone(frequency, 0.075, 0.16, 0, true);
      }
    });
  }, 90);
};

AudioOutput.prototype.write = function (addr, value) {
  var reg = addr & 0xff;

  if ((addr & 0xf000) !== 0x3000 || !soundRegisters[reg]) {
    return;
  }

  this.registers[reg] = value & 0xff;

  try {
    if (window.localStorage && window.localStorage.tamago_sound_debug === "1") {
      console.log(
        "[tamago sound]",
        "0x" + (0x3000 | reg).toString(16),
        "0x" + (0x100 | value).toString(16).substr(1)
      );
    }
  } catch (e) {}

  if (!this.enabled || !this.context || this.context.state === "closed") {
    return;
  }

  if (reg === 0x06 && (value & 0x01)) {
    this.playSpuEvent();
    return;
  }

  this.playPulse(reg, value & 0xff);
};

AudioOutput.prototype.playSpuEvent = function () {
  var pitch = this.registers[0x62],
    control = this.registers[0x64],
    length = this.registers[0x65],
    frequency = pitch ? 260 + (pitch & 0x7f) * 10 : 1040,
    duration = 0.08 + ((length || 1) & 0x0f) * 0.018;

  clearTimeout(this.keyFallbackTimer);
  this.lastSpuEventAt = this.currentTime();

  if (control & 0x80) {
    this.playBuzzer(frequency, duration, 0.17);
  } else {
    this.playBuzzer(frequency, duration, 0.12);
  }
};

AudioOutput.prototype.playBuzzer = function (frequency, duration, amplitude) {
  this.playTone(frequency, duration, amplitude, 0, true, "square", 0.0015);
};

AudioOutput.prototype.playPulse = function (reg, value, force) {
  var now = this.context.currentTime,
    pitch = this.registers[0x62] || this.registers[0x64] || value,
    volume = this.registers[0x60] || this.registers[0x06] || value,
    duration = 0.035 + ((this.registers[0x65] || value) & 0x0f) * 0.004,
    amplitude = 0.035 + (((volume || 1) & 0x0f) / 0x0f) * 0.055,
    frequency,
    oscillator,
    gain;

  if (!force && now - this.lastPulseAt < 0.028) {
    return;
  }

  if (!value && !pitch && !volume) {
    return;
  }

  frequency = 180 + ((pitch || 1) & 0x7f) * 14;
  frequency = Math.max(140, Math.min(2200, frequency));

  this.playTone(frequency, duration, amplitude, 0, force);
};

AudioOutput.prototype.currentTime = function () {
  if (this.context && this.context.state !== "closed") {
    return this.context.currentTime;
  }

  return +new Date() / 1000;
};

AudioOutput.prototype.playTone = function (
  frequency,
  duration,
  amplitude,
  delay,
  force,
  type,
  attack
) {
  var now,
    oscillator,
    gain;

  if (!this.context || this.context.state === "closed") {
    return;
  }

  now = this.context.currentTime + (delay || 0);

  if (!force && now - this.lastPulseAt < 0.028) {
    return;
  }

  oscillator = this.context.createOscillator();
  gain = this.context.createGain();

  oscillator.type = type || "square";
  oscillator.frequency.setValueAtTime(frequency, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(amplitude, now + (attack || 0.004));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  oscillator.connect(gain);
  gain.connect(this.master);

  oscillator.start(now);
  oscillator.stop(now + duration + 0.01);

  this.lastPulseAt = now;
};

AudioOutput.prototype.playFallbackPulse = function () {
  var player,
    played;

  if (!window.Audio || !window.Blob || !(window.URL || window.webkitURL)) {
    return;
  }

  if (!this.fallbackAudioUrl) {
    this.fallbackAudioUrl = createToneUrl(660, 0.22, 0.7);
  }

  player = new window.Audio(this.fallbackAudioUrl);
  player.volume = 0.9;
  played = player.play();
  if (played && played.catch) {
    played.catch(function () {});
  }
};

function createToneUrl(frequency, duration, amplitude) {
  var sampleRate = 22050,
    samples = Math.floor(sampleRate * duration),
    buffer = new ArrayBuffer(44 + samples * 2),
    view = new DataView(buffer),
    i,
    sample;

  function writeString(offset, value) {
    for (var s = 0; s < value.length; s++) {
      view.setUint8(offset + s, value.charCodeAt(s));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples * 2, true);

  for (i = 0; i < samples; i++) {
    sample = Math.sin((i / sampleRate) * frequency * Math.PI * 2);
    view.setInt16(44 + i * 2, sample * amplitude * 32767, true);
  }

  return (window.URL || window.webkitURL).createObjectURL(
    new window.Blob([buffer], { type: "audio/wav" })
  );
}

module.exports = {
  AudioOutput: AudioOutput,
};
