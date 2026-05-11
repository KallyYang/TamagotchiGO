var DEFAULT_FRAME_MS = 1000 / 60;
var DEFAULT_EXACT_BUDGET_MS = 15000;
var DEFAULT_EXACT_BUDGET_RATIO = 0.8;
var DEFAULT_MIN_EXACT_TAIL_MS = 30000;
var DEFAULT_MAX_EXACT_TAIL_MS = 5 * 60 * 1000;

function as_number(value, fallback) {
	value = Number(value);
	return isFinite(value) ? value : fallback;
}

function frame_count(durationMs, frameMs) {
	return Math.max(1, Math.round(durationMs / frameMs));
}

function frame_duration(frameCount, frameMs) {
	return Math.max(0, frameCount * frameMs);
}

function buildCatchupPlan(options) {
	var frameMs = Math.max(1, as_number(options.frameMs, DEFAULT_FRAME_MS)),
		deltaMs = Math.max(0, as_number(options.deltaMs, 0)),
		framesPerMs = Math.max(0.001, as_number(options.framesPerMs, 0.001)),
		exactBudgetMs = Math.max(1000, as_number(options.exactBudgetMs, DEFAULT_EXACT_BUDGET_MS)),
		exactBudgetRatio = Math.max(0.1, Math.min(0.95, as_number(options.exactBudgetRatio, DEFAULT_EXACT_BUDGET_RATIO))),
		minExactTailMs = Math.max(frameMs, as_number(options.minExactTailMs, DEFAULT_MIN_EXACT_TAIL_MS)),
		maxExactTailMs = Math.max(minExactTailMs, as_number(options.maxExactTailMs, DEFAULT_MAX_EXACT_TAIL_MS)),
		totalFrames = frame_count(deltaMs, frameMs),
		estimatedMs = totalFrames / framesPerMs,
		exactFrameBudget,
		exactFrames,
		exactMs,
		skippedMs;

	if (!deltaMs) {
		return {
			mode: "none",
			deltaMs: 0,
			totalFrames: 0,
			estimatedMs: 0,
			exactFrames: 0,
			exactMs: 0,
			exactEstimatedMs: 0,
			skippedMs: 0
		};
	}

	if (estimatedMs <= exactBudgetMs) {
		return {
			mode: "exact",
			deltaMs: deltaMs,
			totalFrames: totalFrames,
			estimatedMs: estimatedMs,
			exactFrames: totalFrames,
			exactMs: deltaMs,
			exactEstimatedMs: estimatedMs,
			skippedMs: 0
		};
	}

	exactFrameBudget = Math.max(
		frame_count(minExactTailMs, frameMs),
		Math.floor(framesPerMs * exactBudgetMs * exactBudgetRatio)
	);
	exactFrames = Math.min(
		totalFrames,
		Math.min(
			exactFrameBudget,
			frame_count(maxExactTailMs, frameMs)
		)
	);
	exactFrames = Math.max(1, exactFrames);
	exactMs = frame_duration(exactFrames, frameMs);
	skippedMs = Math.max(0, deltaMs - exactMs);

	return {
		mode: skippedMs > 0 ? "approximate" : "exact",
		deltaMs: deltaMs,
		totalFrames: totalFrames,
		estimatedMs: estimatedMs,
		exactFrames: exactFrames,
		exactMs: exactMs,
		exactEstimatedMs: exactFrames / framesPerMs,
		skippedMs: skippedMs
	};
}

module.exports = {
	DEFAULT_EXACT_BUDGET_MS: DEFAULT_EXACT_BUDGET_MS,
	DEFAULT_EXACT_BUDGET_RATIO: DEFAULT_EXACT_BUDGET_RATIO,
	DEFAULT_MAX_EXACT_TAIL_MS: DEFAULT_MAX_EXACT_TAIL_MS,
	DEFAULT_MIN_EXACT_TAIL_MS: DEFAULT_MIN_EXACT_TAIL_MS,
	buildCatchupPlan: buildCatchupPlan
};
