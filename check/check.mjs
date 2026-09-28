#!/usr/bin/env node
/**
 * httplite 固定验收程序（固定件）。
 *
 * 用法（在仓库根目录）：
 *   node check/check.mjs            跑全部场景
 *   node check/check.mjs -list      只列出 `组/名`
 *   node check/check.mjs --only <组>  只跑某一组
 *
 * 输出：逐场景 `PASS <组>/<名>` 或 `FAIL <组>/<名>  期望=… 实际=…`，
 * 结尾 `结果：通过 x/N`；全过 exit 0，否则 exit 1；失败不早退。
 *
 * 判据只描述**对外可见性质**（请求行三段是否自洽、头段的键/值/顺序、字节账目是否精确、
 * 上限与截断的边界、入参是否被改动），不引用任何内部实现细节。
 * 本文件不含 HTTP 解析实现，测试向量全部是写死的字节串。
 */
import { Buffer } from 'node:buffer';

import { parse } from '../src/httplite.js';
import { BadRequestError, TooLargeError } from '../src/errors.js';

/* ------------------------------------------------------------------ 工具 */

/** 把一段 latin1 文本包成字节缓冲（本文件里不出现 utf-8，避免字节账目歧义）。 */
const B = (s) => Buffer.from(s, 'latin1');

const fail = (msg) => {
  throw new Error(msg);
};

const eq = (actual, expected, label) => {
  if (actual !== expected) {
    fail(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
};

const eqList = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    fail(`${label}：期望 ${b}，实际 ${a}`);
  }
};

const describe = (v) => {
  if (v === null) return 'null';
  if (typeof v === 'object') return `object ${JSON.stringify(v)}`;
  return `${typeof v} ${String(v)}`;
};

/** 必须解析成功：不得返回 null，也不得抛错。 */
function mustParse(buf, label) {
  let r;
  try {
    r = parse(buf);
  } catch (e) {
    const name = e && e.constructor ? e.constructor.name : typeof e;
    fail(`${label}：期望解析成功，实际抛 ${name}: ${e && e.message}`);
  }
  if (r === null) fail(`${label}：期望解析成功，实际返回 null`);
  if (r === undefined || typeof r !== 'object') {
    fail(`${label}：期望返回对象，实际 ${describe(r)}`);
  }
  if (!(r.headers instanceof Map)) {
    fail(`${label}：headers 期望 Map 实例，实际 ${describe(r.headers)}`);
  }
  for (const k of ['bodyOffset', 'bytesConsumed']) {
    if (typeof r[k] !== 'number') fail(`${label}：${k} 期望 number，实际 ${describe(r[k])}`);
  }
  return r;
}

/** 必须恰好抛 ctor（不得是别的类型、不得静默返回）。 */
function expectError(fn, ctor, label) {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  if (thrown === null) fail(`${label}：期望抛 ${ctor.name}，实际正常返回`);
  if (!(thrown instanceof ctor)) {
    const got = thrown && thrown.constructor ? thrown.constructor.name : typeof thrown;
    fail(`${label}：期望 ${ctor.name} 实例，实际 ${got}: ${thrown && thrown.message}`);
  }
  if (thrown.name !== ctor.name) {
    fail(`${label}：期望 err.name === '${ctor.name}'，实际 '${thrown.name}'`);
  }
}

/* -------------------------------------------------------------- 测试向量 */

const SIMPLE = B('GET /index.html HTTP/1.1\r\n\r\n');

const HEAD_2 = 'GET /a HTTP/1.1\r\nHost: x\r\nAccept: y\r\n\r\n';

const HEAD_TAIL = 'GET /a HTTP/1.1\r\nHost: x\r\n\r\n';
// 后续数据自身也含 `CRLF CRLF`，而且是一个完整请求：越读的实现会在这里露馅。
const FOLLOWING = 'POST /b HTTP/1.1\r\nHost: y\r\n\r\nbody-bytes';

const HEADERS_MIX =
  'GET / HTTP/1.1\r\n' +
  'Host: example.com\r\n' +
  'X-One: v1\r\n' +
  'Set-Cookie: a=1\r\n' +
  'X-Two:   v2  \r\n' +
  'Set-Cookie: b=2\r\n' +
  '\r\n';

const HEADERS_DUP = 'GET / HTTP/1.1\r\nX-Dup: 1\r\nX-Dup: 2\r\nX-Dup: 3\r\n\r\n';

/** 恰好 8192 字节的合法请求行。 */
const LINE_8192 = `GET ${'/'.repeat(8179)} HTTP/1.1`;
/** 8193 字节：超限一个字节。 */
const LINE_8193 = `GET ${'/'.repeat(8180)} HTTP/1.1`;

const headerLines = (n) => Array.from({ length: n }, (_, i) => `X-H${i}: v${i}`).join('\r\n');

/* ---------------------------------------------------------------- 场景表 */

const scenarios = [
  {
    group: 'start',
    name: '请求行解析',
    expect:
      'parse("GET /index.html HTTP/1.1 CRLF CRLF") 得到 method=GET、target=/index.html、version=HTTP/1.1，headers 为空 Map，bytesConsumed=请求行长度+4',
    run() {
      const r = mustParse(SIMPLE, 'parse(简单 GET)');
      eq(r.start.method, 'GET', 'start.method');
      eq(r.start.target, '/index.html', 'start.target');
      eq(r.start.version, 'HTTP/1.1', 'start.version');
      eq(r.headers.size, 0, 'headers.size（零个头）');
      eq(r.bytesConsumed, SIMPLE.length, 'bytesConsumed');
      eq(r.bodyOffset, SIMPLE.length, 'bodyOffset');

      const withQuery = mustParse(B('POST /a/b?x=1&y=%20 HTTP/1.1\r\n\r\n'), 'parse(带查询串)');
      eq(withQuery.start.method, 'POST', 'start.method（POST）');
      eq(withQuery.start.target, '/a/b?x=1&y=%20', 'start.target（原样保留）');
    },
  },
  {
    group: 'start',
    name: '方法与版本校验',
    expect:
      'HTTP/1.0 与 HTTP/1.1 合法；小写 method、非法 method 字符、HTTP/2.0、HTTP/1、缺段、多段一律抛 BadRequestError',
    run() {
      eq(mustParse(B('GET / HTTP/1.0\r\n\r\n'), 'parse(HTTP/1.0)').start.version, 'HTTP/1.0', 'version');
      eq(mustParse(B('GET / HTTP/1.1\r\n\r\n'), 'parse(HTTP/1.1)').start.version, 'HTTP/1.1', 'version');

      const bad = [
        ['get / HTTP/1.1', '小写 method'],
        ['GeT / HTTP/1.1', '混合大小写 method'],
        ['GE(T / HTTP/1.1', 'method 含非 token 字符'],
        ['GET / HTTP/2.0', 'HTTP/2.0'],
        ['GET / HTTP/1', 'HTTP/1'],
        ['GET /', '缺少版本段'],
        ['GET / HTTP/1.1 x', '多出一段'],
        [' GET / HTTP/1.1', '行首多一个空格'],
      ];
      for (const [line, label] of bad) {
        expectError(() => parse(B(`${line}\r\n\r\n`)), BadRequestError, `请求行「${label}」`);
      }
    },
  },

  {
    group: 'framing',
    name: 'CRLF严格性',
    expect:
      '请求行用单个 LF 结束、头值里出现裸 LF —— 都抛 BadRequestError；全部用 CRLF 的同一请求正常解析',
    run() {
      expectError(() => parse(B('GET / HTTP/1.1\nHost: x\r\n\r\n')), BadRequestError, '请求行后是单个 LF');
      expectError(
        () => parse(B('GET / HTTP/1.1\r\nHost: ex\nample.com\r\n\r\n')),
        BadRequestError,
        '头值里出现裸 LF',
      );
      // 对照：同样内容全部用 CRLF 时必须正常解析。
      const ok = mustParse(B('GET / HTTP/1.1\r\nHost: example.com\r\nX-A: 1\r\n\r\n'), 'CRLF 对照');
      eq(ok.headers.get('host'), 'example.com', 'CRLF 对照的 host');
      eq(ok.headers.size, 2, 'CRLF 对照的 headers.size');
    },
  },
  {
    group: 'framing',
    name: 'bytesConsumed精确',
    expect:
      'bytesConsumed 恰等于「请求行 + 头 + CRLF CRLF」的字节数（HEAD_2 为 39），bodyOffset 与之相等；后面再接 4 个字节不改变结果',
    run() {
      const r = mustParse(B(HEAD_2), 'parse(HEAD_2)');
      eq(r.bytesConsumed, HEAD_2.length, 'bytesConsumed');
      eq(r.bodyOffset, r.bytesConsumed, 'bodyOffset 必须等于 bytesConsumed');
      eq(r.headers.size, 2, 'headers.size');

      const withTail = mustParse(B(`${HEAD_2}ZZZZ`), 'parse(HEAD_2 + ZZZZ)');
      eq(withTail.bytesConsumed, HEAD_2.length, '带尾巴时的 bytesConsumed');
      eq(withTail.bodyOffset, HEAD_2.length, '带尾巴时的 bodyOffset');
      eqList([...withTail.headers.keys()], ['host', 'accept'], '带尾巴时的头名顺序');
    },
  },
  {
    group: 'framing',
    name: '后面跟数据不被吃',
    expect:
      '头段后面紧跟一个「自身也含 CRLF CRLF」的完整请求时，bytesConsumed 仍是第一个请求头段的长度，headers 只含第一个请求的 host=x，且入参 Buffer 逐字节不变',
    run() {
      const buf = B(HEAD_TAIL + FOLLOWING);
      const snapshot = Buffer.from(buf);
      const r = mustParse(buf, 'parse(头段 + 后续完整请求)');
      eq(r.bytesConsumed, HEAD_TAIL.length, 'bytesConsumed');
      eq(r.bodyOffset, r.bytesConsumed, 'bodyOffset');
      eq(r.start.target, '/a', 'start.target（必须是第一个请求）');
      eq(r.headers.size, 1, 'headers.size（只含第一个请求的头）');
      eq(r.headers.get('host'), 'x', 'headers.get("host")');
      if (!buf.equals(snapshot)) fail('入参 Buffer 被修改了');
    },
  },

  {
    group: 'headers',
    name: '顺序与大小写',
    expect:
      '头名统一小写；迭代顺序为首次出现顺序 [host, x-one, set-cookie, x-two]；值 trim；重复的 Set-Cookie 按出现顺序合并为 "a=1, b=2"',
    run() {
      const r = mustParse(B(HEADERS_MIX), 'parse(HEADERS_MIX)');
      eqList([...r.headers.keys()], ['host', 'x-one', 'set-cookie', 'x-two'], 'headers 的键与顺序');
      eq(r.headers.get('host'), 'example.com', 'host 的值');
      eq(r.headers.get('x-one'), 'v1', 'x-one 的值');
      eq(r.headers.get('set-cookie'), 'a=1, b=2', 'set-cookie 的合并值（按出现顺序）');
      eq(r.headers.get('x-two'), 'v2', 'x-two 的值（已 trim）');
    },
  },
  {
    group: 'headers',
    name: '重复头合并',
    expect:
      '同一头名出现三次 → 值按出现顺序用 ", " 连接为 "1, 2, 3"；重复只占 Map 里的一个键；头名大小写不同也视为同一个头',
    run() {
      const r = mustParse(B(HEADERS_DUP), 'parse(HEADERS_DUP)');
      eq(r.headers.size, 1, 'headers.size（三次重复只占一个键）');
      eq(r.headers.get('x-dup'), '1, 2, 3', 'x-dup 的合并值');

      const mixedCase = mustParse(
        B('GET / HTTP/1.1\r\nX-Dup: 1\r\nx-dup: 2\r\n\r\n'),
        'parse(大小写不同的同名头)',
      );
      eq(mixedCase.headers.size, 1, 'headers.size（大小写不同算同一个头）');
      eq(mixedCase.headers.get('x-dup'), '1, 2', 'x-dup 的合并值（大小写混合）');
    },
  },

  {
    group: 'limit',
    name: '请求行超限',
    expect:
      '请求行恰好 8192 字节合法；8193 字节抛 TooLargeError；9000 字节且不含空格的非法请求行也必须抛 TooLargeError（不得改抛 BadRequestError）',
    run() {
      const atLimit = mustParse(B(`${LINE_8192}\r\n\r\n`), 'parse(8192 字节请求行)');
      eq(atLimit.start.target.length, 8179, '目标长度（8192 字节请求行恰好放得下）');
      eq(atLimit.bytesConsumed, LINE_8192.length + 4, 'bytesConsumed');

      expectError(() => parse(B(`${LINE_8193}\r\n\r\n`)), TooLargeError, '8193 字节请求行');

      // 先判上限再解析内容：这一行连三段都分不出来，但超限优先。
      expectError(
        () => parse(B(`${'X'.repeat(9000)}\r\n\r\n`)),
        TooLargeError,
        '9000 字节且不含空格的请求行',
      );
    },
  },
  {
    group: 'limit',
    name: '头总数超限',
    expect:
      '恰好 100 个头行合法且 headers.size === 100；101 个头行抛 TooLargeError；超限优先于头名的语法检查',
    run() {
      const ok = mustParse(
        B(`GET / HTTP/1.1\r\n${headerLines(100)}\r\n\r\n`),
        'parse(100 个头行)',
      );
      eq(ok.headers.size, 100, 'headers.size（恰好 100）');

      expectError(
        () => parse(B(`GET / HTTP/1.1\r\n${headerLines(101)}\r\n\r\n`)),
        TooLargeError,
        '101 个头行',
      );

      // 第 101 行的头名非法，但头数超限应优先。
      const bad101 = `GET / HTTP/1.1\r\n${headerLines(100)}\r\nBad Name: v\r\n\r\n`;
      expectError(() => parse(B(bad101)), TooLargeError, '101 个头行（末行头名非法）');
    },
  },

  {
    group: 'incomplete',
    name: '截断返回null',
    expect:
      '空 buffer、只有 CRLF、只有请求行、请求行 + 一个头但没有结尾 CRLF、以及超长但没有 CRLF CRLF —— 一律返回 null，不抛错',
    run() {
      const cases = [
        ['空 buffer', ''],
        ['只有 CRLF', '\r\n'],
        ['只有请求行', 'GET / HTTP/1.1'],
        ['请求行 + CRLF', 'GET / HTTP/1.1\r\n'],
        ['请求行 + 一个头', 'GET / HTTP/1.1\r\nHost: x\r\n'],
        ['超长但没有 CRLF CRLF', 'X'.repeat(9000)],
      ];
      for (const [label, s] of cases) {
        let r;
        try {
          r = parse(B(s));
        } catch (e) {
          const name = e && e.constructor ? e.constructor.name : typeof e;
          fail(`${label}：期望返回 null，实际抛 ${name}: ${e && e.message}`);
        }
        eq(r, null, `${label} 的返回值`);
      }
    },
  },
];

/* ---------------------------------------------------------------- 运行器 */

const argv = process.argv.slice(2);

if (argv.includes('-list')) {
  for (const s of scenarios) process.stdout.write(`${s.group}/${s.name}\n`);
  process.exit(0);
}

let only = null;
const onlyAt = argv.indexOf('--only');
if (onlyAt >= 0) {
  only = argv[onlyAt + 1];
  if (only === undefined) {
    process.stdout.write(
      '用法：node check/check.mjs --only <组名>（组名：start / framing / headers / limit / incomplete）\n',
    );
    process.exit(1);
  }
}

const selected = only === null ? scenarios.slice() : scenarios.filter((s) => s.group === only);

if (selected.length === 0) {
  process.stdout.write(`结果：通过 0/0（没有匹配的场景：--only ${String(only)}）\n`);
  process.exit(1);
}

let passed = 0;
for (const s of selected) {
  const id = `${s.group}/${s.name}`;
  try {
    s.run();
    passed += 1;
    process.stdout.write(`PASS ${id}\n`);
  } catch (e) {
    const actual = e instanceof Error ? e.message : String(e);
    process.stdout.write(`FAIL ${id}  期望=${s.expect} 实际=${actual}\n`);
  }
}

process.stdout.write(`结果：通过 ${passed}/${selected.length}\n`);
process.exit(passed === selected.length ? 0 : 1);
