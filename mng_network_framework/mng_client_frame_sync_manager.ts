/**
 * 客户端帧同步管理器。
 *
 * 可以把它理解为：
 *   帧时钟 + 帧数据缓存调度 + 预测/校正调度 + 业务回调。
 *
 * 外部给它两类输入：
 *
 * 1. 时间：
 *    updateLogicFrame(dt)
 *    updateRenderFrame(dt)
 *
 * 2. 数据：
 *    addClientFrame(...)
 *    addServerFrame(...)
 *
 * 它向外提供两类通知：
 *
 * 1. 数据处理回调：
 *    onClientFrame
 *    onServerFrame
 *    onServerFrameBatch
 *
 * 2. 事件：
 *    FRAME_UPDATE
 *    FRAME_PREDICT
 *    FRAME_CORRECT
 *    FRAME_LOST
 *
 * 注意：
 * - 本类不发送网络消息。
 * - 本类不直接计算角色移动、碰撞、技能。
 * - 逻辑帧计数器推进，不代表一定调用了 onClientFrame。
 *   只有对应缓存存在、且设置了 dataHandler 时，才会调用。
 * - 服务器帧通常在 addServerFrame 中立即交给业务，
 *   不必等 updateLogicFrame 推进到对应帧号。
 */

import {MngBaseFrameInfo,MngBaseFrameInfos,MngBaseFrameData,} from "./mng_base_frame_data";
import {MngFrameSyncConfig,MNG_DEFAULT_FRAME_SYNC_CONFIG,} from "./mng_frame_sync_config";
import {MngFrameSyncStatus,MngFrameSyncEventType,MngFrameSyncEventCallback,MngFrameSyncStats,IMngFrameDataHandler,IMngFrameSyncLogger,MNG_NULL_LOGGER,} from "./mng_frame_sync_types";

import { MngFrameBuffer } from "./mng_frame_buffer";
import { MngFramePredictor } from "./mng_frame_predictor";
import { MngFrameCorrector } from "./mng_frame_corrector";

export class MngClientFrameSyncManager<
    TInfo extends MngBaseFrameInfo = MngBaseFrameInfo,
    TFrameInfos extends MngBaseFrameInfos<TInfo> = MngBaseFrameInfos<TInfo>,
    TFrameData extends MngBaseFrameData<TFrameInfos> = MngBaseFrameData<TFrameInfos>
> {
    // ==================== 配置与运行状态 ====================

    /**
     * 合并默认值后的完整配置。
     *
     * 默认：
     * - 逻辑帧率：15
     * - 渲染帧率：60
     * - serverFrameDelay：5
     * - maxFrameCache：600
     * - 本地预测：关闭
     * - 服务器校正：开启
     */
    private config: MngFrameSyncConfig;

    /**
     * 当前运行状态。
     *
     * 创建对象后只是 UNINITIALIZED。
     * 必须调用 init() 才进入 RUNNING。
     *
     * 本类的时间推进和数据接入入口都会检查 RUNNING。
     */
    private status: MngFrameSyncStatus = MngFrameSyncStatus.UNINITIALIZED;

    // ==================== 三个内部组件 ====================

    /**
     * 按帧号保存数据。
     *
     * 内部大致是：
     *
     * Map<帧号, {
     *     clientFrame,
     *     serverFrame,
     *     confirmed,
     *     timestamp
     * }>
     *
     * 同一帧号可以同时有客户端数据和服务器数据。
     */
    private frameBuffer: MngFrameBuffer<TFrameInfos>;

    /**
     * 预测器。
     *
     * 当前实现主要根据前后两帧位置，
     * 外推下一帧位置：
     *
     * next = current + (current - previous)
     */
    private predictor: MngFramePredictor<TInfo, TFrameInfos>;

    /**
     * 校正器。
     *
     * 根据服务器数据补充或修正 clientFrame 缓存。
     * 这里的校正不等于完整游戏世界的回滚重算。
     */
    private corrector: MngFrameCorrector<TInfo, TFrameInfos>;

    // ==================== 三种帧号 ====================

    /**
     * 本地逻辑帧计数器。
     *
     * 通常由 advanceLogicFrameOnce() 每次加 1。
     * 硬对齐时也可能被直接设置为目标帧号。
     */
    private currentLogicFrame: number = 0;

    /**
     * 本类的渲染节拍计数器。
     *
     * 注意：
     * 它不是 Cocos 真正提交到屏幕的画面数量。
     * 一次 updateRenderFrame() 可能发出多个渲染更新事件。
     */
    private currentRenderFrame: number = 0;

    /**
     * 已接入的服务器帧号最大值。
     *
     * addServerFrame 中使用 Math.max 更新，
     * 因此这个字段不会因接入较旧帧而降低。
     *
     * 它不代表业务已经逐帧模拟到这里。
     */
    private serverFrame: number = 0;

    /**
     * 是否还没有完成首次有效帧号对齐。
     *
     * 名字虽然叫“是否第一帧”，实际清除条件是：
     *
     * serverFrameIndex - serverFrameDelay > 0
     *
     * 如果服务器帧号还太小，
     * 即使已经收到若干帧，这个标记也可能仍为 true。
     */
    private isFirstServerFrame: boolean = true;

    // ==================== 追帧策略 ====================

    /**
     * 相对目标逻辑帧，落后不超过 10 帧时，
     * 采用小幅补跑。
     */
    private static readonly MAX_SOFT_SYNC_DIFF: number = 10;

    /**
     * 小幅补跑：
     * 每次 updateLogicFrame 最多额外推进 2 帧。
     *
     * 注意“额外”：
     * 不包括前面按 deltaTime 正常推进的帧。
     */
    private static readonly MAX_CATCH_UP_LOGIC_FRAMES_PER_UPDATE: number = 2;

    /**
     * 欠账追帧：
     * 每次 updateLogicFrame 最多额外推进 6 帧。
     */
    private static readonly MAX_FAST_CATCH_UP_LOGIC_FRAMES_PER_UPDATE: number = 6;

    /**
     * 还需要额外补跑多少逻辑帧。
     *
     * 通常在收到服务器帧时，
     * 由 syncClientFrameWithServer() 根据当前差距设置。
     *
     * 真正补跑发生在 updateLogicFrame()。
     */
    private _catchUpDebtLogicFrames: number = 0;

    // ==================== 统计信息 ====================

    /**
     * 预测器返回有效结果的累计次数。
     *
     * 注意：
     * 预测器可能返回已经存在的下一帧，
     * 所以它不是严格去重后的“新预测帧数量”。
     */
    private predictFrameCount: number = 0;

    /**
     * correctFrame() 返回 true 的累计次数。
     *
     * 服务器数据创建了原本不存在的客户端缓存，
     * 也可能被计入。
     *
     * 同一个服务器帧内处理多个玩家，
     * 也可能累计多次。
     */
    private correctFrameCount: number = 0;

    /**
     * 缓存缺口检查结果的累计数量。
     *
     * 注意：
     * 同一个缺口可能在相邻逻辑帧的回溯检查中重复出现，
     * 所以它不是去重后的真实网络丢帧数量。
     */
    private lostFrameCount: number = 0;

    /**
     * 通过“服务器帧号 - 本地逻辑帧号”换算的毫秒数。
     *
     * 它包含主动保留的 serverFrameDelay，
     * 不是通过请求/响应测量的网络 RTT。
     */
    private networkLatency: number = 0;

    // ==================== 对外回调 ====================

    /**
     * 一个事件类型可以注册多个监听函数。
     *
     * 例如：
     * FRAME_UPDATE -> [监听函数A, 监听函数B]
     */
    private eventCallbacks: Map<MngFrameSyncEventType, MngFrameSyncEventCallback[]> = new Map();

    /**
     * 业务注入的数据处理器。
     *
     * 管理器负责在适当时机调用，
     * 具体怎样修改角色、场景状态，由处理器决定。
     */
    private dataHandler: IMngFrameDataHandler<TFrameData> | null = null;

    /**
     * 默认是无输出的日志器。
     * 外部可以通过 setLogger 接入项目日志系统。
     */
    private logger: IMngFrameSyncLogger = MNG_NULL_LOGGER;

    // ==================== 时间累加器 ====================

    /**
     * 将“秒”转换为“微秒”。
     *
     * 1 秒 = 1,000,000 微秒。
     *
     * 通过整数微秒累加，减少直接累计小数秒的误差。
     * Math.round 仍会产生微秒级量化误差，
     * 不能理解为数学意义上的完全无误差。
     */
    private static readonly TIME_SCALE: number = 1000000;

    /**
     * 累积了、但尚未用于推进逻辑帧的时间。
     * 单位：微秒。
     *
     * 例如：
     * 累积 80,000μs，每帧需要 66,666μs，
     * 推进一帧后剩余 13,334μs 留待下次使用。
     */
    private logicFrameTime: number = 0;

    /** 推进一个逻辑帧所需的时间，单位：微秒。 */
    private logicFrameInterval: number = 0;

    /** 尚未用于推进渲染节拍的时间，单位：微秒。 */
    private renderFrameTime: number = 0;

    /** 一个渲染节拍所需的时间，单位：微秒。 */
    private renderFrameInterval: number = 0;

    /**
     * 当前文件中这个队列没有实际入队、出队逻辑。
     * 仅声明并在 stop 中清空。
     *
     * 不要因为看到 Queue，就认为服务器帧在这里
     * 自动排队等待逻辑帧消费。
     */
    private serverFrameQueue: TFrameInfos[] = [];

    // ==================== 服务器帧批处理 ====================

    /**
     * 是否正在批量接入服务器帧。
     *
     * 开启后主要改变业务数据的派发时机。
     * 缓存、校正、帧号对齐等仍然可能发生。
     */
    private isServerFrameBatching: boolean = false;

    /**
     * latest：
     *   最终只把帧号最大的一个帧包交给业务。
     *
     * replay：
     *   收集多个帧包，结束时按帧号排序后交给业务。
     */
    private serverFrameBatchMode: "latest" | "replay" = "latest";

    /** latest 模式下，保留当前最大的那个帧包。 */
    private pendingServerFrameData: TFrameData | null = null;

    /**
     * replay 模式下，按帧号收集帧包。
     *
     * Map 的 key 是 frameIndex。
     * 同一帧号再次 set，会覆盖之前保存的帧包。
     */
    private pendingServerFrameDataMap: Map<number, TFrameData> = new Map();

    // ==================== 构造 ====================

    /**
     * Partial 表示调用者可以只提供部分配置。
     *
     * 例如：
     * new MngClientFrameSyncManager({
     *     enableLocalPredict: true
     * });
     *
     * 其余字段使用默认配置。
     */
    constructor(config?: Partial<MngFrameSyncConfig>) {
        // 创建新对象，并用调用者配置覆盖默认值。
        // 不直接修改 MNG_DEFAULT_FRAME_SYNC_CONFIG。
        this.config = Object.assign({}, MNG_DEFAULT_FRAME_SYNC_CONFIG, config);

        // 创建缓存。
        this.frameBuffer = new MngFrameBuffer<TFrameInfos>(this.config.maxFrameCache);

        // 预测器与校正器共享同一个缓存。
        // 因此它们写入的数据，Manager 随后也能读到。
        this.predictor = new MngFramePredictor<TInfo, TFrameInfos>(this.frameBuffer, this.config.enableLocalPredict);

        this.corrector = new MngFrameCorrector<TInfo, TFrameInfos>(this.frameBuffer, this.config.enableServerCorrection);

        // 配置中是秒，内部转换为整数微秒。
        //
        // 默认逻辑间隔：
        // 0.066666 秒 -> 66,666 微秒。
        this.logicFrameInterval = Math.round(this.config.logicFrameInterval * MngClientFrameSyncManager.TIME_SCALE);

        // 默认渲染间隔：
        // 0.016666 秒 -> 16,666 微秒。
        this.renderFrameInterval = Math.round(this.config.renderFrameInterval * MngClientFrameSyncManager.TIME_SCALE);

        // 注意：
        // 此处不会根据 logicFrameRate 自动计算 interval。
        // 如果将逻辑帧率改成 20，调用者还要同步配置：
        // logicFrameInterval: 1 / 20。
        //
        // 当前构造函数也没有校验 interval 是否为正数；
        // 后面的 while 推进依赖有效的正间隔。
    }

    /** 注入日志实现。 */
    public setLogger(logger: IMngFrameSyncLogger): void {
        this.logger = logger;
    }

    /**
     * 暴露校正器。
     *
     * 玩法可以设置：
     * - 玩家身份提取方法
     * - 朝向归一化方法
     * - 位置误差阈值
     */
    public getCorrector(): MngFrameCorrector<TInfo, TFrameInfos> {
        return this.corrector;
    }

    /** 暴露预测器。 */
    public getPredictor(): MngFramePredictor<TInfo, TFrameInfos> {
        return this.predictor;
    }

    // ==================== 启动 ====================

    /**
     * 将管理器从 UNINITIALIZED 切换到 RUNNING。
     *
     * 构造函数只创建组件；
     * init 才允许接入数据和推进时间。
     */
    public init(): void {
        // 避免重复启动。
        // PAUSED 状态下调用 init 也不会恢复，
        // 恢复应使用 resume。
        if (this.status !== MngFrameSyncStatus.UNINITIALIZED) {
            return;
        }

        this.status = MngFrameSyncStatus.RUNNING;

        // 清空时间余量，从新的时间累计开始。
        this.logicFrameTime = 0;
        this.renderFrameTime = 0;

        // 接下来等待第一次有效的服务器帧号对齐。
        this.isFirstServerFrame = true;

        // 通知外部已启动。
        //
        // 注意：
        // 这个 FRAME_UPDATE 没有 type: "logic"/"render"。
        // 它也没有推进逻辑帧号。
        this.emit(MngFrameSyncEventType.FRAME_UPDATE, {
            frame: this.currentLogicFrame,
            status: this.status,
        });
    }

    // ==================== 本地逻辑时间推进 ====================
    public updateLogicFrame(deltaTime: number): void {
        if (this.status !== MngFrameSyncStatus.RUNNING) {
            return;
        }

        // ---------- A. 正常时间推进 ----------
        // 将这次经过的时间加入累加器。
        this.logicFrameTime += Math.round(deltaTime * MngClientFrameSyncManager.TIME_SCALE);

        // 使用 while，不是 if：
        //
        // 如果一次 update 经历了多个逻辑帧间隔，
        // 就在本次调用中连续推进多个逻辑帧。
        //
        // 例如逻辑间隔约 0.066666 秒，
        // deltaTime = 0.2 秒，且原本无时间余量：
        // 这里大约推进 3 帧。
        //
        // 注意：
        // 这段正常推进没有设置“每次最多几帧”的上限。
        while (this.logicFrameTime >= this.logicFrameInterval) {
            // 消耗一个固定时间步长。
            this.logicFrameTime -= this.logicFrameInterval;

            // 真正推进一次逻辑帧。
            this.advanceLogicFrameOnce();
        }

        // ---------- B. 额外追赶服务器进度 ----------
        // 只有首次对齐已经完成，并且不在批处理中，
        // 才执行这部分额外追帧。
        //
        // 注意：
        // 这个条件不影响前面 A 段的正常时间推进。
        if (!this.isFirstServerFrame && !this.isServerFrameBatching) {
            // 有意让本地逻辑帧落后服务器 delay 帧。
            // 例如：
            // serverFrame = 120
            // delay = 5
            // 目标本地逻辑帧就是 115。
            const expectedLogicFrame = this.serverFrame - this.config.serverFrameDelay;

            if (expectedLogicFrame > 0 && this.currentLogicFrame < expectedLogicFrame) {
                // 这里的差值是完成 A 段正常推进后，本地仍然落后的数量。
                const diff = expectedLogicFrame - this.currentLogicFrame;

                if (diff <= MngClientFrameSyncManager.MAX_SOFT_SYNC_DIFF) {
                    // 小幅落后：最多额外补跑 2 帧。
                    const steps = Math.min(MngClientFrameSyncManager.MAX_CATCH_UP_LOGIC_FRAMES_PER_UPDATE, diff);

                    for (let i = 0; i < steps; i++) {
                        this.advanceLogicFrameOnce();
                    }

                    // 已进入小差距处理，不再保留旧欠账。
                    this._catchUpDebtLogicFrames = 0;
                } else if (this._catchUpDebtLogicFrames > 0) {
                    // 差距超过 10，并且收帧时记录了欠账。
                    // 本次最多额外推进 6 帧。
                    let steps = Math.min(MngClientFrameSyncManager.MAX_FAST_CATCH_UP_LOGIC_FRAMES_PER_UPDATE, this._catchUpDebtLogicFrames);

                    // 三个条件都满足才继续：
                    // 1. 本次额度没用完。
                    // 2. 还有欠账。
                    // 3. 尚未追到目标。
                    while (steps > 0 && this._catchUpDebtLogicFrames > 0 && this.currentLogicFrame < expectedLogicFrame) {
                        this.advanceLogicFrameOnce();
                        this._catchUpDebtLogicFrames--;
                        steps--;
                    }
                }
            } else {
                // 不再落后，或目标帧号还无效。
                this._catchUpDebtLogicFrames = 0;
            }
        }

        // 额外追帧没有扣除 logicFrameTime。
        // 因为这些帧是为了追赶进度主动多跑的，
        // 不是由本次经过的真实时间换算出来的。
    }

    /**
     * 推进一个逻辑帧的公共内部步骤。
     *
     * 正常时间推进和额外追帧都调用这里。
     *
     * 顺序：
     * 1. 帧号 +1。
     * 2. 清理旧缓存。
     * 3. 检查缓存缺口。
     * 4. 有客户端缓存时，回调 onClientFrame。
     * 5. 发出逻辑帧更新事件。
     */
    private advanceLogicFrameOnce(): void {
        this.currentLogicFrame++;

        // ---------- 清理过旧的数据 ----------

        // 例如：
        // 当前逻辑帧 1000，缓存窗口 600，
        // cleanupFrame = 400。
        const cleanupFrame = this.currentLogicFrame - this.config.maxFrameCache;

        if (cleanupFrame > 0) {
            // Buffer.cleanup 删除的是：
            // frameIndex < cleanupFrame 的记录。
            this.frameBuffer.cleanup(cleanupFrame);
        }

        // ---------- 检查缓存缺口 ----------

        // Buffer 默认向前检查最近最多约 10 帧，
        // 从有效的缓存起点开始检查缺失的 Map key。
        //
        // 它检查的是“该帧有没有缓存记录”，
        // 不是“有没有收到服务器确认”。
        //
        // 仅有 clientFrame 的记录也算存在。
        const lostFrames = this.frameBuffer.checkLostFrames(this.currentLogicFrame);

        if (lostFrames.length > 0) {
            this.lostFrameCount += lostFrames.length;

            // 这里只发出事件。
            // 本类不会在这里自动发送补帧请求。
            this.emit(MngFrameSyncEventType.FRAME_LOST, {
                frames: lostFrames,
                count: lostFrames.length,
            });
        }

        // ---------- 消费当前帧的客户端缓存 ----------

        // 直接按 currentLogicFrame 查缓存。
        //
        // 这里不再额外加 serverFrameDelay。
        // addClientFrame 写入时已经完成过帧号映射。
        const clientFrame = this.frameBuffer.getClientFrame(this.currentLogicFrame);

        if (clientFrame && this.dataHandler) {
            // 将缓存中的一个 TFrameInfos，
            // 包装成业务处理器需要的 TFrameData。
            //
            // 注意：
            // 1. roomId 当前写死为 1，不是动态房间信息。
            // 2. 这里是普通对象，不是 new TFrameData。
            // 3. as unknown as 只影响 TS 类型检查，
            //    不会自动补上玩法扩展字段或执行构造函数。
            const frameData = {
                roomId: 1,
                frameIndex: this.currentLogicFrame,
                frames: [clientFrame],
            } as unknown as TFrameData;

            // 在逻辑推进到这个缓存帧时调用。
            //
            // clientFrame 可能来自：
            // - 本地输入；
            // - 本地预测；
            // - 服务器校正器创建或修改的缓存。
            //
            // 所以“客户端帧”描述的是缓存位置，
            // 并不保证其中所有数据都源自本地输入。
            this.dataHandler.onClientFrame(frameData);
        }

        // 无论有没有 clientFrame，都会发出逻辑帧更新事件。
        //
        // 因此：
        // FRAME_UPDATE(type=logic) 可以每个逻辑步都有，
        // onClientFrame 则不一定每个逻辑步都有。
        this.emit(MngFrameSyncEventType.FRAME_UPDATE, {
            frame: this.currentLogicFrame,
            type: "logic",
        });
    }

    // ==================== 渲染节拍推进 ====================

    /**
     * 与逻辑时间使用独立的时间累加器。
     *
     * 外部通常每次 update 都调用：
     * manager.updateLogicFrame(dt);
     * manager.updateRenderFrame(dt);
     *
     * 本方法只是产生表现更新事件，
     * 不会直接设置节点位置或执行插值。
     */
    public updateRenderFrame(deltaTime: number): void {
        if (this.status !== MngFrameSyncStatus.RUNNING) {
            return;
        }

        this.renderFrameTime += Math.round(deltaTime * MngClientFrameSyncManager.TIME_SCALE);

        while (this.renderFrameTime >= this.renderFrameInterval) {
            this.renderFrameTime -= this.renderFrameInterval;
            this.currentRenderFrame++;

            // 把渲染帧号换算到逻辑帧时间线上。
            //
            // 默认逻辑15、渲染60，比例是 0.25：
            //
            // 渲染帧400 -> targetLogicFrame = 100
            // 渲染帧401 -> targetLogicFrame = 100.25
            // 渲染帧402 -> targetLogicFrame = 100.5
            //
            // 小数部分可以作为外部插值的参考。
            //
            // 注意：
            // 这里没有读取实际 currentLogicFrame，
            // 也没有保证所需的前后帧数据已经存在。
            const targetLogicFrame = this.currentRenderFrame * (this.config.logicFrameRate / this.config.renderFrameRate);

            this.emit(MngFrameSyncEventType.FRAME_UPDATE, {
                frame: this.currentRenderFrame,
                type: "render",
                targetLogicFrame,
            });
        }

        // 一次 update 可能连续发出多个 render 事件，
        // 但不代表屏幕在这次调用期间实际显示了多张画面。
    }

    // ==================== 接入本地输入 ====================

    /**
     * 将本地操作写入缓存。
     *
     * frameIndex：
     *   调用者传入的原始帧号。
     *
     * frameInfo：
     *   玩家及其操作信息。
     *
     * 本方法：
     * - 不发送消息。
     * - 不增加 currentLogicFrame。
     * - 不会立即调用 onClientFrame。
     */
    public addClientFrame(frameIndex: number, frameInfo: TFrameInfos): void {
        if (this.status !== MngFrameSyncStatus.RUNNING) {
            return;
        }

        // 映射到内部缓存帧号。
        //
        // 原始帧100 + delay5 -> 缓存帧105。
        const alignedFrameIndex = frameIndex + this.config.serverFrameDelay;

        // 对同一个缓存帧号再次写入，
        // Buffer 会替换对应的 clientFrame 引用。
        //
        // 不会自动变成105、106、107……
        // 也不会自动把多次传入的 infos 合并。
        this.frameBuffer.addClientFrame(alignedFrameIndex, frameInfo);

        this.logger.isDebugEnabled() && this.logger.log(`[产生客户端帧] 客户端帧号: ${frameIndex}, 对齐后帧号: ${alignedFrameIndex}, 当前逻辑帧: ${this.currentLogicFrame}`);

        // 只有启用预测，并且至少有一条操作，
        // 才尝试生成下一帧。
        if (this.config.enableLocalPredict && frameInfo?.infos?.length > 0) {
            // 当前实现只使用 infos[0] 作为预测入口。
            // 不是遍历当前帧中的全部操作分别预测。
            const localPlayerData = frameInfo.infos[0];

            const predictFrame = this.predictor.predictNextFrame(alignedFrameIndex, localPlayerData);

            if (predictFrame) {
                this.predictFrameCount++;

                // 当前缓存帧105 -> 预测数据放到106。
                this.frameBuffer.addClientFrame(alignedFrameIndex + 1, predictFrame);

                // 通知外部产生了预测结果。
                //
                // 此处仍然没有推进到106，
                // 也没有向服务器发送预测数据。
                this.emit(MngFrameSyncEventType.FRAME_PREDICT, {
                    frame: alignedFrameIndex + 1,
                    data: predictFrame,
                });
            }
        }
    }

    // ==================== 接入服务器数据 ====================

    /**
     * 接收一个服务器帧包。
     *
     * 正常情况下由 Driver 完成连续性检查、
     * 格式转换后调用。
     *
     * 注意：
     * 本方法自身不做服务器帧连续性检查，
     * 也没有过滤重复帧、旧帧或空 frameData。
     * 调用方需要提供有效数据。
     */
    public addServerFrame(frameData: TFrameData): void {
        if (this.status !== MngFrameSyncStatus.RUNNING) {
            // PAUSED 时传入的数据在这里直接不处理。
            // 本方法不会替你暂存到一个等待队列。
            return;
        }

        const serverFrameIndex = frameData.frameIndex;

        // 第一步：根据本次服务器帧号，
        // 判断是否需要首次对齐或大幅硬对齐。
        this.alignClientFrameToServer(serverFrameIndex);

        // 第二步：缓存、校正，并派发或收集业务数据。
        //
        // 非批处理时，这一步内部会调用 onServerFrame。
        this.processServerFrameData(frameData);

        // 第三步：记录目前接入过的最大服务器帧号。
        this.serverFrame = Math.max(this.serverFrame, serverFrameIndex);

        // 第四步：根据差距设置追帧欠账。
        // 这里通常只是记录，不是立即逐帧补跑。
        this.syncClientFrameWithServer();

        // 第五步：更新帧差换算出的延迟统计。
        this.updateNetworkStats();

        // 特别注意调用顺序：
        //
        // onServerFrame 回调发生在 serverFrame 更新之前。
        // 在该回调内部读取 getServerFrame() 或 getStats()，
        // 可能仍看到本次更新前的字段。
        //
        // 判断“当前这个包是哪一帧”，
        // 应直接看回调参数 frameData.frameIndex。
    }

    // ==================== 批处理入口 ====================

    /**
     * 开始 latest 模式。
     *
     * 批量接入期间只保留帧号最大的业务帧包，
     * 结束时最多派发一个。
     */
    public beginServerFrameBatch(): void {
        this.isServerFrameBatching = true;
        this.serverFrameBatchMode = "latest";

        // 开始新批次时，清掉上一批的待派发数据。
        // 这不是可嵌套的批处理栈。
        this.pendingServerFrameData = null;
        this.pendingServerFrameDataMap.clear();
    }

    /**
     * 开始 replay 模式。
     *
     * 收集每个帧号对应的业务帧包，
     * 结束时排序并交给业务回放。
     */
    public beginServerFrameReplayBatch(): void {
        this.isServerFrameBatching = true;
        this.serverFrameBatchMode = "replay";

        this.pendingServerFrameData = null;
        this.pendingServerFrameDataMap.clear();
    }

    /**
     * 结束批处理。
     *
     * flush = true：
     *   将收集到的数据派发给业务。
     *
     * flush = false：
     *   不派发，并清空待派发集合。
     *
     * 注意：
     * false 不会撤销批处理期间已经发生的：
     * 缓存写入、校正、统计变化、帧号对齐。
     */
    public endServerFrameBatch(flush: boolean = true): void {
        this.isServerFrameBatching = false;

        if (flush && this.dataHandler) {
            if (this.serverFrameBatchMode === "replay") {
                // Map 按帧号去重后，转换成数组并升序排序。
                const frames = Array.from(this.pendingServerFrameDataMap.values()).sort((a, b) => a.frameIndex - b.frameIndex);

                if (frames.length > 0) {
                    if (this.dataHandler.onServerFrameBatch) {
                        // 业务实现了批量接口：
                        // 一次性交出整个有序数组。
                        //
                        // 业务是否逐帧快速回放、
                        // 是否跳过动画等，由业务决定。
                        this.dataHandler.onServerFrameBatch(frames);
                    } else {
                        // 当前代码的降级行为：
                        // 只派发最后一帧。
                        //
                        // 不是逐帧调用 onServerFrame。
                        // 类型接口中的相关注释与此实现不一致，
                        // 阅读时以这里为准。
                        this.dataHandler.onServerFrame(frames[frames.length - 1]);
                    }
                }
            } else if (this.pendingServerFrameData) {
                // latest 模式：只派发保留下来的最大帧。
                this.dataHandler.onServerFrame(this.pendingServerFrameData);
            }
        }

        // 正常执行到这里后，释放待派发帧包引用。
        this.pendingServerFrameData = null;
        this.pendingServerFrameDataMap.clear();

        // 本方法不会在结束时主动重新计算追帧欠账。
    }

    // ==================== 收帧时的对齐 ====================

    /**
     * 根据“本次收到的服务器帧号”决定是否硬对齐。
     *
     * 硬对齐指：
     * 直接修改本地帧计数器和时间余量。
     *
     * 不等于执行被跳过的全部逻辑帧。
     */
    private alignClientFrameToServer(serverFrameIndex: number): void {
        const expectedLogicFrame = serverFrameIndex - this.config.serverFrameDelay;

        // ---------- 首次有效对齐 ----------

        if (this.isFirstServerFrame) {
            if (expectedLogicFrame > 0) {
                // 例如收到120，delay5：
                // 直接把本地逻辑帧设为115。
                this.syncFramesToLogicFrame(expectedLogicFrame);

                this.isFirstServerFrame = false;
            }

            // 首次阶段处理到此结束。
            //
            // 如果 expectedLogicFrame <= 0，
            // 本次不会清除 isFirstServerFrame。
            return;
        }

        // ---------- 后续大幅偏差对齐 ----------

        const frameDiff = serverFrameIndex - this.currentLogicFrame - this.config.serverFrameDelay;

        // 使用 Math.abs：
        //
        // 本地落后目标超过20帧，会向前跳。
        // 本地领先目标超过20帧，也可能向后调整。
        //
        // 不是仅处理“本地落后”。
        if (Math.abs(frameDiff) > 20 && expectedLogicFrame > 0) {
            this.syncFramesToLogicFrame(expectedLogicFrame);
        }

        // 这个方法没有检查 isServerFrameBatching。
        // 因此批量接入历史帧期间，也可能发生硬对齐。
    }

    /**
     * 对服务器帧包进行缓存、校正和业务派发。
     */
    private processServerFrameData(frameData: TFrameData): void {
        const serverFrameIndex = frameData.frameIndex;

        // frameData.frames 通常是“同一帧中各玩家的数据”。
        //
        // 所以下面的循环不是：
        // 第100帧、第101帧、第102帧……
        //
        // 而是：
        // 第100帧的玩家A、玩家B、玩家C……
        for (const serverFrame of frameData.frames || []) {
            this.frameBuffer.addServerFrame(serverFrameIndex, serverFrame);

            // 注意当前 Buffer 的结构：
            // 一个帧号只有一个 serverFrame 槽位。
            //
            // 如果这个循环处理多个玩家，
            // 后面的 serverFrame 会覆盖前面的 serverFrame。
            //
            // 但传给业务的完整 frameData.frames 仍在，
            // 不会因为这个缓存覆盖而只剩最后一个玩家。

            if (this.config.enableServerCorrection) {
                // 用当前玩家的服务器数据，
                // 补充或修正同帧 clientFrame。
                //
                // 校正器内部还会检查它自己的启用开关。
                const needCorrection = this.corrector.correctFrame(serverFrameIndex, serverFrame);

                if (needCorrection) {
                    this.correctFrameCount++;

                    // 事件携带的是这次处理的服务器玩家数据。
                    // 校正后的客户端缓存可从 Buffer 查询。
                    this.emit(MngFrameSyncEventType.FRAME_CORRECT, {
                        frame: serverFrameIndex,
                        data: serverFrame,
                    });
                }
            }
        }

        // 即使 frameData.frames 是空数组，
        // 只要有 dataHandler，整个 frameData 仍会走下面的派发。
        //
        // “没有玩家操作”也可能是业务需要消费的一个逻辑帧。
        if (this.dataHandler) {
            if (this.isServerFrameBatching) {
                if (this.serverFrameBatchMode === "replay") {
                    // 同一 frameIndex 只保留最后 set 的帧包。
                    this.pendingServerFrameDataMap.set(frameData.frameIndex, frameData);
                } else {
                    // latest 模式选择帧号最大的包。
                    //
                    // 相同帧号再次到来，也会用新引用替换旧引用。
                    if (!this.pendingServerFrameData || frameData.frameIndex >= this.pendingServerFrameData.frameIndex) {
                        this.pendingServerFrameData = frameData;
                    }
                }
            } else {
                // 非批处理：
                // 在接收调用链中同步回调业务。
                //
                // 不等待 currentLogicFrame 追到 serverFrameIndex。
                // 不等待下一次 updateLogicFrame。
                this.dataHandler.onServerFrame(frameData);
            }
        }

        // 当前代码只有 dataHandler 存在时，
        // 才会把帧包放入批处理待派发集合。
        //
        // 所以应在灌入帧数据前完成 setDataHandler。
    }

    /**
     * 根据已记录的服务器最大帧号，设置追帧欠账。
     *
     * 这个方法名字叫 sync，
     * 但它本身没有调用 advanceLogicFrameOnce。
     */
    private syncClientFrameWithServer(): void {
        if (this.isFirstServerFrame || this.isServerFrameBatching) {
            return;
        }

        const expectedLogicFrame = this.serverFrame - this.config.serverFrameDelay;

        if (expectedLogicFrame <= 0) {
            return;
        }

        const diff = expectedLogicFrame - this.currentLogicFrame;

        if (diff <= 0 || diff <= MngClientFrameSyncManager.MAX_SOFT_SYNC_DIFF) {
            // diff <= 0：已经同步或本地领先。
            // diff 在1~10：交给 updateLogicFrame 的小幅补跑。
            //
            // 原条件中 diff <= 0 已被 diff <= 10 包含，
            // 这里保留原代码。
            this._catchUpDebtLogicFrames = 0;
            return;
        }

        // 记录当前差距，而不是在旧欠账上累加。
        // 上限为20。
        //
        // 正常顺序下，大于20的偏差通常已经在
        // alignClientFrameToServer 中硬对齐过。
        this._catchUpDebtLogicFrames = Math.min(20, diff);
    }

    /**
     * 直接设置逻辑与渲染帧号。
     *
     * 这是“跳转计数器”，不是逐帧执行。
     */
    private syncFramesToLogicFrame(targetLogicFrame: number): void {
        this.currentLogicFrame = targetLogicFrame;

        // 按帧率比例换算渲染帧号。
        //
        // 默认60/15=4：
        // 逻辑帧115 -> 渲染帧460。
        this.currentRenderFrame = Math.floor(targetLogicFrame * (this.config.renderFrameRate / this.config.logicFrameRate));

        // 放弃原时间线中尚未消费的时间余量。
        this.logicFrameTime = 0;
        this.renderFrameTime = 0;

        // 本方法不会：
        // - 逐帧调用 onClientFrame；
        // - 发出被跳过各帧的 FRAME_UPDATE；
        // - 自动恢复游戏世界状态。
    }

    /**
     * 用帧差换算“时间差”统计。
     */
    private updateNetworkStats(): void {
        const frameDelay = this.serverFrame - this.currentLogicFrame;

        // 帧差 × 每帧微秒数 / 1000 -> 毫秒。
        //
        // 例如默认保留5帧差：
        // 5 × 66,666 / 1000 ≈ 333.33ms。
        //
        // 即使网络传输非常快，
        // 这个值也可能因为主动延迟而约为333ms。
        this.networkLatency = (frameDelay * this.logicFrameInterval) / 1000;

        this.logger.isDebugEnabled() && this.logger.log(`[添加服务器帧] 服务器帧号: ${this.serverFrame}, 当前逻辑帧: ${this.currentLogicFrame}, 网络延迟: ${this.networkLatency.toFixed(1)}ms`);

        // 只有 addServerFrame 的末尾会调用本方法。
        // 本地逻辑帧单独推进时，该统计不会立即重算。
        //
        // 如果本地领先服务器，计算结果也可能为负数。
    }

    // ==================== 查询接口 ====================

    public getCurrentLogicFrame(): number {
        return this.currentLogicFrame;
    }

    public getCurrentRenderFrame(): number {
        return this.currentRenderFrame;
    }

    public getServerFrame(): number {
        return this.serverFrame;
    }

    /**
     * 返回实际 Buffer 对象，不是只读副本。
     */
    public getFrameBuffer(): MngFrameBuffer<TFrameInfos> {
        return this.frameBuffer;
    }

    /**
     * 判断缓存是否存在这个 key。
     *
     * 这里使用缓存帧号，不自动加 delay。
     * 存在不等于有服务器确认，也不等于同时有两类数据。
     */
    public hasFrame(frameIndex: number): boolean {
        return this.frameBuffer.hasFrame(frameIndex);
    }

    /**
     * 返回当前统计字段组成的新对象。
     * 调用本方法不会重新计算 networkLatency。
     */
    public getStats(): MngFrameSyncStats {
        return {
            currentLogicFrame: this.currentLogicFrame,
            currentRenderFrame: this.currentRenderFrame,
            serverFrame: this.serverFrame,
            predictFrameCount: this.predictFrameCount,
            correctFrameCount: this.correctFrameCount,
            lostFrameCount: this.lostFrameCount,
            networkLatency: this.networkLatency,
        };
    }

    // ==================== 读取客户端缓存 ====================

    /**
     * 根据原始帧号读取一个客户端帧包。
     *
     * 可供外部发送逻辑使用，但本方法自己不发送。
     *
     * 例如：
     * addClientFrame(100, info) -> 缓存key105。
     * getClientFrameData(100) -> 查key105。
     * 返回的外层 frameIndex 仍然是100。
     */
    public getClientFrameData(frameIndex?: number): TFrameData | null {
        // 明确传0也是有效参数。
        //
        // 没传参数时，默认原始帧号为：
        // currentLogicFrame - 1。
        const originalFrame = frameIndex !== undefined ? frameIndex : this.currentLogicFrame - 1;

        const alignedFrame = originalFrame + this.config.serverFrameDelay;

        const frameInfo = this.frameBuffer.getClientFrame(alignedFrame);

        if (!frameInfo) {
            return null;
        }

        // 新建外层对象，但 frameInfo 仍是缓存中的对象引用。
        // 不是深拷贝。
        return {
            roomId: 1,
            frameIndex: originalFrame,
            frames: [frameInfo],
        } as unknown as TFrameData;
    }

    /**
     * 读取一个原始帧号区间内存在的客户端缓存。
     * 区间包含 startFrame 和 endFrame。
     *
     * 注意返回形式：
     * 它不是 TFrameData[]。
     *
     * 而是一个 TFrameData，
     * 把不同时间帧中的 TFrameInfos 放进同一个 frames 数组。
     *
     * 因而这里 frames 的组装方式，
     * 与通常“同一帧中的多个玩家”含义不同。
     * 调用方必须理解这种约定。
     */
    public getClientFramesData(startFrame: number, endFrame: number): TFrameData | null {
        const frames: TFrameInfos[] = [];

        // 两端都映射到内部缓存帧号。
        const alignedStart = startFrame + this.config.serverFrameDelay;

        const alignedEnd = endFrame + this.config.serverFrameDelay;

        for (let i = alignedStart; i <= alignedEnd; i++) {
            const frameInfo = this.frameBuffer.getClientFrame(i);

            if (frameInfo) {
                frames.push(frameInfo);
            }

            // 缺失的帧直接跳过，没有放入占位元素。
        }

        if (frames.length === 0) {
            return null;
        }

        // 外层只携带 endFrame。
        //
        // 本方法没有为每个数组元素附加原始帧号，
        // 如果区间中有缺口，不能仅凭数组下标可靠还原帧号。
        return {
            roomId: 1,
            frameIndex: endFrame,
            frames,
        } as unknown as TFrameData;
    }

    /**
     * 注入业务数据处理器。
     *
     * 与事件监听不同：
     * dataHandler 只有一个，新设置会替换旧引用；
     * eventCallbacks 则可以同一事件注册多个函数。
     */
    public setDataHandler(handler: IMngFrameDataHandler<TFrameData>): void {
        this.dataHandler = handler;
    }

    // ==================== 事件系统 ====================

    /**
     * 注册事件监听。
     *
     * 同一个函数重复注册会被重复保存，
     * 当前没有去重。
     */
    public on(eventType: MngFrameSyncEventType, callback: MngFrameSyncEventCallback): void {
        if (!this.eventCallbacks.has(eventType)) {
            this.eventCallbacks.set(eventType, []);
        }

        // ! 是 TypeScript 非空断言。
        // 前面保证了对应数组已经存在。
        this.eventCallbacks.get(eventType)!.push(callback);
    }

    /**
     * 注销一个监听。
     *
     * 必须传入注册时的同一个函数引用。
     * 新写一个内容相同的箭头函数，不是同一个引用。
     */
    public off(eventType: MngFrameSyncEventType, callback: MngFrameSyncEventCallback): void {
        const callbacks = this.eventCallbacks.get(eventType);

        if (!callbacks) {
            return;
        }

        const index = callbacks.indexOf(callback);

        if (index >= 0) {
            // 只删除第一个匹配项。
            callbacks.splice(index, 1);
        }
    }

    /**
     * 同步派发事件。
     *
     * callback 会在 emit 的调用栈中立即执行，
     * 不是等下一帧，也不是异步任务队列。
     */
    private emit(eventType: MngFrameSyncEventType, data: any): void {
        const callbacks = this.eventCallbacks.get(eventType);

        if (!callbacks) {
            return;
        }

        for (const callback of callbacks) {
            try {
                callback(data);
            } catch (error) {
                // 捕获当前监听函数同步抛出的异常。
                // 日志正常执行后，会继续后面的监听函数。
                this.logger.error(`[MngClientFrameSyncManager] 事件回调错误:`, error);
            }
        }

        // 注意：
        // dataHandler.onClientFrame/onServerFrame 等调用，
        // 没有复用这里的 try/catch。
        //
        // 如果数据处理器同步抛出异常，
        // 会中断其所在的调用链。
        //
        // 同时，此处也不会 await 异步监听函数返回的 Promise。
    }

    // ==================== 生命周期 ====================

    /**
     * 暂停管理器。
     *
     * 只修改状态，不清缓存、帧号或事件监听。
     *
     * 因为各入口检查 RUNNING，
     * 暂停期间：
     * - 不推进逻辑/渲染帧；
     * - addClientFrame 不接入数据；
     * - addServerFrame 不接入数据。
     *
     * 暂停期间的网络数据如需保留，必须由外部处理。
     */
    public pause(): void {
        if (this.status === MngFrameSyncStatus.RUNNING) {
            this.status = MngFrameSyncStatus.PAUSED;
        }
    }

    /**
     * 从暂停恢复。
     *
     * 保留帧号和缓存，但清掉暂停前的时间余量。
     */
    public resume(): void {
        if (this.status === MngFrameSyncStatus.PAUSED) {
            this.status = MngFrameSyncStatus.RUNNING;

            this.logicFrameTime = 0;
            this.renderFrameTime = 0;

            // 注意：
            // 这里只清内部累积值。
            // 如果外部下一次传入一个包含长时间暂停的巨大 dt，
            // updateLogicFrame 仍然会按这个 dt 补跑。
        }
    }

    /**
     * 停止并重置大部分运行数据。
     *
     * 当前实现把状态设回 UNINITIALIZED，
     * 而不是枚举里的 STOPPED。
     * 因此之后可以再次调用 init。
     */
    public stop(): void {
        this.status = MngFrameSyncStatus.UNINITIALIZED;

        // 重置时间线。
        this.currentLogicFrame = 0;
        this.currentRenderFrame = 0;
        this.serverFrame = 0;
        this.isFirstServerFrame = true;

        // 重置统计。
        this.predictFrameCount = 0;
        this.correctFrameCount = 0;
        this.lostFrameCount = 0;
        this.networkLatency = 0;

        // 重置累计时间。
        this.logicFrameTime = 0;
        this.renderFrameTime = 0;

        // 清空历史帧数据。
        this.frameBuffer.clear();

        // 当前未实际使用的队列也清空。
        this.serverFrameQueue = [];

        // 所有 on 注册的监听都会被移除。
        // stop 后重新 init，需要重新注册所需监听。
        this.eventCallbacks.clear();

        // 结束并清理批处理状态。
        this.isServerFrameBatching = false;
        this.serverFrameBatchMode = "latest";
        this.pendingServerFrameData = null;
        this.pendingServerFrameDataMap.clear();

        // 当前实现保留：
        // - config
        // - logger
        // - dataHandler
        // - predictor/corrector 对象及其自定义设置
        //
        // 当前实现也没有显式清零：
        // _catchUpDebtLogicFrames
        //
        // 因此不要把 stop 理解为完全恢复到构造刚结束的状态。
    }

    /**
     * 销毁管理器的业务连接。
     *
     * 先执行 stop，再解除数据处理器引用。
     * 它不是 Cocos Node 的 destroy。
     */
    public destroy(): void {
        this.stop();
        this.dataHandler = null;
    }
}