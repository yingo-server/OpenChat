# OpenChat

OpenChat 是一个自托管的即时通讯服务：单聊、群聊、图片与语音消息、多设备同步，全部数据由你自己的服务器掌控。

## 特性

- **实时通讯**：单聊与群聊，消息送达/已读回执，离线消息自动补拉
- **多媒体**：图片、语音消息、文件传输，缩略图渐进加载
- **多设备**：同一账号最多 3 台设备同时在线，消息全端同步
- **账号体系**：手机验证码、邮箱链接、微信、Apple、一键登录，支持游客模式
- **数据自主**：冷热双存储，热数据 90 天留在本机，全量历史归档至外部数据库；随时导出或删除
- **资源友好**：2 核 2G 服务器即可运行，单二进制部署，无容器依赖

## 快速开始

### 要求

- Linux 服务器（2C2G 起），systemd
- 域名与 TLS 证书（Caddy 自动获取）
- 外部 PostgreSQL（冷存储，可选初期用同一台）

### 安装

```bash
# 1. 获取发布包（版本号见 https://github.com/yingo-server/OpenChat/releases）
V=0.1.1
curl -LO https://github.com/yingo-server/OpenChat/releases/download/v$V/openchat-v$V-linux-amd64.tar.gz
curl -LO https://github.com/yingo-server/OpenChat/releases/download/v$V/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
tar -xzf openchat-v$V-linux-amd64.tar.gz

# 2. 安装
sudo ./install.sh   # 部署二进制、systemd 单元、生成配置与密钥

# 3. 配置域名
sudoedit /etc/openchat/openchat.toml

# 4. 启动
sudo systemctl enable --now openchat
```

打开 `https://你的域名` 即可使用。首次注册的账号自动成为管理员。

### 升级

```bash
sudo openchatctl upgrade    # 下载新版本、校验、滚动重启
```

## 常用运维

| 命令 | 用途 |
|---|---|
| `openchatctl status` | 查看服务状态、在线连接数、队列水位 |
| `openchatctl backup` | 立即备份热库与密钥配置 |
| `openchatctl ban <uid>` | 封禁用户 |
| `openchatctl drain` | 维护前优雅排空连接 |
| `openchatctl flags list` | 查看功能开关 |

日志：`journalctl -u openchat -f`

## 文档

- [用户指南](docs/user-guide.md)：账号、消息、隐私设置、数据导出与注销
- [管理员指南](docs/admin-guide.md)：部署、备份、封禁、广播、故障处理
- [开发文档](docs/README.md)：架构设计、协议、贡献指引

## 许可

[Apache-2.0](LICENSE)
