#!/usr/bin/env node
"use strict";

/**
 * Cloudflare KV 白名单管理脚本。
 *
 * 通过子进程调用 `wrangler kv` 操作账号条目。每条记录形如：
 *   key   = "user:<username>"
 *   value = JSON { username, algo: "pbkdf2-sha256", iterations, salt, hash, updatedAt }
 *
 * 用法：
 *   node ./scripts/users-kv.js add <username> <password> [--binding SAVE_KV] [--preview] [--remote]
 *   node ./scripts/users-kv.js remove <username>          [--binding SAVE_KV] [--preview] [--remote]
 *   node ./scripts/users-kv.js list                       [--binding SAVE_KV] [--preview] [--remote]
 *   node ./scripts/users-kv.js show <username>            [--binding SAVE_KV] [--preview] [--remote]
 *
 * 默认 binding=SAVE_KV，本地 wrangler dev (--local) 使用本地 miniflare KV；加 --remote 写入生产。
 */

var crypto = require("crypto");
var spawnSync = require("child_process").spawnSync;

var DEFAULT_BINDING = "SAVE_KV";
var KEY_PREFIX = "user:";
var USERNAME_PATTERN = /^[A-Za-z0-9_\-\.]{2,32}$/;
var DEFAULT_ITERATIONS = 200000;

function parseArgs(argv) {
  var args = { positional: [], binding: DEFAULT_BINDING, remote: false, preview: false };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === "--binding") {
      args.binding = argv[++i];
    } else if (a === "--remote") {
      args.remote = true;
    } else if (a === "--preview") {
      args.preview = true;
    } else if (a === "-h" || a === "--help" || a === "help") {
      args.help = true;
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function printUsage() {
  console.log("");
  console.log("Cloudflare KV account whitelist management");
  console.log("");
  console.log("Commands:");
  console.log("  add <username> <password>   Insert/update an account record in KV");
  console.log("  remove <username>           Delete an account record");
  console.log("  show <username>             Show the stored record (without raw password)");
  console.log("  list                        List all user:* keys");
  console.log("");
  console.log("Options:");
  console.log("  --binding <name>            KV binding name (default: SAVE_KV)");
  console.log("  --remote                    Operate on the remote (production) namespace");
  console.log("  --preview                   Operate on the preview namespace");
  console.log("");
  console.log("By default the local development namespace is used (matches `wrangler dev`).");
  console.log("");
}

function runWrangler(args, opts) {
  opts = opts || {};
  var cmd = process.platform === "win32" ? "npx.cmd" : "npx";
  var fullArgs = ["wrangler"].concat(args);
  var result = spawnSync(cmd, fullArgs, {
    stdio: opts.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    input: opts.input,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function buildScopeFlags(args) {
  var flags = ["--binding", args.binding];
  if (args.remote) {
    flags.push("--remote");
  }
  if (args.preview) {
    flags.push("--preview");
  }
  return flags;
}

function hashPassword(password) {
  var salt = crypto.randomBytes(16).toString("hex");
  var iterations = DEFAULT_ITERATIONS;
  var keyLen = 32;
  var hashBuf = crypto.pbkdf2Sync(password, Buffer.from(salt, "hex"), iterations, keyLen, "sha256");
  return {
    algo: "pbkdf2-sha256",
    iterations: iterations,
    salt: salt,
    hash: hashBuf.toString("hex"),
  };
}

function validateUsername(name) {
  if (!name) return "username is required";
  if (!USERNAME_PATTERN.test(name)) {
    return "username must be 2-32 chars (letters/digits/_/-/.)";
  }
  return "";
}

function validatePassword(password) {
  if (!password || password.length < 4) return "password must be at least 4 chars";
  if (password.length > 128) return "password must be at most 128 chars";
  return "";
}

function cmdAdd(args) {
  var username = args.positional[1];
  var password = args.positional[2];
  var error;
  error = validateUsername(username);
  if (error) {
    console.error("[error] " + error);
    process.exit(1);
  }
  error = validatePassword(password);
  if (error) {
    console.error("[error] " + error);
    process.exit(1);
  }

  var creds = hashPassword(password);
  var record = {
    username: username,
    algo: creds.algo,
    iterations: creds.iterations,
    salt: creds.salt,
    hash: creds.hash,
    updatedAt: new Date().toISOString(),
  };

  var key = KEY_PREFIX + username;
  var value = JSON.stringify(record);

  // wrangler kv key put <key> <value> --binding ...
  var wrArgs = ["kv", "key", "put", key, value].concat(buildScopeFlags(args));
  var result = runWrangler(wrArgs);
  if (result.status !== 0) {
    console.error("[error] wrangler exited with code " + result.status);
    process.exit(result.status || 1);
  }
  console.log("[ok] saved KV key '" + key + "' (algo=" + record.algo + ", iter=" + record.iterations + ")");
}

function cmdRemove(args) {
  var username = args.positional[1];
  var error = validateUsername(username);
  if (error) {
    console.error("[error] " + error);
    process.exit(1);
  }
  var key = KEY_PREFIX + username;
  var wrArgs = ["kv", "key", "delete", key].concat(buildScopeFlags(args));
  var result = runWrangler(wrArgs);
  if (result.status !== 0) {
    console.error("[error] wrangler exited with code " + result.status);
    process.exit(result.status || 1);
  }
  console.log("[ok] deleted KV key '" + key + "'");
}

function cmdShow(args) {
  var username = args.positional[1];
  var error = validateUsername(username);
  if (error) {
    console.error("[error] " + error);
    process.exit(1);
  }
  var key = KEY_PREFIX + username;
  var wrArgs = ["kv", "key", "get", key].concat(buildScopeFlags(args));
  var result = runWrangler(wrArgs, { captureStdout: true });
  if (result.status !== 0) {
    console.error("[error] wrangler exited with code " + result.status);
    process.exit(result.status || 1);
  }
  var stdout = (result.stdout || "").trim();
  if (!stdout) {
    console.log("(empty)");
    return;
  }
  try {
    var parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") {
      delete parsed.hash;
      delete parsed.salt;
      console.log(JSON.stringify(Object.assign({ key: key }, parsed), null, 2));
      return;
    }
  } catch (e) {}
  console.log(stdout);
}

function cmdList(args) {
  var wrArgs = ["kv", "key", "list", "--prefix", KEY_PREFIX].concat(buildScopeFlags(args));
  var result = runWrangler(wrArgs);
  if (result.status !== 0) {
    console.error("[error] wrangler exited with code " + result.status);
    process.exit(result.status || 1);
  }
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (args.help || !args.positional.length) {
    printUsage();
    process.exit(0);
  }

  var cmd = args.positional[0];
  if (cmd === "add") {
    cmdAdd(args);
  } else if (cmd === "remove" || cmd === "rm" || cmd === "del") {
    cmdRemove(args);
  } else if (cmd === "show") {
    cmdShow(args);
  } else if (cmd === "list" || cmd === "ls") {
    cmdList(args);
  } else {
    console.error("[error] unknown command: " + cmd);
    printUsage();
    process.exit(1);
  }
}

main();
