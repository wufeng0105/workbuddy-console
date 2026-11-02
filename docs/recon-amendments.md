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
| **自我 1** | 推翻 | 「验证策略已声明 = 验证能给出答案」是假的 | 五种判据给出错答案的形态，见下方「自我修正 1」 |
| **自我 2** | 推翻 | 「前端是配置管理器的薄壳」是假的 | 前端有独立不变量 I1–I7，违反会**丢用户输入**，见 [framework](framework.md) |
| **自我 3** | 推翻 | 「`render-log` 是四种策略之一」是假的 | 只有三种有实现；契约不拦「声明了不存在的策略」 |
| **自我 4** | 推翻 | 「门禁全绿 + 每条修复配了断言 = 承诺已兑现」是假的 | 8 条断言空转、1 条门禁恒真、断言只钉住一层；本组改用「已兑现 / 未兑现」，见下方「自我修正 4」 |
| **自我 5** | 撤回 | 前端不变量 **I8**「六步每步都要在界面有出口」——与用户 2026-11-01 定版「页面不再驱动验证」冲突 | 按用户决定撤回 I8；界面不承担验证，只承担"看得见改了什么、怎么自测" |
| **自我 6** | 推翻 | 「HTTP 层也守住了漏参数防线」是假的 | `server.mjs` 把 `undefined` 提前变成 `''`，空 JSON body 可清空文件并回 `ok:true` |
| **自我 7** | 推翻 | 「漂移 5 类」与产出同源 | 实际只产出 3 类，常量里 2 类无生产者；守它的断言只查单向 |
| **自我 8** | 推翻 | 放宽档「凭据类目录（`~/.ssh/` 等）仍 `ask`」 | 代码全量放开 read+write，命中样例首项就是 `~/.ssh/` |
| **自我 9** | 推翻 | 「前端不变量每条都有断言与红灯验证」 | I8 零断言；I1 的 textarea 保全零覆盖；I2 在 DOM stub 上无法行为化；另有 7 条空转 |

> 编号沿用历史（原文从"修正 3"开始），不重排——**改编号会让已有引用全部失效**。
> 前缀区分来源：**修正/新增/记录** 针对侦察基线；**自我** 针对本工程自己的旧认知（2026-11-02 起）。

---

## 自我修正 1 · 「验证策略已声明 = 验证能给出答案」是假的

**原结论**（本工程此前默认）：把手声明了 `verification.strategy` 就已满足铁律 2，验证能力随之成立。

**新证据**（2026-11-02 两轮独立复核，各条都配了断言，均在真实代码上复现）：

| 判据 | 实际行为 | 证据位置 |
|---|---|---|
| 规则面 `readback-after-restart` | 需要 `restarted` 参数，而 CLI 不解析、前端不调用 → **永远无法判定** | `src/cli.mjs` 的 `verify`；[verification](verification.md)「规则面」 |
| 提示词模板 `marker-trace-grep` | apply 不注入标记，verify 用常量前缀 grep → 普通编辑**必然判「未生效」** | `src/handles/prompt-template.mjs`；[verification](verification.md)「标记法」 |
| `token-delta` 负增量 | 噪声带用带符号 delta → **删减改动永远判不出「生效」** | `src/verify/token-delta.mjs`；[verification](verification.md)「三个方向性错判」 |
| `token-delta` 小增量 | `MIN_MEANINGFUL` 定义了但没进判定 → 小改动判「未生效」 | 同上 |
| `noop` 之后 | 期望增量记 `0` → **什么都没改却报「生效」** | `src/core/engine.mjs` 的 `apply` |

**影响**：铁律 2 的字面要求（声明策略）**不足以**保证验证能力。一条判据要能给出答案，必须同时满足三点——**可达**（用户拿得到调用方式）、**方向正确**（正负对称）、**拒绝假确定**（判不了就说判不了）。见 [verification](verification.md)「一条判据的三个必要条件」。

## 自我修正 2 · 「前端是配置管理器的薄壳」是假的

**原结论**：控制台只是 `/api/*` 的渲染层，风险集中在后端。

**新证据**：前端是**单可变状态 + 全量重渲染**（`render()` 43 处调用），任何只存在于 DOM 里、
没进 `S` 的用户输入都会在下一次 render 时消失。实测后果：

- 编辑 SOUL.md 后点「应用」→ 发出去的是**旧内容** → 后端判 noop → 提示「备份 null」而文件没变
- 同一缺陷在**五个输入面**都存在（textarea / 下拉 / 规则勾选框 / 厂商确认 / 审批确认）
- 另有按钮永久禁用、401 请求自激（一轮打满 401 次）、原生弹窗阻塞页面等结构性问题

**影响**：前端有六条独立不变量（I1–I6），各配断言，见 [framework](framework.md)「前端不变量」。
「改前端只改显示」这样的判断不再成立。

## 自我修正 3 · 「`render-log` 是四种策略之一」是假的

**原结论**：`docs/verification.md` 写「四种策略……均已实现并有自测覆盖」。

**新证据**：`src/verify/` 只有 `auto-capture / marker / readback / token-delta`；
`render-log` 既无实现文件，也无任何把手声明（18 个把手全部落在另外三种）。

**影响**：文档已改为「三种有实现」。**同时暴露一个契约缺口**：`assertHandle` 只校验
「策略名在 `VERIFY_STRATEGIES` 列表里」，所以一个**没有实现**的策略名也能通过契约校验——
铁律 2 的字面要求满足了，判据要求没有。保留该枚举值但标注为未实现。

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

**同一个启动 reconciliation 只碰 `extraAllowWrite`**，不触碰 `orderedRules`（后者走 `ensureOrderedRules` 的 defaults/migrate 路径）——这是"启动是否覆盖 `orderedRules`"（残余 R12）的代码旁证。

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

## 自我修正 4 · 「已实现」曾被当成「已兑现」

**原结论**（本工程此前默认）：四道门禁全绿、每条修复都配了断言，就说明承诺兑现了。

**新证据**（2026-11-02 第二轮独立审计：7 个维度各一名 fresh 审计员 + Lead 复核，26 条发现，
原始输出在 `.zhll/audit2/`）：

| 判据 | 实际行为 | 证据 |
|---|---|---|
| 「断言写出来了」 | **8 条断言改回缺陷态仍全绿**：1 条结构性恒真（`ok(rows.length >= n0)` 在同一份只增日志上恒真）、3 条只认词/可被注释骗过、1 条覆盖洞、前端 7 条、启项断言 11 条全是源码字符串 | `.zhll/audit2/06-assertions-backend.md`、`07-assertions-frontend.md` |
| 「门禁挡住了」 | `npm run check:contracts` **恒真**：清空两个契约常量仍 exit 0 | `.zhll/audit2/01-contracts.md` #8 |
| 「断言钉住了这个契约」 | 同一条契约在 **HTTP / 前端 / CLI 三层各有绕过路径**，上一轮只堵了其中一层（例：漏参数清空文件在 CLI 与 engine 堵住了，HTTP 的 `?? ''` 与前端 `?? {}` 没有） | `.zhll/audit2/01-contracts.md` #1 |

**影响**：本组改用两个词——**已兑现**（有会变红的断言守住）／**未兑现**（代码在但没守住），
**"已实现"不再作为状态词**。所有差距登记在 [DOC-OUTLINE](../DOC-OUTLINE.md)「已知残余」（R1–R20），
其余篇只引用编号。断言纪律从"两证"升为**三证**（改回缺陷态→红、正常态→绿、**删掉被测字段→红**）。

## 自我修正 5 · 前端不变量 I8 与用户定版冲突，撤回

**原结论**：`framework.md` 的 I8 写「六步契约的每一步都要在界面上有出口」，并把"预览与验证前端零调用"当成缺陷。

**新证据**：同一份 `framework.md` 在「最初基线」一节记录用户 2026-11-01 定版——
**编辑卡只留「应用」与「还原」两键，验证能力保留在引擎与 API，页面不再驱动验证**。
两处互相否定（`framework.md` 的两节，相隔约 100 行）。

**影响**：按用户决定为准，**撤回 I8**。界面不承担验证；真正该守的底线改成
「界面不许让用户以为'写成功'等于'生效了'」。随之修正的是审计对 F9 的定性——
"11 个把手在界面上无法验证"**是按设计如此**，不是缺陷；真正的缺陷是
**后端算出的警告到不了界面**（残余 R4）与**写成功提示不说下一步怎么自测**。

## 自我修正 6 · 「HTTP 层也守住了漏参数防线」是假的

**原结论**：上一轮把"漏参数即拒绝"登记为已修，措辞是"CLI 与 engine 双层拦截"。

**新证据**：`src/server.mjs` 的 apply 分支用 `body.next ?? ''` 把 `undefined` 提前变成空串，
engine 的 `next === undefined` 检查永不触发。实测 `POST /api/handle/personalization.soul/apply` body `{}`
→ SOUL.md 31 B → 0 B，响应 `ok:true`，审计记 `changed:true,status:'ok'`；
而同一个调用状态直调 engine 正确抛 `INPUT_MISSING`。前端侧 `web/app.js` 的 `pr?.state ?? {}`
让"探测失败"渲染成"空内容 + 可用按钮"，是这条链的入口。

**影响**：「双层拦截」的措辞作废。同一条契约必须在 HTTP / 前端 / CLI 三层各问一次绕过路径——
这条写进 [AGENTS](../AGENTS.md) 门禁节。

## 自我修正 7 · 「漂移 5 类」与实际产出不同源（第二次，且方向相反）

**原结论**：五类冻在 `DRIFT_KINDS`，`detectDrift` 产出这五类。

**新证据**：两侧**双向都不重合**——产出里多出 `handle-missing` / `unchanged`（它们不是漂移分类），
而常量里的 `value-changed` / `mode-dependent` **全库没有生产者**。守它的断言只查**单向**（产出 ⊆ 常量），
所以"常量里有两个永远不会发生的类"这件事没有任何断言能发现。

**影响**：残余 R7。应然是**双向相等**，且断言必须能抓住"加了一个没人产出的类"。
第一次的教训是"常量少了"，这次是"断言只查一个方向"——同一个病的两个面。

## 自我修正 8 · 放宽档「凭据类目录仍 ask」是假的

**原结论**：`product.md` 的审批档位表写「放宽（建议默认）：49 条 `ask` → `allow`；
**凭据类目录（`~/.ssh/` 等）仍 `ask`**」。

**新证据**：`src/core/approval.mjs` 的 `relaxed` 规则操作是 `{from:'ask', to:'allow', actions:['read','write']}`，
**全量放开、无任何路径豁免**；实测 `approval-plan relaxed --json` 的命中样例前三项就是
`~/.ssh/`、`~/.aws/`、`~/.gnupg/`。

**影响**：残余 R6。承诺与代码冲突时**以代码为事实、以承诺为目标**：这一格标成"未兑现"，
豁免清单单独一批实现——不改文档认账，因为那句是安全承诺。

## 自我修正 9 · 「前端不变量每条都有断言与红灯验证」是假的

**原结论**：`framework.md` 写「上面八条……对应 `test/frontend.test.mjs` 里的断言，每条都有红灯验证」。

**新证据**：`test/` 三个文件里 **I8 零出现**；I1 的 textarea 保全**零覆盖**
（把 textarea 的 `rememberField` 删掉仍全绿、把 `runBusy` 开头的 `render` 加回去仍全绿，只有两处同时改回去才红）；
I2 无法在这套断言上行为化——stub 的 `click()` **不看 `disabled`**，而 `app.js` 唯一的防双击手段就是 `disabled`；
另有 7 条把修复改回去仍全绿。

**影响**：残余 R8。本组不再整体声明"不变量已被守住"，改为**逐条给状态**；
新增不变量必须过三证。

---

## 置信度与限制

自我修正 1–3 的证据在源码行与自测里；**自我修正 4–9 的证据在 `.zhll/audit2/`（7 份维度报告 + 190 余份原始输出）**，
每条都可用报告里的「怎么复核」列重跑。高。

限制：这些修正**只对 5.9.3 有效**。WorkBuddy 升级后，行号会变、逻辑可能改——**修正也必须重新核对**，不能当永久结论。

## 给下一篇留下的问题

修正归位了，但工程实现过程中动过多少次真实文件、每次还原了没有——最后一篇是台账。

---

下一篇：动过什么 → [ledger](ledger.md)
