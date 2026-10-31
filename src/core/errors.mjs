/**
 * 错误类型 —— 全部带稳定 code，便于上层判定与界面呈现。
 */

export class ConsoleError extends Error {
  /**
   * @param {string} code 稳定错误码
   * @param {string} message 人话说明
   * @param {object} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = code;
    this.code = code;
    this.detail = detail;
  }
  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

/** 锚点探测失败 —— 铁律 3：绝不回退到猜测值 */
export class AnchorMissingError extends ConsoleError {
  constructor(message, detail) { super('ANCHOR_MISSING', message, detail); }
}

/** 把手不满足契约 */
export class HandleContractError extends ConsoleError {
  constructor(message, detail) { super('HANDLE_CONTRACT', message, detail); }
}

/** 闸门未满足（如应用未退出） */
export class GateBlockedError extends ConsoleError {
  constructor(message, detail) { super('GATE_BLOCKED', message, detail); }
}

/** 无备份不成写（铁律 1） */
export class BackupMissingError extends ConsoleError {
  constructor(message, detail) { super('BACKUP_MISSING', message, detail); }
}

/** 完整性校验失败（sha256 不符） */
export class IntegrityError extends ConsoleError {
  constructor(message, detail) { super('INTEGRITY', message, detail); }
}

/** 需要显式确认而未被确认（厂商文件，铁律 5） */
export class ConfirmationRequiredError extends ConsoleError {
  constructor(message, detail) { super('CONFIRMATION_REQUIRED', message, detail); }
}
