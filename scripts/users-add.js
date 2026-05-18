#!/usr/bin/env node
"use strict";

var fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");

var USERS_FILE = path.join(__dirname, "..", "web", "files", "users.json");
var USERNAME_PATTERN = /^[A-Za-z0-9_\-\.\u4e00-\u9fa5]{2,32}$/;

function printUsage() {
  console.log("");
  console.log("Tamago account management (whitelist)");
  console.log("");
  console.log("Usage:");
  console.log("  node scripts/users-add.js add <username> <password>");
  console.log("  node scripts/users-add.js remove <username>");
  console.log("  node scripts/users-add.js list");
  console.log("");
  console.log("Notes:");
  console.log("  - Edits the whitelist at web/files/users.json");
  console.log("  - Passwords are hashed with PBKDF2-SHA256 (200000 iter)");
  console.log("  - Front-end only reads username + salt + hash; plain password is never stored");
  console.log("");
}

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    return { format: "tamago-users-v1", users: [] };
  }
  var raw = fs.readFileSync(USERS_FILE, "utf8").trim();
  if (!raw) {
    return { format: "tamago-users-v1", users: [] };
  }
  var parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    return { format: "tamago-users-v1", users: [] };
  }
  if (!Array.isArray(parsed.users)) {
    parsed.users = [];
  }
  parsed.format = "tamago-users-v1";
  return parsed;
}

function writeUsers(payload) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function hashPassword(password, salt) {
  var iterations = 200000;
  var hashBuf = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return {
    algo: "pbkdf2-sha256",
    iterations: iterations,
    salt: salt,
    hash: hashBuf.toString("hex"),
  };
}

function validateUsername(name) {
  if (!name) return "Username is required";
  if (!USERNAME_PATTERN.test(name)) {
    return "Username must be 2-32 chars (letters/digits/_/-/. or CJK)";
  }
  return "";
}

function validatePassword(password) {
  if (!password || password.length < 4) return "Password must be at least 4 chars";
  if (password.length > 64) return "Password must be at most 64 chars";
  return "";
}

function cmdAdd(username, password) {
  var err;
  err = validateUsername(username);
  if (err) {
    console.error("[error] " + err);
    process.exit(1);
  }
  err = validatePassword(password);
  if (err) {
    console.error("[error] " + err);
    process.exit(1);
  }

  var data = readUsers();
  var salt = crypto.randomBytes(16).toString("hex");
  var creds = hashPassword(password, salt);

  var existing = data.users.findIndex(function (u) {
    return u && u.username === username;
  });

  var record = {
    username: username,
    algo: creds.algo,
    iterations: creds.iterations,
    salt: creds.salt,
    hash: creds.hash,
    updatedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    data.users[existing] = record;
    writeUsers(data);
    console.log("[ok] updated user '" + username + "'");
  } else {
    data.users.push(record);
    writeUsers(data);
    console.log("[ok] added user '" + username + "'");
  }
}

function cmdRemove(username) {
  var data = readUsers();
  var before = data.users.length;
  data.users = data.users.filter(function (u) {
    return !u || u.username !== username;
  });
  if (data.users.length === before) {
    console.error("[warn] user '" + username + "' not found");
    process.exit(1);
  }
  writeUsers(data);
  console.log("[ok] removed user '" + username + "'");
}

function cmdList() {
  var data = readUsers();
  if (!data.users.length) {
    console.log("(no users)");
    return;
  }
  data.users.forEach(function (u) {
    console.log(
      "- " + u.username + "   algo=" + u.algo + "   updatedAt=" + (u.updatedAt || "-")
    );
  });
}

function main() {
  var args = process.argv.slice(2);
  if (!args.length) {
    printUsage();
    process.exit(0);
  }

  var cmd = args[0];
  if (cmd === "add") {
    if (args.length < 3) {
      console.error("[error] usage: add <username> <password>");
      process.exit(1);
    }
    cmdAdd(args[1], args[2]);
  } else if (cmd === "remove" || cmd === "rm" || cmd === "del") {
    if (args.length < 2) {
      console.error("[error] usage: remove <username>");
      process.exit(1);
    }
    cmdRemove(args[1]);
  } else if (cmd === "list" || cmd === "ls") {
    cmdList();
  } else if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    printUsage();
  } else {
    console.error("[error] unknown command: " + cmd);
    printUsage();
    process.exit(1);
  }
}

main();
