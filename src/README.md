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
| `core/engine` | ⬜ 待写 | `plan → apply → verify → audit` 执行引擎 |
| `core/registry` | ⬜ 待写 | 把手注册表（注册时强制过 `assertHandle`） |
| `core/backup` | ⬜ 待写 | manifest + sha256 备份仓与还原 |
| `core/drift` | ⬜ 待写 | 漂移引擎（期望 vs 实际） |
| `core/anchor` | ⬜ 待写 | 锚点解析器（探测失败硬报错，绝不猜） |
| `handles/*` | ⬜ 待写 | P0 只做 `personalization.soul` 一个 |
| `anchors/*` | ⬜ 待写 | 首批锚点表：WorkBuddy 5.9.3 |
| `verify/*` | ⬜ 待写 | `token-delta`（P0 必需）；其余 P2 |

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
