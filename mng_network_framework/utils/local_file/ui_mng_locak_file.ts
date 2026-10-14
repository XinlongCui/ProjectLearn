/* [学习注释]
 * 【本文件职责】挂在Cocos节点上的日志写入/上传测试UI，文件名locak沿用原文件拼写。
 * 按钮事件→MngLocalFile读写→wx.uploadFile或fetch发送→成功后清本地日志。
 * 它处理的是日志上传，不是帧同步操作协议；不要把上传服务端口当成游戏服务器端口。
 * 当前代码与旧用法注释有差异：写入按钮一次循环500次，采用Default02测试日志，未使用appendLineTemplate。
 * 异步回调中仍有节点生命周期校验缺口，此学习副本只标注，不改变原行为。
 * [/学习注释]
 */
import { _decorator, Component, Node, Button, Label, EditBox, sys } from 'cc';
import { MngLocalFile } from './mng_local_file';
import { getLocalFileConfig } from './local_file_config';
import { FOOTBALL_UPLOAD_PORT, MngIP } from '../mng_const';

const { ccclass, property } = _decorator;

declare const wx: any;

// ------------------------------------------------------测试UI功能脚本--------------------------------------------------

/**
 * 服务器地址说明：
 *   1. 在 PC 上启动 tools/local_file_upload_server/start.bat (或 ./start.sh)
 *   2. 控制台会打印类似 "listening on http://0.0.0.0:8866"
 *      （football 上传服务专用端口 8866，避开 logs_collect 的 3000，二者可同时运行）
 *   3. 在 PC 上 cmd 执行 `ipconfig` (mac/linux: `ifconfig` / `ip addr`) 查局域网 IP
 *   4. 把 "ip:port" 填到组件面板的 serverAddr，或调用 setMngIP() 全局设置
 *   5. 微信开发者工具勾选「不校验合法域名/HTTPS」即可（HTTP 仅限调试期）
 *
 * fileName / 上传字段 / 模板等通用配置请使用 ./local_file_config：
 *   import { setLocalFileConfig } from "./local_file_config";
 *   setLocalFileConfig({ fileName: "color_game/replay.json", upload: { formData: { roomId } } });
 */

/**
 * 持续追加写入 + 上传到本地服务器 demo
 *
 * 用法：
 *   1. 在场景中挂载本组件
 *      - 必填：btn_write / btn_upload
 *      - 可选：btn_reset、lbl_status、edit_server_ip（运行时输入服务器 IP）
 *   2. 编辑器面板填好 serverIp / serverPort / uploadPath（或挂 edit_server_ip 运行时输入）
 *   3. PC 上启动 tools/local_file_upload_server/start.bat 跑 server.py
 *   4. 反复点 [btn_write]：每点一次本地文件追加一行
 *   5. 点 [btn_upload]：把当前累计文件整体上传到 http://<serverIp>:<serverPort><uploadPath>
 *                      上传成功后自动清空本地文件
 *   6. 点 [btn_reset] ：手动清空本地文件（不触发上传）
 *
 * 跨平台行为（由 MngLocalFile 自动分流）：
 *   - 微信 / 字节 / 支付宝小游戏：写到 wx.env.USER_DATA_PATH 下的 fileName
 *   - 原生 iOS / Android：写到 native.fileUtils.getWritablePath() 下
 *   - 编辑器 / 浏览器：编辑器走 Node fs；浏览器走 sys.localStorage 兜底
 */
/* [学习注释]
 * 装饰器让Cocos识别组件；@property字段可在编辑器绑定节点/Label和地址。桌面单独目录没有这些场景资源。
 * [/学习注释]
 */
@ccclass('UIMngLocalFile')
export class UIMngLocalFile extends Component {

    @property(Node)
    private btn_write: Node = null;

    @property(Node)
    private btn_upload: Node = null;

    @property(Node)
    private btn_reset: Node = null;

    @property(Label)
    private lbl_status: Label = null;

    @property({ tooltip: '服务器地址，支持 "ip"、"ip:port"、"http://ip:port" 三种格式；缺端口时默认 8866（football 上传专用端口，避开 logs_collect 的 3000）' })
    public serverAddr: string = `127.0.0.1:${FOOTBALL_UPLOAD_PORT}`;

    @property({ tooltip: '上传接口路径，默认 /upload' })
    public uploadPath: string = '/upload';

    private static readonly DEFAULT_IP: string = '127.0.0.1';
    private static readonly DEFAULT_PORT: number = FOOTBALL_UPLOAD_PORT;

    /* [学习注释]
     * 写入演示用计数，onClickWrite每次从0循环到499，而不是跨点击持续自增的总行数。
     * [/学习注释]
     */
    private _appendCount: number = 0;

    /* [学习注释]
     * 注册三个按钮；若全局MngIP非空，会覆盖面板serverAddr。默认MngIP本来就非空，实际地址以这次覆盖后为准。
     * [/学习注释]
     */
    protected onLoad(): void {
        if (this.btn_write) {
            this.btn_write.on(Button.EventType.CLICK, this.onClickWrite, this);
        }
        if (this.btn_upload) {
            this.btn_upload.on(Button.EventType.CLICK, this.onClickUpload, this);
        }
        if (this.btn_reset) {
            this.btn_reset.on(Button.EventType.CLICK, this.onClickReset, this);
        }

        if (MngIP) { this.serverAddr = MngIP; }
        console.log('[main] mng file addr:', this.serverAddr);

        this.updateStatus(`adapter=${MngLocalFile.getAdapterName()}  url=${this.getUploadUrl()}`);
    }

    /* [学习注释]
     * 用相同回调和this解绑按钮。当前只有按钮节点isValid检查，不会取消已发出的网络上传任务。
     * [/学习注释]
     */
    protected onDestroy(): void {
        if (this.btn_write && this.btn_write.isValid) {
            this.btn_write.off(Button.EventType.CLICK, this.onClickWrite, this);
        }
        if (this.btn_upload && this.btn_upload.isValid) {
            this.btn_upload.off(Button.EventType.CLICK, this.onClickUpload, this);
        }
        if (this.btn_reset && this.btn_reset.isValid) {
            this.btn_reset.off(Button.EventType.CLICK, this.onClickReset, this);
        }
    }

    // ========== 服务器地址 ==========

    /** 根据 serverAddr / uploadPath 实时拼出最终上传 URL */
    /* [学习注释]
     * 解析host/port、规范接口前导斜杠，最终固定拼http://。输入https地址也会被重建为http。
     * [/学习注释]
     */
    public getUploadUrl(): string {
        const { ip, port } = UIMngLocalFile.parseAddr(this.serverAddr);
        let path = (this.uploadPath || '/upload').trim();
        if (!path.startsWith('/')) { path = '/' + path; }
        return `http://${ip}:${port}${path}`;
    }

    /** 业务侧/外部调用：运行时更换服务器配置；addr 支持 "ip"/"ip:port"/"http://ip:port" */
    /* [学习注释]
     * 运行时更改地址或路径并刷新状态Label；没有立即探测服务器是否可达。
     * [/学习注释]
     */
    public setServer(addr?: string, path?: string): void {
        if (addr != null) { this.serverAddr = addr.trim(); }
        if (path) { this.uploadPath = path; }
        this.updateStatus(`server -> ${this.getUploadUrl()}`);
    }

    /** 解析 "ip" / "ip:port" / "http://ip:port[/...]" 三种格式 */
    /* [学习注释]
     * 去协议与路径，以最后一个冒号拆端口，缺失/非正端口用8866。简化IPv4/主机名解析，不是完整IPv6 URL解析器。
     * [/学习注释]
     */
    private static parseAddr(s: string): { ip: string; port: number } {
        const raw = (s || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        const idx = raw.lastIndexOf(':');
        let ip = raw;
        let port = 0;
        if (idx >= 0) {
            ip = raw.substring(0, idx);
            port = parseInt(raw.substring(idx + 1), 10);
        }
        if (!ip) { ip = UIMngLocalFile.DEFAULT_IP; }
        if (!(port > 0)) { port = UIMngLocalFile.DEFAULT_PORT; }
        return { ip, port };
    }

    // ========== 持续追加写入 ==========

    /* [学习注释]
     * 当前每次点击同步追加500次，内容是0..499及换行。使用_test日志且不检查普通日志开关。
     * 旧顶部注释“一次写一行/使用模板”与当前实现不一致；高频同步IO与日志输出可能占用主线程。
     * [/学习注释]
     */
    private onClickWrite(): void {
        for (let index = 0; index < 500; index++) {
            // const cfg = getLocalFileConfig();
            this._appendCount = index;
            console.error(this._appendCount);
            
            //const line = cfg.appendLineTemplate(this._appendCount);
            // const ok = MngLocalFile.appendFileSync(cfg.fileName, line);
            const ok = MngLocalFile.appendFileSyncDefault02(this._appendCount.toString()+"\n");
            if (!ok) {
                console.warn('[main] append fail:', getLocalFileConfig().fileName);
                this.toast('追加失败');
                this.updateStatus(`append FAIL: ${getLocalFileConfig().fileName}`);
                return;
            }
    
            const full = MngLocalFile.resolvePath(getLocalFileConfig().fileName);
            console.log(`[main] appended #${this._appendCount} -> ${full}: ${this._appendCount.toString().trim()}`);
            this.toast(`已追加 ${this._appendCount} 行`);
            this.updateStatus(`appended=${this._appendCount}  path=${full}`);
        }
    }

    // ========== 上传到本地服务器 ==========

    /* [学习注释]
     * 先看当前配置文件是否存在，再按wx.uploadFile能力分流。存在不保证读取成功，也没有防重复上传锁。
     * [/学习注释]
     */
    private onClickUpload(): void {
        const cfg = getLocalFileConfig();
        if (!MngLocalFile.existsSync(cfg.fileName)) {
            console.warn('[main] file not exist, please click write first');
            this.toast('请先点击写入');
            return;
        }

        if (typeof wx !== 'undefined' && wx.uploadFile) {
            this.uploadByWx();
        } else {
            this.uploadByFetch();
        }
    }

    /** 微信/小游戏：wx.uploadFile 直接传本地路径，无需把文件读入内存 */
    /* [学习注释]
     * 将真实本地文件路径交给wx.uploadFile，不先把整个文件读成字符串。timeout来自共享配置。
     * [/学习注释]
     */
    private uploadByWx(): void {
        const cfg = getLocalFileConfig();
        const { name, formData, timeout } = cfg.upload;
        const url = this.getUploadUrl();
        const filePath = MngLocalFile.resolvePath(cfg.fileName);
        console.log('[main] wx.uploadFile ->', url, 'file=', filePath);

        const options: any = {
            url,
            filePath,
            name,
            formData,
            /* [学习注释]
             * 传输成功回调还要检查HTTP状态；当前只把200当成功，并清本地文件。
             * 异步返回时组件可能已销毁；这里没有isValid(this.node,true)检查，实际接入需关注该生命周期边界。
             * [/学习注释]
             */
            success: (res: any) => {
                console.log('[main] wx.uploadFile success:', res);
                if (res.statusCode === 200) {
                    this.clearLocal();
                    this.toast('上传成功，本地已清空');
                    this.updateStatus(`upload OK & cleared: ${res.data}`);
                } else {
                    this.toast(`上传失败 ${res.statusCode}`);
                    this.updateStatus(`upload FAIL ${res.statusCode}: ${res.data}`);
                }
            },
            fail: (err: any) => {
                console.error('[main] wx.uploadFile fail:', err);
                this.toast('上传失败');
                this.updateStatus(`upload FAIL: ${err && err.errMsg}`);
            }
        };
        if (timeout && timeout > 0) { options.timeout = timeout; }

        /* [学习注释]
         * 返回的任务仅用于注册进度日志，未保存供销毁时取消；进度不是帧同步逻辑进度。
         * [/学习注释]
         */
        const task = wx.uploadFile(options);
        if (task && task.onProgressUpdate) {
            task.onProgressUpdate((res: any) => {
                console.log(`[main] upload progress ${res.progress}%  ${res.totalBytesSent}/${res.totalBytesExpectedToSend}`);
            });
        }
    }

    /** 编辑器 / 浏览器 / 原生：读取文件内容后用 fetch + FormData 上传 */
    /* [学习注释]
     * 先读完整文本，检查fetch/FormData/Blob能力，再生成multipart表单上传。
     * 本路径未使用cfg.upload.timeout；读取和Blob构造会占用与日志大小相关的内存。
     * [/学习注释]
     */
    private async uploadByFetch(): Promise<void> {
        const cfg = getLocalFileConfig();
        const { name, formData } = cfg.upload;
        const url = this.getUploadUrl();
        const text = MngLocalFile.readTextSync(cfg.fileName);
        console.log('[main] fetch upload ->', url);
        if (text == null) {
            console.warn('[main] readTextSync returned null');
            this.toast('文件读取失败');
            return;
        }

        const win = globalThis as any;
        if (typeof win.fetch !== 'function' || typeof win.FormData !== 'function' || typeof win.Blob !== 'function') {
            console.warn('[main] fetch/FormData/Blob not supported in current env');
            this.toast('当前环境不支持 fetch 上传');
            return;
        }

        try {
            const form = new win.FormData();
            const blob = new win.Blob([text], { type: 'text/plain;charset=utf-8' });
            form.append(name, blob, cfg.fileName);
            for (const k of Object.keys(formData || {})) {
                form.append(k, String((formData as any)[k]));
            }

            /* [学习注释]
             * await是异步边界。随后resp.text又是第二个边界；当前都没有节点有效性检查，副本保留原行为。
             * [/学习注释]
             */
            const resp = await win.fetch(url, { method: 'POST', body: form });
            const respText = await resp.text();
            console.log('[main] fetch upload:', resp.status, respText);
            /* [学习注释]
             * fetch路径把HTTP 2xx视为成功；wx路径只认200，两者判断不完全相同。成功后删除本地日志。
             * [/学习注释]
             */
            if (resp.ok) {
                this.clearLocal();
                this.toast('上传成功，本地已清空');
                this.updateStatus(`upload OK & cleared: ${respText}`);
            } else {
                this.toast(`上传失败 ${resp.status}`);
                this.updateStatus(`upload FAIL ${resp.status}: ${respText}`);
            }
        } catch (e) {
            const msg = (e && (e as Error).message) || String(e);
            const isNet = /failed to fetch|network|networkerror/i.test(msg);
            console.error('[main] fetch upload error:', msg, 'url=', url);
            if (isNet) {
                console.error(
                    '[main] 可能原因：\n' +
                    '  1) 服务器未启动 / IP 或端口错（先用浏览器打开 ' + url.replace(/\/upload$/, '/') + ' 试一下能否拿到 JSON）\n' +
                    '  2) server.py 未配置 CORS（拉取最新 server.py 已自带，重启服务即可）\n' +
                    '  3) 页面是 https 而服务器是 http（混合内容被浏览器拦截，二者协议要一致）\n' +
                    '  4) PC 防火墙拦截了该端口（Windows 启动 python 时弹窗要选「专用网络/允许」）'
                );
            }
            this.toast('上传异常: ' + (isNet ? '网络/跨域不通' : msg));
            this.updateStatus(`upload ERROR: ${msg}`);
        }
    }

    // ========== 清空本地文件 ==========

    /* [学习注释]
     * 只清当前配置指向的文件，不上传；不存在时显示无需清理。
     * [/学习注释]
     */
    private onClickReset(): void {
        const cfg = getLocalFileConfig();
        if (!MngLocalFile.existsSync(cfg.fileName)) {
            this.toast('本地无文件，无需清空');
            this.updateStatus(`reset: nothing to clear`);
            return;
        }
        this.clearLocal();
        this.toast('本地文件已清空');
        this.updateStatus(`reset OK: ${MngLocalFile.resolvePath(cfg.fileName)}`);
    }

    /** 上传成功 / 主动重置 共用：删除本地文件 + 计数清零 */
    /* [学习注释]
     * 按调用此刻的全局配置删除文件并归零计数，没有检查removeFileSync返回值。
     * 上传期间若共享配置换了fileName，这里可能清另一文件；上传中新追加日志也可能随成功删除。
     * [/学习注释]
     */
    private clearLocal(): void {
        MngLocalFile.removeFileSync(getLocalFileConfig().fileName);
        this._appendCount = 0;
    }

    // ========== UI helpers ==========

    /* [学习注释]
     * 同步改Label文本，只判断引用非空；异步调用者仍需保证组件和Label有效。
     * [/学习注释]
     */
    private updateStatus(text: string): void {
        if (this.lbl_status) { this.lbl_status.string = text; }
    }

    /* [学习注释]
     * 微信使用showToast，桌面浏览器只console输出；其他平台当前没有实现统一提示。
     * [/学习注释]
     */
    private toast(title: string): void {
        if (typeof wx !== 'undefined' && wx.showToast) {
            wx.showToast({ title, icon: 'none' });
        } else if (sys.platform === sys.Platform.DESKTOP_BROWSER) {
            console.log('[toast]', title);
        }
    }
}
