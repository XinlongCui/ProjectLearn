/**
 * 【接入示例】抢宝小游戏 - 驱动层实现
 */

import { MngBaseFrameSyncDriver } from "../mng_base_frame_sync_driver";
import { MngFrameSyncConfig, MNG_DEFAULT_FRAME_SYNC_CONFIG } from "../mng_frame_sync_config";
import { MngFrameSyncEventType, IMngFrameDataHandler } from "../mng_frame_sync_types";
import { MngBaseFrameSyncProtocol } from "../mng_base_frame_sync_protocol";
import {
    ExampleFrameInfo,
    ExampleFrameInfos,
    ExampleFrameData,
    ExampleFrameSendParams,
    ExampleActionType,
} from "./example_data";
import { ExampleFrameSyncProtocol } from "./example_protocol";

export class ExampleFrameSyncDriver extends MngBaseFrameSyncDriver<
    ExampleFrameInfo,
    ExampleFrameInfos,
    ExampleFrameData,
    ExampleFrameSendParams
> {
    private protocol: ExampleFrameSyncProtocol;

    /** 【NEW】游戏逻辑层回调（由外部注入），包在DataHandler中给Manager用（逻辑层->Dirver->Manager）*/         //【！！设置路径与调用路径不同！！】
    /** 外部提供真正的业务处理函数；Driver自己不实现角色移动、技能等。 */
    private gameLogicCallback: ((frameData: ExampleFrameData) => void) | null = null;
    public setGameLogicCallback(callback: (frameData: ExampleFrameData) => void): void {
        this.gameLogicCallback = callback;
    }

    /** 【NEW】重连回调。 */
    /** 外部负责解释快照和恢复顺序，这里只转交房间信息。(其他->Driver->Protocol) */
    private reconnectCallback: ((roomId: number, roomInfo: any) => void) | null = null;
    public setReconnectCallback(callback: (roomId: number, roomInfo: any) => void): void {
        this.reconnectCallback = callback;
    }

    /** 构造函数注入Protocol，便于将网络细节与通用帧管理分开。 */
    constructor(protocol: ExampleFrameSyncProtocol) {
        super();
        this.protocol = protocol;
    }

    // ============ 必须实现：提供帧同步配置 ============

    /** 同时设置帧率和对应间隔，避免只改rate导致实际推进速度不变。此示例关闭预测、开启校正。 */
    protected createConfig(): MngFrameSyncConfig {
        return {
            ...MNG_DEFAULT_FRAME_SYNC_CONFIG,
            logicFrameRate: 15,
            renderFrameRate: 60,
            serverFrameDelay: 5,
            maxFrameCache: 600,
            enableLocalPredict: false,
            enableServerCorrection: true,
            logicFrameInterval: 1 / 15,
            renderFrameInterval: 1 / 60,
        };
    }

    // ============ 必须实现：绑定帧更新事件 ============

    /** 监听不同MngFrameSyncEventTyp.** 事件，并根据事件类型执行不同的逻辑。 */
    protected setupEventListeners(): void {
        this.clientSyncManager.on(MngFrameSyncEventType.FRAME_UPDATE, (data) => {
            // 逻辑帧更新 —— 驱动游戏主逻辑（移动、碰撞检测等）
            if (data.type === "logic") {
                this.logger.isDebugEnabled() &&
                    this.logger.log(`[ExampleDriver] 逻辑帧更新: frame=${data.frame}`);
            }
            // 渲染帧更新 —— 驱动插值渲染
            if (data.type === "render") {
                this.logger.isDebugEnabled() &&
                    this.logger.log(`[ExampleDriver] 渲染帧更新: frame=${data.frame}, targetLogic=${data.targetLogicFrame}`);
            }
        });

        this.clientSyncManager.on(MngFrameSyncEventType.FRAME_PREDICT, (data) => {
            this.logger.isDebugEnabled() &&
                this.logger.log(`[ExampleDriver] 帧预测: frame=${data.frame}`);
        });

        this.clientSyncManager.on(MngFrameSyncEventType.FRAME_CORRECT, (data) => {
            this.logger.isDebugEnabled() &&
                this.logger.log(`[ExampleDriver] 帧矫正: frame=${data.frame}`);
        });

        this.clientSyncManager.on(MngFrameSyncEventType.FRAME_LOST, (data) => {
            this.logger.warn(`[ExampleDriver] 帧丢失: count=${data.count}, frames=${data.frames}`);
        });

        this.clientSyncManager.on(MngFrameSyncEventType.FRAME_ERROR, (data) => {
            this.logger.error(`[ExampleDriver] 帧同步错误:`, data);
        });
    }

    // ============ 必须实现：设置数据处理器 ============

    /** 具体可以看 Manager中是如何使用的 */
    protected setupDataHandler(): void {
        const handler: IMngFrameDataHandler<ExampleFrameData> = {

            onClientFrame: (frameData: ExampleFrameData) => {
                // 客户端帧 —— 本地操作已存入缓冲区后回调
                // 通常用于立即更新本地表现（不等服务器确认）
                this.logger.isDebugEnabled() &&
                    this.logger.log(`[ExampleDriver] onClientFrame: frame=${frameData.frameIndex}`);
            },

            onServerFrame: (frameData: ExampleFrameData) => {
                // 服务器帧 —— 核心回调，将帧数据派发到游戏逻辑层
                this.gameLogicCallback?.(frameData);
            },

            onServerFrameBatch: (frames: ExampleFrameData[]) => {
                // 批量服务器帧 —— 重连/进房追帧时调用
                // 可在此做快速回放或直接跳到最新状态
                this.logger.log(`[ExampleDriver] onServerFrameBatch: ${frames.length} 帧`);
                for (const frame of frames) {
                    this.gameLogicCallback?.(frame);
                }
            },
        };

        this.clientSyncManager.setDataHandler(handler);
    }

    // ============ 必须实现：协议桥接 ============

    /** 返回构造时注入的Protocol，用于普通发送和缺帧恢复请求。 */
    protected getProtocol(): MngBaseFrameSyncProtocol<ExampleFrameSendParams, ExampleFrameInfos, ExampleFrameData> {
        return this.protocol;
    }

    /**
     * 直接调用parseFrameData，但下面onFrameReceived传入的是ExampleFrameData。
     * parseFrameData读players/actions而不是frames/infos；两边数据契约不匹配，实际接入应只转换一次。
     */
    protected convertRawMsgToFrameData(rawMsg: any): ExampleFrameData {
        return this.protocol.parseFrameData(rawMsg);
    }

    // ============ 生命周期 ============

    /** 先super.init创建Manager并注册处理器，再绑定Protocol回调与校正钩子；仍需initSyncClient启动Manager。 */
    public init(): void {
        super.init();

        /** 设置协议层回调。 */
        /** 收到通用帧后进入基类连续性检查；后续还会进入convertRawMsgToFrameData，需留意上面的二次解析问题。 */
        this.protocol.onFrameReceived = (frameData: ExampleFrameData) => {//如果这里传入的是协议层转换后的ExampleFrameData，
            this.addServerFrame(frameData, frameData.frameIndex, frameData.roomId!);//那这里不不要再调用转换了！！
        };
        /** 设置协议层回调。 */
        this.protocol.onReconnectReceived = (roomId: number, roomInfo: any) => {
            this.reconnectCallback?.(roomId, roomInfo);
        };

        /** 配置Manager 矫正器钩子：角度归一化到 [0, 360) */
        this.clientSyncManager.getCorrector().normalizeDirection = (angle: number) => ((angle % 360) + 360) % 360;

        /** 配置Manager 矫正器钩子：自定义玩家标识提取 */
        this.clientSyncManager.getCorrector().getPlayerKey = (frameInfos: ExampleFrameInfos) =>
            frameInfos.simpleInfo?.roleId?.toString?.() ?? "";
    }
    
    /** 先解除Protocol回调并注销消息，再清业务回调、调用super.unInit销毁Manager，避免离场后继续访问旧对象。 */
    public unInit(): void {
        this.protocol.onFrameReceived = null;
        this.protocol.onReconnectReceived = null;
        this.protocol.unInit();
        this.gameLogicCallback = null;
        this.reconnectCallback = null;
        super.unInit();
    }

    // ============ 便捷方法：发送玩家操作 ============

    /**
     * 发送移动操作
     * @param roomId 房间id
     * @param x 目标X坐标
     * @param y 目标Y坐标
     * @param direction 朝向
     */
    /* [学习注释]
     * 读取当前逻辑帧→发送操作→写本地缓存。两者是独立调用；缓存入口不会自动发包。
     * 同一逻辑帧多次调用，会多次提交消息，但本地同key缓存后写覆盖前写。
     * [/学习注释]
     */
    public sendMove(roomId: number, x: number, y: number, direction: number): void {
        const frameIndex = this.getCurrentLogicFrame();
        this.protocol.sendFrame({
            roomId,
            frameIndex,
            x,
            y,
            direction,
            actionType: ExampleActionType.MOVE,
        });

        // 同时将客户端帧存入缓冲区（用于预测和矫正对比）
        /* [学习注释]
         * 示例没有填写simpleInfo、seqId、__rid。不能假设这些简化数据能与校正器完整身份匹配。
         * [/学习注释]
         */
        const frameInfos = new ExampleFrameInfos();
        frameInfos.infos = [{
            x, y, direction,
            actionType: ExampleActionType.MOVE,
        } as ExampleFrameInfo];
        this.addClientFrame(frameIndex, frameInfos);
    }

    /**
     * 发送拾取道具操作
     * @param roomId 房间id
     * @param x 当前X坐标
     * @param y 当前Y坐标
     * @param direction 朝向
     * @param itemId 道具id
     */
    /* [学习注释]
     * 只发送拾取参数，当前没有调用addClientFrame，因此不会自动进入本地预测/客户端缓存回调路径。
     * [/学习注释]
     */
    public sendPickItem(roomId: number, x: number, y: number, direction: number, itemId: number): void {
        const frameIndex = this.getCurrentLogicFrame();
        this.protocol.sendFrame({
            roomId,
            frameIndex,
            x,
            y,
            direction,
            actionType: ExampleActionType.PICK_ITEM,
            itemId,
        });
    }

    /**
     * 发送使用技能操作
     * @param roomId 房间id
     * @param x 当前X坐标
     * @param y 当前Y坐标
     * @param direction 朝向
     * @param skillId 技能id
     */
    /* [学习注释]
     * 同样只走上行发送。skillId是业务语义，通用Manager不会执行技能。
     * [/学习注释]
     */
    public sendUseSkill(roomId: number, x: number, y: number, direction: number, skillId: number): void {
        const frameIndex = this.getCurrentLogicFrame();
        this.protocol.sendFrame({
            roomId,
            frameIndex,
            x,
            y,
            direction,
            actionType: ExampleActionType.USE_SKILL,
            skillId,
        });
    }

}
