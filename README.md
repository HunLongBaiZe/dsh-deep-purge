# dsh-deep-purge

在 DSH 侧栏会话行的「…」菜单里加一项「彻底删除…」，一次清掉会话日志、投影缓存、工作区记账，以及这个会话自己用到的附件副本。删除前有风险确认弹窗，删除后给出逐项汇总。

**不删仍被其他会话引用的附件**。附件按内容哈希存储，分叉出来的会话会继承父会话的图片、因而共享同一批对象；删掉共享对象会让另一个会话的图片变成坏引用，所以这种情况一律保留。

## 安装

从 GitHub 安装：

```sh
dsh plugin --profile <profile> add github:HunLongBaiZe/dsh-deep-purge
```

或用本地目录：

```sh
dsh plugin --profile <profile> add file:/path/to/dsh-deep-purge
```

重启 profile 生效。

## 功能

- 侧栏会话行「…」菜单增加「彻底删除…」，危险配色，排在归档之后
- `RiskConfirmation` 风险确认：勾选「我明白此操作不可撤销」后确认按钮才可用
- 删除范围：
  - 会话日志目录（同时处理 `uuid` 与 `session-` 前缀两种 id 拼写，空掉的工作区目录一并收掉）
  - 投影缓存（`session_projcache` 的 `sessions` 表，经活动 storageDomain，内存与磁盘保持一致）
  - 工作区记账（`workspaces.sessionIds` 与全局 `archivedSessionIds`）
  - 本会话引用、且没有其他会话引用的附件对象
  - 请求图片转码缓存（纯缓存，可重建）
- 删除后弹出汇总：删了几个日志目录，附件引用／删除／保留的数量与释放空间

## 安全措施

- 回收附件前扫描所有幸存会话的日志，任何一个读不出来就整体跳过附件回收
- 收集引用时倾向"过度收集"：任何形如 `sha256:<64hex>` 的 `attachmentId` 都算引用；误判只会让对象多活一会儿，漏判才会毁数据
- 有活跃 agent 的会话拒绝删除，返回 409
- 宿主端点要求请求体里的 `confirm` 与 `sessionId` 完全一致，防误触与脚本乱调
- 删除附件对象前校验路径必须落在 `objects/` 之下，且文件名为 64 位十六进制

## 兼容性

需要 DSH ≥ 0.1.6。用到的客户端 slot、`sessionPersistence` 读句柄与 `storageDomain` 域服务在该版本已具备，已在 0.1.6-alpha.2 与 0.1.7-rc.2 上核对。

界面接入不使用 DOM 注入：菜单项注册进 `sidebar.workspaces.session.menu.item`，对话框注册进 `shell.overlay`，使用 primitives 的 `RiskConfirmation` 与 `Modal`。

## 开发

```sh
node test/run-tests.mjs
```

26 项离线测试，用假 ctx 加真文件系统覆盖引用计数（共享保留／独占删除）、fail-safe 跳过、运行中拒删、confirm 校验，以及两种 id 拼写。

## 更新日志

- **v0.1.0（2026-09-25）**：首个版本。

## License

MIT
