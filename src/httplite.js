/**
 * httplite —— HTTP/1.1 请求解析。
 *
 * 对外契约（10 条）见仓库根目录的 README.md。
 * 本文件是空壳：导出面齐全，任何调用都抛 `not implemented`。
 */
import { BadRequestError, TooLargeError } from './errors.js';

export { BadRequestError, TooLargeError };

/**
 * 解析从字节 0 开始的**一个**请求。
 *
 * @param {Buffer|Uint8Array} buffer 待解析的字节
 * @returns {{start: {method: string, target: string, version: string},
 *            headers: Map<string, string>,
 *            bodyOffset: number,
 *            bytesConsumed: number} | null}
 *          缓冲里还没有出现完整的 `CRLF CRLF` 时返回 `null`。
 * @throws {BadRequestError} 请求行或头不符合 HTTP/1.1 语法
 * @throws {TooLargeError} 请求行 / 头行 / 头总数超过上限
 */
export function parse(buffer) {
  throw new Error("not implemented");
}
