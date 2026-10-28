# 用户层与前端设计

> 总纲：每个组件只做一件事并做好；机制与策略分离；组合优于集成；帧流作为统一接口；crash-only + 快速恢复。

## 1. 用户层：组件化管道设计

统一数据单元 = Envelope 帧，统一连接原语 = channel，每个组件是独立 goroutine 组。上行每步是纯函数式过滤/变换：`cat frames | decode | limitcheck | route | forward`。

```
                        用户层网关内部管道（数据从左到右单向流动）
┌─────────┐   ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐
│ acceptor │──→│ codec   │──→│ router   │──→│ forwarder│──→  Bridge socket
│(connector)│  │(帧编解码)│  │(会话路由) │  │(桥接客户端)│
└─────────┘   └─────────┘   └──────────┘   └──────────┘
     ↑             ↑             ↑              ↑
     │        ┌────┴────┐   ┌───┴────┐    ┌───┴─────┐
     │        │ limiter │   │ session │    │ (反向管道:
     │        │ (限流器) │   │ (连接表) │    │  下行对称)
     │        └─────────┘   └────────┘    └─────────┘
     └── authn(认证器) 不在管道上，是 router 查询的无状态纯函数
```

上行链路：
```
TCP conn
  → acceptor:  accept + HTTP Upgrade → 注册 conn → 每连接协程
  → codec:     bytes ⇄ Envelope（protobuf 解码、64KB 上限、版本白名单）
  → limiter:   令牌桶判定（纯过滤：放行/丢弃/降级）
  → router:    查 session 表确定去向（本地处理白名单 PING/AUTH/RESUME…；其余转发桥接）
  → forwarder: 封内部帧(route+ctx: conn_id/user_id/device_id) 写桥接 socket
```

下行链路对称反向，仅共享 session 表（只读查询），无反向调用。

### 1.1 组件职责表

| 组件 | 唯一职责 | 明确不做 | 接口 |
|---|---|---|---|
| **acceptor** | 监听、TLS 终结、HTTP→WS Upgrade、连接生命周期状态机(CONNECTED→HELLOED→AUTHED→READY) | 不读帧内容、不鉴权、不限流 | `Accept() (net.Conn, *ConnMeta, error)` |
| **authn** | JWT/guest token 验签，**无状态纯函数** | 不查 DB、不管理连接、不踢人 | `Verify(token) (*Identity, AuthErr)` |
| **session** | user_id→[]conn 映射、16 分片锁、conn_id 索引、presence、tombstone(30s) | 不发帧、不解析协议、不判投递目标 | `Get(userID) []Conn` / `Register/Unregister` |
| **codec** | bytes⇄Envelope、内部帧 Wrap/Unwrap、魔数/长度校验 | 不含业务分支（不 switch kind） | `Decode/Encode` |
| **limiter** | 按连接/按 user 令牌桶、PRIORITY 独立额度 | 不断连（只返回判决）、不写队列 | `Allow(connID, kind, priority) Verdict{OK,Drop,Throttle,Kill}` |
| **router** | 上行分类转发、下行寻址投递、执行 KICKED/断连策略 | 不编解码、不碰读写缓冲、不限流计算 | `chan *FrameEvent` → `chan *ForwardReq` / `chan *DeliverReq` |
| **forwarder** | 到桥接的单条内部 socket、读写协程、重连退避、降级重试队列(≤10k) | 不解析 Envelope 业务字段 | `in chan []byte` / `out chan BridgeMsg` |

**main.go 只做接线**（<150 行）：`acceptor.Run → router.RunUpstream → forwarder.Run → router.RunDownstream`，任何业务逻辑出现在 main 即违规。

### 1.2 Go 包结构（net→core→app→cmd 分层）

```
usergw/
├─ cmd/usergw/main.go           # 接线+信号
├─ cmd/usergw-ctl/              # status/kick/drain/reload 子命令
├─ internal/
│  ├─ net/                      # 传输与编码，无业务
│  │  ├─ ws/ bridge/ frame/ limit/
│  ├─ core/                     # 状态与策略
│  │  ├─ session/ authn/ router/ policy/ pipeline/
│  ├─ app/                      # 组装：config + server.go
│  └─ sig/                      # 信号处理独立小包
├─ api/proto/
└─ deploy/usergw.service
```

**依赖方向铁律**（CI lint 强制）：`cmd → app → core → net`，反向 import 直接 CI 失败。net 层不知道 user 概念存在；core 不知道 TLS 存在。

### 1.3 机制/策略分离

- 机制（codec/acceptor/forwarder）：怎么读写重连，写死
- 策略（router+policy 包）：哪些 kind 免限流、超限几次断连、KICKED 排空几秒——数据驱动，SIGHUP 可换
- WS 生命周期状态机由 acceptor 持有状态、router 判定迁移：状态是数据，转移表在 policy 可配（HELLO 超时从 10s 调 3s 无需改代码）

## 2. 前端：组合式设计

### 2.1 目录结构（net→core→ui 分层）

```
src/
├─ net/                  # 只懂字节与协议，零 React 依赖
│  ├─ transport/         # ws-connection.ts（纯WS封装）、backoff.ts
│  ├─ proto/             # gen/（protobuf-ts 生成物）、codec.ts
│  ├─ protocol/          # registry.ts（kind→handler 注册表）、dispatch.ts（<50行）
│  ├─ sync/              # engine.ts（last_seq 收敛引擎）、per-conv.ts、outbox.ts
│  ├─ auth/              # token-store.ts、providers/（phone/email/password/wechat/apple/onetap/guest 各一文件）
│  └─ cache/             # idb.ts（messages/convs/mediaUrls 三库）、media-lru.ts
├─ core/                 # 领域状态，不依赖 React
│  ├─ stores/            # conn/session/conv/message/presence 各一 store，禁互相 import（eventbus 通信）
│  └─ selectors/         # 派生计算
├─ ui/                   # React，只 import core/net 类型
│  ├─ views/             # login/ conv-list/ chat/ media-viewer/ settings/ banned/
│  ├─ renderers/         # ★ 消息渲染器注册表
│  └─ components/
└─ main.tsx              # 只做注册 handlers + renderers + 挂载
```

依赖方向：`ui → core → net`，与后端镜像。

### 2.2 双注册表：机制与策略分离（核心）

**协议 handler 注册表**——dispatch.ts 等价于 shell 的 execvp：查表，调用，零分支：

```
handler = registry.get(env.kind)
if (!handler) { log(`unhandled kind=${kind}`); return }   // 未知 kind 静默丢弃+计数
handler(env, ctx)
```

各模块自注册：MSG→sync.ingest、ACK→applyAck、DELIVERED/READ→applyReceipt、RESUME_RESULT→applyBackfill、FEATURE_FLAGS→setFlags、KICKED→kick、RATE_LIMITED→toast。

**新增 kind（如 350 通话段启用）= 新文件 + 一行 import，dispatch.ts 永不修改。**

**消息渲染器注册表**：

```
registerRenderer('image', ImageMsg)      // blurhash→缩略图→viewer 三段渐进
registerRenderer('audio', AudioMsg)      // 波形24段SVG + 播放进度高亮
registerRenderer('text',  TextMsg)
registerRenderer(999,     UnknownMsg)    // "暂不支持的消息类型"（旧客户端向前兼容）
```

聊天窗消息列表组件只持有位置与交互（虚拟滚动/长按菜单/气泡布局），不含任何一种消息的渲染逻辑。新增"投票"消息=新文件注册，聊天窗不重发版。

### 2.3 sync 引擎：rsync 模型

| rsync | 本设计 |
|---|---|
| 两端校验和对比 | 客户端 last_seq ↔ 服务端当前 seq |
| 只传差异块 | RESUME 只拉 gap 增量 |
| 旧块可复用 | IndexedDB 历史免拉取，分页按需 |
| 目标持有一致副本 | IndexedDB 是渲染唯一数据源，内存窗口是投影 |

- **启动 hydrate**：UI 立即从 IndexedDB 渲染（离线可用），conn-store 显示"同步中"
- **收敛引擎是唯一写者**：下行经 sync engine 校验（seq 连续性/去重）后先写 IndexedDB 再进内存 store
- 服务端删除/撤回=下发 tombstone（同 rsync delete 语义）
- 全量重建=分页重放，与增量共用同一 ingest 入口，**没有第二套写入路径**

## 3. Unix 细节落实

### 3.1 优雅退出（SIGTERM 七步排空）

```
1. 取消 root ctx
2. acceptor 停止 accept（listener.Close，如同 nginx QUIT）
3. 向全部在线连接推 ERROR{SHUTDOWN, retry_at=now+5s}
4. Drain 窗口 10s：等 forwarder 队列排空
5. 关闭桥接 socket（先发内部 BYE 帧，桥接标记这些用户"转移中"避免重复离线推送）
6. 每连接写协程排空写缓冲（≤2s）后 close
7. systemd TimeoutStopSec=15 兜底 SIGKILL
```

### 3.2 日志与 crash-only

- 日志 stdout 单行结构化键值对，过滤/轮转/采集全部 journalctl
- **crash-only**：seq/回执/presence 持久化全在数据层（经桥接）；本机唯一状态是连接表（连接断即失）。`Restart=always` + 1s 重启：进程死后客户端 RESUME 增量补拉，用户无感知
- SIGHUP 热重载：diff 出可热更字段（限流速率/burst/帧上限/白名单/心跳参数），原子替换 policy；监听端口/TLS 路径/桥接地址不可热更→拒绝+exit 3

### 3.3 usergw-ctl（UDS 控制面）

```
usergw-ctl status [--json]          # 连接数/分片占用/桥接状态/降级队列水位
usergw-ctl kick --user U [--device D] --reason CODE
usergw-ctl drain / undrain
usergw-ctl reload                   # 等价 SIGHUP
usergw-ctl conn show --user U
```

退出码：0 成功、1 运行错误、2 参数错误、3 不支持操作——可脚本化串联。

### 3.4 systemd 单元

```ini
[Service]
Type=notify          # sd_notify READY/WATCHDOG
Restart=always       # crash-only
RestartSec=1
WatchdogSec=30       # 所有管道 stage 定期喂狗
TimeoutStopSec=15
LimitNOFILE=65536
```

## 4. Unix 映射清单

| 原则 | 落点 |
|---|---|
| Do one thing well | 七组件职责表，每项列"不做什么"；main 只接线 |
| 机制与策略分离 | policy 包数据驱动；前端双注册表，dispatch/消息列表零分支 |
| 管道与组合 | channel 串联 stage，上行 `accept→codec→limiter→router→forwarder` |
| 一切皆流 | Envelope 帧是统一数据单元；内部帧再包路由头 |
| 分层不许扁平 | 后端 net←core←app←cmd、前端 net←core←ui，CI 强制 |
| 优雅退出 | SIGTERM 七步排空 + TimeoutStopSec 兜底 |
| 日志交 journal | stdout 单行结构化 |
| crash-only | 无本地持久状态 + Restart=always + RESUME 恢复 |
| 控制面分离 | UDS ctl socket 子命令，退出码可脚本化 |
