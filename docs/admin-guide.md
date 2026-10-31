# OpenChat 管理员指南

面向自部署 OpenChat 的服务器管理员。

## 部署

### 要求

- Linux 服务器（2C2G 起），systemd
- 域名，TLS 由 Caddy 自动管理
- 外部 PostgreSQL（冷存储）

### 初始化

```bash
sudo ./install.sh                    # 部署二进制/单元/配置/密钥
sudoedit /etc/openchat/openchat.toml # 填写域名、冷库连接、短信供应商
sudo systemctl enable --now openchat
```

首次注册的账号自动成为管理员。**务必立即**：管理后台 → 设置 → 开启 TOTP 二步验证、配置 IP 白名单。

## 日常运维

```bash
openchatctl status          # systemd unit 状态 + SIGUSR1 dump 摘要 + 热库统计（消息数/最新时间/文件大小）
openchatctl backup          # 立即备份（热库 + 配置 + 密钥清单）
journalctl -u openchat -f   # 跟随日志；-g trace_id=xxx 排查单条消息
```

热库 SQLite 保留最近 90 天，每日 04:00 自动归档至冷库，备份每日 05:30 自动执行（策略见 `/etc/openchat/policy.json`，改完 `systemctl reload openchat` 生效）。

## 内容治理

- **封禁**：后台用户页或 `openchatctl ban <uid> --level 2 --days 7`。封禁立即断开其全部连接并撤销登录凭证
- **举报**：后台举报队列按时间倒序；普通举报 24h 内处理，涉未成年人/人身威胁 2h 内升级
- **紧急下架**：涉即时人身危险内容，值班管理员单人可即时下架并全端撤回，事后 24h 补双人复核
- **广播**：后台编写 → 预览触达人数 → 发送；支持定时

## 应急

| 场景 | 操作 |
|---|---|
| 注册被刷 | 后台开关：禁注册（游客通道同步关闭） |
| 数据事故 | 后台开关：全站只读（可收不可发），随后排查 |
| 安全事故 | `sudo systemctl stop openchat`，防火墙只留 SSH，通知用户 |
| 单用户盗号 | 立即封禁（撤销全部登录凭证），联系用户核实后解封 |

以上开关须 5 分钟内可执行；全部操作自动写入审计日志（防篡改哈希链，每日校验）。

## 合规要点

- 审计日志保留 5 年；登录日志 180 天；用户注销有 15 天冷静期
- 用户申请数据导出须在规定时间内响应（后台导出队列）
- 举报证据加密保全，不可被普通删除流程清除

## 升级与回滚

> ⚠️ 未实现：`openchatctl upgrade` / `upgrade --rollback` 尚不存在（CLI 无该子命令）。升级/回滚请手工执行：

```bash
# 升级：替换二进制 + 滚动重启（连接优雅排空，用户无感）
sudo install -m 0755 /opt/openchat/current/bin/openchatctl /usr/local/bin/openchatctl
sudo install -m 0755 /opt/openchat/current/bin/chatd        /usr/local/bin/chatd
sudo systemctl restart openchat

# 回滚：切回上一版本二进制后重启
sudo install -m 0755 /opt/openchat/previous/bin/chatd /usr/local/bin/chatd
sudo systemctl restart openchat
```

详细架构与开发信息见 [开发文档](README.md)。
