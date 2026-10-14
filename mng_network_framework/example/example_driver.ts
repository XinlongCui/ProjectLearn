/* [学习注释]
 * 【本文件职责】演示协议、通用Manager与玩法回调之间的连接。
 * 继承关系提供统一骨架，子类负责配置、事件、数据处理器和操作发送便捷方法。
 * 这是教学示例，存在原样保留的接入注意点：onFrameReceived已经拿到FrameData时，convertRawMsgToFrameData又按原始players格式解析，会丢失frames；实际接入需避免二次解析。
 * 所有原语句保持不变，学习注释指出实际行为而不把它当成可直接投产的完整实现。
 * [/学习注释]
 */
/**
 * 【接入示例】抢宝小游戏 - 驱动层实现
 *
 * 演示如何继承 MngBaseFrameSyncDriver，实现：
 *  1. createConfig —— 提供玩法专属配置
 *  2. setupEventListeners —— 绑定帧更新事件到游戏事件系统
 *  3. setupDataHandler —— 设置数据处理器，将帧数据派发到游戏逻辑层
 *  4. getProtocol / convertRawMsgToFrameData —— 协议桥接
 *  5. 连接协议层回调
 *  6. 矫正器钩子配置
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
} from "./example_types";
import { ExampleFrameSyncProtocol } from "./example_protocol";

/**
 * 抢宝小游戏 - 帧同步驱动层
 * 作为协议层与帧同步核心之间的桥梁，管理完整生命周期
 */
/* [学习注释]
 * 把四层泛型绑定到同一个玩法，Manager的数据回调与Protocol的发送参数因而获得具体类型。
 * [/学习注释]
 */
export class ExampleFrameSyncDriver extends MngBaseFrameSyncDriver<
    ExampleFrameInfo,
    ExampleFrameInfos,
    ExampleFrameData,
    ExampleFrameSendParams
> {
    private protocol: ExampleFrameSyncProtocol;
    /** 游戏逻辑层回调（由外部注入） */
    /* [学习注释]
     * 外部提供真正的业务处理函数；Driver自己不实现角色移动、技能等。
     * [/学习注释]
     */
    private gameLogicCallback: ((frameData: ExampleFrameData) => void) | null = null;
    /** 重连回调 */
    /* [学习注释]
     * 外部负责解释快照和恢复顺序，这里只转交房间信息。
     * [/学习注释]
     */
    private reconnectCallback: ((roomId: number, roomInfo: any) => void) | null = null;

    /* [学习注释]
     * 构造函数注入Protocol，便于将网络细节与通用帧管理分开；此时还未创建Manager。
     * [/学习注释]
     */
    constructor(protocol: ExampleFrameSyncProtocol) {
        super();
        this.protocol = protocol;
    }

    // ============ 必须实现：提供帧同步配置 ============

    /* [学习注释]
     * 同时设置帧率和对应间隔，避免只改rate导致实际推进速度不变。此示例关闭预测、开启校正。
     * [/学习注释]
     */
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

    /* [学习注释]
     * 注册日志观察者，不会自动推进游戏。FRAME_UPDATE启动通知无type，下面logic/render判断会跳过它。
     * [/学习注释]
     */
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

    /* [学习注释]
     * 业务数据出口：本地帧仅打日志，服务器帧转交gameLogicCallback，批次按顺序逐个调用业务。
     * [/学习注释]
     */
    protected setupDataHandler(): void {
        const handler: IMngFrameDataHandler<ExampleFrameData> = {
            /* [学习注释]
             * 原注释中“立即更新”只是可能的业务用途。实际调用时机是Manager推进到对应缓存key，不是在addClientFrame时。
             * [/学习注释]
             */
            onClientFrame: (frameData: ExampleFrameData) => {
                // 客户端帧 —— 本地操作已存入缓冲区后回调
                // 通常用于立即更新本地表现（不等服务器确认）
                this.logger.isDebugEnabled() &&
                    this.logger.log(`[ExampleDriver] onClientFrame: frame=${frameData.frameIndex}`);
            },

            /* [学习注释]
             * 普通服务器包立即转交外部。外部若也从logic事件推进同一份状态，要设计好职责避免重复执行。
             * [/学习注释]
             */
            onServerFrame: (frameData: ExampleFrameData) => {
                // 服务器帧 —— 核心回调，将帧数据派发到游戏逻辑层
                this.gameLogicCallback?.(frameData);
            },

            /* [学习注释]
             * 这个实现确实逐帧交给业务，保留历史顺序；没有自动跳过动画、抑制奖励或合并表现。
             * [/学习注释]
             */
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

    /* [学习注释]
     * 返回构造时注入的Protocol，用于普通发送和缺帧恢复请求。
     * [/学习注释]
     */
    protected getProtocol(): MngBaseFrameSyncProtocol<ExampleFrameSendParams, ExampleFrameInfos, ExampleFrameData> {
        return this.protocol;
    }

    /* [学习注释]
     * 【示例缺口】直接调用parseFrameData，但下面onFrameReceived传入的是ExampleFrameData。
     * parseFrameData读players/actions而不是frames/infos；两边数据契约不匹配，实际接入应只转换一次。
     * [/学习注释]
     */
    protected convertRawMsgToFrameData(rawMsg: any): ExampleFrameData {
        return this.protocol.parseFrameData(rawMsg);
    }

    // ============ 初始化增强：连接协议层回调 + 矫正器钩子 ============

    /* [学习注释]
     * 先super.init创建Manager并注册处理器，再绑定Protocol回调与校正钩子；仍需initSyncClient启动Manager。
     * [/学习注释]
     */
    public init(): void {
        super.init();

        // 连接协议层 -> 驱动层的回调管道
        /* [学习注释]
         * 收到通用帧后进入基类连续性检查；后续还会进入convertRawMsgToFrameData，需留意上面的二次解析问题。
         * [/学习注释]
         */
        this.protocol.onFrameReceived = (frameData: ExampleFrameData) => {
            this.addServerFrame(frameData, frameData.frameIndex, frameData.roomId!);
        };

        this.protocol.onReconnectReceived = (roomId: number, roomInfo: any) => {
            this.reconnectCallback?.(roomId, roomInfo);
        };

        // 配置矫正器钩子：角度归一化到 [0, 360)
        /* [学习注释]
         * 示例把角度规范到[0,360)，这是玩法选择，不是通用框架强制单位。
         * [/学习注释]
         */
        this.clientSyncManager.getCorrector().normalizeDirection = (angle: number) => ((angle % 360) + 360) % 360;

        // 配置矫正器钩子：自定义玩家标识提取
        this.clientSyncManager.getCorrector().getPlayerKey = (frameInfos: ExampleFrameInfos) =>
            frameInfos.simpleInfo?.roleId?.toString?.() ?? "";
    }

    // ============ 外部注入回调 ============

    /** 设置游戏逻辑层回调（收到服务器帧时调用） */
    /* [学习注释]
     * 保存函数引用，在服务器数据或回放到达时调用；不立即执行。
     * [/学习注释]
     */
    public setGameLogicCallback(callback: (frameData: ExampleFrameData) => void): void {
        this.gameLogicCallback = callback;
    }

    /** 设置重连回调 */
    /* [学习注释]
     * 保存快照/重连消费者，恢复场景与历史顺序由该回调实现。
     * [/学习注释]
     */
    public setReconnectCallback(callback: (roomId: number, roomInfo: any) => void): void {
        this.reconnectCallback = callback;
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

    // ============ 生命周期增强 ============

    /* [学习注释]
     * 先解除Protocol回调并注销消息，再清业务回调、调用super.unInit销毁Manager，避免离场后继续访问旧对象。
     * [/学习注释]
     */
    public unInit(): void {
        this.protocol.onFrameReceived = null;
        this.protocol.onReconnectReceived = null;
        this.protocol.unInit();
        this.gameLogicCallback = null;
        this.reconnectCallback = null;
        super.unInit();
    }
}
