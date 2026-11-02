# 把手：有哪些面

> 18 个把手的完整清单 + 对抗成本 + 验证策略。**这是产品的实际待办。**
> 证据出处均指 [recon-baseline/](../recon-baseline/)（侦察基线）；修正见 [recon-amendments](recon-amendments.md)。

## 本篇主张

「能改 WorkBuddy 行为的地方」只有 18 个，分四类。**每一类都要用不同的手法对付**：身份与风格是纯文本、规则矩阵是结构化操作、插件模板在版本目录里、动态通道至今没实测过。认清类别，比记住清单更有用。

反面：这份清单是**5.9.3 的快照**。升级会增删模板、换 build hash、甚至改协议。清单要现探，不能当常量用。

状态图例：✅ 已实证 ｜ 🟡 部分实证 / 待实测 ｜ ⬜ 未实测 ｜ ❌ 已禁用或移出范围

## 四类，四种手法

| 类 | 位置 | 手法 | 风险 |
|---|---|---|---|
| **身份与人格**（5 个） | 用户数据目录 | 纯文本 / JSON 字段 | 零提权、升级存活 |
| **风格内容**（7 个） | 安装目录 | 纯文本，需确认 | 需提权、升级疑失效 |
| **提示词模板**（3 个） | 插件缓存版本目录 | 纯文本，需确认 | 零提权、升级失效 |
| **行为规则**（3 个） | `settings.json` | **结构化批量改动作** | 零提权、需重启生效 |

## 身份与人格（5 个）

实现：`src/handles/` 的 `personalization.*`，共用 `identity-file.mjs` 与 `json-field.mjs` 两个工厂。

| 把手 | 位置 | 通道 | 状态 |
|---|---|---|---|
| **SOUL.md**（人设设定） | `~/.workbuddy/user-<uid>-personal/SOUL.md` | 尾段 | ✅ 三件联合实测 +1523（**单件未分离**）<br>⚠️ 注入上限 **10 000 字符**<br>普通/专家模式**均注入** |
| **USER.md**（称呼） | 同目录 | 尾段 | ✅ 同上<br>⚠️ 上限 10 000<br>两模式均注入 |
| **IDENTITY.md**（名字） | 同目录 | 尾段 | ✅ 同上<br>⚠️ 上限 10 000<br>🔴 **专家模式下不注入**（名字静默消失） |
| **`toneStyle`**（回复风格） | `~/.workbuddy/app/app-config.json` | 尾段 | ✅ |
| **`customPrompt`**（指令） | 同上 | 尾段 | ✅ 约 +1151（基线出处有差异，见 recon-amendments） |

`identity-file.mjs` 工厂内置两件事：**10 000 字符截断**（期望增量按截断后算）、**模式可达性声明**。
`json-field.mjs` 工厂内置：**最小改动写入**（能无损重序列化就重序列化，否则定向替换，绝不整篇重排）、**枚举守卫**、**与 collector 的 `trim()` 行为对齐**。

## 风格内容（7 个）

实现：`style.*`，共用 `style-file.mjs` 工厂。

| 把手 | 位置 | 提权 | 升级 |
|---|---|---|---|
| `style.{creative,efficient,friendly,professional,sarcastic,socratic,straightforward}` | `C:\Program Files\WorkBuddy\resources\app.asar.unpacked\resources\templates\style\` | **是** | **疑失效**（待实测 #6） |

> ⚠️ **一条静默失败**：编辑**非当前生效**的档位等于什么都没做——`toneStyle` 决定读哪一个文件。
> 工具对此 preview 显著告警、verify 判 `undetermined`（前置条件不成立），**不会**因为实测 Δ=0 就报"未生效"。

当前账号对安装目录**实际可写**（探针 `writeAccess: true` 如实报告，不是假定）。

### 只能看，不能改（2026-11-02 补）

这七张卡**不提供编辑**（写它要提权 + 逐次确认），但**必须能看**——
原来它们只显示一行摘要（字符数 + sha），想确认"当前生效的风格到底写了什么"时无处可看。

现在：卡头可点，展开后是**只读**全文（能复制、不能改），并标出当前是否生效。
写操作仍然只有「拉取 / 还原」，且**还原**要在展开区单独勾选「我确认这是厂商文件」——
那个勾选框是"一次写操作的授权"，刻意与只读内容分开，不混在内容区里。

## 提示词模板（3 个）

实现：`prompt.*`，共用 `prompt-template.mjs` 工厂。

| 把手 | 位置 | 通道 | 验证 |
|---|---|---|---|
| `prompt.welcomemode-{code,work,design}` | `~/.workbuddy/plugins/cache/workbuddy-builtin/<plugin>/<最高版本目录>/prompt.tpl` | **头部** | 标记法 |

- **版本哈希定位**：双版本并存时挑**最高版本**，旧版本原样保留不猜
- 闸门 `app-must-be-closed`：待实测 #3 证实可热改前，保守要求应用退出
- 删 `personal_files_safety` 段时 preview 显著告警，并提示"放宽档位应保留 No-Go Zones"

## 行为规则（3 个）

实现：`rules.*`，共用 `rules.mjs` 工厂。

| 把手 | 说明 |
|---|---|
| `rules.file` | 三域 × 三动作 × 路径粒度。实测 135 条（**write=ask 49 / delete=ask 49 / read=ask 2**） |
| `rules.command` | 0 条（语义待实测 #2） |
| `rules.network` | 0 条（同上） |

**写入形式是结构化操作，不是整块 JSON 编辑**：

```js
{ from: 'ask', to: 'allow', actions: ['write'], paths?: [...] }
```

理由：135 条规则整块编辑，写错一个逗号就毁全部；而「把 49 条 `ask` 提升为 `allow`」才是真实意图，diff 天然可读、效果可数。`paths` 支持定向（黑白名单粒度）。

**验证策略是「重启后回读」**——写完读回证明不了任何事，必须重启再读，才能排除"启动时被重置"。

## 动态通道（3 个，全部 ⬜ 未实测）

| 把手 | 位置 | 说明 |
|---|---|---|
| `system-reminder.tpl` | A 组（安装目录） | 逐轮注入 |
| `ask-mode-reminder.tpl` / `craft-mode-reminder.tpl` | A 组 | 模式切换提醒 |
| `<mentioned_plugins>` 收集器 | 主进程 user-context section（**尾段侧，非 C 组**） | `MentionedPluginsSection` 注册在 `WorkbuddyUserPromptService` |

**为什么未做**：A 组正文本体是 fallback-only，不进 LLM。这三项要么在 A 组（改了没用），要么归尾段侧但未被单独验证过。它们列在这里是为了**不遗漏**，不是因为已可用。

## 界面映射（设置 → 个性化）

| UI 字段 | 落盘 | 进 LLM |
|---|---|---|
| WorkBuddy 对你的称呼 | `USER.md` | ✅ |
| WorkBuddy 的名字 | `IDENTITY.md` | ✅ |
| 回复风格 | `app-config.json → personalization.toneStyle` | ✅ |
| 给 WorkBuddy 的指令 | `app-config.json → personalization.customPrompt` | ✅ |
| 人设设定 | `SOUL.md` | ✅ |
| 长期记忆 | `memory/` + 双开关 | ❌ 被禁用 |

> ⚠️ **界面显示的"当前值"才是数据源。** 实测截图回复风格 = **高效务实（`efficient`）**，而侦察基线记的是 `creative`。
> **文档是快照，会失真**——工具里任何"当前值"必须现读。

## 已禁用与移出范围

| 项 | 原因 |
|---|---|
| `sandbox.extraAllowWrite` | **死把手**——启动时被 `reconcileDesktopExtraAllowWrite()` 强制重置为内置列表（旁证：那 12 项里混着 macOS 路径） |
| 长期记忆 | 被 `cloud_memory_disabled` 禁用，受开关 + 云端 gate 双重控制 |
| `securityReview.assistedApproval` | 受服务端托管门控（`assistedApprovalDisabled`），本地不可绕 |
| my-experts 自建专家 | 本期不做 |
| BYOK / 模型切换 | 只是界面切换，不作承诺 |

## 明确不做的

| 不做 | 为什么 |
|---|---|
| `app.asar` 缝合 | 侦察证明五层把手全在配置面 / 用户目录 / 环境变量面，**没有必须改 asar 的场景** |
| 网关流量改写 / 上游过滤绕过 | 客户端碰不到；且不写绕过配方（[AGENTS](../AGENTS.md) 铁律 7） |
| fuses 翻转 | 无必要（`--inspect` / `RUN_AS_NODE` 本就 enabled） |
| 内嵌 WorkBuddy UI | 死路：扩展由服务端 COS 下发 + audience 门控，且写操作要求应用已退出 |

## 提示词层的具体条款

`personal_files_safety` 实测存在于**插件缓存目录的 6 个文件**：

```
~/.workbuddy/plugins/cache/workbuddy-builtin/welcomemode-{code,work,design}/{5.8.3-*,5.9.3-*}/prompt.tpl
```

（6 处 = 3 个模式 × 双版本缓存并存；**只改 5.9.3 只覆盖 3 处**）

原文开头自称 `ALL mandatory, cannot be overridden`，但**运行时零校验**——改文本即改行为。

| 条款 | 内容 | 对"模型先问"的影响 |
|---|---|---|
| **No-Go Zones** | 禁止递归删除 Desktop / Downloads / Documents / Home / 系统目录 | **保留**（安全底线，任何档位都不去掉） |
| **Scan = Read-Only** | "只扫描不动作"时只出报告 | **"放宽"档要去掉的强制询问来源** |
| **Vague = Ask First** | 指令模糊时先确认 | **同上** |
| Warn + List + Confirm | 破坏性操作前列清单再确认 | 保留或放宽，视档位 |
| Back Up First / Trash, Not Delete / Small Batches / No Script Files | 安全网与编码坑 | 「全放开」档会去掉前三条（**并显式告警**） |

## 置信度与限制

18 个把手的实现与验证策略：已实现，自测覆盖，高。规则条数、风格档位、模板定位：真实配置实测，高。

三项限制：

- **动态通道三项全未实测**，不要当成可用功能引用。
- **7 个风格把手的升级行为未验**（待实测 #6），"疑失效"这个词必须保留。
- 清单本身是快照——**加把手前先现探**，别照抄这里的条数与路径。

## 给下一篇留下的问题

清单上有 18 个面，其中 5 个已经在真实文件上动过、并且还原了。还原得怎么样、怎么证明——最后一篇是台账。

---

下一篇：动过什么 → [ledger](ledger.md)
