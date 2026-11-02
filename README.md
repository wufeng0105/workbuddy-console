# workbuddy-console

**WorkBuddy 宿主层的个性化配置管理器 + 生效验证器。**

> 改之前告诉你代价，改完证明它真的生效，升级后告诉你还在不在。

WorkBuddy（腾讯的桌面 AI 助手）里，"能改它行为的地方"散落在四处：设置界面、隐藏配置文件、插件缓存目录、环境变量。这个工具把它们收拢到一处，并为每一处改动提供**备份、还原、和生效验证**。

## 它解决什么

| 问题 | 现状 | 本工具 |
|---|---|---|
| 改哪里、怎么改 | 手工试错 | 18 个把手 + 差异预览 |
| 改了会不会坏 | 靠自觉 | 写入前自动备份（manifest + sha256），随时还原 |
| **改了到底生效没有** | **只能靠感觉** | **验证层：用数字告诉你进没进模型** |
| 升级后还在不在 | 升级后才发现失效 | 锚点校验 + 漂移告警 + 重放 |
| 哪些改了也没用 | 反复白试 | 边界说明：哪些是厂商划死的 |

## 快速上手

需要 Node ≥ 20。**零依赖、零外网、无需构建**——不装任何包，不发任何外部请求，字体也用系统栈。

### 方式一：双击启动（推荐）

**双击 `start-console.cmd`。** 它会自动打开浏览器，并把带令牌的地址打进窗口。

- **窗口开着 = 服务在跑；关掉窗口 = 服务停止。** 没有后台残留、没有开机自启。
- 已经在跑时会**复用**那个实例（只开浏览器），不会再起第二个。
- 启动前会**探测 WorkBuddy 是否还在运行**：在跑就会劝阻并说清后果（见下）。
- 窗口里会打印一张**操作卡**：改什么、改完要重启还是新建会话、后悔了怎么还原。

> 这套工具是**一次性**的用法：先用它改，改完关掉窗口，再开 WorkBuddy。
> 理由：应用运行中时，规则与提示词模板的写入会被闸门**直接拒绝**；
> 而身份/配置类文件虽然能写进去，但当次会话读的仍是旧内容，且应用自己也在写同一批文件。

### 方式二：命令行

```bash
node src/cli.mjs doctor    # ① 体检：锚点是否成立、把手是否可用
node src/cli.mjs list      # ② 看有哪些把手可管
node src/cli.mjs serve     # ③ 开控制台（会打印带令牌的 URL）
```

> 不带参数运行 `node src/cli.mjs` 会打印完整上手。
> **令牌每次启动都变**——从 `<用户数据目录>/state/console-url.txt` 复制，别手抄。
> 控制台拿到令牌后会**立刻把它从地址栏抹掉**（存进 sessionStorage），所以刷新不受影响，但 URL 里不会留下它。

### 常见动作

```bash
# 改一项人设（改前看差异，改后验生效）
node src/cli.mjs probe personalization.soul
node src/cli.mjs plan  personalization.soul --set soul.md   # 只读预览：差异 + token 代价
node src/cli.mjs apply personalization.soul --set soul.md   # 写入（自动备份）
node src/cli.mjs verify personalization.soul                # 验证是否真进模型

# 存一套人设并一键切换
node src/cli.mjs profile-save "代码专家"
node src/cli.mjs profile-apply code-expert

# 审批自动同意（放宽：写入不问，删除仍确认）
node src/cli.mjs approval-plan relaxed
node src/cli.mjs approval-apply relaxed --confirm

# 升级之后：检查定制还在不在
node src/cli.mjs drift
node src/cli.mjs replay --confirm

# 后悔了
node src/cli.mjs backups
node src/cli.mjs restore <backupId>
```

### 验证怎么用（这是重点）

改完**不会**自动告诉你生效没有——它需要一次真实会话：

1. 在 WorkBuddy 里**新建会话**并发送一条消息
2. 跑 `node src/cli.mjs verify <把手>`

只在旧会话里续聊时，工具会说"请新建会话"，**不会**误报"未生效"。

## 范围边界

**只经营宿主层（客户端本体）；上游（腾讯网关 / 模型服务）碰不到，只如实呈现边界。**

明确不做：

- 不改网关流量、不做上游内容过滤的绕过
- 不改 `app.asar`、不改 Electron fuses
- 不改模型自身行为（模型对齐不在可达范围内）

### 一个必须分清的区分

**验证证明链路，不证明效果。** 工具能证明「你写的文本进入了请求」，不能证明「模型因此改变了行为」。后者取决于模型自身，测不到。

把前者当成后者，是这套东西最容易的误用。

## 三个档位的取舍

| 档位 | 规则面（宿主弹窗） | 提示词面（模型自己问） |
|---|---|---|
| `off` | 不改 | 8 条安全条款全保留 |
| **`relaxed`**（推荐） | read/write 放开，**delete 仍确认** | 去 3 条强制询问，**保留红线与安全网** |
| `full` | 三动作全放开 | 额外去 3 条安全网（**模型可能直接删且不留退路**） |

> ⚠️ **工具会如实告诉你：规则面可靠，提示词面无法保证。**
> 若"模型问"来自模型自身对齐（上游），改提示词无效——那不是你配错了。

## 文档

| 文档 | 内容 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | 工程契约：使命、铁律、授权范围、已踩的坑 |
| [`DOC-OUTLINE.md`](DOC-OUTLINE.md) | 文档组账本：主线、术语、分篇、阅读顺序 |
| [`docs/product.md`](docs/product.md) | 产品要什么：定位、层边界、档位模型、范围、分期 |
| [`docs/framework.md`](docs/framework.md) | 怎么造：四条契约、参照系、分层、事务语义 |
| [`docs/verification.md`](docs/verification.md) | 怎么证明：三态、三种已实现策略、**判据何时给错答案**、待实测 8 条 |
| [`docs/handles.md`](docs/handles.md) | 有哪些面：18 个把手的清单 |
| [`docs/recon-amendments.md`](docs/recon-amendments.md) | 哪些旧结论被推翻（**冲突时以它为准**） |
| [`docs/ledger.md`](docs/ledger.md) | 动过什么、还原了没 |

## 状态

P0–P3 共十项**已实现**。剩下两件事：**待实测 8 条**（见 [`docs/verification.md`](docs/verification.md)），以及**两处不能兑现的承诺**（标记法对普通编辑只能报「无法判定」、`render-log` 策略有名无实，登记在 [`DOC-OUTLINE.md`](DOC-OUTLINE.md) 的「已知残余」）。

> 「已实现」不等于「承诺已兑现」。2026-11-02 的两轮独立复核（27 条）证明过这个区别：
> 功能都在、链路都通，但**判据会安静地把答案给错**——删减改动永远判不出生效、
> 前端会把用户正在编辑的内容在点「应用」前冲掉。这些已全部修复并各配断言。

### 怎么验证它可信

| 命令 | 证明什么 |
|---|---|
| `node src/selftest.mjs` | 后端六步与把手契约（157 条，合成 fixture，不碰真实配置） |
| `npm test` | 前端六条不变量 + 三态判定边界 + 启动器（47 条，零依赖） |
| `npm run verify:all` | 以上串跑 |

新增断言必须做**红灯验证**：把修复改回去，确认断言真的变红。本轮有两条断言第一版是空转的，全靠这一步才发现。

## 关于 `recon-baseline/`

该目录是**侦察基线（已冻结）**——对 WorkBuddy 客户端的行为侦察结论、代码级证据、可复用脚本。

**它被排除在版本控制之外**，不会出现在本仓库——其中包含第三方软件的代码副本，不适合公开分发。

本项目的设计引用了那些结论（文档中以 `recon-baseline/...` 标注出处），但**代码不依赖它**——删掉该目录，工程照常运行。
