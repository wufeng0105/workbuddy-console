/**
 * 规则矩阵把手（三域）—— "越界审批自动同意"的**规则面**。
 *
 * 三条域各自一个把手：
 *   - `rules.file`    路径级规则（本机实测 135 条，其中 write/delete=ask 各 49 条）
 *   - `rules.command` 命令级规则（本机实测 0 条 —— 空规则语义待实测 #2）
 *   - `rules.network` 网络级规则（同上）
 *
 * 写入形式是**结构化操作** `{ from, to, actions }`，不是整块 JSON 编辑。
 */

import { createRuleDomainHandle } from './rules.mjs';

export const ruleHandles = Object.freeze([
  createRuleDomainHandle({
    domain: 'file',
    id: 'rules.file',
    title: '规则 · 文件路径（file）',
  }),
  createRuleDomainHandle({
    domain: 'command',
    id: 'rules.command',
    title: '规则 · 命令（command）',
  }),
  createRuleDomainHandle({
    domain: 'network',
    id: 'rules.network',
    title: '规则 · 网络（network）',
  }),
]);

export default ruleHandles;
