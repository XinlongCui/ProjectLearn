/* 帧同步框架 - 协议层抽象基类（应用时，继承并拓展相关字段即可） */
/* 具体可参考example/example_protocol.ts */

import { MngBaseFrameData, MngBaseFrameInfos } from "./mng_base_frame_data";
import { IMngFrameSyncLogger, MNG_NULL_LOGGER } from "./mng_frame_sync_types";

/**
 * 帧同步协议层 - 发送帧数据的”参数”（mng_base_frame_data中的才是“帧数据”）
 * 例如：同一次玩家输入，可以同时用来构造发送消息和本地帧数据（参考example_driver.ts中的sendMove()）
 * 各游戏可继承扩展额外字段（如道具id、技能id等）
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

/* ===========================*分割线*=========================== */

/**
 * 帧同步协议层抽象基类，abstract类不能直接实例化。各游戏继承此类，实现各自的协议注册、发送、接收逻辑。
 * 将协议注册/注销、帧发送/接收的骨架固化在基类；游戏特定的消息类型、序列化方式、延迟检测等由子类实现。
 * 泛型参数：
 *  - TSendParams: 发送帧数据的参数类型，各游戏可扩展
 *  - TFrameInfos: 帧信息类型
 *  - TFrameData:  帧数据类型
 * TSendParams、TFrameInfos、TFrameData让上行与下行使用各玩法类型（上行：客户端 → 服务器，下行：服务器 → 客户端）。
 */
export abstract class MngBaseFrameSyncProtocol<
    TSendParams extends MngFrameSendParams = MngFrameSendParams,
    TFrameInfos extends MngBaseFrameInfos = MngBaseFrameInfos,
    TFrameData extends MngBaseFrameData<TFrameInfos> = MngBaseFrameData<TFrameInfos>
> {

    /** 防止重复注册消息的本地标记（如果重复注册，在允许重复监听的消息系统中，就可能出现“收到一次消息，处理函数却执行多次”的情况。）
     * 不代表服务器已进房、网络已连通或Manager已RUNNING，因为 _inited 只是在init()里设置的标记，没有检查网络连接，也没有等待服务器确认。
     * 另外，当前代码是先置 true，再注册消息。如果 registerMsg() 抛出异常，标记仍会保持 true，因此它也不是“消息注册一定成功”的严格证明。
     */
    protected _inited: boolean = false;
    protected logger: IMngFrameSyncLogger = MNG_NULL_LOGGER;


    /* 帧数据接收回调，该回调由驱动层设置；协议层收到服务器帧后，解析并调用此回调 */
    public onFrameReceived: ((frameData: TFrameData) => void) | null = null;


    /* 重连数据接收回调，该回调由驱动层设置；协议层收到重连响应后，解析并调用此回调 */
    /* 重连回调携带房间和玩法恢复数据；基类不知道快照/历史帧结构，roomInfo暂用any。*/
    public onReconnectReceived: ((roomId: number, roomInfo: any) => void) | null = null;


    /* 给协议层独立设置logger；Driver设置自己的logger不会自动设置某个Protocol对象。*/
    public setLogger(logger: IMngFrameSyncLogger): void {
        this.logger = logger;
    }

    /* 初始化：注册消息，先判断幂等标记（“幂等”：同一个操作执行一次或重复执行多次，最终效果相同。），再置true并注册。*/
    public init(): void {
        if (this._inited) {
            return;
        }
        this._inited = true;
        this.registerMsg();
    }

    /** 销毁：注销消息，置false并注销消息。
     * 基类没有清空onFrameReceived/onReconnectReceived，引用清理由接入层负责（因为驱动层绑定回调，所以驱动层退出时解除绑定，这里就没有清理）。
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
    /**
     * 正常子类根据TSendParams组装协议消息并调用MsgMgr.sendMsg。
     * 接口没有节流或排队代码，发送频率由调用者或子类决定。（节流：限制提交频率，例如摇杆事件触发了很多次，但每个逻辑帧只提交一次最新输入。排队：先保存操作，之后再按某种规则逐个或批量提交。）。
     * 不会自动增加逻辑帧号，一次调用不等于创建一个新逻辑帧（
        假设现在是第 100 帧，期间还没有发生逻辑帧推进：
        第一次摇杆事件触发：发送位置 A，携带帧号 100。
        第二次摇杆事件触发：发送位置 B，携带帧号 100。
        玩家点击技能：发送技能操作，携带帧号 100。
        这时是：提交了三次操作，但本地逻辑帧仍然是 100。
        随后管理器Manager中this.currentLogicFrame++;，本地逻辑帧才变成 101）。

        服务器可以把同帧多条操作放进一个操作列表
            前面的数据结构，已经允许这样组织：
            一个完整帧包 FrameData：包含帧号，以及 frames 玩家组列表。
            一个玩家组 FrameInfos：包含玩家身份，以及 infos 操作列表。
            一个操作 FrameInfo：表示一次移动、技能等操作。
            假设服务器保留了全部三条操作，那么它下发的某一帧可以包含：
            玩家甲：
                移动 A。
                移动 B。
                使用技能。
            玩家乙：
                移动 C。
        
        但是，客户端自己提交操作时的本地缓存：同帧覆盖。addClientFrame()只会保留最后一次写入的数据。
     */
    public abstract sendFrame(params: TSendParams): void;

    /**
     * 发送断线重连请求
     * @param roomId 房间id
     * @param frameIndex 请求从该帧开始补发
     */
    /**
     * 请求从某帧恢复是接口意图，真实协议可能按frameIndex补历史，也可能重新进房获取快照。
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
