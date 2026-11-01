# AGENTS.md — workbuddy-console 工程契约

> 本文件是 agent 在本仓库作业的**运行契约**，每次会话自动加载。只写使命、铁律、地图与引用；过程性内容一律外置到 `docs/`。
> 文档组的组级账本在 [`DOC-OUTLINE.md`](DOC-OUTLINE.md)——**改任何一篇文档前先读它**。
>
> **历史侦察已归档**：`recon-baseline/`（2026-11-01 整理；主线、术语、分篇索引见其 `OUTLINE.md`）。侦察期的"全权授权"记录随之失效，**不再沿用**。

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
| 最容易的误用 | 把「工具报生效」当成「效果达成」——验证只证明链路，不证明效果 |

## 四条契约

框架 = 这四条，不是目录结构。完整定义见 [docs/framework](docs/framework.md)。

1. **把手契约**：每个可变面统一六步 —— 探测 → 预览 → 备份 → 写入 → **验证** → 还原
2. **状态契约**：文档结论是**断言**，运行时探测才是**数据源**；偏差必须报（漂移 5 类）
3. **边界契约**：谁能写、何时能写（闸门）、写完记哪（审计 + 还原）
4. **演进契约**：升级时**只加数据、不改框架**；锚点失效必须硬报错

## 铁律

1. **备份先行**：任何持久性写入前必须有 `manifest` + `sha256`；无备份不成写
2. **验证必填**：把手必须声明验证策略；**未声明验证策略的把手不允许上线**
3. **不猜锚点**：路径 / 键 / 版本一律运行时探测；探测失败 = 硬报错，**绝不回退到猜测值**
4. **用户数据不进仓库**：`profiles` / `backups` / 运行状态一律放 `%USERPROFILE%\.workbuddy-console\`。本仓库是 **public**
5. **厂商文件逐次确认**：用户目录写入自由（有备份）；**Program Files / 插件缓存版本目录**的写入需逐次显式确认
6. **禁止假装成功**：验证输出三态（生效 / 未生效 / **无法判定**）；"无法判定"不得显示为成功
7. **范围边界**：只服务本机 WorkBuddy；不写绕过上游内容过滤的具体配方（只记录边界位置）
8. **不引用过期事实**：文档里的"当前值"是**快照**，不是事实；任何值都必须现读

## 授权范围

| 目标 | 规则 |
|---|---|
| **用户数据目录**（`~/.workbuddy` 下的配置与身份文件） | 可写，须有备份与还原 |
| **厂商文件**（`C:\Program Files\WorkBuddy\...`、`~/.workbuddy/plugins/cache/...`） | **逐次确认** |
| `app.asar` / 网关流量 / fuses | **不改**（侦察已证明无必要） |

## 目录地图

| 路径 | 是什么 |
|---|---|
| `DOC-OUTLINE.md` | **文档组账本**：主线 / 反面 / 术语 / 分篇 / 顺序 / 残余 |
| `docs/product.md` | 产品要什么：定位、层边界、档位模型、范围、分期 |
| `docs/framework.md` | 怎么造：四条契约、参照系、Core/Data 分层、事务语义 |
| `docs/verification.md` | 怎么证明：四种策略、三态、五条硬保护、待实测 8 条 |
| `docs/handles.md` | 有哪些面：18 个把手的清单、风险、验证策略 |
| `docs/recon-amendments.md` | **哪些旧结论被推翻**——冲突时以它为准 |
| `docs/ledger.md` | **动过什么、还原了没**——动真实文件前后必须回填 |
| `src/` | 实现：Core（契约/锚点/备份/引擎/trace）+ 把手 + 验证策略 + CLI + 服务端 |
| `web/` | 控制台前端（原生 ESM，无构建） |
| `recon-baseline/` | 侦察基线（**冻结、只读、代码不依赖**） |

## 引用索引

- **动手前先读**：`DOC-OUTLINE.md` → `docs/product.md` → `docs/framework.md`
- **遇到与侦察基线冲突**：以 `docs/recon-amendments.md` 为准（**唯一修正入口**）
- **改任何事实性断言前**：核对 `docs/recon-amendments.md` 的修正总览——别引用侦察期原始判断
- **把手现状**：`docs/handles.md`
- **验证怎么做**：`docs/verification.md`
- **代码级证据**：`recon-baseline/evidence/asar-extract`（明文 minified JS，可直接 grep）
- **可复用脚本**：`recon-baseline/tools/`（asar 解析、CDP 驱动、trace 读取；注意是 CommonJS）

## 已知踩坑（不得重犯）

| 坑 | 事实 |
|---|---|
| `sandbox.extraAllowWrite` | **死把手**——启动时 `reconcileDesktopExtraAllowWrite()` 强制重置（推翻了侦察结论） |
| 文档"当前值" | 会漂移（`toneStyle` 记 `creative`，实测 `efficient`） |
| trace grep 找尾段 | **天然失明** → 尾段一律用 **token 增量法**。`20003` 是观测值不是常量 |
| 存储真身 | 个性化读 `~/.workbuddy/app/app-config.json`；`settings.json` 仅 legacy 兜底 |
| 插件缓存目录 | 带 build hash，**升级即重建** |
| **身份文件静默截断** | 注入前截断到 10 000 字符，超出**静默丢弃** → **"文件写了" ≠ "模型看到了"** |
| **模式相关可达性** | `IDENTITY.md` 在**专家模式下不注入**（切档位"名字"静默消失） |
| **托管回压** | `orderedRules` 与 `assistedApproval` 在服务端下发 securityCenter 时被覆盖 |
| **启动参数陷阱** | 父进程带 `ELECTRON_RUN_AS_NODE=1` 会让 WorkBuddy 当 Node 跑、**静默退出码 0**。启动前必清 |
| 内嵌 WorkBuddy | 死路：扩展由服务端 COS 下发 + audience 门控，且写操作要求应用已退出 |

## 分期

P0–P3 共十项**全部完成**（详见 `docs/product.md` 分期表）。竖切优先：先用一个把手把验证器打通，再横向铺开。

当前剩余工作不是新阶段，而是**待实测 8 条**——见 `docs/verification.md`。
