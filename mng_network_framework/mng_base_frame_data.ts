/* 帧同步框架 - 基础帧数据定义（应用时，继承并拓展相关字段即可） */


/** 基础玩家简要信息 */
export interface MngBasePlayerInfo {
    /** 角色id */
    roleId?: Int64;
    /** 角色昵称 */
    name?: string;
    /** 角色头像 */
    head?: string;
}

/**
 * 基础帧操作信息（单次操作）
 */
export class MngBaseFrameInfo {
    /** 客户端验证类型， 
     * 用于标记本地处理状态：LOCAL_PREDICT=0、NORMAL=1、LOCAL_CORRECTION=2。
     * 这是本地预测/校正的辅助标记，不意味着服务器完成了业务合法性校验。
     */
    public clientVerify?: number;
    /** 帧信息序号 ，
     * seqId 是操作序号，frameIndex 是时间帧号，两者不能混用；同一帧可以有多条操作序号。
     */
    public seqId?: number;
    /** 玩家X坐标 */
    public x?: number;
    /** 玩家Y坐标 */
    public y?: number;
    /** 玩家朝向 */
    public direction?: number;
}

/* ====*分割线*==== */

/**
 * 单帧 单个 玩家数据
 * 泛型 TInfo 允许各游戏扩展操作信息
 */
export class MngBaseFrameInfos<TInfo extends MngBaseFrameInfo = MngBaseFrameInfo> {
    /** 玩家简要信息 */
    public simpleInfo?: MngBasePlayerInfo;
    /** 玩家单帧操作数据列表 */
    public infos?: TInfo[];
    /** 是否使用新输入，
     * 可选输入标志。通用 Manager 不直接消费这个字段；它是否影响执行，由具体玩法规定。
     */
    public useNewInput?: boolean;
}

/**
 * 单帧 所有 玩家数据
 * 例如 frameIndex=100，frames=[玩家A操作组, 玩家B操作组]。
 * 泛型 TFrameInfos 允许各游戏扩展玩家帧信息
 */
export class MngBaseFrameData<TFrameInfos extends MngBaseFrameInfos = MngBaseFrameInfos> {
    /** 房间Id */
    public roomId?: number;
    /** 当前帧号，
     * frameIndex 是帧编号，frames 通常是同帧的多个玩家 
    */
    public frameIndex: number;
    /** 帧信息（各玩家数据） */
    public frames?: TFrameInfos[];
}
