# AGENTS.md

本文件记录 `@carizon/board-session` 的开发范式：开发原则、模块职责、构建、手动测试与发布流程。

## 开发原则

> 不要过度设计，模块职责边界清晰，不要假设额外的情况，非必要不增加额外代码，按照终版方案进行开发。

## 当前实现与构建

源码现在是仓库根目录下的独立 npm 包，不再包含 VS Code 插件或跳板端客户端。

| 文件 | 职责 |
| --- | --- |
| `src/identity.ts` | 默认读取包内 debug.key；可校验并原子替换用户数据目录中的共用 PEM，目录 `0700`、文件 `0600`。 |
| `src/transport.ts` | 通过通用 Worker 迭代建立密码跳板连接，维护每跳 loopback 桥接、背压、重试及反向资源清理。 |
| `src/session.ts` | 公开 API、在 `BoardSession.open()` 中统一校验 SSH 参数、shell 就绪、命令完成标记、输出消费、独立 SCP 传输的创建/超时/取消清理及关闭状态，向 Manager 提供轻量活动通知。 |
| `src/native-worker.ts` | 唯一的通用 Worker 脚本；每实例调度独立 addon 连接的握手、Shell/Forward 通道 I/O、SCP 非阻塞步骤和消费确认，不区分板端或跳板。 |
| `src/provider.ts` | 包内 Provider 回调契约与工厂注册、消费者共享数据类型与内部添加补偿错误；可选 `listAvailableBoards` 查询来源真实候选。 |
| `src/index.ts` | 加载内置 Provider 模块以完成自注册，并导出消费者 API。 |
| `src/static.ts` | StaticProvider；仅校验可选显示名称并保存直连或多跳参数，无登录、候选查询、租约或释放能力。 |
| `src/baton.ts` | 内部 Baton HTTP Client 与 Provider：`login` 验证并优先复用有效 Token、`listAvailableBoards` 独立查询真实可预约板、按板子 ID 预约与连接解析、最小单位续约和释放，无生命周期计时器。 |
| `src/manager.ts` | 包内初始化 Provider 注册表、按 ID 统一添加/移除、`listManagedBoards(providerId?)` 从自身资源 Map 返回已管理记录并可按来源筛选、自动租期管理、每板多条独立 SSH、按可选能力空闲回收及自动续期，不定义 Chat 当前板。 |
| `native/addon.cc` | 调用 wolfSSH/wolfSSL 动态库，拥有通用 socket、Password/X.509 认证材料、Shell/Forward 通道、独立 SCP 状态驱动、文件回调、目录遍历及有上限的加密发送缓冲；不修改进程 cwd。 |

通用 SSH 参数仅在 `BoardSession.open()` 校验；Provider 只校验自身业务输入，Manager 只校验资源名称和租期。无效 SSH 配置可能先登记或预约，直到 `openBoard()` 才报错。Provider 不维护已管理列表。

跳板仅支持 `password`；`privateKeyFile` 已移除，旧配置在 `BoardSession.open()` 明确报错。板端继续使用共享 X.509 复合 PEM 和 PTY；跳板保留自动 Shell，不申请 PTY。仅收到远端 `direct-tcpip` 开通确认后才建立可用桥接。Addon 继续无条件接受服务器公钥，不提供服务端身份验证；存在中间人攻击及密码泄露风险，本轮按已确认方案保留。

Manager 的 `login(providerId, input?)` 与 `listAvailableBoards(providerId)` 独立，分别转交 Provider 的可选方法；无登录方法时直接成功，无候选查询方法时返回 `[]`，认证或查询错误正常抛出。`getProviders()` 仅返回 ID 和显示名称；认证状态由 Provider 自行维护，Manager 不保存凭据或 Token。

当前构建和验证平台为 **Linux x64（并在同一 Linux x64 主机上交叉编译 win32-x64）/ Node.js 22+**；产物使用 Node-API v8。`package.json` 限制 `os: ["linux", "win32"]`、`cpu: ["x64"]`，与已入库的 `prebuilds/linux-x64/` 和 `prebuilds/win32-x64/` 一致；macOS 尚未实现。发布包只携带已构建平台的 addon、动态库、编译后的 JS/类型定义及包内调试凭据，不在安装时编译。

开发构建需要 C++17、CMake 3.21+、Node.js headers，win32 交叉编译还需提供 `x86_64-w64-mingw32-g++`，以及提供 X.509 能力的 wolfSSL 和 wolfSSH。本仓库**只消费 wolfSSH/wolfSSL 的头文件与动态库，不构建它们**；构建输入按目标平台维护在 `build/deps/linux-x64/`（`include/`+`lib/`）和 `build/deps/win32-x64/`（`include/`+`lib/`+`bin/`，`bin/` 放 wolf DLL），头文件复用 `build/wolfssh/include` 与 `build/wolfssl/include`。其他安装位置可通过环境变量指定：

```bash
npm ci

# 两个安装都必须提供匹配的头文件和动态库。
export WOLFSSH_ROOT=/path/to/wolfssh-install
export WOLFSSL_ROOT=/path/to/wolfssl-install

npm run build:native
npm run build:ts
npm pack
```

`NODE_INCLUDE_DIR` 可指定包含 `node_api.h` 的目录。

`npm run build:native` 用 CMake 编译 `native/addon.cc`，把 addon、wolfSSH/wolfSSL 动态库（win32 另含 MinGW 运行时 DLL）放入 `prebuilds/<platform>-<arch>/`。wolfSSH 必须以 X.509 证书支持和终端支持编译，且对无本地 TTY 的 Node.js 进程启用 `NO_TERMIOS`：远端仍申请 PTY，但终端模式不从进程 stdin 读取。addon 使用相对自身目录的库搜索路径；安装产物后无需设置 `LD_LIBRARY_PATH` 或全局安装 wolfSSH。

`npm run build:ts` 只编译 TypeScript 到 `dist/`；`npm pack` 会先执行 `build:ts`，把 `dist/`、`prebuilds/` 和 `README.md` 打进发布包。

改动 `native/addon.cc`、`native/CMakeLists.txt` 或更换 wolfSSH/wolfSSL 库后，必须先 `make build`（= `npm run build:native`）刷新入库的 `prebuilds/`，再打包发布；只改 `src/*.ts` 时无需重建原生。

## 真实环境手动测试

不编写单元测试；功能集成可使用 `test/` 中的手动脚本连接真实 SSH 端点，不引入单测框架。使用包内调试凭据 `prebuilds/debug.key`，并复用 `exec()` / `send()` / `read()` / `close()` 的语义：

```bash
node --input-type=module -e "
import { readFile } from 'node:fs/promises';
import { BoardSession } from '@carizon/board-session';
await BoardSession.setIdentity(await readFile('./prebuilds/debug.key'));
const session = await BoardSession.open({
  board: { host: '<板子地址>', port: 22, username: 'root' },
  jumps: [],
});
try {
  const result = await session.exec('uname -a');
  console.log(result.completed, result.exitCode, result.text);
} finally {
  await session.close();
}
"
```

建议覆盖：持久 shell（变量与工作目录保留）、退出码、超时后 `completed: false` 与恢复、交互输入、Ctrl-C 后的未确定状态、大输出/大输入、凭据替换、认证失败与建链失败后的清理。多跳时按真实连接顺序填写 `jumps`，每跳提供密码。全链路验收覆盖 0/1/N 跳、远端拒绝转发、跳板 Shell 退出后继续转发、二进制大流量与慢接收背压、重协商、冷启动重试、断链、在途关闭、重复关闭及 Worker/socket 清理。多板功能重点实测并行打开不同板及同板多个独立 SSH；关闭单一 session 不释放板子；移除板子关闭其所有 session；在途连接与释放竞态；release 失败可重试。

## 发布到私有源

发布沿用 `foundry-local` 的机制：`Makefile` + `publish.py`，直接走 npm registry HTTP 协议推到 JFrog 的 `vscode` 仓库。不引入 `.npmrc`、`npm publish`、CI workflow 或安装期脚本。

| 项 | 值 |
| --- | --- |
| registry | `https://jfrog.carizon.work/artifactory/api/npm/vscode/` |
| 包名 | `@carizon/board-session` |
| 默认 dist-tag | `carizon`（与 foundry-local 一致） |
| 发布版本号 | `<package.json version>-carizon`（如 `0.1.0-carizon`），沿用 foundry-local 的 `-carizon` 约定 |

```bash
make build            # 原生 addon (prebuilds/) + TypeScript (dist/)
make pack             # 只打包并打印清单, 不推送 (dry-run)
make publish          # 打包 -> 认证 -> 同版本先删后推
make publish version=0.1.0-carizon.1   # 指定版本
make publish tag=carizon               # 指定 dist-tag
```

- 打包清单以 `package.json` 的 `files` 为唯一真源（`dist`、`prebuilds`、`README.md`），`publish.py` 读取它并总是附上 `package.json`。版本号只在打包时写进 tarball 内的 `package.json`，不改仓库文件。
- 认证为交互式输入 JFrog 账号密码（密码不回显），Basic 头随每个请求发送、不落盘；非交互终端直接失败。推送不调用 `npm`/子进程。
- 目标版本已存在时，先按 npm 单版本 unpublish 路径摘除该版本并删除其 tarball 再重推；其余版本与 dist-tag 不受影响。
- `prebuilds/`（含 addon、wolfSSH/wolfSSL 动态库、win32 的 MinGW 运行时 DLL 与调试凭据 `debug.key`）纳入 git 跟踪，使预构建产物可复现；`build/`（本地 wolfSSH/wolfSSL 安装树与 `build/deps/`）与 `dist/`（由 `src/` 打包时生成）不入库。
- 本包只携带构建平台的预构建 addon 与动态库，消费者 `npm install` 时不编译原生代码。

## SCP 构建与验收

`upload(localPath, remotePath)` / `download(remotePath, localPath)` 自动支持文件及递归目录。每次另建 Transport 与同一个 `native-worker.ts` 的独立实例，不在持久 Shell 上运行 SCP，也不改变 Transport 的一对一转发结构。Manager/Provider 无须增加传输业务逻辑。

wolfSSH 必须启用 `--enable-scp`，并包含本次 `/home/songlei/project/wolf/wolfssh` 的必要修改：公开 `wolfSSH_SetScpRecursive` 和 `wolfSSH_GetScpErrorMsg`，远端路径引用，按边界消费控制消息与确认，非阻塞重试，以及自定义回调不进入默认文件上下文的清理/重命名逻辑。Linux 仍需 `--enable-term` 和 `NO_TERMIOS`。更新 wolfSSH 后同步两平台 `build/deps/` 头文件、动态库与 Windows import library，再运行 `make build`；不需要重编 wolfSSL。board 构建仍只消费依赖，不构建 wolfSSH。

不使用远端 find 预扫描。允许跟随源符号链接；上传检测祖先循环，两方向限制深度 128、总时长 5 分钟。下载拒绝不安全条目名、越界目录层级及目标树中的符号链接。错误可能留下部分目标，不能报告成功；具体路径语义和限制见 README。

真实功能验收应覆盖 0/1/多跳、文件和目录双向 SHA-256、空目录/隐藏文件/零字节/Unicode、覆盖和冲突、链接循环、并发、取消和文件描述符稳定性，以及传输前后的持久 Shell。Windows Wine 运行结果必须与原生 Windows 主机验收区分。不得提交临时身份、账号、SSH 配置或测试数据。
