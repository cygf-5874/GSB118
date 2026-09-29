import { Buffer } from 'node:buffer';

import { BadRequestError, TooLargeError } from './errors.js';

export { BadRequestError, TooLargeError };

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const HTAB = 0x09;
const COLON = 0x3a;

const MAX_LINE_LENGTH = 8 * 1024;
const MAX_HEADER_COUNT = 100;

function findHeaderEnd(input) {
  for (let offset = 0; offset + 4 <= input.length; offset += 1) {
    if (
      input[offset] === CR &&
      input[offset + 1] === LF &&
      input[offset + 2] === CR &&
      input[offset + 3] === LF
    ) {
      return offset;
    }
  }
  return -1;
}

function readLine(input, start, end) {
  let offset = start;
  while (offset < end && input[offset] !== LF) {
    offset += 1;
  }

  if (offset === end) {
    return null;
  }

  const crlf = offset > start && input[offset - 1] === CR;
  const contentEnd = crlf ? offset - 1 : offset;
  return {
    start,
    contentEnd,
    next: offset + 1,
    length: contentEnd - start,
    crlf,
  };
}

function latin1(input, start, end) {
  const slice = input.subarray(start, end);
  return (Buffer.isBuffer(input) ? slice : Buffer.from(slice)).toString('latin1');
}

function isTokenByte(byte) {
  if (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a)
  ) {
    return true;
  }

  switch (byte) {
    case 0x21:
    case 0x23:
    case 0x24:
    case 0x25:
    case 0x26:
    case 0x27:
    case 0x2a:
    case 0x2b:
    case 0x2d:
    case 0x2e:
    case 0x5e:
    case 0x5f:
    case 0x60:
    case 0x7c:
    case 0x7e:
      return true;
    default:
      return false;
  }
}

function isMethodByte(byte) {
  return byte >= 0x61 && byte <= 0x7a ? false : isTokenByte(byte);
}

function isTargetByte(byte) {
  return byte >= 0x21 && byte <= 0x7e;
}

function parseStartLine(input, line) {
  const spaces = [];
  for (let offset = line.start; offset < line.contentEnd; offset += 1) {
    if (input[offset] === SP) {
      spaces.push(offset);
    }
  }

  if (spaces.length !== 2) {
    throw new BadRequestError('Request line must contain exactly two spaces');
  }

  const [methodEnd, targetEnd] = spaces;
  const targetStart = methodEnd + 1;
  const versionStart = targetEnd + 1;

  if (
    methodEnd === line.start ||
    targetStart === targetEnd ||
    versionStart === line.contentEnd
  ) {
    throw new BadRequestError('Request line segments must not be empty');
  }

  for (let offset = line.start; offset < methodEnd; offset += 1) {
    if (!isMethodByte(input[offset])) {
      throw new BadRequestError('Invalid HTTP method');
    }
  }

  for (let offset = targetStart; offset < targetEnd; offset += 1) {
    if (!isTargetByte(input[offset])) {
      throw new BadRequestError('Invalid request target');
    }
  }

  const version = latin1(input, versionStart, line.contentEnd);
  if (version !== 'HTTP/1.0' && version !== 'HTTP/1.1') {
    throw new BadRequestError('Unsupported HTTP version');
  }

  return {
    method: latin1(input, line.start, methodEnd),
    target: latin1(input, targetStart, targetEnd),
    version,
  };
}

function isHeaderWhitespace(byte) {
  return byte === SP || byte === HTAB;
}

function parseHeaderLine(input, line, headers) {
  let colon = -1;
  for (let offset = line.start; offset < line.contentEnd; offset += 1) {
    if (input[offset] === COLON) {
      colon = offset;
      break;
    }
  }

  if (colon === -1 || colon === line.start) {
    throw new BadRequestError('Malformed header line');
  }

  for (let offset = line.start; offset < colon; offset += 1) {
    if (!isTokenByte(input[offset])) {
      throw new BadRequestError('Invalid header name');
    }
  }

  let valueStart = colon + 1;
  let valueEnd = line.contentEnd;

  while (valueStart < valueEnd && isHeaderWhitespace(input[valueStart])) {
    valueStart += 1;
  }
  while (valueEnd > valueStart && isHeaderWhitespace(input[valueEnd - 1])) {
    valueEnd -= 1;
  }

  for (let offset = valueStart; offset < valueEnd; offset += 1) {
    const byte = input[offset];
    const valid =
      (byte >= 0x21 && byte <= 0x7e) ||
      byte >= 0x80 ||
      isHeaderWhitespace(byte);
    if (!valid) {
      throw new BadRequestError('Invalid header value');
    }
  }

  const name = latin1(input, line.start, colon).toLowerCase();
  const value = latin1(input, valueStart, valueEnd);

  if (headers.has(name)) {
    headers.set(name, `${headers.get(name)}, ${value}`);
  } else {
    headers.set(name, value);
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
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError('parse expects a Buffer or Uint8Array');
  }

  const headerEnd = findHeaderEnd(buffer);
  if (headerEnd === -1) {
    return null;
  }

  const sectionEnd = headerEnd + 4;
  const requestLine = readLine(buffer, 0, sectionEnd);

  if (requestLine === null) {
    throw new BadRequestError('Malformed request line');
  }
  if (requestLine.length > MAX_LINE_LENGTH) {
    throw new TooLargeError('Request line exceeds 8 KiB');
  }
  if (!requestLine.crlf) {
    throw new BadRequestError('Request line must end with CRLF');
  }

  const start = parseStartLine(buffer, requestLine);
  const headers = new Map();
  let position = requestLine.next;
  let headerCount = 0;

  while (position < sectionEnd) {
    const line = readLine(buffer, position, sectionEnd);
    if (line === null) {
      throw new BadRequestError('Malformed header section');
    }
    if (line.length > MAX_LINE_LENGTH) {
      throw new TooLargeError('Header line exceeds 8 KiB');
    }
    if (!line.crlf) {
      throw new BadRequestError('Header lines must end with CRLF');
    }
    if (line.length === 0) {
      break;
    }

    headerCount += 1;
    if (headerCount > MAX_HEADER_COUNT) {
      throw new TooLargeError('Header count exceeds 100');
    }

    parseHeaderLine(buffer, line, headers);
    position = line.next;
  }

  return {
    start,
    headers,
    bodyOffset: sectionEnd,
    bytesConsumed: sectionEnd,
  };
}
