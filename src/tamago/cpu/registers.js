var ports = require("../data/ports.js");

var SPI_NOOP_COMMANDS = {
	0x01: true,
	0x02: true,
	0x04: true,
	0x06: true,
	0x20: true,
	0x52: true,
	0xC7: true,
	0xD8: true
};

var register_layout = {},
	undef_register = {
		read: undef_read,
		write: undef_write
	};

// ==== Shared helpers ====
function pad(s, l) {
	return "00000000".substr(0, l).substr(s.length) + s;
}

function latch_read(reg) {
	return this._cpureg[reg];
}

function latch_write(reg, value) {
	this._cpureg[reg] = value & 0xFF;
}

function peripherals() {
	return this._peripherals;
}

// ==== Bank Switch ====
function write_bank(reg, value) {
	latch_write.call(this, reg, value);
	this.set_rom_page(value);
}

// ==== IRQ Logic ====
function write_int_flag(reg, value) {
	value &= 0xFF;
	this._cpureg[reg] &= ~value;
}

function write_irq_control(reg, value) {
	latch_write.call(this, reg, value);
	if (this.configure_timers) {
		this.configure_timers();
	}
}

// ==== LCD block ====
function write_lcd_register(reg, value) {
	latch_write.call(this, reg, value);
	if (this.sync_lcd_state) {
		this.sync_lcd_state();
	}
}

// ==== Timer block ====
function write_timer_control(reg, value) {
	latch_write.call(this, reg, value);
	if (this.configure_timers) {
		this.configure_timers();
	}
}

function write_timer_reg(timerName, reg, value) {
	latch_write.call(this, reg, value);
	if (this.update_timer_reload) {
		this.update_timer_reload(timerName);
	}
}

function write_timer0_low(reg, value) {
	write_timer_reg.call(this, "tm0", reg, value);
}

function write_timer0_high(reg, value) {
	write_timer_reg.call(this, "tm0", reg, value);
}

function write_timer1_low(reg, value) {
	write_timer_reg.call(this, "tm1", reg, value);
}

function write_timer1_high(reg, value) {
	write_timer_reg.call(this, "tm1", reg, value);
}

// ==== Port A / IR ====
function update_ir_tx_state() {
	var ir = peripherals.call(this).ir;

	ir.txLine = Boolean(this._cpureg[0x11] & this._cpureg[0x12] & 0x80);
	ir.altTxLine = Boolean(this._cpureg[0x15] & this._cpureg[0x16] & 0x08);
}

function arm_ir_failure_window() {
	var ir = peripherals.call(this).ir;

	if (ir.peer) {
		ir.window = null;
		return;
	}

	ir.window = {
		index: 0,
		total: 16,
		lowStart: 6,
		lowLength: 3
	};
}

function write_porta_dir_data(reg, value) {
	latch_write.call(this, reg, value);
	update_ir_tx_state.call(this);
}

function write_porta_strobe(reg, value) {
	latch_write.call(this, reg, value);
	peripherals.call(this).ir.strobe = value & 0xFF;
	arm_ir_failure_window.call(this);
}

function read_porta_data(reg) {
	var mask = this._cpureg[0x11],
		value = this._cpureg[0x12],
		spi_power = mask & value & 0x10,
		input = read_ir_rx.call(this) | this.keys |
			((spi_power ? 0 : this.inserted_figure) << 5);

	return ((mask & value) | (~mask & input)) & 0xFF;
}

function read_ir_rx() {
	var ir = peripherals.call(this).ir,
		peer,
		window,
		level;

	peer = ir.peer;
	if (peer && peer._peripherals && peer._peripherals.ir) {
		return (peer._peripherals.ir.txLine || peer._peripherals.ir.altTxLine) ? 0x80 : 0x00;
	}

	window = ir.window;
	if (!window) {
		return 0x80;
	}

	level = (window.index >= window.lowStart &&
		window.index < window.lowStart + window.lowLength) ? 0x00 : 0x80;

	window.index++;
	if (window.index >= window.total) {
		ir.window = null;
	}

	return level;
}

// ==== Port B / EEPROM ====
function write_portb_dir_data(reg, value) {
	var mask,
		d;

	latch_write.call(this, reg, value);
	update_ir_tx_state.call(this);

	mask = this._cpureg[0x15];
	d = (~mask | this._cpureg[0x16]) & 0xFF;

	this._eeprom.update(d & 4, d & 2, d & 1);
}

function read_portb_data(reg) {
	var mask = this._cpureg[0x15],
		input = (this._eeprom.output ? 1 : 0);

	return ((mask & this._cpureg[0x16]) | (~mask & input)) & 0xFF;
}

// ==== SPI Figure Flash ====
function reset_spi() {
	flush_spi_trace.call(this);

	this._spi = {
		command: [],
		response: [],
		reading: false,
		address: 0,
		trace: null,
		mode: ""
	};
}

function spi_state() {
	if (!this._spi) {
		reset_spi.call(this);
	}

	return this._spi;
}

function flash_state() {
	return peripherals.call(this).spiFlash;
}

function write_spi_control(reg, value) {
	latch_write.call(this, reg, value);
	reset_spi.call(this);
}

function write_spi_data(reg, value) {
	var spi = spi_state.call(this),
		flash = flash_state.call(this),
		rom = this.spi_rom,
		command,
		address;

	value &= 0xFF;
	this._cpureg[reg] = value;

	if (rom && spi.reading) {
		push_spi_rom_byte.call(this, spi);
		return;
	}

	if (spi.mode === "status") {
		spi.response.push(0x00);
		return;
	}

	if (spi.mode === "id") {
		push_spi_id_byte.call(this, spi);
		return;
	}

	if (spi.mode === "release") {
		push_spi_release_byte.call(this, spi);
		return;
	}

	if (spi.mode === "noop") {
		spi.response.push(0x00);
		return;
	}

	spi.command.push(value);
	spi.response.push(value);
	command = spi.command[0];

	if (!rom) {
		return;
	}

	if (flash.deepPowerDown && command !== 0x05 && command !== 0xAB && command !== 0xB9) {
		spi.response[spi.response.length - 1] = 0xFF;
		spi.mode = "noop";
		return;
	}

	if (command === 0x05 && spi.command.length === 1) {
		spi.mode = "status";
		return;
	}

	if (command === 0x9F && spi.command.length === 1) {
		spi.mode = "id";
		spi.idIndex = 0;
		return;
	}

	if (command === 0xAB && spi.command.length === 1) {
		flash.deepPowerDown = false;
		spi.mode = "release";
		spi.releaseIndex = 0;
		return;
	}

	if (command === 0xB9 && spi.command.length === 1) {
		flash.deepPowerDown = true;
		spi.mode = "noop";
		return;
	}

	if (SPI_NOOP_COMMANDS[command]) {
		spi.mode = "noop";
		return;
	}

	if (spi.command.length === 4 && command === 0x03) {
		address = (spi.command[1] << 16) | (spi.command[2] << 8) | spi.command[3];
		start_spi_read.call(this, spi, command, address);
		return;
	}

	if (spi.command.length === 5 && command === 0x0B) {
		address = (spi.command[1] << 16) | (spi.command[2] << 8) | spi.command[3];
		start_spi_read.call(this, spi, command, address);
		return;
	}

	if (spi.command.length > 5 && !spi.reading) {
		spi.command.shift();
	}
}

function read_spi_data(reg) {
	var spi = spi_state.call(this),
		value = spi.response.length ? spi.response.shift() : 0xFF;

	this._cpureg[reg] = value;
	return value;
}

function read_spi_status(reg) {
	return (this._cpureg[reg] | 0x04) & 0xFF;
}

function start_spi_read(spi, command, address) {
	if (!this.spi_rom || !this.spi_rom.length) {
		return;
	}

	spi.address = address % this.spi_rom.length;
	spi.reading = true;
	spi.trace = {
		command: command,
		address: spi.address,
		bytes: []
	};
}

function push_spi_rom_byte(spi) {
	var rom = this.spi_rom,
		value;

	if (!rom || !rom.length) {
		spi.response.push(0xFF);
		return;
	}

	value = rom[spi.address++ % rom.length];
	spi.response.push(value);

	if (spi.trace) {
		spi.trace.bytes.push(value);
	}
}

function push_spi_id_byte(spi) {
	var id = [0xEF, 0x40, 0x13],
		value = id[spi.idIndex++ % id.length];

	spi.response.push(value);
}

function push_spi_release_byte(spi) {
	var id = [0x13],
		value = id[spi.releaseIndex++ % id.length];

	spi.response.push(value);
}

function flush_spi_trace() {
	var spi = this._spi;

	if (!spi || !spi.trace || !spi.trace.bytes.length || !this.emit_spi_event) {
		return;
	}

	this.emit_spi_event({
		type: "read",
		command: spi.trace.command,
		address: spi.trace.address,
		bytes: spi.trace.bytes.slice()
	});

	spi.trace = null;
}

// ==== Unknown register fallback ====
function undef_read(reg) {
	console.log(
		pad(this._cpureg[0].toString(16), 2),
		this.pc.toString(16),
		"Unhandled register read  (" + (0x3000 + reg).toString(16) + ")",
		"             ",
		(ports[reg | 0x3000] || {}).name || "---");

	return this._cpureg[reg];
}

function undef_write(reg, data) {
	console.log(
		pad(this._cpureg[0].toString(16), 2),
		this.pc.toString(16),
		"Unhandled register write (" + (0x3000 + reg).toString(16) + ")",
		pad(data.toString(16), 2),
		"-",
		pad(data.toString(2), 8),
		(ports[reg | 0x3000] || {}).name || "---");
	this._cpureg[reg] = data & 0xFF;
}

function set_latched(reg) {
	register_layout[reg] = {
		read: latch_read,
		write: latch_write
	};
}

function set_latched_range(start, end, write) {
	var i;

	for (i = start; i <= end; i++) {
		register_layout[i] = {
			read: latch_read,
			write: write || latch_write
		};
	}
}

register_layout[0x00] = { write: write_bank };

set_latched(0x01);
set_latched(0x02);
set_latched(0x04);
set_latched(0x06);
set_latched(0x10);
set_latched(0x14);
set_latched(0x75);
set_latched(0xB1);
set_latched(0xB2);
set_latched(0xB4);
set_latched(0xB5);
set_latched(0xBA);

register_layout[0x11] = { read: latch_read, write: write_porta_dir_data };
register_layout[0x12] = { read: read_porta_data, write: write_porta_dir_data };
register_layout[0x13] = { read: latch_read, write: write_porta_strobe };
register_layout[0x15] = { read: latch_read, write: write_portb_dir_data };
register_layout[0x16] = { read: read_portb_data, write: write_portb_dir_data };

register_layout[0x30] = { read: latch_read, write: write_timer_control };
register_layout[0x31] = { read: latch_read, write: write_timer_control };
register_layout[0x32] = { read: latch_read, write: write_timer0_low };
register_layout[0x33] = { read: latch_read, write: write_timer0_high };
register_layout[0x34] = { read: latch_read, write: write_timer1_low };
register_layout[0x35] = { read: latch_read, write: write_timer1_high };

set_latched_range(0x40, 0x4A, write_lcd_register);
set_latched_range(0x54, 0x56);
set_latched_range(0x60, 0x65);

register_layout[0x70] = { read: latch_read, write: write_irq_control };
register_layout[0x71] = { read: latch_read, write: write_irq_control };
register_layout[0x73] = { read: latch_read, write: write_int_flag };
register_layout[0x74] = { read: latch_read, write: write_int_flag };
register_layout[0x76] = { read: latch_read, write: write_irq_control };

register_layout[0xB0] = { read: latch_read, write: write_spi_control };
register_layout[0xB3] = { read: latch_read, write: write_spi_data };
register_layout[0xB6] = { read: read_spi_data, write: latch_write };
register_layout[0xB7] = { read: read_spi_status, write: latch_write };

module.exports = {
	map_registers: function () {
		var i;

		for (i = 0; i < 0x100; i++) {
			~function () {
				var layout = register_layout[i] || undef_register,
					read = layout.read || latch_read,
					write = layout.write || latch_write,
					a;

				for (a = 0x3000; a < 0x4000; a += 0x100) {
					this._readbank[a + i] = read;
					this._writebank[a + i] = write;
				}
			}.call(this);
		}
	}
};
