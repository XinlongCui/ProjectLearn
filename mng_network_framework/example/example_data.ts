/**
 * 【接入示例】抢宝小游戏 - 数据类型定义
 */

import { MngBaseFrameInfo, MngBaseFrameInfos, MngBaseFrameData, MngBasePlayerInfo } from "../mng_base_frame_data";

// ============ 玩家简要信息扩展 ============
export interface ExamplePlayerInfo extends MngBasePlayerInfo {
    /** 玩家皮肤id */
    skinId?: number;
    /** 玩家等级 */
    level?: number;
}

// ============ 帧操作信息扩展 ============

/** 抢宝小游戏 - 操作类型 */
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

// ============ 帧数据 ============

/** 抢宝小游戏 - 单个玩家一帧内的全部数据 */
export class ExampleFrameInfos extends MngBaseFrameInfos<ExampleFrameInfo> {
    public simpleInfo?: ExamplePlayerInfo;
    public infos?: ExampleFrameInfo[];
}

/** 抢宝小游戏 - 一帧内所有玩家的数据 */
export class ExampleFrameData extends MngBaseFrameData<ExampleFrameInfos> {
    /** 游戏剩余时间（秒），服务器每帧下发 */
    public remainTime?: number;
    /** 场景内道具刷新列表（服务器广播） */
    public spawnedItems?: ExampleSpawnedItem[];
}

// ============ 辅助类型 ============

/** 场景内刷新的道具信息 */
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
/** 上行消息的参数，不等于下行完整帧。Protocol负责把这些参数写入真实协议消息。*/
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
