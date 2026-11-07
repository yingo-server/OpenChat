# v3 消息总线 P0 依赖核实检查单（docs/v3-bus-design.md §9 P0）

> 状态：已完成 · 日期：2026-11 · 结论：三项全部满足，P1 可启动。

## 1. 911 flag 热重载可用于 uid 百分比灰度 —— ✅

| 核实项 | 结论 | 证据 |
|---|---|---|
| 热重载通道 | `SIGHUP → assembly.reload`（白名单：policy + feature flags + rate limits），flag 从 hot DB `sys_feature_flags` 全量重读后 `flags.Apply(delta)` 原子换快照，并经 `KindFeatureFlags`(kind 12，即 911) `user.Broadcast` 全量下发 | `server/cmd/chatd/assemble.go:535`（reload 实现） |
| flag 值类型归一 | `Flags.ToInt` 统一 int/float64/bool/字符串来源（DB 装载 float64、911 下发字符串）——灰度 `v3_bus_percent` 三种来源均可读 | `server/internal/pkg/featureflags/flags.go`（ToInt/Int/Bool） |
| 热改后生效路径 | `Snapshot()` atomic.Value 零拷贝读；灰度判定读快照副本，Apply 即刻对全部后续判定生效，无需重启 | `flags.go`（Snapshot/Apply） |
| 写入口 | `sysStore.UpsertFlag`（admin 面）+ `config/chatd.toml [feature_flags]`（补缺失 key，已有值以库为准） | `server/internal/data/store/sqlite/sys.go:19` |
| 新增 flag | `v3_bus_enabled`（默认 false）/ `v3_bus_percent`（默认 0），已加入 `Defaults()`，灰度判定 `InV3Bucket`（FNV-1a uid 哈希分桶，T-SV-7） | `featureflags/flags.go`、`featureflags/grey.go` + 测试 |

**风险备注**：911 广播是"重放全表"而非增量；`v3_bus_percent` 热调时新旧连接同快照判定，不存在窗口期分裂。分桶判定在 P2 于连接建立与每帧投递两处调用点各读一次快照，中途热改对存量连接下一个判定点生效——符合 §7.3"同 uid 稳定落同一路径"（uid 哈希，与连接无关）。

## 2. kinds CI 一致性检查 —— ✅（已存在，覆盖 15/16/17）

- 现有守门：`scripts/doccheck.sh` [3] WS kinds——文档表 → kinds.go 常量值 + 名称注册双向核对（裸数字禁令另由评审强制）。
- **注意**：doccheck 未挂载进 CI（ci.yml 只跑 importlint/test/build，Makefile 无 doccheck 目标）。本次补挂：`Makefile` 增加 `doccheck` 目标并纳入 `lint`，P1 合入 kind 15/16/17 时即生效。
- **CI 缺口（P1 闭环项）**：doccheck 只核对 kinds.go，未核对 kinds.ts（T-CL-3 要求 TS↔Go 15/16/17 一致）。本次新增 `scripts/kinds-consistency.sh` 同时比对两端常量，挂入 CI（ci.yml go job 后追加 node job 或 Makefile lint 链）。

## 3. mailbox 分域迁移骨架 —— ✅

- 新增 `server/store/migrations/hot/mailbox/0001_mailbox_init.sql`：
  - `mailbox_entries`（mailbox_seq AUTOINCREMENT 单调持久 / user_id / envelope BLOB / state / created_at / delivered_at / dedup_key）；
  - 索引 `idx_mailbox_user_seq`（续传热路径）、`idx_mailbox_state_delivered`（compaction T-SV-6）；
  - `mailbox_cursors`（per-uid 生效 cursor，重启不回退）。
- 命名合规（`NNNN_name.sql`），`migrate.Runner.Discover` 已发现新 domain；测试 `mailbox_test.go` 锁定发现与 schema 关键项。
- 纯建表，不接线：P2（MailboxHub）前任何运行路径不受影响——符合 §9 中间态铁律（`v3_bus_enabled=false`）。

## 4. 门槛核对（§9 P0 "检查单全勾"）

- [x] 911 热重载可灰度（本文件 §1）
- [x] kinds CI 一致性检查（本文件 §2 + `scripts/kinds-consistency.sh`）
- [x] mailbox 迁移骨架（本文件 §3）
- [x] `go build ./...` / `go test ./internal/pkg/featureflags/ ./internal/data/store/migrate/` 全绿

## 5. P3b 中间态 —— v3Plane 已构造、未接线

- 新增 `server/cmd/opendiscord/v3.go`（包 `opendiscord`）：`NewWireV3(db, flagsFn, cfg)` 按
  `mailbox.NewStore(hot.DB) → mailbox.NewHub(store, flagsFn, HubConfig{}) → delivery.NewPlane(store, hub.Ack 适配 AckFn, cfg)` 构造 v3 投递栈，导出 `WireV3{Hub, Plane, Enabled, InBucket}`：
  - `Enabled() = v3_bus_enabled && v3_bus_percent>0`，每次调用读最新 flag 快照（热改即刻生效）；
  - `InBucket(uid) = featureflags.InV3Bucket(flagsFn(), uid)`（FNV-1a uid 哈希稳定分桶，T-SV-7）。
- **当前只构造、未接线**：`WireV3` 未挂进任何下行 fanout 路径，`v3_bus_enabled` 默认
  false 时 `Hub.Offer` 本身也是 no-op（hub 层兜底）——旧路径（pipe 直投）行为**逐字节不变**，符合 §9 中间态铁律。
- 测试 `server/cmd/opendiscord/v3_test.go`：T-SV-5（关→开热切换）、灰度 uid 稳定分桶、
  S-5 重启恢复（新 Hub 实例 Restore 后 Cursor/Head 不回退）；临时真 SQLite，DDL 内嵌同形于 `store/migrations/hot/mailbox/0001`。
- **P3c 计划**：把 v3 plane 接进下行 fanout（按 `InBucket` 双路径分流）、做旧路径瘦身与背压传播（`Bus.PausedConns`/`Bus.BackpressureDepth` 经 §5.5 暴露），届时才改变主干行为。
