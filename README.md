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
- npm 包不负责获取跳板账号、发现板子、管理业务权限，也不引入其他客户端场景。

## 2. 公开 API

### 统一维护一份板端复合 PEM

所有板子使用同一份 X.509 复合 PEM，**它属于整个 npm 包的配置，而不是单块板子的连接参数**。

```ts
import { BoardSession } from '@carizon/board-session';

// 首次配置或更换证书时调用一次；npm 管理保存位置和后续读取。
await BoardSession.setIdentity(compositePem);
```

- `compositePem` 为包含所需私钥和证书的 PEM 内容（`Buffer | string`）。
- npm 在当前用户的数据目录维护**一份**复合 PEM 文件；后续连接自动复用，调用方不需要逐板传文件路径。
- 未配置证书时，`open()` 明确报错；重新调用 `setIdentity()` 即替换这份证书，新连接使用新内容。
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

每一跳使用其独立的 SSH 认证（privateKeyFile 或 password），与板端的复合 PEM 互不混用。内置扩展默认使用跳板密码 123456。不要求调用方提供转发端口、SSH 命令或内部 socket。

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
import { readFile } from 'node:fs/promises';
import { BoardSession } from '@carizon/board-session';

await BoardSession.setIdentity(await readFile('./prebuilds/debug.key'));
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

## Connection Modes and Baton (Host Independent)

`getConnectionModes()` returns the host-independent mode IDs `direct`, `baton`, and `jumpserver`. The consuming IDE owns display labels and interaction. All modes still end at the same `BoardSession.open({ board, jumps })`; the native transport and persistent shell do not know about reservation providers.

```ts
import { BatonClient, BoardSession, getConnectionModes } from '@carizon/board-session';

const modes = getConnectionModes();
const client = new BatonClient({ token: tokenFromYourCredentialStore });
if (!await client.validateToken()) {
  const token = await client.login(username, password);
  await yourCredentialStore.save(token);
}
const boards = await client.listAvailableBoards();
const durations = client.listDurations();
const reservation = await client.reserve(selectedBoard, selectedDuration.minutes);
const options = await client.resolveConnection(reservation, selectedBoard);
await BoardSession.setIdentity(compositePem);
const session = await BoardSession.open(options);
```

The Baton client implements token validation/login, reservable-board discovery, duration choices, reservation creation, conversion into `OpenOptions`, and explicit renewal/release. Reservation listing, history management, and UI remain outside this package's scope. `BoardManager` owns local resource and session lifetime; hosts own interaction and notifications.

The client never persists a token or imports VS Code. Pass `token` at construction or call `setToken(token)` to update it. `login` updates the in-memory token and returns that token to the host for optional persistence. Authentication rejection returns `false` from `validateToken`; network/server errors throw. Requests have a 30-second timeout and reservation creation is not automatically retried.

Configuration precedence: explicit `apiUrl` / `authUrl`, environment `BENCHOPS_API_URL` / `BATON_AUTH_URL`, `~/.benchops/config.json` (`boardops_api_url`, `baton_auth_url`), then `https://board.carizon.work` / `https://auth.carizon.work`.

Container reservations include the selected docker image and known ssh/perfetto port mappings; HIL uses the `use_docker_host_network` board-type dictionary flag. Resolution maps `server.ip_addr` plus the `name=ssh` default host port (22 if absent) to the Baton jump (`root` / `123456`), then `sub_boards[0].ip_addr` to the X.509 board (`root`, port 22). The unified Session layer remains 0-N-hop capable, but the Baton provider itself only models the platform data required by the current Baton flow.

## 多板与生命周期（多会话）

`BoardManager` 保存板子资源及由自身创建的会话，但**不再维护唯一“当前板”或唯一活动 SSH**。每次 `openBoard(id)` 均创建新的独立连接和持久 shell；同板多会话共享远端文件系统和进程，不共享 shell 环境、工作目录或命令输出。

```ts
import { BoardManager } from '@carizon/board-session';
const manager = new BoardManager();
manager.addBoard({
  id: 'A', name: 'Board A',
  connection: { board: { host: '192.168.2.62', username: 'root' } },
  expiresAt: null,
});
manager.addBoard({
  id: 'B', name: 'Board B',
  connection: { board: { host: '192.168.2.63', username: 'root' } },
  expiresAt: null,
});
const a1 = await manager.openBoard('A');
const a2 = await manager.openBoard('A'); // 同板第二条 SSH，完全独立
const b1 = await manager.openBoard('B'); // 与 A 同时使用
await Promise.all([a1.exec('pwd'), a2.exec('pwd'), b1.exec('pwd')]);
await manager.closeSession(a1); // 仅关闭一个 shell，保留 A 记录和 a2
await manager.removeBoard('A');  // 关闭所有 A 会话，释放 A 预约；B 不受影响
await manager.closeSession(b1);
await manager.removeBoard('B');
```

- `addBoard(board, lifecycle?)` 登记资源并按能力启动生命周期计时，不建立 SSH；`getBoard(id)` 返回元数据副本；同一资源的所有使用者应引用相同 board ID，避免重复创建 Baton 预约。
- `openBoard(id)` 每次新建独立 `BoardSession`，多板、同板均可并发；不会隐式切换其他消费者的会话。
- `closeSession(session)` 只关闭这一条由本 manager 创建的 SSH，可重复调用，不调用 `release()`；也可直接 `session.close()`，之后 `refresh()` 清理记录。
- `renewBoard(id, minutes)` 对该资源调用可选续约回调，更新绝对到期时间。
- `refresh()` 回收自然到期的资源及其所有 SSH，不调用额外的 Baton release；返回 `{ boards, removedExpired }`，每板包含 `sessions`（当前活跃本地 session 数）、租期时间、`available` 及可选 `error`。定时器会自动处理到期，无需宿主轮询；`removedExpired` 仅包含本次刷新回收的记录，此前自动回收通过 `expired` 事件通知，不缓存历史。
- `removeBoard(id)` 阻止新连接、等候已开始的握手结束并关闭该板全部 SSH，再调用可选的 `release()` 和删除记录；失败则保留**不可继续连接**的待释放记录，可再次 `removeBoard(id)` 重试。其他板不会断开。
- `BoardSession.setIdentity(pem)` 的用户级单份 PEM 机制不变；并行 session 读取同一身份。管理器不保存 Chat/Agent ID，消费者自行维护 `Map<conversationId, {boardId, session}>`。
- `expiresAt: null` 为无租期；绝对毫秒时间戳为到期时间。没有连接池、单 SSH 多 channel 或宿主全局“当前板”。

Baton 的预约生命周期由消费者建立一次，再供不同对话的 session 共同使用：

```ts
const reservation = await client.reserve(selectedBoard, minutes);
const connection = await client.resolveConnection(reservation, selectedBoard);
manager.addBoard({
  id: reservation.b_id, name: selectedBoard.device_code,
  connection, expiresAt: Date.parse(reservation.end_at),
}, {
  renew: minutes => client.renew(reservation.b_id, minutes),
  release: () => client.release(reservation.b_id),
});
const s1 = await manager.openBoard(reservation.b_id);
const s2 = await manager.openBoard(reservation.b_id);
// 关闭 s1/s2 不直接取消预约；无实际操作满 10 分钟会自动归还，也可 removeBoard 显式归还。
```

消费者还应处理 `reserve()` 成功后、`resolveConnection()` 或登记失败时的补偿释放；这是平台事务，不属于单 SSH 会话。

`BatonClient.renew(id, minutes)` 使用 `PATCH /api/boardops/v1/reservation/{id}/extend`，body 为 `{ extension_minutes: minutes }`，将响应的新结束时间字符串解析为绝对时间戳。`release(id)` 使用无 body 的 `POST /api/boardops/v1/reservation/{id}/release`。两者复用现有 token 与错误处理，不增加预约列表或历史管理。Direct / JumpServer 不传 lifecycle，也不注册空 release。

Manager 按板子分别串行调用续约和释放，允许不同板或同板的多个 SSH 同时打开。自然到期会独立关闭 SSH，不等待尚未返回的续约请求。没有包级 current 或重启持久化，`BoardSession.setIdentity` 的全局共用 PEM 契约不变。

### 自动空闲归还与续期

`new BoardManager()` 默认空闲 10 分钟归还、到期前 5 分钟续约、每次续约 60 分钟。构造器可统一调整 `idleMs`、`renewAheadMs`、`renewMinutes`，便于不同运行环境与手动集成验证。

- 有 `release` 的资源从登记开始计算空闲；同板所有 manager-owned session 汇总有效 `exec/send/非空 read` 活动，空闲后关闭全部 SSH 并归还预约。Direct/JumpServer 无回调且 `expiresAt: null`，不启动自动任务。
- 在途握手和异步操作受保护。握手不重置空闲起点；操作结束后开始完整空闲窗口，`exec()` 超时也结束保护。空读、空发送、校验失败、未消费后台输出、单纯关闭 SSH 不刷新时间。
- 有 `renew` 和有效期时按真实截止时间续约，空闲归还优先。返回值必须晚于当前有效期且尚未到期；短租期按剩余时间的一半再次续约，正常租期仍提前 5 分钟。没有额外固定冷却期。
- 续期失败报告错误，本租期不自动重试；可显式 `renewBoard()` 重试。到期则关闭 SSH、删除资源，不再调用平台 release。归还失败保留不可用记录和错误，使用 `removeBoard()` 重试。
- 每板 renew/release 串行，关闭 SSH 不等待续期网络响应；释放开始后拒绝新连接和远端操作，迟到结果不能复活资源。`read()` 仍可读取关闭后留在本地的输出，旧会话不会影响同 ID 新资源。

`onDidChange()` 只通知 `renewed`、`renewFailed`、`released`、`releaseFailed`、`expired` 五种结果，事件包含 `{ type, id, name, expiresAt, error? }`。宿主用它更新界面、清理失效聊天绑定；无需活动上报、引用计数或自己的续期定时器。监听器同步执行，异常不影响资源清理。

```ts
const unsubscribe = manager.onDidChange(event => {
  // 用 event.id 更新板子状态；失败时读取 event.error。
  // released / expired / releaseFailed 时清理该资源失效的 SSH 绑定。
});
await manager.dispose(); // 停止计时、关闭 SSH、尽力归还；失败抛 AggregateError，记录仍可显式重试。
unsubscribe();
```

每板一个 `unref()` 计时器，不阻止 Node 退出。单独 `BoardSession.open()` 不参与预约跟踪。保障仅限当前 Manager 实例及宿主存活期间；进程异常退出由平台真实到期兜底，没有 daemon 或跨进程共享。自动归还后再次使用须重新预约。
