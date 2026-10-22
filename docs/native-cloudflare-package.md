# Cloudflare 独立部署包

在当前项目根目录运行：

```sh
npm run package:cloudflare
```

工具先调用 `prepareNative()`，验证现有浏览器编译产物、完整原生源码补丁、
资源目录与所有本地对象 SHA，再复制明确列入清单的 Worker 源码、三个联机服务模块、
最新静态资源与 `generated/release.json`。不会重新编译 Rust、执行登录、上传或部署。

产物保存在 `dist/cloudflare/werhd-cloudflare-<patch10>-<contents8>.zip`、同名文件夹
及 `.zip.json` 回执。ZIP 根目录有独立 `package.json`、锁文件、中文 README、
`package-manifest.json` 和 `SHA256SUMS`。依赖精确版本来自现有部署目录。
外部回执记录每个包内文件和 ZIP 本身的 SHA；SHA256SUMS 覆盖有效载荷及清单，
不尝试让校验文件包含自身哈希。

解压后运行 `npm ci`、`npm run login`（已有命名配置时可跳过）、`npm run check`、
`npm run deploy`。检查脚本只做 Wrangler dry-run；真正部署使用原 `youlidefuchou`
命名配置。配置保留现有账户、路由、R2 绑定、DO 类名及迁移，包内相对层级保持可解析。

本包依赖现有 `youlidefuchou-res` 桶中的完整对象及 SHA 元数据，不包含大素材或 WASM。
资源清单、gzip 校验、CORS 与两层 WebSocket 来源准入完整保留；Toy 多包地址为空，
不会激活尚未完成的 Toy 资源切换。复制路径采用白名单并拒绝软链；本机上传计划、
上传状态、认证配置、零售素材、原生客户端源码和 `node_modules` 均不进入 ZIP。

生成包只证明本地交付物已创建。解压后的安装、dry-run、公网部署和浏览器验收是不同步骤，
应各自保存证据，不能把打包成功称为已经部署。
