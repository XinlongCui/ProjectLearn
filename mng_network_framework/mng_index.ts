/* [学习注释]
 * 【本文件职责】统一导出入口（barrel）。各玩法可从此处一次导入核心类型和组件。
 * export * 重新导出目标模块的具名导出，不会创建 Manager/Driver 实例，也不会自动注册网络消息。
 * utils 和 example 不在这份导出列表中；用到它们时仍需明确导入具体文件。
 * [/学习注释]
 */
/**
 * 帧同步框架 - 统一导出
 */

// 基础数据模型
/* [学习注释]
 * 先理解这组模型：操作→玩家操作组→完整帧包，后面所有泛型都建立在它们之上。
 * [/学习注释]
 */
export * from "./mng_base_frame_data";

// 配置
export * from "./mng_frame_sync_config";

// 类型、枚举、接口
export * from "./mng_frame_sync_types";

// 核心组件
/* [学习注释]
 * 内部组合组件：Buffer保存、Predictor外推、Corrector合并；Manager负责调度它们。
 * [/学习注释]
 */
export * from "./mng_frame_buffer";
export * from "./mng_frame_predictor";
export * from "./mng_frame_corrector";
export * from "./mng_client_frame_sync_manager";

// 抽象基类（协议层 & 驱动层）
/* [学习注释]
 * 抽象接入层：Protocol由玩法定义真实消息；Driver负责桥接、连续性检测和生命周期。
 * [/学习注释]
 */
export * from "./mng_base_frame_sync_protocol";
export * from "./mng_base_frame_sync_driver";
