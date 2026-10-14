/* [学习注释]
 * 【本文件职责】连接玩法Protocol和通用Manager，负责正常收帧连续性检查与重连批处理。
 * 调用链：Protocol回调→Driver.addServerFrame→格式转换→Manager.addServerFrame→玩法数据处理器。
 * Driver.init仅创建Manager；initSyncClient才启动Manager。应在放入帧数据前完成两者及回调绑定。
 * 基类没有普通操作的自动发送循环；addClientFrame仅转交缓存，实际sendFrame由玩法调用。
 * [/学习注释]
 */
/**
 * 帧同步框架 - 驱动层抽象基类
 * 作为业务层与帧同步核心逻辑的桥梁：
 *  - 管理 MngClientFrameSyncManager 的生命周期
 *  - 处理协议层递交的服务器帧数据（含缺帧检测与重连请求）
 *  - 将客户端帧数据转发给协议层发送
 *  - 提供重连/追帧回放流程
 *
 * 各游戏继承此类，实现：
 *  - 协议消息到通用 FrameData 的数据转换
 *  - 事件监听绑定（逻辑帧/渲染帧更新等）
 *  - 数据处理器（将帧数据派发到各游戏逻辑层）
 */

import { MngBaseFrameInfo, MngBaseFrameInfos, MngBaseFrameData } from "./mng_base_frame_data";
import { MngFrameSyncConfig, MNG_DEFAULT_FRAME_SYNC_CONFIG } from "./mng_frame_sync_config";
import { IMngFrameSyncLogger, MNG_NULL_LOGGER } from "./mng_frame_sync_types";
import { MngClientFrameSyncManager } from "./mng_client_frame_sync_manager";
import { MngBaseFrameSyncProtocol, MngFrameSendParams } from "./mng_base_frame_sync_protocol";

/* [学习注释]
 * 四个泛型贯通操作、玩家操作组、完整帧包、发送参数；protected成员允许子类访问。
 * [/学习注释]
 */
export abstract class MngBaseFrameSyncDriver<
    TInfo extends MngBaseFrameInfo = MngBaseFrameInfo,
    TFrameInfos extends MngBaseFrameInfos<TInfo> = MngBaseFrameInfos<TInfo>,
    TFrameData extends MngBaseFrameData<TFrameInfos> = MngBaseFrameData<TFrameInfos>,
    TSendParams extends MngFrameSendParams = MngFrameSendParams
> {
    protected clientSyncManager: MngClientFrameSyncManager<TInfo, TFrameInfos, TFrameData>;
    protected config: MngFrameSyncConfig;
    protected logger: IMngFrameSyncLogger = MNG_NULL_LOGGER;

    /** 是否允许接入服务器帧（外部控制开关，如结算后禁止接入） */
    /* [学习注释]
     * 字段实际语义是“阻止普通服务器帧接入”：true时addServerFrame立即return。不要按旧字段注释反向理解。
     * [/学习注释]
     */
    private ctrlAddServerFrame: boolean = false;
    /** 最后连续收到的服务器帧号（用于缺帧检测） */
    /* [学习注释]
     * 连续接收游标，与Manager.serverFrame最大值不是同一概念。-1表示尚未建立起点。
     * [/学习注释]
     */
    private lastContiguousServerFrameIndex: number = -1;
    /** 已发送的重连起始帧（防止重复请求） */
    /* [学习注释]
     * 记录已请求的缺口起点，抑制同一缺口的重复请求；当前没有超时重试计时器。
     * [/学习注释]
     */
    private pendingReconnectFromFrame: number | null = null;
    /** 设置开始连续帧号 */
    /* [学习注释]
     * 直接设置连续游标。例如设0会要求下一帧为1。没有自动回放或恢复玩法状态。
     * [/学习注释]
     */
    public setStartLastContiguousServerFrameIndex(frameIndex: number): void {
        this.lastContiguousServerFrameIndex = frameIndex;
    }
    /** 设置日志器 */
    /* [学习注释]
     * 保存给Driver，并在Manager已存在时同步过去；init时也会把日志传给新Manager。
     * [/学习注释]
     */
    public setLogger(logger: IMngFrameSyncLogger): void {
        this.logger = logger;
        this.clientSyncManager?.setLogger(logger);
    }

    /**
     * 设置是否允许接入服务器帧
     * @param value false 表示暂停接入（如结算阶段）
     */
    /* [学习注释]
     * 重要：参数true允许接收，false禁止接收，因为内部保存的是!value。
     * example_usage及部分旧文档中的true/false说明写反，学习版保留原语句并标注，不改变行为。
     * [/学习注释]
     */
    public setAddServerFrame(value: boolean): void {
        this.ctrlAddServerFrame = !value;
    }

    /** 初始化驱动层 */
    /* [学习注释]
     * 若旧Manager存在，先destroy；再读取配置、创建Manager、安装监听/处理器、重置连续游标。
     * 这里没有调用Manager.init，所以此时Manager仍为UNINITIALIZED。
     * [/学习注释]
     */
    public init(): void {
        if (this.clientSyncManager) {
            try { this.clientSyncManager.destroy(); } catch {}
        }
        this.ctrlAddServerFrame = false;
        this.config = this.createConfig();
        this.clientSyncManager = new MngClientFrameSyncManager<TInfo, TFrameInfos, TFrameData>(this.config);
        this.clientSyncManager.setLogger(this.logger);
        this.setupEventListeners();
        this.setupDataHandler();
        this.lastContiguousServerFrameIndex = -1;
        this.pendingReconnectFromFrame = null;
    }

    /** 初始化 sync manager（进入 RUNNING 状态） */
    /* [学习注释]
     * 进入RUNNING。普通收帧若过早进入Driver，可能先推进连续游标但被未启动的Manager忽略，需由接入顺序避免。
     * [/学习注释]
     */
    public initSyncClient(): void {
        this.clientSyncManager.init();
    }

    // ========== 子类必须/可选实现 ==========

    /**
     * 创建帧同步配置（子类可覆盖以提供游戏特定配置）
     * 默认返回 MNG_DEFAULT_FRAME_SYNC_CONFIG
     */
    /* [学习注释]
     * 返回默认配置副本，子类可覆盖。修改logicFrameRate时同时更新logicFrameInterval。
     * [/学习注释]
     */
    protected createConfig(): MngFrameSyncConfig {
        // 返回默认帧同步配置对象
        return Object.assign({}, MNG_DEFAULT_FRAME_SYNC_CONFIG);
    }

    /**
     * 设置事件监听（逻辑帧/渲染帧更新等）
     * 子类实现以将帧同步事件绑定到各游戏的事件系统
     */
    /* [学习注释]
     * 将Manager事件接到玩法通知系统；要区分FRAME_UPDATE的启动/logic/render载荷。
     * [/学习注释]
     */
    protected abstract setupEventListeners(): void;

    /**
     * 设置数据处理器
     * 子类实现以将帧数据派发到各游戏逻辑层
     */
    /* [学习注释]
     * 把onClientFrame、onServerFrame、onServerFrameBatch接到实际玩法；这是执行状态更新的关键出口。
     * [/学习注释]
     */
    protected abstract setupDataHandler(): void;

    /**
     * 获取协议层实例（子类实现）
     * 用于发送重连请求
     */
    /* [学习注释]
     * 为缺口请求返回玩法Protocol实例；基类不持有统一的具体协议实现。
     * [/学习注释]
     */
    protected abstract getProtocol(): MngBaseFrameSyncProtocol<TSendParams, TFrameInfos, TFrameData>;

    /**
     * 将协议层原始消息转换为通用帧数据（子类实现）
     * 不同游戏的协议格式不同，需要各自实现转换逻辑
     * @param rawMsg 协议层的原始消息
     * @returns 通用帧数据
     */
    /* [学习注释]
     * 协议原始结构转为通用结构。若Protocol已经解析过，要识别已解析对象，避免再按原始字段解析一次丢数据。
     * [/学习注释]
     */
    protected abstract convertRawMsgToFrameData(rawMsg: any): TFrameData;

    // ========== 服务器帧处理 ==========

    /**
     * 添加服务器帧数据（由协议层回调调用）
     * 包含缺帧检测 -> 重连请求 -> 数据转换 -> 传入 syncManager
     * @param rawMsg 协议层的原始消息（需有 frameIndex 和 roomId 等字段）
     * @param frameIndex 帧号
     * @param roomId 房间id（用于重连请求）
     */
    /* [学习注释]
     * 普通直播帧入口。按expectedNext判断旧帧、连续帧、缺口，只有连续帧才交给Manager。
     * [/学习注释]
     */
    public addServerFrame(rawMsg: any, frameIndex: number, roomId: number): void {
        if (this.ctrlAddServerFrame) {
            return;
        }

        // 缺帧检测
        /* [学习注释]
         * 未设置起点时接受首个到达帧作为起点，不会自动请求它之前的全部历史。
         * [/学习注释]
         */
        if (this.lastContiguousServerFrameIndex < 0) {
            this.lastContiguousServerFrameIndex = frameIndex - 1;
        }
        const expectedNext = this.lastContiguousServerFrameIndex + 1;

        // 忽略旧帧/重复帧
        /* [学习注释]
         * 比下一期望帧小，认为是重复/旧帧并忽略，不再次触发业务回调。
         * [/学习注释]
         */
        if (frameIndex < expectedNext) {
            return;
        }

        // 检测缺口 -> 请求重连补帧
        /* [学习注释]
         * 例：已连续到100，收到103，缺口从101开始。发送一次sendReconnect(roomId,101)。
         * 当前103直接丢弃，没有在基类排队保存；后续恢复数据要覆盖需要补齐的范围。
         * [/学习注释]
         */
        if (frameIndex > expectedNext) {
            if (this.pendingReconnectFromFrame !== expectedNext) {
                this.pendingReconnectFromFrame = expectedNext;
                // console.error(
                //     `[通用帧同步] 检测到缺帧触发重连：roomId=${roomId}，lastContiguous=${this.lastContiguousServerFrameIndex}，incoming=${frameIndex}，requestFrom=${expectedNext}`
                // );
                this.logger.isDebugEnabled() &&
                    this.logger.warn(`[帧丢失] 缺口：lastContiguous=${this.lastContiguousServerFrameIndex}, incoming=${frameIndex}，请求从 ${expectedNext} 补帧`);
                this.getProtocol().sendReconnect(roomId, expectedNext);
            }
            return;
        }

        if (this.pendingReconnectFromFrame !== null && frameIndex >= this.pendingReconnectFromFrame) {
            this.pendingReconnectFromFrame = null;
        }
        if (frameIndex === expectedNext) {
            this.lastContiguousServerFrameIndex = frameIndex;
        }

        /* [学习注释]
         * 此时连续游标已经更新。转换或Manager处理若失败，本方法没有回滚游标，因此接入方必须保证有效数据和运行状态。
         * [/学习注释]
         */
        const frameData = this.convertRawMsgToFrameData(rawMsg);
        this.clientSyncManager.addServerFrame(frameData);
    }

    /**
     * 重连游戏（处理重连响应中的历史帧批量灌入）
     * @param roomId 房间id
     * @param historyFrames 按序排列的历史帧数据
     */
    /* [学习注释]
     * 历史批次绕过Driver.addServerFrame，直接灌入Manager；不会再逐帧检查连续性。
     * 调用方应保证历史按正确顺序且覆盖所需范围，方法只取最大帧号更新连续游标。roomId参数当前未使用。
     * [/学习注释]
     */
    public reconnectGame(roomId: number, historyFrames: TFrameData[]): void {
        if (!historyFrames || historyFrames.length === 0) {
            return;
        }

        /* [学习注释]
         * replay期间照常缓存/校正，只延后数据处理器派发。结束后交给onServerFrameBatch；无批量接口则仅最后一帧。
         * [/学习注释]
         */
        this.beginServerFrameReplayBatch();
        let maxFrameIndex = 0;
        for (const frameData of historyFrames) {
            maxFrameIndex = Math.max(maxFrameIndex, frameData.frameIndex);
            this.clientSyncManager.addServerFrame(frameData);
        }
        this.lastContiguousServerFrameIndex = maxFrameIndex;
        if (this.pendingReconnectFromFrame !== null && maxFrameIndex >= this.pendingReconnectFromFrame) {
            this.pendingReconnectFromFrame = null;
        }
        this.endServerFrameBatch(true);
    }

    /**
     * 标记服务端帧已经连续到指定帧。
     *
     * 有些玩法的重连快照会直接把业务状态恢复到某个服务端帧，但不一定有历史帧需要灌入。
     * 例如快照已恢复到 56 帧且 afterFrames 为空时，如果不推进这里的连续帧游标，
     * 下一帧 57 到达时通用层会误判缺少 56 并再次触发重连。
     */
    /* [学习注释]
     * 快照已恢复到56且历史为空时，标记56，下一帧57才不会被误判缺口。
     * 这里只更新Driver连续游标，不修改Manager帧号、不应用快照、不执行玩法。
     * [/学习注释]
     */
    public markServerFrameContiguous(frameIndex: number): void {
        if (frameIndex <= 0) {
            return;
        }
        this.lastContiguousServerFrameIndex = Math.max(this.lastContiguousServerFrameIndex, frameIndex);
        if (this.pendingReconnectFromFrame !== null && frameIndex >= this.pendingReconnectFromFrame) {
            this.pendingReconnectFromFrame = null;
        }
    }

    // ========== 批处理代理 ==========

    /* [学习注释]
     * 代理latest模式：只在结束时向业务交出最大帧号的包；?.表示Manager不存在则不调用。
     * [/学习注释]
     */
    public beginServerFrameBatch(): void { this.clientSyncManager?.beginServerFrameBatch(); }
    /* [学习注释]
     * 代理replay模式：收集后排序批量交付。不是异步队列，begin/end需由调用者成对控制。
     * [/学习注释]
     */
    public beginServerFrameReplayBatch(): void { this.clientSyncManager?.beginServerFrameReplayBatch(); }
    /* [学习注释]
     * flush=false只取消待派发回调，不撤销已灌入缓存和校正产生的副作用。
     * [/学习注释]
     */
    public endServerFrameBatch(flush: boolean = true): void { this.clientSyncManager?.endServerFrameBatch(flush); }

    // ========== 客户端帧处理 ==========

    /**
     * 添加客户端帧数据（本地操作存入缓冲区）
     * @param frameIndex 帧号
     * @param frameInfo 帧信息
     */
    /* [学习注释]
     * 只写本地缓存，不发送消息，也不自动增加逻辑帧。
     * [/学习注释]
     */
    public addClientFrame(frameIndex: number, frameInfo: TFrameInfos): void {
        this.clientSyncManager.addClientFrame(frameIndex, frameInfo);
    }

    // ========== 主循环驱动 ==========

    /** 更新逻辑帧（由游戏主循环调用） */
    /* [学习注释]
     * 传入秒单位dt；Manager按累计时间推进，再按需要额外追帧。
     * [/学习注释]
     */
    public updateLogicFrame(deltaTime: number): void { this.clientSyncManager.updateLogicFrame(deltaTime); }
    /** 更新渲染帧（由游戏主循环调用） */
    /* [学习注释]
     * 发出渲染节拍事件，具体插值和节点位置由玩法处理。
     * [/学习注释]
     */
    public updateRenderFrame(deltaTime: number): void { this.clientSyncManager.updateRenderFrame(deltaTime); }

    // ========== 查询接口 ==========

    /* [学习注释]
     * 读取Manager本地逻辑计数器，未必等于玩法自己维护的已消费服务器帧。
     * [/学习注释]
     */
    public getCurrentLogicFrame(): number { return this.clientSyncManager.getCurrentLogicFrame(); }
    /* [学习注释]
     * 读取框架渲染计数器，不是GPU实际显示的画面数量。
     * [/学习注释]
     */
    public getCurrentRenderFrame(): number { return this.clientSyncManager.getCurrentRenderFrame(); }
    /* [学习注释]
     * 读取Manager接入过的最大服务器帧号。
     * [/学习注释]
     */
    public getServerFrame(): number { return this.clientSyncManager.getServerFrame(); }
    /* [学习注释]
     * 与getServerFrame语义相同，只是另一个名称。
     * [/学习注释]
     */
    public getCurrentServerFrame(): number { return this.clientSyncManager.getServerFrame(); }
    /* [学习注释]
     * 读取本地与服务器帧号的配置偏移，单位是帧。
     * [/学习注释]
     */
    public getServerFrameDelay(): number { return this.config.serverFrameDelay; }
    /* [学习注释]
     * 参数使用原始帧号，Manager内部加delay查缓存，返回外层仍是原始帧号。
     * [/学习注释]
     */
    public getClientFrameData(frameIndex: number): TFrameData | null { return this.clientSyncManager.getClientFrameData(frameIndex); }

    /** 获取某一帧服务器帧数据 */
    /* [学习注释]
     * 直接使用服务器缓存key；当前Buffer单个serverFrame槽位可能只保留多人帧中的最后一个玩家组。
     * [/学习注释]
     */
    public getServerFrameData(frameIndex: number): TFrameInfos | undefined {
        return this.clientSyncManager.getFrameBuffer()?.getServerFrame(frameIndex);
    }

    /** 获取内部的 MngClientFrameSyncManager（高级用法） */
    /* [学习注释]
     * 暴露内部Manager供高级操作，调用者应遵守已初始化和生命周期约束。
     * [/学习注释]
     */
    public getSyncManager(): MngClientFrameSyncManager<TInfo, TFrameInfos, TFrameData> {
        return this.clientSyncManager;
    }

    // ========== 生命周期 ==========

    /* [学习注释]
     * destroy清缓存/事件/处理器并解除Manager引用。null!仅绕过TS类型检查，运行时仍是null。
     * 基类不注销具体Protocol消息；子类应解绑协议回调并unInit协议，防止销毁后继续进入Driver。
     * [/学习注释]
     */
    public unInit(): void {
        try { this.clientSyncManager?.destroy(); } catch {}
        this.clientSyncManager = null!;
        this.config = null!;
        this.ctrlAddServerFrame = false;
        this.lastContiguousServerFrameIndex = -1;
        this.pendingReconnectFromFrame = null;
    }
}
