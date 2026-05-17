Tamago - TamaTown for modern browsers
=====================================

项目来源与贡献说明
------------------

本项目基于 Bryon Vandiver (`asterick`) 的原始仓库 `asterick/tamago` 继续整理和扩展。

原仓库的主要贡献包括：

 * 提供了可在浏览器中运行的 Tamago / TamaTown 模拟器基础工程
 * 建立了核心 CPU、内存映射和基础外设模拟框架
 * 提供了最初的页面结构、构建方式和 ROM 运行基础

当前仓库在此基础上，补充了更适合实际使用和继续维护的一些内容，包括：

 * macOS / Windows 一键启动脚本，以及更完整的终端用户说明
 * 本地静态服务启动脚本和 GitHub Pages 自动部署工作流
 * 内置人物芯片选择、自定义芯片拖拽载入
 * 声音输出改进、移动端音频解锁兼容、速度控制和更稳定的交互流程
 * EEPROM 存档导出 / 导入、本地存档说明，以及页面内的存档提示
 * SPI / 硬件寄存器日志，方便排查模拟器行为
 * 对外设模拟和运行时状态恢复的增强
 * 离线补时 / 后台返回后的自动追赶逻辑，用于尽量恢复离开页面期间的运行状态

Requirements
------------
 * Node.js 18+

Quick Start
-----------

推荐直接双击仓库根目录下的启动脚本：

 * macOS: `start-mac.command`
 * Windows: `start-windows.bat`

首次启动时，脚本会自动检查依赖；如果缺少依赖，会自动执行 `npm install`，并在需要时自动构建前端资源。
启动脚本会在本地拉起一个静态服务并自动打开默认浏览器，默认地址是 `http://127.0.0.1:9001`；如果端口被占用，会自动顺延到下一个可用端口。

详细的终端用户说明见 [docs/user-guide.md](docs/user-guide.md)。

Manual Commands
---------------

如果你想手动启动，可以在仓库根目录运行：

```
npm install
npm run start:app
```

`npm run start:app` 会先检查依赖，并在检测到 `web/` 构建产物过期或缺失时自动重新构建。

如果你希望显式地单独构建静态资源，也可以运行：

```
npm run build:web
npm run start:app
```

Development
-----------

开发模式会保留现有的 Grunt watch 行为：

```
npm install
npm run dev
```

默认会打开浏览器访问本地地址；如果浏览器没有自动打开，可以手动访问启动日志里显示的 `http://127.0.0.1:<port>`。

Validation
----------

为了方便继续维护，仓库还提供了两个可直接运行的回归脚本：

```
npm run test:rom
npm run test:runtime
```

其中：

 * `test:rom` 会检查 BIOS / 内置人物芯片在启动和按键交互下的基础运行情况
 * `test:runtime` 会检查运行时状态导出 / 导入、离线补时规划和恢复后的行为一致性

GitHub Pages
------------

仓库已经提供 GitHub Pages 工作流：

```
.github/workflows/deploy-pages.yml
```

推送到 `main` 分支后，GitHub Actions 会自动执行：

```
npm ci
npm run build:web
```

随后把 `web/` 目录作为静态站点发布到 GitHub Pages。

首次启用时，请到仓库 `Settings -> Pages`，将 `Source` 设置为 `GitHub Actions`。

项目里的脚本、样式和二进制资源都使用相对路径，因此作为 GitHub Pages 项目站点发布时不需要额外配置 base path。

Cloudflare Worker + KV 部署（云端存档）
--------------------------------------

仓库新增了一份可直接部署到 Cloudflare 的 Worker 配置，可以同时承担两件事：

 * 通过 Workers 的 Static Assets 托管 `web/` 静态站点；
 * 提供 `/api/save` 端点，把 EEPROM 存档存放在 Cloudflare KV，跨设备共享。

涉及的新文件：

 * [`wrangler.toml`](wrangler.toml) — Wrangler 配置
 * [`worker/worker.js`](worker/worker.js) — Worker 入口（静态资源 + `/api/save`）
 * [`src/tamago/cloud_save.js`](src/tamago/cloud_save.js) — 浏览器端的云同步客户端

部署步骤（Wrangler v3 / v4 均可）：

```bash
# 1. 安装 wrangler（首次）
npm install -g wrangler
wrangler login

# 2. 创建 KV 命名空间，并把得到的 id / preview_id 写入 wrangler.toml
wrangler kv namespace create tamago-saves
wrangler kv namespace create tamago-saves --preview

# 3. 可选：开启鉴权令牌（不配置时 API 完全公开）
wrangler secret put SAVE_TOKEN

# 4. 构建静态资源 & 部署
npm install
npm run build:web
wrangler deploy
```

部署成功后访问 Worker 的域名即可使用模拟器；页面顶部会自动检测 `/api/save/health`，
检测到 KV 已绑定时会显示 `☁ 上传到云端` / `☁ 从云端下载` / `云同步设置` 三个按钮：

 * `☁ 上传到云端`：把当前 EEPROM 存档以 `tamago-eeprom-v1` 的格式 `PUT` 到 KV
 * `☁ 从云端下载`：从 KV 拉取存档并热替换到模拟器
 * `云同步设置`：设置 `slot`（默认 `default`，仅允许字母 / 数字 / `_` / `-`，最长 64 字符）和 `SAVE_TOKEN`，两者都保存在浏览器本地。

API 简表：

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| `GET` | `/api/save/health` | 探测端点，返回 `{ok, hasToken, kvBound}` |
| `GET` | `/api/save?slot=xxx` | 拉取指定 slot 的存档 |
| `PUT` | `/api/save?slot=xxx` | 写入存档（请求体格式同导出 JSON） |
| `DELETE` | `/api/save?slot=xxx` | 删除存档 |

如果配置了 `SAVE_TOKEN`，所有读写都需要在 `X-Save-Token` 请求头或 `?token=` query 中带上同样的值。

> 注意：Cloudflare KV 不适合存超过 25 MiB 的内容，本仓库的 EEPROM 默认 4 KiB，远低于限制。
> Worker 端额外做了 64 KiB hex 上限校验，避免被填满。

本地调试 Worker（可选）：

```bash
npm run build:web
npx wrangler dev
# 默认端口 8787，浏览器打开 http://127.0.0.1:8787 即可
```

页面功能与存档说明
------------------

当前页面内已经提供这些更适合直接使用的功能：

 * `1x / 2x / 4x / 8x / 16x` 速度控制
 * 更稳定的声音输出，以及移动端首次交互后的音频解锁兼容
 * 页面内的“寄存器日志”面板，可查看声音 / SPI / 部分硬件事件
 * EEPROM 存档导出 / 导入，以及页面内的本地存档提示
 * 页面回到前台后的自动补时状态提示与进度展示

项目的 EEPROM 存档默认保存在当前浏览器的 `localStorage` 中，不会上传到任何服务器，也不会自动在不同设备或不同浏览器之间同步。

这意味着：

 * 同一台设备、同一个浏览器、同一个站点地址下，刷新页面或下次再打开时，存档通常会继续保留。
 * 如果用户清理浏览器数据、使用无痕模式、换浏览器或换设备，原有本地存档不会自动带过去。
 * 页面里的“导出存档 / 导入存档”按钮可用于手动备份和恢复。
 * 页面切到后台或离开一段时间后，再次返回时会尽量按离线时长自动追赶运行状态。

如果你主要是给普通终端用户使用，建议优先让他们从双击启动脚本进入，并配合 [docs/user-guide.md](docs/user-guide.md) 一起分发。

License
-------

仓库维护者新增或原创的代码，按 `GPL-3.0-or-later` 提供。

但本仓库同时包含：

 * 源自上游 `asterick/tamago` 的历史代码与衍生修改
 * 第三方字体与相关样式资源
 * `.bin` 二进制文件及其他需单独确认权利来源的资源

因此，请不要简单理解为“仓库内全部内容都已被维护者重新授权为 GPL”。具体边界和再分发注意事项见 [NOTICE](NOTICE)。
