Tamago - TamaTown for modern browsers
=====================================

Requirements
------------
 * Node.js 18+

Quick Start
-----------

推荐直接双击仓库根目录下的启动脚本：

 * macOS: `start-mac.command`
 * Windows: `start-windows.bat`

首次启动时，脚本会自动检查依赖；如果缺少依赖，会自动执行 `npm install`。
启动脚本会在本地拉起一个静态服务并自动打开默认浏览器。

详细的终端用户说明见 [docs/user-guide.md](/Users/xiyu/Documents/code/tamago/docs/user-guide.md)。

Manual Commands
---------------

如果你想手动启动，可以在仓库根目录运行：

```
npm install
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

当前仓库如果继续使用 `zhouxiyu1997/TamagotchiGO` 这个远端地址，默认访问地址会是：

```
https://zhouxiyu1997.github.io/TamagotchiGO/
```

项目里的脚本、样式和二进制资源都使用相对路径，因此作为 GitHub Pages 项目站点发布时不需要额外配置 base path。
