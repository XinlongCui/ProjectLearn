import { Vec3 } from "cc";
import { RedDotType } from "./red_dot_const";
import { ConfigUtils } from "../utils/config_utils";
import { CfgName } from "../../common/config_enum";

type RedDotTreeNode = { [key: string]: RedDotTreeNode };

// 红点树结构配置：父节点聚合子节点，空对象表示叶子节点。
export let RedDotTreeConfig: { RedDotRoot: RedDotTreeNode } = {
    RedDotRoot: {
        SystemRoot1: {
            ForkNode1: {
                LeafNode1: {},
                LeafNode2: {},
            },
        },
        // 保留 RedDotUtils 动态挂载活动所需的分类节点。
        TbWheelActivity: {},
        RoutineActivity: {},
        ValueActivity: {},
        FestivalActivity: {},
        HorseEventActivity: {},
        FissionActivity: {},
        ActivityBackflow: {},
        CampaignActivity: {},
        S3BeginActivity: {},
        FengcaiSeason1Activity: {},
    },
};

// 红点 Key：常量名映射到树中的节点名。
export let RedDotKey: Record<string, string> = {
    RED_DOT_ROOT: "RedDotRoot",
    SYSTEM_ROOT1: "SystemRoot1",
    SYSTEM_STEM_NODE1: "ForkNode1",
    SYSTEM_STEM_LEAF_NODE1: "LeafNode1",
    SYSTEM_STEM_LEAF_NODE2: "LeafNode2",
    // 与动态活动分类节点对应。
    TbWheelActivity: "TbWheelActivity",
    RoutineActivity: "RoutineActivity",
    ValueActivity: "ValueActivity",
    FestivalActivity: "FestivalActivity",
    HorseEventActivity: "HorseEventActivity",
    FissionActivity: "FissionActivity",
    ActivityBackflow: "ActivityBackflow",
    CampaignActivity: "CampaignActivity",
    S3BeginActivity: "S3BeginActivity",
    FengcaiSeason1Activity: "FengcaiSeason1Activity",
};

// 红点基础配置：type 指定数字或图标，pos 指定相对父节点的显示位置。
export let RedDotConfig = {
    [RedDotKey.SYSTEM_ROOT1]: { type: RedDotType.RedCount, pos: new Vec3(100, 25) },
    [RedDotKey.SYSTEM_STEM_NODE1]: { type: RedDotType.RedCount, pos: new Vec3(100, 25) },
    [RedDotKey.SYSTEM_STEM_LEAF_NODE1]: { type: RedDotType.RedCount, pos: new Vec3(100, 25) },
    [RedDotKey.SYSTEM_STEM_LEAF_NODE2]: { type: RedDotType.RedIcon, pos: new Vec3(100, 25) },
};


export class RedDotUtils {
    static readonly ActivityRedDotKeyHead = "Activity";
    static readonly BattlePassActivityType = "10";
    static readonly DefaultActivityRedIconCfg = { type: RedDotType.RedIcon, pos: new Vec3(86, -18) };
    static readonly DefaultActivityRedCountCfg = { type: RedDotType.RedCount, pos: new Vec3(86, -18) };
    static readonly DefaultActivityEntranceCfg = { type: RedDotType.RedIcon, pos: new Vec3(26, 26) };

    //最强领主
    static readonly DefaultSLScoreHintCfg_78 = { type: RedDotType.RedIcon, pos: new Vec3(22, 18) };
    static readonly DefaultSLScoreHintCfg_79 = { type: RedDotType.RedIcon, pos: new Vec3(38, 30) };
    static readonly ActivityTagRedDotParentKeyMap: Readonly<Record<string, string>> = {
        "990": RedDotKey.TbWheelActivity,
        "1000": RedDotKey.RoutineActivity,
        "1001": RedDotKey.ValueActivity,
        "1003": RedDotKey.FestivalActivity,
        "1004": RedDotKey.HorseEventActivity,
        "1005": RedDotKey.FissionActivity,
        "1006": RedDotKey.ActivityBackflow,
        "1009": RedDotKey.CampaignActivity,
        "1011": RedDotKey.S3BeginActivity,
        "1012": RedDotKey.FengcaiSeason1Activity,
    };

    static getActivityRedDotKey(activityId: string | number) {
        return `${RedDotUtils.ActivityRedDotKeyHead}${activityId}`;
    }

    private static _digitOnlyRegex = new RegExp("^\\d+$");
    static getActivityCfgFromKey(key: string, head: string) {
        if (key.length <= head.length || !key.startsWith(head)) {
            return undefined;
        }
        const suffix = key.slice(head.length);
        if (!RedDotUtils._digitOnlyRegex.test(suffix)) {
            return undefined;
        }
        return ConfigUtils.GetConfigById(CfgName.ActivityMain, suffix);
    }

    //红点树构建前添加配置
    static createOtherRedDotTreeConfig() {
        for (const activityCfg of ConfigUtils.GetCfgRawList(CfgName.ActivityMain)) {
            const activityId = activityCfg.id;
            const activityType = activityCfg.activityType;
            if (activityType == "78" || activityType == "79") {
                const key = RedDotUtils.getActivityRedDotKey(activityId);
                if (!RedDotTreeConfig.RedDotRoot.RoutineActivity[key]) {
                    RedDotTreeConfig.RedDotRoot.RoutineActivity[key] = {
                        [`SLScoreHint${activityId}`]: {},
                        [`SLScoreTask${activityId}`]: {},
                    };
                }
            } else if (activityType == RedDotUtils.BattlePassActivityType) {
                RedDotUtils.addActivityRedDotNode(activityCfg);
            }
        }
    }

    private static addActivityRedDotNode(activityCfg: { id: number, tag?: string }) {
        const parentCfg = RedDotUtils.getActivityRedDotParentCfg(activityCfg);
        if (!parentCfg) {
            return;
        }
        const key = RedDotUtils.getActivityRedDotKey(activityCfg.id);
        if (!parentCfg[key]) {
            parentCfg[key] = {};
        }
    }

    private static getActivityRedDotParentCfg(activityCfg: { tag?: string }) {
        const parentKey = RedDotUtils.ActivityTagRedDotParentKeyMap[activityCfg?.tag || ""];
        return parentKey ? RedDotTreeConfig.RedDotRoot[parentKey] : undefined;
    }

    //优先找RedDotKey，找不到返回key
    static getRedDotKey(key: string) {
        return RedDotKey[key] ?? key;
    }

    //优先找配置有的，其次根据前缀判断辅佐后面的id进行判断
    static getRedDotConfig(key: string): Readonly<{ type: RedDotType, pos: Vec3 }> | undefined {
        if (!key) { return undefined; }

        //配置表中有的直接返回
        if (RedDotConfig[key]) { return RedDotConfig[key]; }

        //活动
        let activityCfg = RedDotUtils.getActivityCfgFromKey(key, RedDotUtils.ActivityRedDotKeyHead);
        if (activityCfg) {
            if (activityCfg.activityType == "78" || activityCfg.activityType == "79") { return RedDotUtils.DefaultActivityRedIconCfg; }  //最强领主
            else if (activityCfg.activityType == RedDotUtils.BattlePassActivityType) { return RedDotUtils.DefaultActivityRedCountCfg; }
            else { return RedDotUtils.DefaultActivityRedCountCfg; }
        }

        //最强领主
        activityCfg = RedDotUtils.getActivityCfgFromKey(key, "SLScoreTask");
        if (activityCfg) { return activityCfg.activityType == "78" || activityCfg.activityType == "79" ? RedDotUtils.DefaultActivityEntranceCfg : undefined; }
        activityCfg = RedDotUtils.getActivityCfgFromKey(key, "SLScoreHint");
        if (activityCfg) {
            if (activityCfg.activityType == "78") { return RedDotUtils.DefaultSLScoreHintCfg_78; }
            else if (activityCfg.activityType == "79") { return RedDotUtils.DefaultSLScoreHintCfg_79; }
            else { return undefined; }
        }

        return undefined;
    }
}
