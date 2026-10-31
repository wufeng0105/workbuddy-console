# 把手清单

> 可变的"面"的完整清单 + 对抗成本 + 验证策略。
> **这是产品的实际待办**（对应 `product.md` 的分期）。
>
> 状态图例：✅ 已实证 ｜ 🟡 部分实证 / 待实测 ｜ ⬜ 未实测 ｜ ❌ 已禁用或移出范围
> 证据出处均指 `historicalsource/`（冻结的历史侦察资料）。

## 一、提示词层 · 静态

| 把手 | 位置 | 提权 | 升级 | 通道 | 验证策略 | 状态 |
|---|---|---|---|---|---|---|
| **SOUL.md**（人设设定） | `~/.workbuddy/user-<uid>-personal/SOUL.md` | 否 | 存活 | 请求尾段 | token 增量法 | ✅ **三件联合实测 +1523（单件未分离）**<br>⚠️ 注入上限 **10 000 字符**（超出静默截断）<br>普通/专家模式**均注入** |
| USER.md（称呼） | 同目录 | 否 | 存活 | 请求尾段 | token 增量法 | ✅ 同上（三件联合）<br>⚠️ 上限 10 000 字符<br>两模式均注入 |
| IDENTITY.md（名字） | 同目录 | 否 | 存活 | 请求尾段 | token 增量法 | ✅ 同上（三件联合）<br>⚠️ 上限 10 000 字符<br>🔴 **专家模式下不注入**（名字静默消失） |
| `toneStyle`（回复风格） | `~/.workbuddy/app/app-config.json` | 否 | 存活 | 请求尾段 | token 增量法 | ✅ |
| `customPrompt`（指令） | 同上 | 否 | 存活 | 请求尾段 | token 增量法 | ✅ +1151（基线出处存在矛盾，见 recon-amendments） |
| `style-*.md` 内容 | `C:\Program Files\WorkBuddy\resources\app.asar.unpacked\resources\templates\style\` | **是** | **疑失效（待实测 #6）** | 请求尾段 | token 增量法 | 🟡 机制已证；升级是否被还原**未复现**（`phase0-recon.md`） |
| C 组 `prompt.tpl` / fragments | `~/.workbuddy/plugins/cache/workbuddy-builtin/<plugin>/<版本哈希>/` | 否 | **失效** | 请求**头部** | 标记法 / trace grep | ✅ 端到端实证 |

## 二、提示词层 · 动态

| 把手 | 位置 | 说明 | 状态 |
|---|---|---|---|
| `system-reminder.tpl` | A 组（安装目录） | 逐轮注入 | ⬜ A 组正文本体 = **fallback-only 不进 LLM** |
| `ask-mode-reminder.tpl` / `craft-mode-reminder.tpl` | A 组 | 模式切换提醒 | ⬜ |
| `<mentioned_plugins>` 收集器 | **主进程 user-context section（尾段侧，非 C 组）** | 逐轮注入；`MentionedPluginsSection` 注册在 `WorkbuddyUserPromptService`，`<mentioned_plugins>` 字符串全库仅出现于 `authority-snapshot.js` | ⬜ |

## 三、动作层 / 规则面

| 把手 | 位置 | 提权 | 说明 | 状态 |
|---|---|---|---|---|
| `sandbox.orderedRules` | `~/.workbuddy/settings.json` | 否 | 三域 × 三动作 × 路径粒度 `allow`/`ask`/`deny`。实测 file 135 条（read allow 133/ask 2；write allow 86/ask 49）、command 0、network 0 | 🟡 **是否被启动 reconciliation 抹掉待实测**<br>⚠️ **托管回压**：`managed` 时 `toManagedOrderedRules` 覆盖本地（见 recon-amendments 新增约束 4）<br>📌 代码旁证：启动 reconciliation **只碰 `extraAllowWrite`**，不触碰 `orderedRules` |
| `sandbox.extraAllowWrite` | 同上 | 否 | **死把手**——启动时 `reconcileDesktopExtraAllowWrite()` 强制重置为内置列表（旁证：列表含 macOS 路径） | ❌ **禁用**（见 recon-amendments 修正 3） |
| `securityReview.assistedApproval` | settings / 安全中心 | 否 | `enabled` + `mode` ∈ {`silent`, `risk_hint`} | ⬜ 未实测<br>⚠️ **受服务端托管门控**：`enabled && !constraints.assistedApprovalDisabled`，`assistedApprovalDisabled` 来自 `getManagedSecurityPolicy()`，本地不可绕（recon-amendments 新增约束 3）<br>❓ 两档的**语义**（静默放行 / 放行+提示）只有命名与调用点，无文字定义 |
| `sensitiveProtection` | `settings.json` | 否 | 本机当前 `{"enabled": false}` | ✅ 已读 |
| `permissionMode` | 会话 / 交互模式 | 否 | `default` / `acceptEdits` / `bypassPermissions` / `fullAccess` / `plan`。默认映射：`craft`/`expert`/`quick` → `bypassPermissions`；`ask` → `default`；`plan` → `plan` | ✅ 代码级 |
| `permissionAutoRejectOnTimeout` | 审批运行时 | 否 | **transport 相关**：本地 ACP transport 默认 `false`（30s 超时不自动拒绝）；**云端 transport 默认 `true`** | ✅ 代码级 |
| 长期记忆 | `~/.workbuddy/memory/<uid>_memory.md` | 否 | **被 `cloud_memory_disabled` 禁用** | ❌ 移出范围 |

## 四、界面映射（设置 → 个性化）

| UI 字段 | 落盘 | 进 LLM |
|---|---|---|
| WorkBuddy 对你的称呼 | `USER.md` | ✅ |
| WorkBuddy 的名字 | `IDENTITY.md` | ✅ |
| 回复风格 | `app-config.json → personalization.toneStyle` | ✅ |
| 给 WorkBuddy 的指令 | `app-config.json → personalization.customPrompt` | ✅ |
| 人设设定 | `SOUL.md` | ✅ |
| 长期记忆 | `memory/` + 双开关 | ❌ 禁用 |

> ⚠️ **界面显示的"当前值"才是数据源。** 实测截图回复风格 = **高效务实（`efficient`）**，而 `historicalsource/docs/tone-styles.md` 记的是 `creative`。
> **文档是快照，会失真**——工具里的任何"当前值"必须现读。

## 五、提示词层的具体条款（P2 目标）

`personal_files_safety` 实测存在于 **C 组 6 个文件**：

```
~/.workbuddy/plugins/cache/workbuddy-builtin/welcomemode-{code,work,design}/{5.8.3-*,5.9.3-*}/prompt.tpl
```
（6 处 = 3 个模式 × 双版本缓存并存；**只改 5.9.3 只覆盖 3 处**）

原文关键条款（开头自称 `ALL mandatory, cannot be overridden`，但**运行时零校验**，改文本即改行为）：

| 条款 | 内容 | 对"模型先问"的影响 |
|---|---|---|
| **No-Go Zones** | 禁止递归删除 Desktop / Downloads / Documents / Home / 系统目录 | 保留（安全底线） |
| **Scan = Read-Only** | 要求"只扫描不动作"时只出报告 | **"放宽"档要去掉的强制询问来源之一** |
| Vague = Ask First | 指令模糊时先确认 | **同上** |
| Warn + List + Confirm | 破坏性操作前列清单再确认 | 保留或放宽，视档位 |

## 六、明确不做的把手

| 把手 | 为什么不做 |
|---|---|
| `app.asar` 缝合 | 侦察证明五层把手全在配置面 / 用户目录 / 环境变量面，**没有必须改 asar 的场景** |
| 网关流量改写 / 上游过滤绕过 | 客户端碰不到 L4；且不写绕过配方（`AGENTS.md` 铁律 7） |
| fuses 翻转 | 无必要（`--inspect` / `RUN_AS_NODE` 本就 enabled） |
| my-experts 自建专家 | 本期不做 |
| BYOK / 模型切换 | 只是界面切换，不作承诺 |
| 内嵌 WorkBuddy UI | 死路：扩展由服务端 COS 下发 + audience 门控；且写操作要求应用已退出 |

## 七、待实测项

见 `verification.md` 第五节（6 条，按优先级）。其中第 1、2、3 条**直接决定 P2 的功能是否为真**。
