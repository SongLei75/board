# BoardSession

`@carizon/board-session` 是一个独立、宿主无关的 Node.js npm 包。`BoardSession` 提供统一的持久板端 X.509 SSH Session，`BoardManager` 在此之上管理多块板、租期和每板多个独立活动会话。包内没有 VS Code、UI 或通知依赖。

本文前六节定义实现契约，其后是使用细节与 Baton / 多板能力。

## 1. 职责与连接模型

调用方提供板子的地址与可选跳板列表。BoardSession 负责建链、板端 SSH 认证、命令执行、终端输入输出和关闭。调用方不需要关心跳数对应不同的连接实现。

```text
0 跳：Node.js ─────────────────────────────── Board:22
1 跳：Node.js ─ SSH(A) ────────────────────── Board:22
N 跳：Node.js ─ SSH(A) ─ SSH(B) ─ … ─ SSH(N) ─ Board:22
                                                 │
                                   同一份本地 wolfSSH 客户端
                                   完成最终板端 SSH/X.509 会话
```

- `jumps: []` 就是直连；1～N 跳重复同一转发算法，不设计按跳数区分的接口或类。
- 中间节点只提供 SSH 的 TCP forwarding；不要求安装 wolfssh、npm 或板端证书。
- **最终设备的 SSH 握手始终发生在运行本 npm 包的环境**，不在最后一跳执行 wolfssh 命令。
- 每个 BoardSession 对应一个板端持久 shell；多条命令复用该会话。
- Provider 负责各来源的输入校验、板子发现和预约；消费者提供账号与选择结果，Manager 不理解平台业务或 UI。

## 2. 公开 API

### 统一维护一份板端复合 PEM

所有板子使用同一份 X.509 复合 PEM，**它属于整个 npm 包的配置，而不是单块板子的连接参数**。

```ts
import { BoardSession } from '@carizon/board-session';

// 可选：覆盖默认 debug.key；npm 管理保存位置和后续读取。
await BoardSession.setIdentity(compositePem);
```

- `compositePem` 为包含所需私钥和证书的 PEM 内容（`Buffer | string`）。
- npm 在当前用户的数据目录维护**一份**复合 PEM 文件；后续连接自动复用，调用方不需要逐板传文件路径。
- 未配置自定义证书时，直接读取包内 `prebuilds/debug.key`，路径相对 npm 包解析，不依赖当前工作目录。`manager.setIdentity()` 或 `BoardSession.setIdentity()` 复用同一份校验/持久化逻辑；新连接使用当前证书，已有会话不受影响。
- 本方案不设计每板证书仓库、证书下载服务或额外的证书管理器。包内按内部调试要求维护一份 `prebuilds/debug.key`：它就是连接板子调试用的凭据，随包在私有源内分发，仅作调试用途，不作为生产证书使用。

### 连接板子

```ts
const session = await BoardSession.open({
  board: {
    host: '192.168.10.20',
    port: 22,
    username: 'root',
  },
  jumps: [
    {
      host: 'jump-a.example',
      port: 22,
      username: 'alice',
      privateKeyFile: '/path/jump-a-key',
    },
    {
      host: '10.10.0.2',
      port: 22,
      username: 'bob',
      privateKeyFile: '/path/jump-b-key',
    },
  ],
});

try {
  const result = await session.exec('uname -a');
  const output = session.read();
  const reply = await session.send('input', true);
} finally {
  await session.close();
}
```

`jumps` 省略时默认为 `[]`；端口省略时默认为 `22`。数组按真实连接顺序填写。板端用户名和地址属于单次连接参数，复合 PEM 不属于单次连接参数。

每一跳使用其独立的 SSH 认证（privateKeyFile 或 password），与板端的复合 PEM 互不混用。Baton 的跳板参数由其 Provider 解析，Static 使用消费者提供的认证参数。不要求调用方提供转发端口、SSH 命令或内部 socket。

### 会话方法

| 接口 | 语义 |
| --- | --- |
| `BoardSession.setIdentity(pem)` | 为 npm 配置/更新共用的板端复合 PEM。 |
| `BoardSession.open({ board, jumps? })` | 建立 0～N 跳连接并完成板端 X.509 SSH 登录及 shell 就绪，成功才返回实例。 |
| `session.exec(command, timeoutMs?)` | 在持久 shell 中执行一条命令，返回 `{ text, completed, exitCode? }`。 |
| `session.read()` | 返回尚未被前次调用消费的终端输出：`{ text }`。 |
| `session.send(text, appendNewline?)` | 发送交互输入，按需追加回车，返回当前输出：`{ text }`。 |
| `session.close()` | 关闭会话及整条转发链，可重复调用。 |
| `session.isClosed` | 只读会话状态。 |

仅暴露上述必要能力。游标、监听端口、转发 stream、原生指针及逐跳连接由 npm 内部维护。

## 3. 0～N 跳如何实现

npm 使用 `ssh2` 建立跳板链。SSH `direct-tcpip` 传的是**到下一目标的原始 TCP 数据**，中间无需启动 wolfssh。

```text
首跳：Node.js ─ TCP ─ SSH(A)

下一跳：SSH(A).forwardOut(B:22) ─ Duplex ─ SSH(B).connect({ sock })

继续：SSH(B).forwardOut(C:22) ─ Duplex ─ SSH(C).connect({ sock })

最终：SSH(N).forwardOut(Board:22) ─ Duplex ─ 板端 TCP 字节流
```

内部只需要一段按 `jumps` 顺序迭代的逻辑。0 跳直接访问板端，不创建 ssh2 跳板连接。每个后续节点的地址由**上一跳可访问的网络**决定。

跳板必须允许 SSH TCP forwarding；如果不允许，建链失败，不回退成在跳板上执行 netcat、socat 或其他命令。

## 4. wolfSSH 如何接收最终 TCP 连接

`ssh2.forwardOut()` 得到的是 JS Duplex stream，而本地 wolfSSH 动态库接收操作系统 socket；两者不能直接强制转换。

**第一版只在最终接入 wolfSSH 时处理这一次接口差异：**

- **0 跳**：原生模块直接建立到 `board.host:port` 的 TCP socket，然后创建 wolfSSH 会话。
- **1～N 跳**：npm 在 `127.0.0.1:0` 创建一个内部临时监听端口；原生模块连接该端口，npm 将接收到的 loopback socket 与最后一个 `forwardOut(board.host, board.port)` stream 双向连接。

```text
ssh2(A) -> … -> ssh2(N) -> forwardOut(Board:22)
                                  ||
                           内部双向 TCP 桥接
                                  ||
                        127.0.0.1:临时端口
                                  |
                         wolfSSH 原生 socket
                                  |
                         板端 X.509 SSH Session
```

- **不是每跳一个本地端口**；整个会话最多只有最终接入原生模块所需的这一个内部临时监听。
- 桥接后不再需要监听器，但已建立的 socket/forwardOut stream 必须保持到会话结束。
- 内部端口不固定、不暴露给调用方，也不对外网卡监听。
- 桥接只转发原始 TCP 数据，不代替 wolfSSH 做 SSH 握手、认证或终端处理。
- 只实现必要的双向转发、断开处理与清理；暂不引入自定义 wolfSSH I/O callback 来替换这条简单路径。

## 5. wolfSSH 能力依赖与模块边界

BoardSession **消费** wolfSSH/wolfSSL 提供的客户端动态库能力：接入 TCP socket、使用复合 PEM 进行 X.509 SSH 认证、建立持久终端会话、收发 SSH 通道数据以及关闭会话。

```text
@carizon/board-session
  JS/TS                  0～N 跳建链、必要的 TCP 桥接、统一会话 API
  native (Node-API)      调用 wolfSSH 动态库，处理板端会话和终端 I/O
  wolfSSH / wolfSSL      最终板子的 SSH/X.509 协议能力
```

- wolfSSH 不负责逐跳建链或调用方的连接参数。
- ssh2 只用于跳板 SSH 和 TCP forwarding，不参与最终板端 X.509 SSH 认证。
- BoardSession 以 native addon 调用库接口，不启动 `wolfssh` 可执行文件，也不要求任何跳板安装 wolfSSH。
- npm 交付物携带与运行平台匹配的 addon 及所需动态库，不依赖全局安装或手工设置库搜索路径。
- 一份复合 PEM 由 npm 配置和保存，供所有板端会话使用。

## 6. 会话行为约束

- 一个板端会话保留一个持久 shell；多次 `exec()` 复用该会话，不重复建链。同一 shell 不允许并发 `exec()` 相互串台。
- 持久 shell 内单条命令的退出码不能直接等同于 SSH channel 结束时的退出码；`exec()` 必须能区分命令输出、完成和退出码。
- `exec()` 超时不代表远端命令已经停止；在状态未确定时不能盲目执行下一条命令。
- `read()` 只返回尚未消费的输出；`send()` 的等待不等同于远端命令完成。
- 任一跳失败即关闭整个会话并释放已建立的原生会话、桥接、channel 和跳板连接；`close()` 幂等。
- 不设计连接池、自动重连、文件传输、额外命令前缀、按跳数分类的会话类型或其他尚无需求的扩展。

## 7. 使用细节

```ts
import { BoardSession } from '@carizon/board-session';

// 未设置自定义 identity 时自动使用包内 debug.key。
const session = await BoardSession.open({
  board: { host: '192.168.10.20', username: 'root' },
  jumps: [],
});
try {
  console.log(await session.exec('cd /tmp; export BOARD_VALUE=hello'));
  console.log(await session.exec('printf "%s\\n" "$BOARD_VALUE"'));
} finally {
  await session.close();
}
```

- PEM 位置为 `$XDG_DATA_HOME/carizon/board-session/identity.pem`，未设置 `XDG_DATA_HOME` 时使用 `~/.local/share/carizon/board-session/identity.pem`。新连接读取当前文件；已经建立的会话不受替换影响。
- 板端需要支持 POSIX shell 的 `eval`、`printf` 和 `stty`。会话初始化关闭输入回显和 shell 提示符；命令在同一个 shell 中执行，工作目录和变量会保留。输出保留终端原始换行/控制字符，stdout 和 stderr 通过 PTY 合并。
- `exec()` 默认超时 30 秒，超时返回 `completed: false`，不发送终止信号。只有收到该命令的完成标记才能自动解除忙状态；随后输出可通过 `read()` 消费。并发或仍未确定完成的 `exec()` 会被拒绝，不排队。
- `exec()` 只返回本条命令开始/完成标记之间尚未消费的输出，不混入先前未读的终端输出；旧输出仍可 `read()`。`read()`/`send()` 消费当时的全部未读输出，因此执行期间调用它们，会减少最终 `exec().text` 中的文本，已经消费的文本不会再次返回。
- `send()` 等待输入交给原生 SSH 通道后返回当时已有输出，不等待远端响应或命令完成；`appendNewline: true` 追加 `\r`。后续响应通过 `read()` 或正在等待的 `exec()` 取得。
- `send()` 是原始终端输入。Ctrl-C、`exit`、`exec` 替换 shell 或修改 shell 的执行行为可能让完成标记不再执行；此时状态不确定的会话需要 `close()` 后重新打开，不把等待结束当作完成。
- 连接/认证失败会让 `open()` 拒绝；已打开会话断开后 `isClosed` 变为 `true`，正在等待的操作会拒绝，剩余输出仍可 `read()`，`close()` 可重复等待清理完成。
- 当前 API 没有提供服务端主机密钥或 CA 信任配置；跳板和板端**不做服务端主机身份固定/校验**。X.509 在这里用于板端对客户端的认证，不能据此声称已验证服务端身份。

## Provider 注册与添加板子

各内置 Provider 在模块加载时自注册，包入口加载所有内置模块，`BoardManager` 构造时统一创建实例。消费者用 `getProviders()` 获取 `{ id, displayName }`。Manager 只透明转交输入、保存资源和调度生命周期，不解读平台字段，不包含 UI 或动态插件注入。

消费者负责账号表单、静态地址输入和候选板选择。Static 没有目录，直接添加；Baton 先认证并查询真实可预约板，再通过所选 ID 预约。

通用 SSH 参数仅由 `BoardSession.open()` 校验；Manager 只校验资源名称和租期。因此无效 SSH 配置可能先登记（Baton 可能已预约），直到 `openBoard()` 才报错。两类列表均通过 Manager 获取：Provider 只查询来源候选，不维护 Manager 的已管理列表。

```ts
import { BoardManager } from '@carizon/board-session';

const manager = new BoardManager();
const providers = manager.getProviders();
// 可选：await manager.setIdentity(compositePem);

await manager.login('static'); // 无登录需求，直接成功。
const staticChoices = await manager.listAvailableBoards('static'); // []。
const staticBoard = await manager.addBoard('static', {
  name: 'local-board',
  board: { host: '192.168.1.100', username: 'root', port: 22 },
  jumps: [], // 0～N 跳，按真实连接顺序填写。
});

const managed = manager.listManagedBoards(); // 当前 Manager 管理的所有来源记录。
const staticBoards = manager.listManagedBoards('static'); // 仅 Static 记录。

const s1 = await manager.openBoard(staticBoard.id);
const s2 = await manager.openBoard(staticBoard.id);
await Promise.all([s1.exec('pwd'), s2.exec('uname -a')]);
await manager.removeBoard(staticBoard.id); // s1、s2 全部关闭。

// username/password 和 selectedId 由消费者自己的 UI 或配置提供。
await manager.login('baton', { username, password });
const choices = await manager.listAvailableBoards('baton'); // 只查询，不触发登录。
// 消费者展示 choices 并取得 selectedId。
const batonBoard = await manager.addBoard('baton', { boardId: selectedId });
const ssh = await manager.openBoard(batonBoard.id);
await ssh.exec('uname -a');
await manager.login('baton'); // 验证并复用已有有效 Token。
await manager.removeBoard(batonBoard.id); // 关闭所有 SSH，然后释放预约。
```

### Manager 公共接口

| 接口 | 语义 |
| --- | --- |
| `getProviders()` | 仅返回内置来源 ID 和显示名称。 |
| `login(providerId, input?)` | 透明转交给 Provider 的可选登录方法；无登录方法时直接成功，未知来源抛错。 |
| `listAvailableBoards(providerId)` | 独立查询来源真实候选，不接受凭据或触发登录；无查询方法或当前无候选均返回 `[]`，未知来源、认证或查询错误正常抛出。 |
| `addBoard(providerId, input)` | 由 Provider 校验业务输入和获取资源，返回 `ManagedBoard`，不校验 SSH 参数或建立 SSH。 |
| `listManagedBoards(providerId?)` | 直接从 Manager 的资源 Map 返回已管理板子及剩余租期、未关闭会话数、可用状态和可选错误；可按来源筛选，不需要轮询来驱动生命周期。 |
| `getBoard(id)` | 查找一块已管理板子的基本信息，不存在时返回 `undefined`。 |
| `openBoard(boardId)` | 每次新建独立 SSH 和持久 shell，返回 `BoardSession`。 |
| `removeBoard(boardId)` | 关闭该板全部 SSH，按可用能力释放资源，成功后移除记录。 |
| `setIdentity(pem)` | 全局覆盖新建 SSH 使用的 PEM，所有 Manager 和直接创建的 Session 共用。 |
| `onDidChange(listener)` | 订阅板子变更，返回取消订阅函数。 |

**`removeBoard(boardId)` 会关闭该板子的全部 SSH Session，包括其他消费端仍持有的句柄。** 消费者无需逐个关闭 Session。Manager 不提供 `closeSession()` 或 `dispose()`；底层 `session.close()` 仍可用于关闭单条 SSH，不释放板子、不影响其他会话。

- `ManagedBoard` 为 `{ id, name, providerId, lease }`，`lease` 是 `null` 或 `{ expiresAt }`。Manager 生成管理 ID，返回值不含 SSH 凭据或 Provider 私有句柄。
- `listManagedBoards(providerId?)` 每项在基本信息上增加 `remainingMs/sessions/available/error?`。返回的数据为快照，修改它不会改变管理记录。
- 同板增加 SSH 使用 `openBoard(boardId)`。Baton 通过内部稳定资源键合并在途添加、复用已有登记，避免重复预约；Static 每次添加独立登记。
- 添加失败由 Provider 补偿；成功返回后登记失败由 Manager 按可用释放能力补偿。补偿失败保留不可用记录，通过 `listManagedBoards()` 找到 ID 后重试 `removeBoard(id)`。

### 包内 Provider 边界

`provider.ts` 定义内部契约和工厂注册表：必需 `id/displayName/addBoard`，可选 `login/listAvailableBoards/getBoardKey/renewBoard/releaseBoard`。每个 Provider 独立实现业务并自注册；`index.ts` 导入内置模块；Manager 不引用具体 Provider，也不按来源 ID 分支。不同 Manager 的 Provider 实例、认证及资源状态独立。

Static 只处理 `{ name?, board, jumps? }`：仅校验可选显示名称，保存目标地址和可选的多级跳板。它没有 `login/listAvailableBoards/renewBoard/releaseBoard`，没有虚拟候选板，不预约、不自动回收 SSH。端口默认 22，跳板为 0～N 个，每跳提供 `password` 或 `privateKeyFile`。

Baton 的 `login({ username, password })` 优先通过 `validateToken()` 验证已有 Token；有效时即使传入凭据也直接复用，不切换账号。无有效 Token 时清理候选缓存，有凭据则登录，无凭据则抛出认证错误；验证期间的网络或平台异常直接抛出。并发登录共享同一次认证，Token 仅保存在所属 Provider 内存中，Manager 不保存凭据或登录状态。登录与列板互不调用，消费者可单独调用 `manager.login('baton')` 验证并复用有效认证。

Baton 的 `listAvailableBoards()` 查询平台真实可预约列表，成功后替换内部候选缓存，仅对外返回 `{ id, name }`；查询在途时保留上次成功的候选，`addBoard({ boardId })` 使用该候选执行预约及连接解析。查询不预约，无候选返回空数组；网络或平台错误向上传递，不伪装成空列表。预约和续约沿用 60 分钟最小单位；HTTP 请求超时 30 秒，预约不自动重试。

包入口导出消费端输入类型 `StaticBoardInput/BatonCredentials/BatonBoardInput`，不导出 Provider 实现、注册方法、Baton HTTP Client、私有响应结构或资源句柄。

Baton 服务地址优先级：环境变量 `BENCHOPS_API_URL/BATON_AUTH_URL`、`~/.benchops/config.json`、默认 `https://board.carizon.work` / `https://auth.carizon.work`。

Baton 使用 `server.ip_addr` 和默认 SSH host port 作为跳板（root / 123456），`sub_boards[0].ip_addr` 作为 X.509 板端（root / 22）。容器预约保留 docker image 和已知端口映射，HIL 根据板型字典处理 host network。Session 仍统一支持 0～N 跳。

## 多板、SSH 与统一生命周期

Manager 不维护唯一“当前板”，不保存 Chat/Agent ID。同板 Session 共享设备文件系统，不共享 shell 目录、变量或输出。`BoardSession.open()` 直接创建的会话不参与 Manager 管理。需要共享管理资源的消费者复用同一个 Manager 实例。

### 活动与空闲回收

默认 `idleMs = 600_000`（十分钟），可在构造器调整。空闲回收只按 Provider 是否有 `releaseBoard` 判断，与是否存在租约无关。

- 按板汇总有效 `exec/send/非空 read` 活动，每次刷新空闲窗口；SSH 打开成功也刷新一次。关闭 SSH、空读、无输入的空发送、未消费后台输出不算活动。
- 在途握手和等待中的异步操作沿用现有空闲保护；操作结束后开始完整窗口。`exec()` 超时结束本地保护，不代表远端进程停止，不保证保护任意后台进程。
- **Static 没有释放能力，不调度空闲回收；即使超过十分钟无活动也保留 SSH，直到显式移除板子或关闭会话。**
- 有释放能力的 Provider（如 Baton）空闲时先阻止新连接和操作，关闭全部 SSH，再执行平台释放并移除记录；即使资源没有租约也按此规则回收。
- 清理或释放失败保留不可连接记录，允许显式 `removeBoard(boardId)` 重试。

### 自动续约与到期

默认 `renewAheadMs = 600_000`（十分钟），可调整。只有 Provider 有 `renewBoard` 且资源有有效租约、尚未空闲时，Manager 才在临近到期时调用续约。续约时长由 Provider 决定，消费者不用维护定时器。

- 空闲回收优先于续约；续约不刷新 SSH 活动时间。
- 同板续约与释放串行，在途续约合并，不同板互不阻塞。
- 新租期必须延长现有租期且尚未到期。短租期按剩余时间的一半再次检查，避免连续立即续约。
- 续约失败报告 `renewFailed`，同租期不无限自动重试；到期后立即阻止连接、关闭 SSH。
- 到期/释放先关本地 SSH，再等待在途续约结束并调用可用的 `releaseBoard`。迟到续约不能复活本地资源。Baton 仅在确认自然过期时跳过网络 release；续约超时或响应无效时仍按现有策略尝试释放。

`onDidChange()` 通知 `added/renewed/renewFailed/released/releaseFailed/expired`，事件包含板子基本信息、类型与可选错误。监听器异常不影响清理。每板最多一个 `unref()` 定时器，不阻止 Node 退出；仅管理当前进程和 Manager 实例，不引入跨进程恢复、连接池或自动重连。

本轮保留 ssh2 跳板和 wolfSSH 板端链路；wolfSSH 全链路转发及 SCP/SFTP 尚未实现。
