var object = require("../../util/object.js");

var DISABLED = 0,
	COMMAND = 1,
	ADDRESS = 2,
	READ = 3,
	WRITE = 4,
	STORAGE_KEY = "tamago_eeprom_data",
	LEGACY_STORAGE_KEY = "eeprom_data";

function decode(data) {
	if (!data || data.length % 2 || !/^[0-9a-fA-F]+$/.test(data)) {
		return null;
	}

	return data.match(/../g).map(function(v){
		return parseInt(v,16);
	});
}

function encode(data) {
	var output = [];

	for (var i = 0; i < data.length; i++) {
		output.push((0x100 | data[i]).toString(16).substr(1));
	}

	return output.join("");
}

function get_storage() {
	try {
		if (typeof window !== "undefined" && window.localStorage) {
			return window.localStorage;
		}
	} catch(e) {}

	return null;
}

function load_data(byte_size) {
	var store = get_storage(),
		raw,
		data;

	if (store) {
		raw = store.getItem(STORAGE_KEY) || store.getItem(LEGACY_STORAGE_KEY);
		data = decode(raw);
	}

	if (!data) {
		data = object.fill(byte_size, 0);
	}

	while (data.length < byte_size) {
		data.push(0);
	}

	return data.slice(0, byte_size);
}

function decode_export(payload) {
	var parsed,
		data;

	if (!payload) {
		return null;
	}

	if (typeof payload !== "string") {
		payload = String(payload);
	}

	payload = payload.trim();
	if (!payload) {
		return null;
	}

	try {
		parsed = JSON.parse(payload);
		if (parsed && parsed.format === "tamago-eeprom-v1") {
			data = decode(parsed.data);
			if (data) {
				return data;
			}
		}
	} catch(e) {}

	return decode(payload);
}

function normalize_data(data, byte_size) {
	while (data.length < byte_size) {
		data.push(0);
	}

	return data.slice(0, byte_size);
}

function eeprom(bit_width) {
	bit_width || (bit_width = 12);
	var byte_size = 1 << bit_width;

	// Initalize eeprom data (4kB by default)
	this.data = load_data(byte_size);
	this.byte_size = byte_size;
	this.save_timer = null;

	this.address_width = Math.ceil(bit_width / 8);
	this.mask = (1 << bit_width) - 1;

	this.update(false);
}

eeprom.prototype.save = function () {
	var store = get_storage();

	if (!store) {
		return false;
	}

	if (this.save_timer) {
		clearTimeout(this.save_timer);
		this.save_timer = null;
	}

	store.setItem(STORAGE_KEY, encode(this.data));
	return true;
};

eeprom.prototype.export_data = function () {
	this.save();

	return {
		format: "tamago-eeprom-v1",
		bytes: this.data.length,
		data: encode(this.data)
	};
};

eeprom.prototype.import_data = function (payload) {
	var data = decode_export(payload);

	if (!data) {
		return false;
	}

	this.data = normalize_data(data, this.byte_size);
	this.save();
	return true;
};

eeprom.prototype.queue_save = function () {
	var that = this;

	if (this.save_timer) {
		return;
	}

	this.save_timer = setTimeout(function () {
		that.save();
	}, 80);
};

eeprom.prototype.update = function(power, clk, data) {
	// Coerse clk / data lines into integer booleans
	clk = clk ? 1 : 0;
	data = data ? 1 : 0;

	var clk_d = clk - this.last_clk,
		data_d = data - this.last_data;

	this.last_pow = power;
	this.last_clk = clk;
	this.last_data = data;

	// This chip is not receiving power, so it is idle.
	if (!power) {
		this.state = DISABLED;
		this.output = 1; // NACK
		return ;
	}

	// There has been no bus change (idle)
	if (!clk_d && !data_d) { return ; }

	// Give friendly warning about the host behaving poorly
	if (clk_d && data_d) {
		console.error("WARNING: Data and clock lines are transitioning at the same time");
	}

	// Data transition while CLK is high
	if (clk && data_d) {
		if (data_d > 0) { 
			if (this.state === WRITE) {
				this.save();
			}

			// Stop
			this.state = DISABLED;
			this.output = 0;
		} else {
			// Start
			this.state = COMMAND;
			this.output = 0;

			this.bits_tx = 0;
			this.read = 0;
		}
	}

	// We are not processing any data right now
	if (this.state === DISABLED) { return ; }

	if (clk_d > 0) {
		// Rising edge clock (input)
		this.read = ((this.read << 1) & 0xFF) | (data ? 1 : 0);
	} else if (clk_d < 0) {
		// Falling edge (delivery)
		if (this.bits_tx < 8) {
			// Simply update output buffer
			if (this.state === READ) {
				this.output = ((this.data[this.address] << this.bits_tx) & 0x80) ? 1 : 0;
			} else {
				this.output = 1;
			}
		} else if (this.bits_tx === 8) {
			this.output = 0; // ACK

			// We have received a full command / output a value
			switch (this.state) {
			case COMMAND:
				switch(this.read & 0xF1) {
				case 0xA0: // Write
					this.state = ADDRESS;
					this.addressbyte = 0;
					this.address = 0;
					break ;
				case 0xA1: // Read
					this.state = READ;
					break ;
				default:
					this.output = 1; // NACK
					break ;
				}
				break ;
			case ADDRESS:
				// Update address
				this.address = (this.address << 8) | this.read;
				if (++this.addressbyte >= this.address_width) {
					this.state = WRITE;
				}
				break ;
			case WRITE:
				this.data[this.address] = this.read & 0xFF;
				this.address = (this.address + 1) & this.mask;
				this.queue_save();
				break ;
			case READ:
				this.address = (this.address + 1) & this.mask;
				break ;
			}
		}

		// Increment bit clock
		this.bits_tx = (this.bits_tx + 1) % 9;
	}
}

module.exports = {
	eeprom: eeprom
};
