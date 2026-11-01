/**
 * workbuddy-console · Core 契约定义
 * ---------------------------------------------------------------
 * 本文件**只有契约（接口与校验），没有实现**。
 *
 * 契约稳定，数据多变：
 *   - 修改本文件 = 改框架（应当罕见）
 *   - 新增把手 / 新增版本锚点 = 加数据（不动本文件）
 *
 * 依据：docs/framework.md 第六节
 */

import { HandleContractError } from './errors.mjs';

// ── 契约 1 · 把手六步 ─────────────────────────────────────────────

/** 每个可变面必须按此顺序实现 */
export const HANDLE_STEPS = Object.freeze([
  'probe',   // 探测现状（运行时读取，不猜）
  'preview', // 差异预览（改什么、多出多少 token、影响哪些下游）
  'backup',  // 备份 manifest + sha256（无备份不成写）
  'apply',   // 写入
  'verify',  // 按声明的验证策略判定生效（三态）
  'restore', // 按 manifest 还原
]);

// ── 契约 2 · 状态（漂移） ─────────────────────────────────────────

/** 漂移分类 */
export const DRIFT_KINDS = Object.freeze([
  'anchor-missing',  // 锚点失效：路径 / 键 / 版本找不到了
  'value-changed',   // 值已变：被外部改动（如 toneStyle）
  'vendor-restored', // 厂商已还原：升级覆盖了定制
  'mode-dependent',  // 模式相关失效：同一文件在不同模式下可达性不同（如 IDENTITY.md 在专家模式不注入）
  'target-missing',  // 目标文件不存在：升级可能清理了它（由 replay.detectDrift 产出）
]);

// ── 契约 3 · 边界 ────────────────────────────────────────────────

/** 写入分级：决定是否需要逐次显式确认 */
export const WRITE_CLASSES = Object.freeze([
  'user-data',   // 用户数据目录 —— 自由写（须有备份）
  'vendor-file', // 厂商文件（Program Files / 插件缓存版本目录）—— 逐次确认
]);

/** 权限要求 */
export const PRIVILEGES = Object.freeze([
  'none',         // 普通用户即可
  'elevated',     // 需要管理员权限
]);

/**
 * 进程互斥闸门。
 * 头部通道（C 组模板）在 WorkBuddy 运行中必须拒绝写，而不是"写了不生效"。
 */
export const GATE_KINDS = Object.freeze([
  'app-must-be-closed', // 应用必须已退出
  'new-session-required', // 可热写，但需新会话才生效
  'none',
]);

// ── 契约 4 · 演进 ────────────────────────────────────────────────

/** 升级后的把手归宿 */
export const UPGRADE_BEHAVIORS = Object.freeze([
  'survives',  // 存活
  'invalidated', // 失效（需重放）
  'dead',      // 死把手（启动被覆盖），禁用
]);

/** 锚点表结构版本 —— 结构变更时必须 +1 并提供 migrate() */
export const ANCHOR_SCHEMA_VERSION = 1;

// ── 验证层 ───────────────────────────────────────────────────────

/** 验证策略（详见 docs/verification.md） */
export const VERIFY_STRATEGIES = Object.freeze([
  'marker-trace-grep',      // 请求头部通道
  'token-delta',            // 请求尾段通道（唯一可靠）
  'render-log',             // 渲染日志（辅助）
  'readback-after-restart', // 配置值 / 规则面，专捕"启动覆盖"
]);

/** 验证通道 */
export const CHANNELS = Object.freeze([
  'request-head', // C 组模板 / fragments
  'request-tail', // user-context（SOUL / 身份 / 风格 / 指令）
  'rule-matrix',  // orderedRules 等规则面
  'config-value', // 配置值
]);

/**
 * 验证结论恒为三态。
 * 铁律 6：禁止把 'undetermined' 显示成成功。
 */
export const VERIFY_VERDICTS = Object.freeze([
  'effective',    // 生效
  'ineffective',  // 未生效
  'undetermined', // 无法判定
]);

// ── 把手适配器契约 ───────────────────────────────────────────────

/**
 * @typedef {Object} Handle
 * @property {string}  id               唯一标识，如 'personalization.soul'
 * @property {string}  title            界面显示名
 * @property {string}  target           探测函数名（运行时定位，**不写死路径**）
 * @property {'user-data'|'vendor-file'} writeClass
 * @property {'none'|'elevated'} privilege
 * @property {'request-head'|'request-tail'|'rule-matrix'|'config-value'} channel
 * @property {'survives'|'invalidated'|'dead'} upgradeBehavior
 * @property {Object}  verification     验证声明（**必填**，名词）
 * @property {string}  verification.strategy  VERIFY_STRATEGIES 之一
 * @property {string}  verification.channel   CHANNELS 之一（可与 channel 不同）
 * @property {string}  verification.baseline  基线如何取
 * @property {string}  verification.assertion 判据（可与理论值比较）
 * @property {'app-must-be-closed'|'new-session-required'|'none'} [gate]
 *
 * 注意：六步中的 `verify()` 是**动词方法**，本字段 `verification` 是**名词声明**。
 * 二者曾经同名，导致方法覆盖声明 —— 见 selftest 的回归用例。
 */

/**
 * 校验把手适配器是否满足契约。
 * 不满足即抛错——**未声明验证策略的把手不允许上线**（铁律 2）。
 *
 * @param {Handle} h
 * @returns {Handle} 原样返回，便于链式使用
 */
export function assertHandle(h) {
  // 抛带稳定错误码的异常（曾被写成裸 Error，上层无法判定 —— 见 selftest 回归）
  const fail = (msg) => { throw new HandleContractError(`[handle-contract] ${msg}`); };

  if (!h || typeof h !== 'object') fail('handle 必须是对象');
  for (const k of ['id', 'title', 'target']) {
    if (typeof h[k] !== 'string' || !h[k].trim()) fail(`缺少必填字段 ${k}`);
  }
  if (!WRITE_CLASSES.includes(h.writeClass)) fail(`writeClass 非法：${h.writeClass}`);
  if (!PRIVILEGES.includes(h.privilege)) fail(`privilege 非法：${h.privilege}`);
  if (!CHANNELS.includes(h.channel)) fail(`channel 非法：${h.channel}`);
  if (!UPGRADE_BEHAVIORS.includes(h.upgradeBehavior)) fail(`upgradeBehavior 非法：${h.upgradeBehavior}`);

  // 铁律 2：验证必填（名词声明 verification，注意与动词方法 verify() 区分）
  const v = h.verification;
  if (!v || typeof v !== 'object' || typeof v === 'function') {
    fail('缺少 verification（验证策略必填；注意不是动词方法 verify()）');
  }
  if (!VERIFY_STRATEGIES.includes(v.strategy)) fail(`verification.strategy 非法：${v.strategy}`);
  if (!CHANNELS.includes(v.channel)) fail(`verification.channel 非法：${v.channel}`);
  for (const k of ['baseline', 'assertion']) {
    if (typeof v[k] !== 'string' || !v[k].trim()) fail(`verification.${k} 必填`);
  }

  // 尾段通道不得用 trace grep（截断导致假阴性，见 docs/verification.md）
  if (v.channel === 'request-tail' && v.strategy === 'marker-trace-grep') {
    fail('请求尾段通道禁用 marker-trace-grep：trace 截断会造成假阴性，必须用 token-delta');
  }

  // 死把手直接拒绝注册
  if (h.upgradeBehavior === 'dead') fail('dead 把手不得注册（如 sandbox.extraAllowWrite）');

  if (h.gate !== undefined && !GATE_KINDS.includes(h.gate)) fail(`gate 非法：${h.gate}`);

  return h;
}
