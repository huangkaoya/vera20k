# 历史 Canvas 模拟原型

当前完整原生客户端的运行方式见 [项目首页](../README.md)。以下是旧版本说明。

独立的网页红警版本：VERA20k 的 Rust 模拟编译为 WASM；TypeScript 负责 WERHD 风格的大厅、输入、Canvas 画面。游戏规则、寻路、经济、生产、战斗和状态哈希均由 VERA 执行。前端、资源、大厅、对战分别运行，入口通过运行配置连接。

## 本地运行

需要 Node.js 22.12+、Python 3、Rust stable 和 `wasm32-unknown-unknown` target。游戏资源使用本机已有的尤里复仇资源，只读访问，不复制到源仓库。

```sh
npm ci
rustup target add wasm32-unknown-unknown
npm run build
npm run start:stack
```

打开 **http://127.0.0.1:5280**。默认资源目录：

```text
~/Library/Application Support/VERA20k/retail-assets
```

其他位置可设置 `VERA_ASSET_ROOT`，构建素材和启动服务器都使用这一变量：

```sh
VERA_ASSET_ROOT=/absolute/path/to/assets npm run build
VERA_ASSET_ROOT=/absolute/path/to/assets npm run start:stack
```

`start:stack` 从 `config/sites.local.json` 启动四个独立 Node 进程：前端 5280、资源 5281、大厅 5282、对战 5283。默认只监听 `127.0.0.1`。`npm run dev:stack` 使用 Vite 热更新。运行配置、分开启动和反向代理说明见 [docs/services.md](services.md)。没有上传资源或连接原 WERHD 线上服务。

旧的 `npm run dev` / `npm run dev -- --production` 保留同源一体式调试模式；正式联调使用上面的四服务启动命令。

## 操作与联调

左键选择、拖框选择、Shift 多选；右键移动或攻击；双击基地车展开。方向键或鼠标中键拖动地图，滚轮缩放，小地图定位。侧栏生产建筑，完成后点击图标并在有效位置放置；右键取消放置。A 攻击移动、S 停止、G 警戒、D 展开、X 散开。

本地联机：两个浏览器标签打开相同地址，分别创建和加入房间；准备后由房主开始。大厅服务创建独立对战，并向每位玩家发送一次性入场票据。客户端连接对战服务，全部资源加载且初始哈希一致后开始。对战服务汇集输入，逐帧等待全部玩家，并比较上一帧完整状态哈希。断开、超时或哈希不一致会停止对局。房间使用独立协议，不能加入已有 WERHD 生产房间。

当前提供两张真实地图和三阵营资源，是桌面浏览器集成版本。Canvas 呈现与原生 GPU 渲染器独立，尚未移植原生完整音视频、任务战役和全部特效；移动端触控及公网匹配不在本次交付范围内。

```sh
npm test                 # 大厅配置及房间同步协议
npm run test:parity      # 同一输入下，原生与 WASM 每帧完整 stateHash
npm run typecheck
npm run check:isolation  # 比对本次任务前后的两个原始目录
```

`check:isolation` 依赖当前机器在工作开始前保存的原目录指纹，文件位于忽略的 `validation/protected-sources.json`。首次克隆本仓库时，确认 `upstream.lock.json` 中的来源路径正确，再在开始编辑前记录一次：

```sh
python3 tools/sync_upstream.py isolation --record
```

已有基线时脚本会拒绝覆盖。检测到原目录被其他工作修改会输出 `validation/isolation.json`，不会恢复原目录，也不应通过重录基线隐藏差异。本次任务已存在基线，VERA 并行修改的情况见验收记录。

`test:parity` 会编译原生桥接程序，并使用已构建的 WASM 与同一资源目录；可用 `-- --no-build` 复用已编译的原生产物。具体验收覆盖和结果记录在 [docs/acceptance.md](acceptance.md)。`window.__veraWeb` 提供只读的当前快照、选中单位和缺失素材清单，方便定位问题。

## 源码同步与构建边界

所有编辑、Git 提交、构建缓存和生成资源均位于本目录。`vendor` 是固定提交的普通文件快照，不使用软链接。原始 `../vera20k` 和 `../ra2web-werhd` 是只读来源；构建不在这两个目录内执行。

- [upstream.lock.json](../upstream.lock.json)：上游提交、源路径及逐文件 SHA256。
- `patches/*.patch` 和 `patches.lock.json`：本项目的 WASM 适配补丁及摘要。
- `crates/vera-web-core`：同一 Rust 分发器的 WASM ABI 与原生测试程序。
- `crates/asset-export`：读取真实 MIX/SHP/VXL/TMP 资源，导出网页地图与图集。
- `web/src/engine`：Worker 生命周期、原始 WASM ABI、资源校验及配置转换。
- `web/src/ui`、`lobby`、`network`、`render`：界面、房间和呈现。

固定版本重建 vendor：

```sh
npm run sync:check
npm run sync:upstream
```

显式升级到当前上游 HEAD：

```sh
npm run sync:upstream -- --update
```

脚本先在本仓库 `.build` 暂存上游快照并检查全部补丁，成功后才替换本仓库 vendor。发现未记录编辑或补丁冲突会停止。修改适配代码后，先审阅 diff，再运行 `npm run sync:patches` 记录补丁；不要用记录补丁掩盖意外修改。升级后重新执行构建、原生/WASM 一致性和浏览器验收。

VERA 源码遵循随附的 [GPL license](../vendor/vera20k/LICENSE-GPL)。商业游戏资源、导出的地图图集和 WASM 编译产物不提交 Git；WERHD 参考代码保留在 `vendor/werhd-reference`，来源记录见锁文件。
