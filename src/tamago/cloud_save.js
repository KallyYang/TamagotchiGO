/**
 * 云端存档客户端：与同源 Cloudflare Worker 上的 /api/save 端点交互。
 *
 * 设计原则：
 * - 完全可选，端点不可用时（404 / 网络错误）调用方应回退到本地存档逻辑。
 * - Token 与 slot 都存在 localStorage，不会随存档导出。
 * - 仅依赖浏览器原生 fetch，避免引入额外依赖。
 */

var TOKEN_KEY = "tamago_cloud_token";
var SLOT_KEY = "tamago_cloud_slot";
var DEFAULT_SLOT = "default";
var HEALTH_PATH = "/api/save/health";
var SAVE_PATH = "/api/save";

function safeStorage() {
	try {
		if (typeof window !== "undefined" && window.localStorage) {
			return window.localStorage;
		}
	} catch (e) {}
	return null;
}

function getToken() {
	var store = safeStorage();
	return store ? store.getItem(TOKEN_KEY) || "" : "";
}

function setToken(value) {
	var store = safeStorage();
	if (!store) return;
	if (value) {
		store.setItem(TOKEN_KEY, value);
	} else {
		store.removeItem(TOKEN_KEY);
	}
}

function getSlot() {
	var store = safeStorage();
	if (!store) return DEFAULT_SLOT;
	var slot = store.getItem(SLOT_KEY);
	return slot && /^[A-Za-z0-9_-]{1,64}$/.test(slot) ? slot : DEFAULT_SLOT;
}

function setSlot(value) {
	var store = safeStorage();
	if (!store) return false;
	if (!value) {
		store.removeItem(SLOT_KEY);
		return true;
	}
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
		return false;
	}
	store.setItem(SLOT_KEY, value);
	return true;
}

function buildUrl(path) {
	return path + "?slot=" + encodeURIComponent(getSlot());
}

function buildHeaders(extra) {
	var headers = extra || {};
	var token = getToken();
	if (token) {
		headers["X-Save-Token"] = token;
	}
	return headers;
}

function isAvailable() {
	if (typeof window === "undefined" || typeof fetch !== "function") {
		return Promise.resolve({ available: false });
	}

	return fetch(HEALTH_PATH, { method: "GET", cache: "no-store" })
		.then(function (resp) {
			if (!resp.ok) {
				return { available: false };
			}
			return resp.json().then(
				function (json) {
					return {
						available: Boolean(json && json.ok && json.kvBound),
						hasToken: Boolean(json && json.hasToken),
					};
				},
				function () {
					return { available: false };
				}
			);
		})
		.catch(function () {
			return { available: false };
		});
}

function pull() {
	return fetch(buildUrl(SAVE_PATH), {
		method: "GET",
		cache: "no-store",
		headers: buildHeaders(),
	}).then(function (resp) {
		if (resp.status === 404) {
			return { ok: false, reason: "not_found" };
		}
		if (resp.status === 401) {
			return { ok: false, reason: "unauthorized" };
		}
		if (!resp.ok) {
			return { ok: false, reason: "http_" + resp.status };
		}
		return resp.json().then(function (json) {
			if (!json || !json.payload) {
				return { ok: false, reason: "empty_payload" };
			}
			return { ok: true, payload: json.payload };
		});
	});
}

function push(payload) {
	if (!payload || payload.format !== "tamago-eeprom-v1") {
		return Promise.resolve({ ok: false, reason: "invalid_payload" });
	}

	return fetch(buildUrl(SAVE_PATH), {
		method: "PUT",
		cache: "no-store",
		headers: buildHeaders({ "Content-Type": "application/json" }),
		body: JSON.stringify({
			format: payload.format,
			bytes: payload.bytes,
			data: payload.data,
		}),
	}).then(function (resp) {
		if (resp.status === 401) {
			return { ok: false, reason: "unauthorized" };
		}
		if (!resp.ok) {
			return { ok: false, reason: "http_" + resp.status };
		}
		return resp.json().then(
			function (json) {
				return { ok: true, updatedAt: json && json.updatedAt };
			},
			function () {
				return { ok: true };
			}
		);
	});
}

module.exports = {
	isAvailable: isAvailable,
	pull: pull,
	push: push,
	getToken: getToken,
	setToken: setToken,
	getSlot: getSlot,
	setSlot: setSlot,
	DEFAULT_SLOT: DEFAULT_SLOT,
};
