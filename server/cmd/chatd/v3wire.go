// v3wire.go —— v3 总线 P3c：把 P3b 的 WireV3 真正接进 chatd 主干装配
// （docs/v3-bus-design.md §5/§6/§9）。
//
// 本文件只做「构造 + 挂载」，不做任何投递路径切换：
//   - fanout/user/pipe 的现有代码一行不动；
//   - v3_bus_enabled 默认 false 时 Hub.Offer 为 no-op、plane 无人订阅，
//     旧路径（pipe 直投）行为逐字节不变（§9 中间态铁律）；
//   - fanout 瘦身与灰度分流留待 P3d。
//
// 孤立说明：cmd/opendiscord/v3.go 是 P3b 的孤立构造/测试单元，不是主干入口；
// 主干唯一的 v3 构造点是本文件的 newV3Wire。
package main

import (
	"context"
	"database/sql"

	"github.com/yingo-server/OpenDiscord/server/internal/bus/delivery"
	"github.com/yingo-server/OpenDiscord/server/internal/bus/mailbox"
	"github.com/yingo-server/OpenDiscord/server/internal/pkg/featureflags"
)

// WireV3 是 v3 总线在 chatd 装配层的句柄集合。P3c 只构造不接线：
// flag 打开前不得把 Hub/Plane 挂进任何下行 fanout 路径。
type WireV3 struct {
	Hub   *mailbox.MailboxHub
	Plane *delivery.Plane

	// Enabled 反映当前灰度总开关（总开关 && percent>0）。
	// 每次调用读最新 flag 快照（SIGHUP/911 热重载语义由上游保证）。
	Enabled func() bool

	// InBucket 判定 uid 是否落在 v3 灰度桶（uid 哈希，与连接/重启无关）。
	InBucket func(uid int64) bool
}

// newV3Wire 构造 v3 投递栈（P3c 主干装配点；newAssembly 成功路径末尾调用）。
//
//	db      —— 热库句柄（与 data 层同一个连接池；mailbox 分域 DDL 已在
//	          P0 迁移树 store/migrations/hot/mailbox/0001）；
//	flagsFn —— flag 快照读取器，典型 a.flags.Snapshot（SIGHUP 热重载语义
//	          由上游保证），允许 nil（视为全关——安全中间态）；
//	planeCfg —— credit 流控参数（§6 flag：delivery_credit 等，零值取默认）。
//
// db/flagsFn 缺一即返回 nil（由调用方记 WARN 继续）：v3 总线在中间态是纯
// 旁路设施，任何故障都必须不影响旧路径投递（§9：旧路径是唯一投递路径）。
func newV3Wire(db *sql.DB, flagsFn func() map[string]any, planeCfg delivery.Config) *WireV3 {
	if db == nil || flagsFn == nil {
		return nil
	}
	store := mailbox.NewStore(db)
	hub := mailbox.NewHub(store, flagsFn, mailbox.HubConfig{})
	// AckFn 适配：plane 回调不带 error，持久化失败只留观测（cursor 仍单调）。
	ackFn := delivery.AckFn(func(ctx context.Context, uid, cursor int64) {
		_ = hub.Ack(ctx, uid, cursor)
	})
	plane := delivery.NewPlane(store, ackFn, planeCfg)

	w := &WireV3{Hub: hub, Plane: plane}
	w.Enabled = func() bool {
		flags := flagsFn()
		if !featureflags.BoolMap(flags, featureflags.KeyV3BusEnabled) {
			return false
		}
		percent, ok := featureflags.ToInt(flags[featureflags.KeyV3BusPercent])
		return ok && percent > 0
	}
	w.InBucket = func(uid int64) bool {
		return featureflags.InV3Bucket(flagsFn(), uint64(uid))
	}
	return w
}
