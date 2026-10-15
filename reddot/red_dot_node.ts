import { Component } from "cc";
import { RedDotKey, RedDotUtils} from "./red_dot_config";
import { RedDotNodeType, RedDotType, KeyType } from "./red_dot_const";
import { Notifier } from "../../client_core/global/notifier_center";
import { SimEventType } from "../sim/sim_const";

export interface Callback{
    (key:KeyType,redType:RedDotType,count:number):void
}
export type InstanceType = Component;

export class RedDotNode{
    private _instance:InstanceType;
    private _key:KeyType;
    private _nodeType:RedDotNodeType;
    private _parentNode:RedDotNode;
    private _callback:Callback;
    private _redType:RedDotType;
    private _redCount:number = 0;
    private _childList:RedDotNode[];
    private _node: Node;

    constructor(key:KeyType){
        this._key = key;
        this._childList = [];
       
    }
    
    public get instance ():InstanceType{
        return this._instance;
    }
    public set instance(instance:InstanceType){
        this._instance = instance;
    }

    public get key():KeyType{
        return this._key;
    }

    public get nodeType():RedDotNodeType{
        return this._nodeType;
    }
    public set nodeType(nodeType){
        this._nodeType = nodeType
    }

    public get parentNode():RedDotNode{
        return this._parentNode;
    }
    public set parentNode(node:RedDotNode){
        this._parentNode = node;
    }

    public get callBack():Callback{
        return this._callback;
    }
    public set callBack(callBack:Callback){
        this._callback = callBack;
    }

    public get redType():RedDotType{
        return this._redType;
    }
    public set redType(state:RedDotType){
        if(this._redType != state){
            this._redType = state;
        }
    }

    public get redCount(): number {
        return this._redCount;
    }
    public set redCount(count: number) {
        if(this._redCount != count){
            this._redCount = count;
            this.updateStateCallback();
            this.updateParentState(this.parentNode);
            if(this.key==RedDotKey.Activity_AllianceBattle){
                Notifier.trigger(SimEventType.AllianceBattleOutEntrance,count );
            }
            if(this.key==RedDotKey.Activity_CampPk){
                Notifier.trigger(SimEventType.CampPkOutEntrance,count );
            }
        }
    }

    public get node(): Node {
        return this._node;
    }
    public set node(node: Node) {
        this._node = node;
    }

    public addChild(node:RedDotNode) {
        this._childList.push(node);
    }
    public updateStateCallback(){
        if(this._callback){
            this._callback.call(this.instance,this.key,this.redType,this.redCount);
        }
    }
    public updateParentState(parentNode:RedDotNode){
        if(parentNode.nodeType == RedDotNodeType.Root){
            return;
        }
        
        parentNode.redCount = parentNode.getChildRedCount();
    }

    private getChildRedCount(): number {
        let tempRedCount = 0;
        let childList = this._childList;
        for (let index = 0; index < childList.length; index++) {
            const element = childList[index];
            tempRedCount = tempRedCount + element.redCount;
            if (!this.redType) {
                this.redType = RedDotUtils.getRedDotConfig(this.key)?.type;
            }
        }
        return tempRedCount;
    }
}