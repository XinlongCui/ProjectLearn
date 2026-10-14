> **学习版批注（以同目录当前 TypeScript 实现为准）**
>
> 查API时同时区分单位、对象引用和调用副作用：dt用秒，内部累计用微秒，networkLatency已是毫秒。
> setAddServerFrame：true允许、false禁止。stop：回UNINITIALIZED，清事件监听，但保留dataHandler；destroy再解除dataHandler。
> hasFrame查缓存key存在，不代表服务器确认。getFrame/getFrameBuffer返回实际可变对象引用，没有深拷贝。
> getClientFrameData参数用原始帧号，内部加delay；getClientFramesData把多时间帧塞进一个frames数组并跳过缺项，没有逐项帧号包装。
> onServerFrameBatch缺省时只回调最后一帧；FRAME_ERROR虽有定义，当前Manager没有主动emit它。
> stats中的预测、校正、缺口次数并非去重帧数；networkLatency是帧差换算，不是实测RTT。以下为原API说明。

---

# 帧同步通用框架 — API 速查

## MngClientFrameSyncManager

核心控制器，管理帧同步的完整生命周期。

### 泛型参数

| 参数 | 约束 | 说明 |
|------|------|------|
| `TInfo` | extends `MngBaseFrameInfo` | 帧操作信息类型 |
| `TFrameInfos` | extends `MngBaseFrameInfos<TInfo>` | 玩家帧信息类型 |
| `TFrameData` | extends `MngBaseFrameData<TFrameInfos>` | 帧数据类型 |

### 构造 & 生命周期

| 方法 | 签名 | 说明 |
|------|------|------|
| constructor | `(config?: Partial<MngFrameSyncConfig>)` | 创建实例，合并默认配置 |
| init | `(): void` | 进入 RUNNING 状态 |
| pause | `(): void` | 暂停 |
| resume | `(): void` | 恢复 |
| stop | `(): void` | 停止并重置所有状态 |
| destroy | `(): void` | 停止 + 清除处理器 |

### 帧驱动

| 方法 | 签名 | 说明 |
|------|------|------|
| updateLogicFrame | `(deltaTime: number): void` | 主循环调用，驱动逻辑帧推进（含追帧策略） |
| updateRenderFrame | `(deltaTime: number): void` | 主循环调用，驱动渲染帧推进 |

### 帧数据管理

| 方法 | 签名 | 说明 |
|------|------|------|
| addClientFrame | `(frameIndex, frameInfo): void` | 添加客户端帧（内部自动 +delay 对齐） |
| addServerFrame | `(frameData): void` | 添加服务器帧（含对齐、矫正、通知） |
| getClientFrameData | `(frameIndex?): TFrameData \| null` | 获取客户端帧数据（返回原始帧号） |
| getClientFramesData | `(start, end): TFrameData \| null` | 获取范围内客户端帧数据 |

### 批处理

| 方法 | 签名 | 说明 |
|------|------|------|
| beginServerFrameBatch | `(): void` | 开始 latest 模式批处理 |
| beginServerFrameReplayBatch | `(): void` | 开始 replay 模式批处理 |
| endServerFrameBatch | `(flush?: boolean): void` | 结束批处理，flush=true 时派发数据 |

### 查询

| 方法 | 返回值 | 说明 |
|------|--------|------|
| getCurrentLogicFrame() | `number` | 当前逻辑帧号 |
| getCurrentRenderFrame() | `number` | 当前渲染帧号 |
| getServerFrame() | `number` | 服务器帧号 |
| getFrameBuffer() | `MngFrameBuffer` | 帧缓冲区实例 |
| getCorrector() | `MngFrameCorrector` | 帧矫正器实例 |
| getPredictor() | `MngFramePredictor` | 帧预测器实例 |
| getStats() | `MngFrameSyncStats` | 统计信息 |
| hasFrame(frameIndex) | `boolean` | 帧是否存在 |

### 设置

| 方法 | 签名 | 说明 |
|------|------|------|
| setDataHandler | `(handler: IMngFrameDataHandler<TFrameData>): void` | 设置数据处理器 |
| setLogger | `(logger: IMngFrameSyncLogger): void` | 设置日志器 |

### 事件

| 方法 | 签名 | 说明 |
|------|------|------|
| on | `(eventType, callback): void` | 注册事件回调 |
| off | `(eventType, callback): void` | 注销事件回调 |

---

## MngBaseFrameSyncDriver

驱动层抽象基类，桥接协议层与核心控制器。

### 泛型参数

| 参数 | 说明 |
|------|------|
| `TInfo` | 帧操作信息类型 |
| `TFrameInfos` | 玩家帧信息类型 |
| `TFrameData` | 帧数据类型 |
| `TSendParams` | 发送参数类型 |

### 子类必须实现

| 方法 | 签名 | 说明 |
|------|------|------|
| setupEventListeners | `(): void` | 绑定帧事件到游戏事件系统 |
| setupDataHandler | `(): void` | 设置数据处理器 |
| getProtocol | `(): MngBaseFrameSyncProtocol` | 返回协议层实例 |
| convertRawMsgToFrameData | `(rawMsg): TFrameData` | 协议消息 → 通用帧数据 |

### 子类可选覆盖

| 方法 | 签名 | 说明 |
|------|------|------|
| createConfig | `(): MngFrameSyncConfig` | 玩法专属配置（默认返回 DEFAULT） |

### 公开方法

| 方法 | 说明 |
|------|------|
| `init()` | 初始化驱动层（创建 SyncManager） |
| `initSyncClient()` | SyncManager 进入 RUNNING |
| `setAddServerFrame(value)` | 控制是否接入服务器帧 |
| `addServerFrame(rawMsg, frameIndex, roomId)` | 添加服务器帧（含缺帧检测） |
| `addClientFrame(frameIndex, frameInfo)` | 添加客户端帧 |
| `reconnectGame(roomId, historyFrames)` | 重连追帧 |
| `updateLogicFrame(dt)` / `updateRenderFrame(dt)` | 帧驱动 |
| `setLogger(logger)` | 设置日志器 |
| `unInit()` | 销毁 |

### 查询方法

| 方法 | 说明 |
|------|------|
| `getCurrentLogicFrame()` | 逻辑帧号 |
| `getCurrentRenderFrame()` | 渲染帧号 |
| `getServerFrame()` | 服务器帧号 |
| `getServerFrameDelay()` | 配置的延迟帧数 |
| `getClientFrameData(frameIndex)` | 客户端帧数据 |
| `getServerFrameData(frameIndex)` | 服务器帧数据 |
| `getSyncManager()` | 内部 SyncManager |

---

## MngBaseFrameSyncProtocol

协议层抽象基类。

### 泛型参数

| 参数 | 说明 |
|------|------|
| `TSendParams` | 发送参数类型 |
| `TFrameInfos` | 玩家帧信息类型 |
| `TFrameData` | 帧数据类型 |

### 子类必须实现

| 方法 | 说明 |
|------|------|
| `registerMsg()` | 注册网络消息处理 |
| `unregisterMsg()` | 注销网络消息处理 |
| `sendFrame(params)` | 发送帧同步数据到服务器 |
| `sendReconnect(roomId, frameIndex)` | 发送断线重连请求 |

### 子类可选覆盖

| 方法 | 说明 |
|------|------|
| `onDelayDetected(intervalMs)` | 延迟检测钩子 |

### 回调属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `onFrameReceived` | `((frameData) => void) \| null` | 驱动层设置，协议层解析消息后调用 |
| `onReconnectReceived` | `((roomId, roomInfo) => void) \| null` | 驱动层设置，收到重连响应后调用 |

### 公开方法

| 方法 | 说明 |
|------|------|
| `init()` | 注册消息 |
| `unInit()` | 注销消息 |
| `setLogger(logger)` | 设置日志器 |

---

## MngFrameBuffer

帧缓冲区管理器。

| 方法 | 说明 |
|------|------|
| `addClientFrame(frameIndex, frameInfo)` | 添加客户端帧 |
| `addServerFrame(frameIndex, frameInfo)` | 添加服务器帧 |
| `getFrame(frameIndex)` | 获取帧缓冲项 |
| `getClientFrame(frameIndex)` | 获取客户端帧 |
| `getServerFrame(frameIndex)` | 获取服务器帧 |
| `hasFrame(frameIndex)` | 帧是否存在 |
| `isFrameConfirmed(frameIndex)` | 帧是否已被服务器确认 |
| `getFramesInRange(start, end)` | 范围查询 |
| `checkLostFrames(currentFrame, lookback?)` | 丢帧检测（返回列表） |
| `checkLostFrame(currentFrame, lookback?)` | 丢帧检测（返回第一个） |
| `cleanup(beforeFrame)` | 清理旧帧 |
| `clear()` | 清空所有数据 |

---

## MngFramePredictor

帧预测器（线性插值预测）。

| 方法 | 说明 |
|------|------|
| `predictNextFrame(currentFrame, localPlayerData)` | 预测下一帧 |
| `predictFrames(startFrame, count, localPlayerData)` | 批量预测 |
| `setEnablePredict(enable)` / `getEnablePredict()` | 开关控制 |

---

## MngFrameCorrector

帧矫正器（服务器权威矫正）。

| 方法 / 属性 | 说明 |
|-------------|------|
| `correctFrame(frameIndex, serverFrame)` | 矫正单帧 |
| `rollbackAndReapply(from, to, serverData)` | 回滚重放 |
| `normalizeDirection` | 角度归一化钩子（可赋值） |
| `getPlayerKey` | 玩家标识提取钩子（可赋值） |
| `setEnableCorrection(enable)` / `setCorrectionThreshold(threshold)` | 配置 |

---

## 枚举 & 接口

### MngFrameSyncStatus

| 值 | 说明 |
|----|------|
| UNINITIALIZED (0) | 未初始化 |
| RUNNING (1) | 运行中 |
| PAUSED (2) | 已暂停 |
| STOPPED (3) | 已停止 |

### MngFrameSyncEventType

| 值 | 说明 |
|----|------|
| FRAME_UPDATE | 帧数据更新 |
| FRAME_PREDICT | 帧预测 |
| FRAME_CORRECT | 帧矫正 |
| FRAME_LOST | 帧丢失 |
| FRAME_ERROR | 帧同步错误 |

### MngClientVerifyType

| 值 | 说明 |
|----|------|
| LOCAL_PREDICT (0) | 本地预测数据 |
| NORMAL (1) | 正常服务器确认 |
| LOCAL_CORRECTION (2) | 本地矫正后数据 |

### MngFrameSyncConfig

| 字段 | 默认值 | 说明 |
|------|--------|------|
| logicFrameRate | 15 | 逻辑帧率（帧/秒） |
| renderFrameRate | 60 | 渲染帧率（帧/秒） |
| serverFrameDelay | 5 | 服务器帧延迟（帧） |
| maxFrameCache | 600 | 最大帧缓存数量 |
| enableLocalPredict | false | 本地预测开关 |
| enableServerCorrection | true | 服务器矫正开关 |
| logicFrameInterval | 0.066666 | 逻辑帧间隔（秒） |
| renderFrameInterval | 0.016666 | 渲染帧间隔（秒） |

### IMngFrameDataHandler<TFrameData>

| 方法 | 说明 |
|------|------|
| `onClientFrame(frameData)` | 客户端帧处理 |
| `onServerFrame(frameData)` | 服务器帧处理 |
| `onServerFrameBatch?(frames)` | 批量帧处理（可选） |

### IMngFrameSyncLogger

| 方法 | 说明 |
|------|------|
| `isDebugEnabled()` | 是否启用调试日志 |
| `log(msg, ...args)` | 普通日志 |
| `warn(msg, ...args)` | 警告日志 |
| `error(msg, ...args)` | 错误日志 |
