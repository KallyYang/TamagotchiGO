"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var http = require("http");
var path = require("path");

var MIN_NODE_MAJOR = 18;
var DEFAULT_HOST = "127.0.0.1";
var DEFAULT_PORT = 9001;
var ROOT_DIR = path.resolve(__dirname, "..");
var WEB_DIR = path.join(ROOT_DIR, "web");
var BUILD_OUTPUTS = [
  path.join(WEB_DIR, "tamagotchi.js"),
  path.join(WEB_DIR, "style", "runtime.css"),
];
var BUILD_INPUTS = [
  path.join(ROOT_DIR, "src"),
  path.join(ROOT_DIR, "less"),
  path.join(ROOT_DIR, "Gruntfile.js"),
];
var REQUIRED_PACKAGES = ["grunt", "grunt-cli", "browserify"];
var MIME_TYPES = {
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=UTF-8",
  ".eot": "application/vnd.ms-fontobject",
  ".html": "text/html; charset=UTF-8",
  ".js": "application/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=UTF-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
};

var shuttingDown = false;

function log(message) {
  console.log("[tamago]", message);
}

function fail(message, detail) {
  console.error("[tamago] " + message);
  if (detail) {
    console.error(detail);
  }
  process.exit(1);
}

function ensureNodeVersion() {
  var major = Number(process.versions.node.split(".")[0] || 0);
  if (major < MIN_NODE_MAJOR) {
    fail(
      "当前 Node.js 版本过低。请安装 Node.js " +
        MIN_NODE_MAJOR +
        "+ 后再启动。",
      "当前版本: v" + process.versions.node
    );
  }
}

function packageExists(name) {
  return fs.existsSync(path.join(ROOT_DIR, "node_modules", name, "package.json"));
}

function missingPackages() {
  return REQUIRED_PACKAGES.filter(function (name) {
    return !packageExists(name);
  });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runCommand(command, args, description) {
  log(description);

  var result = childProcess.spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });

  if (result.error) {
    fail(description + "失败。", result.error.message);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    fail(description + "失败。", "退出码: " + result.status);
  }
}

function ensureDependencies() {
  var missing = missingPackages();

  if (!missing.length) {
    return;
  }

  log("检测到缺少依赖: " + missing.join(", "));
  runCommand(npmCommand(), ["install"], "正在自动安装依赖，请稍候");

  missing = missingPackages();
  if (missing.length) {
    fail(
      "依赖安装后仍缺少关键包。",
      "仍缺少: " + missing.join(", ") + "\n请尝试手动运行 npm install。"
    );
  }
}

function pathStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (error) {
    return null;
  }
}

function newestMtime(targetPath) {
  var stat = pathStat(targetPath);
  var children;
  var newest;

  if (!stat) {
    return 0;
  }

  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  newest = stat.mtimeMs;
  children = fs.readdirSync(targetPath);
  children.forEach(function (name) {
    newest = Math.max(newest, newestMtime(path.join(targetPath, name)));
  });

  return newest;
}

function oldestOutputMtime() {
  var oldest = Infinity;
  var i;
  var stat;

  for (i = 0; i < BUILD_OUTPUTS.length; i++) {
    stat = pathStat(BUILD_OUTPUTS[i]);
    if (!stat) {
      return 0;
    }
    oldest = Math.min(oldest, stat.mtimeMs);
  }

  return oldest === Infinity ? 0 : oldest;
}

function buildNeeded() {
  var outputTime = oldestOutputMtime();
  var latestInput = 0;

  if (!outputTime) {
    return true;
  }

  BUILD_INPUTS.forEach(function (targetPath) {
    latestInput = Math.max(latestInput, newestMtime(targetPath));
  });

  return latestInput > outputTime;
}

function ensureBuild() {
  var gruntCli = path.join(ROOT_DIR, "node_modules", "grunt-cli", "bin", "grunt");

  if (!buildNeeded()) {
    return;
  }

  if (!fs.existsSync(gruntCli)) {
    fail(
      "找不到本地 grunt-cli，可先手动运行 npm install。",
      "缺少文件: " + gruntCli
    );
  }

  runCommand(process.execPath, [gruntCli], "正在构建前端资源");
}

function openBrowser(url) {
  var command;
  var args;
  var browserProcess;

  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    browserProcess = childProcess.spawn(command, args, {
      cwd: ROOT_DIR,
      detached: true,
      stdio: "ignore",
    });
    browserProcess.on("error", function () {
      log("自动打开浏览器失败，请手动访问: " + url);
    });
    browserProcess.unref();
  } catch (error) {
    log("自动打开浏览器失败，请手动访问: " + url);
  }
}

function safeJoin(basePath, requestPath) {
  var decoded;
  var normalized;
  var relative;

  try {
    decoded = decodeURIComponent(requestPath);
  } catch (error) {
    return null;
  }

  normalized = decoded.replace(/^\/+/, "");
  relative = path.normalize(normalized);

  if (
    relative === ".." ||
    relative.indexOf(".." + path.sep) === 0 ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  return path.join(basePath, relative);
}

function sendResponse(res, statusCode, body, headers) {
  var finalHeaders = headers || {};
  finalHeaders["Cache-Control"] = "no-cache";
  res.writeHead(statusCode, finalHeaders);
  res.end(body);
}

function serveFile(filePath, res) {
  var stat = pathStat(filePath);
  var ext;

  if (!stat) {
    sendResponse(res, 404, "Not Found", { "Content-Type": "text/plain; charset=UTF-8" });
    return;
  }

  if (stat.isDirectory()) {
    serveFile(path.join(filePath, "index.html"), res);
    return;
  }

  ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, function (error, data) {
    if (error) {
      sendResponse(
        res,
        500,
        "Internal Server Error",
        { "Content-Type": "text/plain; charset=UTF-8" }
      );
      return;
    }

    sendResponse(res, 200, data, {
      "Content-Length": data.length,
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    });
  });
}

function createServer() {
  return http.createServer(function (req, res) {
    var parsedPath = new URL(req.url, "http://127.0.0.1").pathname;
    var requestPath = parsedPath === "/" ? "/index.html" : parsedPath;
    var filePath = safeJoin(WEB_DIR, requestPath);

    if (parsedPath === "/favicon.ico" && !pathStat(path.join(WEB_DIR, "favicon.ico"))) {
      sendResponse(res, 204, "", {});
      return;
    }

    if (!filePath) {
      sendResponse(res, 403, "Forbidden", {
        "Content-Type": "text/plain; charset=UTF-8",
      });
      return;
    }

    serveFile(filePath, res);
  });
}

function listenOnPort(port, callback) {
  var server = createServer();

  server.once("error", function (error) {
    if (error && error.code === "EADDRINUSE") {
      listenOnPort(port + 1, callback);
      return;
    }

    fail("本地服务启动失败。", error && error.message);
  });

  server.listen(port, DEFAULT_HOST, function () {
    callback(server, port);
  });
}

function attachShutdown(server) {
  function shutdown(signalName) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log("收到 " + signalName + "，正在停止本地服务...");
    server.close(function () {
      process.exit(0);
    });
  }

  process.on("SIGINT", function () {
    shutdown("SIGINT");
  });

  process.on("SIGTERM", function () {
    shutdown("SIGTERM");
  });
}

function startServer() {
  listenOnPort(DEFAULT_PORT, function (server, port) {
    var url = "http://" + DEFAULT_HOST + ":" + port;
    attachShutdown(server);
    log("启动成功: " + url);
    log("浏览器没有自动打开的话，请手动访问上面的地址。");
    log("按 Ctrl+C 可以停止服务。");
    openBrowser(url);
  });
}

function main() {
  ensureNodeVersion();
  ensureDependencies();
  ensureBuild();
  startServer();
}

main();
