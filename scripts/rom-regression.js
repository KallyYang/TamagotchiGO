"use strict";

var fs = require("fs");
var path = require("path");
var tamagotchi = require("../src/tamago/cpu/tamagotchi.js");

var ROOT_DIR = path.resolve(__dirname, "..");
var FILE_DIR = path.join(ROOT_DIR, "web", "files");
var BIOS_PATH = path.join(FILE_DIR, "tamago.bin");
var STARTUP_FRAMES = 240;
var BUTTON_ROUNDS = 3;
var BUTTONS = [1, 2, 4];
var MAX_GUARD = 400000;

function loadArrayBuffer(filePath) {
	var data = fs.readFileSync(filePath);
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function createScenario(name, figureName, figureValue) {
	return {
		name: name,
		figureName: figureName || "",
		figureValue: figureValue || 0
	};
}

function runFrame(system, buttonMask, metrics) {
	var guard = 0,
		pc;

	system.keys = buttonMask === null ? 0x0F : (0x0F & ~buttonMask);
	system.cycles += system.CLOCK_RATE / 60;
	system.fire_nmi(6);

	while (system.cycles > 0 && guard++ < MAX_GUARD) {
		pc = system.pc;
		if (pc === metrics.lastPc) {
			metrics.samePcStreak++;
		} else {
			metrics.samePcStreak = 1;
			metrics.lastPc = pc;
		}

		if (metrics.samePcStreak > metrics.maxSamePcStreak) {
			metrics.maxSamePcStreak = metrics.samePcStreak;
		}

		if (metrics.visitedPcs.size < 4096) {
			metrics.visitedPcs.add(pc);
		}

		system.step();

		if (system._cpureg[0x74] & 0x20) {
			metrics.pending.tm1 = true;
		}

		if (system._cpureg[0x74] & 0x04) {
			metrics.pending.tbl = true;
		}
	}

	if (guard >= MAX_GUARD) {
		throw new Error("execution guard tripped at pc=0x" + system.pc.toString(16));
	}
}

function withCapturedConsole(run) {
	var originalLog = console.log,
		originalError = console.error,
		logs = [],
		errors = [],
		result;

	console.log = function () {
		logs.push(Array.prototype.join.call(arguments, " "));
	};
	console.error = function () {
		errors.push(Array.prototype.join.call(arguments, " "));
	};

	try {
		result = run();
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}

	return {
		result: result,
		logs: logs,
		errors: errors
	};
}

function runScenario(scenario) {
	var system = new tamagotchi.system(),
		metrics = {
			irqCounts: { tm1: 0, tbl: 0 },
			clears: { tm1: 0, tbl: 0 },
			pending: { tm1: false, tbl: false },
			visitedPcs: new Set(),
			lastPc: -1,
			samePcStreak: 0,
			maxSamePcStreak: 0
		},
		spiEvents = [],
		captured,
		summary,
		originalFireIrq,
		originalWrite,
		round,
		button,
		i;

	if (scenario.figureName) {
		system.insert_figure(loadArrayBuffer(path.join(FILE_DIR, scenario.figureName)));
		system.inserted_figure = scenario.figureValue;
	}

	system.add_spi_event_hook(function (event) {
		spiEvents.push(event);
	});

	originalFireIrq = system.fire_irq;
	system.fire_irq = function (index) {
		if (index === 10) {
			metrics.irqCounts.tm1++;
		} else if (index === 13) {
			metrics.irqCounts.tbl++;
		}

		return originalFireIrq.call(this, index);
	};

	originalWrite = system.write;
	system.write = function (addr, value) {
		if (addr === 0x3074) {
			if (value & 0x20) {
				metrics.clears.tm1++;
			}
			if (value & 0x04) {
				metrics.clears.tbl++;
			}
		}

		return originalWrite.call(this, addr, value);
	};

	captured = withCapturedConsole(function () {
		var crash = null,
			release;

		try {
			for (i = 0; i < STARTUP_FRAMES; i++) {
				runFrame(system, null, metrics);
			}

			for (round = 0; round < BUTTON_ROUNDS; round++) {
				for (i = 0; i < BUTTONS.length; i++) {
					button = BUTTONS[i];
					for (release = 0; release < 5; release++) {
						runFrame(system, button, metrics);
					}
					for (release = 0; release < 15; release++) {
						runFrame(system, null, metrics);
					}
				}
			}
		} catch (error) {
			crash = error && error.stack ? error.stack : String(error);
		}

		return {
			pc: system.pc,
			lcd: system.get_lcd_state(),
			spiEvents: spiEvents.length,
			crash: crash
		};
	});

	summary = {
		name: scenario.name,
		figure: scenario.figureName || "none",
		finalPc: "0x" + captured.result.pc.toString(16),
		lcd: captured.result.lcd,
		spiEvents: captured.result.spiEvents,
		crash: captured.result.crash,
		irqCounts: metrics.irqCounts,
		clears: metrics.clears,
		pending: metrics.pending,
		visitedPcCount: metrics.visitedPcs.size,
		maxSamePcStreak: metrics.maxSamePcStreak,
		unhandledLogs: captured.logs.filter(function (line) {
			return line.indexOf("Unhandled register") !== -1;
		}),
		errorLogs: captured.errors
	};

	summary.pass =
		!summary.crash &&
		!summary.unhandledLogs.length &&
		summary.irqCounts.tm1 > 0 &&
		summary.irqCounts.tbl > 0 &&
		summary.clears.tm1 > 0 &&
		summary.clears.tbl > 0 &&
		summary.pending.tm1 &&
		summary.pending.tbl &&
		summary.visitedPcCount > 256 &&
		summary.maxSamePcStreak < 5000;

	return summary;
}

function main() {
	var bios = loadArrayBuffer(BIOS_PATH),
		scenarios = [
			createScenario("bios-only"),
			createScenario("makiko", "makiko.bin", 1),
			createScenario("shimashimatchi", "shimashimatchi.bin", 2)
		],
		failed = false,
		results = [],
		i,
		result;

	tamagotchi.system.prototype.bios = bios;

	for (i = 0; i < scenarios.length; i++) {
		result = runScenario(scenarios[i]);
		results.push(result);
		if (!result.pass) {
			failed = true;
		}
	}

	for (i = 0; i < results.length; i++) {
		result = results[i];
		console.log(
			"[rom-regression]",
			result.name,
			result.pass ? "PASS" : "FAIL",
			"pc=" + result.finalPc,
			"irq(tm1/tbl)=" + result.irqCounts.tm1 + "/" + result.irqCounts.tbl,
			"clear(tm1/tbl)=" + result.clears.tm1 + "/" + result.clears.tbl,
			"spi=" + result.spiEvents,
			"visited=" + result.visitedPcCount,
			"streak=" + result.maxSamePcStreak
		);

		if (!result.pass) {
			console.log(JSON.stringify(result, null, 2));
		}
	}

	if (failed) {
		process.exitCode = 1;
	}
}

main();
