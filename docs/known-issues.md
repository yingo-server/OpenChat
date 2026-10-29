# OpenChat 1.0 已知问题

> 版本：1.0.0（2026-10-29）
> 适用：`chatd` embedded 单二进制 / v1.0 发布包
> 说明：以下问题均已通过读代码或实跑确认，1.0 不修复；每条按「现象 / 影响 / 计划版本」记录。

## 1. 媒体下载没有会话级 ACL

- **现象**：`GET /api/media/{media_id}` 只校验登录态（`access_token` Cookie），不校验请求者与媒体所属会话的成员关系。`media_id = base64url(sha256(前 16 字节) ‖ 8 字节随机数)`（32 字符，不可枚举）；`media_media` 行记录了上传者 `uid`，但下载路径没有使用它。无权限与不存在统一返回 404，不泄露存在性。
- **影响**：任何已登录用户只要拿到 `media_id` 就能下载原文件；安全性依赖 `media_id` 不泄露（日志、转发、客户端缓存均可能泄露）。1.0 只适合可信的小规模部署。
- **计划版本**：1.1 补 `media_id → 消息 → 会话 → 成员` 的 ACL 校验（security-spec §4.4 红线）。

## 2. 会话列表未虚拟滚动（消息列表已虚拟滚动）

- **现象**：`apps/client/src/ui/views/conv-list/ConvList.tsx` 直接 `filtered.map(...)` 渲染全部会话，只做了行级 `memo`，没有虚拟列表；消息列表 `apps/client/src/ui/views/chat/MessageList.tsx` 已使用 `@tanstack/react-virtual` 做虚拟滚动。
- **影响**：会话数量达到数千时首屏 DOM 节点过多、滚动卡顿、内存升高；功能本身正常。
- **计划版本**：1.1（`@tanstack/react-virtual` 复用消息列表的方案）。

## 3. E2EE / 音视频通话 / 视频消息为 feature flag 关闭的预留实现

- **现象**：`[feature_flags]` 的 `e2ee`、`call_enabled`、`video_enabled` 默认均为 `false`，且当前没有对应的业务实现可开启：协议只为通话预留 kind 350–399（常量已定义、无处理器），`mediasvc` 只接受 image/audio/file（mtype 3 视频留给 1.1），客户端 `video` 渲染器回退为文件卡片；E2EE 仅有表结构预留（security-spec §5.4），没有密钥协商与加解密实现。
- **影响**：1.0 不支持端到端加密、音视频通话、视频消息；后台把 flag 改成 `true` 也不会启用任何功能。
- **计划版本**：1.1（视频消息）；1.2（E2EE、音视频通话）。

## 4. 冷库 Postgres driver 需部署层注册，未注册时审计降级为「只写日志不落盘」

- **现象**：`chatd` 按架构约定不 import 任何 PostgreSQL driver（driver 由部署层注入）。`cold_dsn` 非空时执行 `sql.Open("postgres", dsn)`；若部署层未 import/注册 `lib/pq`（驱动名 `postgres`）或等价 driver，启动日志报 `cold store disabled: driver not registered — 需在部署层 import pgx/stdlib 或 lib/pq 注册 driver（本二进制按架构约定不携带 postgres driver）`，冷库句柄为 `nil`。冷库与归档作业已接线：归档调度仍存在，但无冷库时只做 dry-run/明确报错；管理面审计 journal 退化为 `logJournal`，每个事件只打一条 WARN 并累加 `Dropped`，不落盘。
- **影响**：历史消息无法归档到冷库、冷读与归档搜索不可用；审计链缺失（security-spec §5.5 生产红线）。热库的新消息读写不受影响。
- **计划版本**：1.0 部署时由部署层注册 driver（见 docs/deploy.md 附录 A）；1.1 评估提供带 driver 的构建变体与启动自检。

## 5. 短信 / 邮件 / 图形验证码为接口缝

- **现象**：`authsvc.Deps` 中的 `SMS`（`SMSSender`）、`Mailer`、`Captcha`（`CaptchaVerifier`）都是注入接口，`chatd` 装配未注入任何实现。`dev_otp=true` 且 `APP_ENV=dev` 时，手机 OTP 固定为 `123456`、邮箱 magic link 在响应里直接返回 `link`、captcha 任意非空 token 放行，可跑通完整链路。生产模式下短信/邮件不会真正发出；验证码在当日第 2 次 OTP 请求起强制，且 `CaptchaVerifier == nil` 时返回 `CAPTCHA_REQUIRED`（fail-closed，不会静默放行）。
- **影响**：生产环境手机验证码登录、邮箱 magic link 不可用；触发验证码阈值后 OTP 发送会被拒。密码登录、游客登录不受影响。
- **计划版本**：1.1（内置 SMS / SMTP / 图形验证码适配器；1.0 仅 dev 模式可跑通）。

## 6. `-race` 仅 CI 可跑（本地沙箱 TSan 不支持）

- **现象**：在本地沙箱/部分 ARM 环境执行 `go test -race`（如 `make test`）会直接失败：`FATAL: ThreadSanitizer: unsupported VMA range`。CI 的 x86_64 runner 上 `make test`（`go test ./... -race -count=1`）可正常执行。
- **影响**：本地无法用 ThreadSanitizer 验证并发正确性；并发回归只能在 CI 发现。
- **计划版本**：不修复（运行环境限制）；1.0 起发布门禁以 CI 的 `make test` 为准。

## 7. 分片上传 / 断点续传未做

- **现象**：媒体上传是单次 `multipart/form-data` 全量提交（`apps/client/src/net/media.ts` 的 `uploadMedia` 用一个 XHR 发送整个 `File`）；服务端 `mediasvc` 也是 `io.ReadAll` 一次读满（图片 8MB / 音频 2MB / 文件 20MB 上限）。没有分片、断点续传、秒传。注意：WS 的 `RESUME` 是消息同步水位，不是文件上传续传。
- **影响**：弱网或大文件上传失败后必须整文件重传；上传进度只在单请求内有效。
- **计划版本**：1.1（分片 + 断点续传）。

## 8. blurhash 用低清占位代替

- **现象**：图片渲染器（`apps/client/src/ui/renderers/image.tsx`）的占位是后端 `thumb_inline`（data URL/base64 低清图）或按 `mediaId` hash 生成的纯色渐变；没有 blurhash 编解码。`mediasvc` 也不生成缩略图/转码，真实链路中 `thumb_inline` 通常为空，最终回退为渐变占位。
- **影响**：列表图片的渐进加载观感与 web-ui-spec §4.2 的 blurhash 目标有差距；因有宽高比容器，不会造成布局偏移（CLS）。
- **计划版本**：1.1（服务端缩略图 + 客户端 blurhash）。

## 9. 媒体上传无异步病毒扫描（ClamAV 未接）

- **现象**：`mediasvc.handleUpload` 在魔数/扩展名/大小校验通过后直接写入 `Media.Status = 1`（可用），没有 `status=0(scanning)` 阶段，也没有 clamd 扫描。security-spec §4.3 的 ClamAV 流水线属于 1.1 范围。
- **影响**：上传文件不会被病毒扫描，恶意文件可能被其他用户下载；1.0 的防线只有类型白名单与大小上限。对可信内网可接受，对开放注册的生产环境不合规。
- **计划版本**：1.1（ClamAV：status 0 → 1/2，检出隔离并告警）。

## 10. access token 吊销不会踢掉已有 WS 连接

- **现象**：`logout` 与 refresh 重放只吊销 refresh token family；access token 按设计不设黑名单（security-spec §2.7 允许 15 分钟残余窗口），且网关尚未接入「踢下线」信号（`server/internal/authsvc/tokens.go` 的 `TODO-KICK`）。已建立的 WebSocket 连接不会因登出/refresh 重放被立即断开。
- **影响**：用户登出或 refresh 重放后，已签发的 access token 在剩余有效期（≤15 分钟）内仍可调用 API 和维持 WS；被撤销设备不会立刻下线。
- **计划版本**：1.1（网关按 uid/device 踢线，access token 短 TTL + 主动刷新）。

## 11. SYNC 补拉（会话内 gap 回补）在 v1.0 空转

- **现象**：客户端检测到 seq 跳号时（`apps/client/src/app/bootstrap.ts` 的 `onGap`）发送 `SYNC_REQUEST`（kind 8）。但服务端无消费者：usergw 将其转发至桥接，Bridge `Router.Route(8)` 落在 0-99 控制面白名单之外、无精确路由，返回 `nil`（丢帧）；数据层 `dispatcher` 只处理 101/920/930/940/970/971/980，无 kind 8 handler。断线重连的 `RESUME`(6) 与 `READ_HISTORY`(920) 读路径正常，仅「单连接内跳号的 SYNC 主动回补」链路空转。
- **影响**：长乱序/单连接跳号导致的会话内缺口无法经 SYNC 主动回补，只能依赖重连 RESUME 全量对齐；期间该会话可能持续显示缺口。
- **计划版本**：1.1（Bridge Route 增 kind 8 → data 920 映射，或数据层 dispatcher 增 SYNC handler，与 P3-7 一并接线）。

## 12. 管理后台登录锁定计数为进程内存（单实例假设）

- **现象**：admin 登录失败锁定（`server/internal/admin/middleware/ratelimit.go` 的 `LoginLimiter`，5 次/档 → 15m/1h/24h，账号与来源指纹双维度）以进程内 `map + atomic` 计数维护，未落库、不跨实例共享、进程重启即清零。
- **影响**：仅在单实例部署下成立；多副本或频繁重启会放宽暴力破解防护（计数丢失/分摊到各实例）。1.0 为单实例 embedded 部署，当前可接受。
- **计划版本**：1.1（持久化到 adm 库，或引入共享计数器）。

## 13. split 多进程部署形态未实现（systemd unit 为预留）

- **现象**：`server/cmd` 实际只有 `chatd`、`openchatctl`、`adminctl`；`server/cmd/chatd/main.go` 对非 embedded 的 `[mode]` 直接报错（`this build is embedded-only`）。`deploy/systemd/openchat-{bridge,user,data,admin}.service` 的 `ExecStart` 指向 `bin/chatd-bridge` 等不存在的二进制，**一旦 enable 即启动失败**。
- **影响**：1.0 只能以 embedded 单二进制部署，无法按层分机扩展；这 4 个 unit 仅作 1.1 预留。
- **计划版本**：1.1（补 `cmd/chatd-{bridge,user,data,admin}` 二进制，或从发布包/部署产物中移除这些 unit，避免运维误启）。
