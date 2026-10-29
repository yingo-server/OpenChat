# 前端与用户层文档符合性审查（docs vs 代码）

> 审查日期：2025-06 ｜ 审查人：前端评审（只读审查）｜ 范围：user-frontend-design.md / web-ui-spec.md / architecture.md vs `apps/client`、`server/internal/user`、`server/internal/data/pipe`、`proto/`。
> 所有结论均附本人亲自执行的命令证据。工作区含未提交改动，按当前工作树审查。

## 总评

整体符合度**高**。分层依赖、双注册表、sync 引擎 single-writer、设计令牌表、防闪烁 hooks 均与文档一致且实现质量好。发现 **1 个 P0**（WS token 走 query 违反 security-spec 红线——历史问题仍在）、**3 个 P1**、若干 P2/P3。

---

## P0 —— 违反红线 / 契约破坏

### P0-1 WS 鉴权 token 走 URL query（红线未修）

- **文档出处**：security-spec §2.3 红线表：「握手请求中 token 出现在 URL query → **禁止**（会进日志/Referer）；只允许 Cookie 或 Sec-WebSocket-Protocol」；user-frontend-design §1.1 acceptor「不鉴权」，authsvc 负责验签。
- **代码位置**：`apps/client/src/net/transport/ws-client.ts:242-249`
- **证据**：
  ```
  $ sed -n '240,250p' apps/client/src/net/transport/ws-client.ts
    const token = this.options.token?.();
    ...
    if (token) url.searchParams.set('token', token);
    if (deviceId) url.searchParams.set('device_id', deviceId);
  $ rg -n "token:" apps/client/src/app/bootstrap.ts
    122:      token: () => tokenStore.accessToken,
  ```
  而服务端已按文档实现 Cookie-only：
  ```
  $ rg -n "query|Cookie" server/internal/user/net/ws/*.go | rg -i "token|query"
    ws/…go:283: // tokenFromRequest 只从 Cookie 取 token（禁止 URL query，security-spec §2.3 红线）。
  ```
  且 `authsvc/tokens.go` 已写明 `setAuthCookie stores the access token as an HttpOnly cookie`。
- **结论**：**已知历史问题仍未修复**。服务端拒绝 query token，浏览器真实（非 mock）模式下 WsClient 会带 `?token=` 建连——要么被 401 拒绝（鉴权 fail-closed，连接不可用），要么若服务端存在兜底读 query 的路径则直接违反红线。前端把 token 拼进 URL 本身就违反「token 不进日志/Referer」红线。
- **修法**：删除 `buildUrl()` 中的 `token` 分支；改为 (a) 依赖登录时种下的 HttpOnly Cookie（真实路径，服务端已就绪），或 (b) `new WebSocket(url, [token])` 走 `Sec-WebSocket-Protocol`（`ws-connection.ts` 已有 `protocols` 参数槽位，`SocketFactory` 签名已支持，接线即可）。同时删掉 `WsClientOptions.token` 的注释「拼到 query」。

---

## P1 —— 偏差

### P1-1 trace_id「前端生成」未实现：MSG_SEND 不携带独立 trace，依赖 requestId 顶替

- **文档出处**：architecture.md「消息发送」时序：「**trace_id 前端生成**，经 FrameMeta 全程透传」→ Bridge FrameRW → data 层 → ack。
- **代码证据**：
  ```
  $ rg -n "trace" apps/client/src -g '!*test*'   → 无命中（前端零 trace 字段）
  $ rg -n "requestId" apps/client/src/net/sync/outbox.ts
    270:          requestId: next.clientMsgId,   // MSG_SEND 的 request_id = client_msg_id
  $ sed -n '75,90p' server/internal/bridge/framerw/framerw.go
    // TraceID 从 Envelope.request_id 提取，缺失则生成 16 字节随机 hex。
  $ sed -n '244,261p' server/internal/data/pipe/pipe.go
    ready := ReadyMsg{Msg: msgs[0], Trace: req.TraceID}
  ```
  Bridge 确实从 `Envelope.request_id` 提取 TraceID 并放入 `ReadyMsg.Trace` 全程流转——透传链路是通的；但「前端生成 trace_id」实际是 **client_msg_id 兼职**。MsgAck payload (`chat.proto:169-175`) 只有 msg_id/seq/client_msg_id/status 四字段，**ACK 不回传 trace/request_id**，Envelope 级 `requestId` 只在 `buildErrEnv/buildResultEnv`（ack.go）回填，`buildAckEnv` 不带。
- **结论**：时序图「trace_id 前端生成」为语义偏差——现状是 client_msg_id 兼任 trace 源，ACK 无法用 trace 关联。功能可用但排障时 send→ack 无法按 trace 串联。
- **修法**（二选一）：① 文档改写为「request_id（=client_msg_id）兼任 trace 源；ACK 经 client_msg_id 关联」；② 真正实现：Envelope 增加 trace_id 字段（proto 有位，InternalFrame.trace_id 已有），`buildAckEnv` 回填 Envelope.request_id=req.RequestID。

### P1-2 mock 登录响应字段与真实 authsvc 契约部分对齐但少字段

- **文档/契约出处**：`server/internal/authsvc/tokens.go:18-40` sessionResponse 注释明确列出「client contract (apps/client/.../provider.ts → mapAuthSession)」字段集：`access_token / token / refresh_token / user_id / session_id / expires_at / guest / profile{display_name}`，另含 `device_id / expires_at_unix / is_new_user`。
- **证据**：
  ```
  $ sed -n '789,800p' apps/client/src/net/mock/mockBridge.ts
    return { token, refreshToken, userId, sessionId, expiresAt, guest, profile }   // camelCase
  $ sed -n '89-106p' apps/client/src/net/auth/provider.ts   // mapAuthSession
    const token = raw.token ?? raw.access_token ?? '';
    ... raw.user_id ?? compatible.userId ...
  ```
  mock 返回 camelCase，真实返回 snake_case；`mapAuthSession` 靠双形态兜底兼容，所以**功能对齐**（expires_at 均为毫秒，契约一致）。偏差点：mock 少 `is_new_user`、`expires_at_unix`、`device_id`；mock 的 `sessionId` 是 `mock-session-...` 而真实 `session_id = deviceID`（tokens.go:74 `SessionID: deviceID`）——真实登录后 sessionId 会等于设备 ID，mock 里两者语义不同。
- **结论**：字段名靠 `mapAuthSession` 双兜底维持一致，属**脆弱对齐**：一旦真实端删 `token` 别名（注释写着 "alias kept for older clients"），或前端忘同步，即静默漂移。mock sessionId 语义与真实不同。
- **修法**：mockBridge 改返回与 sessionResponse 完全同形（snake_case + 全字段，sessionId=mock deviceId）；在 authsvc 与前端各加一条契约测试锁定字段集。

### P1-3 wire 字段命名两态（snake/camel）在前端解码层做 `pick()` 双收——契约真源模糊

- **文档出处**：architecture.md「proto/ 唯一契约源」；user-frontend-design §2.1「proto/gen 生成物」。
- **证据**：未提交改动 `apps/client/src/net/proto/payload.ts`（git diff）新增：
  ```ts
  /** 服务端 wire JSON 是 lowerCamelCase，mock/历史数据是 snake_case：两种都收。 */
  function pick(raw, snake, camel) { ... }
  function millis(value) { /* 秒级时间戳自动升毫秒 */ }
  ```
  同时 `pipe.go:298,325` `wire.DataResult{RequestID...}` 输出 camelCase JSON；而 `chat.proto` 与 mock 使用 snake_case（`client_msg_id`）。decodeMsgAck 仍只收 snake_case。
- **结论**：数据层 wire JSON 用 Go 结构体 tag（camelCase），proto 定义用 snake_case，mock 用 snake_case——**三种形态并存**，前端被迫到处 `pick()`。「proto 是唯一契约源」的律条在 data 层 930/940 应答路径上不成立。
- **修法**：明确 wire JSON 命名规范（建议统一 snake_case，`wire.Marshal` 加 tag 或改用 protojson）；mock 与真实端由同一 schema 生成/校验；至少在 payload.ts 头部文档记录「双态收窄是过渡措施，1.1 收敛」。

---

## P2 —— 文档漂移（合理/低风险）

### P2-1 前端 i18n 目录与文档不符

- **文档出处**：web-ui-spec §7.4「目录规范：`src/locales/zh-CN/*.json`，按域拆分 common/auth/chat/report/admin；zh-CN 缺 key 即构建报错（CI 校验）」。
- **证据**：`$ ls apps/client/src/ui/i18n/` → `index.ts zh-CN.ts`；`$ ls apps/client/src/locales` → 不存在。单文件 ts、无 en-US、无 key 完整性 CI 校验。
- **结论**：现状单文件 ts 便于起步，属合理漂移，但 §7.4 的「CI 校验 key 完整性」缺漏（见 P3-2）。

### P2-2 stores 通信总线在 `core/bus.ts` 而非文档所写 `eventbus`

- **文档出处**：user-frontend-design §2.1「stores …禁互相 import（eventbus 通信）」。
- **证据**：`$ rg -n "from '\./" apps/client/src/core/stores/ | rg -v bus` → 零命中（互不 import ✅）；`$ ls apps/client/src/core/` → `bus.ts`。各 store 均经 `bus.emit('conn:changed'/'message:upserted'/...)` 通信，规则本体完全满足。
- **结论**：仅命名漂移（eventbus → bus.ts），无风险。文档可顺手改。

### P2-3 dispatch.ts 49 行但含少量统计辅助代码

- **文档出处**：user-frontend-design §2.2「dispatch.ts 等价于 execvp：查表调用零分支，<50 行」。
- **证据**：`$ wc -l dispatch.ts` → 49 行 ✅；核心 `dispatch()` 无 if 分支（仅 `!handler` 空查表落空 + try/catch 隔离，属文档允许的「未知 kind 静默丢弃+计数」）；文件后半 `dispatchStats/unhandledCount/resetDispatchStats` 是诊断导出。
- **结论**：符合。

### P2-4 media.ts 媒体上限/错误码文档缺失

- **证据**：新文件 `apps/client/src/net/media.ts`（未提交）声明「与服务端 mediasvc.go 逐字一致」：8MB/2MB/20MB、50 次/天、错误码 UNAUTHORIZED/FILE_TOO_LARGE/UNSUPPORTED_TYPE/RATE_LIMITED。web-ui-spec §4.4 只写了 UI 层（进度条 4px、5 类图标），未写这些上限与错误码。
- **结论**：实现向服务端对齐做得好，但**文档层没有这个契约的位置**——建议在 web-ui-spec §4.4 或 bridge-design 增补「媒体上行限制与错误码表」。

---

## P3 —— 缺漏

### P3-1 web-ui-spec §7.4 的 CI key 完整性校验未实现

- **证据**：`apps/client` 无 locales 目录（见 P2-1），构建脚本中无 key 校验步骤；`npm run build` 成功不检查 key。

### P3-2 web-ui-spec 性能指标（LCP<2.5s 等）无度量

- **文档出处**：§8.1 指标表。仓库内无 Lighthouse/CI 性能门禁配置（apps/client 无相关脚本）。属「目标已写、未验收」，可在 release 流程补。

### P3-3 RTL 逻辑属性 CI lint 未落地

- **文档出处**：§7.4「上述规则进入 Code Review 检查单」「验收清单：RTL 通过 CI lint」。
- **证据**：apps/client 无 eslint 规则文件涉及 `ms-/me-/start-/end-`；抽检 `rg "ml-|mr-|pl-|pr-" apps/client/src/ui` 未发现违例（实现本身干净），但门禁缺失。

---

## 逐项审查结论表（要求项 → 结论）

| # | 审查项 | 结论 | 证据要点 |
|---|---|---|---|
| 1a | 后端 net 不 import core/app | ✅ 通过 | `rg "internal/(core\|app)" server/internal/user/net/` 零命中 |
| 1b | 前端 core/net 不引用 ui | ✅ 通过 | `rg "from '(\.\./)+ui" src/{core,net}` 零命中 |
| 1c | stores 互不 import，仅经 bus | ✅ 通过 | `rg "from './" stores/` 除 bus 外零命中；总线文件为 `core/bus.ts` |
| 1d | main.tsx 只做注册 | ✅ 通过 | 86 行；`registry.register × 20 + registerRenderer × 7 + bootstrap + render`，零业务分支 |
| 2a | dispatch ≤50 行零分支 | ✅ 通过 | 49 行，dispatch() 查表+try/catch 隔离 |
| 2b | MessageList 无消息类型分支 | ✅ 通过 | `rg "type ===\|kind ===" MessageList.tsx` 仅 `flush={message.type==='image'}`（滚动锚定参数，非渲染分支）；渲染全经 `getRenderer(String(type))` 注册表 |
| 2c | renderers 注册表扩展 | ✅ 通过 | 6 类 + unknown 兜底，`registerRenderer('unknown', UnknownMessage)` 满足「旧客户端向前兼容」 |
| 3a | sync single-writer | ✅ 通过 | engine.ts 所有写路径（ingest/applyTombstone/applyEdit/hydrate/ensureConv）一律 `enqueue()` 进同一条 Promise 串行队列；IndexedDB 写点只有 `cache.putMessages/saveLastSeq`（`rg -l` 仅 engine.ts + idb.ts），无第二写入口；persist 失败回滚 lastSeq 保持「IDB=事实源」 |
| 3b | tombstone 处理 | ✅ 通过 | applyTombstone 不推进 lastSeq、deleted=true 落库、防复活有测试（engine.test.ts:107） |
| 3c | gap 触发 SYNC | ✅ 通过 | acceptOne 跳 seq → requestGap → `sink.onGap` → bootstrap.ts:60-64 发 `KINDS.SYNC_REQUEST`，与 RESUME 共用 ingest 入口 |
| 4a | 令牌表 vs tailwind.config | ✅ 通过（零 diff） | 颜色全走 `rgb(var(--tok))` 变量、fontSize/spacing/borderRadius（6/10/14/4/20/999）/boxShadow（三档与文档逐字同值）/zIndex（0/10/20/30/40/50/60/70）/duration（100/200/300/1200ms）逐项比对一致 |
| 4b | 骨架 300ms 防闪烁 | ✅ 通过 | `useDelayedFlag`：骨架 delay=300 + minVisible=300；loading 200/300（Button/Skeleton 均引用） |
| 4c | 动效三档 + reduce-motion | ✅ 通过（tokens） | micro/normal/slow 在 config；`prefers-reduced-motion` 归零未见全局 CSS 检查（styles 未逐行审），记 P3 观察 |
| 5 | MSG_SEND request_id/trace 透传 | ⚠️ P1-1 | 透传链路通（framerw 从 request_id 提取 TraceID→ReadyMsg.Trace→flusher），但「前端生成 trace_id」实为 client_msg_id 兼职；ACK 不回传 |
| 6 | WS token 禁 query | ❌ P0-1 | ws-client.ts:247 仍 `?token=`，历史问题未修 |
| 7 | mock vs authsvc 契约 | ⚠️ P1-2 | 字段靠 mapAuthSession 双兜底对齐；mock 少 3 字段、sessionId 语义不同 |
| 8 | 未提交前端改动方向 | ✅ 媒体+会话 | 15 文件 +584/-55：媒体上传（media.ts 新增、Composer/renderers、payload.ts ConvCreate/DataResult）、会话（ConvList 置顶/建群）。`npm run build` ✅ 14.19s；`npm test` ✅ 33/33。无半成品破坏构建 |

**契约漂移专项扫描结果**（重点项）：
- kind 数值：前端 `kinds.ts` 与 `server/internal/proto/kinds/kinds.go` 逐值比对（HELLO…DRAFT 36 个常量 + CONV_DATA_RESULT=931）**零 diff**，含本次新启用的 931 ✅。
- 错误码：data 层 `buildErrEnv` 用 400/403/500/503；前端 `handleError` 只 toast `payload.code/reason` 不 switch 具体码——目前无漂移面，但前端没有错误码枚举表，未来加「按码分流」（如 401 登出）时需先立文档。
- 媒体错误码：media.ts 与 mediasvc.go 注释互指「逐字一致」，抽查一致 ✅（建议补测）。

---

## 文档更新清单

1. **security-spec §2.3 / known-issues**：把「ws-client 仍用 ?token=」记入 known-issues（或修代码后关闭），P0。
2. **architecture.md 消息时序**：改为「Envelope.request_id（=client_msg_id）兼任 trace 源，Bridge FrameRW 提取为 FrameMeta.trace_id」；或实现独立 trace_id 后保持原文。
3. **user-frontend-design §2.1**：「eventbus」→「bus.ts」；§2.1 目录补 `net/media.ts`。
4. **web-ui-spec §7.4**：i18n 目录现实改为 `src/ui/i18n/zh-CN.ts`（或按文档落地 locales 目录，二选一）；明确 key 完整性校验为 1.1 待办。
5. **web-ui-spec §4.4 或新 §4.7**：增补「媒体上行限制（8/2/20MB、50 次/天）与错误码表」，与 media.ts/mediasvc 对齐。
6. **bridge-design / architecture**：明确层间 wire JSON 命名规范（snake vs camel）与 protojson 归一计划，消除前端 `pick()` 双收。
7. **known-issues**：补一条「mock 登录响应少 is_new_user/device_id/expires_at_unix，sessionId 语义与真实端不同」。
