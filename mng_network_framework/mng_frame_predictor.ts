/* [学习注释]
 * 【本文件职责】根据历史坐标预测下一帧的通用基础数据。
 * 虽然原注释叫“线性插值”，公式 current+(current-prev) 实际是线性外推：沿最近位移继续走一步。
 * 它不计算碰撞、技能或完整世界状态；也不会直接发送消息、推进时间或自动预测全部玩家。
 * [/学习注释]
 */
/**
 * 帧同步框架 - 帧预测器
 * 基于历史数据进行线性插值预测，减少网络延迟带来的影响
 */

import { MngBaseFrameInfo, MngBaseFrameInfos } from "./mng_base_frame_data";
import { MngClientVerifyType } from "./mng_frame_sync_types";
import { MngFrameBuffer } from "./mng_frame_buffer";

/* [学习注释]
 * 通过泛型接收玩法类型，但下面构造结果时只填写基础字段。扩展类型不等于扩展行为。
 * [/学习注释]
 */
export class MngFramePredictor<
    TInfo extends MngBaseFrameInfo = MngBaseFrameInfo,
    TFrameInfos extends MngBaseFrameInfos<TInfo> = MngBaseFrameInfos<TInfo>
> {
    private frameBuffer: MngFrameBuffer<TFrameInfos>;
    private enablePredict: boolean;

    /* [学习注释]
     * 持有Manager共享的Buffer引用。构造函数默认开启，但Manager会传入配置，框架默认配置实际关闭。
     * [/学习注释]
     */
    constructor(frameBuffer: MngFrameBuffer<TFrameInfos>, enablePredict: boolean = true) {
        this.frameBuffer = frameBuffer;
        this.enablePredict = enablePredict;
    }

    /**
     * 预测下一帧数据
     * @param currentFrame 当前帧号
     * @param localPlayerData 本地玩家数据
     * @returns 预测的帧信息，未启用则返回 null
     */
    /* [学习注释]
     * 输入currentFrame是缓存帧号，目标为currentFrame+1。关闭时返回null。
     * 本函数返回预测对象，本身不调用Buffer.addClientFrame；通常由Manager负责写入。
     * [/学习注释]
     */
    public predictNextFrame(currentFrame: number, localPlayerData: TInfo): TFrameInfos | null {
        if (!this.enablePredict) {
            return null;
        }

        const nextFrame = currentFrame + 1;
        /* [学习注释]
         * 下一帧已经存在就直接复用。Manager仍可能对此累计predictFrameCount，不代表生成了新数据。
         * [/学习注释]
         */
        const existingFrame = this.frameBuffer.getClientFrame(nextFrame);
        if (existingFrame) {
            return existingFrame;
        }

        const currentFrameData = this.frameBuffer.getClientFrame(currentFrame);
        const prevFrameData = this.frameBuffer.getClientFrame(currentFrame - 1);
        /* [学习注释]
         * 优先使用当前帧的身份信息，没有则退回前一帧；这里未校验二者是否属于同一个玩家。
         * [/学习注释]
         */
        const currentPlayerInfo = currentFrameData || prevFrameData;

        /* [学习注释]
         * 创建普通对象并断言为TFrameInfos。类型断言不会调用玩法构造函数，也不会补扩展字段。
         * [/学习注释]
         */
        const predictFrame = {
            simpleInfo: currentPlayerInfo?.simpleInfo || null,
            infos: [],
        } as unknown as TFrameInfos;

        /* [学习注释]
         * 只读取历史infos[0]的x/y，seqId加1，朝向沿用输入；不会预测infos列表内的每一条操作。
         * 结果没有自动带__rid、skillId等额外字段，接入时要理解与校正器匹配要求的差别。
         * [/学习注释]
         */
        const predictPlayerData = {
            clientVerify: MngClientVerifyType.LOCAL_PREDICT,
            seqId: (localPlayerData.seqId ?? 0) + 1,
            x: this.predictValue(
                prevFrameData?.infos?.[0]?.x,
                currentFrameData?.infos?.[0]?.x,
                localPlayerData.x
            ),
            y: this.predictValue(
                prevFrameData?.infos?.[0]?.y,
                currentFrameData?.infos?.[0]?.y,
                localPlayerData.y
            ),
            direction: localPlayerData.direction,
        } as TInfo;

        predictFrame.infos!.push(predictPlayerData);
        return predictFrame;
    }

    /**
     * 批量预测多帧数据
     * @param startFrame 起始帧号
     * @param count 预测帧数
     * @param localPlayerData 本地玩家数据
     * @returns 预测的帧信息数组
     */
    /* [学习注释]
     * 循环请求count个结果，首个目标为startFrame。每次用上次结果的infos[0]更新输入。
     * 注意：本方法没有把中间预测结果写入Buffer，后续历史查询不会自动看到这些新结果；不能当作完整连续模拟器。
     * [/学习注释]
     */
    public predictFrames(startFrame: number, count: number, localPlayerData: TInfo): TFrameInfos[] {
        if (!this.enablePredict || count <= 0) {
            return [];
        }

        const predictFrames: TFrameInfos[] = [];
        let currentData = localPlayerData;
        for (let i = 0; i < count; i++) {
            const predictFrame = this.predictNextFrame(startFrame + i - 1, currentData);
            if (predictFrame) {
                predictFrames.push(predictFrame);
                if (predictFrame.infos && predictFrame.infos.length > 0) {
                    currentData = predictFrame.infos[0];
                }
            }
        }
        return predictFrames;
    }

    /** 线性插值预测 */
    /* [学习注释]
     * 若历史缺失，返回本次输入值。历史齐全时用current+(current-prev)。
     * 例：prev=10,current=12得到14，而不是两点之间的11。
     * [/学习注释]
     */
    private predictValue(prev: number | undefined, current: number | undefined, input: number): number {
        if (prev === undefined || current === undefined) {
            return input;
        }
        return current + (current - prev);
    }

    /* [学习注释]
     * 只改变预测器内部开关；Manager还有config.enableLocalPredict这一层门控，单独开启此处未必触发预测。
     * [/学习注释]
     */
    public setEnablePredict(enable: boolean): void { this.enablePredict = enable; }
    /* [学习注释]
     * 只反映预测器自身状态，不代表Manager入口的配置门控也已经打开。
     * [/学习注释]
     */
    public getEnablePredict(): boolean { return this.enablePredict; }
}
