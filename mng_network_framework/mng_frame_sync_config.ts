/* [学习注释]
 * 【本文件职责】声明配置契约和默认值。这里没有计时器，也不会启动帧循环。
 * Manager 在构造时复制配置；逻辑/渲染帧率用于帧号比例换算，interval 才是时间推进实际使用的间隔。
 * 修改帧率时应同时提供一致的间隔，例如 logicFrameRate=20、logicFrameInterval=1/20。
 * [/学习注释]
 */
/**
 * 帧同步框架 - 配置定义
 */

/** 帧同步配置 */
/* [学习注释]
 * 时间单位：logicFrameInterval、renderFrameInterval 都是秒；Manager 内部转换为整数微秒。
 * 帧数单位：serverFrameDelay、maxFrameCache 都不是毫秒。
 * [/学习注释]
 */
export interface MngFrameSyncConfig {
    /** 逻辑帧率（每秒帧数，默认15帧） */
    logicFrameRate: number;
    /** 渲染帧率（每秒帧数，默认60帧） */
    renderFrameRate: number;
    /** 服务器帧延迟（延迟N帧处理，用于缓存对抗网络波动，默认5帧） */
    /* [学习注释]
     * 双重作用：本地输入的缓存 key=原始帧号+delay；目标本地帧号=服务器帧号-delay。
     * 注意原注释中的“延迟处理”不能理解为所有服务器回调都等待 N 帧：正常 onServerFrame 会立即调用。
     * [/学习注释]
     */
    serverFrameDelay: number;
    /** 最大帧缓存数量（默认600帧） */
    /* [学习注释]
     * 作为 Buffer 清理窗口参数；当前按帧号范围删除旧数据，并非严格的固定容量 FIFO。
     * 连续 key 场景中由于删除条件是小于阈值，边界上可能保留 maxFrameCache+1 个记录。
     * [/学习注释]
     */
    maxFrameCache: number;
    /** 本地预测开关（默认false） */
    /* [学习注释]
     * 启用后 addClientFrame 尝试预测下一帧；不会因此自动发送预测数据或立刻推进逻辑帧。
     * [/学习注释]
     */
    enableLocalPredict: boolean;
    /** 服务器矫正开关（默认true） */
    /* [学习注释]
     * 允许服务器数据补充/修正 clientFrame 缓存。关闭后仍然接收、缓存并派发服务器帧。
     * [/学习注释]
     */
    enableServerCorrection: boolean;
    /** 逻辑帧间隔（秒） */
    logicFrameInterval: number;
    /** 渲染帧间隔（秒） */
    renderFrameInterval: number;
}

/** 默认帧同步配置 */
/* [学习注释]
 * 默认约15Hz逻辑、60Hz渲染，分别约66.666ms和16.666ms。
 * 数值是截取后的小数，并非精确的1/15、1/60；转为微秒后分别是66666、16666。
 * 预测默认关闭、校正默认开启，意味着不预测时仍可从服务器数据创建客户端缓存。
 * [/学习注释]
 */
export const MNG_DEFAULT_FRAME_SYNC_CONFIG: MngFrameSyncConfig = {
    logicFrameRate: 15,
    renderFrameRate: 60,
    serverFrameDelay: 5,
    maxFrameCache: 600,
    enableLocalPredict: false,
    enableServerCorrection: true,
    logicFrameInterval: 0.066666,
    renderFrameInterval: 0.016666,
};
