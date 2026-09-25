# dsh-deep-purge

> 给 DeepSeek Harness 加一个**彻底删除会话**的按钮：会话日志、投影缓存、工作区记账，以及**本会话自己的附件副本**，一次清干净。
>
> A thorough "permanently delete session" action for DeepSeek Harness.

会话行「…」菜单里多一行红色 **彻底删除…**，点开是一个带警告和确认勾选框的对话框，删完给出逐项汇总。

---

## 它删什么

| 目标 | 位置 | 方式 |
|---|---|---|
| 会话日志 | `<DSH_HOME>/sessions/<工作区>/<会话>/` | 递归删除，**两种 id 拼写**（`uuid` 与 `session-uuid`）都扫；空掉的工作区目录一并收掉 |
| 投影缓存 | `storageDomain('session_projcache')` 的 `sessions` 表 | 通过运行时服务删除，内存与磁盘同时更新 |
| 工作区记账 | `workspaces.sessionIds` + 全局 `archivedSessionIds` | 同上 |
| **本会话引用的附件** | `<DSH_HOME>/attachments/v1/objects/<sha256>` | **引用计数**，只删没有其他会话引用的 |
| 请求图片转码缓存 | `<DSH_HOME>/cache/attachments/request-images` | 整目录清空（纯缓存，可重建） |

## 它**不**删什么

- **仍被其他会话引用的附件**。附件是内容寻址存储，分叉（fork）出来的会话会继承父会话的事件、因而共享同一批 `attachmentId`。删共享对象会让另一个会话的图片变成坏引用，所以宁可保留。
- 工作区目录本身、以及任何未被该会话引用的文件。

## 为什么可以放心点

1. **Fail-safe**：删附件前会扫描所有幸存会话的日志。只要有**任何一个**读不出来，附件回收就**整体跳过**（宁可不删，不误删），并在结果里说明原因。
2. **过度收集**：任何形如 `sha256:<64hex>` 的 `attachmentId` 都算引用。误判只会让对象多活一会儿，漏判才会毁数据。
3. **运行中拒删**：会话有活跃 agent 时返回 409，前端提示"正在运行，请等它结束后再删除"。
4. **接口二次确认**：`POST` 请求体里的 `confirm` 必须原样等于 `sessionId`，防误触和脚本乱调。
5. **路径逃逸防护**：删除附件对象前校验目标路径必须落在 `objects/` 之下，且文件名必须是 64 位十六进制。

## 安装

**从 GitHub 安装**（推荐）：

```bash
dsh plugin --profile web add github:HunLongBaiZe/dsh-deep-purge
```

**从本地目录安装**：在 DSH 桌面端的「插件管理器」里粘贴本目录的绝对路径，或

```bash
dsh plugin --profile web add /path/to/dsh-deep-purge
```

装完**重启应用**生效。

> **不需要构建。** 本插件是纯 JavaScript（宿主 ESM + 浏览器端经典脚本），没有 `prepare`/`postinstall` 脚本，所以 pnpm 不会要求你放行构建脚本——对比之下，从源码安装需要编译的插件必须先过 `allowBuilds` 审批。

## 要求

- DSH **≥ 0.1.6**（用到的客户端 slot、`sessionPersistence` 读句柄、`storageDomain` 域服务在该版本已具备；已在 0.1.6-alpha.2 与 0.1.7-rc.2 上核对）
- Node **≥ 20**（宿主半边）

## 用法

1. 侧栏把鼠标移到某个会话行 → 点「…」
2. 选最下面、带分隔线的红色「**彻底删除…**」
3. 对话框里勾选「我明白此操作不可撤销」，再点「彻底删除」
4. 完成后弹汇总：

```
日志目录：删除 1 个
投影缓存：已清
工作区记账：已清
附件回收：引用 11 个 → 删除 11 个（1.6 MB）
因其他会话仍在引用而保留：0 个（扫描了 6 个会话）
请求图片缓存：清空 6 个（694.0 KB）
```

## 它是怎么接进界面的

不注入 DOM、不猜标题、不做 CSS 手术——两处都用官方扩展点：

| 界面部分 | 扩展点 |
|---|---|
| 会话行菜单项 | slot `sidebar.workspaces.session.menu.item`（`order: 500`，排在归档 400 之后） |
| 确认对话框 | slot `shell.overlay` + primitives 的 `RiskConfirmation`（警告行 + 必选勾选框 + `outline`/`primary` 按钮配对） |
| 结果汇总 | `Modal` + `primary` 按钮 |

宿主半边注册两个端点（不占用 `/api`，避免浏览器信任围栏）：

- `GET  /__deep-purge/info` — DSH home、sessions 根、附件库与缓存的文件数/体积
- `POST /__deep-purge/delete` — `{ sessionId, confirm, attachments?, requestImages? }`

## 开发

```bash
node test/run-tests.mjs
```

26 项离线集成测试：用假 ctx + 真文件系统覆盖引用计数（共享保留 / 独占删除）、fail-safe 跳过、409 运行中拒删、confirm 校验、裸 uuid 与 `session-` 前缀两种拼写。

## License

MIT
