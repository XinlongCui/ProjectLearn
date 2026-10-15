import { macro, _decorator, Node, Label } from "cc";
import { ncg } from '../../client_core/global/core_decorator';
import BaseComponent from '../../client_core/ui/base_component';
import { RedDotType, KeyType } from "./red_dot_const";

const { ccclass } = _decorator;

@ccclass("UIRedDotComp")
export class UIRedDotComp extends BaseComponent {

    // 红点图片类型
    @ncg("red_icon")
    redIcon: Node;

    // 红点数字类型
    @ncg("red_count")
    redCount: Node;
    @ncg({ path: "red_count.Icon.lab_red_count", type: Label})
    labRedCount: Label;

    /**
     * 设置红点状态
     * @param type 红点显示类型
     * @param val 红点数量(0: 不提示红点 , >=1: 显示红点)
     */
    setState(type: RedDotType,val: number) {
        this.node.active = val >= 1;
        if (val >= 1) {
            if(this.redIcon){
                this.redIcon.active = type != RedDotType.RedCount;
            }
            if(this.redCount){
                this.redCount.active = type === RedDotType.RedCount;
            }
            if (type === RedDotType.RedCount && this.labRedCount) {
                this.labRedCount.string = val.toString();
            }
        }
    }
}
