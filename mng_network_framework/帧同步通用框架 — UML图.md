> **学习版批注（以同目录当前 TypeScript 实现为准）**
>
> 类图用于识别所有权/继承/回调方向，不能把图中有成员误认为该功能已实际接入。例如serverFrameQueue目前未使用。
> 正常收帧时，Manager先对齐并处理包（其中会回调业务），之后才更新serverFrame和统计；回调内部应看传入包的frameIndex。
> 原图中“线性插值预测”实际是沿上一段位移外推。回滚接口当前只合并缓存，不包含完整世界状态恢复与物理重算。
> 生命周期图的setAddServerFrame布尔值要按实现校正：true允许、false禁止；stop实际回UNINITIALIZED，枚举STOPPED并未在stop里使用。
> 追帧软补2/欠账补6是额外执行次数，正常dt累计推进没有同样上限；硬对齐不逐帧发事件。
> 把图中数据类型的关联关系与mng_base_frame_data.ts泛型声明结合阅读，避免把字段包含误解成类继承。以下保留原图。

---

# 帧同步通用框架 — UML 类图 & 时序图

> 所有图表使用 Mermaid 语法，可在 GitHub、VSCode（Mermaid 插件）、Typora 等工具中直接渲染。

---

## 一、UML 类图 — 完整架构

### 1.1 核心类关系总览

```mermaid
classDiagram
    direction TB

    %% ==================== 数据模型层 ====================

    class MngBasePlayerInfo {
        <<interface>>
        +roleId? : Int64
        +name? : string
        +head? : string
    }

    class MngBaseFrameInfo {
        +clientVerify? : number
        +seqId? : number
        +x? : number
        +y? : number
        +direction? : number
    }

    class MngBaseFrameInfos~TInfo~ {
        +simpleInfo? : MngBasePlayerInfo
        +infos? : TInfo[]
    }

    class MngBaseFrameData~TFrameInfos~ {
        +roomId? : number
        +frameIndex : number
        +frames? : TFrameInfos[]
    }

    MngBaseFrameInfos --> MngBasePlayerInfo : 包含 simpleInfo
    MngBaseFrameInfos --> MngBaseFrameInfo : 包含 infos[]
    MngBaseFrameData --> MngBaseFrameInfos : 包含 frames[]

    %% ==================== 配置 ====================

    class MngFrameSyncConfig {
        <<interface>>
        +logicFrameRate : number
        +renderFrameRate : number
        +serverFrameDelay : number
        +maxFrameCache : number
        +enableLocalPredict : boolean
        +enableServerCorrection : boolean
        +logicFrameInterval : number
        +renderFrameInterval : number
    }

    %% ==================== 枚举 ====================

    class MngClientVerifyType {
        <<enumeration>>
        LOCAL_PREDICT = 0
        NORMAL = 1
        LOCAL_CORRECTION = 2
    }

    class MngFrameSyncStatus {
        <<enumeration>>
        UNINITIALIZED = 0
        RUNNING = 1
        PAUSED = 2
        STOPPED = 3
    }

    class MngFrameSyncEventType {
        <<enumeration>>
        FRAME_UPDATE
        FRAME_PREDICT
        FRAME_CORRECT
        FRAME_LOST
        FRAME_ERROR
    }

    %% ==================== 接口 ====================

    class IMngFrameDataHandler~TData~ {
        <<interface>>
        +onClientFrame(frameData: TData) void
        +onServerFrame(frameData: TData) void
        +onServerFrameBatch(frames: TData[])? void
    }

    class IMngFrameSyncLogger {
        <<interface>>
        +isDebugEnabled() boolean
        +log(message, ...args) void
        +warn(message, ...args) void
        +error(message, ...args) void
    }

    class MngFrameSyncStats {
        <<interface>>
        +currentLogicFrame : number
        +currentRenderFrame : number
        +serverFrame : number
        +predictFrameCount : number
        +correctFrameCount : number
        +lostFrameCount : number
        +networkLatency : number
    }

    %% ==================== 帧缓冲区 ====================

    class MngFrameBufferItem~TFrameInfos~ {
        <<interface>>
        +frameIndex : number
        +clientFrame? : TFrameInfos
        +serverFrame? : TFrameInfos
        +confirmed : boolean
        +timestamp : number
    }

    class MngFrameBuffer~TFrameInfos~ {
        -buffer : Map~number, MngFrameBufferItem~
        -maxSize : number
        -minFrame : number
        -maxFrame : number
        +addClientFrame(frameIndex, frameInfo) void
        +addServerFrame(frameIndex, frameInfo) void
        +getFrame(frameIndex) MngFrameBufferItem
        +getClientFrame(frameIndex) TFrameInfos
        +getServerFrame(frameIndex) TFrameInfos
        +hasFrame(frameIndex) boolean
        +isFrameConfirmed(frameIndex) boolean
        +getFramesInRange(start, end) MngFrameBufferItem[]
        +checkLostFrames(currentFrame, lookback) number[]
        +checkLostFrame(currentFrame, lookback) number
        +cleanup(beforeFrame) void
        +clear() void
    }

    MngFrameBuffer --> MngFrameBufferItem : 管理

    %% ==================== 帧预测器 ====================

    class MngFramePredictor~TInfo_TFrameInfos~ {
        -frameBuffer : MngFrameBuffer
        -enablePredict : boolean
        +predictNextFrame(currentFrame, localPlayerData) TFrameInfos
        +predictFrames(startFrame, count, localPlayerData) TFrameInfos[]
        -predictValue(prev, current, input) number
        +setEnablePredict(enable) void
        +getEnablePredict() boolean
    }

    MngFramePredictor --> MngFrameBuffer : 依赖（读取历史帧）

    %% ==================== 帧矫正器 ====================

    class MngFrameCorrector~TInfo_TFrameInfos~ {
        -frameBuffer : MngFrameBuffer
        -enableCorrection : boolean
        -correctionThreshold : number
        +normalizeDirection : Function（钩子）
        +getPlayerKey : Function（钩子）
        +correctFrame(frameIndex, serverFrame) boolean
        -createFrameFromServer(frameIndex, serverFrame, rid) boolean
        -mergeServerFrame(frameIndex, clientFrame, serverFrame, rid) boolean
        -applyCorrection(clientInfo, serverFrame, serverInfo) void
        +rollbackAndReapply(from, to, serverData) void
        +setEnableCorrection(enable) void
        +setCorrectionThreshold(threshold) void
    }

    MngFrameCorrector --> MngFrameBuffer : 依赖（读写帧数据）

    %% ==================== 核心控制器 ====================

    class MngClientFrameSyncManager~TInfo_TFrameInfos_TFrameData~ {
        -config : MngFrameSyncConfig
        -status : MngFrameSyncStatus
        -frameBuffer : MngFrameBuffer
        -predictor : MngFramePredictor
        -corrector : MngFrameCorrector
        -currentLogicFrame : number
        -currentRenderFrame : number
        -serverFrame : number
        -dataHandler : IMngFrameDataHandler
        -logger : IMngFrameSyncLogger
        -eventCallbacks : Map
        +init() void
        +updateLogicFrame(deltaTime) void
        +updateRenderFrame(deltaTime) void
        +addClientFrame(frameIndex, frameInfo) void
        +addServerFrame(frameData) void
        +beginServerFrameBatch() void
        +beginServerFrameReplayBatch() void
        +endServerFrameBatch(flush) void
        +setDataHandler(handler) void
        +setLogger(logger) void
        +getCorrector() MngFrameCorrector
        +getPredictor() MngFramePredictor
        +getFrameBuffer() MngFrameBuffer
        +getStats() MngFrameSyncStats
        +on(eventType, callback) void
        +off(eventType, callback) void
        +pause() void
        +resume() void
        +stop() void
        +destroy() void
        -advanceLogicFrameOnce() void
        -alignClientFrameToServer(serverFrameIndex) void
        -processServerFrameData(frameData) void
        -syncClientFrameWithServer() void
        -syncFramesToLogicFrame(targetLogicFrame) void
        -updateNetworkStats() void
        -emit(eventType, data) void
    }

    MngClientFrameSyncManager *-- MngFrameBuffer : 组合
    MngClientFrameSyncManager *-- MngFramePredictor : 组合
    MngClientFrameSyncManager *-- MngFrameCorrector : 组合
    MngClientFrameSyncManager --> MngFrameSyncConfig : 使用
    MngClientFrameSyncManager --> IMngFrameDataHandler : 回调
    MngClientFrameSyncManager --> IMngFrameSyncLogger : 日志
    MngClientFrameSyncManager --> MngFrameSyncStats : 产出

    %% ==================== 协议层 ====================

    class MngFrameSendParams {
        <<interface>>
        +roomId : number
        +frameIndex : number
        +x : number
        +y : number
        +direction : number
        +seqId? : number
    }

    class MngBaseFrameSyncProtocol~TSendParams_TFrameInfos_TFrameData~ {
        <<abstract>>
        #_inited : boolean
        #logger : IMngFrameSyncLogger
        +onFrameReceived : Function（回调）
        +onReconnectReceived : Function（回调）
        +init() void
        +unInit() void
        +setLogger(logger) void
        #registerMsg()* void
        #unregisterMsg()* void
        +sendFrame(params)* void
        +sendReconnect(roomId, frameIndex)* void
        #onDelayDetected(intervalMs) void
    }

    MngBaseFrameSyncProtocol --> IMngFrameSyncLogger : 日志
    MngBaseFrameSyncProtocol --> MngFrameSendParams : 发送参数

    %% ==================== 驱动层 ====================

    class MngBaseFrameSyncDriver~TInfo_TFrameInfos_TFrameData_TSendParams~ {
        <<abstract>>
        #clientSyncManager : MngClientFrameSyncManager
        #config : MngFrameSyncConfig
        #logger : IMngFrameSyncLogger
        -ctrlAddServerFrame : boolean
        -lastContiguousServerFrameIndex : number
        -pendingReconnectFromFrame : number
        +init() void
        +initSyncClient() void
        +setAddServerFrame(value) void
        +setLogger(logger) void
        +addServerFrame(rawMsg, frameIndex, roomId) void
        +addClientFrame(frameIndex, frameInfo) void
        +reconnectGame(roomId, historyFrames) void
        +updateLogicFrame(dt) void
        +updateRenderFrame(dt) void
        +getSyncManager() MngClientFrameSyncManager
        +unInit() void
        #createConfig() MngFrameSyncConfig
        #setupEventListeners()* void
        #setupDataHandler()* void
        #getProtocol()* MngBaseFrameSyncProtocol
        #convertRawMsgToFrameData(rawMsg)* TFrameData
    }

    MngBaseFrameSyncDriver *-- MngClientFrameSyncManager : 组合
    MngBaseFrameSyncDriver --> MngBaseFrameSyncProtocol : 依赖（缺帧重连）
    MngBaseFrameSyncDriver --> MngFrameSyncConfig : 创建
    MngBaseFrameSyncDriver --> IMngFrameSyncLogger : 日志
```

### 1.2 数据模型继承关系（泛型展开）

```mermaid
classDiagram
    direction LR

    class MngBasePlayerInfo {
        <<interface>>
        +roleId? : Int64
        +name? : string
        +head? : string
    }

    class MngBaseFrameInfo {
        +clientVerify? : number
        +seqId? : number
        +x? : number
        +y? : number
        +direction? : number
    }

    class MngBaseFrameInfos~TInfo~ {
        +simpleInfo? : MngBasePlayerInfo
        +infos? : TInfo[]
    }

    class MngBaseFrameData~TFrameInfos~ {
        +roomId? : number
        +frameIndex : number
        +frames? : TFrameInfos[]
    }

    class MngFrameSendParams {
        <<interface>>
        +roomId : number
        +frameIndex : number
        +x : number
        +y : number
        +direction : number
        +seqId? : number
    }

    %% 玩法扩展示例（color_game）
    class GamePlayerInfo {
        <<玩法扩展>>
        +campId? : number
    }
    class GameFrameInfo {
        <<玩法扩展>>
        +itemId? : number
        +bagId? : number
    }
    class GameFrameInfos {
        <<玩法扩展>>
        +campId? : number
        +itemIds? : number[]
    }
    class GameFrameData {
        <<玩法扩展>>
        +mapGift? : number[]
    }
    class GameSendParams {
        <<玩法扩展>>
        +giftId : number
        +bagIndex : number
    }

    MngBasePlayerInfo <|-- GamePlayerInfo : 继承扩展
    MngBaseFrameInfo <|-- GameFrameInfo : 继承扩展
    MngBaseFrameInfos <|-- GameFrameInfos : 继承扩展
    MngBaseFrameData <|-- GameFrameData : 继承扩展
    MngFrameSendParams <|-- GameSendParams : 继承扩展
```

### 1.3 抽象基类与子类继承关系

```mermaid
classDiagram
    direction TB

    class MngBaseFrameSyncProtocol~TSend_TInfos_TData~ {
        <<abstract 协议层>>
        #registerMsg()*
        #unregisterMsg()*
        +sendFrame(params)*
        +sendReconnect(roomId, frameIndex)*
        #onDelayDetected(intervalMs)
        +onFrameReceived : callback
        +onReconnectReceived : callback
    }

    class MngBaseFrameSyncDriver~TInfo_TInfos_TData_TSend~ {
        <<abstract 驱动层>>
        #setupEventListeners()*
        #setupDataHandler()*
        #getProtocol()*
        #convertRawMsgToFrameData(rawMsg)*
        #createConfig()
    }

    class MngClientFrameSyncManager~TInfo_TInfos_TData~ {
        <<核心控制器>>
    }

    class GameProtocol {
        <<玩法实现>>
        #registerMsg()
        #unregisterMsg()
        +sendFrame(params)
        +sendReconnect(roomId, frameIndex)
    }

    class GameDriver {
        <<玩法实现>>
        #setupEventListeners()
        #setupDataHandler()
        #getProtocol()
        #convertRawMsgToFrameData(rawMsg)
    }

    MngBaseFrameSyncProtocol <|-- GameProtocol : 继承实现
    MngBaseFrameSyncDriver <|-- GameDriver : 继承实现
    MngBaseFrameSyncDriver *-- MngClientFrameSyncManager : 组合
    MngBaseFrameSyncDriver ..> MngBaseFrameSyncProtocol : 依赖
    GameDriver ..> GameProtocol : 依赖
```

### 1.4 核心控制器内部组合关系

```mermaid
classDiagram
    direction LR

    class MngClientFrameSyncManager {
        -frameBuffer
        -predictor
        -corrector
        -dataHandler
        -eventCallbacks
    }

    class MngFrameBuffer {
        -buffer : Map
        +addClientFrame()
        +addServerFrame()
        +getClientFrame()
        +getServerFrame()
        +checkLostFrames()
        +cleanup()
    }

    class MngFramePredictor {
        +predictNextFrame()
        +predictFrames()
        -predictValue()
    }

    class MngFrameCorrector {
        +normalizeDirection()
        +getPlayerKey()
        +correctFrame()
        +rollbackAndReapply()
    }

    class IMngFrameDataHandler {
        <<interface>>
        +onClientFrame()
        +onServerFrame()
        +onServerFrameBatch()
    }

    class MngFrameBufferItem {
        <<interface>>
        +frameIndex
        +clientFrame
        +serverFrame
        +confirmed
        +timestamp
    }

    MngClientFrameSyncManager *-- MngFrameBuffer
    MngClientFrameSyncManager *-- MngFramePredictor
    MngClientFrameSyncManager *-- MngFrameCorrector
    MngClientFrameSyncManager o-- IMngFrameDataHandler : 回调接口
    MngFrameBuffer *-- MngFrameBufferItem : 存储
    MngFramePredictor ..> MngFrameBuffer : 读取
    MngFrameCorrector ..> MngFrameBuffer : 读写
```

---

## 二、时序图

### 2.1 正常帧同步 — 服务器帧处理全流程

```mermaid
sequenceDiagram
    participant Server as 服务器
    participant MsgMgr as MsgMgr 消息分发
    participant Protocol as Protocol 协议层
    participant Driver as Driver 驱动层
    participant SyncMgr as SyncManager 核心控制器
    participant Buffer as FrameBuffer 帧缓冲区
    participant Corrector as Corrector 帧矫正器
    participant Handler as DataHandler 数据处理器
    participant Logic as 游戏逻辑层

    Server ->> MsgMgr: TCP 帧数据包
    MsgMgr ->> Protocol: revServerFrameMsg(msgBuffer)
    Protocol ->> Protocol: 解析 Thrift/Protobuf 消息
    Protocol ->> Protocol: 坐标还原（÷10000）
    Protocol ->> Driver: onFrameReceived(frameData)

    Driver ->> Driver: 缺帧检测(frameIndex vs expectedNext)

    alt 帧号连续（无缺口）
        Driver ->> Driver: convertRawMsgToFrameData(rawMsg)
        Driver ->> SyncMgr: addServerFrame(frameData)

        SyncMgr ->> SyncMgr: 1. alignClientFrameToServer()
        Note over SyncMgr: 首次对齐 / 强制对齐（差距>20）

        SyncMgr ->> SyncMgr: 2. processServerFrameData()
        SyncMgr ->> Buffer: addServerFrame(frameIndex, frameInfos)
        SyncMgr ->> Corrector: correctFrame(frameIndex, serverFrame)

        alt 偏差 > threshold
            Corrector ->> Corrector: applyCorrection()
            Corrector -->> SyncMgr: return true (已矫正)
            SyncMgr ->> SyncMgr: emit(FRAME_CORRECT)
        else 偏差 ≤ threshold
            Corrector -->> SyncMgr: return false (无需矫正)
        end

        SyncMgr ->> Handler: onServerFrame(frameData)
        Handler ->> Logic: 派发帧数据 → 更新游戏状态

        SyncMgr ->> SyncMgr: 3. serverFrame = max(serverFrame, index)
        SyncMgr ->> SyncMgr: 4. syncClientFrameWithServer() 追帧计算
        SyncMgr ->> SyncMgr: 5. updateNetworkStats()

    else 帧号有缺口
        Driver ->> Protocol: sendReconnect(roomId, missingStart)
        Protocol ->> Server: 发送重连补帧请求
    end
```

### 2.2 客户端帧处理 — 本地操作发送流程

```mermaid
sequenceDiagram
    participant Player as 玩家操作
    participant Scene as 游戏场景
    participant Driver as Driver 驱动层
    participant Protocol as Protocol 协议层
    participant SyncMgr as SyncManager 核心控制器
    participant Buffer as FrameBuffer 帧缓冲区
    participant Predictor as Predictor 帧预测器
    participant Server as 服务器

    Player ->> Scene: 摇杆移动 / 技能 / 拾取
    Scene ->> Driver: addClientFrame(frameIndex, frameInfo)
    Scene ->> Protocol: sendFrame(params)
    Protocol ->> Protocol: 坐标精度处理（×10000）
    Protocol ->> Server: MsgMgr.sendMsg(CgXxxFrame)

    Driver ->> SyncMgr: addClientFrame(frameIndex, frameInfo)
    SyncMgr ->> SyncMgr: alignedIndex = frameIndex + serverFrameDelay
    SyncMgr ->> Buffer: addClientFrame(alignedIndex, frameInfo)

    alt 启用本地预测
        SyncMgr ->> Predictor: predictNextFrame(alignedIndex, localPlayerData)
        Predictor ->> Buffer: getClientFrame(currentFrame)
        Predictor ->> Buffer: getClientFrame(currentFrame - 1)
        Predictor ->> Predictor: 线性插值预测
        Predictor -->> SyncMgr: predictFrame
        SyncMgr ->> Buffer: addClientFrame(alignedIndex + 1, predictFrame)
        SyncMgr ->> SyncMgr: emit(FRAME_PREDICT)
    end
```

### 2.3 主循环帧驱动 — 逻辑帧推进与追帧

```mermaid
sequenceDiagram
    participant Scene as Scene.update(dt)
    participant Driver as Driver 驱动层
    participant SyncMgr as SyncManager 核心控制器
    participant Buffer as FrameBuffer 帧缓冲区
    participant Handler as DataHandler 数据处理器
    participant Logic as 游戏逻辑层

    Scene ->> Driver: updateLogicFrame(dt)
    Driver ->> SyncMgr: updateLogicFrame(dt)

    SyncMgr ->> SyncMgr: logicFrameTime += dt × 1000000（微秒）

    loop 当 logicFrameTime ≥ logicFrameInterval
        SyncMgr ->> SyncMgr: logicFrameTime -= interval
        SyncMgr ->> SyncMgr: advanceLogicFrameOnce()
        SyncMgr ->> SyncMgr: currentLogicFrame++

        SyncMgr ->> Buffer: cleanup(过期帧)
        SyncMgr ->> Buffer: checkLostFrames(currentLogicFrame)

        alt 有丢帧
            SyncMgr ->> SyncMgr: emit(FRAME_LOST)
        end

        SyncMgr ->> Buffer: getClientFrame(currentLogicFrame)

        alt 有客户端帧数据
            SyncMgr ->> Handler: onClientFrame(frameData)
        end

        SyncMgr ->> SyncMgr: emit(FRAME_UPDATE, type="logic")
    end

    Note over SyncMgr: === 追帧策略 ===
    SyncMgr ->> SyncMgr: expectedLogic = serverFrame - delay

    alt diff 1~10（小落后）
        loop 最多补跑 2 帧
            SyncMgr ->> SyncMgr: advanceLogicFrameOnce()
        end
    else diff 11~20（中等落后，有欠账）
        loop 最多补跑 6 帧（消耗欠账）
            SyncMgr ->> SyncMgr: advanceLogicFrameOnce()
            SyncMgr ->> SyncMgr: catchUpDebt--
        end
    end

    Scene ->> Driver: updateRenderFrame(dt)
    Driver ->> SyncMgr: updateRenderFrame(dt)
    SyncMgr ->> SyncMgr: renderFrameTime += dt × 1000000

    loop 当 renderFrameTime ≥ renderFrameInterval
        SyncMgr ->> SyncMgr: currentRenderFrame++
        SyncMgr ->> SyncMgr: targetLogicFrame = renderFrame × (logicRate / renderRate)
        SyncMgr ->> SyncMgr: emit(FRAME_UPDATE, type="render")
    end
```

### 2.4 断线重连 — 完整时序

```mermaid
sequenceDiagram
    participant Server as 服务器
    participant Protocol as Protocol 协议层
    participant Driver as Driver 驱动层
    participant SyncMgr as SyncManager 核心控制器
    participant Buffer as FrameBuffer 帧缓冲区
    participant Handler as DataHandler 数据处理器
    participant Logic as 游戏逻辑层

    Note over Server, Logic: === 网络断开，帧丢失 ===
    Note over Driver: lastContiguous = 499

    Server ->> Protocol: 帧 #600（跳过 500~599）
    Protocol ->> Driver: addServerFrame(msg, 600, roomId)
    Driver ->> Driver: expectedNext = 500, incoming = 600
    Driver ->> Driver: 检测到缺口！

    Driver ->> Protocol: sendReconnect(roomId, 500)
    Protocol ->> Server: 发送补帧请求（从 #500 开始）

    Note over Server, Logic: === 等待重连响应（期间帧被忽略）===

    Server ->> Protocol: 重连响应（含 #500 ~ #610）
    Protocol ->> Driver: onReconnectReceived(roomId, roomInfo)
    Driver ->> Driver: reconnectGame(roomId, historyFrames)

    Driver ->> SyncMgr: beginServerFrameReplayBatch()
    SyncMgr ->> SyncMgr: isServerFrameBatching = true
    SyncMgr ->> SyncMgr: serverFrameBatchMode = "replay"

    loop 遍历历史帧 #500 ~ #610
        Driver ->> SyncMgr: addServerFrame(frameData)
        SyncMgr ->> Buffer: addServerFrame(frameIndex, frameInfos)
        SyncMgr ->> SyncMgr: correctFrame() 矫正
        SyncMgr ->> SyncMgr: pendingServerFrameDataMap.set(index, data)
        Note right of SyncMgr: 批处理期间不立即派发 onServerFrame
    end

    Driver ->> Driver: lastContiguous = 610
    Driver ->> Driver: pendingReconnect = null

    Driver ->> SyncMgr: endServerFrameBatch(flush=true)
    SyncMgr ->> SyncMgr: 按 frameIndex 排序历史帧
    SyncMgr ->> Handler: onServerFrameBatch([#500, ..., #610])
    Handler ->> Logic: 批量处理追帧数据

    Note over Server, Logic: === 恢复正常 ===
    Server ->> Protocol: 帧 #611
    Protocol ->> Driver: addServerFrame(msg, 611, roomId)
    Driver ->> Driver: expectedNext = 611 ✓ 正常处理
    Driver ->> SyncMgr: addServerFrame(frameData)
```

### 2.5 帧矫正 — 服务器权威矫正流程

```mermaid
sequenceDiagram
    participant SyncMgr as SyncManager
    participant Corrector as Corrector 帧矫正器
    participant Buffer as FrameBuffer

    SyncMgr ->> Corrector: correctFrame(frameIndex, serverFrame)

    Corrector ->> Buffer: getClientFrame(frameIndex)
    Corrector ->> Corrector: ridStr = getPlayerKey(serverFrame)

    alt 客户端帧不存在
        Corrector ->> Corrector: createFrameFromServer()
        Note over Corrector: 用服务器数据创建新帧<br/>标记 clientVerify = NORMAL<br/>normalizeDirection() 处理角度
        Corrector ->> Buffer: addClientFrame(frameIndex, newFrame)
        Corrector -->> SyncMgr: return true（产生矫正）

    else 客户端帧存在
        Corrector ->> Corrector: mergeServerFrame()

        loop 遍历 serverFrame.infos
            Corrector ->> Corrector: 查找匹配的 clientInfo（by __rid）

            alt 找到匹配玩家
                Corrector ->> Corrector: distance = √((cx-sx)² + (cy-sy)²)

                alt distance > correctionThreshold
                    Corrector ->> Corrector: applyCorrection()
                    Note over Corrector: clientVerify = LOCAL_CORRECTION<br/>覆写 x, y, direction
                else distance ≤ threshold
                    Corrector ->> Corrector: clientVerify = NORMAL
                end

            else 未找到匹配玩家
                Note over Corrector: 追加新 info 条目<br/>clientVerify = NORMAL
            end
        end

        Corrector -->> SyncMgr: return needCorrection
    end
```

### 2.6 完整生命周期 — 进房到离房

```mermaid
sequenceDiagram
    participant Game as 游戏主类
    participant Driver as Driver 驱动层
    participant Protocol as Protocol 协议层
    participant SyncMgr as SyncManager
    participant Scene as 游戏场景 update()

    Note over Game, Scene: === 进入房间 ===

    Game ->> Driver: init()
    Note over Driver: 创建 SyncManager<br/>绑定事件监听<br/>设置数据处理器

    Game ->> Protocol: init()
    Note over Protocol: 注册 MsgMgr 消息

    Game ->> Driver: initSyncClient()
    Driver ->> SyncMgr: init()
    Note over SyncMgr: 状态 → RUNNING

    Game ->> Driver: setAddServerFrame(false)
    Note over Driver: 允许接入服务器帧

    Note over Game, Scene: === 游戏进行中 ===

    loop 每帧
        Scene ->> Driver: updateLogicFrame(dt)
        Scene ->> Driver: updateRenderFrame(dt)
    end

    Note over Game, Scene: === 玩家操作 ===
    Game ->> Driver: addClientFrame(frameIndex, info)
    Game ->> Protocol: sendFrame(params)

    Note over Game, Scene: === 收到服务器帧 ===
    Protocol ->> Driver: addServerFrame(...)
    Driver ->> SyncMgr: addServerFrame(frameData)

    Note over Game, Scene: === 游戏结束 / 离开房间 ===

    Game ->> Driver: setAddServerFrame(true)
    Note over Driver: 禁止继续接入

    Game ->> Driver: unInit()
    Driver ->> SyncMgr: destroy()
    Note over SyncMgr: 状态 → UNINITIALIZED<br/>清空缓冲区、事件、处理器

    Game ->> Protocol: unInit()
    Note over Protocol: 注销 MsgMgr 消息
```

---

## 三、状态机

### 3.1 SyncManager 状态转换

```mermaid
stateDiagram-v2
    [*] --> UNINITIALIZED : 构造

    UNINITIALIZED --> RUNNING : init()
    RUNNING --> PAUSED : pause()
    PAUSED --> RUNNING : resume()
    RUNNING --> UNINITIALIZED : stop() / destroy()
    PAUSED --> UNINITIALIZED : stop() / destroy()

    UNINITIALIZED --> [*] : destroy()

    note right of RUNNING
        可执行：
        · updateLogicFrame()
        · updateRenderFrame()
        · addClientFrame()
        · addServerFrame()
    end note

    note right of PAUSED
        暂停帧推进
        恢复时重置时间累积器
    end note

    note right of UNINITIALIZED
        所有计数/缓冲区已重置
        需重新 init() 才能运行
    end note
```

### 3.2 追帧策略状态

```mermaid
stateDiagram-v2
    [*] --> 同步 : diff ≤ 0

    同步 --> 小落后 : diff 1~10
    小落后 --> 同步 : 追上
    小落后 --> 小落后 : 每tick补跑≤2帧

    小落后 --> 中等落后 : diff 11~20
    中等落后 --> 中等落后 : 每tick补跑≤6帧(消耗欠账)
    中等落后 --> 小落后 : 追到diff≤10
    中等落后 --> 同步 : 追上

    中等落后 --> 大落后 : diff > 20
    大落后 --> 同步 : 硬同步跳帧(alignClientFrameToServer)

    同步 --> 大落后 : diff > 20

    note right of 小落后
        MAX_CATCH_UP = 2帧/tick
        每次 addServerFrame 计算 diff
    end note

    note right of 中等落后
        MAX_FAST_CATCH_UP = 6帧/tick
        catchUpDebt = min(20, diff)
    end note

    note right of 大落后
        直接 syncFramesToLogicFrame()
        重置时间累积器
    end note
```
