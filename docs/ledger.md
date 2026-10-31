# 开发期写操作台账

> 区分两种台账：
> - **运行时台账**：`<用户数据目录>/state/audit.jsonl`（工具自身每次 plan/apply/verify/restore 自动记）
> - **本文件**：记录**开发与验证过程中**对本机真实 WorkBuddy 的写操作
>
> 铁律 1：无备份不成写。每条都必须写明**备份 id、还原结果、逐字节校验**。

---

## 2026-11-01 · P0c 真实写入往返验证

目的：证明"真实路径 → 真实备份 → 真实最小改动写入 → 真实还原"这条链在**用户真实数据**上成立
（此前受 workspace-write 沙箱限制，只能在 fixture 上验证）。

| # | 目标文件 | 操作 | 备份 id | 还原 | 验证 |
|---|---|---|---|---|---|
| 1 | `~/.workbuddy/app/app-config.json` | `personalization.customPrompt` 写入标记 `WBC-E2E-1793471373`（经 CLI） | `20261031T182933Z-aa05bc` | ✅ 已还原 | 备份 sha256 = 改动前 `897D5AFB…`；还原后 sha256 **逐字节一致** |
| 2 | `~/.workbuddy/user-<uid>-personal/SOUL.md` | 追加标记行 `WBC-E2E-CONSOLE-MARKER`（经**控制台 HTTP API**） | `20261031T183000Z-8d7934` | ✅ 已还原 | 还原后 sha256 = 改动前 `5602F4B6…` **逐字节一致** |

**验证到的东西**（不只是"写进去了"）：

- 真实锚点解析（uid 目录、`app-config.json`）✅
- 最小改动写入：`app-config.json` 除该字段外**逐字节不变** ✅
- 备份内容 == 改动前内容（sha256 相等）✅
- 还原**逐字节**回到原状，零残留 ✅
- 控制台 HTTP 路径的鉴权、写入，以及 `verify` 如实报 `undetermined`（无新会话）✅

**终态**：`customPrompt` 恢复为空串；`SOUL.md` 内容完好（487 字符 / 注入上限 10 000）。

**本次未做**（明确边界）：

- 未写安装目录 `C:\Program Files\WorkBuddy`（`style-*.md` 属 P1c）
- 未改 C 组插件缓存（属 P2）
- 未改网关流量、未改 `app.asar`、未改 fuses
- **未触发真实会话** —— 因此 `verify` 的 `effective` 分支仍未在真实数据上跑过（需要一次真实会话，属交互步骤）

---

## 2026-11-01 · P1b 档位采集（只写用户数据目录）

| # | 目标 | 操作 | 结果 |
|---|---|---|---|
| 3 | `~/.workbuddy-console/profiles/real-snapshot.json` | 从**当前真实状态**采集档位「当前状态快照」 | 采到 SOUL 487 字符 / toneStyle `efficient` / customPrompt 空串 |

**未触碰 WorkBuddy 文件**：采集前后 `app-config.json` 与 `SOUL.md` 的 sha256 均未变（已复核）。
档位是**源状态**，天然只读 WorkBuddy、只写用户数据目录。
