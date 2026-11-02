/**
 * Node 版本门槛的判定（从 `launch.mjs` 抽出来，好让它**可被行为断言**）。
 *
 * 为什么值得单独一个模块：原来的自测断言是**纯字符串匹配**——
 * 只查 "常量 `MIN_NODE_MAJOR = 20` 存在" + "和 package.json 的 engines 一致"。
 * 独立审计（WP24 第 8 条）把**整段判定删掉**做了变异实验，13 条断言**全绿**：
 * 常量还在、字符串还在，判定已经没了。这正是本工程契约里写明的
 * "常量定义了、没进判定"那一类空转（残余 R8 / R50）。
 *
 * 抽成纯函数以后，断言可以真的问它："18 过不过？20 过不过？乱码过不过？"
 */

/**
 * @param {string} version 形如 `v20.11.1` 或 `20.11.1` 或 `18.20.4`
 * @param {number} minMajor
 * @returns {{ok: boolean, major: number|null}}
 *   `major` 为 `null` 表示**解析不出主版本号** —— 这时 `ok` 必须是 `false`：
 *   探测不出就硬拒绝，绝不回退到"当作满足"（铁律 3：不猜）。
 */
export function checkNodeVersion(version, minMajor) {
  const m = /^v?(\d+)\./.exec(String(version ?? '').trim());
  if (!m) return { ok: false, major: null };
  const major = Number(m[1]);
  if (!Number.isFinite(major)) return { ok: false, major: null };
  return { ok: major >= minMajor, major };
}
