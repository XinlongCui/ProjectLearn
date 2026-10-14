/* [学习注释]
 * 【本文件职责】用服务器数据补充或校正同帧clientFrame缓存。
 * 匹配键为客户端操作上的__rid与seqId；__rid由getPlayerKey(serverFrame)推导。
 * 校正只处理基础位置/朝向等字段，不保存完整游戏快照，也不会自动重跑移动、碰撞、技能。
 * [/学习注释]
 */
/**
 * 帧同步框架 - 帧矫正器
 * 根据服务器数据矫正本地预测的帧数据
 * 提供 normalizeDirection 钩子供各游戏自定义角度归一化逻辑
 */

import { MngBaseFrameInfo, MngBaseFrameInfos } from "./mng_base_frame_data";
import { MngClientVerifyType } from "./mng_frame_sync_types";
import { MngFrameBuffer } from "./mng_frame_buffer";

export class MngFrameCorrector<
    TInfo extends MngBaseFrameInfo = MngBaseFrameInfo,
    TFrameInfos extends MngBaseFrameInfos<TInfo> = MngBaseFrameInfos<TInfo>
> {
    private frameBuffer: MngFrameBuffer<TFrameInfos>;
    private enableCorrection: boolean;
    /* [学习注释]
     * 默认位置距离阈值0.1，单位沿用玩法坐标；不是0.1秒或0.1帧。
     * [/学习注释]
     */
    private correctionThreshold: number = 0.1;

    /**
     * 角度归一化钩子，默认直接返回原值
     * 各游戏可在构造后赋值自定义逻辑（如将角度归一化到 [0, 360)）
     */
    public normalizeDirection: (angle: number) => number = (angle) => angle;

    /**
     * 获取玩家唯一标识的钩子，默认读取 simpleInfo.roleId 的字符串形式。
     * 缺少身份的玩家可能得到相同key，玩法需要提供可靠身份。
     * 各游戏可根据协议差异自定义
     */
    public getPlayerKey: (frameInfos: TFrameInfos) => string = (frameInfos) =>
        frameInfos.simpleInfo?.roleId?.toString?.() ?? "";

    /* [学习注释]
     * 持有共享缓存，correctFrame对clientFrame的修改会直接被Manager后续读到。
     * [/学习注释]
     */
    constructor(frameBuffer: MngFrameBuffer<TFrameInfos>, enableCorrection: boolean = true) {
        this.frameBuffer = frameBuffer;
        this.enableCorrection = enableCorrection;
    }

    /**
     * 矫正帧数据
     * @param frameIndex 帧号
     * @param serverFrame 服务器帧数据（单个玩家的信息）
     * @returns 是否产生了矫正
     */
    /* [学习注释]
     * 关闭则不处理。有客户端缓存走合并；没有则根据服务器创建缓存。
     * 返回true表示发生创建、追加或位置修正，不只表示“预测错误”。
     * [/学习注释]
     */
    public correctFrame(frameIndex: number, serverFrame: TFrameInfos): boolean {
        if (!this.enableCorrection) {
            return false;
        }

        const clientFrame = this.frameBuffer.getClientFrame(frameIndex);
        const ridStr = this.getPlayerKey(serverFrame);

        if (!clientFrame) {
            return this.createFrameFromServer(frameIndex, serverFrame, ridStr);
        }

        return this.mergeServerFrame(frameIndex, clientFrame, serverFrame, ridStr);
    }

    /** 没有客户端帧数据时，直接使用服务器数据创建新帧 */
    /* [学习注释]
     * 只复制simpleInfo及操作的seqId/x/y/direction，并附加__rid。
     * clientVerify标NORMAL，因为这条数据直接来自服务器。扩展操作字段不会自动复制。
     * [/学习注释]
     */
    private createFrameFromServer(frameIndex: number, serverFrame: TFrameInfos, ridStr: string): boolean {
        const newFrame = {
            simpleInfo: serverFrame.simpleInfo,
            infos: [],
        } as unknown as TFrameInfos;

        for (const serverInfo of serverFrame.infos || []) {
            const info = {
                clientVerify: MngClientVerifyType.NORMAL,
                seqId: serverInfo.seqId,
                x: serverInfo.x,
                y: serverInfo.y,
                direction: serverInfo.direction !== undefined ? this.normalizeDirection(serverInfo.direction) : undefined,
                __rid: ridStr,
            } as any;
            newFrame.infos!.push(info);
        }
        this.frameBuffer.addClientFrame(frameIndex, newFrame);
        return true;
    }

    /** 合并服务器帧数据到已有的客户端帧 */
    /* [学习注释]
     * 逐条服务器操作查找本地对应操作。匹配条件是__rid和seqId同时相等，而不是只按坐标或玩家组身份。
     * [/学习注释]
     */
    private mergeServerFrame(frameIndex: number, clientFrame: TFrameInfos, serverFrame: TFrameInfos, ridStr: string): boolean {
        let needCorrection = false;

        for (const serverInfo of serverFrame.infos || []) {
            // 优先按 seqId 精确匹配
            /* [学习注释]
             * 本地输入若没有设置__rid，即使simpleInfo.roleId一致，也可能匹配不到，进入后面的追加分支。
             * [/学习注释]
             */
            const clientInfo = clientFrame.infos?.find(info =>
                (info as any).__rid === ridStr && info.seqId === serverInfo.seqId
            );
            
            if (clientInfo) {
                /* [学习注释]
                 * 欧氏距离sqrt(dx²+dy²)。x/y使用||0兜底；当前判定只看位置，没有单独比较朝向或技能字段。
                 * [/学习注释]
                 */
                const distance = Math.sqrt(
                    Math.pow((clientInfo.x || 0) - (serverInfo.x || 0), 2) +
                    Math.pow((clientInfo.y || 0) - (serverInfo.y || 0), 2)
                );
                /* [学习注释]
                 * 只有位置差严格超过阈值才覆盖位置和可用朝向。阈值内仅标NORMAL，朝向不同不会单独触发校正。
                 * [/学习注释]
                 */
                if (distance > this.correctionThreshold) {
                    needCorrection = true;
                    this.applyCorrection(clientInfo, serverFrame, serverInfo);
                } else {
                    clientInfo.clientVerify = MngClientVerifyType.NORMAL;
                }
            } else {
                if (!clientFrame.infos) {
                    clientFrame.infos = [];
                }
                /* [学习注释]
                 * 未匹配到操作时追加基础数据，不会替换整个infos列表；__rid帮助后续同玩家同序号匹配。
                 * [/学习注释]
                 */
                clientFrame.infos.push({
                    clientVerify: MngClientVerifyType.NORMAL,
                    seqId: serverInfo.seqId,
                    x: serverInfo.x,
                    y: serverInfo.y,
                    direction: serverInfo.direction !== undefined ? this.normalizeDirection(serverInfo.direction) : undefined,
                    __rid: ridStr,
                } as any);
                needCorrection = true;
            }
        }

        return needCorrection;
    }

    /** 将服务器数据应用到客户端帧 */
    /* [学习注释]
     * 修改现有客户端操作对象，并标LOCAL_CORRECTION；direction缺失时保留原方向。
     * 这不是修改Cocos节点，角色如何应用修改后的数据仍由玩法决定。
     * [/学习注释]
     */
    private applyCorrection(clientInfo: TInfo, serverFrame: TFrameInfos, serverInfo: TInfo): void {
        clientInfo.clientVerify = MngClientVerifyType.LOCAL_CORRECTION;
        const matched = serverFrame.infos?.find(info => info.seqId === clientInfo.seqId) || serverInfo;
        clientInfo.x = matched.x;
        clientInfo.y = matched.y;
        if (matched.direction !== undefined) {
            clientInfo.direction = this.normalizeDirection(matched.direction);
        }
    }

    /**
     * 回滚并重新应用帧数据
     * @param fromFrame 起始帧号
     * @param toFrame 目标帧号
     * @param serverFrameData 按帧号索引的服务器帧数据集合
     */
    /* [学习注释]
     * 方法名含回滚，但实现只是遍历闭区间、逐个调用correctFrame合并缓存。
     * 没有恢复世界快照、撤销事件或重算物理；这些如果需要，必须由玩法实现。
     * [/学习注释]
     */
    public rollbackAndReapply(fromFrame: number, toFrame: number, serverFrameData: Map<number, TFrameInfos[]>): void {
        if (!this.enableCorrection) {
            return;
        }
        for (let frameIndex = fromFrame; frameIndex <= toFrame; frameIndex++) {
            const serverFrames = serverFrameData.get(frameIndex);
            if (serverFrames) {
                for (const serverFrame of serverFrames) {
                    this.correctFrame(frameIndex, serverFrame);
                }
            }
        }
    }

     /* 仅切换校正器自身开关；Manager的enableServerCorrection也必须允许调用。 */
    public setEnableCorrection(enable: boolean): void { this.enableCorrection = enable; }
     /* 读取校正器内部开关。 */
    public getEnableCorrection(): boolean { return this.enableCorrection; }
    /* 直接保存阈值，没有有效性校验或单位转换；调用方要提供符合坐标单位的非负值。 */
    public setCorrectionThreshold(threshold: number): void { this.correctionThreshold = threshold; }
     /* 读取当前用于位置偏差判断的阈值。 */
    public getCorrectionThreshold(): number { return this.correctionThreshold; }
}
