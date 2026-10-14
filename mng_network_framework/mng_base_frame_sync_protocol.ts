/* [学习注释]
 * 【本文件职责】约定具体玩法如何与网络基础设施连接，是抽象协议层。
 * 基类不绑定任何真实消息号，也不创建WebSocket；MsgMgr注册、解包和发送由子类实现。
 * sendFrame是提交操作消息的接口，不会自动增加逻辑帧号；发送频率由调用者或子类决定。
 * [/学习注释]
 */
/**
 * 帧同步框架 - 协议层抽象基类
 * 各游戏继承此类，实现各自的协议注册、发送、接收逻辑
 *
 * 设计思路：
 *  - 将协议注册/注销、帧发送/接收的骨架固化在基类
 *  - 游戏特定的消息类型、序列化方式、延迟检测等由子类实现
 *  - 通过 onFrameReceived / onReconnectReceived 回调将解析后的数据递交驱动层
 */

import { MngBaseFrameData, MngBaseFrameInfos } from "./mng_base_frame_data";
import { IMngFrameSyncLogger, MNG_NULL_LOGGER } from "./mng_frame_sync_types";

/**
 * 帧同步协议层 - 发送帧数据的参数
 * 各游戏可继承扩展额外字段（如道具id、技能id等）
 */
/* [学习注释]
 * 上行参数：roomId确定房间，frameIndex是调用方附带的时间标签，seqId是可选操作序号。
 * 位置与朝向的单位需与玩法协议一致；子类可以加技能、道具等字段。
 * [/学习注释]
 */
export interface MngFrameSendParams {
    /** 房间id */
    roomId: number;
    /** 帧号 */
    frameIndex: number;
    /** 玩家X坐标 */
    x: number;
    /** 玩家Y坐标 */
    y: number;
    /** 玩家朝向 */
    direction: number;
    /** 操作序号（可选） */
    seqId?: number;
}

/**
 * 帧同步协议层抽象基类
 * 泛型参数：
 *  - TSendParams: 发送帧数据的参数类型，各游戏可扩展
 *  - TFrameInfos: 帧信息类型
 *  - TFrameData:  帧数据类型
 */
/* [学习注释]
 * abstract类不能直接实例化。TSendParams、TFrameInfos、TFrameData让上行与下行使用各玩法类型。
 * [/学习注释]
 */
export abstract class MngBaseFrameSyncProtocol<
    TSendParams extends MngFrameSendParams = MngFrameSendParams,
    TFrameInfos extends MngBaseFrameInfos = MngBaseFrameInfos,
    TFrameData extends MngBaseFrameData<TFrameInfos> = MngBaseFrameData<TFrameInfos>
> {
    /* [学习注释]
     * 防止重复注册消息的本地标记；不代表服务器已进房、网络已连通或Manager已RUNNING。
     * [/学习注释]
     */
    protected _inited: boolean = false;
    protected logger: IMngFrameSyncLogger = MNG_NULL_LOGGER;

    /**
     * 帧数据接收回调，该回调由驱动层设置
     * 协议层收到服务器帧后，解析并调用此回调传递给驱动层
     */
    public onFrameReceived: ((frameData: TFrameData) => void) | null = null;

    /**
     * 重连数据接收回调，该回调由驱动层设置
     * 协议层收到重连响应后，解析并调用此回调传递给驱动层
     */
    /* [学习注释]
     * 重连回调携带房间和玩法恢复数据；基类不知道快照/历史帧结构，roomInfo暂用any。
     * [/学习注释]
     */
    public onReconnectReceived: ((roomId: number, roomInfo: any) => void) | null = null;

    /** 设置日志器 
     * 给协议层独立注入日志；Driver设置自己的logger不会自动设置某个Protocol对象。
     */
    public setLogger(logger: IMngFrameSyncLogger): void {
        this.logger = logger;
    }

    /** 初始化：注册消息，
     *  先判断幂等标记，再置true并注册。没有try/finally，registerMsg若抛错，标记已经变为true。
     */
    public init(): void {
        if (this._inited) {
            return;
        }
        this._inited = true;
        this.registerMsg();
    }

    /** 销毁：注销消息，
     * 置false并注销消息。基类没有清空onFrameReceived/onReconnectReceived，引用清理由接入层负责。
     */
    public unInit(): void {
        if (!this._inited) {
            return;
        }
        this._inited = false;
        this.unregisterMsg();
    }

    // ========== 子类必须实现的方法 ==========

    /** 注册网络消息处理 */
    protected abstract registerMsg(): void;

    /** 注销网络消息处理 */
    protected abstract unregisterMsg(): void;

    /**
     * 发送帧同步数据到服务器
     * @param params 发送参数（包含坐标、帧号等）
     */
    /* [学习注释]
     * 接口没有节流或排队代码；正常子类组装协议并调用MsgMgr.sendMsg。一次调用不等于创建一个新逻辑帧。
     * [/学习注释]
     */
    public abstract sendFrame(params: TSendParams): void;

    /**
     * 发送断线重连请求
     * @param roomId 房间id
     * @param frameIndex 请求从该帧开始补发
     */
    /* [学习注释]
     * 请求从某帧恢复是接口意图，真实协议可能按frameIndex补历史，也可能重新进房获取快照。
     * [/学习注释]
     */
    public abstract sendReconnect(roomId: number, frameIndex: number): void;

    // ========== 子类可选覆盖的方法 ==========

    /**
     * 延迟检测处理（可选）
     * 子类可覆盖此方法实现游戏特定的延迟检测与提示
     * @param intervalMs 相邻两次收到服务器帧的时间间隔（毫秒）
     */
    /* [学习注释]
     * 可选钩子，基类不会定时调用它。子类需测量收帧间隔后主动调用；间隔也不等于网络RTT。
     * [/学习注释]
     */
    protected onDelayDetected(intervalMs: number): void {
        // 默认不做处理，子类按需覆盖
    }
}
