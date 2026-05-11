var TRACKED_REGISTERS = {
  0x06: true,
  0x30: true,
  0x31: true,
  0x32: true,
  0x33: true,
  0x34: true,
  0x35: true,
  0x60: true,
  0x62: true,
  0x64: true,
  0x65: true,
  0x70: true,
  0x71: true,
  0x72: true,
  0x76: true,
  0xb0: true,
  0xb1: true,
  0xb2: true,
  0xb4: true,
  0xb5: true,
  0xb6: true,
  0xb7: true,
  0xba: true,
};

function RegisterLog(ports) {
  this.ports = ports || {};
  this.enabled = false;
  this.suppressed = false;
  this.entries = [];
  this.soundState = {};
  this.counts = {};
  this.total = 0;
  this.startedAt = +new Date();
  this.lastKey = "";
  this.renderTimer = null;
  this.button = null;
  this.panel = null;
  this.summary = null;
  this.lines = null;
}

RegisterLog.prototype.setSuppressed = function (suppressed) {
  this.suppressed = Boolean(suppressed);
};

RegisterLog.prototype.attach = function (elements) {
  var that = this;

  this.button = elements.button;
  this.panel = elements.panel;
  this.summary = elements.summary;
  this.lines = elements.lines;

  this.button.addEventListener("click", function () {
    that.toggle();
  });

  this.render();
};

RegisterLog.prototype.toggle = function () {
  this.enabled = !this.enabled;
  this.render();
  return this.enabled;
};

RegisterLog.prototype.write = function (addr, value) {
  var reg = addr & 0xff,
    mode = this.debugMode(),
    entry,
    key,
    soundEventName;

  if ((addr & 0xf000) !== 0x3000) {
    return;
  }

  if (this.suppressed) {
    return;
  }

  if (mode !== "all" && !TRACKED_REGISTERS[reg]) {
    return;
  }

  value &= 0xff;
  soundEventName = this.trackSoundState(reg, value);
  key = addr + ":" + value;
  this.total++;
  this.counts[addr] = (this.counts[addr] || 0) + 1;

  if (this.lastKey === key && this.entries.length) {
    entry = this.entries[this.entries.length - 1];
    entry.repeats++;
  } else {
    entry = {
      time: ((+new Date() - this.startedAt) / 1000).toFixed(3),
      addr: addr,
      value: value,
      name: soundEventName || (this.ports[addr] || {}).name || "",
      repeats: 1,
    };
    this.entries.push(entry);
    this.lastKey = key;
  }

  while (this.entries.length > 80) {
    this.entries.shift();
  }

  if (mode) {
    this.logToConsole(entry);
  }

  if (this.enabled) {
    this.scheduleRender();
  }
};

RegisterLog.prototype.spi = function (event) {
  var mode = this.debugMode(),
    message = formatSpiEvent(event),
    entry,
    key;

  if (!message) {
    return;
  }

  if (this.suppressed) {
    return;
  }

  key = "spi:" + message;
  this.total++;

  if (this.lastKey === key && this.entries.length) {
    entry = this.entries[this.entries.length - 1];
    entry.repeats++;
  } else {
    entry = {
      time: ((+new Date() - this.startedAt) / 1000).toFixed(3),
      message: message,
      repeats: 1,
    };
    this.entries.push(entry);
    this.lastKey = key;
  }

  while (this.entries.length > 80) {
    this.entries.shift();
  }

  if (mode) {
    this.logToConsole(entry);
  }

  if (this.enabled) {
    this.scheduleRender();
  }
};

RegisterLog.prototype.trackSoundState = function (reg, value) {
  var eventId;

  if (reg !== 0x06 && reg !== 0x60 && reg !== 0x62 && reg !== 0x64 && reg !== 0x65) {
    return;
  }

  this.soundState[reg] = value;

  if (reg !== 0x06 || !(value & 0x01)) {
    return "";
  }

  eventId = [
    this.soundState[0x64] || 0,
    this.soundState[0x60] || 0,
    this.soundState[0x62] || 0,
    this.soundState[0x65] || 0,
    value,
  ]
    .map(function (part) {
      return toHex(2, part);
    })
    .join(" ");

  return "SPU event " + eventId;
};

RegisterLog.prototype.debugMode = function () {
  try {
    return window.localStorage && window.localStorage.tamago_register_debug;
  } catch (e) {
    return "";
  }
};

RegisterLog.prototype.logToConsole = function (entry) {
  if (entry.message) {
    console.log("[tamago register]", entry.time + "s", entry.message);
    return;
  }

  console.log(
    "[tamago register]",
    entry.time + "s",
    toHex(4, entry.addr),
    toHex(2, entry.value),
    entry.name
  );
};

RegisterLog.prototype.scheduleRender = function () {
  var that = this;

  if (this.renderTimer) {
    return;
  }

  this.renderTimer = setTimeout(function () {
    that.renderTimer = null;
    that.render();
  }, 120);
};

RegisterLog.prototype.render = function () {
  var lines = [],
    i;

  if (this.button) {
    this.button.innerHTML = this.enabled ? "隐藏日志" : "寄存器日志";
    this.button.classList.toggle("is-active", this.enabled);
    this.button.setAttribute("aria-pressed", this.enabled ? "true" : "false");
  }

  if (this.panel) {
    this.panel.hidden = !this.enabled;
  }

  if (!this.enabled || !this.summary || !this.lines) {
    return;
  }

  this.summary.textContent = this.total
    ? "已捕获 " + this.total + " 次相关事件"
    : "等待相关寄存器或 SPI 事件";

  for (i = 0; i < this.entries.length; i++) {
    lines.push(formatEntry(this.entries[i]));
  }

  this.lines.textContent = lines.length ? lines.join("\n") : "按 A/B/C 或继续运行游戏后查看变化";
};

function formatEntry(entry) {
  if (entry.message) {
    return (
      entry.time +
      "s  " +
      entry.message +
      (entry.repeats > 1 ? "  x" + entry.repeats : "")
    );
  }

  return (
    entry.time +
    "s  " +
    toHex(4, entry.addr) +
    " = " +
    toHex(2, entry.value) +
    (entry.repeats > 1 ? "  x" + entry.repeats : "") +
    (entry.name ? "  " + entry.name : "")
  );
}

function formatSpiEvent(event) {
  if (!event || event.type !== "read" || !event.bytes) {
    return "";
  }

  return (
    "SPI read " +
    toHex(6, event.address) +
    " len " +
    event.bytes.length +
    " cmd " +
    toHex(2, event.command) +
    " -> " +
    formatBytes(event.bytes, 16)
  );
}

function formatBytes(bytes, max) {
  var parts = [],
    limit = Math.min(bytes.length, max),
    i;

  for (i = 0; i < limit; i++) {
    parts.push(toHex(2, bytes[i]).substr(2));
  }

  if (bytes.length > limit) {
    parts.push("...");
    parts.push("+" + (bytes.length - limit));
  }

  return parts.join(" ");
}

function toHex(width, value) {
  var hex = value.toString(16).toUpperCase();

  while (hex.length < width) {
    hex = "0" + hex;
  }

  return "0x" + hex;
}

module.exports = {
  RegisterLog: RegisterLog,
};
