/* [学习注释]
 * 【本文件职责】演示具体Protocol如何实现抽象网络契约。
 * 真实MsgMgr导入、注册、解包和发送代码都被注释；直接调用此示例主要输出日志，不会完成真实通信。
 * 它的parseFrameData接收原始players/actions结构；已转好的frames/infos对象不能再次当原始结构解析。
 * 学习重点：消息注册成对、上行组包、下行解包、通过回调交给Driver；这些与逻辑帧计时是独立职责。
 * [/学习注释]
 */
/**
 * 【接入示例】抢宝小游戏 - 协议层实现
 *
 * 演示如何继承 MngBaseFrameSyncProtocol，实现：
 *  1. registerMsg / unregisterMsg —— 注册/注销网络消息
 *  2. sendFrame —— 将本地操作发送到服务器
 *  3. sendReconnect —— 发送断线重连请求
 *  4. 服务器消息回调 —— 解析协议数据后通过 onFrameReceived 递交驱动层
 *
 * 注意：示例中 MsgMgr / MsgType / sg.xxx 为项目已有的网络基础设施，
 *       各玩法按自身协议替换对应的消息类型和数据结构即可。
 */

import { MngBaseFrameSyncProtocol } from "../mng_base_frame_sync_protocol";
import {
    ExampleFrameInfo,
    ExampleFrameInfos,
    ExampleFrameData,
    ExampleFrameSendParams,
    ExampleActionType,
} from "./example_types";

// ---- 以下为项目已有基础设施的模拟导入，实际接入时替换为真实路径 ----
// import { MsgMgr } from "../../../global/msg_mgr";
// import { MsgType } from "../../../../common/msg_type";

/* [学习注释]
 * 三个泛型绑定示例上行参数、玩家操作组、完整帧包，覆盖基类要求的方法。
 * [/学习注释]
 */
export class ExampleFrameSyncProtocol extends MngBaseFrameSyncProtocol<
    ExampleFrameSendParams,
    ExampleFrameInfos,
    ExampleFrameData
> {
    /** 上一次收到服务器帧的时间（用于延迟检测） */
    /* [学习注释]
     * 上次收帧的本地墙钟毫秒时间，用于相邻包间隔；不是帧号，也不是请求发送时间。
     * [/学习注释]
     */
    private lastFrameReceivedTime: number = 0;

    // ============ 必须实现：注册/注销消息 ============

    /* [学习注释]
     * 展示注册入口；下面MsgMgr语句仍是注释。真实实现需保证注册消息号与解包类型一致。
     * [/学习注释]
     */
    protected registerMsg(): void {
        // 实际项目中使用 MsgMgr 注册：
        // MsgMgr.regMsgHandler(MsgType.GcExampleFrameSync, this.onServerFrameMsg, this);
        // MsgMgr.regMsgHandler(MsgType.GcExampleReconnect, this.onReconnectMsg, this);

        this.logger.log("[ExampleProtocol] 协议消息已注册");
    }

    /* [学习注释]
     * 与registerMsg成对；必须使用同一个方法引用和this绑定。当前同样只有示例日志。
     * [/学习注释]
     */
    protected unregisterMsg(): void {
        // MsgMgr.unregMsgHandler(MsgType.GcExampleFrameSync, this.onServerFrameMsg, this);
        // MsgMgr.unregMsgHandler(MsgType.GcExampleReconnect, this.onReconnectMsg, this);

        this.logger.log("[ExampleProtocol] 协议消息已注销");
    }

    // ============ 必须实现：发送帧数据 ============

    /* [学习注释]
     * 真实用途是组装协议后提交MsgMgr；没有在此等待固定逻辑间隔，也不自行生成frameIndex。
     * 下面发送代码被注释，因此本示例不实际发包。
     * [/学习注释]
     */
    public sendFrame(params: ExampleFrameSendParams): void {
        // 构造协议消息（根据项目的 thrift/protobuf 协议结构）
        // const msg = new sg.CgExampleFrameSync();
        // msg.roomId = new Int64(params.roomId);
        // msg.frameIndex = params.frameIndex;
        // msg.x = params.x;
        // msg.y = params.y;
        // msg.direction = params.direction;
        // msg.seqId = params.seqId;
        // msg.actionType = params.actionType ?? ExampleActionType.MOVE;
        // msg.itemId = params.itemId ?? 0;
        // msg.skillId = params.skillId ?? 0;
        // msg.targetRoleId = params.targetRoleId;
        // MsgMgr.sendMsg(msg, MsgType.CgExampleFrameSync);

        this.logger.isDebugEnabled() &&
            this.logger.log(`[ExampleProtocol] sendFrame: frame=${params.frameIndex}, action=${params.actionType}`);
    }

    // ============ 必须实现：发送重连请求 ============

    /* [学习注释]
     * 展示请求从哪个帧号恢复。真实项目可能请求历史或快照，具体语义由服务端协议决定。
     * [/学习注释]
     */
    public sendReconnect(roomId: number, frameIndex: number): void {
        // const msg = new sg.CgExampleReconnect();
        // msg.roomId = new Int64(roomId);
        // msg.frameIndex = frameIndex;
        // MsgMgr.sendMsg(msg, MsgType.CgExampleReconnect);

        this.logger.warn(`[ExampleProtocol] sendReconnect: roomId=${roomId}, fromFrame=${frameIndex}`);
    }

    // ============ 可选覆盖：延迟检测 ============

    /* [学习注释]
     * 相邻服务器消息间隔超过2000ms才日志提示；并不会暂停、重连或弹UI。间隔不能直接当RTT。
     * [/学习注释]
     */
    protected onDelayDetected(intervalMs: number): void {
        if (intervalMs > 2000) {
            this.logger.warn(`[ExampleProtocol] 检测到高延迟: ${intervalMs}ms，考虑提示玩家网络状况`);
        }
    }

    // ============ 服务器消息回调（协议层核心职责：解析 -> 递交） ============

    /**
     * 收到服务器帧同步消息
     * 协议层负责将原始消息解析为通用 ExampleFrameData，然后通过 onFrameReceived 回调递交驱动层
     */
    /* [学习注释]
     * 先计算收帧间隔，再准备解包和调用onFrameReceived；当前解包/递交仍被注释。
     * 若实现回调，要只解析一次并明确Driver接收的是原始包还是通用对象。
     * [/学习注释]
     */
    private onServerFrameMsg(msgBuffer: any): void {
        // --- 延迟检测 ---
        const now = Date.now();
        if (this.lastFrameReceivedTime > 0) {
            this.onDelayDetected(now - this.lastFrameReceivedTime);
        }
        this.lastFrameReceivedTime = now;

        // --- 解析协议数据（各玩法按自身协议实现） ---
        // const msg = sg.GcExampleFrameSync.decode(msgBuffer);
        // const frameData = this.parseFrameData(msg);
        // this.onFrameReceived?.(frameData);

        // 示例：假设 msg 已解析
        // this.onFrameReceived?.(frameData);
    }

    /**
     * 收到重连响应
     * 将重连数据递交驱动层处理
     */
    /* [学习注释]
     * 原本应解包并交给onReconnectReceived；当前是占位实现。
     * [/学习注释]
     */
    private onReconnectMsg(msgBuffer: any): void {
        // const msg = sg.GcExampleReconnect.decode(msgBuffer);
        // this.onReconnectReceived?.(msg.roomId, msg.roomInfo);
    }

    // ============ 协议解析辅助方法（将协议结构转为框架通用结构） ============

    /**
     * 将服务器消息解析为 ExampleFrameData
     * 这是协议层最关键的转换逻辑，各玩法在此适配自身协议格式
     */
    /* [学习注释]
     * 输入预期含roomId/frameIndex/players，每个player含actions。先建完整帧包，再逐玩家逐操作转换。
     * 当前无空msg保护，且不识别已经解析的ExampleFrameData。
     * [/学习注释]
     */
    public parseFrameData(msg: any): ExampleFrameData {
        const frameData = new ExampleFrameData();
        frameData.roomId = msg.roomId;
        frameData.frameIndex = msg.frameIndex;
        frameData.remainTime = msg.remainTime;
        frameData.spawnedItems = msg.spawnedItems;
        frameData.frames = [];

        /* [学习注释]
         * players缺失就生成空frames。如果把仅有frames的通用对象传进来，就会丢失玩家数据。
         * [/学习注释]
         */
        for (const playerMsg of msg.players || []) {
            const frameInfos = new ExampleFrameInfos();
            frameInfos.simpleInfo = {
                roleId: playerMsg.roleId,
                name: playerMsg.name,
                skinId: playerMsg.skinId,
                level: playerMsg.level,
            };
            frameInfos.infos = [];

            /* [学习注释]
             * 逐条复制基础和玩法字段。这里显式复制了actionType/itemId等，因此能保留；通用预测/校正没有相同复制逻辑。
             * [/学习注释]
             */
            for (const action of playerMsg.actions || []) {
                const info = new ExampleFrameInfo();
                info.seqId = action.seqId;
                info.x = action.x;
                info.y = action.y;
                info.direction = action.direction;
                info.actionType = action.actionType ?? ExampleActionType.MOVE;
                info.itemId = action.itemId;
                info.skillId = action.skillId;
                info.targetRoleId = action.targetRoleId;
                info.speed = action.speed;
                frameInfos.infos.push(info);
            }

            frameData.frames!.push(frameInfos);
        }

        return frameData;
    }
}
