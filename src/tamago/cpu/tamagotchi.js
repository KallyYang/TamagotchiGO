
var r6502 = require("./6502.js"),
		eeprom = require("./eeprom.js"),
		registers = require("./registers.js"),
		object = require("../../util/object.js");

var ACCESS_READ		= 0x01,
		ACCESS_WRITE	= 0x02,
		FRAME_SECONDS = 1 / 60,
		FRAME_EPSILON = 1e-9;

function create_timer(lowReg, highReg, controlReg, enableMask, irq) {
	return {
		lowReg: lowReg,
		highReg: highReg,
		controlReg: controlReg,
		enableMask: enableMask,
		irq: irq,
		reload: 0,
		period: 0x10000,
		remaining: 0x10000,
		active: false
	};
}

function timer_period(raw) {
	raw &= 0xFFFF;
	raw = (0x10000 - raw) & 0xFFFF;
	return raw || 0x10000;
}

function encode_bytes(data) {
	var output = [],
		i;

	for (i = 0; i < data.length; i++) {
		output.push((0x100 | data[i]).toString(16).substr(1));
	}

	return output.join("");
}

function decode_bytes(data, expectedLength) {
	var output,
		i;

	if (!data || data.length % 2 || !/^[0-9a-fA-F]+$/.test(data)) {
		return null;
	}

	output = new Uint8Array(data.length >> 1);
	for (i = 0; i < output.length; i++) {
		output[i] = parseInt(data.substr(i * 2, 2), 16);
	}

	if (expectedLength !== undefined && output.length !== expectedLength) {
		return null;
	}

	return output;
}

function as_number(value, fallback) {
	value = Number(value);
	return isFinite(value) ? value : fallback;
}

function copy_array(list) {
	return list ? list.slice() : [];
}

function copy_object(value) {
	return value ? JSON.parse(JSON.stringify(value)) : value;
}

function restore_bytes(target, encoded) {
	var decoded = decode_bytes(encoded, target.length),
		i;

	if (!decoded) {
		return false;
	}

	for (i = 0; i < target.length; i++) {
		target[i] = decoded[i];
	}

	return true;
}

function system() {
	this._readbank = new Array(0x10000);
	this._writebank = new Array(0x10000);

	this._cpuacc = new Uint8Array(0x10000);		// Access flags

	this._cpureg = new Uint8Array(0x100);		// Control registers
	this._dram   = new Uint8Array(0x200);		// Display memory
	this._wram	 = new Uint8Array(0x600);		// System memory
	this._eeprom = new eeprom.eeprom(12);		// new 32kb eeprom
	this._irqs = new Uint16Array(0x10000);
	this._write_hooks = [];
	this._spi_event_hooks = [];
	this._ir_event_hooks = [];
	this._peripherals = null;
	this._ir_peer = null;
	this._ir_response_trace = null;
	this.total_cycles = 0;

	this.keys	 = 0xF;
	this.spi_rom = null;
	this._spi = null;
	this.previous_clock = 0;
	this.inserted_figure = 0;
	this.speed_multiplier = 1;
	this.frame_progress_seconds = 0;

	// Convert a 16bit mask into a priority encoded IRQ table
	var irqs = new Uint16Array(this.bios, 0x3FC0, 16);
	for (var i = 0; i < this._irqs.length; i++) {
		this._irqs[i] = irqs[15 - Math.floor(i ? (Math.log(i) / Math.log(2)) : 0)];
	}

	// Configure and reset
	this.init();
	this.reset();
}

system.prototype = Object.create(r6502.r6502);	
object.extend(system.prototype, registers);

system.prototype.PALETTE = [0xffdddddd, 0xff9e9e9e, 0xff606060, 0xff222222];

system.prototype.CLOCK_RATE = 4000000; // 4MHz
system.prototype.MAX_ADVANCE = 1;
system.prototype.MAX_FRAME_MS = 8;
system.prototype.LCD_ORDER = [
	0x0C0, 0x0CC, 0x0D8, 0x0E4, 
	0x0F0, 0x0FC, 0x108, 0x114, 
	0x120, 0x12C, 0x138, 0x144, 
	0x150, 0x15C, 0x168, 0x174, 
	0x0B4, 0x0A8, 0x09C, 0x090, 
	0x084, 0x078, 0x06C, 0x060, 
	0x054, 0x048, 0x03C, 0x030, 
	0x024, 0x018, 0x00C];

system.prototype.reset_peripherals = function () {
	this._cpureg.fill(0);
	this._spi = null;
	this._peripherals = {
		timers: {
			tm0: create_timer(0x32, 0x33, 0x30, 0x01, null),
			tm1: create_timer(0x34, 0x35, 0x31, 0x02, 10),
			tbl: {
				controlReg: 0x31,
				enableMask: 0x20,
				divider: this.CLOCK_RATE / 2,
				remaining: this.CLOCK_RATE / 2,
				irq: 13,
				active: false
			}
		},
		lcd: {
			enabled: false,
			bufferEnabled: false,
			rows: this.LCD_ORDER.length,
			columns: 64
		},
		ir: {
			peer: this._ir_peer,
			strobe: 0,
			txLine: false,
			altTxLine: false,
			window: null,
			responseTrace: this._ir_response_trace,
			responsePlayback: null
		},
		spiFlash: {
			deepPowerDown: false
		}
	};
	this.sync_lcd_state();
};

system.prototype.connectIrPeer = function (peerSystem) {
	this._ir_peer = peerSystem || null;
	if (this._peripherals) {
		this._peripherals.ir.peer = this._ir_peer;
	}
};

system.prototype.set_ir_response_trace = function (trace) {
	this._ir_response_trace = trace || null;

	if (!this._peripherals) {
		return;
	}

	this._peripherals.ir.responseTrace = this._ir_response_trace;
	this._peripherals.ir.responsePlayback = null;
};

system.prototype.update_timer_reload = function (name) {
	var timer = this._peripherals.timers[name];

	if (!timer) {
		return;
	}

	timer.reload = this._cpureg[timer.lowReg] | (this._cpureg[timer.highReg] << 8);
	timer.period = timer_period(timer.reload);
	timer.remaining = timer.period;
};

system.prototype.configure_timers = function () {
	var timers = this._peripherals.timers,
		name,
		timer,
		active;

	for (name in timers) {
		if (!timers.hasOwnProperty(name)) {
			continue;
		}

		timer = timers[name];
		active = Boolean(this._cpureg[timer.controlReg] & timer.enableMask);

		if (active && !timer.active) {
			timer.remaining = timer.period || timer.divider || 1;
		} else if (!active && timer.active) {
			timer.remaining = timer.period || timer.divider || 1;
		}

		timer.active = active;
	}
};

system.prototype.sync_lcd_state = function () {
	var lcd = this._peripherals.lcd,
		setup1 = this._cpureg[0x40],
		bufferCtrl = this._cpureg[0x47],
		segCount = this._cpureg[0x44],
		comCount = this._cpureg[0x45];

	lcd.bufferEnabled = Boolean(bufferCtrl & 0x40);
	lcd.enabled = Boolean((setup1 & 0x20) && lcd.bufferEnabled);
	lcd.rows = Math.max(1, Math.min(this.LCD_ORDER.length, (comCount & 0x1F) || this.LCD_ORDER.length));
	lcd.columns = Math.max(4, Math.min(64, ((segCount & 0x0F) + 1) * 16));
};

system.prototype.get_lcd_state = function () {
	return this._peripherals.lcd;
};

system.prototype.advance_timer = function (timer, cycles) {
	var period,
		guard = 0;

	if (!timer.active) {
		return;
	}

	period = timer.period || 1;
	timer.remaining -= cycles;

	while (timer.remaining <= 0 && guard++ < 16) {
		timer.remaining += period;
		if (timer.irq !== null) {
			this.fire_irq(timer.irq);
		}
	}
};

system.prototype.advance_timebase = function (timer, cycles) {
	var guard = 0;

	if (!timer.active) {
		return;
	}

	timer.remaining -= cycles;

	while (timer.remaining <= 0 && guard++ < 4) {
		timer.remaining += timer.divider;
		this.fire_irq(timer.irq);
	}
};

system.prototype.advance_peripherals = function (cycles) {
	var timers = this._peripherals.timers;

	this.advance_timer(timers.tm0, cycles);
	this.advance_timer(timers.tm1, cycles);
	this.advance_timebase(timers.tbl, cycles);
};

system.prototype.step = function () {
	var cycles = r6502.r6502.step.call(this);
	this.total_cycles += cycles;
	this.advance_peripherals(cycles);
	return cycles;
};

system.prototype.execute_cycle_budget = function (deadlineMs) {
	var steps = 0,
		dropped = false;

	while(this.cycles > 0) {
		this.step();
		if (deadlineMs && !(++steps & 0xFF) && +new Date() > deadlineMs) {
			this.cycles = 0;
			dropped = true;
			break;
		}
	}

	return {
		steps: steps,
		dropped: dropped
	};
};

system.prototype.process_virtual_seconds = function (virtualSeconds, options) {
	var remaining = Math.max(0, virtualSeconds || 0),
		frame = {
			virtualSeconds: remaining,
			cycles: 0,
			frameEvents: 0,
			execution: {
				steps: 0,
				dropped: false
			}
		},
		sliceSeconds,
		frameRemaining,
		execution;

	options || (options = {});

	// Keep high speed modes frame-accurate by stepping through each virtual frame
	// boundary instead of batching multiple NMIs into a single instant.
	while (remaining > FRAME_EPSILON) {
		frameRemaining = FRAME_SECONDS - this.frame_progress_seconds;
		if (frameRemaining <= FRAME_EPSILON) {
			this.frame_progress_seconds = 0;
			frameRemaining = FRAME_SECONDS;
		}

		if (this.frame_progress_seconds <= FRAME_EPSILON) {
			this.frame_progress_seconds = 0;
			this.fire_nmi(6);
			frame.frameEvents++;
		}

		sliceSeconds = Math.min(remaining, frameRemaining);
		this.cycles += this.CLOCK_RATE * sliceSeconds;
		frame.cycles += this.CLOCK_RATE * sliceSeconds;
		execution = this.execute_cycle_budget(options.deadlineMs);
		frame.execution.steps += execution.steps;

		if (execution.dropped) {
			frame.execution.dropped = true;
			break;
		}

		this.frame_progress_seconds += sliceSeconds;
		if (this.frame_progress_seconds >= FRAME_SECONDS - FRAME_EPSILON) {
			this.frame_progress_seconds = 0;
		}

		remaining -= sliceSeconds;
	}

	return frame;
};

system.prototype.process_frame_slice = function (deltaSeconds, options) {
	var speed = Math.max(1, this.speed_multiplier || 1),
		nowSeconds,
		frame;

	options || (options = {});
	if (options.updateClock !== false) {
		nowSeconds = options.nowSeconds;
		if (typeof nowSeconds !== "number") {
			nowSeconds = +new Date() / 1000;
		}
		this.previous_clock = nowSeconds;
	}

	frame = this.process_virtual_seconds(deltaSeconds * speed, options);
	frame.speedMultiplier = speed;
	return frame;
};

system.prototype.step_realtime = function () {
	var t = +new Date() / 1000,
		d = Math.min(this.MAX_ADVANCE, t - this.previous_clock) || 0;

	return this.process_frame_slice(d, {
		nowSeconds: t,
		deadlineMs: +new Date() + this.MAX_FRAME_MS
	});
};

system.prototype.step_virtual_frame = function () {
	return this.process_frame_slice(FRAME_SECONDS, {
		updateClock: false
	});
};

system.prototype.run_virtual_frames = function (frameCount) {
	frameCount = Math.max(0, Math.floor(frameCount || 0));
	while (frameCount-- > 0) {
		this.step_virtual_frame();
	}
};

system.prototype.fire_nmi = function (i) {
	// NMI was not enabled
	if (~this._cpureg[0x76] & (0x80 >> i)) { return ; }

	this.nmi();
}

system.prototype.pending_irq = function () {
	return (this._cpureg[0x73] << 8) | this._cpureg[0x74];
}

system.prototype.fire_irq = function (i) {
	// Map the pending interrupt
	var mask = (this._cpureg[0x70] << 8) | this._cpureg[0x71];

	// This IRQ is disabled
	if ((0x8000 >> i) & ~mask) { return ; }

	// Set pending IRQ to fire
	this._cpureg[0x73 + (i >> 3)] |= 0x80 >> (i & 7);
}

system.prototype.insert_figure = function (data) {
	if (!data) {
		this.spi_rom = null;
		this._spi = null;
		if (this._peripherals) {
			this._peripherals.spiFlash.deepPowerDown = false;
		}
		return;
	}

	this.spi_rom = new Uint8Array(data);
	this._spi = null;
	if (this._peripherals) {
		this._peripherals.spiFlash.deepPowerDown = false;
	}
};

system.prototype.export_state = function (options) {
	var timers = this._peripherals && this._peripherals.timers,
		ir = this._peripherals && this._peripherals.ir,
		spiFlash = this._peripherals && this._peripherals.spiFlash;

	options || (options = {});

	return {
		format: "tamago-runtime-v1",
		cpu: {
			a: this.a & 0xFF,
			x: this.x & 0xFF,
			y: this.y & 0xFF,
			s: this.s & 0xFF,
			pc: this.pc & 0xFFFF,
			status: this.p & 0xFF,
			cycles: as_number(this.cycles, 0),
			totalCycles: as_number(this.total_cycles, 0),
			keys: this.keys & 0x0F
		},
		memory: {
			cpureg: encode_bytes(this._cpureg),
			dram: encode_bytes(this._dram),
			wram: encode_bytes(this._wram)
		},
		eeprom: this._eeprom.export_state(),
		peripherals: {
			timers: {
				tm0: timers ? {
					reload: as_number(timers.tm0.reload, 0),
					period: as_number(timers.tm0.period, 0x10000),
					remaining: as_number(timers.tm0.remaining, 0x10000),
					active: Boolean(timers.tm0.active)
				} : null,
				tm1: timers ? {
					reload: as_number(timers.tm1.reload, 0),
					period: as_number(timers.tm1.period, 0x10000),
					remaining: as_number(timers.tm1.remaining, 0x10000),
					active: Boolean(timers.tm1.active)
				} : null,
				tbl: timers ? {
					remaining: as_number(timers.tbl.remaining, this.CLOCK_RATE / 2),
					active: Boolean(timers.tbl.active)
				} : null
			},
			ir: ir ? {
				strobe: as_number(ir.strobe, 0),
				txLine: Boolean(ir.txLine),
				altTxLine: Boolean(ir.altTxLine),
				window: copy_object(ir.window),
				responseTrace: copy_object(ir.responseTrace),
				responsePlayback: copy_object(ir.responsePlayback)
			} : null,
			spiFlash: spiFlash ? {
				deepPowerDown: Boolean(spiFlash.deepPowerDown)
			} : null
		},
		spi: this._spi ? {
			command: copy_array(this._spi.command),
			response: copy_array(this._spi.response),
			reading: Boolean(this._spi.reading),
			address: as_number(this._spi.address, 0),
			trace: copy_object(this._spi.trace),
			mode: this._spi.mode || "",
			idIndex: as_number(this._spi.idIndex, 0),
			releaseIndex: as_number(this._spi.releaseIndex, 0)
		} : null,
		figure: {
			inserted: as_number(this.inserted_figure, 0),
			rom: options.includeSpiRom === false || !this.spi_rom ? "" : encode_bytes(this.spi_rom)
		},
		timing: {
			previousClock: as_number(this.previous_clock, 0),
			speedMultiplier: as_number(this.speed_multiplier, 1),
			frameProgressSeconds: as_number(this.frame_progress_seconds, 0)
		}
	};
};

system.prototype.import_state = function (snapshot, options) {
	var timers,
		ir,
		spiData;

	options || (options = {});

	if (!snapshot || snapshot.format !== "tamago-runtime-v1") {
		return false;
	}

	this.reset();

	if (
		!snapshot.memory ||
		!restore_bytes(this._cpureg, snapshot.memory.cpureg) ||
		!restore_bytes(this._dram, snapshot.memory.dram) ||
		!restore_bytes(this._wram, snapshot.memory.wram) ||
		!snapshot.eeprom ||
		!this._eeprom.import_state(snapshot.eeprom)
	) {
		return false;
	}

	if (snapshot.figure && snapshot.figure.rom) {
		spiData = decode_bytes(snapshot.figure.rom);
		if (!spiData) {
			return false;
		}
		this.insert_figure(spiData.buffer);
	} else if (options.figureData) {
		this.insert_figure(options.figureData);
	} else {
		this.insert_figure(null);
	}

	this.inserted_figure = snapshot.figure ? as_number(snapshot.figure.inserted, 0) : 0;
	this.speed_multiplier = snapshot.timing ? Math.max(1, as_number(snapshot.timing.speedMultiplier, 1)) : 1;
	this.previous_clock = snapshot.timing ? as_number(snapshot.timing.previousClock, 0) : 0;
	this.frame_progress_seconds = snapshot.timing ? Math.max(0, as_number(snapshot.timing.frameProgressSeconds, 0)) : 0;
	if (this.frame_progress_seconds >= FRAME_SECONDS - FRAME_EPSILON) {
		this.frame_progress_seconds = 0;
	}

	this.a = snapshot.cpu ? as_number(snapshot.cpu.a, 0) & 0xFF : 0;
	this.x = snapshot.cpu ? as_number(snapshot.cpu.x, 0) & 0xFF : 0;
	this.y = snapshot.cpu ? as_number(snapshot.cpu.y, 0) & 0xFF : 0;
	this.s = snapshot.cpu ? as_number(snapshot.cpu.s, 0) & 0xFF : 0;
	this.pc = snapshot.cpu ? as_number(snapshot.cpu.pc, 0) & 0xFFFF : 0;
	this.p = snapshot.cpu ? as_number(snapshot.cpu.status, 0x20) & 0xFF : 0x20;
	this.cycles = snapshot.cpu ? as_number(snapshot.cpu.cycles, 0) : 0;
	this.total_cycles = snapshot.cpu ? as_number(snapshot.cpu.totalCycles, 0) : 0;
	this.keys = snapshot.cpu ? as_number(snapshot.cpu.keys, 0x0F) & 0x0F : 0x0F;

	this._cpuacc.fill(0);
	this.set_rom_page(this._cpureg[0]);
	this.sync_lcd_state();
	this.configure_timers();

	timers = this._peripherals.timers;
	if (snapshot.peripherals && snapshot.peripherals.timers) {
		if (snapshot.peripherals.timers.tm0) {
			timers.tm0.reload = as_number(snapshot.peripherals.timers.tm0.reload, timers.tm0.reload);
			timers.tm0.period = as_number(snapshot.peripherals.timers.tm0.period, timers.tm0.period);
			timers.tm0.remaining = as_number(snapshot.peripherals.timers.tm0.remaining, timers.tm0.remaining);
			timers.tm0.active = Boolean(snapshot.peripherals.timers.tm0.active);
		}
		if (snapshot.peripherals.timers.tm1) {
			timers.tm1.reload = as_number(snapshot.peripherals.timers.tm1.reload, timers.tm1.reload);
			timers.tm1.period = as_number(snapshot.peripherals.timers.tm1.period, timers.tm1.period);
			timers.tm1.remaining = as_number(snapshot.peripherals.timers.tm1.remaining, timers.tm1.remaining);
			timers.tm1.active = Boolean(snapshot.peripherals.timers.tm1.active);
		}
		if (snapshot.peripherals.timers.tbl) {
			timers.tbl.remaining = as_number(snapshot.peripherals.timers.tbl.remaining, timers.tbl.remaining);
			timers.tbl.active = Boolean(snapshot.peripherals.timers.tbl.active);
		}
	}

	ir = this._peripherals.ir;
	if (snapshot.peripherals && snapshot.peripherals.ir) {
		ir.strobe = as_number(snapshot.peripherals.ir.strobe, 0);
		ir.txLine = Boolean(snapshot.peripherals.ir.txLine);
		ir.altTxLine = Boolean(snapshot.peripherals.ir.altTxLine);
		ir.window = copy_object(snapshot.peripherals.ir.window);
		ir.responseTrace = copy_object(snapshot.peripherals.ir.responseTrace);
		ir.responsePlayback = copy_object(snapshot.peripherals.ir.responsePlayback);
		this._ir_response_trace = copy_object(snapshot.peripherals.ir.responseTrace);
	}

	if (snapshot.peripherals && snapshot.peripherals.spiFlash) {
		this._peripherals.spiFlash.deepPowerDown = Boolean(snapshot.peripherals.spiFlash.deepPowerDown);
	}

	this._spi = snapshot.spi ? {
		command: copy_array(snapshot.spi.command),
		response: copy_array(snapshot.spi.response),
		reading: Boolean(snapshot.spi.reading),
		address: as_number(snapshot.spi.address, 0),
		trace: copy_object(snapshot.spi.trace),
		mode: snapshot.spi.mode || "",
		idIndex: as_number(snapshot.spi.idIndex, 0),
		releaseIndex: as_number(snapshot.spi.releaseIndex, 0)
	} : null;

	return true;
};

system.prototype.init = function () {
	var i, data;

	r6502.r6502.init.call(this);

	// Work ram
	for (i = 0x0000; i < 0x1000; i+=0x0100) {
		data = new Uint8Array(this._wram.buffer, i % this._wram.length, 0x100);
		this.ram(i>>8, data);
	}

	// Display memory
	for (i = 0x1000; i < 0x3000; i+=0x0100) {
		data = new Uint8Array(this._dram.buffer, i % this._dram.length, 0x100);
		this.ram(i>>8, data);
	}

	// CPU registers
	this.map_registers();

	// Static rom
	for (var i = 0; i < 0x40; i ++) {
		this.rom(i + 0xC0, new Uint8Array(this.bios, i << 8, 0x100));
	}

	this._readbank[0xFFFE] = function () { return this._irqs[this.pending_irq()] & 0xFF; }
	this._readbank[0xFFFF] = function () { return this._irqs[this.pending_irq()] >> 8; }

	// Bankable rom
	this.set_rom_page(0);	// Clear current rom page
}

system.prototype.reset = function () {
	this.cycles = 0;
	this.total_cycles = 0;
	this._cpuacc.fill(0);
	this.reset_peripherals();
	this.previous_clock = +new Date() / 1000;
	this.frame_progress_seconds = 0;
	r6502.r6502.reset.call(this);
};

system.prototype.read = function(addr, noack) {
	// A addressing
	if (addr === null) {
		return this.a;
	}

	if(!noack) this._cpuacc[addr] |= ACCESS_READ;

	return this._readbank[addr].call(this, addr & 0xFF);
};

system.prototype.write = function (addr, data) {
	var result, i;

	if (addr === null) {
		this.a = data; 
		return ;
	}

	this._cpuacc[addr] |= ACCESS_WRITE;

	result = this._writebank[addr].call(this, addr & 0xFF, data);

	for (i = 0; i < this._write_hooks.length; i++) {
		this._write_hooks[i](addr, data);
	}

	return result;
};

system.prototype.add_write_hook = function (hook) {
	this._write_hooks.push(hook);
};

system.prototype.add_spi_event_hook = function (hook) {
	this._spi_event_hooks.push(hook);
};

system.prototype.add_ir_event_hook = function (hook) {
	this._ir_event_hooks.push(hook);
};

system.prototype.emit_spi_event = function (event) {
	for (var i = 0; i < this._spi_event_hooks.length; i++) {
		this._spi_event_hooks[i](event);
	}
};

system.prototype.emit_ir_event = function (event) {
	for (var i = 0; i < this._ir_event_hooks.length; i++) {
		this._ir_event_hooks[i](event);
	}
};

// Start helper functions for mapping to memory
system.prototype.set_rom_page = function (bank) {
	var offset = 0x8000 * (bank % 20);

	for (var i = 0; i < 0x80; i ++) {
		this.rom(i + 0x40, new Uint8Array(this.bios, offset + (i << 8), 0x100));
	}
}
system.prototype.ram = function (bank, data) {
	function read(reg) {
		return data[reg];
	}

	function write(reg, value) {
		data[reg] = value;
	}

	bank <<= 8;
	for (var i = 0; i < 0x100; i++) {
		this._readbank[bank+i] = read;
		this._writebank[bank+i] = write;
	}
};

system.prototype.rom = function (bank, data) {
	function nullwrite() {}
	function read(addr) {
		return data[addr];
	}

	bank <<= 8;
	for (var i = 0; i < 0x100; i++) {
		this._readbank[bank+i] = read;
		this._writebank[bank+i] = nullwrite;
	}
};

module.exports =  {
	ACCESS_WRITE: ACCESS_WRITE,
	ACCESS_READ: ACCESS_READ,
	system: system
};
