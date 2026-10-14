/* [学习注释]
 * 【本文件职责】日志上传调试服务的地址和开关，并非游戏帧同步服务器地址配置。
 * FOOTBALL_UPLOAD_PORT=8866用来和日志收集等其他本地服务区分。
 * setMngIP还会开启日志落盘开关；其他业务调用时要知道这一副作用。
 * [/学习注释]
 */
/**
 * @Author: YangWenJie
 * @Date: 2026-05-18 15:29:28
 * @LastEditors: YangWenJie
 * @LastEditTime: 2026-05-29 15:30:00
 * @Description: 网络框架基础常量
 */

/**
 * football_game 本地上传服务专用端口。
 *
 * 历史背景：原本和 logs_collect 一样默认 3000，结果两个服务无法在同一台 PC 同时跑
 * （extensions/logs_collect_launcher 起来的 logs_collect 已经占了 3000，
 *  tools/local_file_upload_server/server.py 也想监听 3000 就会冲突）。
 * 这里给 football 上传服务挪一个独立端口，避免和 logs_collect / Node / Vite / React 等
 * 常见本地服务撞车。改动时记得同步：
 *   - tools/local_file_upload_server/server.py 的 --port 默认
 *   - tools/local_file_upload_server/start.bat / start.sh / README.md
 *   - assets/.../local_file/ui_mng_locak_file.ts 的 serverAddr / DEFAULT_PORT
 *   - assets/resources/ui/prefab/level/ui_level_hud.prefab 的 serverAddr
 */
/* [学习注释]
 * 上传服务约定端口，修改时需与服务脚本、组件和prefab配置同步。
 * [/学习注释]
 */
export const FOOTBALL_UPLOAD_PORT: number = 8866;

/* [学习注释]
 * 可变的host:port，默认回环地址。真机中的127.0.0.1指向真机自身，不是开发电脑。
 * [/学习注释]
 */
export let MngIP: string = `127.0.0.1:${FOOTBALL_UPLOAD_PORT}`;

/**
 * 设置 football_game 上传服务地址。
 *
 * 注意：调用方（如 ui_test_userId.ts）传入的地址里往往带的是 logs_collect 的端口（3000），
 * 这里会主动**剥掉协议头和原端口**，统一拼成 `<ip>:FOOTBALL_UPLOAD_PORT`，
 * 保证 football 上传请求一定打到本服务对应的端口，不会被 logs_collect 抢走。
 */
/* [学习注释]
 * 去掉http(s)协议头、路径和原数字端口，再强制拼8866；不是保留用户任意URL的通用解析器。
 * 空输入回退127.0.0.1；随后开启本地日志。
 * [/学习注释]
 */
export function setMngIP(ip: string) {
    const host = (ip || '').trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '');
    const finalIp = host || '127.0.0.1';
    MngIP = `${finalIp}:${FOOTBALL_UPLOAD_PORT}`;
    console.error('set mng ip：', MngIP, '(raw input:', ip, ')');
    setFootballLocalFile(true);
}

//-----------------------------------本地file开关------------------------------------
/* [学习注释]
 * 模块级共享布尔值，不是持久化到本地存储的设置，重新加载模块后默认false。
 * [/学习注释]
 */
let FOOTBALL_LOCAL_FILE = false;

/* [学习注释]
 * 只更新内存开关，不立即创建、删除或上传文件。
 * [/学习注释]
 */
export function setFootballLocalFile(enabled: boolean): void {
    FOOTBALL_LOCAL_FILE = enabled;
}

/* [学习注释]
 * 读取开关；appendFileSyncDefault会检查它，appendFileSyncDefault02测试入口不会。
 * [/学习注释]
 */
export function isFootballLocalFile(): boolean {
    return FOOTBALL_LOCAL_FILE;
}
