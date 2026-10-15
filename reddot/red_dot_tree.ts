import { Node } from "cc";
import { RedDotKey, RedDotTreeConfig, RedDotUtils } from "./red_dot_config";
import { RedDotNodeType, RedDotType, KeyType } from "./red_dot_const";
import { RedDotNode, Callback, InstanceType } from "./red_dot_node";
import RedSystem from "./red_dot_system";
import { DEV } from "cc/env";

export default class RedDotTree {
    _nodeTree: RedDotNode;
    _redNodeDic: Map<string, RedDotNode>;
    constructor() {

    }

    public init() {
        this._redNodeDic = new Map<string, RedDotNode>();
        RedDotUtils.createOtherRedDotTreeConfig();
        this.createTree(RedDotTreeConfig);
    }

    //业务层绑定红点
    public bindRedDotCallBack(key: KeyType, callBack: Callback, instance: InstanceType) {
        this.ensureActivityRedDotNode(key);
        let redNode = this._redNodeDic[key] as RedDotNode;
        if (redNode) {
            redNode.callBack = callBack;
            redNode.instance = instance;
            redNode.updateStateCallback();
        } else {
            console.error(`未找到RedDotNode：${key}`);
        }
    }
    public bindRedDotsCallBack(keys: KeyType[], callBack: Callback, instance: InstanceType) {
        for (let key of keys) {
            this.bindRedDotCallBack(key, callBack, instance);
        }
    }

    //业务层取消绑定红点
    public unBindRedDotCallBack(key: KeyType) {
        if (this._redNodeDic[key]) {
            this._redNodeDic[key].callBack = null;
            this._redNodeDic[key].instance = null;

            // 回收业务层红点对象
            if (this._redNodeDic[key].node) {
                RedSystem.instance.pushRedDotPool(this._redNodeDic[key].node);
            }
            this._redNodeDic[key].node = null;
        }
    }
    public unBindRedDotsCallBack(keys: KeyType[]) {
        for (let key of keys) {
            this.unBindRedDotCallBack(key);
        }
    }

    // 业务层绑定红点实例对象
    public bindRedDotNode(key: KeyType, node: Node) {
        if (this._redNodeDic[key]) {
            this._redNodeDic[key].node = node;
        }
    }
    public getRedDotNode(key: KeyType): Node {
        if (this._redNodeDic[key] && this._redNodeDic[key].node) {
            return this._redNodeDic[key].node;
        }
        return null;
    }

    /** 
     * 业务层设置红点数据
     * @param key 红点树的节点Key
     * @param redCount 该节点红点数量(0: 无,<=1 代表有红点提示)
     * @param redType 红点类型
     */
    public setRedDotData(key: KeyType, redCount: number | boolean = 0) {
        this.ensureActivityRedDotNode(key);
        if (this._redNodeDic[key]) {
            let tempCount = 0;
            if (typeof redCount == "boolean") {
                tempCount = redCount ? 1 : 0;
            } else {
                tempCount = redCount;
            }
            // console.log("【RD】 Set ==> Key :"+key+" Count : "+tempCount);
            if (!this._redNodeDic[key].redType) {
                this._redNodeDic[key].redType = RedDotUtils.getRedDotConfig(key)?.type;
            }
            this._redNodeDic[key].redCount = tempCount;
            (globalThis.DEBUG_MODEL || globalThis.updateInfo?.showRedDotLog) && console.log("【RD】 Set ==> Key :" + key + " Count : " + tempCount);
        }
    }
    //业务层获取红点数据
    public getRedDotData(key: KeyType): [RedDotType, number] {
        this.ensureActivityRedDotNode(key);
        if (key == undefined || this._redNodeDic[key] == undefined) { return [null, null]; }
        if (this._redNodeDic[key]) {
            return [this._redNodeDic[key].redType, this._redNodeDic[key].redCount];
        }
    }

    // 查看指定枝干红点状态(PS: 当前节点以及所有父节点)
    public checkRedDotStemState(key: KeyType) {
        var tempNode = this._redNodeDic[key];
        var tempKeyPath = "";
        if (tempNode) {
            while (tempNode) {
                tempKeyPath = tempKeyPath == "" ? tempNode.key : tempKeyPath + "/" + tempNode.key;
                // console.log("【RD】 Check ==> Key :"+tempKeyPath+" Count : "+tempNode.redCount);
                tempNode = tempNode.parentNode;
            }
        }
    }

    /**
     * 按需创建普通活动入口红点节点，避免每期活动都修改静态红点树配置。
     */
    private ensureActivityRedDotNode(key: KeyType): void {
        if (!key || !this._redNodeDic || !this._nodeTree || this._redNodeDic[key]) {
            return;
        }

        let activityCfg = RedDotUtils.getActivityCfgFromKey(key, RedDotUtils.ActivityRedDotKeyHead);
        if (!activityCfg || activityCfg.activityType == "78" || activityCfg.activityType == "79"
            || activityCfg.activityType == RedDotUtils.BattlePassActivityType) {
            return;
        }

        let parentKey = RedDotUtils.ActivityTagRedDotParentKeyMap[activityCfg.tag || ""];
        let parentNode = parentKey ? this._redNodeDic[parentKey] : this._nodeTree;
        if (!parentNode) {
            parentNode = this._nodeTree;
        }

        let redNode = new RedDotNode(key);
        redNode.nodeType = RedDotNodeType.Fork;
        redNode.parentNode = parentNode;
        redNode.redType = RedDotType.RedCount;
        this._redNodeDic[key] = redNode;
        parentNode.addChild(redNode);
    }

    private createTree(root: any) {
        this._nodeTree = this.createNode(root[RedDotKey.RED_DOT_ROOT], RedDotKey.RED_DOT_ROOT, null, true);
    }
    private createNode(cfg: any, key: any, parentNode: RedDotNode, isRoot: boolean) {
        let curNode = new RedDotNode(key);
        if (isRoot) {
            curNode.nodeType = RedDotNodeType.Root;
            curNode.redType = RedDotType.None;
        } else {
            curNode.nodeType = RedDotNodeType.Fork;
            curNode.parentNode = parentNode;
        }
        if (DEV && this._redNodeDic[key]) { console.error(`RedDotTree: ${key} already exists`); }
        this._redNodeDic[key] = curNode;
        for (const k in cfg) {
            if (Object.prototype.hasOwnProperty.call(cfg, k)) {
                curNode.addChild(this.createNode(cfg[k], k, curNode, false))
            }
        }
        return curNode;
    }
}
