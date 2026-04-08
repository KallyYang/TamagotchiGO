var ports = require("../data/ports.js"),
		object = require("../../util/object.js");

// ==== Bank Switch ====
function write_bank(reg, value) {
	this._cpureg[reg] = value;
	this.set_rom_page(value);
}

// ==== IRQ Logic ===
function write_int_flag(reg, value) {
	this._cpureg[reg] &= ~value;
}

// ==== PortA ====
function write_porta_dir_data(reg, value) {
	this._cpureg[reg] = value;
	// no writes yet.
}

function read_porta_data(reg, value) {
	var mask = this._cpureg[0x11],
		value = this._cpureg[0x12],
		spi_power = mask & value & 0x10,
		input = read_ir_rx.call(this) | this.keys |
				((spi_power ? 0 : this.inserted_figure) << 5);

	return (mask & value) | (~mask & input);
}

function read_ir_rx() {
	if (!this._ir_rx) {
		this._ir_rx = {
			pc: null,
			reads: 0
		};
	}

	if (this._ir_rx.pc === this.pc) {
		this._ir_rx.reads++;
	} else {
		this._ir_rx.pc = this.pc;
		this._ir_rx.reads = 1;
	}

	// No peer is attached, so the IR receiver idles high. If the ROM busy-waits
	// on an edge, synthesize a small idle edge so the UI can reach its own
	// failure/return path instead of trapping the emulator forever.
	return (this._ir_rx.reads >= 8 && Math.floor(this._ir_rx.reads / 8) % 2) ? 0 : 0x80;
}

// ==== PortB ====
function write_portb_dir_data(reg, value) {
	this._cpureg[reg] = value;

	var mask = this._cpureg[0x15],
		d = ~mask | this._cpureg[0x16];	// Values are pulled up

	this._eeprom.update(d&4, d&2, d&1);
}

function read_portb_data(reg, value) {
	var mask = this._cpureg[0x15],
		input = (this._eeprom.output ? 1 : 0);
	
	return (mask & this._cpureg[0x16]) | (~mask & input);
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
	if (!this._spi) { reset_spi.call(this); }
	return this._spi;
}

function write_spi_control(reg, value) {
	value &= 0xFF;
	this._cpureg[reg] = value;
	reset_spi.call(this);
}

function write_spi_data(reg, value) {
	var spi = spi_state.call(this),
		rom = this.spi_rom,
		address,
		command;

	value &= 0xFF;
	this._cpureg[reg] = value;

	if (rom && spi.reading) {
		push_spi_rom_byte.call(this, spi);
		return;
	}

	if (rom && spi.mode === "status") {
		spi.response.push(0x00);
		return;
	}

	if (rom && spi.mode === "id") {
		push_spi_id_byte.call(this, spi);
		return;
	}

	spi.command.push(value);
	spi.response.push(value);
	command = spi.command[0];

	if (!rom) {
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

	if (spi.command.length > 4 && !spi.reading) {
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
	return this._cpureg[reg] | 0x04;
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

// --- REGISTER LAYOUT ---
function pad(s, l) {
	return "00000000".substr(0, l).substr(s.length) + s;
}

// Default register actions
function undef_read(reg) {
	console.log(
		pad(this._cpureg[0].toString(16), 2),
		this.pc.toString(16),
		"Unhandled register read  (" + (0x3000+reg).toString(16) + ")", 
		"             ", 
		(ports[reg|0x3000] || {}).name || "---");

	if (reg == 0xB7) return 0xFF;

	return this._cpureg[reg];
}

function undef_write(reg, data) {
	console.log(
		pad(this._cpureg[0].toString(16), 2),					
		this.pc.toString(16),
		"Unhandled register write (" + (0x3000+reg).toString(16) + ")", 
		pad(data.toString(16),2), 
		"-", 
		pad(data.toString(2), 8), 
		(ports[reg|0x3000] || {}).name || "---");
	this._cpureg[reg] = data;
}

var register_layout = {
	0x00: { write: write_bank },
	0x01: {}, // SILENCE
	0x04: {}, // SILENCE
	0x31: {}, // SILENCE

	// --- DATA Ports
	0x10: {}, // SILENCE CONFIG
	0x11: { write: write_porta_dir_data },
	0x12: { write: write_porta_dir_data, read: read_porta_data },
	0x14: {}, // SILENCE CONFIG
	0x15: { write: write_portb_dir_data },
	0x16: { write: write_portb_dir_data, read: read_portb_data },

	// --- IRQ Block
	0x70: {}, // IRQ Enables are normal 
	0x71: {}, // IRQ Enables are normal 
	0x73: { write: write_int_flag },
	0x74: { write: write_int_flag },
	0x76: {}, // NMI Enables are normal

	// --- SPI figure flash
	0xB0: { write: write_spi_control },
	0xB3: { write: write_spi_data },
	0xB6: { read: read_spi_data },
	0xB7: { read: read_spi_status },
}, undef_register = {
	read: undef_read, 
	write: undef_write 
};

module.exports = {
	map_registers: function () {
		// Start mapping out registers
		for (var i = 0; i < 0x100; i++) {
			// This is normally considered dangerous, but I need the closure
			~function () {
				var layout = register_layout[i] || undef_register,
					read   = layout.read || function (reg) { return this._cpureg[reg]; },
					write  = layout.write || function (reg, data) { this._cpureg[reg] = data; };

				// Map registers to their mirrors as well
				for (var a = 0x3000; a < 0x4000; a += 0x100) {
					this._readbank[a+i] = read;
					this._writebank[a+i] = write;
				}
			}.call(this);
		}
	}
};
