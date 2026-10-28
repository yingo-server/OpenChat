# OpenChat 部署手册

> 适用范围：单机（2C2G 起步）embedded 部署；split 形态差异在文中标注。
> 安全基线以 [security-spec.md](security-spec.md) §6 为唯一权威，本文只做操作映射。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 系统 | Linux + systemd（Debian 12 / Ubuntu 22.04 / Rocky 9 验证） |
| 资源 | 2 vCPU / 2 GB 内存 / 40 GB SSD 起；媒体目录建议独立 LUKS 卷 |
| 域名 | 已解析到本机；TLS 由 Caddy 自动签发（80/443 需可达） |
| 冷库 | 外部 PostgreSQL 14+（本机不装；`sslmode=require` 为底线） |
| 依赖 | `openssl`、`sqlite3`、`curl`、`tar`、`rsync`（异地备份时）、`age`（可选） |
| Caddy | v2.8+；限流需 `caddy-ratelimit` 插件或前置 nftables |

防火墙只放行 22 / 80 / 443，其余 DROP（security-spec §6.3 红线）。

---

## 2. 单机安装

```bash
# 1) 构建产物（在开发机或目标机）
make release-all            # client + admin + chatd + tar.gz

# 2) 上传到目标机后执行
sudo ./deploy/install.sh               # embedded（默认）
sudo ./deploy/install.sh --split       # split 五进程
sudo ./deploy/install.sh --no-start    # 镜像构建：只落盘不启动

# 3) 改配置
sudoedit /etc/openchat/openchat.toml   # 域名 / 冷库 DSN
sudoedit /etc/openchat/policy.json     # 保留期 / cron / 限流
sudo systemctl reload openchat         # SIGHUP 热重载策略

# 4) 边缘
sudo cp /etc/openchat/Caddyfile.reference /etc/caddy/Caddyfile
sudo sed -i 's/203.0.113.10\/32/<你的运维出口IP>\/32/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

`install.sh` 是幂等的：可反复执行，已存在的配置与密钥不会被覆盖，目录权限每次强制校正。

**安装脚本做的事**

1. 建组 `openchat` 与系统用户（embedded: `openchat`；split: `openchat-{bridge,user,data,admin}`）
2. 建目录并按权限矩阵 chmod/chown：
   `/etc/openchat` 0750、`keys/` 0750、`env` 0600、`/var/lib/openchat` 0700、`media/` 0750、`backup/` 0700
3. 生成密钥到 `/etc/openchat/keys/`：
   `jwt_sign_key.pem`、`admin_jwt_key.pem`（Ed25519，`openssl genpkey -algorithm ED25519`；无 openssl 时回退 `go run ./deploy/keygen`）、
   `ipc_key`/`hmac_key`/`pii_key`/`phone_lookup_key`/`download_key`/`upload_secret`/`audit_chain_key`/`backup.key`（32B hex）
4. 安装 `openchat.toml` / `policy.json` / journald 配额 drop-in / systemd unit
5. `systemctl daemon-reload && systemctl enable --now`
6. 红线自检：`find /etc/openchat /var/lib/openchat -perm /o+rwx` 必须为空，否则退出 1

安装完成后**立即**：登录管理后台 → 开启 TOTP → 核对 `/api/admin/*` 白名单 → 跑一次 `openchatctl audit verify`。

---

## 3. 配置说明

### 3.1 `/etc/openchat/openchat.toml`（0640 root:openchat）

| 键 | 说明 |
|---|---|
| `mode` | `embedded`（默认）或 `split` |
| `listen` / `admin_listen` / `metrics_listen` | **必须** 127.0.0.1；公网只允许 Caddy |
| `public_origin` | 站点绝对地址，用于 Cookie 域与 CORS |
| `hot_db` / `admin_db` | SQLite 路径；admin.db 独立，最小权限隔离 |
| `media_dir` | 媒体根目录（LUKS 卷，0750） |
| `cold_dsn` | 冷库 Postgres，`sslmode=require` |
| `policy_path` | 策略真源，默认 `/etc/openchat/policy.json` |
| `log_level` | `debug`/`info`/`warn`/`error`；日志只走 stdout → journald |
| `[feature_flags]` | 默认值；运行期由管理后台热改（kind 911 下发） |

### 3.2 `/etc/openchat/policy.json`（0640 root:openchat）

策略唯一真源（docs/admin-data-design.md §4）。改完 `systemctl reload openchat` 热生效；
坏策略（如 `hot_retention_days: 0`）会被拒绝加载并继续用旧策略，同时 `policy.invalid` 指标 +1。

```json
{
  "hot_retention_days": 90,
  "archive": { "cron": "0 4 * * *", "batch_size": 1000, "batch_pause_ms": 100, "active_exempt": true },
  "backup":  { "cron": "30 5 * * *", "dir": "/var/lib/openchat/backup", "keep_days": 14 },
  "trim": [
    { "table": "sys_rate_limit",         "retention_days": 7 },
    { "table": "identity_login_history", "retention_days": 180 }
  ],
  "rate_limit": { "msg_per_user_per_min": 60, "login_per_ip_per_min": 10 }
}
```

- `trim[].table` 只能取白名单（`sys_rate_limit` / `identity_login_history`），其他值加载即拒绝——trimmer 永不做动态 SQL。
- `archive.cron` 支持 `0 4 * * *`、`@daily 04:00`、`interval 3600` 三种形式；复杂 cron 需在装配层化简。
- 审计保留 5 年、登录日志 180 天属合规约束，不在本文件里缩短。

### 3.3 环境变量 `/etc/openchat/env`（0600 root:openchat）

只放运行时参数（`GOMEMLIMIT`、`TZ`、`OPENCHAT_CONFIG` 等）。systemd 以 root 读取后再降权，
因此 0600 不影响服务读取。**密钥不要放这里**，走 `/etc/openchat/keys/`。

### 3.4 Caddy（`/etc/caddy/Caddyfile`）

| 路径 | 去向 | 保护 |
|---|---|---|
| `/ws` | 127.0.0.1:8081 用户层 | upgrade 限流 10/min/IP + 失败熔断（红线） |
| `/api/admin/*` | 127.0.0.1:7780 管理层 | `remote_ip` 白名单，非白名单返回 404 |
| `/metrics` | 127.0.0.1:9090 | 仅内网/本机，公网 404 |
| `/api/*` | 127.0.0.1:8080 | 1MB body 上限 |
| 其余（含 `/admin/`） | chatd 内嵌 SPA | HTML no-cache，hash 资源长缓存 |

HSTS/`X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`/`Permissions-Policy` 由 Caddy 统一加。

---

## 4. 升级与回滚

```bash
# 发布（构建 → 打包 → 上传 → 切换 → 健康检查 → 失败自动回滚）
./deploy/release.sh --target root@chat.example.com

# 指定版本 / 复用 CI 产物
./deploy/release.sh --target root@chat.example.com --version v1.4.2 --skip-build
```

远端布局（只保留 current + last）：

```
/opt/openchat/
├── releases/v1.4.2/{bin,web}
├── current -> releases/v1.4.2
├── last    -> releases/v1.4.1
├── bin     -> current/bin
└── web     -> current/web
```

切换用 `ln -sfn ... current.new && mv -Tf current.new current`（原子 rename），随后
`systemctl restart openchat`。健康检查最多等 20s；失败自动把 `current` 指回 `last` 并重启，
仍失败则退出非 0 并保留现场。

手工回滚：

```bash
sudo ln -sfn "$(readlink -f /opt/openchat/last)" /opt/openchat/current
sudo systemctl restart openchat
journalctl -u openchat -n 100 --no-pager
```

数据库迁移只向前（`datactl migrate up`），回滚二进制前先确认迁移是否兼容旧版本；
破坏性迁移必须配 `datactl backup` 快照。

---

## 5. 备份与恢复

```bash
sudo /opt/openchat/current/deploy/backup.sh --dry-run   # 预检空间/密钥/异地目标
sudo ./deploy/backup.sh                                 # 立即备份
```

流程：`sqlite3 .backup`（在线一致快照）→ `PRAGMA integrity_check` → age/openssl 加密
（密钥 `/etc/openchat/backup.key` → `keys/backup.key`）→ 原子落盘 → rsync/对象存储异地 →
按 `policy.backup.keep_days` 清理。任一步失败退出非 0。

**恢复**

```bash
sudo systemctl stop openchat
sudo mv /var/lib/openchat/chatd.db /var/lib/openchat/chatd.db.bak
# age
age -d -i /etc/openchat/keys/age.key -o /tmp/hot.db /var/lib/openchat/backup/openchat-*.db.age
# 或 openssl
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in /var/lib/openchat/backup/openchat-*.db.enc \
  -out /tmp/hot.db -pass file:/etc/openchat/backup.key

sqlite3 /tmp/hot.db "PRAGMA integrity_check;"      # 必须 ok
sudo install -m 0600 -o openchat -g openchat /tmp/hot.db /var/lib/openchat/chatd.db
sudo rm -f /var/lib/openchat/chatd.db-wal /var/lib/openchat/chatd.db-shm
sudo systemctl start openchat
openchatctl doctor
```

恢复后补跑一次 `openchatctl archive --dry-run` 确认 cutoff 与冷库一致（备份不含冷库，
冷库由 Postgres 自身 PITR 负责）。

---

## 6. 常用运维命令

### systemd / journald

```bash
systemctl status openchat                 # 单元状态 + 最近日志
systemctl reload openchat                 # SIGHUP：热重载 policy 与白名单
journalctl -u openchat -f                 # 跟随日志（JSON lines）
journalctl -u openchat -g 'trace_id=abc'  # 单条消息全链路
journalctl -u openchat --since '10 min ago' -p warning
journalctl --disk-usage
journalctl --vacuum-size=200M             # 应急收缩（配额 200M）
```

信号：`SIGTERM` 优雅退出（flusher 最后组提交 + 归档断点，预算 30s）、`SIGHUP` 热重载、
`SIGUSR1` 触发一次备份、`SIGUSR2` WAL checkpoint + 指标 dump。

### openchatctl（管理面 CLI，等价 API 客户端）

| 命令 | 用途 |
|---|---|
| `openchatctl status` | 在线连接、队列水位、归档状态、版本 |
| `openchatctl doctor` | 体检：DB/WAL/磁盘/冷库连通/密钥可读 |
| `openchatctl backup [--run]` | 查看/触发备份（等价 SIGUSR1） |
| `openchatctl ban <uid> --level 2 --days 7` | 封禁（撤销 token + 断连） |
| `openchatctl unban <uid>` / `kick --uid` | 解封 / 强制下线 |
| `openchatctl users list\|show <uid>` | 用户查询 |
| `openchatctl reports list\|show\|handle` | 举报队列 |
| `openchatctl messages search --q ... --conv 123` | 消息检索 |
| `openchatctl broadcast preview\|send` | 广播预估/发送 |
| `openchatctl flags list\|set <key>=<value>` | feature flag |
| `openchatctl audit --since-id N` / `audit verify` | 顺序读审计 / 校验哈希链 |
| `openchatctl archive status\|--dry-run\|--run` | 归档作业 |
| `openchatctl policy show\|validate` | 策略查看/校验 |
| `openchatctl migrate status\|up` | 迁移 |
| `openchatctl completion bash` | shell 补全 |

**datactl** 说话给数据层（`status` / `archive` / `backup` / `trim` / `search` / `inspect` / `policy` / `doctor`），
**adminctl** 说话给管理层（`login` / `whoami` / `users` / `monitor` / `reports` / `messages` / `broadcast` / `flags` / `audit`）。
两者与管理后台走完全相同的 HTTP/鉴权链路，没有旁路。

### 常用一次性命令

```bash
sudo -u openchat /opt/openchat/current/bin/chatd-ctl status      # 数据层状态 dump
sqlite3 /var/lib/openchat/chatd.db "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 /var/lib/openchat/chatd.db "PRAGMA quick_check;"
du -sh /var/lib/openchat/media /var/lib/openchat/backup
ss -lntp | grep -E '8080|8081|7780|9090'
```
---

## 7. 故障排查

### 7.1 先看三样

```bash
systemctl status openchat --no-pager -l
journalctl -u openchat -n 100 --no-pager
ss -lntp | grep -E '8080|8081|7780|9090'
```

日志是 JSON lines，可直接用 `jq` 过滤（示例）：

```bash
journalctl -u openchat -o cat | jq -c 'select(.level=="error")' | tail -20
```

### 7.2 症状 → 处置

| 症状 | 最可能原因 | 处置 |
|---|---|---|
| 启动即退出，退出码 78 | 配置/策略非法（TOML 引号、policy 校验失败） | `journalctl` 找 `policy: invalid` / `config:` 行；`openchatctl policy validate` |
| `start operation timed out`，反复重启 | 未收到 `READY=1`（sd_notify）或启动阻塞 | 见 §9 已知差异；临时 `systemctl edit --full` 改 `Type=exec` 验证 |
| Caddy 502 | 上游未监听 / 端口写错 | `ss -lntp`；确认只监听 127.0.0.1 且 Caddy 指向同端口 |
| `/ws` 握手 401 | token 放在 query（红线）、Cookie 域不对、access 过期 | 用 Cookie 或 `Sec-WebSocket-Protocol`；核对 `public_origin` |
| 管理后台 404（其他路径正常） | 来源 IP 不在白名单 | 改 Caddyfile 的 `remote_ip`，`systemctl reload caddy` |
| 登录 429 / 一直失败 | 失败锁定（5 次 15min，逐级升到 24h） | 等锁定期结束；查 `auth.login_failed` 审计；不要绕过限流 |
| 归档 API 返回 409 | 上一轮仍在运行（单飞） | `openchatctl archive status`；必要时等其结束 |
| 归档滞后天数 > 0 | 冷库慢 / 作业被打断 | 查 `cold_db.latency_ms`；`openchatctl archive --dry-run` 估量 |
| 写队列水位持续 > 64 | 磁盘慢 / SQLite 锁竞争 | 查 `writech_queue_depth`、`iostat`、WAL 大小；临时降级写入 |
| 磁盘满 | journal 或备份堆积 | `journalctl --vacuum-size=200M`；清理过期备份；检查媒体 GC |
| 审计链断裂 `audit_chain_broken=1` | 数据库被旁路写入 / 恢复错版本 | **P0**：冻结写入、保全现场、通知安全负责人、跑 `openchatctl audit verify` |
| TOTP 全部校验失败 | 服务器时间漂移 | `timedatectl`；启用 chrony/timesyncd（红线） |

### 7.3 状态 dump（贴给维护者）

```bash
{
  date -u; uname -a
  systemctl is-active openchat; systemctl show openchat -p NRestarts -p ExecMainStatus
  openchatctl status --output json
  sqlite3 /var/lib/openchat/chatd.db "PRAGMA wal_checkpoint(PASSIVE); PRAGMA quick_check;"
  df -h /var/lib/openchat; du -sh /var/lib/openchat/*
  curl -s 127.0.0.1:9090/metrics | grep -E 'writech_queue_depth|ratelimit|audit_chain|go_goroutines'
  journalctl -u openchat -n 200 --no-pager
} > /tmp/openchat-dump.txt 2>&1
```

**注意**：dump 里可能含用户 ID / 会话 ID，外发前脱敏；不要包含 `keys/`、`env`、数据库文件。

---

## 8. 安全基线 checklist

部署完成逐项打勾；任何一项不通过视为未上线（security-spec §6 红线）。

**systemd 加固**

- [ ] `NoNewPrivileges=true`、`ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`
- [ ] `PrivateDevices=true`、`ProtectKernel{Tunables,Modules,Logs,ControlGroups,Clock}=true`
- [ ] `RestrictSUIDSGID=true`、`LockPersonality=true`、`RestrictNamespaces=true`
- [ ] `CapabilityBoundingSet=` 与 `AmbientCapabilities=` 为空
- [ ] `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`
- [ ] `ReadWritePaths` 只含本进程数据目录（embedded：`/var/lib/openchat`、`media`、`/run/openchat`）
- [ ] 每进程独立系统用户（split：`openchat-{bridge,user,data,admin}`）
- [ ] `EnvironmentFile` 指向 0600 文件
- [ ] `systemd-analyze security --offline=true /etc/systemd/system/openchat.service` 评分 ≤ 2.0（EXPOSED 项逐条解释）

**文件权限**

- [ ] `/etc/openchat` 0750 root:openchat；`keys/` 0750；`*.pem` 0640；`env` 0600
- [ ] `/var/lib/openchat` 0700；`media/` 0750；库文件 0600
- [ ] `/opt/openchat/**` 0755 root:root（运行用户不可写）
- [ ] `find /etc/openchat /var/lib/openchat -perm /o+rwx` 输出为空

**网络与边界**

- [ ] 防火墙默认 DROP，仅 22/80/443；出站白名单（443/DNS/NTP/短信邮件供应商）
- [ ] SSH：`PermitRootLogin no`、`PasswordAuthentication no`、仅 ed25519、`MaxAuthTries 3`
- [ ] `/api/admin/*` 白名单生效，非白名单返回 404
- [ ] `/metrics` 公网 404
- [ ] HSTS（`max-age=31536000; includeSubDomains; preload`）与 `X-Content-Type-Options: nosniff`
- [ ] 请求体上限 1MB（上传预签名 64KB）
- [ ] 时间同步已启用（TOTP/JWT 时间窗依赖）

**应用**

- [ ] 管理登录强制 TOTP（未开启的管理员在顶栏有红色提示）
- [ ] JWT 算法白名单仅 `EdDSA`，`kid` 支持双钥轮换
- [ ] 密钥清单齐全且**不在**本机明文之外的地方留副本；`backup.key` 离线保管
- [ ] 审计链每月自动校验 + 手动可跑，断链 P0 告警
- [ ] 日志只走 journald（`systemd-journald` 配额 200M），无文件日志
- [ ] 备份加密 + 异地 + 至少做过一次恢复演练

**密钥轮换日历**（security-spec §6.4.1）

| 密钥 | 周期 | 到期动作 |
|---|---|---|
| `jwt_sign_key` / `admin_jwt_key` | 180 / 90 天 | 新钥 `kid` 上线 → 24h 后旧钥下线 → 全端重登 |
| `ipc_key` / `hmac_key` | 90 天 | 换钥 + 重启进程对 + 审计 |
| `pii_key` / `phone_lookup_key` | 180 / 365 天 | 重加密迁移 / 重建索引 |
| `download_key` / `upload_secret` | 90 天 | 旧签名 15min 自然过期 |
| `audit_chain_key` | 365 天 | 换盐需全链重验（先在副本演练） |
| `backup_key` | 180 天 | 旧备份作废重做 |
| `db_disk_key`（LUKS） | 365 天 | 仅离线信封保管，不在本机留明文 |

---

## 9. 已知差异（骨架阶段）

部署件按**目标形态**编写；当前仓库的 `chatd` 仍是第 2 批骨架，联调时注意：

1. **配置读取**：骨架从工作目录读 `config/chatd.toml`，尚未解析 `--config`。
   `install.sh` 已建 `/etc/openchat/config/chatd.toml -> ../openchat.toml` 兼容链接，且单元
   `WorkingDirectory=/etc/openchat`，因此可直接启动；`--config` 参数在 CLI 落地后自动生效。
2. **Type=notify**：骨架未实现 `sd_notify(READY=1)`，systemd 会在 `TimeoutStartSec=30` 后判定启动失败并重启。
   临时联调可 `systemctl edit --full openchat` 把 `Type=notify` 改为 `Type=exec`；**上线前必须恢复**并实现 sd_notify。
3. **健康检查**：`/healthz` 未实现。`release.sh` 检测到 404 会自动退化为 `systemctl is-active`，不会误回滚。
4. **/metrics**：未实现指标端点时，管理后台「数据面板」显示"—/未找到指标"，不影响其他页面。
5. **openchatctl**：CLI 三件套尚未落地，命令表见 §6 与 docs/admin-data-design.md §7。
6. **后台 API 前缀**：前端约定 `/api/admin/v1/*`，与 Caddy 的 `/api/admin/*` 白名单规则一致；
   管理层路由实现时保持该前缀即可，无需改前端。

---

## 10. 附：目录速查

```
/opt/openchat/current/bin/{chatd,chatd-{bridge,user,data,admin}}
/opt/openchat/current/web/{client,admin}       # 内嵌 SPA 源目录
/etc/openchat/{openchat.toml,policy.json,env,keys/,env.d/,Caddyfile.reference}
/var/lib/openchat/{chatd.db,admin.db,media/,backup/}
/run/openchat/*.sock                          # UDS，mode 0600
/etc/systemd/system/openchat*.service
/etc/systemd/journald.conf.d/openchat.conf
```
