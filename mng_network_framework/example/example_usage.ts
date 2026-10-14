/* [学习注释]
 * 【本文件职责】展示从进房、启动、update、输入、服务器消费、重连到离场的完整连接顺序。
 * 原文件明确是不可直接运行的伪代码；末尾函数大多为空占位，不能把注释当成已实现功能。
 * 三处特别注意：setAddServerFrame的布尔调用与注释写反；networkLatency本来就是毫秒；重连恢复快照与回放的正确顺序取决于实际协议。
 * 此副本只加注释，所有示例原语句保留，以便对照学习。
 * [/学习注释]
 */
/**
 * 【接入示例】抢宝小游戏 - 完整接入用法
 *
 * 演示帧同步框架的完整生命周期：
 *  1. 创建协议层 & 驱动层实例
 *  2. 初始化（注册消息、创建 SyncManager）
 *  3. 在游戏主循环中驱动逻辑帧/渲染帧
 *  4. 发送本地操作 & 处理服务器帧数据
 *  5. 断线重连处理
 *  6. 游戏结束销毁
 *
 * 本文件为伪代码示例，展示调用流程，不可直接运行
 */

import { IMngFrameSyncLogger } from "../mng_frame_sync_types";
import { ExampleFrameSyncProtocol } from "./example_protocol";
import { ExampleFrameSyncDriver } from "./example_driver";
import { ExampleFrameData, ExampleActionType, ExampleFrameInfo } from "./example_types";

// ============================================================
// 第一步：实现日志适配器（可选，但强烈推荐）
// ============================================================

/** 接入项目日志系统的适配器 */
/* [学习注释]
 * 依赖注入日志适配器。DEBUG_MODEL影响isDebugEnabled，直接调用warn/log本身不会自动受该开关限制。
 * [/学习注释]
 */
const exampleLogger: IMngFrameSyncLogger = {
    isDebugEnabled: () => !!globalThis.DEBUG_MODEL,
    log: (msg, ...args) => console.log(msg, ...args),
    warn: (msg, ...args) => console.warn(msg, ...args),
    error: (msg, ...args) => console.error(msg, ...args),
};

// ============================================================
// 第二步：创建实例（通常在游戏 Manager / Controller 中持有）
// ============================================================

/* [学习注释]
 * 由进房创建、离场清空的协议实例。模块级变量意味着该示例没有设计多个并行房间。
 * [/学习注释]
 */
let protocol: ExampleFrameSyncProtocol;
/* [学习注释]
 * Driver持有Manager并连接Protocol；构造与启动是两个步骤。
 * [/学习注释]
 */
let driver: ExampleFrameSyncDriver;

/**
 * 进入游戏房间时调用
 * @param roomId 房间id
 */
/* [学习注释]
 * 演示初始化生命周期。roomId参数当前没有用于保存真实房间，后面的操作方法仍把房间写死为1。
 * [/学习注释]
 */
function onEnterRoom(roomId: number): void {
    // 1. 创建协议层
    protocol = new ExampleFrameSyncProtocol();
    protocol.setLogger(exampleLogger);
    /* [学习注释]
     * 注册网络监听较早，Driver及其回调尚未准备好；实际接入需保证初始化期间不会丢失首包。
     * [/学习注释]
     */
    protocol.init();

    // 2. 创建驱动层（传入协议层实例）
    driver = new ExampleFrameSyncDriver(protocol);
    driver.setLogger(exampleLogger);

    // 3. 设置游戏逻辑回调 —— 收到服务器帧时更新游戏状态
    driver.setGameLogicCallback((frameData: ExampleFrameData) => {
        onServerFrameUpdate(frameData);
    });

    // 4. 设置重连回调
    driver.setReconnectCallback((reconnRoomId: number, roomInfo: any) => {
        onReconnect(reconnRoomId, roomInfo);
    });

    // 5. 初始化驱动层（内部创建 SyncManager 并绑定事件）
    driver.init();

    // 6. 允许接入服务器帧
    /* [学习注释]
     * 【原示例写反】false实际禁止普通服务器帧接入，因为Driver内部保存!value。要允许应传true。
     * 这里保留原代码，不把注释副本作为已经修复的运行版。
     * [/学习注释]
     */
    driver.setAddServerFrame(false);

    // 7. 启动帧同步（进入 RUNNING 状态）
    /* [学习注释]
     * Manager从UNINITIALIZED变RUNNING。仅driver.init并不启动时间/数据入口。
     * [/学习注释]
     */
    driver.initSyncClient();
}

// ============================================================
// 第三步：游戏主循环驱动帧更新
// ============================================================

/**
 * 在 Cocos Creator 的 update 回调中调用
 * @param dt 帧间隔（秒）
 */
/* [学习注释]
 * 将Cocos每帧dt同时交给两个独立累加器。逻辑每约66.666ms、渲染每约16.666ms产生节拍。
 * 一次update可推进多步；这不是每步直接绘制屏幕，也不自动发送操作。
 * [/学习注释]
 */
function onGameUpdate(dt: number): void {
    if (!driver) {
        return;
    }

    // 驱动逻辑帧（按配置的 logicFrameRate 推进）
    driver.updateLogicFrame(dt);

    // 驱动渲染帧（按配置的 renderFrameRate 推进）
    driver.updateRenderFrame(dt);
}

// ============================================================
// 第四步：发送本地玩家操作
// ============================================================

/** 摇杆移动 */
/* [学习注释]
 * 输入事件直接调用sendMove；示例没有固定间隔节流，所以发送次数取决于事件触发次数。
 * [/学习注释]
 */
function onJoystickMove(x: number, y: number, direction: number): void {
    const roomId = 1; // 从房间数据获取
    driver.sendMove(roomId, x, y, direction);
}

/** 点击拾取道具 */
/* [学习注释]
 * 一次点击提交拾取参数，具体技能/拾取是否有效由玩法和服务端规则决定。
 * [/学习注释]
 */
function onClickPickItem(itemId: number, playerX: number, playerY: number, direction: number): void {
    const roomId = 1;
    driver.sendPickItem(roomId, playerX, playerY, direction, itemId);
}

/** 使用技能 */
/* [学习注释]
 * 发送技能操作，不在此推进逻辑时钟。
 * [/学习注释]
 */
function onClickUseSkill(skillId: number, playerX: number, playerY: number, direction: number): void {
    const roomId = 1;
    driver.sendUseSkill(roomId, playerX, playerY, direction, skillId);
}

// ============================================================
// 第五步：处理服务器帧数据（核心游戏逻辑）
// ============================================================

/**
 * 服务器帧到达后的处理逻辑
 * 此回调由 driver.setGameLogicCallback 注入
 */
/* [学习注释]
 * 正常服务器包或历史回放都会进入这个业务消费者；真实实现需要区分回放时哪些表现可省略。
 * [/学习注释]
 */
function onServerFrameUpdate(frameData: ExampleFrameData): void {
    // 更新游戏倒计时
    /* [学习注释]
     * 使用undefined判断能保留0这个有效值：倒计时归零仍需要更新。
     * [/学习注释]
     */
    if (frameData.remainTime !== undefined) {
        updateCountdown(frameData.remainTime);
    }

    // 处理场景道具刷新
    if (frameData.spawnedItems?.length) {
        for (const item of frameData.spawnedItems) {
            spawnItemInScene(item.itemUid, item.itemCfgId, item.x, item.y);
        }
    }

    // 处理各玩家帧数据
    /* [学习注释]
     * 先遍历同一帧的各玩家，再遍历每个玩家的操作；这不是每个玩家都占一个新时间帧。
     * [/学习注释]
     */
    for (const playerFrameInfos of frameData.frames || []) {
        const roleId = playerFrameInfos.simpleInfo?.roleId;
        if (!roleId) {
            continue;
        }

        for (const info of playerFrameInfos.infos || []) {
            /* [学习注释]
             * 业务根据操作类型调用不同功能。非空断言!只是绕过TS检查，不会在运行时补齐缺失坐标或技能ID。
             * [/学习注释]
             */
            switch (info.actionType) {
                case ExampleActionType.MOVE:
                    movePlayer(roleId, info.x!, info.y!, info.direction!, info.speed);
                    break;
                case ExampleActionType.PICK_ITEM:
                    playerPickItem(roleId, info.itemId!);
                    break;
                case ExampleActionType.USE_SKILL:
                    playerUseSkill(roleId, info.skillId!);
                    break;
                case ExampleActionType.THROW_ITEM:
                    playerThrowItem(roleId, info.itemId!, info.targetRoleId!);
                    break;
            }
        }
    }
}

// ============================================================
// 第六步：断线重连处理
// ============================================================

/**
 * 重连回调
 * 驱动层的缺帧检测会自动发送重连请求，此处处理重连响应
 */
/* [学习注释]
 * 从roomInfo取历史帧交给Driver.reconnectGame。注意这里先回放后restoreGameScene是示例顺序。
 * 真实快照协议若要求先恢复快照再应用增量，应按协议执行，否则恢复场景可能覆盖已回放结果。
 * [/学习注释]
 */
function onReconnect(roomId: number, roomInfo: any): void {
    // 从 roomInfo 中提取历史帧数据
    const historyFrames: ExampleFrameData[] = roomInfo.historyFrames || [];

    // 交给驱动层批量灌入（内部处理追帧回放）
    driver.reconnectGame(roomId, historyFrames);

    // 恢复游戏场景状态（如道具、玩家位置等）
    restoreGameScene(roomInfo);
}

// ============================================================
// 第七步：游戏结束 / 离开房间时销毁
// ============================================================

/* [学习注释]
 * 生命周期收尾：停止接入、销毁Driver和Protocol并清引用。此示例的接收开关语句见下一条批注。
 * [/学习注释]
 */
function onLeaveRoom(): void {
    if (!driver) {
        return;
    }

    // 禁止继续接入服务器帧
    /* [学习注释]
     * 【原示例写反】true实际允许接收；停止普通接入应传false。随后unInit会销毁对象，但不要据此误学开关语义。
     * [/学习注释]
     */
    driver.setAddServerFrame(true);

    // 销毁驱动层（内部销毁 SyncManager、清理事件和缓冲区）
    driver.unInit();

    // 销毁协议层（注销消息）
    /* [学习注释]
     * ExampleDriver.unInit已调用一次protocol.unInit；基类_inited保护使这里第二次调用直接返回。
     * [/学习注释]
     */
    protocol.unInit();

    driver = null!;
    protocol = null!;
}

// ============================================================
// 第八步（可选）：查询帧同步状态（用于调试/UI 显示）
// ============================================================

/* [学习注释]
 * 读取统计不触发重新测量。networkLatency字段本身就是毫秒，下方除1000后仍标ms是不一致的示例展示。
 * [/学习注释]
 */
function getDebugInfo(): string {
    if (!driver) {
        return "未初始化";
    }
    const stats = driver.getSyncManager().getStats();
    return [
        `逻辑帧: ${stats.currentLogicFrame}`,
        `渲染帧: ${stats.currentRenderFrame}`,
        `服务器帧: ${stats.serverFrame}`,
        `预测次数: ${stats.predictFrameCount}`,
        `矫正次数: ${stats.correctFrameCount}`,
        `丢帧次数: ${stats.lostFrameCount}`,
        /* [学习注释]
         * 【单位说明】/1000后是秒，当前字符串却标ms。保留原表达式，仅用于说明错误来源；帧差估计也不等于RTT。
         * [/学习注释]
         */
        `网络延迟: ${(stats.networkLatency / 1000).toFixed(1)}ms`,
    ].join(" | ");
}

// ============================================================
// 以下为游戏逻辑占位函数（各玩法自行实现）
// ============================================================

/* [学习注释]
 * 占位：真实实现负责倒计时UI；该空函数没有实际行为。
 * [/学习注释]
 */
function updateCountdown(remainTime: number): void { /* 更新倒计时UI */ }
/* [学习注释]
 * 占位：真实实现应按itemUid管理实例及资源加载生命周期。
 * [/学习注释]
 */
function spawnItemInScene(itemUid: number, itemCfgId: number, x: number, y: number): void { /* 场景中生成道具 */ }
/* [学习注释]
 * 占位：是否设置目标坐标、立即位移或插值由玩法决定，框架不强制。
 * [/学习注释]
 */
function movePlayer(roleId: Int64, x: number, y: number, direction: number, speed?: number): void { /* 移动玩家角色 */ }
/* [学习注释]
 * 占位：背包与拾取表现属于业务，不能由通用缓存校正自动完成。
 * [/学习注释]
 */
function playerPickItem(roleId: Int64, itemId: number): void { /* 播放拾取动画 & 更新背包 */ }
/* [学习注释]
 * 占位：技能判定/效果和表现需要具体实现。
 * [/学习注释]
 */
function playerUseSkill(roleId: Int64, skillId: number): void { /* 播放技能特效 */ }
/* [学习注释]
 * 占位：目标玩家和道具语义由玩法解释。
 * [/学习注释]
 */
function playerThrowItem(roleId: Int64, itemId: number, targetRoleId: Int64): void { /* 投掷道具逻辑 */ }
/* [学习注释]
 * 占位：快照恢复需要真实对象状态及协议帧号，不能仅靠Manager计数器完成。
 * [/学习注释]
 */
function restoreGameScene(roomInfo: any): void { /* 重连后恢复游戏场景 */ }
