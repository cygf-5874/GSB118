# httplite

HTTP/1.1 请求解析库。Node.js 22、ESM，只用 `node:` 内置模块，**零第三方依赖**。

- 入口：`src/httplite.js`（导出 `parse`）
- 错误类型：`src/errors.js`（导出 `BadRequestError` / `TooLargeError`）
- 既有用例：`test/httplite.test.js`（14 个，起点全红）
- 固定验收程序：`check/check.mjs`（**不要修改**）
- 自检：`bash scripts/check.sh`

```bash
node --test                    # 既有用例（仓库根目录裸跑）
node check/check.mjs           # 跑全部场景
node check/check.mjs -list     # 只列出 组/名
node check/check.mjs --only framing
bash scripts/check.sh --only headers
```

---

## 数据模型

`parse(buffer)` 从字节 `0` 开始识别**一个**请求，返回

```js
{
  start: { method, target, version },
  headers: Map<string, string>,
  bodyOffset: number,
  bytesConsumed: number,
}
```

或者返回 `null`（表示「缓冲里还没有一个完整请求，还需要更多字节」）。

### `start`

- `method`：**大写** token（RFC 9110 `token` 字符集，且不含小写字母）；
- `target`：请求目标（原样保留，不解码）；
- `version`：只接受 `HTTP/1.0` 与 `HTTP/1.1` 两个字面量。

请求行形如 `method SP target SP version`，**恰好三段**，以单个 SP 分隔。

### `headers`

- 是 `Map<string, string>`，键为**小写**头名，值为**去掉首尾空白（SP / HTAB）**后的字符串；
- 迭代顺序 = 各头名**首次出现**的顺序；
- 同名头重复出现时，值按出现顺序用 `, ` 连接（`Set-Cookie` 也照此连接，其连接顺序有意义）；
- 头名的字节按 **latin1** 逐字节映射为字符串（即每个字节对应一个 `U+0000..U+00FF` 字符）。

### 帧（framing）

头段以 `CRLF CRLF` 结束。`bytesConsumed` 是「请求行 + 所有头行 + 结尾 `CRLF CRLF`」的**字节数**，
`bodyOffset` 恒等于 `bytesConsumed`。`buffer` 里排在后面的数据（正文、后续请求）**不属于**本次解析结果。

---

## 对外契约（10 条）

1. `parse(Buffer) -> { start, headers, bodyOffset, bytesConsumed }`：解析从 `0` 起的一个请求；
   入参也可以是 `Uint8Array`。
2. `start`：`{ method, target, version }`；`method` 为**大写 token**，`version` 必须是 `HTTP/1.0` 或 `HTTP/1.1`。
3. 请求行与头一律以 **CRLF**（`\r\n`）结束；出现**单个 LF**（不配对的 `\n`）必须抛 `BadRequestError`，不许宽容。
4. **不许多读**：`bytesConsumed` 必须恰好等于「请求行 + 头 + CRLF CRLF」的长度；
   `bodyOffset === bytesConsumed`；buffer 里后面还跟着别的数据时**不得**被吃掉。
5. `headers` 是一个**保持首次出现顺序**的 `Map<string, string>`（键小写、值 trim 前后空白）；
   重复头按 `, ` 合并。
6. 头名必须是 RFC 9110 的 token；含非法字符抛 `BadRequestError`；头值里出现裸 `\n` 抛 `BadRequestError`。
7. **长度上限**：请求行 `8 KiB`（8192 字节）、单个头行 `8 KiB`、头总数 `100` ——
   **超出**抛 `TooLargeError`。上限在**拼字符串之前**判：一行只要超过上限就先抛 `TooLargeError`，
   不因为该行内容本身也不合语法而改抛 `BadRequestError`。
8. 输入被截断（没有出现 `CRLF CRLF`）时返回 `null`（表示「还需要更多字节」），不得抛错。
9. 空 buffer、只有 `\r\n`、只有请求行无后续，都按第 8 条处理（返回 `null`）。
10. 纯函数：同一输入多次调用结果相同，**不得修改入参 Buffer**；除 `headers` 的 `Map` 迭代顺序外，
    结果不依赖任何顺序源。

### 精确定义（保证判据确定、与实现无关）

- **行的长度**：不含结尾的 `CRLF`。请求行的长度 = 从 `0` 到第一个 `CRLF` 之间的字节数；
  头行的长度 = 该行 `CRLF` 之前的字节数。
- **头总数**：头行的条数（不是去重后的头名个数）。恰好 `100` 条合法，`101` 条抛 `TooLargeError`。
- **上限与截断的先后**：解析只在缓冲里出现 `CRLF CRLF` 之后进行；没有出现 `CRLF CRLF` 时一律返回
  `null`（第 8 条优先），无论缓冲多长。**出现之后**，逐行判上限，再判语法。
- **空头段**：`CRLF CRLF` 紧跟请求行（即零个头）合法，`headers` 为空 `Map`。
- **逐字节还原**：`parse` 只读不写；对同一 `Buffer` 反复调用，`bytesConsumed` 与各字段恒定。

## 导出面

- `src/httplite.js`：`parse(buffer)`。
- `src/errors.js`：`BadRequestError` / `TooLargeError`（均继承 `Error`，实例满足
  `err instanceof X` 且 `err.name === 'X'`）。

## 约束

- 只用 `node:` 内置模块；`package.json` 里**不许出现 `dependencies`**。
- 不改 `check/`、不改 `src/errors.js`、不改 `test/httplite.test.js`；可以新增文件，
  但 `src/httplite.js` 的导出名与签名不许改。
- 不许用 `http` / `http2` / `net` 等现成的解析设施；不许用 `Date.now()`、`Math.random()`。
