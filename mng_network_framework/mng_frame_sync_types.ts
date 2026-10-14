/* [学习注释]
 * 【本文件职责】集中定义运行状态、事件、业务处理接口、统计和日志接口。
 * 读本文件要区分“契约/名称”和“当前实现”：枚举存在不代表 Manager 一定使用该状态或发出该事件。
 * 数据处理器负责帧数据如何进入玩法，事件监听负责观察更新/预测/校正等通知，两条回调通道相互独立。
 * [/学习注释]
 */
/**
 * 帧同步框架 - 通用类型定义
 */

import { MngBaseFrameData, MngBaseFrameInfos } from "./mng_base_frame_data";

/** 客户端验证类型 */
/* [学习注释]
 * 数字随客户端缓存中的 clientVerify 传递。NORMAL 不代表位置必然完全相等：误差不超过校正阈值时也会标记 NORMAL。
 * [/学习注释]
 */
export enum MngClientVerifyType {
    /** 本地预测 */
    LOCAL_PREDICT = 0,
    /** 正常 */
    NORMAL = 1,
    /** 本地矫正 */
    LOCAL_CORRECTION = 2,
}

/** 帧同步状态 */
/* [学习注释]
 * Manager 初始化为 UNINITIALIZED；init→RUNNING；pause→PAUSED；resume→RUNNING。
 * 当前 stop 实际回到 UNINITIALIZED，未设置为下面声明的 STOPPED。
 * [/学习注释]
 */
export enum MngFrameSyncStatus {
    /** 未初始化 */
    UNINITIALIZED = 0,
    /** 运行中 */
    RUNNING = 1,
    /** 已暂停 */
    PAUSED = 2,
    /** 已停止 */
    STOPPED = 3,
}

/** 帧同步事件类型 */
/* [学习注释]
 * FRAME_UPDATE 有启动通知、logic 更新、render 更新三种载荷形状，启动通知没有 type。
 * FRAME_ERROR 在此声明，但当前 Manager 没有主动 emit 此事件；不能只注册它就期待覆盖全部异常。
 * [/学习注释]
 */
export enum MngFrameSyncEventType {
    /** 帧数据更新 */
    FRAME_UPDATE = "frame_update",
    /** 帧预测 */
    FRAME_PREDICT = "frame_predict",
    /** 帧矫正 */
    FRAME_CORRECT = "frame_correct",
    /** 帧丢失 */
    FRAME_LOST = "frame_lost",
    /** 帧同步错误 */
    FRAME_ERROR = "frame_error",
}

/** 帧同步事件回调 */
/* [学习注释]
 * 事件载荷为 any，使用时按事件类型及 data.type 判断字段。emit 是同步调用，未 await Promise。
 * [/学习注释]
 */
export type MngFrameSyncEventCallback = (data: any) => void;

/**
 * 帧数据处理器接口
 * 泛型 TData 为具体帧数据类型，默认 MngBaseFrameData
 */
/* [学习注释]
 * 业务注入的帧消费者。Manager 只持有一个 handler，重复 setDataHandler 会替换引用。
 * onClientFrame：推进到有客户端缓存的逻辑帧时调用；onServerFrame：普通收帧路径立即调用。
 * [/学习注释]
 */
export interface IMngFrameDataHandler<TData extends MngBaseFrameData = MngBaseFrameData> {
    /** 处理客户端帧数据 */
    onClientFrame(frameData: TData): void;
    /** 处理服务器帧数据 */
    onServerFrame(frameData: TData): void;
    /**
     * 处理服务器帧数据批次（用于重连/进房追帧回放）
     * 可选实现；未实现时回退为逐帧调用 onServerFrame
     */
    /* [学习注释]
     * 【以实现为准】上方旧注释写“回退为逐帧”，当前 endServerFrameBatch 实际只回调最后一帧。
     * 需要完整历史回放的玩法应实现这个方法，并自己按数组顺序消费各帧。
     * [/学习注释]
     */
    onServerFrameBatch?(frames: TData[]): void;
}

/** 帧同步统计信息 */
/* [学习注释]
 * 统计是观察值，不是严格网络测量：networkLatency 是帧差换算毫秒，非 RTT。
 * 丢帧数可能重复累计同一缓存缺口；校正数包含创建/追加缓存；预测数可能包含复用已有预测。
 * [/学习注释]
 */
export interface MngFrameSyncStats {
    /** 当前逻辑帧号 */
    currentLogicFrame: number;
    /** 当前渲染帧号 */
    currentRenderFrame: number;
    /** 服务器帧号 */
    serverFrame: number;
    /** 预测帧数量 */
    predictFrameCount: number;
    /** 矫正帧数量 */
    correctFrameCount: number;
    /** 丢失帧数量 */
    lostFrameCount: number;
    /** 网络延迟（毫秒） */
    networkLatency: number;
}

/**
 * 日志输出接口，由外部注入以解耦具体日志实现
 */
/* [学习注释]
 * 通过依赖注入解耦具体日志库。框架调用 isDebugEnabled 控制部分调试信息，warn/error 不一定受该开关约束。
 * [/学习注释]
 */
export interface IMngFrameSyncLogger {
    /** 是否启用调试日志 */
    isDebugEnabled(): boolean;
    /** 输出日志 */
    log(message: string, ...args: any[]): void;
    /** 输出警告 */
    warn(message: string, ...args: any[]): void;
    /** 输出错误 */
    error(message: string, ...args: any[]): void;
}

/** 默认日志实现（不输出任何日志） */
/* [学习注释]
 * 空对象模式：每个方法都可直接调用但没有输出，避免到处判断 logger 是否为空。
 * [/学习注释]
 */
export const MNG_NULL_LOGGER: IMngFrameSyncLogger = {
    isDebugEnabled: () => false,
    log: () => {},
    warn: () => {},
    error: () => {},
};
