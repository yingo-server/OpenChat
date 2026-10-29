# 变更日志

本文件记录 OpenChat 的版本变更。格式参考 Keep a Changelog，版本号遵循语义化版本。

## [1.0.0] - 2026-10-29

首个正式版本：`chatd` embedded 单二进制可部署，含用户端/管理端 SPA、管理 REST、媒体上传下载与冷热分层存储。

### Added

- 协议与工程骨架：`proto/chat.proto`（72 条消息）、kinds 常量注册表（78 个 kind）、Frame/FrameMeta/Reject 管道类型、Makefile（proto/build/test/lint/release）与 GitHub Actions CI。
- 文档：架构总纲、桥接/用户/管理/数据层设计、Web UI 规范与限流/安全规范。
- 总线与桥接层：进程内/远程 Peer（TCP/UDS）、HMAC 握手（双钥轮换、±30s 窗口、10 万 nonce 防重放）、8 组件桥接流水线（framerw/verifier/router/egress/ack/session/adminapi/supervisor）、16 路总线 fanout、有界队列背压与优雅排空。
- 数据层：SQLite 热库（WAL、`RETURNING` seq 分配、keyset 分页）、PostgreSQL 冷库（分区归档、trgm 全文检索、哈希链审计）、21 张分域表与版本化迁移、policy 热加载、写管道（seqalloc/dedup/flusher，1000 条或 50ms 组提交）。
- 用户层：WebSocket 网关（升级前 Cookie 鉴权、按 kind 令牌桶、16 路会话分片、七步优雅排空）；`/api/auth/*` 认证服务（手机 OTP、邮箱 magic link、密码、游客、refresh 轮换与重放检测、Ed25519 签发、登录锁定 5 次→15m/1h/24h）。
- 管理面：独立 `admin.db`、TOTP + RBAC 三角色、常量时间 CSRF 校验、幂等键、审计游标、管理 REST（`/api/v1/*` 挂载在 `admin_rest_listen`）、`adminctl` / `openchatctl` 运维 CLI。
- 前端：用户端 SPA（net/core/ui 分层、IndexedDB 单一真源、seq 收敛与 gap buffer、乐观 outbox、渲染器注册表、消息列表虚拟滚动）与管理控制台；两端产物经 `go:embed` 内嵌进单二进制。
- 媒体：`POST /api/media/upload` 与 `GET /api/media/{id}`（magic bytes 校验、扩展名一致、类型/大小上限、每日 50 次限流、内容寻址去重）。
- 部署件：systemd 加固单元、Caddyfile、install/backup/release 脚本、`openchat-<ver>-linux-<arch>.tar.gz` + `SHA256SUMS` 发布包。

### Fixed

- 浏览器 JSON 文本帧被网关丢弃导致整条浏览器链路不可用：codec 增加 JSON/protobuf 嗅探并按对端格式回包。
- 管理面能力集缺少 960/970/980 kind，ban 帧被 verifier 拒绝。
- `adminctl flags` 对 PUT 路由误用 POST；embedded bus 在瞬时无接收者时丢帧。
- 数据层评审问题：帧内容被 JSON 嵌入导致回复载荷丢失、解码器先读 magic 再读完整头、控制面帧混入数据流、TeeStage 未关闭输出、archiver 无进展时可能死循环。
- 构建/CI：`make proto` 中 `exit 0` 只结束单行导致 protoc 仍执行；`VERSION` 因 `make web` 重写 `server/web/*` 而带上 `-dirty`。
- 文档：README 的发布资产名与 `SHA256SUMS` 校验命令对齐实际 release 产物。
- CI `-race` 竞态：`admin.Server.Addr`、`adminPlane.addr`、`ws.Acceptor` 监听器注册、`OnResync` 回调、supervisor reload 测试与测试就绪等待。

### Security

- 认证：Ed25519 access（15m）/refresh（30d），refresh token family 轮换与重放撤销；PII 仅保存 HMAC 索引，明文不落库；登录失败锁定 5→15m/1h/24h。
- 管理面：强制 TOTP、RBAC 三角色、常量时间 CSRF、登录失败指数锁定；管理监听仅回环（`admin_listen` / `admin_rest_listen`）。
- 上传：magic bytes 白名单 + 扩展名一致 + 可执行/脚本/SVG 黑名单；图片 8MB / 音频 2MB / 文件 20MB 上限，每用户每日 50 次。
- 审计：冷库 append-only 哈希链；无冷库时显式告警并降级为「只写日志不落盘」，不静默伪造。
- 限流：OTP 防轰炸（60s 间隔、5 次/小时、10 次/天、单 IP 5 次/小时、3 个来源 IP 冻结 24h）；captcha 自当日第 2 次起强制，未接供应商时 fail-closed。
- 层间传输：HMAC 握手（双钥轮换、±30s 窗口、nonce 防重放）、UDS 0600。

## [0.1.1] - 2026-10-29

### Fixed

- 发布构建：`VERSION` 不再因 `make web` 重写 `server/web/*` 而带上 `-dirty`，发布资产名固定为 `openchat-<ver>-linux-<arch>.tar.gz`。

## [0.1.0] - 2026-10-29

### Added

- 首个可安装的 embedded 骨架：协议契约、分域迁移、总线/桥接/数据/用户/管理各层主体、用户端与管理端 SPA、systemd/Caddy/install 等部署件。
- 发布链路：tag push 触发 CI 构建 `openchat-<ver>-linux-<arch>.tar.gz` 与 `SHA256SUMS`，并作为 GitHub Release 资产发布。

### Fixed

- CI 发布 job 补充 `contents: write` 权限，GitHub Release 资产上传不再返回 403。
