/**
 * httplite 的错误类型。
 *
 * 两个类都已给全，实现方不需要（也不应该）改动本文件。
 */

/** 请求行 / 头不符合 HTTP/1.1 语法时抛出。 */
export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** 请求行 / 头行 / 头总数超过 README 写明的上限时抛出。 */
export class TooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TooLargeError';
  }
}
