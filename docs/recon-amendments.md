# 修正登记：哪些旧结论被推翻

> `recon-baseline/` 是**已冻结**的侦察基线（只读，不修改）。但其中若干结论与本文件登记的修正**冲突或缺失**。
> **本文件是本仓库对外的唯一修正入口**——读到冲突时，以本文件为准。
>
> 登记纪律：每条修正必须有**代码级或可复现的证据**，并写明它推翻了哪一处。

## 本篇主张

侦察基线是快照，工程实现会撞上它没记录、或者记错了的地方。**这份文件就是那些撞击的记录。** 它的存在让「基线仍然权威」和「基线会被推翻」两件事同时成立——前者靠不改原文，后者靠这里逐条登记。

反面：修正史容易变成免责声明。所以每条只写三样——**原结论是什么、新证据在哪一行、影响哪些实现**。不写"我们当时多么谨慎"。

## 修正总览

| # | 类型 | 内容 | 影响 |
|---|---|---|---|
| **修正 1** | 推翻 | `sandbox.extraAllowWrite` 是**死把手** | 任何"写它来扩权"的实现都会静默失效 |
| **新增 1** | 补齐 | 身份三文件 **10 000 字符硬截断** | 期望增量必须按截断后算 |
| **新增 2** | 补齐 | 专家模式跳过 `IDENTITY.md` | 身份三文件从"无条件注入"降为"模式相关" |
| **新增 3** | 补齐 | `assistedApproval` 受服务端托管门控 | 审批把手的可靠性有外部边界 |
| **新增 4** | 补齐 | `orderedRules` 有托管回压 | 规则矩阵不是最终权威 |
| **记录 1** | 存疑 | `+1019` vs `+1151` 基线不一致 | 数值只作约数 |
| **记录 2** | 存疑 | `20003` 不是代码常量 | 只能当观测值 |

> 编号沿用历史（原文从"修正 3"开始），不重排——**改编号会让已有引用全部失效**。

---

## 修正 3 · `sandbox.extraAllowWrite` 是死把手

> 编号为 3 是因为原文已有"修正 1/2"在侦察基线内部；这里是工程侧第一次推翻。

| 项 | 内容 |
|---|---|
| **原结论（已作废）** | `recon-baseline/findings/06-action-layer.md` 的把手表把 `sandbox.extraAllowWrite` 列为「扩沙箱写权限 \| 零改动」；`findings/00-overview.md` 同样列为"官方配置面…零" |
| **新结论** | **死把手，禁用。** 启动时整数组重置为内置列表，用户新增项被抹掉 |
| **证据** | `recon-baseline/evidence/asar-extract/main/server.js` — `reconcileDesktopExtraAllowWrite`：读 `sandbox.extraAllowWrite` → 与内置表 `rT` 逐项比较 → 不等则 `t.extraAllowWrite = i` **整体覆盖**写回 `settings.json`；模块构造时无条件调用（日志串 `[SecurityCenter] Reconciled sandbox.extraAllowWrite (N paths) to settings.json`） |
| **旁证** | 本机该列表恰 12 项，且含 macOS 路径（`~/Library/Application Support/beisencli/`、`.../tmeet`）与 `/tmp/dws-cache` —— **Windows 机器上出现 macOS 路径**，证明这是 App 自管的跨平台默认表，不是用户意图 |
| **影响** | 任何"写 `extraAllowWrite` 来扩权"的实现都会**静默失效**。本仓库已在 `src/core/contracts.mjs` 把 `upgradeBehavior: 'dead'` 设为**注册即拒** |
| **侦察为什么没发现** | 侦察期只做静态配置面读取，没检查该键是否被启动逻辑重写 |

**同一个启动 reconciliation 只碰 `extraAllowWrite`**，不触碰 `orderedRules`（后者走 `ensureOrderedRules` 的 defaults/migrate 路径）——这是待实测 #1 的代码旁证。

---

## 新增约束 1 · 身份三文件 10 000 字符硬截断

侦察资料**完全无记录**。

| 项 | 内容 |
|---|---|
| **事实** | `SOUL.md` / `USER.md` / `IDENTITY.md`（以及 `BOOTSTRAP.md`）在注入前**逐文件截断到 10 000 字符**，超出部分**静默丢弃**——只在渲染文本尾部追加一行 `... (content truncated — exceeded character limit)`，不报错、不告警 |
| **证据** | `authority-snapshot.js:53` → `var Is=1, Ls=1e4, …`；同文件 `:184` → `e.SoulContent=truncateContent(l[0],Ls)`、`e.UserContent=truncateContent(l[2],Ls)`、`e.IdentityContent=truncateContent(l[3],Ls)`；`truncateContent(e,t)` = `e.length<=t ? e : \`${truncateUtf16(e,t)}\n... (content truncated — exceeded character limit)\`` |
| **为什么重要** | P0 唯一的把手就是 SOUL。一个"写进去了、文件确实变了、但超限部分从未进模型"的场景，会让 token 增量法给出**偏小的 Δ**，进而可能误判为"未生效"——而根因是截断，不是通道 |
| **本仓库的处置** | `personalization.soul` 内置 `MAX_CHARS = 10000`；`probe` 报告 `limits.exceeded`；`preview` 出告警；`verify` 的**理论增量按截断后文本算** |
| **待实测** | 截断阈值确认 → [verification](verification.md) #8 |

---

## 新增约束 2 · 专家模式下 `IDENTITY.md` 不注入

侦察资料**完全无记录**。

| 项 | 内容 |
|---|---|
| **事实** | `isExpert === true` 时 `IDENTITY.md` **不读、不注入**；`BOOTSTRAP.md` 同样跳过。SOUL 与 USER **两模式都注入** |
| **证据** | `authority-snapshot.js:184`（`IdentityCollector.collect`）：<br>• `s = !t.isExpert && await this.fileExists(i)`（`i` = BOOTSTRAP）<br>• `c = [readFileIfExists(SOUL), s ? read(BOOTSTRAP) : '', read(USER)]`<br>• `t.isExpert \|\| c.push(this.readFileIfExists(a))`（`a` = IDENTITY）<br>• `t.isExpert \|\| (e.IdentityPath=a, e.IdentityContent=truncateContent(l[3],Ls))`<br>另有 `ExpertPromptSlotCollector` 亦以 `if(!t.isExpert)` 早退 |
| **为什么重要** | 产品核心是「N 套档位 + 一键切换」。真实行为是：**切到专家模式 = 名字静默消失** |
| **本仓库的处置** | `handles.md` 三个身份把手标注模式条件；`framework.md` 漂移分类增补 `mode-dependent`；`product.md` 档位模型注明 |

---

## 新增约束 3 · `assistedApproval` 受服务端托管硬门控

| 项 | 内容 |
|---|---|
| **事实** | 生效条件是 `enabled && !constraints.assistedApprovalDisabled`，后者来自**服务端托管安全策略**，**本地不可绕过** |
| **证据** | `common.js` — `isSecurityReviewConfigEnabled(t){ return t.config.modelBehaviorReview.enabled \|\| t.config.riskContentProtection.enabled \|\| t.config.assistedApproval.enabled && !t.constraints.assistedApprovalDisabled }`；`server.js` — `securityReview: { ...pickSecurityReviewConfig(n), assistedApprovalDisabled: s.assistedApprovalDisabled === true }`（`s` 来自 `getManagedSecurityPolicy()`） |
| **影响** | 规则面把手的**可靠性边界 = 服务端未下发 securityCenter 块** |

---

## 新增约束 4 · `orderedRules` 有托管回压

`p.managed === true` 时，`toManagedOrderedRules` 用托管策略**覆盖本地** `orderedRules`（`findings/06-action-layer.md` 结论 2 / `findings/10-experiments.md` 修正 2）。

个人环境当前 `managed = false` 所以本地改动有效——但这是**当前状态**，不是恒定属性。

---

## 记录 1 · `+1019` vs `+1151`：基线不一致

同一次 customPrompt 复测，两份记录的数字不同：

| 出处 | 记录 |
|---|---|
| `findings/07-personalization.md` 原文 | 34830 → 35849（**+1019**） |
| `findings/10-experiments.md` | 34698 → 35849（**+1151**） |

**根因**：三个数字来自**三条不同会话**（`34698@9212` / `34830@4632` / `35849@24816`），跨会话漂移被算进了增量。

**处置**：两个数都只作**约数**。作为判据时必须本机当次实测，**不复用历史数值**。这条也直接催生了 [verification](verification.md) 里「按会话取首条」的设计。

---

## 记录 2 · `20003` 不是代码常量

trace 截断值 `20003` 在 asar 全库**搜不到**（不是代码常量），只存在于侦察文档的观测记录里。

**处置**：引用时只作为"该次观测值"。真正的结论是**方法论**——「尾段通道用 trace grep 会失明」——这一条由代码与行为双重支撑，**不依赖该具体数字**。

---

## 侦察原文里的作废判定（整理后已就地标注）

`recon-baseline` 归档整理（2026-11-01）时，把两处作废判定**就地处理**了，不再依赖外部提醒：

| 原位置 | 处理 |
|---|---|
| 原 `experiments.md` 里「`customPrompt`/toneStyle 确认为**无 LLM 效力**」的中间判定 | 已在 `findings/10-experiments.md` 修正 1 里明确标为作废，写明推翻理由与复测方法 |
| 原「对 map.md 的修订项」里「`customPrompt` → 标注「无效（fallback-only）」」 | 已删除——那句把「A 组正文 fallback-only」与「customPrompt 无效」混为一谈，是错误外推 |

**结论口径**：`customPrompt` 与 `toneStyle` 均有效，走尾段通道（token 增量实证）。

---

## 置信度与限制

每条修正都有代码行号或可复现证据，高。

限制：这些修正**只对 5.9.3 有效**。WorkBuddy 升级后，行号会变、逻辑可能改——**修正也必须重新核对**，不能当永久结论。

## 给下一篇留下的问题

修正归位了，但工程实现过程中动过多少次真实文件、每次还原了没有——最后一篇是台账。

---

下一篇：动过什么 → [ledger](ledger.md)
