// 红点Key值类型
export type KeyType = string;

export const RedDotPrefabPath = "ui/prefab/common/ui_red_dot_comp";

export enum RedDotNodeType{
    Root = 1, //根节点
    Fork = 2, //分叉节点
    Leaf = 3, //叶子节点
}


// 红点类型
export enum RedDotType {
    None = 0,
    RedIcon = 1,    // 红点Icon
    RedCount = 2    // 红点数量
}
