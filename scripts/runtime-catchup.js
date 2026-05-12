"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var offlineCatchup = require("../src/tamago/offline_catchup.js");
var tamagotchi = require("../src/tamago/cpu/tamagotchi.js");

var ROOT_DIR = path.resolve(__dirname, "..");
var FILE_DIR = path.join(ROOT_DIR, "web", "files");
var BIOS_PATH = path.join(FILE_DIR, "tamago.bin");
var MAKIKO_PATH = path.join(FILE_DIR, "makiko.bin");
var SHIMA_PATH = path.join(FILE_DIR, "shimashimatchi.bin");
var PRE_FRAMES = 60;
var CATCHUP_FRAMES = 90;
var VERIFY_FRAMES = 30;
var BENCHMARK_FRAMES = 30;
var BUDGET_MS = 15000;
var THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
var FRAME_SECONDS = 1 / 60;

function loadArrayBuffer(filePath) {
	var data = fs.readFileSync(filePath);
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function createScenario(name, figureValue, figureData, includeSpiRom) {
	return {
		name: name,
		figureValue: figureValue,
		figureData: figureData || null,
		includeSpiRom: includeSpiRom !== false
	};
}

function createSystem(scenario) {
	var system = new tamagotchi.system();

	system.keys = 0x0F;
	if (scenario && scenario.figureData) {
		system.insert_figure(scenario.figureData);
		system.inserted_figure = scenario.figureValue || 0;
	}

	return system;
}

function exportFullState(system) {
	var state = system.export_state({
		includeSpiRom: true
	});

	if (state.timing) {
		state.timing.previousClock = 0;
	}

	return JSON.stringify(state);
}

function importState(system, snapshot, scenario) {
	return system.import_state(snapshot, {
		figureData: scenario && !scenario.includeSpiRom ? scenario.figureData : null
	});
}

function runFrames(system, frameCount) {
	system.keys = 0x0F;
	system.run_virtual_frames(frameCount);
}

function assertSameState(label, left, right) {
	assert.strictEqual(exportFullState(left), exportFullState(right), label);
}

function attachIrPlayback(system) {
	system.set_ir_response_trace({
		id: "ir-playback-test",
		createdAt: "2026-05-10T00:00:00.000Z",
		figure: system.inserted_figure || 0,
		figureName: system.inserted_figure === 2 ? "shimashimatchi" : "makiko",
		durationCycles: 96,
		name: "ir-playback-test",
		events: [
			{ type: "strobe", cycle: 0, pc: 0, strobe: 0x55, txLine: false, altTxLine: false, value: 0x55 },
			{ type: "tx", cycle: 16, pc: 0, strobe: 0x55, txLine: true, altTxLine: false, value: 1 },
			{ type: "tx", cycle: 48, pc: 0, strobe: 0x55, txLine: false, altTxLine: false, value: 0 },
			{ type: "tx", cycle: 96, pc: 0, strobe: 0x55, txLine: true, altTxLine: false, value: 1 }
		]
	});
	system.write(0x3013, 0x55);
}

function testSnapshotRoundTrip(scenario) {
	var original = createSystem(scenario);
	var restored = createSystem();
	var snapshot;

	runFrames(original, PRE_FRAMES);
	attachIrPlayback(original);
	snapshot = original.export_state({
		includeSpiRom: scenario.includeSpiRom
	});

	assert(importState(restored, snapshot, scenario), scenario.name + " should import initial snapshot");
	assertSameState(scenario.name + " round-trip should preserve immediate state", original, restored);

	runFrames(original, VERIFY_FRAMES);
	runFrames(restored, VERIFY_FRAMES);
	assertSameState(scenario.name + " round-trip should stay deterministic after more frames", original, restored);
}

function testSameSessionCatchup(scenario) {
	var baseline = createSystem(scenario);
	var live = createSystem(scenario);

	runFrames(baseline, PRE_FRAMES);
	runFrames(live, PRE_FRAMES);
	attachIrPlayback(baseline);
	attachIrPlayback(live);
	runFrames(baseline, CATCHUP_FRAMES);
	runFrames(live, CATCHUP_FRAMES);
	assertSameState(scenario.name + " same-session catch-up should match uninterrupted execution", baseline, live);
}

function testRestoreThenCatchup(scenario) {
	var baseline = createSystem(scenario);
	var saved = createSystem(scenario);
	var restored = createSystem();
	var snapshot;

	runFrames(baseline, PRE_FRAMES);
	runFrames(saved, PRE_FRAMES);
	attachIrPlayback(baseline);
	attachIrPlayback(saved);
	runFrames(baseline, CATCHUP_FRAMES);
	snapshot = saved.export_state({
		includeSpiRom: scenario.includeSpiRom
	});

	assert(importState(restored, snapshot, scenario), scenario.name + " should import saved snapshot");
	runFrames(restored, CATCHUP_FRAMES);
	runFrames(baseline, VERIFY_FRAMES);
	runFrames(restored, VERIFY_FRAMES);
	assertSameState(scenario.name + " restore + catch-up should match uninterrupted execution", baseline, restored);
}

function testIrStateSnapshot(scenario) {
	var original = createSystem(scenario);
	var restored = createSystem();
	var snapshot;

	runFrames(original, 60);
	attachIrPlayback(original);
	snapshot = original.export_state({
		includeSpiRom: scenario.includeSpiRom
	});

	assert(importState(restored, snapshot, scenario), "IR snapshot should import");
	assertSameState("IR response trace playback should survive snapshot restore", original, restored);
}

function testPartialFrameSnapshot(scenario) {
	var original = createSystem(scenario);
	var restored = createSystem();
	var snapshot;

	original.speed_multiplier = 16;
	original.process_frame_slice(FRAME_SECONDS / 2, {
		updateClock: false
	});
	snapshot = original.export_state({
		includeSpiRom: scenario.includeSpiRom
	});

	assert(importState(restored, snapshot, scenario), scenario.name + " should import partial-frame snapshot");
	assertSameState(scenario.name + " partial-frame progress should survive snapshot restore", original, restored);
}

function testSpeedMultiplierScaling() {
	var expectedCycles = tamagotchi.system.prototype.CLOCK_RATE * FRAME_SECONDS;
	var speeds = [1, 2, 4, 8, 16];
	var i;
	var system;
	var frame;

	for (i = 0; i < speeds.length; i++) {
		system = createSystem();
		system.speed_multiplier = speeds[i];
		frame = system.process_frame_slice(FRAME_SECONDS, {
			updateClock: false
		});

		assert.strictEqual(
			frame.frameEvents,
			speeds[i],
			"speed " + speeds[i] + "x should replay one virtual frame per multiplier step"
		);
		assert(
			Math.abs(frame.cycles - (expectedCycles * speeds[i])) < 1e-6,
			"speed " + speeds[i] + "x should scale cycle budget linearly"
		);
	}
}

function testBudgetEstimate(scenario) {
	var snapshotSource = createSystem(scenario);
	var probe = createSystem();
	var startedAtMs;
	var elapsedMs;
	var framesPerMs;
	var totalFrames = 30 * 24 * 60 * 60 * 60;
	var estimatedMs;

	runFrames(snapshotSource, PRE_FRAMES);
	assert(
		importState(
			probe,
			snapshotSource.export_state({ includeSpiRom: scenario.includeSpiRom }),
			scenario
		),
		"budget probe should import"
	);

	startedAtMs = Date.now();
	runFrames(probe, BENCHMARK_FRAMES);
	elapsedMs = Math.max(1, Date.now() - startedAtMs);
	framesPerMs = BENCHMARK_FRAMES / elapsedMs;
	estimatedMs = totalFrames / framesPerMs;

	assert(
		estimatedMs > BUDGET_MS,
		"30 days of offline frames should exceed the " + BUDGET_MS + "ms catch-up budget"
	);

	return {
		framesPerMs: framesPerMs,
		estimatedMs: estimatedMs
	};
}

function testCatchupPlanner(framesPerMs) {
	var shortPlan = offlineCatchup.buildCatchupPlan({
		deltaMs: 10 * 1000,
		frameMs: 1000 / 60,
		framesPerMs: framesPerMs,
		exactBudgetMs: BUDGET_MS
	});
	var longPlan = offlineCatchup.buildCatchupPlan({
		deltaMs: THREE_DAYS_MS,
		frameMs: 1000 / 60,
		framesPerMs: framesPerMs,
		exactBudgetMs: BUDGET_MS
	});

	assert.strictEqual(shortPlan.mode, "exact", "short offline gaps should stay on exact replay");
	assert.strictEqual(longPlan.mode, "approximate", "3 days should enter fast restore mode");
	assert(longPlan.skippedMs > 0, "fast restore mode should compress part of the offline gap");
	assert(
		longPlan.exactEstimatedMs <= BUDGET_MS,
		"fast restore exact tail should stay within the exact replay budget"
	);
	assert(
		longPlan.exactMs <= offlineCatchup.DEFAULT_MAX_EXACT_TAIL_MS,
		"fast restore exact tail should respect the configured max tail window"
	);
	assert(
		longPlan.exactMs >= offlineCatchup.DEFAULT_MIN_EXACT_TAIL_MS,
		"fast restore exact tail should keep a meaningful exact replay window"
	);

	return longPlan;
}

function main() {
	var bios = loadArrayBuffer(BIOS_PATH);
	var makiko = loadArrayBuffer(MAKIKO_PATH);
	var shima = loadArrayBuffer(SHIMA_PATH);
	var scenarios;
	var budget;
	var planner;
	var i;

	tamagotchi.system.prototype.bios = bios;
	scenarios = [
		createScenario("none", 0, null, true),
		createScenario("makiko-builtin", 1, makiko, false),
		createScenario("shimashimatchi-builtin", 2, shima, false),
		createScenario("custom-figure", 3, makiko, true)
	];

	for (i = 0; i < scenarios.length; i++) {
		testSnapshotRoundTrip(scenarios[i]);
		testSameSessionCatchup(scenarios[i]);
		testRestoreThenCatchup(scenarios[i]);
	}

	testIrStateSnapshot(scenarios[1]);
	testPartialFrameSnapshot(scenarios[0]);
	testSpeedMultiplierScaling();
	budget = testBudgetEstimate(scenarios[0]);
	planner = testCatchupPlanner(budget.framesPerMs);

	console.log(
		"[runtime-catchup] PASS",
		"scenarios=" + scenarios.length,
		"framesPerMs=" + budget.framesPerMs.toFixed(3),
		"estimateMs=" + budget.estimatedMs.toFixed(0),
		"fastRestoreExactMs=" + planner.exactMs.toFixed(0),
		"fastRestoreSkippedMs=" + planner.skippedMs.toFixed(0)
	);
}

main();
