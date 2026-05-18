var SESSION_KEY = "tamago_session_v1",
  USERS_URL = "files/users.json",
  AUTH_LOGIN_PATH = "/api/auth/login",
  AUTH_HEALTH_PATH = "/api/auth/health",
  USERNAME_PATTERN = /^[A-Za-z0-9_\-\.\u4e00-\u9fa5]{2,32}$/;

var whitelistCache = null,
  whitelistPromise = null,
  remoteAuthAvailable = null,
  remoteAuthProbe = null;

function getStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch (e) {}
  return null;
}

function readSession() {
  var store = getStorage(),
    raw,
    parsed;

  if (!store) {
    return null;
  }

  try {
    raw = store.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }
    parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.accountId && parsed.username) {
      return parsed;
    }
  } catch (e) {}

  return null;
}

function writeSession(session) {
  var store = getStorage();
  if (!store) {
    return false;
  }
  try {
    if (session) {
      store.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      store.removeItem(SESSION_KEY);
    }
    return true;
  } catch (e) {
    return false;
  }
}

function fetchWhitelist() {
  if (whitelistCache) {
    return Promise.resolve(whitelistCache);
  }
  if (whitelistPromise) {
    return whitelistPromise;
  }

  whitelistPromise = new Promise(function (resolve) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", USERS_URL + "?t=" + Date.now(), true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }

      var parsed = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch (e) {
          parsed = null;
        }
      }

      if (!parsed || !Array.isArray(parsed.users)) {
        whitelistCache = { users: [] };
      } else {
        whitelistCache = { users: parsed.users };
      }
      whitelistPromise = null;
      resolve(whitelistCache);
    };
    try {
      xhr.send();
    } catch (e) {
      whitelistCache = { users: [] };
      whitelistPromise = null;
      resolve(whitelistCache);
    }
  });

  return whitelistPromise;
}

function bufferToHex(buffer) {
  var view = new Uint8Array(buffer),
    out = "",
    i;
  for (i = 0; i < view.length; i++) {
    out += (0x100 | view[i]).toString(16).slice(1);
  }
  return out;
}

function hexToBytes(hex) {
  if (typeof hex !== "string") {
    return null;
  }
  hex = hex.trim();
  if (hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return null;
  }
  var out = new Uint8Array(hex.length / 2),
    i;
  for (i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  var diff = 0,
    i;
  for (i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function pbkdf2Sha256(password, salt, iterations, keyLengthBytes) {
  if (
    typeof window === "undefined" ||
    !window.crypto ||
    !window.crypto.subtle ||
    typeof TextEncoder === "undefined"
  ) {
    return Promise.reject(new Error("WebCrypto unavailable"));
  }

  var enc = new TextEncoder();
  var saltBytes = hexToBytes(salt);
  if (!saltBytes) {
    return Promise.reject(new Error("Invalid salt"));
  }

  return window.crypto.subtle
    .importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"])
    .then(function (key) {
      return window.crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: saltBytes,
          iterations: iterations,
          hash: "SHA-256",
        },
        key,
        keyLengthBytes * 8
      );
    })
    .then(function (bits) {
      return bufferToHex(bits);
    });
}

function digestSha256(text) {
  if (
    typeof window === "undefined" ||
    !window.crypto ||
    !window.crypto.subtle ||
    typeof TextEncoder === "undefined"
  ) {
    return Promise.reject(new Error("WebCrypto unavailable"));
  }
  return window.crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then(function (buffer) {
      return bufferToHex(buffer);
    });
}

function computeHash(record, password) {
  var algo = (record.algo || "pbkdf2-sha256").toLowerCase();

  if (algo === "pbkdf2-sha256") {
    var iterations = Number(record.iterations) || 200000;
    var keyLength = (record.hash && record.hash.length / 2) || 32;
    return pbkdf2Sha256(password, record.salt || "", iterations, keyLength);
  }

  if (algo === "sha256") {
    return digestSha256((record.salt || "") + "|" + password);
  }

  return Promise.reject(new Error("Unsupported algo: " + record.algo));
}

function normalizeUsername(name) {
  return (name || "").trim();
}

function validateUsername(name) {
  if (!name) {
    return "请输入账号名";
  }
  if (!USERNAME_PATTERN.test(name)) {
    return "账号名格式不合法";
  }
  return "";
}

function validatePassword(password) {
  if (!password) {
    return "请输入密码";
  }
  if (password.length > 128) {
    return "密码长度过长";
  }
  return "";
}

function findRecord(users, username) {
  var i;
  for (i = 0; i < users.length; i++) {
    if (users[i] && users[i].username === username) {
      return users[i];
    }
  }
  return null;
}

function deriveAccountId(username) {
  return "wl_" + encodeURIComponent(username).replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
}

function probeRemoteAuth() {
  if (remoteAuthAvailable !== null) {
    return Promise.resolve(remoteAuthAvailable);
  }
  if (remoteAuthProbe) {
    return remoteAuthProbe;
  }
  if (typeof fetch !== "function") {
    remoteAuthAvailable = false;
    return Promise.resolve(false);
  }

  remoteAuthProbe = fetch(AUTH_HEALTH_PATH, { method: "GET", cache: "no-store" })
    .then(function (resp) {
      if (!resp.ok) {
        remoteAuthAvailable = false;
        return false;
      }
      return resp.json().then(
        function (json) {
          remoteAuthAvailable = Boolean(json && json.ok && json.kvBound);
          return remoteAuthAvailable;
        },
        function () {
          remoteAuthAvailable = false;
          return false;
        }
      );
    })
    .catch(function () {
      remoteAuthAvailable = false;
      return false;
    })
    .then(function (value) {
      remoteAuthProbe = null;
      return value;
    });

  return remoteAuthProbe;
}

function loginRemote(username, password) {
  if (typeof fetch !== "function") {
    return Promise.resolve({ ok: false, transport: false });
  }

  return fetch(AUTH_LOGIN_PATH, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: username, password: password }),
  })
    .then(function (resp) {
      return resp
        .json()
        .then(
          function (json) {
            return { resp: resp, json: json };
          },
          function () {
            return { resp: resp, json: null };
          }
        )
        .then(function (entry) {
          var resp = entry.resp,
            json = entry.json || {};

          if (resp.status === 200 && json.ok) {
            var name =
              (json.account && json.account.username) || username;
            return { ok: true, transport: true, account: { username: name } };
          }
          if (resp.status === 401) {
            return { ok: false, transport: true, reason: "账号或密码错误" };
          }
          if (resp.status === 500 && json.error === "kv_not_bound") {
            return { ok: false, transport: false };
          }
          if (resp.status >= 500) {
            return { ok: false, transport: true, reason: "服务端校验失败，请稍后再试" };
          }
          return {
            ok: false,
            transport: true,
            reason: "登录失败：" + (json.error || ("http_" + resp.status)),
          };
        });
    })
    .catch(function () {
      return { ok: false, transport: false };
    });
}

function loginLocal(username, password, done) {
  fetchWhitelist().then(function (data) {
    var users = (data && data.users) || [];
    if (!users.length) {
      done({
        ok: false,
        reason:
          "尚未配置任何账号，请联系管理员通过 Cloudflare KV 或后台白名单文件添加。",
      });
      return;
    }

    var record = findRecord(users, username);
    if (!record || !record.hash) {
      done({ ok: false, reason: "账号或密码错误" });
      return;
    }

    computeHash(record, password).then(
      function (hash) {
        if (!constantTimeEqual(String(hash || ""), String(record.hash || ""))) {
          done({ ok: false, reason: "账号或密码错误" });
          return;
        }
        finishSuccess(username, done);
      },
      function () {
        done({
          ok: false,
          reason: "无法在当前浏览器完成密码校验（缺少 WebCrypto 支持）。",
        });
      }
    );
  });
}

function finishSuccess(username, done) {
  var account = {
    id: deriveAccountId(username),
    username: username,
  };
  var session = {
    accountId: account.id,
    username: account.username,
    loginAt: +new Date(),
  };
  writeSession(session);
  done({ ok: true, account: account, session: session });
}

function login(username, password, done) {
  username = normalizeUsername(username);

  var error = validateUsername(username);
  if (error) {
    done({ ok: false, reason: error });
    return;
  }
  error = validatePassword(password);
  if (error) {
    done({ ok: false, reason: error });
    return;
  }

  probeRemoteAuth().then(function (available) {
    if (!available) {
      loginLocal(username, password, done);
      return;
    }

    loginRemote(username, password).then(function (result) {
      if (result.ok) {
        finishSuccess(
          (result.account && result.account.username) || username,
          done
        );
        return;
      }
      if (result.transport === false) {
        loginLocal(username, password, done);
        return;
      }
      done({ ok: false, reason: result.reason || "账号或密码错误" });
    });
  });
}

function logout() {
  writeSession(null);
}

function getCurrentSession() {
  return readSession();
}

function accountStorageKey(accountId, baseKey) {
  return "tamago_acc_" + accountId + "_" + baseKey;
}

function reloadWhitelist() {
  whitelistCache = null;
  whitelistPromise = null;
  return fetchWhitelist();
}

module.exports = {
  login: login,
  logout: logout,
  getCurrentSession: getCurrentSession,
  accountStorageKey: accountStorageKey,
  reloadWhitelist: reloadWhitelist,
};
