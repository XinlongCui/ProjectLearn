/* [学习注释]
 * 【本文件职责】日志文件名、上传参数和追加文本模板的共享配置中心。
 * 配置是模块级单例，不属于某一个Manager或房间；多个玩法使用时会共享、覆盖同一份配置。
 * 没有文件读写或网络上传，只有配置对象管理。实际写入在MngLocalFile，上传在UIMngLocalFile。
 * Partial<ILocalFileConfig>只让第一层可选，并不是递归DeepPartial；TypeScript调用时upload内部仍按完整接口检查。
 * [/学习注释]
 */
/**
 * 本地文件追加 + 上传 的通用配置中心
 * ---- 示例配置1 ----
 * 设计目标：让任何玩法都能"一行接入"，无需改 UI 组件本身：
 *   import { setLocalFileConfig } from "...local_file/local_file_config";
 *
 *   setLocalFileConfig({
 *       fileName: `color_game/${roomId}/replay.json`,
 *       upload: { formData: { source: 'color_game', roomId } },
 *       appendLineTemplate: (tick) => JSON.stringify({ tick, ts: Date.now() }) + '\n',
 *   });
 * 
 * ---- 示例配置2 ----
 *  setLocalFileConfig({
 *      fileName: `frame_sync/battle_${battleId}.log`,
 *      upload: { formData: { source: 'frame_sync', battleId } },
 *  });
 * 
 * 
 *
 * 然后场景里挂 UIMngLocalFile 组件即可使用；或直接调用 MngLocalFile 的接口都可以。
 *
 * 配置是单例（全局只有一份当前值），如果同一进程内多个玩法可能交叉触发上传，
 * 各玩法在进入自己流程时再次 setLocalFileConfig(...) 覆盖，离开时按需 resetLocalFileConfig()。
 */

/* [学习注释]
 * name是multipart文件字段名，要与上传服务一致；formData是附加表单字段；timeout单位毫秒且只在wx上传路径使用。
 * [/学习注释]
 */
export interface ILocalFileUploadConfig {
    /** multipart/form-data 文件字段名，需与服务端 server.py 中接收的字段一致（默认 'file'） */
    name: string;
    /** 附加表单字段，会一起 POST 给服务器，便于服务端按 tag 归档 */
    formData: { [k: string]: string | number | boolean };
    /** wx.uploadFile 的超时（ms），fetch 路径忽略此项 */
    timeout: number;
}

/* [学习注释]
 * fileName是相对路径，appendLineTemplate是可调用模板；定义模板不代表框架会自动定时追加日志。
 * [/学习注释]
 */
export interface ILocalFileConfig {
    /** 客户端本地相对路径，相对 wx.env.USER_DATA_PATH / native getWritablePath() / 编辑器 temp/ 等 */
    fileName: string;

    upload: ILocalFileUploadConfig;

    /** 每次"写入"按钮 / 业务侧主动追加时生成单行内容的模板 */
    appendLineTemplate: (tick: number, extra?: any) => string;
}

/* [学习注释]
 * 默认文件frame_sync_demo.log，默认表单字段file、超时30000ms。模板使用本地时间，适合日志而非确定性模拟输入。
 * [/学习注释]
 */
const DEFAULT_CONFIG: ILocalFileConfig = {
    fileName: 'frame_sync_demo.log',
    upload: {
        name: 'file',
        formData: { source: 'minigame_demo' },
        timeout: 30000,
    },
    appendLineTemplate: (tick) => `[${new Date().toLocaleString()}] tick=${tick}\n`,
};

/* [学习注释]
 * 从默认值复制出当前配置，避免修改当前formData时直接污染默认配置。
 * [/学习注释]
 */
let _current: ILocalFileConfig = cloneConfig(DEFAULT_CONFIG);

/** 获取当前生效的配置（不要持有返回值长期引用，因为 setLocalFileConfig 会替换其内部对象） */
/* [学习注释]
 * 直接返回当前可变对象，不是副本。调用者修改其字段会影响全局配置；reset后旧引用不会自动变为新对象。
 * [/学习注释]
 */
export function getLocalFileConfig(): ILocalFileConfig {
    return _current;
}

/**
 * 合并式覆盖：只覆盖传入的字段，其他保留。
 * - upload.formData 是浅合并（旧 formData 字段保留 + 新字段覆盖/新增）
 * - 其他字段是整体替换
 */
/* [学习注释]
 * 选择性更新：fileName/模板要求真值；upload.name/timeout使用!=null，允许空字符串或0覆盖。
 * formData浅合并保留旧key；换玩法时不希望旧字段残留，应考虑reset。
 * [/学习注释]
 */
export function setLocalFileConfig(partial: Partial<ILocalFileConfig>): void {
    if (!partial) { return; }

    if (partial.fileName) { _current.fileName = partial.fileName; }
    if (partial.appendLineTemplate) { _current.appendLineTemplate = partial.appendLineTemplate; }

    if (partial.upload) {
        /* [学习注释]
         * 重新创建upload对象，因此之前保存的upload引用不会跟随变化；_current顶层对象在set里并未整体替换。
         * [/学习注释]
         */
        _current.upload = {
            name: partial.upload.name != null ? partial.upload.name : _current.upload.name,
            timeout: partial.upload.timeout != null ? partial.upload.timeout : _current.upload.timeout,
            formData: { ..._current.upload.formData, ...(partial.upload.formData || {}) },
        };
    }
}

/** 重置为出厂默认配置（玩法退出时可调用，避免影响下一个玩法） */
/* [学习注释]
 * 整体替换_current为默认副本；之前持有旧配置引用的调用者不会自动看到新值。
 * [/学习注释]
 */
export function resetLocalFileConfig(): void {
    _current = cloneConfig(DEFAULT_CONFIG);
}

/* [学习注释]
 * 复制顶层、upload和formData对象；函数appendLineTemplate保留同一引用，不是通用递归深拷贝。
 * [/学习注释]
 */
function cloneConfig(src: ILocalFileConfig): ILocalFileConfig {
    return {
        fileName: src.fileName,
        appendLineTemplate: src.appendLineTemplate,
        upload: {
            name: src.upload.name,
            timeout: src.upload.timeout,
            formData: { ...src.upload.formData },
        },
    };
}
