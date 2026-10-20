# 前端、资源、大厅、对战

四个服务分别使用独立 Node 进程。所有进程、配置、生成资源和构建缓存都属于 `werhd-vera`；游戏资源目录只读。

| 服务 | 默认地址 | 职责 |
| --- | --- | --- |
| 前端 | http://127.0.0.1:5280 | 页面、JS/CSS、品牌图片、`GET /api/config` |
| 资源 | http://127.0.0.1:5281 | `generated` 地图/图集、`wasm` 引擎、`/api/resources` 白名单与 `/retail` 文件 |
| 大厅 | ws://127.0.0.1:5282/ws/rooms | 创建/加入/设置/准备、申请对战、发送每人独立入场票据 |
| 对战 | ws://127.0.0.1:5283/ws/battle | 票据校验、初始加载屏障、逐 tick 输入排序、哈希比较、断线/超时停止 |

每个 HTTP 服务都有 `/api/health`。前端拒绝本地 `/generated`、`/wasm`、`/retail` 和 `/api/resources`，确保资源配置实际生效。资源服务没有页面或源码路由，只对配置中的前端 origin 开放 CORS；支持 HEAD、Range、ETag、正确的 MIME 和 SHA256。图片跨域时使用 anonymous，支持阵营色像素处理。

## 一条命令启动

```sh
npm ci
npm run build
npm run start:stack
```

脚本先启动对战，再启动大厅、资源、前端，并检查四个健康接口才输出 `stack-ready`。任一进程退出会关闭本次脚本启动的其他进程。Ctrl-C 关闭这四个子进程，不扫描或结束其他项目的服务。若端口已被占用，启动失败并清理本次子进程。

Vite 开发模式：`npm run dev:stack`。改用其他 JSON 配置：

```sh
npm run start:stack -- --config config/sites.local.json
```

仓库提供可直接使用的 [sites.local.json](../config/sites.local.json) 和需要配置自己域名/代理的 [sites.reverse-proxy.example.json](../config/sites.reverse-proxy.example.json)。修改前可以复制一份。页面每次启动读取 `/api/config`，更改服务地址无需重编译 Rust/WASM 或网页 JS。

## 配置

每个服务都有 `host`、`port`（内部监听）和 `publicUrl`（浏览器/反向代理公开入口）。`battle.internalUrl` 是大厅调用对战注册接口的 HTTP(S) origin，可以与对战公开地址不同。

```json
{
  "schema": 1,
  "web": {"host": "127.0.0.1", "port": 5280, "publicUrl": "https://game.example.com"},
  "resources": {"host": "127.0.0.1", "port": 5281, "publicUrl": "https://assets.example.com/vera"},
  "lobby": {"host": "127.0.0.1", "port": 5282, "publicUrl": "https://lobby.example.com"},
  "battle": {"host": "127.0.0.1", "port": 5283, "publicUrl": "https://battle.example.com", "internalUrl": "http://127.0.0.1:5283"}
}
```

反向代理需要支持 WebSocket upgrade，资源站 `/vera/` 转发时移除这个前缀。TLS 在代理终止；HTTPS 前端要求 HTTPS 资源和 WSS 大厅/对战。前端公开入口部署在域名根路径；资源与联机公开入口可带路径前缀。这个示例是配置说明，本任务没有部署这些公网域名。

可选字段：`resources.publicDir`（默认 `public`，开发素材目录）、`web.distDir`（默认 `dist`，生产素材与网页输出）、`resources.assetRoot`（零售资源目录，可被 `VERA_ASSET_ROOT` 覆盖）、`allowedOrigins`（附加前端 origin）。公开静态目录必须位于本项目内，不能借配置指向原始项目。也可通过顶层 `assets.manifestUrl`、`assets.wasmUrl`、`assets.resourceManifestUrl` 单独指定三个资源入口；资源文件路径相对其所属清单解析。

## 分开启动

在四个终端使用同一份配置。大厅与对战必须读取同一个 `WERHD_SERVICE_SECRET`（至少 16 字符）；通过终端环境或进程管理器传入，不写进 Git、公开配置或浏览器。

```sh
npm run serve:battle
npm run serve:lobby
npm run serve:resources
npm run serve:web
```

每条命令支持 `-- --config /absolute/path/config.json`，前端和资源还支持 `-- --dev`。`start:stack` 在未设置 `WERHD_SERVICE_SECRET` 时自动为本次进程树生成随机秘密。重启整个 stack 需要重新开局；当前没有持久化账号、重连和房间恢复。

大厅用带 Bearer 认证的内部 `POST /internal/matches` 注册对战，返回 matchId、每人一次性票据和公开 WSS/WS 地址。浏览器先在对战 socket 发 `join`，收到权威 `joined` 后才初始化 WASM；`loaded`、`input`、`ready`、`turn` 仅走对战 socket。大厅连接仍用于房间元数据和离开时的取消。内部 DELETE 用于清理已分配对战。服务秘密不进入上述浏览器协议。

模拟仍由浏览器中的 VERA WASM 运行；对战服务是输入同步和一致性检查服务。它不能证明客户端诚实，也没有实现服务端权威仿真或反作弊。默认本机联调配置与公网运营服务是不同交付边界。

## 验证

`npm test` 包括四个真实进程的启动/健康/路由隔离/退出清理，以及真实双 WebSocket 服务的大厅交接、票据、玩家绑定、哈希不一致、超时和断线行为。原生 VERA 与 WASM 的逐帧一致性仍由 `npm run test:parity` 验证。实际浏览器跨站资源和双人对战记录见 [acceptance.md](acceptance.md)。
