/**
 * 【接入示例】抢宝小游戏 - 协议层实现
 */

import { MngBaseFrameSyncProtocol } from "../mng_base_frame_sync_protocol";
import {
    ExampleFrameInfo,
    ExampleFrameInfos,
    ExampleFrameData,
    ExampleFrameSendParams,
    ExampleActionType,
} from "./example_data";

// ---- 以下为项目已有基础设施的模拟导入，实际接入时替换为真实路径 ----
// import { MsgMgr } from "../../../global/msg_mgr";
// import { MsgType } from "../../../../common/msg_type";


export class ExampleFrameSyncProtocol extends MngBaseFrameSyncProtocol<
    ExampleFrameSendParams,
    ExampleFrameInfos,
    ExampleFrameData
> {
    /** 【NEW】上一次收到服务器帧的时间（用于延迟检测） */
    private lastFrameReceivedTime: number = 0;

    // ============ 必须实现：注册/注销消息 ============
    protected registerMsg(): void {
        // 实际项目中使用 MsgMgr 注册：
        // MsgMgr.regMsgHandler(MsgType.GcExampleFrameSync, this.onServerFrameMsg, this);
        // MsgMgr.regMsgHandler(MsgType.GcExampleReconnect, this.onReconnectMsg, this);

        this.logger.log("[ExampleProtocol] 协议消息已注册");
    }

    protected unregisterMsg(): void {
        // MsgMgr.unregMsgHandler(MsgType.GcExampleFrameSync, this.onServerFrameMsg, this);
        // MsgMgr.unregMsgHandler(MsgType.GcExampleReconnect, this.onReconnectMsg, this);

        this.logger.log("[ExampleProtocol] 协议消息已注销");
    }

    // ============ 必须实现：发送帧数据 && 服务器消息回调（协议层核心职责：解析 -> 递交 ============
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
        // this.onFrameReceived?.(frameData);//调用驱动层设置的回调
    }

    // ============ 必须实现：发送重连请求 ============
    public sendReconnect(roomId: number, frameIndex: number): void {
        // const msg = new sg.CgExampleReconnect();
        // msg.roomId = new Int64(roomId);
        // msg.frameIndex = frameIndex;
        // MsgMgr.sendMsg(msg, MsgType.CgExampleReconnect);

        this.logger.warn(`[ExampleProtocol] sendReconnect: roomId=${roomId}, fromFrame=${frameIndex}`);
    }

    private onReconnectMsg(msgBuffer: any): void {
        // const msg = sg.GcExampleReconnect.decode(msgBuffer);
        // this.onReconnectReceived?.(msg.roomId, msg.roomInfo);//调用驱动层设置的回调
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


    // ============ 协议解析辅助方法（将协议结构转为框架通用结构） ============
    /**
     * 将服务器消息解析为帧数据（示例这里是一帧的所有数据）
     * 这是协议层最关键的转换逻辑，各玩法在此适配自身协议格式
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
