import { isValid, Node, Vec3 } from "cc";
import { AssetsLoader } from "../../client_core/global/assets_loader";
import { Notifier } from "../../client_core/global/notifier_center";
import { SimEventType } from "../sim/sim_const";
import { Utils } from "../../client_core/utils/utils";
import { EAssetGroupName } from "../common/asset_const";
import { MHPoolMgr } from "../global/MHPoolMgr";
import { RedDotUtils, RedDotKey } from "./red_dot_config";
import { KeyType, RedDotPrefabPath } from "./red_dot_const";
import RedDotTree from "./red_dot_tree";
import { UIRedDotComp } from "./ui_red_dot_comp";

/** 红点业务层示例：更新叶子节点数据，并管理界面红点对象。 */
export default class RedSystem extends RedDotTree {
    private static _instance: RedSystem;

    public static get instance(): RedSystem {
        if (!RedSystem._instance) {
            RedSystem._instance = new RedSystem();
            RedSystem._instance.init();
            RedSystem._instance.registerMsg();
        }
        return RedSystem._instance;
    }

    // 红点对象池，用于复用界面节点。
    private _redDotPool: Node[];

    private constructor() {
        super();
        this._redDotPool = [];
    }

    // 事件监听示例：单例初始化时注册，并指定回调中的 this。
    private registerMsg() {
        Notifier.listen(SimEventType.CrossDay, this.onCrossDay, this);
    }

    // 跨天后调用更新函数；示例清零，实际业务可在这里读取最新数据。
    private onCrossDay() {
        this.updateTestRedDotState(0, false);
    }


    // 测试示例：切换指定叶子节点的红点状态。
    updateTestRedDotState(key: KeyType) {
        const count = this.getRedDotData(key)[1];
        this.setRedDotData(key, count == 0 ? 1 : 0);
    }

    // 创建界面红点：优先复用已有节点或对象池，再按配置设置显示位置。
    async createRedDotPrefab(key: KeyType, parent: Node, reuseExistingInParent: boolean = false) {
        if (!parent || !isValid(parent, true)) {
            return;
        }
        const _redDotNodeName = "ui_red_dot_comp";
        let tempNode = null;
        // 界面缓存 存在红点节点，则直接返回
        if (reuseExistingInParent) {
            let _redNode = parent.getChildByName(_redDotNodeName);
            if (_redNode && _redNode.getComponent(UIRedDotComp)) {
                tempNode = _redNode;
            }
        }

        if (!tempNode) {
            tempNode = this._redDotPool.pop();
            if (!tempNode) {
                let tempPrefab = await AssetsLoader.loadPrefab(RedDotPrefabPath, EAssetGroupName.Resident);
                //再获取一次.连续触发await,会创建多个
                let lastNode = RedSystem.instance.getRedDotNode(key);
                if (lastNode) {
                    tempNode = lastNode;
                } else {
                    tempNode = Utils.instantiate(tempPrefab, UIRedDotComp) as Node;
                }
            }
            tempNode.name = _redDotNodeName;
            if (isValid(parent, true)) {
                tempNode.setParent(parent);
            }
        }

        tempNode.position = RedDotUtils.getRedDotConfig(key)?.pos ?? Vec3.ZERO;
        // 首次: 绑定业务层红点实例对象(主要用于回收操作)
        RedSystem.instance.bindRedDotNode(key, tempNode);
        return tempNode;
    }

    // 解绑时回收界面红点；无效节点或关闭对象池时直接销毁。
    pushRedDotPool(node: Node) {
        if (isValid(node, true) && !globalThis.updateInfo?.closeReddotPool) {
            node.setParent(MHPoolMgr.transPoolRD);
            this._redDotPool.push(node);
        } else {
            try {
                node?.destroy();
            } catch (error) {
                console.error(`[RedSystem] 尝试返回无效节点到对象池: ${error}`);
            }
        }
    }
}
