var config = require("./config.js"),
  audio = require("./audio.js"),
  registerLog = require("./register_log.js"),
  tamagotchi = require("./cpu/tamagotchi.js"),
  disassemble = require("./cpu/disassembler.js"),
  ports = require("./data/ports.js"),
  object = require("../util/object.js"),
  mainTemplate = require("../templates/main.html"),
  portTemplate = require("../templates/port.html");

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

function start(bios) {
  getBinary("files/tamago.bin", function (bios) {
    // Bind to tamago system class
    tamagotchi.system.prototype.bios = bios;

    // Start the application when BIOS is done
    [].forEach.call(document.querySelectorAll("tamago"), function (elem) {
      new Tamago(elem);
    });
  });
}

function Tamago(element) {
  var u8 = new Uint8Array(this.bios),
    that = this;

  this.system = new tamagotchi.system();
  this.audio = new audio.AudioOutput();
  this.registerLog = new registerLog.RegisterLog(ports);
  this.system.add_write_hook(this.audio.write.bind(this.audio));
  this.system.add_write_hook(this.registerLog.write.bind(this.registerLog));
  this.system.add_spi_event_hook(this.registerLog.spi.bind(this.registerLog));

  this.configure(element);

  this._pixeldata = this.body.display.getImageData(0, 0, 64, 31);
  this._pixels = new Uint32Array(this._pixeldata.data.buffer);
  this._disasmOffset = 0;

  this.refresh();

  document.addEventListener("keyup", function (e) {
    that.system.keys |= that.mapping[e.keyCode] || 0;
  });
  document.addEventListener("keydown", function (e) {
    if (that.audio.enabled) {
      that.audio.unlock();
    }
    if (!e.repeat) {
      that.audio.playKey(e.keyCode);
    }
    that.system.keys &= ~that.mapping[e.keyCode] || 0xff;
  });

  // Bind bottom user key buttons (simulate keydown+keyup)
  // [].forEach.call(
  //   document.querySelectorAll(".user-keys button"),
  //   function (btn) {
  //     var code = Number(btn.dataset.key);
  //     btn.addEventListener("mousedown", function () {
  //       that.system.keys &= ~(that.mapping[code] || 0);
  //     });
  //     btn.addEventListener("mouseup", function () {
  //       that.system.keys |= that.mapping[code] || 0;
  //     });
  //     btn.addEventListener("mouseleave", function () {
  //       that.system.keys |= that.mapping[code] || 0;
  //     });
  //   }
  // );

  [].forEach.call(
    document.querySelectorAll(".user-keys button"),
    function (btn) {
      var code = Number(btn.dataset.key);

      // --- 1. 定义“按下”的逻辑 ---
      var handleKeyDown = function (event) {
        // 阻止触摸事件的默认行为（如滚动或模拟点击）
        if (event.type.startsWith("touch")) {
          event.preventDefault();
        }
        if (that.audio.enabled) {
          that.audio.unlock();
        }
        that.audio.playKey(code);
        that.system.keys &= ~(that.mapping[code] || 0);
      };

      // --- 2. 定义“松开”的逻辑 ---
      var handleKeyUp = function (event) {
        if (event.type.startsWith("touch")) {
          event.preventDefault();
        }
        that.system.keys |= that.mapping[code] || 0;
      };

      // --- 3. 绑定所有事件 ---

      // 绑定 PC 鼠标事件
      btn.addEventListener("mousedown", handleKeyDown);
      btn.addEventListener("mouseup", handleKeyUp);
      btn.addEventListener("mouseleave", handleKeyUp); // 鼠标移开也算松开

      // 绑定移动端触摸事件
      btn.addEventListener("touchstart", handleKeyDown);
      btn.addEventListener("touchend", handleKeyUp);
      btn.addEventListener("touchcancel", handleKeyUp); // 触摸被系统打断（比如来电话）也算松开
    }
  );
}

// Keyboard mapping
Tamago.prototype.mapping = { 65: 1, 83: 2, 68: 4, 82: 8 };

Tamago.prototype.step = function (e) {
  this.system.step();
  this.refresh();
};

Tamago.prototype.irq = function (e) {
  this.system.fire_irq(parseInt(this.body.selects.irq.value, 10));
  this.refresh();
};

Tamago.prototype.nmi = function (e) {
  this.system.fire_nmi(6);
  this.refresh();
};

Tamago.prototype.run = function (e) {
  var that = this;

  function frame() {
    if (!that.running) {
      return;
    }

    that.system.step_realtime();
    that.refresh();
    requestAnimationFrame(frame);
  }

  this.running = !this.running;
  frame();

  if (e) {
    e.target.attributes.value.value = this.running ? "stop" : "run";
  }
};

Tamago.prototype.reset = function (e) {
  this.system.reset();
  this.refresh();
};

Tamago.prototype.refresh_simple = function () {
  var a = 4,
    b = 0,
    g = 0;

  while (g < 10) {
    var glyph = (this.system._dram[a] >> b) & 3;
    if ((b -= 2) < 0) {
      b = 6;
      a++;
    }

    this.body.glyphs[g++].style.color =
      "#" + (this.system.PALETTE[glyph] & 0xffffff).toString(16);
  }

  var px = 0;
  for (var y = 0; y < 31; y++) {
    var a = this.system.LCD_ORDER[y];

    for (var x = 0; x < 64; x += 4) {
      var d = this.system._dram[a++],
        b = 6;

      while (b >= 0) {
        this._pixels[px++] = this.system.PALETTE[(d >> b) & 3];
        b -= 2;
      }
    }
  }

  this.body.display.putImageData(this._pixeldata, 0, 0);
};

Tamago.prototype.drop = function (evt) {
  evt.stopPropagation();
  evt.preventDefault();

  var files = evt.dataTransfer.files,
    binary = files[0],
    that = this;

  if (files.length < 1) {
    return;
  }

  this.body.figure.innerHTML = binary.name + " inserted";
  this.system.inserted_figure = 1;

  var reader = new FileReader();
  reader.onload = function (e) {
    that.system.insert_figure(e.target.result);
  };
  reader.readAsArrayBuffer(binary);
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

  // Update basic views
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

  // PC isn't were it should be
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
      } else node.removeAttribute(attr);
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

  data.debug = Boolean(element.attributes.debugger);

  element.innerHTML = mainTemplate(data);

  var figureSelect = element.querySelector("select[action=figure]");
  if (figureSelect) {
    figureSelect.addEventListener("change", function (e) {
      var option = e.target.options[e.target.selectedIndex],
        figure = Number(e.target.value),
        file = option && option.getAttribute("data-file"),
        loadToken = (that.figureLoadToken || 0) + 1;

      that.figureLoadToken = loadToken;

      if (!figure) {
        that.system.inserted_figure = 0;
        that.system.insert_figure(null);
        that.body.figure.innerHTML = "";
      } else if (file) {
        that.system.inserted_figure = 0;
        that.system.insert_figure(null);
        that.body.figure.innerHTML = "正在读取 " + option.text + "...";
        getBinary(file, function (data) {
          if (that.figureLoadToken !== loadToken) {
            return;
          }

          that.system.insert_figure(data);
          that.system.inserted_figure = figure;
          that.body.figure.innerHTML = option.text + " inserted";
        });
      } else {
        that.system.inserted_figure = 0;
        that.system.insert_figure(null);
        that.body.figure.innerHTML = "拖入芯片文件";
      }
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

  function noopHandler(evt) {
    evt.stopPropagation();
    evt.preventDefault();
  }

  element.addEventListener("dragenter", noopHandler, false);
  element.addEventListener("dragexit", noopHandler, false);
  element.addEventListener("dragover", noopHandler, false);
  element.addEventListener("drop", this.drop.bind(this), false);

  // Bind to HTML
  if (data.debug) {
    [].forEach.call(
      document.querySelectorAll("input[type=button]"),
      function (el) {
        el.addEventListener(
          "click",
          that[el.attributes.action.value].bind(that)
        );
      }
    );

    this.body = {
      glyphs: element.querySelectorAll(".glyph"),
      port: element.querySelector("port"),
      selects: [].reduce.call(
        element.querySelectorAll("select"),
        function (acc, f) {
          acc[f.attributes.action.value.toLowerCase()] = f;
          return acc;
        },
        {}
      ),
      flags: [].reduce.call(
        element.querySelectorAll("flag"),
        function (acc, f) {
          acc[f.attributes.name.value.toLowerCase()] = f;
          return acc;
        },
        {}
      ),
      registers: [].reduce.call(
        element.querySelectorAll("register"),
        function (acc, r) {
          acc[r.attributes.name.value.toLowerCase()] = r;
          return acc;
        },
        {}
      ),
      instructions: [].map.call(
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
      ),
      control: [].map.call(
        element.querySelectorAll("control byte"),
        function (b) {
          b.addEventListener("click", that.update_control.bind(that));

          return b;
        }
      ),
      memory: [].map.call(
        element.querySelectorAll("memory byte"),
        function (b) {
          return b;
        }
      ),
      display: element.querySelector("display canvas").getContext("2d"),
      figure: element.querySelector("display figure"),
    };

    this._debug_port = 0x3000;
    this.update_control();

    this.refresh = this.refresh_debugger;
  } else {
    this.body = {
      glyphs: element.querySelectorAll(".glyph"),
      display: element.querySelector("display canvas").getContext("2d"),
      figure: element.querySelector("display figure"),
    };

    this.refresh = this.refresh_simple;
    // Start running soon
    setTimeout(function () {
      that.run();
    }, 10);
  }
};

module.exports = {
  start: start,
};
