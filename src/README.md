# src/ —— 分层与实现状态

> 契约定义见 `core/contracts.mjs`；设计依据见 `../docs/framework.md`。

## 分层

```
src/
├─ core/       Core（框架 · 少变）—— 契约 / 引擎 / 注册表 / 备份 / 漂移 / 锚点
├─ handles/    把手适配器（Data · 多变）—— 一个把手一个文件
├─ anchors/    锚点表（Data · 多变）—— 按 WorkBuddy 版本
└─ verify/     验证策略实现（三条 + 回读）
```

**判断一个改动该放哪**：改 `core/` = 改框架（应当罕见）；加 `handles/` 或 `anchors/` = 加数据（常态）。

## 实现状态

| 模块 | 状态 | 说明 |
|---|---|---|
| `core/contracts.mjs` | ✅ 已定 | 契约定义 + `assertHandle()` 校验（**只有接口，无实现**） |
| `core/anchor.mjs` | ✅ 已实现 | 锚点解析：运行时探测版本；位置不可确定即硬报错 |
| `core/backup.mjs` | ✅ 已实现 | manifest + sha256 备份仓、还原、预演、漂移报告 |
| `core/profiles.mjs` | ✅ 已实现 | 档位（源状态）存取：原子写、结构校验、损坏可见；**存用户数据目录，不进仓库** |
| `core/engine.mjs` | ✅ 已实现 | `plan → apply → verify → audit`；apply 前必然先备份；**档位多把手事务**（一次备份 / 一条审计 / 整体还原） |
| `core/trace.mjs` | ✅ 已实现 | 读 `traces/<pid>/trace_*.jsonl` 的 generation usage；排除标题生成 |
| `core/diff.mjs` · `tokens.mjs` · `audit.mjs` · `registry.mjs` · `errors.mjs` · `paths.mjs` · `appstate.mjs` | ✅ 已实现 | 差异、token 估算、台账、注册表、错误、路径、进程探测 |
| `verify/token-delta.mjs` | ✅ 已实现 | 三态判定（生效 / 未生效 / 无法判定） |
| `verify/auto-capture.mjs` | ✅ 已实现 | **自动对照**：用台账的 apply 时间戳 + trace 的 prompt_tokens 取基线/观测；同 worker 时强制降级 |
| `handles/personalization.soul.mjs` / `.user.mjs` / `.identity.mjs` | ✅ 已实现 | 身份文件三件，共用 `identity-file.mjs` 工厂（含 10 000 字符截断与模式可达性） |
| `handles/personalization.tone-style.mjs` / `.custom-prompt.mjs` | ✅ 已实现 | JSON 字段，共用 `json-field.mjs` 工厂（最小改动写入 + 枚举守卫 + `trim()` 对齐） |
| `cli.mjs` | ✅ 已实现 | doctor / list / probe / plan / apply / verify / restore / backups / audit / traces / **serve** |
| `server.mjs` | ✅ 已实现 | 本地控制台服务端：仅回环 + 随机端口 + 一次性 token；前端永不直触文件系统 |
| `handles/style-file.mjs` + `handles/styles.mjs` | ✅ 已实现 | 七档 style 内容（安装目录厂商文件）：`resolveTarget` 参数化定位、生效档位判定、可写性如实报告 |
| `core/appconfig.mjs` | ✅ 已实现 | app-config 读取 + toneStyle 枚举（避免把手之间互相依赖） |
| `handles/prompt-template.mjs` + `handles/prompt-templates.mjs` | ✅ 已实现 | C 组三模式根模板（请求**头部**通道）：版本哈希定位、标记法验证、闸门 `app-must-be-closed` |
| `verify/marker.mjs` | ✅ 已实现 | 标记法三态判定（逐条时间过滤 / 无时间戳降级 / 无 apply 记录降级） |
| `core/trace-raw.mjs` | ✅ 已实现 | trace 原文扫描（标记法用），与 `trace.mjs`（usage 抽取）分工 |
| 其余把手（规则矩阵） | ⬜ 待写 | P2b |
| `web/` 前端 | ✅ 已实现 | 把手面板 / 差异预览 / 三态验证 / 备份还原 |

## 硬约束（写代码前必读）

1. **验证必填**——注册表用 `assertHandle()` 强制；未声明验证策略的把手**不允许上线**。
   字段名是 `verification`（**名词声明**），不要与六步中的动词方法 `verify()` 混淆——同名会互相覆盖。
2. **不猜锚点**——路径 / 键 / 版本一律运行时探测；探测失败**硬报错**。
3. **尾段通道禁用 trace grep**——校验器已内建拦截（截断会产生假阴性）。
4. **死把手不得注册**——`upgradeBehavior: 'dead'` 在 `assertHandle()` 被拒（如 `sandbox.extraAllowWrite`）。
5. **无备份不成写**——`apply` 之前必须已有 manifest。
6. **三态不得合并**——`undetermined`（无法判定）禁止显示为成功。

## 用户数据不在仓库内

`profiles` / `backups` / 状态一律放 `%USERPROFILE%\.workbuddy-console\`（铁律 4，本仓库是 public）。
