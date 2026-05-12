var config = require("./config.js"),
  audio = require("./audio.js"),
  offlineCatchup = require("./offline_catchup.js"),
  registerLog = require("./register_log.js"),
  tamagotchi = require("./cpu/tamagotchi.js"),
  disassemble = require("./cpu/disassembler.js"),
  ports = require("./data/ports.js"),
  object = require("../util/object.js"),
  mainTemplate = require("../templates/main.html"),
  portTemplate = require("../templates/port.html");

var FRAME_MS = 1000 / 60,
  UI_BUTTON_MIN_PRESS_MS = 90,
  CATCHUP_BUDGET_MS = offlineCatchup.DEFAULT_EXACT_BUDGET_MS,
  CATCHUP_BENCHMARK_FRAMES = 90,
  CATCHUP_CHUNK_TARGET_MS = 18,
  RUNTIME_STORAGE_KEY = "tamago_runtime_resume_v1",
  CATCHUP_IDLE = "idle",
  CATCHUP_RUNNING = "running",
  CATCHUP_APPROXIMATE = "approximate_applied",
  CATCHUP_SKIPPED = "skipped_over_budget",
  CATCHUP_FAILED = "restore_failed",
  BUILTIN_FIGURES = {
    1: {
      type: "builtin",
      value: 1,
      insertedFigure: 1,
      label: "Makiko",
      file: "files/makiko.bin",
    },
    2: {
      type: "builtin",
      value: 2,
      insertedFigure: 2,
      label: "Shimashimatchi",
      file: "files/shimashimatchi.bin",
    },
  };

function getBinary(path, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", path, true);
  xhr.responseType = "arraybuffer";
  xhr.send();

  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) {
      return;
    }

    if (xhr.status !== 200) {
      throw new Error("Could not download " + path);
    }

    cb(xhr.response);
  };
}

function toHex(w, i) {
  i = i.toString(16).toUpperCase();

  var zeros = "0";
  while (zeros.length < w) {
    zeros += zeros;
  }

  return zeros.substr(0, w).substr(i.length) + i;
}

function getStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch (e) {}

  return null;
}

function cloneFigureSource(source) {
  return JSON.parse(JSON.stringify(source || { type: "none" }));
}

function normalizeFigureSource(source) {
  if (!source || source.type === "none") {
    return { type: "none", value: 0, insertedFigure: 0, label: "" };
  }

  if (source.type === "builtin") {
    return {
      type: "builtin",
      value: Number(source.value) || 0,
      insertedFigure: Number(source.insertedFigure) || Number(source.value) || 0,
      label: source.label || "",
      file: source.file || "",
    };
  }

  return {
    type: "custom",
    value: 3,
    insertedFigure: Number(source.insertedFigure) || 1,
    label: source.label || "自定义芯片",
    name: source.name || "",
  };
}

function formatDuration(ms) {
  var totalSeconds = Math.max(0, Math.round(ms / 1000)),
    hours,
    minutes,
    seconds,
    parts = [];

  hours = Math.floor(totalSeconds / 3600);
  minutes = Math.floor((totalSeconds % 3600) / 60);
  seconds = totalSeconds % 60;

  if (hours) {
    parts.push(hours + " 小时");
  }
  if (minutes) {
    parts.push(minutes + " 分");
  }
  if (!parts.length || seconds) {
    parts.push(seconds + " 秒");
  }

  return parts.join("");
}

function readRuntimeResume() {
  var store = getStorage(),
    raw,
    parsed;

  if (!store) {
    return null;
  }

  try {
    raw = store.getItem(RUNTIME_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.format !== "tamago-runtime-meta-v1" ||
      parsed.snapshotVersion !== "tamago-runtime-v1" ||
      !parsed.snapshot
    ) {
      return null;
    }

    return parsed;
  } catch (e) {
    return null;
  }
}

function writeRuntimeResume(payload) {
  var store = getStorage();

  if (!store) {
    return false;
  }

  store.setItem(RUNTIME_STORAGE_KEY, JSON.stringify(payload));
  return true;
}

function clearRuntimeResume() {
  var store = getStorage();

  if (!store) {
    return;
  }

  store.removeItem(RUNTIME_STORAGE_KEY);
}

function start(bios) {
  getBinary("files/tamago.bin", function (bios) {
    tamagotchi.system.prototype.bios = bios;

    [].forEach.call(document.querySelectorAll("tamago"), function (elem) {
      new Tamago(elem);
    });
  });
}

function Tamago(element) {
  var that = this;

  this.element = element;
  this.isDebugger = Boolean(element.attributes.debugger);
  this.system = new tamagotchi.system();
  this.audio = new audio.AudioOutput();
  this.registerLog = new registerLog.RegisterLog(ports);
  this.figureSource = normalizeFigureSource();
  this.running = false;
  this.frameHandle = null;
  this.figureLoadToken = 0;
  this.autoStartTimer = null;
  this.boundFrame = this.onAnimationFrame.bind(this);
  this.catchupState = CATCHUP_IDLE;
  this.catchupJob = null;
  this.runtimeResume = {
    suspendedAtMs: 0,
    wasRunning: false,
  };

  this.system.add_write_hook(this.audio.write.bind(this.audio));
  this.system.add_write_hook(this.registerLog.write.bind(this.registerLog));
  this.system.add_spi_event_hook(this.registerLog.spi.bind(this.registerLog));

  this.configure(element);
  this.bindAudioUnlock(element);

  this._pixeldata = this.body.display.getImageData(0, 0, 64, 31);
  this._pixels = new Uint32Array(this._pixeldata.data.buffer);
  this._disasmOffset = 0;

  document.addEventListener("keyup", function (e) {
    if (that.inputBlocked()) {
      that.releaseKeys();
      return;
    }
    that.system.keys |= that.mapping[e.keyCode] || 0;
  });

  document.addEventListener("keydown", function (e) {
    if (that.inputBlocked()) {
      that.releaseKeys();
      return;
    }
    if (that.audio.enabled) {
      that.audio.unlock();
    }
    if (!e.repeat) {
      that.audio.playKey(e.keyCode);
    }
    that.system.keys &= ~that.mapping[e.keyCode] || 0xff;
  });

  window.addEventListener("pagehide", function () {
    that.handlePageHide();
  });

  if (!this.isDebugger) {
    document.addEventListener("visibilitychange", function () {
      that.handleVisibilityChange();
    });

    window.addEventListener("pageshow", function () {
      if (!document.hidden && that.runtimeResume.suspendedAtMs) {
        that.resumeFromBackground();
      }
    });
  }

  [].forEach.call(element.querySelectorAll(".user-keys button"), function (btn) {
    var code = Number(btn.dataset.key),
      pressed = false,
      pressedAtMs = 0,
      releaseTimer = null,
      usesPointerEvents = typeof window !== "undefined" && typeof window.PointerEvent === "function";

    function clearReleaseTimer() {
      if (!releaseTimer) {
        return;
      }

      clearTimeout(releaseTimer);
      releaseTimer = null;
    }

    function syncPressedState(active) {
      btn.classList.toggle("is-pressed", active);
    }

    function preventDefaultIfPossible(event) {
      if (event && event.cancelable) {
        event.preventDefault();
      }
    }

    function finishRelease(event) {
      pressed = false;
      releaseTimer = null;
      that.system.keys |= that.mapping[code] || 0;
      syncPressedState(false);

      if (event && event.pointerId != null && btn.releasePointerCapture) {
        try {
          btn.releasePointerCapture(event.pointerId);
        } catch (e) {}
      }
    }

    function handleKeyDown(event) {
      preventDefaultIfPossible(event);
      clearReleaseTimer();

      if (pressed || that.inputBlocked()) {
        return;
      }

      pressed = true;
      pressedAtMs = +new Date();

      if (that.audio.enabled) {
        that.audio.unlock();
      }

      that.audio.playKey(code);
      that.system.keys &= ~(that.mapping[code] || 0);
      syncPressedState(true);

      if (event && event.pointerId != null && btn.setPointerCapture) {
        try {
          btn.setPointerCapture(event.pointerId);
        } catch (e) {}
      }
    }

    function handleKeyUp(event) {
      var remaining;

      preventDefaultIfPossible(event);

      if (!pressed) {
        return;
      }

      remaining = UI_BUTTON_MIN_PRESS_MS - (+new Date() - pressedAtMs);

      if (remaining > 0) {
        clearReleaseTimer();
        releaseTimer = setTimeout(function () {
          finishRelease();
        }, remaining);
        return;
      }

      finishRelease(event);
    }

    if (usesPointerEvents) {
      btn.addEventListener("pointerdown", handleKeyDown);
      btn.addEventListener("pointerup", handleKeyUp);
      btn.addEventListener("pointercancel", handleKeyUp);
      btn.addEventListener("pointerleave", handleKeyUp);
      return;
    }

    btn.addEventListener("mousedown", handleKeyDown);
    btn.addEventListener("mouseup", handleKeyUp);
    btn.addEventListener("mouseleave", handleKeyUp);
    btn.addEventListener("touchstart", handleKeyDown);
    btn.addEventListener("touchend", handleKeyUp);
    btn.addEventListener("touchcancel", handleKeyUp);
  });

  this.refreshFigureLabel();
  this.refresh();

  if (!this.isDebugger) {
    this.bootstrapRuntime();
  }
}

Tamago.prototype.mapping = { 65: 1, 83: 2, 68: 4, 82: 8 };

Tamago.prototype.inputBlocked = function () {
  return this.catchupState === CATCHUP_RUNNING;
};

Tamago.prototype.releaseKeys = function () {
  this.system.keys = 0x0f;
};

Tamago.prototype.refreshFigureLabel = function () {
  var source = this.figureSource,
    label = "";

  if (source.type === "builtin") {
    label = (source.label || "芯片") + " inserted";
  } else if (source.type === "custom") {
    label = (source.name || source.label || "自定义芯片") + " inserted";
  }

  this.body.figure.innerHTML = label;

  if (!this.body.figureSelect) {
    return;
  }

  if (source.type === "builtin") {
    this.body.figureSelect.value = String(source.value || 0);
  } else if (source.type === "custom") {
    this.body.figureSelect.value = "3";
  } else {
    this.body.figureSelect.value = "0";
  }

  if (this.body.speedSelect) {
    this.body.speedSelect.value = String(this.system.speed_multiplier || 1);
  }
};

Tamago.prototype.refreshRunButton = function (target) {
  if (target && target.attributes && target.attributes.value) {
    target.attributes.value.value = this.running ? "stop" : "run";
  }
  if (this.body.runButton) {
    this.body.runButton.value = this.running ? "stop" : "run";
  }
};

Tamago.prototype.setControlsDisabled = function (disabled) {
  (this.body.controls || []).forEach(function (control) {
    control.disabled = disabled;
  });
};

Tamago.prototype.setCatchupStatus = function (message, state) {
  this.catchupState = state || CATCHUP_IDLE;
  if (this.body.catchupStatus) {
    this.body.catchupStatus.textContent = message || "";
    this.body.catchupStatus.hidden = !message;
  }
};

Tamago.prototype.updateCatchupOverlay = function (job) {
  var progress = 0,
    totalFrames = 0,
    totalTimeMs = 0,
    elapsedMs,
    processedTimeMs,
    remainingMs,
    estimateFramesPerMs;

  if (
    !this.body.catchupOverlay ||
    !this.body.catchupProgressFill ||
    !this.body.catchupProgressLabel ||
    !this.body.catchupElapsed ||
    !this.body.catchupRemaining
  ) {
    return;
  }

  if (!job || this.catchupState !== CATCHUP_RUNNING) {
    this.body.catchupOverlay.hidden = true;
    this.element.classList.remove("is-catchup-running");
    return;
  }

  totalFrames = Math.max(0, job.totalFrames || 0);
  totalTimeMs = totalFrames * FRAME_MS;
  progress = totalFrames ? Math.min(1, job.processedFrames / totalFrames) : 1;
  elapsedMs = Math.max(1, +new Date() - job.startedAtMs);
  processedTimeMs = job.processedFrames * FRAME_MS;
  estimateFramesPerMs = Math.max(job.framesPerMs, job.processedFrames / elapsedMs || 0.001);
  remainingMs = Math.max(0, (totalFrames - job.processedFrames) / estimateFramesPerMs);

  this.body.catchupOverlay.hidden = false;
  this.element.classList.add("is-catchup-running");
  this.body.catchupProgressFill.style.width = Math.round(progress * 100) + "%";
  this.body.catchupProgressLabel.textContent = Math.round(progress * 100) + "%";

  if (job.mode === "approximate") {
    this.body.catchupElapsed.textContent =
      "快速恢复：已精确追赶 " +
      formatDuration(processedTimeMs) +
      " / " +
      formatDuration(totalTimeMs) +
      "，压缩 " +
      formatDuration(job.skippedMs);
    this.body.catchupRemaining.textContent =
      "预计剩余 " +
      formatDuration(remainingMs) +
      "，离线总时长 " +
      formatDuration(job.deltaMs);
    return;
  }

  this.body.catchupElapsed.textContent =
    "已追赶 " + formatDuration(processedTimeMs) + " / " + formatDuration(totalTimeMs);
  this.body.catchupRemaining.textContent = "预计剩余 " + formatDuration(remainingMs);
};

Tamago.prototype.loadFigureSource = function (source, options, done) {
  var that = this,
    loadToken,
    figureInfo;

  if (typeof options === "function") {
    done = options;
    options = {};
  }

  options || (options = {});
  done || (done = function () {});
  source = normalizeFigureSource(source);
  loadToken = ++this.figureLoadToken;
  this.figureSource = source;

  if (source.type === "none") {
    this.system.inserted_figure = 0;
    this.system.insert_figure(null);
    this.refreshFigureLabel();
    done(true);
    return;
  }

  if (source.type === "custom") {
    if (options.data) {
      this.system.inserted_figure = source.insertedFigure || 1;
      this.system.insert_figure(options.data);
      this.refreshFigureLabel();
      done(true);
      return;
    }

    if (this.system.spi_rom) {
      this.system.inserted_figure = source.insertedFigure || this.system.inserted_figure || 1;
      this.refreshFigureLabel();
      done(true);
      return;
    }

    this.system.inserted_figure = 0;
    this.system.insert_figure(null);
    if (this.body.figure) {
      this.body.figure.innerHTML = "拖入芯片文件";
    }
    done(false);
    return;
  }

  figureInfo = BUILTIN_FIGURES[source.value];
  if (!figureInfo) {
    this.system.inserted_figure = 0;
    this.system.insert_figure(null);
    this.figureSource = normalizeFigureSource();
    this.refreshFigureLabel();
    done(false);
    return;
  }

  this.figureSource = normalizeFigureSource(figureInfo);

  if (options.data) {
    this.system.inserted_figure = figureInfo.insertedFigure;
    this.system.insert_figure(options.data);
    this.refreshFigureLabel();
    done(true);
    return;
  }

  this.body.figure.innerHTML = "正在读取 " + figureInfo.label + "...";
  getBinary(figureInfo.file, function (data) {
    if (that.figureLoadToken !== loadToken) {
      return;
    }

    that.system.inserted_figure = figureInfo.insertedFigure;
    that.system.insert_figure(data);
    that.figureSource = normalizeFigureSource(figureInfo);
    that.refreshFigureLabel();
    done(true, data);
  });
};

Tamago.prototype.captureRuntimePayload = function (lastRealTimeMs) {
  return {
    format: "tamago-runtime-meta-v1",
    snapshotVersion: "tamago-runtime-v1",
    savedAtMs: +new Date(),
    lastRealTimeMs: lastRealTimeMs || +new Date(),
    running: Boolean(this.running || this.catchupState === CATCHUP_RUNNING || this.runtimeResume.wasRunning),
    figureSource: cloneFigureSource(this.figureSource),
    snapshot: this.system.export_state({
      includeSpiRom: this.figureSource.type === "custom",
    }),
  };
};

Tamago.prototype.persistRuntimeState = function (lastRealTimeMs) {
  var payload;

  if (this.isDebugger) {
    return false;
  }

  payload = this.captureRuntimePayload(lastRealTimeMs);

  try {
    if (writeRuntimeResume(payload)) {
      return true;
    }
  } catch (error) {
  }

  clearRuntimeResume();
  if (this.figureSource.type === "custom") {
    this.setCatchupStatus(
      "自定义芯片当前只能保证切后台补时，关闭页面后可能无法恢复运行态。",
      this.catchupState === CATCHUP_RUNNING ? CATCHUP_RUNNING : CATCHUP_FAILED
    );
  }
  return false;
};

Tamago.prototype.queueAutoStart = function () {
  var that = this;

  clearTimeout(this.autoStartTimer);
  this.autoStartTimer = setTimeout(function () {
    if (!that.running && that.catchupState !== CATCHUP_RUNNING) {
      that.startRunning();
    }
  }, 10);
};

Tamago.prototype.bootstrapRuntime = function () {
  var payload = readRuntimeResume(),
    that = this;

  if (!payload) {
    this.queueAutoStart();
    return;
  }

  this.restoreRuntimePayload(payload, function (restored, running, lastRealTimeMs) {
    var deltaMs;

    if (!restored) {
      that.queueAutoStart();
      return;
    }

    if (!running) {
      that.refresh();
      that.queueAutoStart();
      return;
    }

    deltaMs = Math.max(0, +new Date() - lastRealTimeMs);
    if (deltaMs <= 0) {
      that.startRunning();
      return;
    }

    that.beginCatchup(deltaMs, {
      resumeRunning: true,
      baseRealTimeMs: lastRealTimeMs,
    });
  });
};

Tamago.prototype.restoreRuntimePayload = function (payload, done) {
  var that = this,
    source = normalizeFigureSource(payload.figureSource),
    needsBuiltinData =
      source.type === "builtin" &&
      payload.snapshot &&
      payload.snapshot.figure &&
      !payload.snapshot.figure.rom;

  function applyImportedState(figureData) {
    var imported = that.system.import_state(payload.snapshot, {
      figureData: figureData,
    });

    if (!imported) {
      clearRuntimeResume();
      that.setCatchupStatus("上次运行态恢复失败，已重新启动。", CATCHUP_FAILED);
      done(false);
      return;
    }

    that.figureSource = source;
    that.releaseKeys();
    that.refreshFigureLabel();
    that.refresh();
    done(true, Boolean(payload.running), Number(payload.lastRealTimeMs) || +new Date());
  }

  if (!needsBuiltinData) {
    applyImportedState(null);
    return;
  }

  getBinary(source.file, function (data) {
    applyImportedState(data);
  });
};

Tamago.prototype.handlePageHide = function () {
  if (this.system && this.system._eeprom) {
    this.system._eeprom.save();
  }

  if (this.isDebugger) {
    return;
  }

  this.releaseKeys();
  this.runtimeResume.suspendedAtMs = +new Date();
  this.runtimeResume.wasRunning = Boolean(this.running || this.catchupState === CATCHUP_RUNNING);
  this.persistRuntimeState(this.runtimeResume.suspendedAtMs);
  this.stopRunning();
};

Tamago.prototype.handleVisibilityChange = function () {
  if (this.isDebugger) {
    return;
  }

  if (document.hidden) {
    this.releaseKeys();
    this.runtimeResume.suspendedAtMs = +new Date();
    this.runtimeResume.wasRunning = Boolean(this.running || this.catchupState === CATCHUP_RUNNING);
    this.persistRuntimeState(this.runtimeResume.suspendedAtMs);
    this.stopRunning();
    return;
  }

  this.resumeFromBackground();
};

Tamago.prototype.resumeFromBackground = function () {
  var deltaMs;

  if (this.catchupState === CATCHUP_RUNNING || !this.runtimeResume.suspendedAtMs) {
    return;
  }

  deltaMs = Math.max(0, +new Date() - this.runtimeResume.suspendedAtMs);
  this.runtimeResume.suspendedAtMs = 0;

  if (!this.runtimeResume.wasRunning) {
    return;
  }

  if (!deltaMs) {
    this.startRunning();
    return;
  }

  this.beginCatchup(deltaMs, {
    resumeRunning: true,
    baseRealTimeMs: +new Date() - deltaMs,
  });
};

Tamago.prototype.estimateCatchup = function (snapshot, totalFrames) {
  var probe = new tamagotchi.system(),
    benchmarkFrames = Math.max(15, Math.min(CATCHUP_BENCHMARK_FRAMES, totalFrames)),
    startedAtMs,
    elapsedMs,
    framesPerMs;

  if (!probe.import_state(snapshot)) {
    return null;
  }

  startedAtMs = +new Date();
  probe.run_virtual_frames(benchmarkFrames);
  elapsedMs = Math.max(1, +new Date() - startedAtMs);
  framesPerMs = benchmarkFrames / elapsedMs;

  return {
    framesPerMs: framesPerMs,
    estimatedMs: totalFrames / framesPerMs,
  };
};

Tamago.prototype.beginCatchup = function (deltaMs, options) {
  var totalFrames,
    snapshot,
    estimate,
    plan;

  options || (options = {});
  totalFrames = Math.max(1, Math.round(deltaMs / FRAME_MS));
  snapshot = this.system.export_state({
    includeSpiRom: true,
  });
  estimate = this.estimateCatchup(snapshot, totalFrames);

  if (!estimate || !isFinite(estimate.estimatedMs)) {
    this.failCatchup("补时预估失败，已跳过本次离线追赶。", options.resumeRunning);
    return;
  }

  plan = offlineCatchup.buildCatchupPlan({
    deltaMs: deltaMs,
    frameMs: FRAME_MS,
    framesPerMs: estimate.framesPerMs,
    exactBudgetMs: CATCHUP_BUDGET_MS,
  });

  if (!plan || !plan.exactFrames || !isFinite(plan.exactEstimatedMs)) {
    this.skipCatchup(deltaMs, estimate.estimatedMs, options.resumeRunning);
    return;
  }

  this.stopRunning();
  this.releaseKeys();
  this.setControlsDisabled(true);
  this.audio.setSuppressed(true);
  this.registerLog.setSuppressed(true);
  this.setCatchupStatus("", CATCHUP_RUNNING);
  this.catchupJob = {
    mode: plan.mode,
    deltaMs: plan.deltaMs,
    totalFrames: plan.exactFrames,
    offlineFrames: plan.totalFrames,
    processedFrames: 0,
    framesPerMs: Math.max(estimate.framesPerMs, 0.001),
    resumeRunning: Boolean(options.resumeRunning),
    startedAtMs: +new Date(),
    exactMs: plan.exactMs,
    exactEstimatedMs: plan.exactEstimatedMs,
    skippedMs: plan.skippedMs,
    fullEstimatedMs: plan.estimatedMs,
  };
  this.updateCatchupOverlay(this.catchupJob);
  this.pumpCatchup();
};

Tamago.prototype.pumpCatchup = function () {
  var that = this,
    job = this.catchupJob,
    chunkFrames;

  if (!job) {
    return;
  }

  chunkFrames = Math.max(4, Math.round(job.framesPerMs * CATCHUP_CHUNK_TARGET_MS));
  chunkFrames = Math.min(chunkFrames, job.totalFrames - job.processedFrames);

  this.system.run_virtual_frames(chunkFrames);
  job.processedFrames += chunkFrames;
  this.refresh();
  this.updateCatchupOverlay(job);

  if (job.processedFrames >= job.totalFrames) {
    this.finishCatchup();
    return;
  }

  setTimeout(function () {
    that.pumpCatchup();
  }, 0);
};

Tamago.prototype.finishCatchup = function () {
  var job = this.catchupJob,
    resumeRunning = job && job.resumeRunning,
    message = "补时完成，已恢复当前运行态。",
    state = CATCHUP_IDLE;

  this.catchupJob = null;
  this.audio.setSuppressed(false);
  this.registerLog.setSuppressed(false);
  this.setControlsDisabled(false);
  this.system.previous_clock = +new Date() / 1000;
  this.releaseKeys();
  this.updateCatchupOverlay(null);

  if (job && job.mode === "approximate" && job.skippedMs > 0) {
    message =
      "离线 " +
      formatDuration(job.deltaMs) +
      " 已进入快速恢复：精确追赶最近 " +
      formatDuration(job.exactMs) +
      "，较早的 " +
      formatDuration(job.skippedMs) +
      " 未完整回放。";
    state = CATCHUP_APPROXIMATE;
  }

  this.setCatchupStatus(message, state);
  this.persistRuntimeState(+new Date());
  this.refresh();

  if (resumeRunning) {
    this.startRunning();
  }
};

Tamago.prototype.skipCatchup = function (deltaMs, estimatedMs, resumeRunning) {
  this.catchupJob = null;
  this.audio.setSuppressed(false);
  this.registerLog.setSuppressed(false);
  this.setControlsDisabled(false);
  this.updateCatchupOverlay(null);
  this.system.previous_clock = +new Date() / 1000;
  this.releaseKeys();
  this.setCatchupStatus(
    "离线 " +
      formatDuration(deltaMs) +
      " 需要约 " +
      formatDuration(estimatedMs) +
      " 才能完整补时，当前版本已跳过这次追赶。",
    CATCHUP_SKIPPED
  );
  this.persistRuntimeState(+new Date());
  this.refresh();

  if (resumeRunning) {
    this.startRunning();
  }
};

Tamago.prototype.failCatchup = function (message, resumeRunning) {
  this.catchupJob = null;
  this.audio.setSuppressed(false);
  this.registerLog.setSuppressed(false);
  this.setControlsDisabled(false);
  this.updateCatchupOverlay(null);
  this.system.previous_clock = +new Date() / 1000;
  this.releaseKeys();
  this.setCatchupStatus(message, CATCHUP_FAILED);
  this.refresh();

  if (resumeRunning) {
    this.startRunning();
  }
};

Tamago.prototype.bindAudioUnlock = function (element) {
  var that = this,
    listeners = [],
    active = true;

  if (!this.audio.supported) {
    return;
  }

  function removeListeners() {
    if (!active) {
      return;
    }

    active = false;
    listeners.forEach(function (listener) {
      listener.node.removeEventListener(listener.type, attemptUnlock, true);
    });
  }

  function attemptUnlock() {
    if (!active || !that.audio.enabled || that.inputBlocked()) {
      return;
    }

    that.audio.unlock(removeListeners);
  }

  function addListener(node, type) {
    node.addEventListener(type, attemptUnlock, true);
    listeners.push({ node: node, type: type });
  }

  ["pointerdown", "touchstart", "mousedown", "click"].forEach(function (type) {
    addListener(element, type);
  });
  addListener(document, "keydown");
};

Tamago.prototype.onAnimationFrame = function () {
  this.frameHandle = null;

  if (!this.running || this.catchupState === CATCHUP_RUNNING) {
    return;
  }

  this.system.step_realtime();
  this.refresh();
  this.scheduleFrame();
};

Tamago.prototype.scheduleFrame = function () {
  if (!this.running || this.frameHandle || this.catchupState === CATCHUP_RUNNING) {
    return;
  }

  this.frameHandle = requestAnimationFrame(this.boundFrame);
};

Tamago.prototype.setRunning = function (running, trigger) {
  running = Boolean(running);

  if (this.running === running) {
    this.refreshRunButton(trigger);
    return;
  }

  this.running = running;
  if (!this.running && this.frameHandle) {
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  if (this.running) {
    this.system.previous_clock = +new Date() / 1000;
    this.scheduleFrame();
  }

  this.refreshRunButton(trigger);
};

Tamago.prototype.startRunning = function () {
  this.setRunning(true);
};

Tamago.prototype.stopRunning = function () {
  this.setRunning(false);
};

Tamago.prototype.step = function () {
  this.system.step();
  this.refresh();
};

Tamago.prototype.irq = function () {
  this.system.fire_irq(parseInt(this.body.selects.irq.value, 10));
  this.refresh();
};

Tamago.prototype.nmi = function () {
  this.system.fire_nmi(6);
  this.refresh();
};

Tamago.prototype.run = function (e) {
  this.setRunning(!this.running, e && e.target);
};

Tamago.prototype.reset = function () {
  this.system.reset();
  this.releaseKeys();
  this.runtimeResume.suspendedAtMs = 0;
  this.runtimeResume.wasRunning = this.running;
  this.refreshFigureLabel();
  this.refresh();
  this.persistRuntimeState(+new Date());
};

Tamago.prototype.refresh_simple = function () {
  var lcd = this.system.get_lcd_state
      ? this.system.get_lcd_state()
      : { enabled: true, rows: 31, columns: 64 },
    background = this.system.PALETTE[0],
    a = 4,
    b = 0,
    g = 0;

  while (g < 10) {
    var glyph = lcd.enabled ? (this.system._dram[a] >> b) & 3 : 0;
    if ((b -= 2) < 0) {
      b = 6;
      a++;
    }

    this.body.glyphs[g++].style.color =
      "#" + (this.system.PALETTE[glyph] & 0xffffff).toString(16);
  }

  var px = 0;
  for (var y = 0; y < 31; y++) {
    a = this.system.LCD_ORDER[y];
    var rowActive = lcd.enabled && y < lcd.rows;

    for (var x = 0; x < 64; x += 4) {
      var d = rowActive ? this.system._dram[a++] : 0;
      b = 6;

      while (b >= 0) {
        var column = x + ((6 - b) >> 1);
        this._pixels[px++] =
          rowActive && column < lcd.columns
            ? this.system.PALETTE[(d >> b) & 3]
            : background;
        b -= 2;
      }
    }
  }

  this.body.display.putImageData(this._pixeldata, 0, 0);
};

Tamago.prototype.drop = function (evt) {
  var files,
    binary,
    reader,
    that = this;

  evt.stopPropagation();
  evt.preventDefault();

  if (this.inputBlocked()) {
    return;
  }

  files = evt.dataTransfer.files;
  binary = files[0];

  if (!binary) {
    return;
  }

  reader = new FileReader();
  reader.onload = function (e) {
    that.loadFigureSource(
      {
        type: "custom",
        value: 3,
        insertedFigure: 1,
        label: "自定义芯片",
        name: binary.name,
      },
      { data: e.target.result },
      function () {
        that.persistRuntimeState(+new Date());
      }
    );
  };
  reader.readAsArrayBuffer(binary);
};

Tamago.prototype.export_save = function () {
  var payload = this.system._eeprom.export_data(),
    blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
      type: "application/json",
    }),
    url = (window.URL || window.webkitURL).createObjectURL(blob),
    link = document.createElement("a");

  link.href = url;
  link.download = "tamago-eeprom-save.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(function () {
    (window.URL || window.webkitURL).revokeObjectURL(url);
  }, 0);
};

Tamago.prototype.import_save = function (file) {
  var reader = new FileReader(),
    that = this;

  reader.onload = function (e) {
    if (that.system._eeprom.import_data(e.target.result)) {
      that.system.reset();
      that.releaseKeys();
      that.runtimeResume.suspendedAtMs = 0;
      that.runtimeResume.wasRunning = that.running;
      that.setCatchupStatus("存档已导入，运行态已重载。", CATCHUP_IDLE);
      that.refreshFigureLabel();
      that.system.previous_clock = +new Date() / 1000;
      that.refresh();
      that.persistRuntimeState(+new Date());
      return;
    }

    that.setCatchupStatus("存档无法读取。", CATCHUP_FAILED);
  };

  reader.readAsText(file);
};

Tamago.prototype.update_control = function (e) {
  if (e) {
    this._debug_port = parseInt(e.target.dataset.address);
  }

  var port = ports[this._debug_port];
  if (!port) {
    port = {
      name: "Unknown",
      description: "",
    };
  }
  if (!port.fields) {
    port.fields = [{ name: "data", start: 0, length: 8 }];
  }

  port = Object.create(port);
  port.address = this._debug_port.toString(16);

  if (port.address.length < 2) port.address = "0" + port.address;

  this.body.port.innerHTML = portTemplate(port);
  this.body.fields = this.body.port.querySelectorAll("field");

  this.refresh_port();
};

Tamago.prototype.refresh_port = function () {
  var d = this.system.read(this._debug_port, true);

  function pad(s, l) {
    return "00000000".substr(0, l).substr(s.length) + s;
  }

  [].forEach.call(this.body.fields, function (f) {
    var l = Number(f.dataset.length),
      s = Number(f.dataset.start),
      m = (d >> s) & ((1 << l) - 1),
      b = f.querySelector("bin"),
      h = f.querySelector("hex");

    b.innerHTML = pad(m.toString(2), l);
    h.innerHTML = pad(m.toString(16), Math.ceil(l / 4));
  });
};

Tamago.prototype.refresh_debugger = function () {
  var that = this;

  object.each(this.body.registers, function (elem, register) {
    elem.innerHTML = toHex(2, that.system[register]);
  });

  object.each(this.body.flags, function (elem, flag) {
    elem.classList.toggle("active", Boolean(that.system[flag]));
  });

  this.body.memory.forEach(function (m, i) {
    m.innerHTML = toHex(2, that.system._wram[i]);
  });

  this.body.control.forEach(function (m, i) {
    var acc = that.system._cpuacc[i + 0x3000];
    that.system._cpuacc[i + 0x3000] = 0;
    m.classList.toggle("read", acc & tamagotchi.ACCESS_READ);
    m.classList.toggle("write", acc & tamagotchi.ACCESS_WRITE);
    m.innerHTML = toHex(2, that.system._cpureg[i]);
  });

  var disasm = disassemble.disassemble(
      config.instructionCount,
      this._disasmOffset,
      this.system
    ),
    bias = Math.floor(config.instructionCount / 2),
    current = disasm.reduce(function (acc, d, i) {
      return d.active ? i : acc;
    }, null);

  if (current === null) {
    this._disasmOffset = this.system.pc;
    disasm = disassemble.disassemble(
      config.instructionCount,
      this._disasmOffset,
      this.system
    );
  } else if (current >= bias && disasm.length == config.instructionCount) {
    this._disasmOffset = disasm[current - bias].location;
    disasm = disassemble.disassemble(
      config.instructionCount,
      this._disasmOffset,
      this.system
    );
  }

  disasm.forEach(function (g, i) {
    var row = that.body.instructions[i];

    row.location.innerHTML = toHex(4, g.location);
    row.opcode.innerHTML = g.instruction;
    row.addressing.innerHTML = (g.data === null ? "" : g.data)
      .toString(16)
      .toUpperCase();
    row.data.innerHTML = g.bytes;

    function attr(node, attr, value) {
      if (value !== undefined) {
        node.setAttribute(attr, value);
      } else {
        node.removeAttribute(attr);
      }
    }

    row.instruction.classList.toggle("active", g.active === true);
    attr(row.addressing, "mode", g.mode);
    attr(
      row.addressing,
      "address",
      (g.address || 0).toString(16).toUpperCase()
    );
    attr(row.instruction, "port", g.port);
  });

  for (var i = disasm.length; i < config.instructionCount; i++) {
    var row = that.body.instructions[i];

    row.location.innerHTML = "";
    row.opcode.innerHTML = "";
    row.addressing.innerHTML = "";
    row.data.innerHTML = "";
    row.addressing.removeAttribute("mode");
  }

  this.refresh_port();
  this.refresh_simple();
};

Tamago.prototype.configure = function (element) {
  var data = Object.create(config),
    that = this;

  data.toHex = toHex;
  data.ramBytes = this.system._wram.length;
  data.registerBytes = this.system._cpureg.length;
  data.debug = this.isDebugger;

  element.innerHTML = mainTemplate(data);

  this.body = {
    glyphs: element.querySelectorAll(".glyph"),
    display: element.querySelector("display canvas").getContext("2d"),
    figure: element.querySelector("display figure"),
    figureSelect: element.querySelector("select[action=figure]"),
    speedSelect: element.querySelector("select[action=speed]"),
    catchupStatus: element.querySelector(".catchup-status"),
    catchupOverlay: element.querySelector(".catchup-overlay"),
    catchupProgressFill: element.querySelector(".catchup-progress-fill"),
    catchupProgressLabel: element.querySelector(".catchup-progress-label"),
    catchupElapsed: element.querySelector(".catchup-elapsed"),
    catchupRemaining: element.querySelector(".catchup-remaining"),
  };

  this.body.controls = [].slice.call(
    element.querySelectorAll("select, button, input[type=file], input[type=button]")
  );

  if (this.body.figureSelect) {
    this.body.figureSelect.addEventListener("change", function (e) {
      var figure = Number(e.target.value),
        source;

      if (that.inputBlocked()) {
        return;
      }

      if (!figure) {
        source = normalizeFigureSource();
      } else if (BUILTIN_FIGURES[figure]) {
        source = cloneFigureSource(BUILTIN_FIGURES[figure]);
      } else {
        source = normalizeFigureSource({
          type: "custom",
          label: "自定义芯片",
          value: 3,
          insertedFigure: 1,
        });
      }

      if (!figure) {
        that.loadFigureSource(source, function () {
          that.persistRuntimeState(+new Date());
        });
        return;
      }

      if (source.type === "builtin") {
        that.loadFigureSource(source, function () {
          that.persistRuntimeState(+new Date());
        });
        return;
      }

      that.loadFigureSource(source, function () {
        that.persistRuntimeState(+new Date());
      });
    });
  }

  if (this.body.speedSelect) {
    this.body.speedSelect.addEventListener("change", function (e) {
      that.system.speed_multiplier = Number(e.target.value) || 1;
      that.system.previous_clock = +new Date() / 1000;
      that.system.cycles = 0;
      that.persistRuntimeState(+new Date());
    });
  }

  var soundButton = element.querySelector("button[action=sound]");
  if (soundButton) {
    function refreshSoundButton() {
      soundButton.innerHTML = that.audio.enabled ? "关闭声音" : "开启声音";
      soundButton.classList.toggle("is-active", that.audio.enabled);
      soundButton.setAttribute("aria-pressed", that.audio.enabled ? "true" : "false");
    }

    if (!this.audio.supported) {
      soundButton.innerHTML = "声音不可用";
      soundButton.disabled = true;
    } else {
      refreshSoundButton();
      soundButton.addEventListener("click", function () {
        that.audio.toggle();
        refreshSoundButton();
      });
    }
  }

  var registerLogButton = element.querySelector("button[action=register-log]"),
    registerLogPanel = element.querySelector(".register-log");
  if (registerLogButton && registerLogPanel) {
    this.registerLog.attach({
      button: registerLogButton,
      panel: registerLogPanel,
      summary: registerLogPanel.querySelector(".register-log-summary"),
      lines: registerLogPanel.querySelector(".register-log-lines"),
    });
  }

  var exportSaveButton = element.querySelector("button[action=export-save]"),
    importSaveButton = element.querySelector("button[action=import-save]"),
    saveFileInput = element.querySelector("input[action=save-file]");

  if (exportSaveButton) {
    exportSaveButton.addEventListener("click", function () {
      that.export_save();
    });
  }

  if (importSaveButton && saveFileInput) {
    importSaveButton.addEventListener("click", function () {
      saveFileInput.click();
    });

    saveFileInput.addEventListener("change", function (e) {
      var file = e.target.files[0];

      if (file) {
        that.import_save(file);
      }

      e.target.value = "";
    });
  }

  function noopHandler(evt) {
    evt.stopPropagation();
    evt.preventDefault();
  }

  element.addEventListener("dragenter", noopHandler, false);
  element.addEventListener("dragexit", noopHandler, false);
  element.addEventListener("dragover", noopHandler, false);
  element.addEventListener("drop", this.drop.bind(this), false);

  if (data.debug) {
    [].forEach.call(element.querySelectorAll("input[type=button]"), function (el) {
      el.addEventListener("click", that[el.attributes.action.value].bind(that));
    });

    this.body.runButton = element.querySelector("input[action=run]");
    this.body.port = element.querySelector("port");
    this.body.selects = [].reduce.call(
      element.querySelectorAll("select"),
      function (acc, f) {
        acc[f.attributes.action.value.toLowerCase()] = f;
        return acc;
      },
      {}
    );
    this.body.flags = [].reduce.call(
      element.querySelectorAll("flag"),
      function (acc, f) {
        acc[f.attributes.name.value.toLowerCase()] = f;
        return acc;
      },
      {}
    );
    this.body.registers = [].reduce.call(
      element.querySelectorAll("register"),
      function (acc, r) {
        acc[r.attributes.name.value.toLowerCase()] = r;
        return acc;
      },
      {}
    );
    this.body.instructions = [].map.call(
      element.querySelectorAll("instruction"),
      function (i) {
        return {
          instruction: i,
          location: i.querySelector("location"),
          opcode: i.querySelector("opcode"),
          data: i.querySelector("data"),
          addressing: i.querySelector("addressing"),
        };
      }
    );
    this.body.control = [].map.call(
      element.querySelectorAll("control byte"),
      function (b) {
        b.addEventListener("click", that.update_control.bind(that));
        return b;
      }
    );
    this.body.memory = [].map.call(
      element.querySelectorAll("memory byte"),
      function (b) {
        return b;
      }
    );

    this._debug_port = 0x3000;
    this.update_control();
    this.refresh = this.refresh_debugger;
    return;
  }

  this.refresh = this.refresh_simple;
};

module.exports = {
  start: start,
};
