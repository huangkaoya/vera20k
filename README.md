# 王二火大 · VERA 网页客户端

将 VERA 的完整 Rust 客户端编译到 WASM/WebGPU：沿用原有菜单、地图、单位、迷雾、动画、HUD、鼠标键盘输入和模拟时钟。浏览器只接管窗口、GPU 初始化、资源、音频及持久化接口。

之前只接 sim、另用 TypeScript/Canvas 画图的版本保留为历史原型，见 [Canvas 原型说明](docs/canvas-prototype.md)。本版本使用独立的原生指令协议，不混用历史原型或 WERHD 的战斗协议。

## 本地运行

需要 Node.js 22.12+、Python 3、Rust stable、`wasm32-unknown-unknown` target，以及支持 WebGPU 的桌面浏览器。所有构建输出均在本仓库内。

```sh
npm ci
npm run setup:native-web
npm run build:native-web
npm run start:native-web
```

打开 **http://127.0.0.1:5280/**。本地原版游戏资源默认从下面的目录只读载入，不提交到 Git：

```text
~/Library/Application Support/VERA20k/retail-assets
```

其他资源目录可设置 `VERA_ASSET_ROOT=/absolute/path/to/assets` 再编译并启动服务。构建记录绑定资源清单，服务启动时检查实际 JS/WASM 和资源身份；不匹配时需重新构建。服务器只开放游戏资源白名单，不开放个人 `RA2MD.INI`、快捷键配置或源代码。

默认启动只下载遭遇战素材（约 279 MB）和压缩引擎（约 10 MB），不包含战役、过场影片、音乐及菜单动画。在「资源管理」中可以下载可选内容或完整资源，退出对局后重新载入启用。已校验文件按 SHA256 缓存到 CacheStorage；浏览器允许持久缓存时，后续载入复用缓存。压缩传输与解压后的文件均检查长度和 SHA256。菜单动画使用之前确认的约 4.11 MB MP4，由浏览器解码；默认使用静态背景。分包、构建和验证方法见 [资源架构说明](docs/native-content.md)。

网页沿用 VERA 的操作：左键选择和下达上下文命令、右键取消/拖动视角、拖框选取、双击基地车展开。生产与建筑放置走原侧栏。具体快捷键沿用 VERA 的选项设置。

`window.__veraNative.diagnostics()` 是可显式启用的低频只读诊断，返回原生屏幕、tick、己方单位、选择和生产队列；它不会推进模拟或注入指令。`networkStatus()` 返回当前原生联机会话状态。

## 本地联机

主菜单选择「网络」，创建房间，将房间代码交给另一位玩家。加入者准备后，房主开始作战。本阶段入口固定为「火线冲突（2）」、两位真人；房主可设置国家、颜色、出生点、队伍与游戏选项。单机遭遇战继续使用原生菜单。

本地 HTTP 服务同时提供同源 `/ws/native`。大厅负责房间和冻结启动配置；两端完整 VERA 客户端各自持有世界，服务端按玩家顺序聚合原生指令。选择状态保留本地，游戏指令沿用原生输入解析。每帧等待所有玩家，断线或校验失败停止对局，不承诺断线续局。

加载屏障核对版本、资源、玩家映射和初始帧。完整存档哈希含本地视角状态，仅作诊断；第一回合使用服务器会话收据，此后立即比较原有 `Queue_AI` 产出的联机 CRC，不重复计算、不增加随机数抽取。编译、协议测试、CRC 一致和实际浏览器实玩是不同的验收层次。

独立 Cloudflare Worker、R2 和 Durable Object 的打包与部署说明见 [deployment/README.md](deployment/README.md)。本地代码、部署包和目标域名发布分别验证。

## 源码、补丁和构建

- `native-client/`：完整 VERA 源码快照及本仓库的浏览器平台适配。
- `native-source.lock.json`：原本机提交、两路远端提交、整合提交和逐文件来源摘要。
- `web-native/`：页面启动、字体及资源校验；游戏界面由 Rust 绘制。
- `web-native/content-store.js`、`content-plan.js`：独立资源下载、缓存和内容方案；后续大厅可直接复用。
- `web-native/runtime-adapter.js`：当前原生客户端的加载、资源挂载和联机接口，后续只接 sim 时替换该适配层及对局生命周期。
- `tools/build-native-web.mjs`：WASM 编译、16 MB 栈、版本匹配的 wasm-bindgen 及构建记录。
- `tools/native-server.mjs`：同源本地 HTTP 服务，支持 WASM MIME、资源校验、HEAD 与范围请求。
- `tools/services/native-room-coordinator.mjs`：本地 WebSocket 与云端 Durable Object 共用的原生房间/回合同步所有者。

默认使用 `web` 优化配置；正式性能比较可运行 `VERA_WEB_PROFILE=release npm run build:native-web`。编译和通过状态哈希均不能代替浏览器实玩验证。

本仓库完全独立于 `../vera20k` 和 `../ra2web-werhd`；不在两个来源目录中 fetch、合并、构建或写文件。远端整合只在本仓库 `.build/vera-upstream` 内完成。源快照包含原本机定制及本次同步时的远端更新，具体提交以锁文件为准。

本地修改已单独记录在 `patches/native-client.patch` 和对应锁文件中。检查与固定版本重放：

```sh
npm run native:check
npm run native:sync
npm run native:test-sync
```

`native:sync` 内容一致时不修改时间戳；显式 `npm run native:sync -- --rebuild` 可从已记录的源树反向验证基线并重放补丁，不要求原项目或远端存在本机整合提交。存在未记录编辑时拒绝重建。审阅适配修改后，`npm run native:record` 使用本仓库的 `.build/vera-upstream` 基线更新补丁；它不会同步新的上游提交。

浏览器持久化使用当前站点的 localStorage。存档超出浏览器容量时会报告错误并保留原存档。网页触屏操作、浏览器截图导出与跨浏览器兼容性需要单独验证；不能用桌面菜单成功替代这些验收。

VERA 源码遵循随附的 [GPL license](native-client/LICENSE-GPL)。商业游戏资源和编译产物不提交 Git。
