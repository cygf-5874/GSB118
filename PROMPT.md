请求行、头、体三段必须严格按 RFC 9112 的顺序识别，一个字节都不能多读。httplite 是
Node.js 22 的 HTTP 请求解析库，只用 `node:` 内置模块（无第三方依赖），
构建不需要额外步骤，自检走 `scripts/check.sh`（`check/` 是固定验收程序，别改），
既有用例走 `node --test`。

`src/httplite.js` 现在只有导出签名，方法体全抛错；`src/errors.js` 里两个错误类已经给全。

任务：按 README「对外契约」的 10 条实现，让固定件全过，并让 14 个既有用例转绿。

验收：
- node --test 14/14 全绿；
- node check/check.mjs 退出码 0，10 个场景全过（start 2 + framing 3 + headers 2 + limit 2 + incomplete 1）。

约束：
1. 不改 `check/`、不改 `src/errors.js`；可以新增模块。
2. 对外导出名与签名已定死，不要改；`test/httplite.test.js` 里的用例一条都不许删或改。
3. 只用 `node:` 内置模块，`package.json` 里不许出现 `dependencies`。
4. 解析必须是纯函数，不许改动传进来的 Buffer。
