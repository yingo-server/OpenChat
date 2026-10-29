# OpenChat 开发文档

OpenChat 采用分层 socket 架构：总线层为骨架，桥接层为枢纽，用户层/管理层/数据层经桥接通信。除管理层到桥接使用 HTTP API 外，所有层间通信均为内部 socket 长连接；前端到用户层使用 WebSocket。

## 文档索引

| 文档 | 内容 |
|---|---|
| [架构总纲](architecture.md) | 分层架构、kind 号段、全链路时序、目录结构、部署形态 |
| [总线与桥接层设计](bridge-design.md) | 桥接流水线组件、背压、crash-only 恢复、ctl 工具 |
| [用户层与前端设计](user-frontend-design.md) | WS 网关管道、前端分层、sync 引擎、渲染器注册表 |
| [管理层与数据层设计](admin-data-design.md) | 数据操作 kind、DDL 分域、写管道、REST API、RBAC |
| [Web UI 设计规范](web-ui-spec.md) | 设计令牌、组件规范、消息区交互、性能指标 |
| [限流与安全规范](security-spec.md) | 分层限流、认证、上传安全、运维基线、合规 |
| [已知问题](known-issues.md) | 1.0 已知缺陷、影响范围与计划修复版本 |

## 技术栈

- 后端：Go（多进程分层，systemd 部署）
- 前端：React 18 + TypeScript + Vite
- 协议：Protobuf Envelope（单一契约源 `proto/`）
- 存储：SQLite（热，本机）/ PostgreSQL（冷，外部）

## 设计律

1. 每个组件只做一件事并做好；组件经 channel 管道串联，禁止 god-component
2. 一切皆帧：控制、数据、管理、观测统一为 Envelope 帧
3. 机制与策略分离：可运营变更的常量一律入 `policy.json` / feature flags
4. crash-only：故障即重启，靠 REQ/ACK 补发恢复，不写容错状态机
5. 日志只写 stdout，交给 journald；所有操作有 CLI 等价物

## 贡献

提交前请确认：`make lint && make test` 通过；安全相关改动须对照 [限流与安全规范](security-spec.md) 的红线清单自审。
