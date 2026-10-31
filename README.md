# OpenChat

自托管的即时通讯服务：单聊、群聊、图片/语音/文件、语音视频通话、多设备同步。
数据在你自己的服务器上，不经过任何第三方。

一个二进制 = 服务端 + 用户端界面 + 管理后台。2 核 2G 起步，不需要容器。

## 特性

**通讯**
- 单聊与群聊，消息已读/送达回执、输入中提示、在线状态
- 2 分钟内可撤回自己发的消息（管理员可撤回他人）
- 离线消息自动补拉，断网重连后消息不丢不乱序
- 多设备同时在线（默认上限 3 台），消息全端同步

**多媒体**
- 图片、语音、文件消息；缩略图与语音波形在浏览器本地生成，服务端不做转码
- WebRTC 一对一语音/视频通话（媒体流点对点直连，服务器只转发信令）
- 媒体存储带配额（默认单用户 500MB、全局 20GB），缩略图在文件系统而非数据库

**账号**
- 手机验证码、邮箱魔法链接、密码、游客模式
- 登录失败指数退避、验证码发送限流、多设备管理
- 管理端强制 TOTP 二步验证

**管理与运维**
- Web 管理后台：仪表盘（实时指标 + 趋势图）、用户/举报/广播/开关/归档/审计
- `opchat`：纯终端管理台，7 个标签页，适合 SSH 里快速处理
- `openchatctl` / `adminctl`：脚本化命令行，退出码可编排
- 全中英双语，界面语言自动跟随系统

**数据自主**
- 热数据留在本机 SQLite（默认 90 天），更早的归档到外部 PostgreSQL
- 归档、清理、备份、媒体回收都是独立作业，可 dry-run 预演
- 审计日志哈希链 + append-only，不可篡改

## 容量（实测，非估算）

CI 上 2 核 4 GB runner、无限流、10 人群，每档 10 秒稳态：

| 并发 WS 连接 | 消息/秒 | 全局 RPM | 可用性(ACK/发送) | 端到端 p50/p95 |
|---|---|---|---|---|
| 256 | ~1,790 | 107,520 | 99.6% | 65 / 85 ms |
| **512** | **~3,535** | **212,130** | **98.1%** | **80 / 126 ms** |
| 1024 | ~6,950 | 417,114 | 65.9% | 1,260 / 1,410 ms |

**结论：2 核机器上稳定的工作点是 ~512 并发连接 / ~3,500 消息每秒。** 1024 连接时可用性掉到 66%，这是本机型的实际拐点。

容量由**扇出写放大**决定，不是消息本身：一条消息要写给 N 个成员。50 人群是 10 人群的 5 倍写入，实测可用性从 100% 掉到 38%。要更高容量：加核、或把大群拆成多实例。

复现：`scripts/stress/main.go`（`--conv-members` 设扇出宽度，`-ladder start=256` 自动倍增到可用性 <70%）。

## 快速开始

### 支持的平台

| 平台 | 架构 | 产物 |
|---|---|---|
| Linux | x86_64 / x86 / arm64 / armv7 / riscv64 | `.tar.gz`（静态链接 SQLite） |
| Windows | x86_64 / x86 | `.zip` |
| 源码 | — | `openchat-<ver>-src.tar.gz` |

Windows on ARM / ARM64 暂无产物（缺 mingw CGO 工具链），见 [已知问题](docs/known-issues.md#3-windows-arm--arm64-不提供构建产物)。

### 要求

- Linux 服务器（2 核 2G 起），systemd
- 域名（TLS 由 Caddy 自动签发）
- PostgreSQL（冷存储，可选；不配则只保留本机热数据）

### 安装

```bash
# 1. 下载（版本号见 https://github.com/yingo-server/OpenChat/releases）
V=1.1.0
curl -LO https://github.com/yingo-server/OpenChat/releases/download/v$V/openchat-v$V-linux-amd64.tar.gz
curl -LO https://github.com/yingo-server/OpenChat/releases/download/v$V/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
tar -xzf openchat-v$V-linux-amd64.tar.gz

# 2. 安装（交互式向导；无 TTY 时自动降级为参数模式）
sudo ./deploy/install-interactive

# 或者非交互：
# sudo ./deploy/install.sh --domain https://chat.example.com \
#      --admin-user admin --admin-pass-file /root/admin.pass --lang zh

# 3. 启动
sudo systemctl enable --now openchat
```

打开 `https://你的域名` 即可使用。首次启动会创建管理员账号并打印一次性的
TOTP 密钥（用 `journalctl -u openchat | grep otpauth` 查看），请立即在认证器里登记。

### 升级

```bash
# 备份 → 替换二进制 → 重启（详见 docs/deploy.md §7）
sudo openchatctl backup
sudo systemctl stop openchat
# 替换 releases/<ver> 下的二进制并切换 current 符号链接
sudo systemctl start openchat
sudo openchatctl doctor
```

> **从 v1.0 升级到 v1.1 必须做一次热库转换**（启用 auto_vacuum，否则磁盘只涨不落），
> 命令见 `docs/release-notes-v1.1.0.md` 与 `docs/deploy.md §7.4`。

## 常用运维

| 命令 | 用途 |
|---|---|
| `openchatctl status` | 服务状态、进程信息、热库统计 |
| `openchatctl doctor` | 体检：数据库完整性、磁盘空间、日志错误、冷库连通、审计存储 |
| `openchatctl backup [--dry-run]` | 备份热库与配置 |
| `openchatctl ban <uid> --days 7` | 封禁用户 |
| `openchatctl unban <uid>` | 解封 |
| `openchatctl flags list` / `flags set k=v` | 查看/修改功能开关 |
| `openchatctl archive --dry-run` / `--run` | 归档预演 / 执行 |
| `openchatctl migrate thumbs [--dry-run]` | 把旧版存在数据库里的缩略图迁到文件系统 |
| `opchat` | 打开终端管理台（交互式） |
| `adminctl users list --q 张` | 检索用户（脚本化） |
| `adminctl broadcast send --text "..."` | 全站广播 |

日志：`journalctl -u openchat -f`　　Dump 内部状态：`kill -USR1 $(pidof openchat)`

## 文档

面向使用者：
- [用户指南](docs/user-guide.md)：账号、消息、隐私、数据导出与注销
- [管理员指南](docs/admin-guide.md)：日常运维、内容治理、应急处理

面向部署者：
- [部署手册](docs/deploy.md)：安装、配置、Caddy、备份恢复、故障排查、安全基线
- [升级说明 v1.1](docs/release-notes-v1.1.0.md)：升级步骤、配置变更、回滚

面向开发者：
- [开发文档索引](docs/README.md)：架构、协议、各层设计
- [API 参考](docs/api-reference.md) / [CLI 参考](docs/cli-reference.md) / [WS 协议](docs/ws-protocol.md)
- [路线图](docs/roadmap.md) / [变更日志](CHANGELOG.md) / [已知问题](docs/known-issues.md)

## 许可

[Apache-2.0](LICENSE)
