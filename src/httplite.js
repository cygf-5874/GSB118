/**
 * httplite —— HTTP/1.1 请求解析。
 *
 * 对外契约（10 条）见仓库根目录的 README.md。
 *
 * 识别顺序严格遵循 RFC 9112：先定位头段结尾 `CRLF CRLF`，在此之前一切
 * 截断都返回 `null`；定位之后才逐行判定长度上限，再判定行内语法。
 * 解析全程只读，不修改传入的字节。
 */
import { BadRequestError, TooLargeError } from './errors.js';

export { BadRequestError, TooLargeError };

const SP = 0x20;
const HTAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;
const COLON = 0x3a;

const MAX_LINE = 8192;
const MAX_HEADERS = 100;

const VERSIONS = new Set(['HTTP/1.0', 'HTTP/1.1']);

/** RFC 9110 tchar：token 允许的字符。 */
const TCHAR = new Set(
  "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
);

const decode = (buf, start, end) => buf.toString('latin1', start, end);

function isToken(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i += 1) {
    if (!TCHAR.has(s[i])) return false;
  }
  return true;
}

/** 去掉值首尾的 SP / HTAB（RFC 9112 OWS）。 */
function trimOWS(buf, start, end) {
  let lo = start;
  let hi = end;
  while (lo < hi && (buf[lo] === SP || buf[lo] === HTAB)) lo += 1;
  while (hi > lo && (buf[hi - 1] === SP || buf[hi - 1] === HTAB)) hi -= 1;
  return decode(buf, lo, hi);
}

/**
 * 从头扫描头段结尾 `CRLF CRLF`，返回首个 `\r` 的下标；不存在返回 -1。
 * 仅按字节模式匹配，不解释其间内容，保证「多读一个字节都不可能」。
 */
function findHeaderEnd(buf) {
  const n = buf.length;
  if (n < 4) return -1;
  for (let i = 0; i <= n - 4; i += 1) {
    if (
      buf[i] === CR &&
      buf[i + 1] === LF &&
      buf[i + 2] === CR &&
      buf[i + 3] === LF
    ) {
      return i;
    }
  }
  return -1;
}

function parseStartLine(buf, lineStart, lineEnd) {
  const lineLen = lineEnd - lineStart;
  if (lineLen > MAX_LINE) {
    throw new TooLargeError(`request line too large: ${lineLen} bytes`);
  }
  // 行内不得残留 CR 或裸 LF（行分隔只能是 CRLF，已在切片时剥离）。
  for (let i = lineStart; i < lineEnd; i += 1) {
    if (buf[i] === LF || buf[i] === CR) {
      throw new BadRequestError('bare CR or LF in request line');
    }
  }

  const segments = [];
  let segStart = lineStart;
  for (let i = lineStart; i < lineEnd; i += 1) {
    if (buf[i] === SP) {
      segments.push([segStart, i]);
      segStart = i + 1;
    }
  }
  segments.push([segStart, lineEnd]);

  // 请求行恰好三段，且段段非空（同时排除行首/行尾/连续空格）。
  if (segments.length !== 3 || segments.some(([s, e]) => s === e)) {
    throw new BadRequestError('malformed request line: expected method SP target SP version');
  }

  const method = decode(buf, segments[0][0], segments[0][1]);
  const target = decode(buf, segments[1][0], segments[1][1]);
  const version = decode(buf, segments[2][0], segments[2][1]);

  if (!isToken(method) || method !== method.toUpperCase()) {
    throw new BadRequestError(`invalid method: ${method}`);
  }
  if (!VERSIONS.has(version)) {
    throw new BadRequestError(`invalid HTTP version: ${version}`);
  }

  return { method, target, version };
}

function parseHeaderLine(buf, lineStart, lineEnd, headers) {
  const lineLen = lineEnd - lineStart;
  if (lineLen > MAX_LINE) {
    throw new TooLargeError(`header line too large: ${lineLen} bytes`);
  }
  for (let i = lineStart; i < lineEnd; i += 1) {
    if (buf[i] === LF || buf[i] === CR) {
      throw new BadRequestError('bare CR or LF in header field');
    }
  }

  let colon = -1;
  for (let i = lineStart; i < lineEnd; i += 1) {
    if (buf[i] === COLON) {
      colon = i;
      break;
    }
  }
  if (colon <= lineStart) {
    throw new BadRequestError('malformed header field: missing field name or colon');
  }

  const name = decode(buf, lineStart, colon).toLowerCase();
  if (!isToken(name)) {
    throw new BadRequestError(`invalid header field name: ${name}`);
  }
  const value = trimOWS(buf, colon + 1, lineEnd);

  const existing = headers.get(name);
  if (existing === undefined) {
    headers.set(name, value);
  } else {
    headers.set(name, `${existing}, ${value}`);
  }
}

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
  // 零拷贝归一化为 Buffer 视图（共享底层内存，全程只读）。
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const endMark = findHeaderEnd(buf);
  if (endMark === -1) return null;

  const headers = new Map();

  // 第一段一定是请求行；零个头时它的 CRLF 就是 endMark 本身。
  let crlf = -1;
  for (let i = 0; i <= endMark; i += 1) {
    if (buf[i] === CR && buf[i + 1] === LF) {
      crlf = i;
      break;
    }
  }
  if (crlf === -1) {
    throw new BadRequestError('malformed header section');
  }

  const start = parseStartLine(buf, 0, crlf);
  let pos = crlf + 2;
  let headerCount = 0;

  while (pos < endMark) {
    let nextCrlf = -1;
    for (let i = pos; i <= endMark; i += 1) {
      if (buf[i] === CR && buf[i + 1] === LF) {
        nextCrlf = i;
        break;
      }
    }
    // endMark 之前必有 CRLF（它就是结尾双 CRLF 的起点），找不到说明结构损坏。
    if (nextCrlf === -1) {
      throw new BadRequestError('malformed header section');
    }

    headerCount += 1;
    if (headerCount > MAX_HEADERS) {
      throw new TooLargeError(`too many header fields: ${headerCount}`);
    }
    parseHeaderLine(buf, pos, nextCrlf, headers);
    pos = nextCrlf + 2;
  }

  const bytesConsumed = endMark + 4;
  return {
    start,
    headers,
    bodyOffset: bytesConsumed,
    bytesConsumed,
  };
}
