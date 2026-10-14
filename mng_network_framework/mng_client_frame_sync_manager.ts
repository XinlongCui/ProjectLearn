/* [学习注释]
 * 【本文件职责】客户端帧时钟、缓存调度、预测/校正调度以及业务回调。
 * 时间入口：updateLogicFrame(dt)、updateRenderFrame(dt)，dt单位是秒。
 * 数据入口：addClientFrame保存本地操作，addServerFrame接入服务器帧包。
 * 输出分两路：dataHandler的数据处理回调，以及on/emit的事件通知。
 * 本类没有sendFrame或MsgMgr，不负责发送消息，也不直接计算角色移动、碰撞和技能。
 * 本地缓存按currentLogicFrame查Map；普通服务器数据则在接收调用链中立即交给业务，没有统一FIFO消费队列。
 * 下面保留源代码全部语句。学习注释以当前实现为准，尤其注意批处理、硬对齐和统计的实际语义。
 * [/学习注释]
 */
/**
 * 帧同步框架 - 客户端帧同步管理器
 * 核心控制器，负责逻辑帧/渲染帧推进、服务器帧对齐、预测矫正、追帧策略
 * 与具体游戏逻辑无关，通过泛型 + IMngFrameDataHandler 解耦
 */

import { MngBaseFrameInfo, MngBaseFrameInfos, MngBaseFrameData } from "./mng_base_frame_data";
import { MngFrameSyncConfig, MNG_DEFAULT_FRAME_SYNC_CONFIG } from "./mng_frame_sync_config";
import { MngFrameSyncStatus, MngFrameSyncEventType, MngFrameSyncEventCallback, MngFrameSyncStats, IMngFrameDataHandler, IMngFrameSyncLogger, MNG_NULL_LOGGER } from "./mng_frame_sync_types";
import { MngFrameBuffer } from "./mng_frame_buffer";
import { MngFramePredictor } from "./mng_frame_predictor";
import { MngFrameCorrector } from "./mng_frame_corrector";

/* [学习注释]
 * 泛型TInfo=一条操作；TFrameInfos=一个玩家的一组操作；TFrameData=包含房间/帧号的完整帧包。
 * extends限制最小结构，等号提供默认类型；扩展类型不会自动扩展预测、校正行为。
 * [/学习注释]
 */
export class MngClientFrameSyncManager<
    TInfo extends MngBaseFrameInfo = MngBaseFrameInfo,
    TFrameInfos extends MngBaseFrameInfos<TInfo> = MngBaseFrameInfos<TInfo>,
    TFrameData extends MngBaseFrameData<TFrameInfos> = MngBaseFrameData<TFrameInfos>
> {
    /* [学习注释]
     * 保存合并后的配置副本。帧率用于帧号比例换算，interval用于实际时间推进，两者必须匹配。
     * [/学习注释]
     */
    private config: MngFrameSyncConfig;
    /* [学习注释]
     * 构造后未运行，init才进入RUNNING；暂停时update和add数据入口均直接return。
     * [/学习注释]
     */
    private status: MngFrameSyncStatus = MngFrameSyncStatus.UNINITIALIZED;

    /* [学习注释]
     * 共享历史缓存：Map<帧号,{clientFrame,serverFrame,confirmed,timestamp}>。
     * Predictor和Corrector持有同一个Buffer，不会各自复制独立历史。
     * [/学习注释]
     */
    private frameBuffer: MngFrameBuffer<TFrameInfos>;
    /* [学习注释]
     * 下一帧基础坐标预测器；默认配置关闭，启用后由addClientFrame调用。
     * [/学习注释]
     */
    private predictor: MngFramePredictor<TInfo, TFrameInfos>;
    /* [学习注释]
     * 服务器数据对客户端缓存的合并/校正器，不是完整世界快照回滚器。
     * [/学习注释]
     */
    private corrector: MngFrameCorrector<TInfo, TFrameInfos>;

    /* [学习注释]
     * 本地逻辑计数器，通常一次advance加1，也可能被硬对齐直接修改。不是已发送的消息数量。
     * [/学习注释]
     */
    private currentLogicFrame: number = 0;
    /* [学习注释]
     * 框架渲染节拍计数，不是屏幕实际呈现的画面数；一次update可能连续发出多个render事件。
     * [/学习注释]
     */
    private currentRenderFrame: number = 0;
    /* [学习注释]
     * 已接入服务器帧号的最大值，Math.max保证此字段不回退。它不代表业务已经逐帧模拟到这里。
     * [/学习注释]
     */
    private serverFrame: number = 0;
    /* [学习注释]
     * 实际上表示“尚未完成首次有效对齐”。只有服务器帧号-delay>0时才清除，不一定收到首包就变false。
     * [/学习注释]
     */
    private isFirstServerFrame: boolean = true;

    /** 追帧策略常量 */
    /* [学习注释]
     * 相对目标最多落后10帧走小幅补跑；目标=服务器帧-delay。
     * [/学习注释]
     */
    private static readonly MAX_SOFT_SYNC_DIFF: number = 10;
    /* [学习注释]
     * 小差距每次update最多额外补2帧；不包括前面按dt正常推进的帧数。
     * [/学习注释]
     */
    private static readonly MAX_CATCH_UP_LOGIC_FRAMES_PER_UPDATE: number = 2;
    /* [学习注释]
     * 较大差距按欠账每次最多额外补6帧；不是正常时间推进while循环的上限。
     * [/学习注释]
     */
    private static readonly MAX_FAST_CATCH_UP_LOGIC_FRAMES_PER_UPDATE: number = 6;
    /* [学习注释]
     * 收到服务器帧时记录的剩余追帧欠账，update里实际补跑后递减。当前stop未显式清零此字段。
     * [/学习注释]
     */
    private _catchUpDebtLogicFrames: number = 0;

    /* [学习注释]
     * 有效预测结果累计次数，预测器复用已存在下一帧也可能计数；非严格去重新增帧数。
     * [/学习注释]
     */
    private predictFrameCount: number = 0;
    /* [学习注释]
     * correctFrame返回true的累计次数，包括从服务器创建/追加缓存；同一个时间帧的多个玩家可累计多次。
     * [/学习注释]
     */
    private correctFrameCount: number = 0;
    /* [学习注释]
     * 缓存缺口累计检测数；同一缺口可能被相邻逻辑步反复检出，不等于去重网络丢帧数。
     * [/学习注释]
     */
    private lostFrameCount: number = 0;
    /* [学习注释]
     * 帧差×逻辑间隔得到的毫秒估计，含主动delay；不是网络请求往返耗时RTT。
     * [/学习注释]
     */
    private networkLatency: number = 0;

    /* [学习注释]
     * 一个事件可注册多个函数；同步遍历调用。dataHandler则是下面单独持有的一个对象。
     * [/学习注释]
     */
    private eventCallbacks: Map<MngFrameSyncEventType, MngFrameSyncEventCallback[]> = new Map();
    /* [学习注释]
     * 玩法注入的消费者：onClientFrame、onServerFrame及可选onServerFrameBatch。未设置就不派发帧数据。
     * [/学习注释]
     */
    private dataHandler: IMngFrameDataHandler<TFrameData> | null = null;
    /* [学习注释]
     * 空日志器默认不输出；通过setLogger注入项目实现。
     * [/学习注释]
     */
    private logger: IMngFrameSyncLogger = MNG_NULL_LOGGER;

    /** 微秒精度时间管理，避免浮点数累积误差 */
    /* [学习注释]
     * 秒转微秒：1秒=1000000微秒。整数累计减少小数累积误差，但round仍有微秒级量化。
     * [/学习注释]
     */
    private static readonly TIME_SCALE: number = 1000000;
    /* [学习注释]
     * 已累计但尚未消费的时间余量，单位微秒。例如80000扣66666后留下13334等待下次update。
     * [/学习注释]
     */
    private logicFrameTime: number = 0;
    /* [学习注释]
     * 单个逻辑步需要的微秒数；默认66666。调用者配置必须是有效正数，否则while无法正常推进。
     * [/学习注释]
     */
    private logicFrameInterval: number = 0;
    /* [学习注释]
     * 渲染节拍有独立时间余量，不与逻辑累加器共享。
     * [/学习注释]
     */
    private renderFrameTime: number = 0;
    /* [学习注释]
     * 单个渲染节拍的微秒间隔；默认16666。
     * [/学习注释]
     */
    private renderFrameInterval: number = 0;

    /* [学习注释]
     * 当前仅声明和stop时清空，没有入队、出队或消费逻辑。真正本地帧存储在frameBuffer的Map中。
     * [/学习注释]
     */
    private serverFrameQueue: TFrameInfos[] = [];

    /** 服务器帧批处理（重连/进房追帧回放） */
    /* [学习注释]
     * 批处理主要延后业务数据派发，不会阻止缓存、校正、硬对齐；只抑制额外追帧部分。
     * [/学习注释]
     */
    private isServerFrameBatching: boolean = false;
    /* [学习注释]
     * latest只保留最大的帧包；replay按帧号收集，结束时排序交给业务。
     * [/学习注释]
     */
    private serverFrameBatchMode: "latest" | "replay" = "latest";
    /* [学习注释]
     * latest模式的单个待交付包，保存引用，不做深拷贝。
     * [/学习注释]
     */
    private pendingServerFrameData: TFrameData | null = null;
    /* [学习注释]
     * replay模式Map，以frameIndex去重；同帧新包覆盖旧包，结束时按key对应帧号排序。
     * [/学习注释]
     */
    private pendingServerFrameDataMap: Map<number, TFrameData> = new Map();

    /* [学习注释]
     * Partial允许只覆盖部分配置；Object.assign创建新对象。此处创建组件，不启动Manager。
     * 只改logicFrameRate不会自动重算logicFrameInterval；如20Hz，需同时传1/20秒间隔。
     * [/学习注释]
     */
    constructor(config?: Partial<MngFrameSyncConfig>) {
        this.config = Object.assign({}, MNG_DEFAULT_FRAME_SYNC_CONFIG, config);
        this.frameBuffer = new MngFrameBuffer<TFrameInfos>(this.config.maxFrameCache);
        this.predictor = new MngFramePredictor<TInfo, TFrameInfos>(this.frameBuffer, this.config.enableLocalPredict);
        this.corrector = new MngFrameCorrector<TInfo, TFrameInfos>(this.frameBuffer, this.config.enableServerCorrection);
        /* [学习注释]
         * 内部把配置秒数转为整数微秒。默认0.066666×1000000=66666，而非无限精度的1/15。
         * [/学习注释]
         */
        this.logicFrameInterval = Math.round(this.config.logicFrameInterval * MngClientFrameSyncManager.TIME_SCALE);
        this.renderFrameInterval = Math.round(this.config.renderFrameInterval * MngClientFrameSyncManager.TIME_SCALE);
    }

    /**
     * 设置日志器
     * @param logger 日志器实现
     */
    /* [学习注释]
     * 替换Manager日志对象；其他独立Protocol的日志需由接入方另外设置。
     * [/学习注释]
     */
    public setLogger(logger: IMngFrameSyncLogger): void {
        this.logger = logger;
    }

    /** 获取帧矫正器（用于设置钩子等） */
    /* [学习注释]
     * 返回实际校正器，可设置normalizeDirection、getPlayerKey和位置误差阈值。
     * [/学习注释]
     */
    public getCorrector(): MngFrameCorrector<TInfo, TFrameInfos> { return this.corrector; }

    /** 获取帧预测器 */
    /* [学习注释]
     * 返回实际预测器。其开关与Manager配置是两层门控，单独开启内部开关不一定触发调用。
     * [/学习注释]
     */
    public getPredictor(): MngFramePredictor<TInfo, TFrameInfos> { return this.predictor; }

    /** 初始化（从 UNINITIALIZED 进入 RUNNING） */
    /* [学习注释]
     * 只有UNINITIALIZED能启动；PAUSED应调用resume。清计时余量、等待首次对齐，再发启动事件。
     * 这里没有增加currentLogicFrame，也没有立即开始定时循环，仍需外部update调用。
     * [/学习注释]
     */
    public init(): void {
        if (this.status !== MngFrameSyncStatus.UNINITIALIZED) {
            return;
        }
        this.status = MngFrameSyncStatus.RUNNING;
        this.logicFrameTime = 0;
        this.renderFrameTime = 0;
        this.isFirstServerFrame = true;
        /* [学习注释]
         * 这是启动通知，没有type字段；监听者不能把所有FRAME_UPDATE都当成一次logic或render更新。
         * [/学习注释]
         */
        this.emit(MngFrameSyncEventType.FRAME_UPDATE, { frame: this.currentLogicFrame, status: this.status });
    }

    /**
     * 更新逻辑帧（由游戏主循环调用）
     * @param deltaTime 时间差（秒）
     */
    /* [学习注释]
     * 由外部主循环输入秒单位dt。A段按时间正常推进，B段按服务器进度额外补跑。
     * 每次推进的是逻辑时间编号，不等于每次发包或每次都存在可消费数据。
     * [/学习注释]
     */
    public updateLogicFrame(deltaTime: number): void {
        if (this.status !== MngFrameSyncStatus.RUNNING) {
            return;
        }

        /* [学习注释]
         * 累加本次经过时间；不足一个逻辑步就留下，等待后续update。
         * [/学习注释]
         */
        this.logicFrameTime += Math.round(deltaTime * MngClientFrameSyncManager.TIME_SCALE);
        /* [学习注释]
         * 使用while处理卡顿后积累的多个步长。例如dt=0.2秒约补3个逻辑步。
         * 这段没有最大执行次数限制；固定步长不意味着真实执行时间均匀间隔。
         * [/学习注释]
         */
        while (this.logicFrameTime >= this.logicFrameInterval) {
            this.logicFrameTime -= this.logicFrameInterval;
            this.advanceLogicFrameOnce();
        }

        // 追帧策略：小落后少量补跑，中等落后按欠账逐步追赶
        /* [学习注释]
         * B段：首次对齐完成且非批处理，才考虑额外追帧。A段正常按dt推进不受此条件限制。
         * [/学习注释]
         */
        if (!this.isFirstServerFrame && !this.isServerFrameBatching) {
            /* [学习注释]
             * 例：服务器120、delay5，期望本地115；这份目标是在正常时间推进之后用于追赶判断。
             * [/学习注释]
             */
            const expectedLogicFrame = this.serverFrame - this.config.serverFrameDelay;
            if (expectedLogicFrame > 0 && this.currentLogicFrame < expectedLogicFrame) {
                const diff = expectedLogicFrame - this.currentLogicFrame;
                if (diff <= MngClientFrameSyncManager.MAX_SOFT_SYNC_DIFF) {
                    /* [学习注释]
                     * 差距1~10时，每次额外补最多2帧。例如本地110、目标115，本次额外走111和112。
                     * [/学习注释]
                     */
                    const steps = Math.min(MngClientFrameSyncManager.MAX_CATCH_UP_LOGIC_FRAMES_PER_UPDATE, diff);
                    for (let i = 0; i < steps; i++) {
                        this.advanceLogicFrameOnce();
                    }
                    this._catchUpDebtLogicFrames = 0;
                /* [学习注释]
                 * 差距超过10且存在欠账才补较大批次；每次最多6步，并同时防止超出目标。
                 * 额外步不会扣logicFrameTime，因为它们是在正常时间之外主动追赶的。
                 * [/学习注释]
                 */
                } else if (this._catchUpDebtLogicFrames > 0) {
                    let steps = Math.min(
                        MngClientFrameSyncManager.MAX_FAST_CATCH_UP_LOGIC_FRAMES_PER_UPDATE,
                        this._catchUpDebtLogicFrames
                    );
                    while (steps > 0 && this._catchUpDebtLogicFrames > 0 && this.currentLogicFrame < expectedLogicFrame) {
                        this.advanceLogicFrameOnce();
                        this._catchUpDebtLogicFrames--;
                        steps--;
                    }
                }
            } else {
                this._catchUpDebtLogicFrames = 0;
            }
        }
    }

    /** 推进 1 个逻辑帧 */
    /* [学习注释]
     * 统一的一步：帧号+1→清旧缓存→检查缺口→读当前clientFrame→调用处理器→发logic事件。
     * 正常推进和额外追帧都复用此方法，不会自动检查服务器是否已确认当前帧。
     * [/学习注释]
     */
    private advanceLogicFrameOnce(): void {
        this.currentLogicFrame++;

        /* [学习注释]
         * 保留近maxFrameCache帧范围。例：当前1000、窗口600，清理key<400，400本身保留。
         * [/学习注释]
         */
        const cleanupFrame = this.currentLogicFrame - this.config.maxFrameCache;
        if (cleanupFrame > 0) {
            this.frameBuffer.cleanup(cleanupFrame);
        }

        /* [学习注释]
         * Buffer默认回溯近10帧，查Map key缺失，而不是缺少服务器确认。这里只发事件，不自动发补帧请求。
         * [/学习注释]
         */
        const lostFrames = this.frameBuffer.checkLostFrames(this.currentLogicFrame);
        if (lostFrames.length > 0) {
            this.lostFrameCount += lostFrames.length;
            this.emit(MngFrameSyncEventType.FRAME_LOST, { frames: lostFrames, count: lostFrames.length });
        }

        /* [学习注释]
         * 按currentLogicFrame直接读内部key，不再加delay。无数据则不调用onClientFrame，但帧号仍前进。
         * 消费后不出队删除，记录继续保留供校正和查询；clientFrame也可能由服务器校正器创建。
         * [/学习注释]
         */
        const clientFrame = this.frameBuffer.getClientFrame(this.currentLogicFrame);
        if (clientFrame && this.dataHandler) {
            /* [学习注释]
             * 将一个玩家操作组包装成完整帧包，roomId固定为1。
             * as unknown as只影响TS检查，不会运行玩法构造函数、补充扩展字段或深拷贝内部对象。
             * [/学习注释]
             */
            const frameData = {
                roomId: 1,
                frameIndex: this.currentLogicFrame,
                frames: [clientFrame],
            } as unknown as TFrameData;
            /* [学习注释]
             * 真正交出缓存供业务处理的时刻；addClientFrame本身不会立即调用这里。
             * 此回调没有try/catch，若业务抛出同步异常，会中断本次推进后续流程。
             * [/学习注释]
             */
            this.dataHandler.onClientFrame(frameData);
        }

        /* [学习注释]
         * 即使当前没有clientFrame，正常执行到这里仍会通知logic节拍。它与数据处理回调不是同一概念。
         * [/学习注释]
         */
        this.emit(MngFrameSyncEventType.FRAME_UPDATE, { frame: this.currentLogicFrame, type: "logic" });
    }

    /**
     * 更新渲染帧（由游戏主循环调用）
     * @param deltaTime 时间差（秒）
     */
    /* [学习注释]
     * 按独立累加器推进渲染节拍，只emit事件，不设置节点位置、不实现插值、不配置Cocos实际FPS。
     * [/学习注释]
     */
    public updateRenderFrame(deltaTime: number): void {
        if (this.status !== MngFrameSyncStatus.RUNNING) {
            return;
        }

        this.renderFrameTime += Math.round(deltaTime * MngClientFrameSyncManager.TIME_SCALE);
        while (this.renderFrameTime >= this.renderFrameInterval) {
            this.renderFrameTime -= this.renderFrameInterval;
            this.currentRenderFrame++;
            /* [学习注释]
             * 按渲染编号×逻辑帧率/渲染帧率换算连续逻辑时间。默认渲染401对应100.25。
             * 这里只是参考时间，不保证前后帧已到达，也未读取currentLogicFrame进行校验。
             * [/学习注释]
             */
            const targetLogicFrame = this.currentRenderFrame * (this.config.logicFrameRate / this.config.renderFrameRate);
            this.emit(MngFrameSyncEventType.FRAME_UPDATE, {
                frame: this.currentRenderFrame,
                type: "render",
                targetLogicFrame,
            });
        }
    }

    /**
     * 添加客户端帧数据（本地玩家操作）
     * 客户端帧号会加上 serverFrameDelay 后存储，以便与服务器帧对齐
     */
    /* [学习注释]
     * 本地输入入口：映射key并缓存；不增加逻辑帧号、不发送消息、不立即调用onClientFrame。
     * [/学习注释]
     */
    public addClientFrame(frameIndex: number, frameInfo: TFrameInfos): void {
        if (this.status !== MngFrameSyncStatus.RUNNING) {
            return;
        }

        /* [学习注释]
         * 原始帧100、delay5→key105；重复写100仍落到105，覆盖该槽位，不自动排成106、107。
         * [/学习注释]
         */
        const alignedFrameIndex = frameIndex + this.config.serverFrameDelay;
        this.frameBuffer.addClientFrame(alignedFrameIndex, frameInfo);

        this.logger.isDebugEnabled() &&
            this.logger.log(`[产生客户端帧] 客户端帧号: ${frameIndex}, 对齐后帧号: ${alignedFrameIndex}, 当前逻辑帧: ${this.currentLogicFrame}`);

        if (this.config.enableLocalPredict && frameInfo?.infos?.length > 0) {
            /* [学习注释]
             * 只取infos[0]预测；不是对本帧全部操作和全部玩家分别预测。
             * [/学习注释]
             */
            const localPlayerData = frameInfo.infos[0];
            const predictFrame = this.predictor.predictNextFrame(alignedFrameIndex, localPlayerData);
            if (predictFrame) {
                this.predictFrameCount++;
                /* [学习注释]
                 * 预测结果放下一缓存帧。例如105→106，但不代表逻辑时间已推进到106，也不自动发送预测包。
                 * [/学习注释]
                 */
                this.frameBuffer.addClientFrame(alignedFrameIndex + 1, predictFrame);
                this.emit(MngFrameSyncEventType.FRAME_PREDICT, { frame: alignedFrameIndex + 1, data: predictFrame });
            }
        }
    }

    /**
     * 添加服务器帧数据
     * 流程：帧号对齐 -> 处理帧数据 -> 更新服务器帧号 -> 同步客户端帧号 -> 更新统计
     */
    /* [学习注释]
     * 服务器入口不做连续性、旧帧、重复帧或空参校验，这些通常交给Driver/调用方。
     * PAUSED等非RUNNING状态直接忽略数据，不会暂存到serverFrameQueue。
     * [/学习注释]
     */
    public addServerFrame(frameData: TFrameData): void {
        if (this.status !== MngFrameSyncStatus.RUNNING) {
            return;
        }

        const serverFrameIndex = frameData.frameIndex;
        /* [学习注释]
         * 严格顺序：先硬对齐→处理包及业务回调→更新serverFrame最大值→记录追帧欠账→更新统计。
         * 所以onServerFrame回调内部读getServerFrame/getStats可能仍是此次包之前的值，当前包帧号看参数。
         * [/学习注释]
         */
        this.alignClientFrameToServer(serverFrameIndex);
        this.processServerFrameData(frameData);
        this.serverFrame = Math.max(this.serverFrame, serverFrameIndex);
        this.syncClientFrameWithServer();
        this.updateNetworkStats();
    }

    /** 开始服务器帧批处理（重连/进房灌历史帧） */
    /* [学习注释]
     * 开启latest并清上一批待派发内容；非嵌套批处理，重复begin会丢弃尚未派发的收集结果。
     * [/学习注释]
     */
    public beginServerFrameBatch(): void {
        this.isServerFrameBatching = true;
        this.serverFrameBatchMode = "latest";
        this.pendingServerFrameData = null;
        this.pendingServerFrameDataMap.clear();
    }

    /** 开始服务器帧追帧回放批处理 */
    /* [学习注释]
     * 开启replay；收集所有不同帧号的包用于有序历史回放，业务需要实现批量接口。
     * [/学习注释]
     */
    public beginServerFrameReplayBatch(): void {
        this.isServerFrameBatching = true;
        this.serverFrameBatchMode = "replay";
        this.pendingServerFrameData = null;
        this.pendingServerFrameDataMap.clear();
    }

    /**
     * 结束服务器帧批处理
     * @param flush 是否派发一次数据到逻辑层（默认 true）
     */
    /* [学习注释]
     * flush=true派发、false仅清掉待交付集合。false不回滚缓存/校正/帧号/统计。
     * 结束本身不会重新计算追帧欠账；回调抛错时也没有finally保证最后的清理执行。
     * [/学习注释]
     */
    public endServerFrameBatch(flush: boolean = true): void {
        this.isServerFrameBatching = false;
        if (flush && this.dataHandler) {
            if (this.serverFrameBatchMode === "replay") {
                /* [学习注释]
                 * Map同帧去重后转数组、按帧号升序。传递的是原始对象引用，消费速度和表现裁剪由业务控制。
                 * [/学习注释]
                 */
                const frames = Array.from(this.pendingServerFrameDataMap.values()).sort((a, b) => a.frameIndex - b.frameIndex);
                if (frames.length > 0) {
                    if (this.dataHandler.onServerFrameBatch) {
                        this.dataHandler.onServerFrameBatch(frames);
                    } else {
                        /* [学习注释]
                         * 当前实际降级是“只交最后一帧”，不是类型注释所说的逐帧回调；需要历史输入的玩法不可依赖此降级。
                         * [/学习注释]
                         */
                        this.dataHandler.onServerFrame(frames[frames.length - 1]);
                    }
                }
            } else if (this.pendingServerFrameData) {
                this.dataHandler.onServerFrame(this.pendingServerFrameData);
            }
        }
        this.pendingServerFrameData = null;
        this.pendingServerFrameDataMap.clear();
    }

    /** 对齐客户端逻辑帧号到服务器帧号 */
    /* [学习注释]
     * 收帧时根据本次包的帧号决定硬对齐；不是根据最大serverFrame。此函数批处理中也会运行。
     * [/学习注释]
     */
    private alignClientFrameToServer(serverFrameIndex: number): void {
        const expectedLogicFrame = serverFrameIndex - this.config.serverFrameDelay;

        /* [学习注释]
         * 目标>0才首次对齐并清标志；否则继续等待有效目标，所以收到帧不一定完成首次对齐。
         * [/学习注释]
         */
        if (this.isFirstServerFrame) {
            if (expectedLogicFrame > 0) {
                this.syncFramesToLogicFrame(expectedLogicFrame);
                this.isFirstServerFrame = false;
            }
            return;
        }

        const frameDiff = serverFrameIndex - this.currentLogicFrame - this.config.serverFrameDelay;
        /* [学习注释]
         * 绝对差超过20才硬对齐：本地过慢向前跳，本地过快也可能向后调。
         * 直接改计数器，不会执行跳过的全部onClientFrame或撤销已经执行的业务。
         * [/学习注释]
         */
        if (Math.abs(frameDiff) > 20 && expectedLogicFrame > 0) {
            this.syncFramesToLogicFrame(expectedLogicFrame);
        }
    }

    /** 处理服务器帧数据 */
    /* [学习注释]
     * 逐玩家缓存/校正，然后把完整包立即派发或收进批处理集合。空frames仍可把外层包交给业务。
     * [/学习注释]
     */
    private processServerFrameData(frameData: TFrameData): void {
        const serverFrameIndex = frameData.frameIndex;

        /* [学习注释]
         * frames通常是同一时间帧中的多个玩家，不是连续多个时间帧。这里循环始终用同一个serverFrameIndex。
         * [/学习注释]
         */
        for (const serverFrame of frameData.frames || []) {
            /* [学习注释]
             * Buffer每key只有一个serverFrame槽位，多玩家写入会覆盖到最后一个；完整frameData.frames仍原样交给业务。
             * [/学习注释]
             */
            this.frameBuffer.addServerFrame(serverFrameIndex, serverFrame);

            if (this.config.enableServerCorrection) {
                /* [学习注释]
                 * 校正器可能修改已有clientFrame或创建它；返回true也可能只是新增数据，不只意味着预测偏差。
                 * [/学习注释]
                 */
                const needCorrection = this.corrector.correctFrame(serverFrameIndex, serverFrame);
                if (needCorrection) {
                    this.correctFrameCount++;
                    this.emit(MngFrameSyncEventType.FRAME_CORRECT, { frame: serverFrameIndex, data: serverFrame });
                }
            }
        }

        if (this.dataHandler) {
            if (this.isServerFrameBatching) {
                if (this.serverFrameBatchMode === "replay") {
                    /* [学习注释]
                     * replay按帧号保存，重复key覆盖。此分支位于if(dataHandler)内，未设置处理器就不会收集待派发包。
                     * [/学习注释]
                     */
                    this.pendingServerFrameDataMap.set(frameData.frameIndex, frameData);
                } else {
                    if (!this.pendingServerFrameData || frameData.frameIndex >= this.pendingServerFrameData.frameIndex) {
                        this.pendingServerFrameData = frameData;
                    }
                }
            } else {
                /* [学习注释]
                 * 普通模式的服务器数据在这里同步回调，不等下一次update，也不等待本地逻辑帧追到服务器帧号。
                 * [/学习注释]
                 */
                this.dataHandler.onServerFrame(frameData);
            }
        }
    }

    /** 同步客户端逻辑帧号跟随服务器帧号 */
    /* [学习注释]
     * 只记录欠账，不直接advance。首次未对齐或批处理中直接返回。
     * [/学习注释]
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
        /* [学习注释]
         * 同步/领先或仅落后1~10时清欠账，小差距留给update中的软补跑。原条件前半段被后半段包含。
         * [/学习注释]
         */
        if (diff <= 0 || diff <= MngClientFrameSyncManager.MAX_SOFT_SYNC_DIFF) {
            this._catchUpDebtLogicFrames = 0;
            return;
        }
        /* [学习注释]
         * 根据当前差距覆盖欠账、最多20；不是在旧欠账上继续累加。
         * [/学习注释]
         */
        this._catchUpDebtLogicFrames = Math.min(20, diff);
    }

    /** 同步逻辑帧和渲染帧到指定帧号 */
    /* [学习注释]
     * 直接设置逻辑帧与按比例换算的渲染帧，并清计时余量。不会逐帧回调、不会恢复世界快照。
     * [/学习注释]
     */
    private syncFramesToLogicFrame(targetLogicFrame: number): void {
        this.currentLogicFrame = targetLogicFrame;
        this.currentRenderFrame = Math.floor(targetLogicFrame * (this.config.renderFrameRate / this.config.logicFrameRate));
        this.logicFrameTime = 0;
        this.renderFrameTime = 0;
    }

    /** 更新网络统计信息 */
    /* [学习注释]
     * 当前帧差×内部逻辑间隔换算毫秒。例如默认差5帧约333.33ms，包含主动delay，不能当网络RTT。
     * 只有收帧末尾更新，本地单独推进不会即时重算；本地领先时结果还可能是负数。
     * [/学习注释]
     */
    private updateNetworkStats(): void {
        const frameDelay = this.serverFrame - this.currentLogicFrame;
        // 转换为毫秒：frameDelay * logicFrameInterval(μs) / 1000
        this.networkLatency = (frameDelay * this.logicFrameInterval) / 1000;

        this.logger.isDebugEnabled() &&
            this.logger.log(`[添加服务器帧] 服务器帧号: ${this.serverFrame}, 当前逻辑帧: ${this.currentLogicFrame}, 网络延迟: ${this.networkLatency.toFixed(1)}ms`);
    }

    // ========== 公共查询接口 ==========

    /* [学习注释]
     * 返回逻辑计数器。
     * [/学习注释]
     */
    public getCurrentLogicFrame(): number { return this.currentLogicFrame; }
    /* [学习注释]
     * 返回框架渲染节拍计数。
     * [/学习注释]
     */
    public getCurrentRenderFrame(): number { return this.currentRenderFrame; }
    /* [学习注释]
     * 返回已接入服务器最大帧号。
     * [/学习注释]
     */
    public getServerFrame(): number { return this.serverFrame; }
    /* [学习注释]
     * 返回实际可变Buffer引用，不是只读副本。
     * [/学习注释]
     */
    public getFrameBuffer(): MngFrameBuffer<TFrameInfos> { return this.frameBuffer; }
    /* [学习注释]
     * 参数是内部缓存key，不加delay；只判断有记录，不表示已经服务器确认。
     * [/学习注释]
     */
    public hasFrame(frameIndex: number): boolean { return this.frameBuffer.hasFrame(frameIndex); }

    /* [学习注释]
     * 创建新的统计外壳对象，不触发网络测量或重算字段。
     * [/学习注释]
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

    /**
     * 获取客户端帧数据（用于发送给服务器）
     * 获取时使用对齐后帧号，返回的 frameIndex 使用原始帧号
     */
    /* [学习注释]
     * 按原始帧号取数据：100→查105→返回外层frameIndex仍100。未传参数时默认currentLogicFrame-1。
     * roomId写死1，内部frameInfo仍引用缓存对象，方法本身不发送。
     * [/学习注释]
     */
    public getClientFrameData(frameIndex?: number): TFrameData | null {
        const originalFrame = frameIndex !== undefined ? frameIndex : this.currentLogicFrame - 1;
        const alignedFrame = originalFrame + this.config.serverFrameDelay;
        const frameInfo = this.frameBuffer.getClientFrame(alignedFrame);
        if (!frameInfo) {
            return null;
        }
        return {
            roomId: 1,
            frameIndex: originalFrame,
            frames: [frameInfo],
        } as unknown as TFrameData;
    }

    /**
     * 获取多帧客户端数据
     * @param startFrame 起始帧号（原始）
     * @param endFrame 结束帧号（原始）
     */
    /* [学习注释]
     * 扫描原始闭区间，跳过缺失项，把多个时间帧的玩家组装进一个frames数组，外层frameIndex=endFrame。
     * 不是TFrameData[]，也不为每项附上时间帧号；有缺口时不能仅用下标还原帧号。
     * [/学习注释]
     */
    public getClientFramesData(startFrame: number, endFrame: number): TFrameData | null {
        const frames: TFrameInfos[] = [];
        const alignedStart = startFrame + this.config.serverFrameDelay;
        const alignedEnd = endFrame + this.config.serverFrameDelay;
        for (let i = alignedStart; i <= alignedEnd; i++) {
            const frameInfo = this.frameBuffer.getClientFrame(i);
            if (frameInfo) {
                frames.push(frameInfo);
            }
        }
        if (frames.length === 0) {
            return null;
        }
        return {
            roomId: 1,
            frameIndex: endFrame,
            frames,
        } as unknown as TFrameData;
    }

    /** 设置数据处理器 */
    /* [学习注释]
     * 替换唯一业务处理器，建议在任何灌帧前设置；不会回放设置之前错过的包。
     * [/学习注释]
     */
    public setDataHandler(handler: IMngFrameDataHandler<TFrameData>): void {
        this.dataHandler = handler;
    }

    // ========== 事件系统 ==========

    /* [学习注释]
     * 添加监听，不去重。相同函数重复注册就会重复调用；!是TS非空断言，不改变运行时。
     * [/学习注释]
     */
    public on(eventType: MngFrameSyncEventType, callback: MngFrameSyncEventCallback): void {
        if (!this.eventCallbacks.has(eventType)) {
            this.eventCallbacks.set(eventType, []);
        }
        this.eventCallbacks.get(eventType)!.push(callback);
    }

    /* [学习注释]
     * 按函数对象引用删除第一个匹配项。重新创建内容相同的箭头函数无法注销旧引用。
     * [/学习注释]
     */
    public off(eventType: MngFrameSyncEventType, callback: MngFrameSyncEventCallback): void {
        const callbacks = this.eventCallbacks.get(eventType);
        if (!callbacks) {
            return;
        }
        const index = callbacks.indexOf(callback);
        if (index >= 0) {
            callbacks.splice(index, 1);
        }
    }

    /* [学习注释]
     * 同步逐个调用事件监听，捕获同步异常并记日志；没有await异步监听。
     * 仅事件通道有此保护，dataHandler的同步异常不会在这里捕获。
     * [/学习注释]
     */
    private emit(eventType: MngFrameSyncEventType, data: any): void {
        const callbacks = this.eventCallbacks.get(eventType);
        if (!callbacks) { return; }
        for (const callback of callbacks) {
            try {
                callback(data);
            } catch (error) {
                this.logger.error(`[MngClientFrameSyncManager] 事件回调错误:`, error);
            }
        }
    }

    // ========== 生命周期 ==========

    /* [学习注释]
     * 只改状态，保留帧号、缓存、事件和处理器。暂停期间update/add数据入口直接返回。
     * [/学习注释]
     */
    public pause(): void {
        if (this.status === MngFrameSyncStatus.RUNNING) {
            this.status = MngFrameSyncStatus.PAUSED;
        }
    }

    /* [学习注释]
     * 恢复RUNNING并清内部计时余量，不主动补算暂停时长。若外部传入包含暂停时长的大dt仍可能大量补跑。
     * [/学习注释]
     */
    public resume(): void {
        if (this.status === MngFrameSyncStatus.PAUSED) {
            this.status = MngFrameSyncStatus.RUNNING;
            this.logicFrameTime = 0;
            this.renderFrameTime = 0;
        }
    }

    /* [学习注释]
     * 状态回UNINITIALIZED而非STOPPED；清帧号、统计、缓存、监听和批次。
     * 保留配置/logger/dataHandler及预测器校正器对象；当前未显式重置_catchUpDebtLogicFrames。
     * stop后再init不会恢复已清掉的on监听，接入方需重新注册。
     * [/学习注释]
     */
    public stop(): void {
        this.status = MngFrameSyncStatus.UNINITIALIZED;
        this.currentLogicFrame = 0;
        this.currentRenderFrame = 0;
        this.serverFrame = 0;
        this.isFirstServerFrame = true;
        this.predictFrameCount = 0;
        this.correctFrameCount = 0;
        this.lostFrameCount = 0;
        this.networkLatency = 0;
        this.logicFrameTime = 0;
        this.renderFrameTime = 0;
        this.frameBuffer.clear();
        this.serverFrameQueue = [];
        this.eventCallbacks.clear();
        this.isServerFrameBatching = false;
        this.serverFrameBatchMode = "latest";
        this.pendingServerFrameData = null;
        this.pendingServerFrameDataMap.clear();
    }

    /* [学习注释]
     * 先stop，再解除dataHandler引用；不是Cocos节点销毁，不操作场景节点。
     * [/学习注释]
     */
    public destroy(): void {
        this.stop();
        this.dataHandler = null;
    }
}
