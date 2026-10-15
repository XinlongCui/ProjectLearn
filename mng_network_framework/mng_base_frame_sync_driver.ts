/**
 * 帧同步框架 - 驱动层抽象基类（应用时，继承并拓展相关字段即可）
 * 具体可参考example/example_driver.ts
 */

import { MngBaseFrameInfo, MngBaseFrameInfos, MngBaseFrameData } from "./mng_base_frame_data";
import { MngFrameSyncConfig, MNG_DEFAULT_FRAME_SYNC_CONFIG } from "./mng_frame_sync_config";
import { IMngFrameSyncLogger, MNG_NULL_LOGGER } from "./mng_frame_sync_types";
import { MngClientFrameSyncManager } from "./mng_client_frame_sync_manager";
import { MngBaseFrameSyncProtocol, MngFrameSendParams } from "./mng_base_frame_sync_protocol";

export abstract class MngBaseFrameSyncDriver<
    TInfo extends MngBaseFrameInfo = MngBaseFrameInfo,
    TFrameInfos extends MngBaseFrameInfos<TInfo> = MngBaseFrameInfos<TInfo>,
    TFrameData extends MngBaseFrameData<TFrameInfos> = MngBaseFrameData<TFrameInfos>,
    TSendParams extends MngFrameSendParams = MngFrameSendParams
> {
    protected clientSyncManager: MngClientFrameSyncManager<TInfo, TFrameInfos, TFrameData>;
    protected config: MngFrameSyncConfig;
    protected logger: IMngFrameSyncLogger = MNG_NULL_LOGGER;

    /** 是否允许接入服务器帧（字段实际语义是“阻止普通服务器帧接入”：true时addServerFrame立即return。不要按旧字段注释反向理解。） */
    private ctrlAddServerFrame: boolean = false;
    /** 重要：参数true允许接收，false禁止接收，因为内部保存的是!value。
     * example_usage及部分旧文档中的true/false说明写反，学习版保留原语句并标注，不改变行为。
     */
    public setAddServerFrame(value: boolean): void {
        this.ctrlAddServerFrame = !value;
    }

    /** 最后连续收到的服务器帧号（用于缺帧检测。连续接收游标，与Manager.serverFrame最大值不是同一概念。-1表示尚未建立起点。*/
    private lastContiguousServerFrameIndex: number = -1;
    /* 直接设置连续游标，例如设i会要求下一期待的帧为i+1，因为i是已经收到的*/
    public setStartLastContiguousServerFrameIndex(frameIndex: number): void {
        this.lastContiguousServerFrameIndex = frameIndex;
    }

    /** 已发送的重连起始帧（防止重复请求）。记录已请求的缺口起点，抑制同一缺口的重复请求；当前没有超时重试计时器。*/
    private pendingReconnectFromFrame: number | null = null;

    /** 设置日志器自身以及Manager的Logger */
    public setLogger(logger: IMngFrameSyncLogger): void {
        this.logger = logger;
        this.clientSyncManager?.setLogger(logger);
    }

    // ========== 生命周期 ==========

    /** 初始化驱动层
     * 若旧Manager存在，先destroy；再读取配置、创建Manager、安装监听/处理器、重置连续游标。
     * 这里没有调用Manager.init，所以此时Manager仍为UNINITIALIZED。
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

    /** 初始化 sync manager（进入 RUNNING 状态）
     * 进入RUNNING。普通收帧若过早进入Driver，可能先推进连续游标但被未启动的Manager忽略，需由接入顺序避免。
     * 因为驱动层已经创建好，不代表内部的 Manager（帧同步管理器）已经启动。如果服务器帧在这两步之间进入，就可能出现“驱动层记录收到了，管理器却没有处理”的情况
     * 
     * 由接入顺序避免”是什么意思？就是确保服务器帧被允许进入 Driver 之前，Manager 已经启动，回调也已经绑定好。一种可行的安排是：
        创建协议层和驱动层。
        调用 driver.init()，完成管理器创建、处理器安装和协议回调绑定。
        调用 driver.initSyncClient()，启动管理器。
        再注册网络消息监听、发起进房请求，或开放服务器帧接入，具体顺序按项目流程安排。
        可参考example/example_usage.ts示例中的初始化顺序。
     */
    public initSyncClient(): void {
        this.clientSyncManager.init();
    }

    /**
     * destroy清缓存/事件/处理器并解除Manager引用。null!仅绕过TS类型检查，运行时仍是null。
     * 基类不注销具体Protocol消息；子类应解绑协议回调并unInit协议，防止销毁后继续进入Driver。
     */
    public unInit(): void {
        try { this.clientSyncManager?.destroy(); } catch {}
        this.clientSyncManager = null!;
        this.config = null!;
        this.ctrlAddServerFrame = false;
        this.lastContiguousServerFrameIndex = -1;
        this.pendingReconnectFromFrame = null;
    }

    // ========== 子类必须/可选实现 ==========

    /**
     * 创建帧同步配置（子类可覆盖以提供游戏特定配置）
     * 默认返回 MNG_DEFAULT_FRAME_SYNC_CONFIG
     */
    protected createConfig(): MngFrameSyncConfig {
        // 返回默认帧同步配置对象
        return Object.assign({}, MNG_DEFAULT_FRAME_SYNC_CONFIG);
    }

    /**
     * 设置事件监听（逻辑帧/渲染帧更新等）
     * 子类实现以将帧同步事件绑定到各游戏的事件系统=>发生事件(FRAME_UPDATE,...)后怎么办？
     * 可参考example/example_usage.ts示例中的实现。
     */
    protected abstract setupEventListeners(): void;

    /**
     * 设置数据处理器
     * 子类实现以将帧数据派发到各游戏逻辑层=>拿到帧数据后怎么办(onClientFrame、onServerFrame、onServerFrameBatch)?
     */
    protected abstract setupDataHandler(): void;

    /**
     * 获取协议层实例（子类实现）
     * 每个具体玩法的 Driver 子类，都要提供一个方法，让基类能够拿到该玩法的协议对象。 基类发现缺帧时，就通过这个对象发送补帧请求
     */
    protected abstract getProtocol(): MngBaseFrameSyncProtocol<TSendParams, TFrameInfos, TFrameData>;

    /**
     * 将协议层原始消息转换为通用帧数据（子类实现）
     * 不同游戏的协议格式不同，需要各自实现转换逻辑
     * @param rawMsg 协议层的原始消息
     * @returns 通用帧数据
     */
    /**
     * 协议原始结构转为通用结构。若Protocol已经解析过，要识别已解析对象，避免再按原始字段解析一次丢数据。
     */
    protected abstract convertRawMsgToFrameData(rawMsg: any): TFrameData;

    // ========== 客户端帧处理 ==========

    /**
     * 添加客户端帧数据（本地操作存入缓冲区）。只写本地缓存，不发送消息，也不自动增加逻辑帧。
     * @param frameIndex 帧号
     * @param frameInfo 帧信息
     */
    public addClientFrame(frameIndex: number, frameInfo: TFrameInfos): void {
        this.clientSyncManager.addClientFrame(frameIndex, frameInfo);
    }

    // ========== 服务器帧处理 ==========

    /**
     * 添加服务器帧数据（协议层收到服务器帧后，通过驱动层设置的回调，让数据进入驱动层，再由驱动层转交管理器。）
     * 包含缺帧检测 -> 重连请求 -> 数据转换 -> 传入 syncManager
     * @param rawMsg 协议层的原始消息（需有 frameIndex 和 roomId 等字段）
     * @param frameIndex 帧号
     * @param roomId 房间id（用于重连请求）
     */
    public addServerFrame(rawMsg: any, frameIndex: number, roomId: number): void {
        if (this.ctrlAddServerFrame) {
            return;
        }

        // 缺帧检测。
        // 未设置起点时接受首个到达帧作为起点，不会自动请求它之前的全部历史。
        if (this.lastContiguousServerFrameIndex < 0) {
            this.lastContiguousServerFrameIndex = frameIndex - 1;
        }
        const expectedNext = this.lastContiguousServerFrameIndex + 1;

        // 忽略旧帧/重复帧。
        // 比下一期望帧小，认为是重复/旧帧并忽略，不再次触发业务回调。
        if (frameIndex < expectedNext) {
            return;
        }

        // 检测缺口 -> 请求重连补帧
        // 例：已连续到100，期望为100 + 1 = 101，但收到103，缺口从101开始。发送一次 protocol的sendReconnect(roomId,101)。
        // 当前103直接丢弃，没有在基类排队保存；后续恢复数据要覆盖需要补齐的范围。
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

        // 连续帧，更新连续游标。
        if (frameIndex === expectedNext) {
            this.lastContiguousServerFrameIndex = frameIndex;
        }

        // 此时连续游标已经更新。转换或Manager处理若失败，本方法没有回滚游标，因此接入方必须保证有效数据和运行状态。
        const frameData = this.convertRawMsgToFrameData(rawMsg);
        this.clientSyncManager.addServerFrame(frameData);
    }

    /**
     * 重连游戏（处理重连响应中的历史帧批量灌入）
     * @param roomId 房间id
     * @param historyFrames 按序排列的历史帧数据
     */
    /**
     * 历史批次绕过Driver.addServerFrame，直接灌入Manager；不会再逐帧检查连续性。
     * 调用方应保证历史按正确顺序且覆盖所需范围，方法只取最大帧号更新连续游标。roomId参数当前未使用。
     * 我们用一个例子贯穿来看：
        驱动层此前连续收到帧 100。
        接着收到 103，发现缺少 101、102，于是请求从 101 补帧。
        服务器返回历史帧 101、102、103、104、105。
        调用 reconnectGame(roomId, historyFrames) 处理这批数据。
     */
    public reconnectGame(roomId: number, historyFrames: TFrameData[]): void {
        //检查有没有历史数据，没有则直接返回。
        if (!historyFrames || historyFrames.length === 0) {
            return;
        }

        //开启历史帧回放批处理，这里会让 Manager 进入 replay，即收集历史帧、结束后按帧号顺序交付的模式，并清空上一批待派发的数据。
        /** 
         * 普通接收模式下，Manager 每接入一帧，就立即调用业务的 onServerFrame()
         * 开启批处理后，接入 101～105 时：
         * 缓存照常写入。
         * 校正照常执行。
         * 必要的帧号对齐仍可能发生。
         * 完整帧包先收集起来，不立即调用业务的 onServerFrame()。
         */
        this.beginServerFrameReplayBatch();
        let maxFrameIndex = 0;
        for (const frameData of historyFrames) {
            maxFrameIndex = Math.max(maxFrameIndex, frameData.frameIndex);
            this.clientSyncManager.addServerFrame(frameData);
        }
        this.lastContiguousServerFrameIndex = maxFrameIndex;//这里是按最大帧号直接认定连续，并没有验证中间是否真的完整。
        if (this.pendingReconnectFromFrame !== null && maxFrameIndex >= this.pendingReconnectFromFrame) {
            //pendingReconnectFromFrame 记录的是：此前已经请求从哪一帧开始恢复，用于避免针对同一个缺口重复发送请求。认为本次补帧请求已经得到覆盖，可以清空。
            this.pendingReconnectFromFrame = null;
        }
        //结束批处理，把历史帧交给业务
        this.endServerFrameBatch(true);//无批量接口（onServerFrameBatch()）则仅最后一帧。
    }

    /**
     * 标记服务端帧已经连续到指定帧。
     * 有些玩法的重连快照会直接把业务状态恢复到某个服务端帧，但不一定有历史帧需要灌入。
     * 例如快照已恢复到 56 帧且 afterFrames 为空时，如果不推进这里的连续帧游标，
     * 下一帧 57 到达时通用层会误判缺少 56 并再次触发重连。
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

    // ========== 批处理代理（具体去看manager里面的解释吧） ==========

    /** 代理latest模式：只在结束时向业务交出最大帧号的包 */
    public beginServerFrameBatch(): void { this.clientSyncManager?.beginServerFrameBatch(); }
    /** 代理replay模式：收集后排序批量交付。*/
    public beginServerFrameReplayBatch(): void { this.clientSyncManager?.beginServerFrameReplayBatch(); }

    public endServerFrameBatch(flush: boolean = true): void { this.clientSyncManager?.endServerFrameBatch(flush); }

    // ========== 主循环驱动 ==========

    /** 更新逻辑帧（由游戏主循环调用） */
    /** 传入秒单位dt；Manager按累计时间推进，再按需要额外追帧。 */
    public updateLogicFrame(deltaTime: number): void { this.clientSyncManager.updateLogicFrame(deltaTime); }

    /** 更新渲染帧（由游戏主循环调用） */
    /** 发出渲染节拍事件，具体插值和节点位置由玩法处理。 */
    public updateRenderFrame(deltaTime: number): void { this.clientSyncManager.updateRenderFrame(deltaTime); }

    // ========== 查询接口 ==========

    /** 读取Manager本地逻辑计数器，未必等于玩法自己维护的已消费服务器帧。 */
    public getCurrentLogicFrame(): number { return this.clientSyncManager.getCurrentLogicFrame(); }

    /** 读取框架渲染计数器，不是GPU实际显示的画面数量。 */
    public getCurrentRenderFrame(): number { return this.clientSyncManager.getCurrentRenderFrame(); }

    /** 读取Manager接入过的最大服务器帧号。 */
    public getServerFrame(): number { return this.clientSyncManager.getServerFrame(); }

    /** 与getServerFrame语义相同，只是另一个名称。 */
    public getCurrentServerFrame(): number { return this.clientSyncManager.getServerFrame(); }

    /** 读取本地与服务器帧号的配置偏移，单位是帧。 */
    public getServerFrameDelay(): number { return this.config.serverFrameDelay; }
    
    /** 参数使用原始帧号，Manager内部加delay查缓存，返回外层仍是原始帧号。 */
    public getClientFrameData(frameIndex: number): TFrameData | null { return this.clientSyncManager.getClientFrameData(frameIndex); }

    /** 获取某一帧服务器帧数据 */
    /** 直接使用服务器缓存key；当前Buffer单个serverFrame槽位可能只保留多人帧中的最后一个玩家组。 */
    public getServerFrameData(frameIndex: number): TFrameInfos | undefined {
        return this.clientSyncManager.getFrameBuffer()?.getServerFrame(frameIndex);
    }

    /** 获取内部的 MngClientFrameSyncManager（高级用法） */
    /** 暴露内部Manager供高级操作，调用者应遵守已初始化和生命周期约束。 */
    public getSyncManager(): MngClientFrameSyncManager<TInfo, TFrameInfos, TFrameData> {
        return this.clientSyncManager;
    }

}
