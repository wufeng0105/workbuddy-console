# 对冻结侦察资料的修正登记

> `recon-baseline/` 是**已冻结**的侦察资料（只读，不修改）。但其中若干结论与本文件登记的修正**冲突或缺失**。
> 本文件是本仓库对外的**唯一修正入口**——读到冲突时，**以本文件为准**。
>
> 登记纪律：每条修正必须有**代码级或可复现的证据**，并写明它推翻了哪一处。

---

## 修正 3 · `sandbox.extraAllowWrite` 是**死把手**（推翻侦察结论）

| 项 | 内容 |
|---|---|
| **原结论（已作废）** | `recon-baseline/findings/06-action-layer.md` 把手表：`sandbox.extraAllowWrite \| 扩沙箱写权限 \| 零改动`；`recon-baseline/findings/00-overview.md` 同样把它列为"官方配置面…零" |
| **新结论** | **死把手，禁用。** WorkBuddy 启动时把它**整数组重置**为内置列表，用户新增项被抹掉 |
| **证据** | `recon-baseline/evidence/asar-extract/main/server.js` — `reconcileDesktopExtraAllowWrite`：读 `sandbox.extraAllowWrite` → 与内置表 `rT` 逐项比较 → 不等则 `t.extraAllowWrite = i` 整体覆盖并写回 `settings.json`；模块构造时无条件调用（日志串 `[SecurityCenter] Reconciled sandbox.extraAllowWrite (N paths) to settings.json`） |
| **旁证** | 本机实测该列表恰 **12 项**，且含 macOS 路径（`~/Library/Application Support/beisencli/`、`~/Library/Application Support/tmeet`）与 `/tmp/dws-cache` —— **Windows 机器上出现 macOS 路径**，证明是 App 自管的跨平台默认表，不是用户意图 |
| **影响** | 任何"写 `extraAllowWrite` 来扩权"的实现都会**静默失效**（下次启动被抹）。本仓库已在 `src/core/contracts.mjs` 把 `upgradeBehavior: 'dead'` 设为**注册即拒** |
| **为什么侦察没发现** | 侦察期只做了静态配置面读取（`action-layer.md` E5-1），没有检查该键是否被启动逻辑重写 |

---

## 新增约束 1 · 身份三文件 **10 000 字符硬截断**（侦察资料完全无记录）

| 项 | 内容 |
|---|---|
| **事实** | `SOUL.md` / `USER.md` / `IDENTITY.md`（以及 `BOOTSTRAP.md`）在注入前**逐文件截断到 10 000 字符**，**超出部分静默丢弃**（只在渲染文本尾部追加一行 `... (content truncated — exceeded character limit)`，不报错、不告警） |
| **证据** | `recon-baseline/evidence/asar-extract/main/authority-snapshot.js:53` → `var Is=1, Ls=1e4, …`；同文件 `:184` → `e.SoulContent=truncateContent(l[0],Ls)`、`e.UserContent=truncateContent(l[2],Ls)`、`e.IdentityContent=truncateContent(l[3],Ls)`；`truncateContent(e,t)`：`e.length<=t ? e : \`${truncateUtf16(e,t)}\n... (content truncated — exceeded character limit)\`` |
| **为什么重要** | **P0 唯一的把手就是 SOUL.md。** 一个"写进去了、文件确实变了、但超限部分从未进入模型"的场景，会让 token 增量法给出**偏小的 Δ**，进而可能被误判为"未生效"或"无法判定"——而根因是截断，不是通道问题 |
| **本仓库的处置** | 1) `src/handles/personalization.soul.mjs` 内置 `MAX_CHARS = 10000`，`probe` 报告 `limits.exceeded`，`preview` 出告警，`verify` 的**理论增量按截断后的文本计算**（避免用全量文本估出偏大的期望值）；2) 写入 `docs/handles.md` 与 `docs/verification.md` |
| **待实测** | 截断阈值的**实测确认**（写入 10 000+ 字符 → token 增量法看实际注入量），见 `docs/verification.md` 待实测 #8 |

---

## 新增约束 2 · **专家模式下 `IDENTITY.md` 不注入**（侦察资料完全无记录）

| 项 | 内容 |
|---|---|
| **事实** | `isExpert === true` 时：`IDENTITY.md` **不读、不注入**；`BOOTSTRAP.md` 同样跳过。`SOUL.md` 与 `USER.md` **两种模式下都注入** |
| **证据** | `authority-snapshot.js:184`（`IdentityCollector.collect`）：<br>• `s = !t.isExpert && await this.fileExists(i)`（`i` = BOOTSTRAP.md）<br>• `c = [readFileIfExists(SOUL), s ? read(BOOTSTRAP) : '', read(USER)]`<br>• `t.isExpert \|\| c.push(this.readFileIfExists(a))`（`a` = IDENTITY.md）<br>• `t.isExpert \|\| (e.IdentityPath=a, e.IdentityContent=truncateContent(l[3],Ls))`<br>另有 `ExpertPromptSlotCollector` 亦以 `if(!t.isExpert)` 早退 |
| **为什么重要** | 产品核心是"**N 套专家档位 + 一键切换**"。真实行为是：**切到专家模式 = 名字（IDENTITY.md）静默消失**。这把"身份三文件"从"无条件注入"降级为**模式相关注入** |
| **本仓库的处置** | `docs/handles.md` 三个身份把手标注模式条件；`docs/framework.md` 漂移分类增补"模式相关失效"；`docs/product.md` 专家档位模型注明 |
| **对漂移分类的影响** | `framework.md` 原有三类漂移（锚点失效 / 值已变 / 厂商已还原）**覆盖不到**这种"同一文件在不同模式下可达性不同"的情况 |

---

## 新增约束 3 · `assistedApproval` 受服务端托管硬门控

| 项 | 内容 |
|---|---|
| **事实** | `securityReview.assistedApproval` 的生效条件是 `enabled && !constraints.assistedApprovalDisabled`，而 `assistedApprovalDisabled` 来自**服务端托管安全策略**（`getManagedSecurityPolicy()` / `getClientSecurity()`），**本地不可绕过** |
| **证据** | `common.js` — `isSecurityReviewConfigEnabled(t){ return t.config.modelBehaviorReview.enabled \|\| t.config.riskContentProtection.enabled \|\| t.config.assistedApproval.enabled && !t.constraints.assistedApprovalDisabled }`；`server.js` — `securityReview: { ...pickSecurityReviewConfig(n), assistedApprovalDisabled: s.assistedApprovalDisabled === true }`（`s` 来自 `getManagedSecurityPolicy()`） |
| **影响** | 与 `action-layer.md` / `experiments.md` 记录的托管边界同源：**规则面把手的可靠性边界 = 服务端未下发 securityCenter 块** |

---

## 新增约束 4 · `orderedRules` 的托管回压边界

`p.managed === true` 时，`toManagedOrderedRules` 会用托管策略**覆盖本地** `orderedRules`（`action-layer.md` 结论 2 / `experiments.md` 修正 2）。

**个人环境当前 `managed = false`**，但这是**可靠性边界**，必须与规则矩阵把手一并登记。

---

## 记录 · 侦察原文里的作废判定（整理后已就地标注）

`recon-baseline` 归档整理（2026-11-01）时，把两处作废判定**就地处理**了，不再依赖外部提醒：

| 原位置 | 处理 |
|---|---|
| 原 `experiments.md` 中「`customPrompt`/toneStyle 确认为**无 LLM 效力**」的中间判定 | 已在 [recon-baseline/findings/10-experiments.md](../recon-baseline/findings/10-experiments.md) 修正 1 里明确标为作废，并写明推翻理由与复测方法 |
| 原「对 map.md 的修订项」里那条「`customPrompt` → 标注「无效（fallback-only，A 组标记实证）」」 | 已删除——那句把「A 组正文 fallback-only」与「customPrompt 无效」混为一谈，是错误外推 |

**结论口径**：`customPrompt` 与 `toneStyle` 均有效，走 user-context 尾段通道（token 增量实证）。

---

## 记录 · 数值矛盾：`+1019` vs `+1151` —— **已定位根因**

同一次复测（customPrompt 4KB）在两份侦察文档里基线不同：

| 出处 | 记录 |
|---|---|
| `personalization.md:28` | `34830 → 35849`（**+1019**） |
| `experiments.md:22` | `34698 → 35849`（**+1151**） |

**根因（本仓库用 trace 原始数据定位）**：三个数字来自**三条不同的会话**：

| 数字 | 会话（worker） | 会话起点 | 性质 |
|---|---|---|---|
| `34698` | 9212 | 13:39:03 | E 组探针会话的**首条** |
| `34830` | 4632 | 14:41:15 | 另一次会话的**首条** |
| `35849` | 24816 | 14:59:52 | 观测会话的**首条** |

两份文档都拿"某个别的会话的首条"当基线 ⇒ 132 tokens 的**跨会话漂移**被算进了增量。
**两个数字都不算错，但都是跨会话比较，天然带噪。**

**由此得到的工程结论（已写进实现）**：

1. `token-delta` 必须**按会话取首条请求**作对照，不能取"时间上最近的一条"
   （同会话后续轮次含累积历史：本机实测 34826 → 35271 → 38430 → 38610）
2. **会话起点**用 `traces/<worker>/` 的目录创建时间（实测与首条请求相差 27–250 ms）——
   会话在改动前创建 ⇒ user-context 是旧的 ⇒ 整个排除
3. 历史数值**不复用**：作为判据时必须本机当次实测

---

## 记录 · `20003` 不是代码常量

trace 截断值 `20003` 在 `asar-extract` 全库**搜不到**（非代码常量），只存在于侦察文档的观测记录中。

**处置**：`docs/verification.md` 引用它时只作为"该次观测值"，不作为恒定阈值；真正的结论是**方法论**——"尾段通道用 trace grep 会失明"，这一条由代码与实测双重支撑，不依赖该具体数字。
