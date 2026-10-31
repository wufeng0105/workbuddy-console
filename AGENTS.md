# AGENTS.md — workbuddy-console 工程契约

> 本文件是 agent 在本仓库作业的**工程期运行契约**，每次会话自动加载。只写使命、铁律、地图与引用；过程性内容一律外置到 `docs/`。
>
> **历史侦察契约已冻结**：`historicalsource/RECON-CONTRACT.md`（不再生效，除非被本文件显式引用）。侦察期的"全权授权"记录随之失效，**不再沿用**。

## 使命

把 WorkBuddy **宿主层**里所有"能改它行为的地方"管起来：

> **改之前告诉你代价，改完证明它真的生效，升级后告诉你还在不在。**

上游（腾讯网关 / 模型服务）碰不到，只如实呈现边界。

## 核心目标锚点

| 问题 | 回答 |
|---|---|
| 这是什么 | WorkBuddy 宿主层的**个性化配置管理器**（A）+ **生效验证器**（B） |
| 谁说话算数 | **A 为体，B 为魂**——没有 B，A 只是一个更好看的配置文件编辑器 |
| 不做什么 | 不改网关、不改 asar、不写绕过内容过滤的配方、不碰模型对齐 |

## 四条契约（框架 = 这四条，不是目录结构）

1. **把手契约**：每个可变面统一六步 —— 探测 → 差异预览 → 备份 → 写入 → **验证** → 还原
2. **状态契约**：文档结论是**断言**，运行时探测才是**数据源**；期望与实际的偏差必须被报出来（漂移）
3. **边界契约**：谁能写、何时能写（进程互斥）、写完记哪（审计 + 还原）
4. **演进契约**：WorkBuddy 升级时**只加数据、不改框架**；锚点失效必须硬报错

## 铁律

1. **备份先行**：任何持久性写入前必须有 `manifest` + `sha256`；无备份不成写。
2. **验证必填**：把手必须声明验证策略；**未声明验证策略的把手不允许上线**。
3. **不猜锚点**：路径 / 键 / 版本一律运行时探测；探测失败 = 硬报错，**绝不回退到猜测值**。
4. **用户数据不进仓库**：`profiles` / `backups` / 运行状态一律放 `%USERPROFILE%\.workbuddy-console\`。本仓库是 **public**。
5. **厂商文件逐次确认**：用户目录写入自由（有备份）；**Program Files / 插件缓存版本目录**的写入需逐次显式确认。
6. **禁止假装成功**：验证输出三态（生效 / 未生效 / **无法判定**）；"无法判定"不得显示为成功。
7. **范围边界**：只服务本机 WorkBuddy；不写绕过上游内容过滤的具体配方（只记录边界位置）。
8. **不引用过期事实**：文档里的"当前值"是**快照**，不是事实；任何值都必须现读。

## 授权范围（工程期）

- **用户数据目录**（`~/.workbuddy` 下的配置与身份文件）：可写，须有备份与还原
- **厂商文件**（`C:\Program Files\WorkBuddy\...`、`~/.workbuddy/plugins/cache/...`）：**逐次确认**
- **不改** `app.asar`（侦察已证明无必要）、不改网关流量、不改 fuses

## 目录地图

| 路径 | 是什么 |
|---|---|
| `docs/product.md` | 定位、层边界、专家档位模型、四个档位、范围、分期 |
| `docs/framework.md` | 四条契约、参照系选型、Core/Data 分层、锚点与迁移 |
| `docs/verification.md` | 验证策略层、三态输出、**待实测清单** |
| `docs/handles.md` | 把手清单（含对抗成本与验证策略）——**实际待办** |
| `docs/recon-amendments.md` | **对冻结侦察资料的修正登记**——读到冲突时**以它为准** |
| `src/` | 框架实现：Core（契约 / 锚点 / 备份 / 引擎 / trace）+ 把手 + 验证策略 + CLI + 本地服务端 |
| `web/` | 控制台前端（原生 ESM，无构建；`node src/cli.mjs serve` 启动） |
| `docs/ledger.md` | **开发期写操作台账**——动真实 WorkBuddy 文件前后必须回填 |
| `historicalsource/` | **历史侦察资料（冻结）**——五层地图、证据、脚本。只读参考，不修改 |

## 引用索引

- **动手前先读**：`docs/product.md` → `docs/framework.md`
- **遇到与冻结资料冲突**：以 `docs/recon-amendments.md` 为准（**唯一修正入口**；已登记 1 条推翻 + 4 条新增约束 + 2 条数值/证据存疑）
- **改任何事实性断言前**：核对 `historicalsource/docs/experiments.md` 的**结论修正史**
  ⚠️ 该文件 `:48` 与 `:85` 仍留有**已被其自身 `:50` 终审覆盖**的中间判定（`customPrompt`「无 LLM 效力」）——**以 `## 结论修正史` 终审段为准：`customPrompt` 与 `toneStyle` 均有效（+1151）**
- **把手现状与证据**：`historicalsource/docs/` 六篇层 findings
- **代码级证据**：`historicalsource/evidence/asar-extract`（asar 提取副本，438 文件）
- **可复用脚本**：`historicalsource/scripts/`（asar 头解析/定位/提取、CONNECT 记录代理、CDP 探针）
- **历史写操作审计**：`historicalsource/docs/ledger.md`

## 已知踩坑（不得重犯）

| 坑 | 事实 |
|---|---|
| `sandbox.extraAllowWrite` | **死把手**——WorkBuddy 启动时 `reconcileDesktopExtraAllowWrite()` 强制重置为内置列表（推翻了侦察期结论，见 `docs/recon-amendments.md`） |
| 文档"当前值" | 会漂移（`toneStyle` 文档记 `creative`，实测 `efficient`） |
| trace grep 找尾段通道 | **天然失明** → 尾段一律用 **token 增量法**。⚠️ `20003` 是该次观测值、**不是代码常量**，别当阈值用 |
| 存储真身 | 个性化读 `~/.workbuddy/app/app-config.json`；`settings.json` 仅 legacy 兜底 |
| C 组缓存目录 | 带 build hash（`5.9.3-wb.42398134...`），**升级即重建** |
| **身份文件静默截断** | SOUL/USER/IDENTITY 注入前**截断到 10 000 字符**，超出**静默丢弃**（`authority-snapshot.js:53 Ls=1e4`）→ **"文件写了" ≠ "模型看到了"** |
| **模式相关可达性** | `IDENTITY.md` 在**专家模式下不注入**（切档位"名字"静默消失）；SOUL/USER 两模式均注入 |
| **托管回压** | `orderedRules` 与 `assistedApproval` 在服务端下发 securityCenter 时被覆盖 |
| 内嵌 WorkBuddy | 死路：扩展由服务端 COS 下发 + audience 门控；且写操作要求应用已退出 |

## 分期

竖切优先：**P0 先用一个把手（SOUL.md）把验证器打通**，再横向铺开。详见 `docs/product.md`。
