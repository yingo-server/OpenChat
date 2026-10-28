// Package exitcodes 定义进程退出码契约（docs/bridge-design.md §5）。
// 退出码是最古老、最稳定的进程间契约：systemd Restart 按码分派，
// 避免配置错误被无限重启刷屏。
package exitcodes

// 退出码总表：
//
//	0   OK              优雅退出（SIGTERM 排空完成后 / 正常结束）
//	1   ConfigInvalid   配置不可用：TOML 语法错、必填项缺失、语义非法
//	2   AssemblyFailed  装配失败：组件构造错误、管道接线失败、依赖缺失
//	70  InvariantBroken 不变量破坏（如 AckTracker 断言失败）——必须重启清状态
//	75  TempFail        临时失败（EX_TEMPFAIL，端口占用等），systemd 可重试
//	78  EXConfig        配置文件存在但内容不可用（BSD sysexits 惯例）
//	143 SigTerm         被 SIGTERM 终止（128+15），未及优雅排空时的兜底
const (
	// OK 优雅退出：SHUTDOWN_NOTICE 已广播、Egress 已排空（≤5s）。
	OK = 0
	// ConfigInvalid 配置不可用，进程启动即失败，不进入服务状态。
	ConfigInvalid = 1
	// AssemblyFailed 装配失败：cmd/ 层接线时组件构造出错。
	AssemblyFailed = 2
	// InvariantBroken 不变量破坏（exit(70)）：内部状态自洽性断言失败，
	// 附完整内存快照（SIGUSR1 dump 复用），必须重启清状态。
	InvariantBroken = 70
	// TempFail 临时失败（EX_TEMPFAIL）：端口占用等可自行恢复的环境问题。
	TempFail = 75
	// EXConfig 配置文件存在但被系统判定不可用（sysexits(3) EX_CONFIG）。
	EXConfig = 78
	// SigTerm 进程收到 SIGTERM 被终止（128+15）。
	SigTerm = 143
)
