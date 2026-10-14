/* [学习注释]
 * 【本文件职责】用一个“抢宝小游戏”演示怎样扩展通用数据类型。
 * 这是教学协议模型，不是已接入真实服务器的完整小游戏。新增字段必须由玩法协议和业务代码共同处理。
 * 阅读时先看ExampleFrameInfo，再看ExampleFrameInfos和ExampleFrameData，最后看发送参数。
 * [/学习注释]
 */
/**
 * 【接入示例】抢宝小游戏 - 数据类型定义
 *
 * 演示如何继承框架基础类型，扩展玩法专属字段
 * 各玩法只需按此模式扩展即可接入帧同步框架
 */

import { MngBaseFrameInfo, MngBaseFrameInfos, MngBaseFrameData, MngBasePlayerInfo } from "../mng_base_frame_data";

// ============ 玩家简要信息扩展 ============

/** 抢宝小游戏 - 玩家简要信息（扩展皮肤、等级等） */
/* [学习注释]
 * 扩展玩家身份：基础roleId/name/head之外增加皮肤与等级。接口不产生运行时实例。
 * [/学习注释]
 */
export interface ExamplePlayerInfo extends MngBasePlayerInfo {
    /** 玩家皮肤id */
    skinId?: number;
    /** 玩家等级 */
    level?: number;
}

// ============ 帧操作信息扩展 ============

/** 抢宝小游戏 - 操作类型 */
/* [学习注释]
 * 示例约定的操作编号；真实接入必须与服务端枚举对应，不能只因名字相同就假设编号一致。
 * [/学习注释]
 */
export enum ExampleActionType {
    /** 移动 */
    MOVE = 0,
    /** 拾取道具 */
    PICK_ITEM = 1,
    /** 使用技能 */
    USE_SKILL = 2,
    /** 投掷道具 */
    THROW_ITEM = 3,
}

/**
 * 抢宝小游戏 - 帧操作信息
 * 继承 MngBaseFrameInfo（含坐标、朝向），追加操作类型、道具id、技能id
 */
/* [学习注释]
 * 单次操作同时可带坐标和玩法参数。actionType决定itemId/skillId等字段的意义，不是所有字段每次都必须有值。
 * [/学习注释]
 */
export class ExampleFrameInfo extends MngBaseFrameInfo {
    /** 操作类型 */
    public actionType?: ExampleActionType;
    /** 道具id（拾取/投掷时使用） */
    public itemId?: number;
    /** 技能id（使用技能时填充） */
    public skillId?: number;
    /** 目标玩家角色id（投掷道具时指定） */
    public targetRoleId?: Int64;
    /** 移动速度（服务器下发） */
    public speed?: number;
}

// ============ 玩家帧信息 & 帧数据 ============

/** 抢宝小游戏 - 单个玩家一帧内的全部数据 */
/* [学习注释]
 * 把infos的元素类型明确为ExampleFrameInfo，使业务能访问actionType等扩展字段。
 * [/学习注释]
 */
export class ExampleFrameInfos extends MngBaseFrameInfos<ExampleFrameInfo> {
    public simpleInfo?: ExamplePlayerInfo;
    public infos?: ExampleFrameInfo[];
}

/** 抢宝小游戏 - 一帧内所有玩家的数据 */
/* [学习注释]
 * 外层仍有roomId/frameIndex/frames，扩展倒计时和道具生成信息。
 * Manager整体转交服务器包时会保留这些字段；它自己构造的客户端帧外壳并不会自动补这些扩展值。
 * [/学习注释]
 */
export class ExampleFrameData extends MngBaseFrameData<ExampleFrameInfos> {
    /** 游戏剩余时间（秒），服务器每帧下发 */
    public remainTime?: number;
    /** 场景内道具刷新列表（服务器广播） */
    public spawnedItems?: ExampleSpawnedItem[];
}

// ============ 辅助类型 ============

/** 场景内刷新的道具信息 */
/* [学习注释]
 * itemUid是场景实例唯一标识，itemCfgId是配置类型编号；同一种配置可以生成多个不同实例。
 * [/学习注释]
 */
export interface ExampleSpawnedItem {
    /** 道具唯一id */
    itemUid: number;
    /** 道具配置id */
    itemCfgId: number;
    /** 道具位置x */
    x: number;
    /** 道具位置y */
    y: number;
}

// ============ 协议发送参数扩展 ============

import { MngFrameSendParams } from "../mng_base_frame_sync_protocol";

/** 抢宝小游戏 - 发送帧数据参数（扩展操作类型、道具、技能） */
/* [学习注释]
 * 上行消息的参数，不等于下行完整帧。Protocol负责把这些参数写入真实协议消息。
 * [/学习注释]
 */
export interface ExampleFrameSendParams extends MngFrameSendParams {
    /** 操作类型 */
    actionType?: ExampleActionType;
    /** 道具id */
    itemId?: number;
    /** 技能id */
    skillId?: number;
    /** 目标角色id */
    targetRoleId?: Int64;
}
