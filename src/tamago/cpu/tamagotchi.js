
var r6502 = require("./6502.js"),
		eeprom = require("./eeprom.js"),
		registers = require("./registers.js"),
		object = require("../../util/object.js");

var ACCESS_READ		= 0x01,
		ACCESS_WRITE	= 0x02;

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
	this._peripherals = null;
	this._ir_peer = null;

	this.keys	 = 0xF;
	this.spi_rom = null;
	this._spi = null;
	this.previous_clock = 0;
	this.inserted_figure = 0;
	this.speed_multiplier = 1;

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
system.prototype.MAX_FRAME_CYCLES = 260000;
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
			window: null
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
	this.advance_peripherals(cycles);
	return cycles;
};

system.prototype.step_realtime = function () {
	var t = +new Date() / 1000,
		d = Math.min(this.MAX_ADVANCE, t - this.previous_clock) || 0,
		speed = Math.max(1, this.speed_multiplier || 1),
		cycles = Math.min(this.CLOCK_RATE * d * speed, this.MAX_FRAME_CYCLES),
		effective_speed = d ? Math.max(1, Math.round(cycles / (this.CLOCK_RATE * d))) : 1,
		frame_events = Math.min(4, effective_speed),
		deadline = +new Date() + this.MAX_FRAME_MS,
		steps = 0,
		i;

	this.previous_clock = t;
	this.cycles += cycles;

	// Fire the bundled BIOS NMI heartbeat from the frame loop.
	for (i = 0; i < frame_events; i++) {
		this.fire_nmi(6);
	}

	while(this.cycles > 0) {
		this.step();
		if (!(++steps & 0xFF) && +new Date() > deadline) {
			this.cycles = 0;
			break;
		}
	}
}

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
	this._cpuacc.fill(0);
	this.reset_peripherals();
	this.previous_clock = +new Date() / 1000;
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

system.prototype.emit_spi_event = function (event) {
	for (var i = 0; i < this._spi_event_hooks.length; i++) {
		this._spi_event_hooks[i](event);
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
