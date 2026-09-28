import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/httplite.js';
import { BadRequestError } from '../src/errors.js';

/** 把一段 latin1 文本包成字节缓冲。 */
const bytes = (s) => Buffer.from(s, 'latin1');

test('parse：解析请求行，返回 method / target / version', () => {
  const r = parse(bytes('GET /index.html HTTP/1.1\r\n\r\n'));
  assert.ok(r !== null, '完整请求应当解析成功而不是返回 null');
  assert.equal(r.start.method, 'GET');
  assert.equal(r.start.target, '/index.html');
  assert.equal(r.start.version, 'HTTP/1.1');
});

test('parse：target 原样保留（含查询串）', () => {
  const r = parse(bytes('POST /a/b?x=1&y=%20 HTTP/1.1\r\n\r\n'));
  assert.equal(r.start.method, 'POST');
  assert.equal(r.start.target, '/a/b?x=1&y=%20');
});

test('parse：接受 HTTP/1.0 与 HTTP/1.1', () => {
  for (const version of ['HTTP/1.0', 'HTTP/1.1']) {
    const r = parse(bytes(`GET / HTTP/1.1\r\n\r\n`.replace('HTTP/1.1', version)));
    assert.equal(r.start.version, version);
  }
});

test('parse：非法版本抛 BadRequestError', () => {
  for (const line of ['GET / HTTP/2.0', 'GET / HTTP/1', 'GET / HTTP/1.1 ', 'GET / HTTP']) {
    assert.throws(() => parse(bytes(`${line}\r\n\r\n`)), BadRequestError, `请求行「${line}」`);
  }
});

test('parse：小写 method 抛 BadRequestError', () => {
  assert.throws(() => parse(bytes('get / HTTP/1.1\r\n\r\n')), BadRequestError);
});

test('parse：headers 的键一律小写', () => {
  const r = parse(bytes('GET / HTTP/1.1\r\nHost: example.com\r\nX-Trace-Id: abc\r\n\r\n'));
  assert.deepEqual([...r.headers.keys()], ['host', 'x-trace-id']);
});

test('parse：headers 的值 trim 前后空白', () => {
  const r = parse(bytes('GET / HTTP/1.1\r\nX-Pad:   spaced value  \r\n\r\n'));
  assert.equal(r.headers.get('x-pad'), 'spaced value');
});

test('parse：headers 保持首次出现顺序', () => {
  const r = parse(bytes('GET / HTTP/1.1\r\nB: 2\r\nA: 1\r\nC: 3\r\nB: 4\r\n\r\n'));
  assert.deepEqual([...r.headers.keys()], ['b', 'a', 'c']);
});

test('parse：重复头用 ", " 合并', () => {
  const r = parse(bytes('GET / HTTP/1.1\r\nX-Dup: 1\r\nX-Dup: 2\r\nX-Dup: 3\r\n\r\n'));
  assert.equal(r.headers.get('x-dup'), '1, 2, 3');
});

test('parse：单个 LF 抛 BadRequestError', () => {
  assert.throws(() => parse(bytes('GET / HTTP/1.1\nHost: x\r\n\r\n')), BadRequestError);
  assert.throws(() => parse(bytes('GET / HTTP/1.1\r\nHost: ex\nample\r\n\r\n')), BadRequestError);
});

test('parse：bytesConsumed 精确等于「请求行 + 头 + CRLF CRLF」', () => {
  const head = 'GET /a HTTP/1.1\r\nHost: x\r\nAccept: y\r\n\r\n';
  const r = parse(bytes(head));
  assert.equal(r.bytesConsumed, head.length);
  assert.equal(r.bodyOffset, head.length);
});

test('parse：bodyOffset === bytesConsumed，后续数据不被吃掉', () => {
  const head = 'GET /a HTTP/1.1\r\nHost: x\r\n\r\n';
  const tail = 'POST /b HTTP/1.1\r\nHost: y\r\n\r\nbody-bytes';
  const r = parse(bytes(head + tail));
  assert.equal(r.bytesConsumed, head.length);
  assert.equal(r.bodyOffset, r.bytesConsumed);
  assert.equal(r.start.target, '/a');
  assert.equal(r.headers.size, 1);
  assert.equal(r.headers.get('host'), 'x');
});

test('parse：没有 CRLF CRLF 时返回 null', () => {
  for (const s of ['', '\r\n', 'GET / HTTP/1.1', 'GET / HTTP/1.1\r\n', 'GET / HTTP/1.1\r\nHost: x\r\n']) {
    assert.equal(parse(bytes(s)), null, `输入 ${JSON.stringify(s)}`);
  }
});

test('parse：纯函数，不修改入参 Buffer，重复调用结果相同', () => {
  const head = 'GET /a HTTP/1.1\r\nHost: x\r\n\r\n';
  const buf = bytes(head + 'TAIL');
  const before = Buffer.from(buf);
  const first = parse(buf);
  const second = parse(buf);
  assert.ok(buf.equals(before), '入参 Buffer 不得被修改');
  assert.equal(first.bytesConsumed, second.bytesConsumed);
  assert.equal(first.start.target, second.start.target);
});
