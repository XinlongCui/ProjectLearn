/* [学习注释]
 * 【本文件职责】按帧号保存客户端/服务器数据的 Map，不是先进先出的消息队列。
 * Manager 以 currentLogicFrame 查询 clientFrame，处理后不立即删除；历史数据等待 cleanup 清理。
 * 读写存放对象引用，不做深拷贝；同一帧同一槽位再次写入会替换旧引用，不自动合并操作。
 * [/学习注释]
 */
/**
 * 帧同步框架 - 帧缓冲区管理器
 * 存储和管理客户端/服务器帧数据的缓存，与具体游戏逻辑无关
 */

import { MngBaseFrameInfos } from "./mng_base_frame_data";

/** 帧缓冲区项 */
/* [学习注释]
 * 一个帧号的缓存记录。clientFrame 与 serverFrame 各只有一个槽位。
 * confirmed 只说明 addServerFrame 写过这里；timestamp 是建记录时的本地时间，不是服务器时间。
 * [/学习注释]
 */
export interface MngFrameBufferItem<TFrameInfos extends MngBaseFrameInfos = MngBaseFrameInfos> {
    /** 帧号 */
    frameIndex: number;
    /** 客户端帧信息 */
    clientFrame?: TFrameInfos;
    /** 服务器帧信息 */
    serverFrame?: TFrameInfos;
    /** 是否已确认（收到服务器帧） */
    confirmed: boolean;
    /** 时间戳 */
    timestamp: number;
}

export class MngFrameBuffer<TFrameInfos extends MngBaseFrameInfos = MngBaseFrameInfos> {
    /* [学习注释]
     * Map<number, Item> 的 key 是内部缓存帧号。它不会自己推进帧号，也不会定时派发数据。
     * [/学习注释]
     */
    private buffer: Map<number, MngFrameBufferItem<TFrameInfos>> = new Map();
    private maxSize: number;
    /* [学习注释]
     * min/max 描述当前缓存的帧号范围，不保证这个范围内的每一帧都存在。
     * [/学习注释]
     */
    private minFrame: number = 0;
    private maxFrame: number = 0;

    /* [学习注释]
     * 只记录窗口大小。初始化不会预先分配600个帧对象；记录按需创建。
     * [/学习注释]
     */
    constructor(maxSize: number = 600) {
        this.maxSize = maxSize;
    }

    /**
     * 添加客户端帧数据
     * @param frameIndex 帧号
     * @param frameInfo 帧信息
     */
    /* [学习注释]
     * 没有记录就创建，有记录就替换 clientFrame。服务器槽位和 confirmed 不会被这次写入清空。
     * 例如同一key105先写A再写B，最终clientFrame只有B，不会自动排到106。
     * [/学习注释]
     */
    public addClientFrame(frameIndex: number, frameInfo: TFrameInfos): void {
        let item = this.buffer.get(frameIndex);
        if (!item) {
            item = { frameIndex, confirmed: false, timestamp: Date.now() };
            this.buffer.set(frameIndex, item);
            this.updateFrameRange(frameIndex);
        }
        item.clientFrame = frameInfo;
    }

    /**
     * 添加服务器帧数据
     * @param frameIndex 帧号
     * @param frameInfo 帧信息
     */
    /* [学习注释]
     * 写入一个 TFrameInfos，而不是完整 TFrameData。收到数据就置 confirmed=true。
     * 若Manager同帧对多位玩家反复调用此函数，serverFrame只保留最后写入的玩家组。
     * [/学习注释]
     */
    public addServerFrame(frameIndex: number, frameInfo: TFrameInfos): void {
        let item = this.buffer.get(frameIndex);
        if (!item) {
            item = { frameIndex, confirmed: false, timestamp: Date.now() };
            this.buffer.set(frameIndex, item);
            this.updateFrameRange(frameIndex);
        }
        item.serverFrame = frameInfo;
        item.confirmed = true;
    }

    /** 获取帧数据 */
    /* [学习注释]
     * 返回实际缓存对象。调用方修改该对象会影响缓存，不能把它当成只读副本。
     * [/学习注释]
     */
    public getFrame(frameIndex: number): MngFrameBufferItem<TFrameInfos> | undefined {
        return this.buffer.get(frameIndex);
    }

    /** 获取客户端帧数据 */
    /* [学习注释]
     * 可选链处理“没有这个帧号”的情况，返回 undefined；不会创造记录或等待数据。
     * [/学习注释]
     */
    public getClientFrame(frameIndex: number): TFrameInfos | undefined {
        return this.buffer.get(frameIndex)?.clientFrame;
    }

    /** 获取服务器帧数据 */
    /* [学习注释]
     * 返回此key的单个服务器槽位；不保证它包含该帧所有玩家。
     * [/学习注释]
     */
    public getServerFrame(frameIndex: number): TFrameInfos | undefined {
        return this.buffer.get(frameIndex)?.serverFrame;
    }

    /** 检查帧是否存在 */
    /* [学习注释]
     * 仅判断Map里有无key；即使只有客户端数据、未被服务器确认，也返回true。
     * [/学习注释]
     */
    public hasFrame(frameIndex: number): boolean {
        return this.buffer.has(frameIndex);
    }

    /** 检查帧是否已确认 */
    /* [学习注释]
     * 无记录或未确认均返回false；这与hasFrame的含义不同。
     * [/学习注释]
     */
    public isFrameConfirmed(frameIndex: number): boolean {
        return this.buffer.get(frameIndex)?.confirmed || false;
    }

    /** 获取范围内的帧数据 */
    /* [学习注释]
     * 按整数帧号升序扫描闭区间，仅返回存在项；缺口不会填undefined占位。返回元素仍是原引用。
     * [/学习注释]
     */
    public getFramesInRange(startFrame: number, endFrame: number): MngFrameBufferItem<TFrameInfos>[] {
        const frames: MngFrameBufferItem<TFrameInfos>[] = [];
        for (let i = startFrame; i <= endFrame; i++) {
            const item = this.buffer.get(i);
            if (item) {
                frames.push(item);
            }
        }
        return frames;
    }

    /** 清理指定帧号之前的数据 */
    /* [学习注释]
     * 两阶段删除：先收集待删key，再执行delete。删除条件是严格小于beforeFrame，边界帧保留。
     * 删除后重算min/max；不会发出业务事件，也不会回滚已经执行的玩法。
     * [/学习注释]
     */
    public cleanup(beforeFrame: number): void {
        const framesToDelete: number[] = [];
        for (const [frameIndex] of this.buffer.entries()) {
            if (frameIndex < beforeFrame) {
                framesToDelete.push(frameIndex);
            }
        }
        for (const frameIndex of framesToDelete) {
            this.buffer.delete(frameIndex);
        }
        if (framesToDelete.length > 0) {
            this.updateMinFrame();
        }
    }

    /** 清理所有数据 */
    /* [学习注释]
     * 彻底清空记录并把范围归零。maxSize配置保持不变。
     * [/学习注释]
     */
    public clear(): void {
        this.buffer.clear();
        this.minFrame = 0;
        this.maxFrame = 0;
    }

    /* [学习注释]
     * 查询缓存范围和大小；空缓存min/max都返回0，不能仅凭0判断帧0是否存在。
     * [/学习注释]
     */
    public getMinFrame(): number { return this.minFrame; }
    /* [学习注释]
     * 当前最大缓存key，不等于Manager.serverFrame，因为客户端输入也会更新范围。
     * [/学习注释]
     */
    public getMaxFrame(): number { return this.maxFrame; }
    /* [学习注释]
     * 返回真实记录数；不是最大帧号减最小帧号，也不是玩家数或操作数。
     * [/学习注释]
     */
    public getSize(): number { return this.buffer.size; }

    /**
     * 检查是否有丢失的帧（向前检查）
     * @param currentFrame 当前帧号
     * @param lookback 回溯帧数
     * @returns 丢失的帧号列表
     */
    /* [学习注释]
     * 回溯默认10帧，检查区间[max(minFrame,current-lookback), current)。当前帧本身不检查。
     * 只查key缺失，不查服务器确认；同一缺口可连续多次返回，调用方累计时可能重复计数。
     * [/学习注释]
     */
    public checkLostFrames(currentFrame: number, lookback: number = 10): number[] {
        const lostFrames: number[] = [];
        const startFrame = Math.max(this.minFrame, currentFrame - lookback);
        for (let i = startFrame; i < currentFrame; i++) {
            if (!this.buffer.has(i)) {
                lostFrames.push(i);
            }
        }
        return lostFrames;
    }

    /**
     * 检查是否有丢失的帧（返回第一个）
     * @param currentFrame 当前帧号
     * @param lookback 回溯帧数
     * @returns 第一个丢失的帧号，无丢失返回 0
     */
    /* [学习注释]
     * 与上面相似，但只返回第一个缺口。0同时作为“没有缺口”的哨兵，无法区分缺失帧0。
     * [/学习注释]
     */
    public checkLostFrame(currentFrame: number, lookback: number = 10): number {
        const startFrame = Math.max(this.minFrame, currentFrame - lookback);
        for (let i = startFrame; i < currentFrame; i++) {
            if (!this.buffer.has(i)) {
                return i;
            }
        }
        return 0;
    }

    /* [学习注释]
     * 首条记录直接设置范围；后续取min/max。超过maxSize时按maxFrame-maxSize清理。
     * 例如maxSize=600，key0..600共有601条，cleanup(0)不删除0，所以不是严格600条容量限制。
     * [/学习注释]
     */
    private updateFrameRange(frameIndex: number): void {
        if (this.buffer.size === 1) {
            // 首次添加，直接设置范围
            this.minFrame = frameIndex;
            this.maxFrame = frameIndex;
        } else {
            this.minFrame = Math.min(this.minFrame, frameIndex);
            this.maxFrame = Math.max(this.maxFrame, frameIndex);
        }
        if (this.buffer.size > this.maxSize) {
            this.cleanup(this.maxFrame - this.maxSize);
        }
    }

    /* [学习注释]
     * 遍历剩余key重新计算范围，避免删除最早/最晚记录后范围失真。时间开销随缓存记录数增长。
     * [/学习注释]
     */
    private updateMinFrame(): void {
        if (this.buffer.size === 0) {
            this.minFrame = 0;
            this.maxFrame = 0;
            return;
        }
        let min = Infinity;
        let max = -Infinity;
        for (const frameIndex of this.buffer.keys()) {
            min = Math.min(min, frameIndex);
            max = Math.max(max, frameIndex);
        }
        this.minFrame = min;
        this.maxFrame = max;
    }
}
