/* [学习注释]
 * 【本文件职责】统一的日志读写门面和四个平台存储策略，不属于逻辑帧收发队列。
 * 门面→首次选择适配器→路径处理→读写；上传网络请求由另一个UI文件发起。
 * 平台差异要逐条看：原生追加读旧再重写、Node直接append、浏览器模拟文件，异步API的实际调度也不同。
 * 此学习版只解释当前行为，不改同步IO、错误处理、平台能力探测或业务日志文件名。
 * [/学习注释]
 */
import { native, sys } from "cc";
import { EDITOR, MINIGAME, NATIVE } from "cc/env";
import { getLocalFileConfig, setLocalFileConfig } from "./local_file_config";
import { UserInfo } from "../../../survey/ui_questionnaire_web";
import { isFootballLocalFile } from "../mng_const";

/**
 * 本地文件读写工具（多平台）
 *
 * 平台分流（自动选择，优先级从上到下）：
 *  1. 微信/字节/支付宝等小游戏 (MINIGAME)   - 走 wx.getFileSystemManager() / wx.env.USER_DATA_PATH
 *  2. 原生 App (iOS/Android, NATIVE)        - 走 native.fileUtils
 *  3. Cocos Creator 编辑器 (EDITOR)         - 走 Node.js fs
 *  4. 浏览器/Web 预览 / 其他                - 走 sys.localStorage 兜底
 *
 * - 写入前会自动递归创建缺失的目录
 * - relPath 是相对"用户可写根目录"的相对路径，例如:
 *     MngLocalFile.writeFileSync("frame_sync/log_1.txt", "hello");
 *   会落到各平台对应的可写目录下
 */
/* [学习注释]
 * 静态门面：业务只调用统一API，内部把路径/内容交给平台适配器。
 * 此文件依赖Cocos和UserInfo，拷到桌面是学习副本，不是可脱离原工程独立运行的库。
 * [/学习注释]
 */
export class MngLocalFile {
    private static readonly TAG = "[MngLocalFile]";

    // 编辑器/Web 兜底时使用的子目录名，便于排查/清理
    private static readonly SUB_DIR = "mng_local_file";

    /* [学习注释]
     * 首次选择后缓存适配器，本会话后续调用复用；不会每次读写重新检测平台。
     * [/学习注释]
     */
    private static _adapter: IFileAdapter | null = null;

    /* [学习注释]
     * 按能力和环境顺序选择：MINIGAME且有wx文件API→NATIVE且有fileUtils→EDITOR且有Node fs→LocalStorage。
     * 不是仅凭“小游戏”就支持所有厂商；当前明确检测globalThis.wx，其他平台需提供兼容接口。
     * [/学习注释]
     */
    private static getAdapter(): IFileAdapter {
        if (MngLocalFile._adapter) { return MngLocalFile._adapter; }

        if (MINIGAME && MngLocalFile.hasWxFs()) {
            MngLocalFile._adapter = new MiniGameFileAdapter();
        } else if (NATIVE && MngLocalFile.hasNativeFs()) {
            MngLocalFile._adapter = new NativeFileAdapter();
        } else if (EDITOR && MngLocalFile.hasNodeFs()) {
            MngLocalFile._adapter = new EditorFileAdapter();
        } else {
            MngLocalFile._adapter = new LocalStorageAdapter();
        }

        console.log(MngLocalFile.TAG, "using adapter:", MngLocalFile._adapter.name);
        return MngLocalFile._adapter;
    }

    /* [学习注释]
     * 同时检查wx.getFileSystemManager、wx.env.USER_DATA_PATH。原注释列出的平台名称不能代替这些真实能力条件。
     * [/学习注释]
     */
    private static hasWxFs(): boolean {
        const wx = (globalThis as any).wx;
        return !!(wx && typeof wx.getFileSystemManager === "function" && wx.env && wx.env.USER_DATA_PATH);
    }

    /* [学习注释]
     * 检测native.fileUtils和getWritablePath，异常时返回false以便回退。
     * [/学习注释]
     */
    private static hasNativeFs(): boolean {
        try {
            return !!(native && (native as any).fileUtils && typeof (native as any).fileUtils.getWritablePath === "function");
        } catch (e) {
            return false;
        }
    }

    /* [学习注释]
     * 检测globalThis.require可调用并能加载fs；普通浏览器即使桌面运行也通常没有这个能力。
     * [/学习注释]
     */
    private static hasNodeFs(): boolean {
        try {
            const req = (globalThis as any).require;
            if (typeof req !== "function") { return false; }
            return !!req("fs");
        } catch (e) {
            return false;
        }
    }

    // ========== 对外 API ==========

    /** 获取当前可写根目录（绝对路径） */
    /* [学习注释]
     * 返回当前适配器根目录。LocalStorage适配器返回空字符串，因为它没有真实磁盘根路径。
     * [/学习注释]
     */
    static getUserDataPath(): string {
        return MngLocalFile.getAdapter().getRoot();
    }

    /** 把相对路径解析成当前平台的绝对路径 */
    /* [学习注释]
     * 统一路径分隔符后交给适配器。浏览器兜底返回相对key，不能把它当作操作系统文件路径上传。
     * [/学习注释]
     */
    static resolvePath(relPath: string): string {
        return MngLocalFile.getAdapter().resolve(MngLocalFile.normalize(relPath));
    }

    /** 同步写入文件（覆盖），自动建目录 */
    /* [学习注释]
     * 覆盖写：已有内容会被新内容替换；空relPath返回false。底层是否支持ArrayBuffer由具体适配器决定。
     * [/学习注释]
     */
    static writeFileSync(relPath: string, content: string | ArrayBuffer, encoding: string = "utf8"): boolean {
        if (!relPath) { return false; }
        return MngLocalFile.getAdapter().writeSync(MngLocalFile.normalize(relPath), content, encoding);
    }

    /** 同步追加内容；文件不存在则自动创建 */
    /* [学习注释]
     * 追加写：追加策略各平台不同。原生/LocalStorage要读取或取出旧全文再拼接，文件大时成本较高。
     * [/学习注释]
     */
    static appendFileSync(relPath: string, content: string | ArrayBuffer, encoding: string = "utf8"): boolean {
        if (!relPath) { return false; }
        return MngLocalFile.getAdapter().appendSync(MngLocalFile.normalize(relPath), content, encoding);
    }

    /** 同步追加内容(默认配置)；文件不存在则自动创建 */
    /* [学习注释]
     * 仅此默认业务入口检查isFootballLocalFile；关闭则返回false。
     * 每次调用会修改全局配置为battle_<roleId>.log，并设置上传字段，然后追加；不是使用任意之前配置的文件名。
     * [/学习注释]
     */
    static appendFileSyncDefault(content: string | ArrayBuffer, encoding: string = "utf8"): boolean {
        if (!isFootballLocalFile()) { return false; }
        setLocalFileConfig({
              fileName: `frame_sync/battle_${UserInfo.roleId}.log`,
              upload: { name: 'file', formData: { source: 'frame_sync' }, timeout: 30000 },
        });
        const relPath = getLocalFileConfig().fileName;
        if (!relPath) { return false; }
        return MngLocalFile.getAdapter().appendSync(MngLocalFile.normalize(relPath), content, encoding);
    }

    /** 同步追加内容(默认配置)；文件不存在则自动创建 */
    /* [学习注释]
     * 测试入口：写battle_<roleId>_test.log，不检查本地日志开关，也会覆盖共享配置的文件名/上传参数。
     * [/学习注释]
     */
    static appendFileSyncDefault02(content: string | ArrayBuffer, encoding: string = "utf8"): boolean {
        setLocalFileConfig({
            fileName: `frame_sync/battle_${UserInfo.roleId}_test.log`,
            upload: { name: 'file', formData: { source: 'frame_sync' }, timeout: 30000 },
        });
        const relPath = getLocalFileConfig().fileName;
        if (!relPath) { return false; }
        return MngLocalFile.getAdapter().appendSync(MngLocalFile.normalize(relPath), content, encoding);
    }

    /**
     * 删除默认帧同步日志文件（与 appendFileSyncDefault 同路径）。
     * 用于开新局前清掉上一局残留，避免上传时把跨局数据一起上传。
     * 不受 isFootballLocalFile 开关约束：即使开关 off 也允许清理（用户可能上一局开关 on、本局 off）。
     * 路径与 appendFileSyncDefault 完全保持一致：`frame_sync/battle_${UserInfo.roleId}.log`
     */
    /* [学习注释]
     * 删除正常battle_<roleId>.log，不受开关限制，且与_test日志不是同一路径。调用同样会修改共享配置。
     * [/学习注释]
     */
    static removeFileSyncDefault(): boolean {
        setLocalFileConfig({
            fileName: `frame_sync/battle_${UserInfo.roleId}.log`,
            upload: { name: 'file', formData: { source: 'frame_sync' }, timeout: 30000 },
        });
        const relPath = getLocalFileConfig().fileName;
        if (!relPath) { return false; }
        return MngLocalFile.getAdapter().removeFileSync(MngLocalFile.normalize(relPath));
    }

    /** 异步写入文件（覆盖），自动建目录 */
    /* [学习注释]
     * 异步风格API通过success/fail回调通知。各适配器实现不同，有的真异步、有的延后同步、有的立即同步回调。
     * [/学习注释]
     */
    static writeFile(
        relPath: string,
        content: string | ArrayBuffer,
        success?: () => void,
        fail?: (err: any) => void,
        encoding: string = "utf8"
    ): void {
        if (!relPath) { fail && fail(new Error("empty path")); return; }
        MngLocalFile.getAdapter().writeAsync(MngLocalFile.normalize(relPath), content, encoding, success, fail);
    }

    /** 同步读取文本 */
    /* [学习注释]
     * 读文本；null表示缺失/失败，空字符串是有效的空文件内容，两者不能混为一谈。
     * [/学习注释]
     */
    static readTextSync(relPath: string, encoding: string = "utf8"): string | null {
        if (!relPath) { return null; }
        return MngLocalFile.getAdapter().readTextSync(MngLocalFile.normalize(relPath), encoding);
    }

    /** 文件/目录是否存在 */
    /* [学习注释]
     * 查询存在性，具体是否能查目录由平台决定；LocalStorage只查询模拟文件key。
     * [/学习注释]
     */
    static existsSync(relPath: string): boolean {
        if (!relPath) { return false; }
        return MngLocalFile.getAdapter().existsSync(MngLocalFile.normalize(relPath));
    }

    /** 删除文件 */
    /* [学习注释]
     * 只删除指定文件/模拟key。调用者应使用受控相对路径；本方法没有完整路径边界校验。
     * [/学习注释]
     */
    static removeFileSync(relPath: string): boolean {
        if (!relPath) { return false; }
        return MngLocalFile.getAdapter().removeFileSync(MngLocalFile.normalize(relPath));
    }

    /** 当前底层适配器名（调试用） */
    /* [学习注释]
     * 调用它也可能触发首次适配器初始化，用于日志展示当前实际走哪条路径。
     * [/学习注释]
     */
    static getAdapterName(): string {
        return MngLocalFile.getAdapter().name;
    }

    /* [学习注释]
     * 只把反斜杠改为斜杠并去掉开头斜杠，不消解..，不是安全的沙箱路径规范化。
     * [/学习注释]
     */
    private static normalize(relPath: string): string {
        return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    }
}

// ========== 适配器接口 ==========

/* [学习注释]
 * 策略接口统一读写操作，门面依赖接口而非具体平台；不同实现的性能、二进制支持和异步时机不完全一致。
 * [/学习注释]
 */
interface IFileAdapter {
    readonly name: string;
    getRoot(): string;
    resolve(relPath: string): string;
    writeSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean;
    appendSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean;
    writeAsync(relPath: string, content: string | ArrayBuffer, encoding: string, success?: () => void, fail?: (err: any) => void): void;
    readTextSync(relPath: string, encoding: string): string | null;
    existsSync(relPath: string): boolean;
    removeFileSync(relPath: string): boolean;
}

const TAG = "[MngLocalFile]";

// ========== 适配器 1: 微信/小游戏 ==========

/* [学习注释]
 * 微信兼容文件API策略：根目录来自wx.env.USER_DATA_PATH；文本带encoding，二进制不传encoding。
 * [/学习注释]
 */
class MiniGameFileAdapter implements IFileAdapter {
    readonly name = "MiniGame";

    private _fs: any;
    private _root: string;

    /* [学习注释]
     * 取得wx文件管理器与USER_DATA_PATH，能力前置由门面的hasWxFs保证。
     * [/学习注释]
     */
    constructor() {
        const wx = (globalThis as any).wx;
        this._fs = wx.getFileSystemManager();
        this._root = wx.env.USER_DATA_PATH;
    }

    /* [学习注释]
     * 返回小游戏用户可写根目录。
     * [/学习注释]
     */
    getRoot(): string { return this._root; }
    /* [学习注释]
     * 根目录+斜杠+相对路径，调用前门面只做简单分隔符规范化。
     * [/学习注释]
     */
    resolve(relPath: string): string { return this._root + "/" + relPath; }

    /* [学习注释]
     * 先access检测目录，不存在则mkdirSync(dir,true)递归创建；失败返回false。
     * [/学习注释]
     */
    private ensureDirSync(dirPath: string): boolean {
        if (!dirPath || dirPath === this._root) { return true; }
        try {
            this._fs.accessSync(dirPath);
            return true;
        } catch (e) {
        }
        try {
            this._fs.mkdirSync(dirPath, true);
            return true;
        } catch (e) {
            console.warn(TAG, "mkdirSync fail:", dirPath, e);
            return false;
        }
    }

    /* [学习注释]
     * 解析完整路径→保证父目录→按字符串或ArrayBuffer分支覆盖写。失败打印并返回false。
     * [/学习注释]
     */
    writeSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean {
        const full = this.resolve(relPath);
        const slash = full.lastIndexOf("/");
        if (slash > 0 && !this.ensureDirSync(full.substring(0, slash))) { return false; }
        try {
            if (typeof content === "string") {
                this._fs.writeFileSync(full, content, encoding);
            } else {
                this._fs.writeFileSync(full, content);
            }
            return true;
        } catch (e) {
            console.warn(TAG, "writeSync fail:", full, e);
            return false;
        }
    }

    /* [学习注释]
     * 优先appendFileSync；任何异常都会退回writeSync覆盖写，不仅限于文件不存在。
     * 因此异常分支可能覆盖已有内容，学习时不要理解为所有失败都无损追加。
     * [/学习注释]
     */
    appendSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean {
        const full = this.resolve(relPath);
        const slash = full.lastIndexOf("/");
        if (slash > 0 && !this.ensureDirSync(full.substring(0, slash))) { return false; }
        try {
            if (typeof content === "string") {
                this._fs.appendFileSync(full, content, encoding);
            } else {
                this._fs.appendFileSync(full, content);
            }
            return true;
        } catch (e) {
            return this.writeSync(relPath, content, encoding);
        }
    }

    /* [学习注释]
     * 小游戏真实回调式writeFile。父目录失败走fail；API同步抛错也在catch中转交fail。
     * [/学习注释]
     */
    writeAsync(relPath: string, content: string | ArrayBuffer, encoding: string, success?: () => void, fail?: (err: any) => void): void {
        const full = this.resolve(relPath);
        const slash = full.lastIndexOf("/");
        if (slash > 0 && !this.ensureDirSync(full.substring(0, slash))) {
            fail && fail(new Error("ensureDir fail: " + full));
            return;
        }

        const params: any = {
            filePath: full,
            data: content,
            success: () => { success && success(); },
            fail: (err: any) => {
                console.warn(TAG, "writeAsync fail:", full, err);
                fail && fail(err);
            }
        };
        if (typeof content === "string") { params.encoding = encoding; }

        try {
            this._fs.writeFile(params);
        } catch (e) {
            console.warn(TAG, "writeAsync throw:", full, e);
            fail && fail(e);
        }
    }

    /* [学习注释]
     * 小游戏readFileSync按encoding读取，任何异常返回null。
     * [/学习注释]
     */
    readTextSync(relPath: string, encoding: string): string | null {
        try {
            return this._fs.readFileSync(this.resolve(relPath), encoding) as string;
        } catch (e) {
            return null;
        }
    }

    /* [学习注释]
     * 用accessSync能否成功判断存在，异常返回false。
     * [/学习注释]
     */
    existsSync(relPath: string): boolean {
        try {
            this._fs.accessSync(this.resolve(relPath));
            return true;
        } catch (e) {
            return false;
        }
    }

    /* [学习注释]
     * 调用unlinkSync删除文件，失败日志并返回false。
     * [/学习注释]
     */
    removeFileSync(relPath: string): boolean {
        try {
            this._fs.unlinkSync(this.resolve(relPath));
            return true;
        } catch (e) {
            console.warn(TAG, "unlinkSync fail:", relPath, e);
            return false;
        }
    }
}

// ========== 适配器 2: 原生 App (iOS / Android) ==========

/* [学习注释]
 * 原生fileUtils策略：追加通过读旧内容再整体写回；异步包装只是setTimeout，真正写文件时仍同步。
 * [/学习注释]
 */
class NativeFileAdapter implements IFileAdapter {
    readonly name = "Native";

    private _fu: any;
    private _root: string;

    /* [学习注释]
     * 取得native.fileUtils及可写目录，规范尾斜杠方便后续拼接。
     * [/学习注释]
     */
    constructor() {
        this._fu = (native as any).fileUtils;
        let root: string = this._fu.getWritablePath() || "";
        if (root && !root.endsWith("/")) { root += "/"; }
        this._root = root;
    }

    /* [学习注释]
     * 返回末尾已规范为斜杠的原生可写目录。
     * [/学习注释]
     */
    getRoot(): string { return this._root; }
    /* [学习注释]
     * 根目录已带尾斜杠，直接拼相对路径。
     * [/学习注释]
     */
    resolve(relPath: string): string { return this._root + relPath; }

    // native.fileUtils.createDirectory 在 Cocos 3.x 会自动递归创建中间目录
    /* [学习注释]
     * 先检查目录存在，再createDirectory，最后再次检查结果；不只依赖创建调用是否抛错。
     * [/学习注释]
     */
    private ensureDirSync(dirPath: string): boolean {
        if (!dirPath) { return true; }
        if (this._fu.isDirectoryExist(dirPath)) { return true; }
        try {
            this._fu.createDirectory(dirPath);
            return this._fu.isDirectoryExist(dirPath);
        } catch (e) {
            console.warn(TAG, "createDirectory fail:", dirPath, e);
            return false;
        }
    }

    /* [学习注释]
     * 文本走writeStringToFile；二进制要求writeDataToFile存在。只把严格true视为成功。
     * [/学习注释]
     */
    writeSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean {
        const full = this.resolve(relPath);
        const slash = full.lastIndexOf("/");
        if (slash > 0 && !this.ensureDirSync(full.substring(0, slash))) { return false; }

        try {
            if (typeof content === "string") {
                return this._fu.writeStringToFile(content, full) === true;
            }
            if (typeof this._fu.writeDataToFile === "function") {
                return this._fu.writeDataToFile(content, full) === true;
            }
            console.warn(TAG, "writeDataToFile not supported on this platform");
            return false;
        } catch (e) {
            console.warn(TAG, "writeSync fail:", full, e);
            return false;
        }
    }

    /* [学习注释]
     * 没有原生append入口，文本读旧全文再拼接写回；二进制分配新Uint8Array拼接旧新两段。
     * 单次追加成本随已有文件大小增加，并非恒定时间追加。
     * [/学习注释]
     */
    appendSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean {
        const full = this.resolve(relPath);
        // native.fileUtils 没有 append 原生接口，读旧内容拼接后整体写回
        if (typeof content === "string") {
            const old = this.existsSync(relPath) ? (this._fu.getStringFromFile(full) || "") : "";
            return this.writeSync(relPath, old + content, encoding);
        }

        if (typeof this._fu.getDataFromFile !== "function" || typeof this._fu.writeDataToFile !== "function") {
            console.warn(TAG, "binary append not supported");
            return false;
        }
        const oldBuf = this.existsSync(relPath) ? (this._fu.getDataFromFile(full) as ArrayBuffer) : new ArrayBuffer(0);
        const merged = new Uint8Array(oldBuf.byteLength + content.byteLength);
        merged.set(new Uint8Array(oldBuf), 0);
        merged.set(new Uint8Array(content), oldBuf.byteLength);
        return this.writeSync(relPath, merged.buffer, encoding);
    }

    /* [学习注释]
     * setTimeout(0)只把同步writeSync推迟到之后执行，不会把IO搬到工作线程；执行时仍可能阻塞。
     * [/学习注释]
     */
    writeAsync(relPath: string, content: string | ArrayBuffer, encoding: string, success?: () => void, fail?: (err: any) => void): void {
        // native 没有异步写接口，包一层 setTimeout 模拟，避免阻塞调用方
        setTimeout(() => {
            if (this.writeSync(relPath, content, encoding)) {
                success && success();
            } else {
                fail && fail(new Error("writeSync fail: " + relPath));
            }
        }, 0);
    }

    /* [学习注释]
     * 先判断文件存在，再getStringFromFile；失败返回null。encoding参数当前未被原生实现使用。
     * [/学习注释]
     */
    readTextSync(relPath: string, encoding: string): string | null {
        try {
            const full = this.resolve(relPath);
            if (!this._fu.isFileExist(full)) { return null; }
            return this._fu.getStringFromFile(full) as string;
        } catch (e) {
            return null;
        }
    }

    /* [学习注释]
     * 文件或目录任一存在就返回true。
     * [/学习注释]
     */
    existsSync(relPath: string): boolean {
        try {
            const full = this.resolve(relPath);
            return this._fu.isFileExist(full) || this._fu.isDirectoryExist(full);
        } catch (e) {
            return false;
        }
    }

    /* [学习注释]
     * 仅在removeFile能力存在时调用，不会用递归删除目录替代。
     * [/学习注释]
     */
    removeFileSync(relPath: string): boolean {
        try {
            const full = this.resolve(relPath);
            if (typeof this._fu.removeFile === "function") {
                return this._fu.removeFile(full) === true;
            }
            // 老版本 cocos 没有 removeFile，可能只有 removeDirectory
            console.warn(TAG, "removeFile not supported");
            return false;
        } catch (e) {
            console.warn(TAG, "removeFile fail:", relPath, e);
            return false;
        }
    }
}

// ========== 适配器 3: Cocos Creator 编辑器 (Node.js fs) ==========

/* [学习注释]
 * 编辑器Node策略：根目录为工程temp/mng_local_file，使用fs/path/Buffer。
 * 普通浏览器预览不等同于EDITOR，能力检测不满足时会走LocalStorage。
 * [/学习注释]
 */
class EditorFileAdapter implements IFileAdapter {
    readonly name = "Editor";

    private _fs: any;
    private _path: any;
    private _Buffer: any;
    private _root: string;

    /* [学习注释]
     * 加载fs/path并取得全局Buffer；优先Editor.Project.path，缺失则回退process.cwd，再创建temp日志目录。
     * [/学习注释]
     */
    constructor() {
        const req = (globalThis as any).require;
        this._fs = req("fs");
        this._path = req("path");
        this._Buffer = (globalThis as any).Buffer;

        const editor = (globalThis as any).Editor;
        const projectPath: string = (editor && editor.Project && editor.Project.path)
            ? editor.Project.path
            : ((globalThis as any).process ? (globalThis as any).process.cwd() : ".");

        this._root = this._path.join(projectPath, "temp", MngLocalFile["SUB_DIR"]);
        this.ensureDirSync(this._root);
    }

    /* [学习注释]
     * 返回编辑器工程temp下的日志目录。
     * [/学习注释]
     */
    getRoot(): string { return this._root; }
    /* [学习注释]
     * 通过Node path.join拼路径，返回当前操作系统风格路径。
     * [/学习注释]
     */
    resolve(relPath: string): string { return this._path.join(this._root, relPath); }

    /* [学习注释]
     * fs.mkdirSync开启recursive；EEXIST被当作成功，其他异常返回false。
     * [/学习注释]
     */
    private ensureDirSync(dirPath: string): boolean {
        try {
            this._fs.mkdirSync(dirPath, { recursive: true });
            return true;
        } catch (e) {
            if (e && e.code === "EEXIST") { return true; }
            console.warn(TAG, "mkdirSync fail:", dirPath, e);
            return false;
        }
    }

    /* [学习注释]
     * 保证父目录后用fs.writeFileSync覆盖写；ArrayBuffer转换为Node Buffer。
     * [/学习注释]
     */
    writeSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean {
        const full = this.resolve(relPath);
        const dir = this._path.dirname(full);
        if (!this.ensureDirSync(dir)) { return false; }
        try {
            if (typeof content === "string") {
                this._fs.writeFileSync(full, content, encoding);
            } else {
                this._fs.writeFileSync(full, this._Buffer.from(content as ArrayBuffer));
            }
            return true;
        } catch (e) {
            console.warn(TAG, "writeSync fail:", full, e);
            return false;
        }
    }

    /* [学习注释]
     * 使用fs.appendFileSync直接追加，失败返回false；与小游戏的失败覆盖策略不同。
     * [/学习注释]
     */
    appendSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean {
        const full = this.resolve(relPath);
        const dir = this._path.dirname(full);
        if (!this.ensureDirSync(dir)) { return false; }
        try {
            if (typeof content === "string") {
                this._fs.appendFileSync(full, content, encoding);
            } else {
                this._fs.appendFileSync(full, this._Buffer.from(content as ArrayBuffer));
            }
            return true;
        } catch (e) {
            console.warn(TAG, "appendSync fail:", full, e);
            return false;
        }
    }

    /* [学习注释]
     * 父目录创建仍同步，正文使用fs.writeFile回调式异步；根据err分发success/fail。
     * [/学习注释]
     */
    writeAsync(relPath: string, content: string | ArrayBuffer, encoding: string, success?: () => void, fail?: (err: any) => void): void {
        const full = this.resolve(relPath);
        const dir = this._path.dirname(full);
        if (!this.ensureDirSync(dir)) { fail && fail(new Error("ensureDir fail: " + dir)); return; }

        const cb = (err: any) => {
            if (err) {
                console.warn(TAG, "writeAsync fail:", full, err);
                fail && fail(err);
            } else {
                success && success();
            }
        };
        if (typeof content === "string") {
            this._fs.writeFile(full, content, encoding, cb);
        } else {
            this._fs.writeFile(full, this._Buffer.from(content as ArrayBuffer), cb);
        }
    }

    /* [学习注释]
     * Node fs.readFileSync按encoding读字符串；异常统一返回null。
     * [/学习注释]
     */
    readTextSync(relPath: string, encoding: string): string | null {
        try {
            return this._fs.readFileSync(this.resolve(relPath), encoding) as string;
        } catch (e) {
            return null;
        }
    }

    /* [学习注释]
     * 委托fs.existsSync，异常返回false。
     * [/学习注释]
     */
    existsSync(relPath: string): boolean {
        try {
            return this._fs.existsSync(this.resolve(relPath));
        } catch (e) {
            return false;
        }
    }

    /* [学习注释]
     * 调用Node unlinkSync；失败返回false。
     * [/学习注释]
     */
    removeFileSync(relPath: string): boolean {
        try {
            this._fs.unlinkSync(this.resolve(relPath));
            return true;
        } catch (e) {
            return false;
        }
    }
}

// ========== 适配器 4: 浏览器 / Web 预览 兜底 ==========

/**
 * Web/浏览器兜底适配器：
 * - 默认走 sys.localStorage 持久化
 * - localStorage 不可用（Safari 私密模式 / 第三方 Cookie 被禁 / 内嵌 webview 策略 / 配额耗尽 等）
 *   时，自动降级到 in-memory Map，本会话内继续可读写，刷新页面才丢
 * - 首次写入时探测一次可用性，结果整会话缓存，避免每次 IO 都触发引擎的
 *   "Warning: localStorage isn't enabled" 警告刷屏
 *
 * 数据完整性保护（修复 football_game Web 端"只统计到一大部分日志"问题）：
 * - 配额超限触发 demote 时，会把当前 localStorage 中所有以 KEY_PREFIX 打头的旧数据
 *   一次性救援回 _memoryFallback，避免之后读取时 _lsUsable=false 直接跳过 localStorage
 *   导致几 MB 的旧日志成为"孤儿"
 * - appendSync / writeSync 在 catch 时把当前 relPath 传给 demote，保证即使
 *   sys.localStorage 不支持 length/key 枚举（小游戏环境兜底）也至少救回当前文件
 * - readTextSync / existsSync 在 demote 后双线兜底：memory 视作权威（已吸收 demote 时
 *   ls 的全部内容 + 之后的追加），memory 没有再回 ls 兜底读一次
 */
/* [学习注释]
 * 浏览器策略：把文件当作带前缀的字符串key存储；不可写/配额耗尽后退到内存Map。
 * 内存仅当前会话有效，刷新丢失；当前ArrayBuffer被转为空字符串，不能作为二进制保存实现。
 * [/学习注释]
 */
class LocalStorageAdapter implements IFileAdapter {
    readonly name = "LocalStorage";

    /* [学习注释]
     * 给模拟文件key加命名空间，迁移时只扫描该前缀，避免把其他业务缓存当成日志文件。
     * [/学习注释]
     */
    private static readonly KEY_PREFIX = "MngLocalFile::";

    /* [学习注释]
     * 降级后的主要存储，key仍是相对文件名，值是完整文本。
     * [/学习注释]
     */
    private _memoryFallback = new Map<string, string>();
    /**
     * localStorage 可用性缓存：
     * - null 未探测
     * - true  可用（持续直写 localStorage）
     * - false 不可用 / 已降级（本会话内不再触碰 localStorage 进行新写入；读取仍可兜底）
     */
    /* [学习注释]
     * null未探测、true可写、false已降级；false后不再尝试新的持久化写入，但读/删除仍可能访问旧存储。
     * [/学习注释]
     */
    private _lsUsable: boolean | null = null;

    /* [学习注释]
     * 返回空字符串：LocalStorage没有真实文件系统根目录。
     * [/学习注释]
     */
    getRoot(): string { return ""; }
    /* [学习注释]
     * 原样返回relPath作为模拟文件标识，不是绝对磁盘路径。
     * [/学习注释]
     */
    resolve(relPath: string): string { return relPath; }

    /* [学习注释]
     * 从相对路径生成localStorage key；Map降级缓存使用原relPath，不加这个前缀。
     * [/学习注释]
     */
    private key(relPath: string): string { return LocalStorageAdapter.KEY_PREFIX + relPath; }

    /**
     * 探测 localStorage 是否真的可写。
     * Safari 私密 / WeChat WebView / 公司组策略 等情况 setItem 会直接抛 SecurityError，
     * 探测结果缓存到会话结束，避免每次 IO 都打引擎警告。
     */
    /* [学习注释]
     * 首次写入并删除探测key，缓存结果以减少重复警告。
     * 注意首次探测失败只设置false，没有执行migrateLsToMemory；迁移发生在后续demote路径，不能混淆两条分支。
     * [/学习注释]
     */
    private isLsUsable(): boolean {
        if (this._lsUsable !== null) { return this._lsUsable; }
        try {
            const probe = LocalStorageAdapter.KEY_PREFIX + "__probe__";
            sys.localStorage.setItem(probe, "1");
            sys.localStorage.removeItem(probe);
            this._lsUsable = true;
            return true;
        } catch (e) {
            console.warn(TAG, "localStorage unavailable, fallback to memory:", e);
            this._lsUsable = false;
            return false;
        }
    }

    /**
     * 把 localStorage 中所有以 KEY_PREFIX 打头的项一次性救回 _memoryFallback。
     * 配额超限 / 主动 demote 时调用，避免之前写入 localStorage 的旧数据
     * 因 _lsUsable=false 后续永远读不到（这正是 Web 端"只统计到一大部分"的根因）。
     *
     * - memory 已有同名 key 时跳过：memory 视作权威，可能已经追加过新数据
     * - 遍历过程任何异常都吞掉：能救一部分是一部分，不能让救援逻辑本身把流程拖死
     * - currentRelPath 是当前正在操作的相对路径，用于在 sys.localStorage 不支持
     *   length/key 枚举时（小游戏老封装）作为兜底，至少救回当前 key
     */
    /* [学习注释]
     * 先枚举全部相关key，再读取旧内容迁移；已存在的内存值优先，不覆盖可能已经追加的新数据。
     * 枚举失败时尝试至少救回当前relPath，每项失败单独忽略，尽量保留可读部分。
     * [/学习注释]
     */
    private migrateLsToMemory(currentRelPath?: string): void {
        const ls = sys.localStorage as unknown as {
            length?: number;
            key?: (idx: number) => string | null;
            getItem: (k: string) => string | null;
        };
        let migratedCurrent = false;
        try {
            if (typeof ls.length === "number" && typeof ls.key === "function") {
                const collected: string[] = [];
                for (let i = 0; i < ls.length; i++) {
                    const k = ls.key(i);
                    if (k && k.indexOf(LocalStorageAdapter.KEY_PREFIX) === 0) { collected.push(k); }
                }
                for (const k of collected) {
                    const relPath = k.substring(LocalStorageAdapter.KEY_PREFIX.length);
                    if (this._memoryFallback.has(relPath)) { continue; }
                    try {
                        this._memoryFallback.set(relPath, ls.getItem(k) || "");
                        if (currentRelPath && relPath === currentRelPath) { migratedCurrent = true; }
                    } catch (_) { /* ignore single-item failure */ }
                }
            }
        } catch (e) {
            console.warn(TAG, "migrateLsToMemory enumerate fail:", e);
        }
        if (currentRelPath && !migratedCurrent && !this._memoryFallback.has(currentRelPath)) {
            try {
                this._memoryFallback.set(currentRelPath, ls.getItem(this.key(currentRelPath)) || "");
            } catch (_) { /* ignore */ }
        }
    }

    /**
     * 翻 _lsUsable=false 的统一入口。
     * 关键顺序：必须**先**把 ls 现有内容救回 memory，**再**翻 flag。
     * 顺序反了就会出现"读时已 demote → 跳过 ls → memory 空 → 数据全丢"。
     */
    /* [学习注释]
     * 关键顺序：先救旧内容，再设置_lsUsable=false。这样append降级后才能得到旧全文+本次新增。
     * 已经false时直接返回，不重复迁移。
     * [/学习注释]
     */
    private demoteToMemory(reason: string, e: any, currentRelPath?: string): void {
        if (this._lsUsable === false) { return; }
        this.migrateLsToMemory(currentRelPath);
        const memLen = currentRelPath ? (this._memoryFallback.get(currentRelPath) || "").length : -1;
        console.warn(TAG, "demote to memory:", reason, "relPath=", currentRelPath, "rescuedMemLen=", memLen, e);
        this._lsUsable = false;
    }

    /* [学习注释]
     * 字符串直接覆盖localStorage；写失败先迁移旧数据再降级写Map。非字符串当前转为空串，返回true不代表二进制已保存。
     * [/学习注释]
     */
    writeSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean {
        const text = typeof content === "string" ? content : "";
        if (this.isLsUsable()) {
            try {
                sys.localStorage.setItem(this.key(relPath), text);
                return true;
            } catch (e) {
                this.demoteToMemory("write", e, relPath);
            }
        }
        this._memoryFallback.set(relPath, text);
        return true;
    }

    /* [学习注释]
     * 先取旧全文再setItem(old+text)；异常时demote救回旧内容，再在Map中追加。
     * 频繁追加大文本会反复复制全文；输入ArrayBuffer不会被正确编码保存。
     * [/学习注释]
     */
    appendSync(relPath: string, content: string | ArrayBuffer, encoding: string): boolean {
        const text = typeof content === "string" ? content : "";
        if (this.isLsUsable()) {
            try {
                const k = this.key(relPath);
                sys.localStorage.setItem(k, (sys.localStorage.getItem(k) || "") + text);
                return true;
            } catch (e) {
                // demote 内部已把 ls 现存内容救到 memory，因此下面 fallback 拼接得到的
                // 就是"旧的全部 + 本次新增"，不会丢前面已经写进 ls 的几 MB。
                this.demoteToMemory("append", e, relPath);
            }
        }
        const old = this._memoryFallback.get(relPath) || "";
        this._memoryFallback.set(relPath, old + text);
        return true;
    }

    /* [学习注释]
     * 立即调用writeSync再立即通知回调，没有异步调度；调用方不能假设success一定下一轮事件循环才执行。
     * [/学习注释]
     */
    writeAsync(relPath: string, content: string | ArrayBuffer, encoding: string, success?: () => void, fail?: (err: any) => void): void {
        if (this.writeSync(relPath, content, encoding)) {
            success && success();
        } else {
            fail && fail(new Error("fallback write fail"));
        }
    }

    /* [学习注释]
     * 持久化可用时直接读；降级后先读Map，Map没有才尝试旧localStorage。
     * 这能兜住部分迁移失败的数据；空字符串表示存在但无内容，null才表示无数据/读取失败。
     * [/学习注释]
     */
    readTextSync(relPath: string, encoding: string): string | null {
        if (this.isLsUsable()) {
            try {
                return sys.localStorage.getItem(this.key(relPath));
            } catch (e) {
                this.demoteToMemory("read", e, relPath);
            }
        }
        // demote 之后：memory 视作权威（demote 那一刻已经把 ls 内容吸收进来），
        // memory 没有这条记录再退回 ls 兜底读一次——覆盖 demote 时 enumerate 失败、
        // 且不是当前 relPath 的别的文件这种边界场景。
        if (this._memoryFallback.has(relPath)) {
            return this._memoryFallback.get(relPath) || "";
        }
        try {
            return sys.localStorage.getItem(this.key(relPath));
        } catch (_) {
            return null;
        }
    }

    /* [学习注释]
     * 优先持久化；降级后优先Map，再读旧存储key。只查模拟文件，不涉及磁盘目录。
     * [/学习注释]
     */
    existsSync(relPath: string): boolean {
        if (this.isLsUsable()) {
            try {
                return sys.localStorage.getItem(this.key(relPath)) !== null;
            } catch (e) {
                this.demoteToMemory("exists", e, relPath);
            }
        }
        if (this._memoryFallback.has(relPath)) { return true; }
        try {
            return sys.localStorage.getItem(this.key(relPath)) !== null;
        } catch (_) {
            return false;
        }
    }

    /* [学习注释]
     * 不论降级状态都尝试删除旧持久化key，并删除Map记录；忽略持久化删除异常后仍返回true。
     * [/学习注释]
     */
    removeFileSync(relPath: string): boolean {
        // 不论 _lsUsable 状态，都试一下把 ls 上的同名 key 清掉，避免下次 readTextSync
        // 兜底回 ls 还能读到脏数据。
        try { sys.localStorage.removeItem(this.key(relPath)); } catch (_) { /* ignore */ }
        this._memoryFallback.delete(relPath);
        return true;
    }
}
