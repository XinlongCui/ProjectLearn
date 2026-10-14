> **学习版批注（以同目录当前 TypeScript 实现为准）**
>
> 本子目录是日志存储与上传辅助，不负责游戏帧同步网络消息或逻辑帧推进。
> 平台选择以实际代码为准：小游戏分支明确要求globalThis.wx文件系统能力；编辑器分支要求EDITOR和Node require；否则走LocalStorage。
> Native的writeAsync仅用setTimeout延后同步写，LocalStorage的writeAsync立即回调，Node/wx路径才使用对应异步API。名称相同不代表调度一致。
> LocalStorage模拟文件只保存文本，ArrayBuffer当前会转为空字符串；降级内存后刷新丢失。正常追加失败降级时会先救旧数据，首次能力探测失败是另一分支。
> 当前写入按钮一次同步循环500次，使用Default02的_test文件，不是原说明中的每次一行模板；默认业务日志入口则受开关控制。
> 当前默认上传端口是8866。getUploadUrl固定生成http；wx只把200当成功，fetch认2xx；成功清理用当时的全局配置文件名，异步期间需关注配置变化和节点生命周期。
> 本副本不会启动上传服务、发起上传或运行任何示例。以下保留原使用文档。

---

# local_file —— 本地文件读写 / 持续追加 / 上传到本地服务器

一套面向调试期的工具集：让客户端（微信小游戏 / 原生 App / 浏览器预览 / Cocos Creator 编辑器）能把任意业务数据**持续追加**到本地文件，再"一键"上传到 PC 本地的 HTTP 服务器，供回放、对比、抓 bug 用。

服务端代码不在本目录，位于：

```text
c:/sg2/creator/tools/local_file_upload_server/
```

服务端启动方式见该目录下的 `README.md`。

---

## 目录组成 & 三层架构

```text
local_file/
├── mng_local_file.ts        # ① 底座：跨平台同步/异步文件读写（4 个平台适配器）
├── local_file_config.ts     # ② 通用配置中心：fileName / 上传字段 / 行模板
├── ui_mng_locak_file.ts     # ③ UI 组件 + 全局服务器地址 (MngIP/setMngIP)
└── README.md                # 本文档
```

```text
+-------------------------------------+
| 玩法层（color_game / battle / ...） |
+---------------+---------------------+
                │ setLocalFileConfig({...})
                ▼
+-------------------------------------+
| ② local_file_config（通用配置）    |
+---------------+---------------------+
                │ getLocalFileConfig()
                ▼
+-----------+--+----------------------+
| ③ UI 组件  │  业务直接调底座         |
| (按钮交互) │  (脱离 UI)             |
+-----------+--+----------------------+
                │ MngLocalFile.appendFileSync(...)
                ▼
+-------------------------------------+
| ① mng_local_file（跨平台文件 IO）  |
| MiniGame / Native / Editor / Web    |
+---------------+---------------------+
                │ wx.uploadFile / fetch+FormData
                ▼
+-------------------------------------+
|  tools/local_file_upload_server     |
|  Flask: POST /upload                |
+-------------------------------------+
```

---

## 30 秒接入（最简）

> 适合"我只想验证一下能不能跑通"。

1. **启服务端**：双击 `tools/local_file_upload_server/start.bat`
2. **查 PC 局域网 IP**：cmd 里 `ipconfig` 找 IPv4 那一行（如 `172.16.22.113`）
3. **打开 Cocos 场景**，挂 `UIMngLocalFile` 组件，把 `Server Addr` 填成 `172.16.22.113:8866`
   （8866 是 football 上传服务专用端口，避开 `logs_collect` 的 3000；若已自定义可同步改这里）
4. **拖按钮**：`Btn Write` / `Btn Upload`（可选 `Btn Reset` / `Lbl Status` / `Edit Server Ip`）
5. **跑起来**：点几次写入 → 点上传 → 上传成功后本地自动清空 → PC 上 `tools/local_file_upload_server/uploads/` 出现新文件

---

## 接入到自己玩法（推荐做法）

玩法侧 **只需做两件事**：①  改文件名/表单字段/行模板 ②  保证服务器 IP 已设置。UI 组件可以复用同一份。

### 1. 在玩法初始化时改配置

```typescript
import { setLocalFileConfig } from 'db://assets/scripts/modules/logic/mng_network_framework/utils/local_file/local_file_config';

setLocalFileConfig({
    fileName: `color_game/room_${roomId}/replay.json`,
    upload: {
        formData: { source: 'color_game', roomId, playerId },
    },
    appendLineTemplate: (tick, extra) =>
        JSON.stringify({ tick, ts: Date.now(), data: extra }) + '\n',
});
```

- `fileName` 支持多级目录，自动建目录（如 `color_game/room_123/replay.jsonl`）
- `formData` 是**浅合并**，旧字段保留 + 新字段加入；服务端可按这些字段归档/查询
- `appendLineTemplate(tick, extra)` 二参可选，业务可塞任意 payload

### 2. 设置服务器地址（任选其一）

```typescript
import { setMngIP } from 'db://assets/scripts/modules/logic/mng_network_framework/utils/mng_const';
// 注意：setMngIP 内部会**强制把端口替换成 FOOTBALL_UPLOAD_PORT（默认 8866）**，
// 即使这里写 :3000、:80 或不写端口，最终都会拼成 "<ip>:8866"。
// 这是为了和 logs_collect (3000) 解耦，两套服务可以同时跑。
setMngIP('172.16.22.113');
```

或在 Cocos Inspector 面板里直接填 `Server Addr`。

或 UI 上挂一个 `EditBox`（绑定 `Edit Server Ip` 字段），运行时输入 `ip` / `ip:port` / `http://ip:port` 任意格式。

### 3. 退出玩法（可选）

```typescript
import { resetLocalFileConfig } from '.../local_file/local_file_config';
resetLocalFileConfig();
```

恢复默认 demo 配置，避免影响下一个玩法。

---

## 脱离 UI 在代码里直接用

如果不想挂 UI 组件，只想在战斗 tick / 网络回调里"写一行"：

```typescript
import { MngLocalFile } from '.../local_file/mng_local_file';
import { getLocalFileConfig } from '.../local_file/local_file_config';

const cfg = getLocalFileConfig();
MngLocalFile.appendFileSync(cfg.fileName, cfg.appendLineTemplate(tick, payload));
```

上传的时候参考 `ui_mng_locak_file.ts` 里 `uploadByWx()` / `uploadByFetch()` 这两段代码，复制改造即可（核心就是 `wx.uploadFile` 或 `fetch + FormData`）。

---

## API 速查

### ① `MngLocalFile`（底座，所有平台同一套调用）


| 方法                                                        | 说明                                                   |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `writeFileSync(relPath, content, encoding?)`              | 覆盖写入（同步），自动建目录                                       |
| `appendFileSync(relPath, content, encoding?)`             | **追加写入**（同步），文件不存在自动创建                               |
| `writeFile(relPath, content, success?, fail?, encoding?)` | 异步覆盖写                                                |
| `readTextSync(relPath, encoding?)`                        | 同步读文本                                                |
| `existsSync(relPath)`                                     | 文件/目录是否存在                                            |
| `removeFileSync(relPath)`                                 | 删除文件                                                 |
| `resolvePath(relPath)`                                    | 拿到当前平台的绝对路径（调试/wx.uploadFile 要用）                     |
| `getUserDataPath()`                                       | 当前平台可写根目录                                            |
| `getAdapterName()`                                        | 当前底层是哪个 adapter（MiniGame/Native/Editor/LocalStorage） |


### ② `local_file_config`（通用配置）

```typescript
interface ILocalFileConfig {
    fileName: string;
    upload: {
        name: string;            // multipart 字段名，默认 'file'
        formData: { [k: string]: string | number | boolean };
        timeout: number;         // 仅 wx.uploadFile 用
    };
    appendLineTemplate: (tick: number, extra?: any) => string;
}

getLocalFileConfig(): ILocalFileConfig;
setLocalFileConfig(partial: Partial<ILocalFileConfig>): void;   // 合并式覆盖
resetLocalFileConfig(): void;                                    // 恢复默认
```

### ③ `ui_mng_locak_file`（UI 组件 + 全局 IP）

```typescript
// 全局服务器地址（fileName 之外的所有"组件实例"都会读它）
export let MngIP: string;
export function setMngIP(ip: string): void;

// UI 组件
class UIMngLocalFile extends Component {
    @property btn_write / btn_upload / btn_reset / lbl_status / edit_server_ip;
    @property serverAddr: string = '127.0.0.1:8866';  // football 上传专用端口
    @property uploadPath: string = '/upload';

    public getUploadUrl(): string;
    public setServer(addr?: string, path?: string): void;
}
```

---

## 跨平台行为表


| 平台                | 写入位置                                  | 备注                                      |
| ----------------- | ------------------------------------- | --------------------------------------- |
| 微信 / 字节 / 支付宝小游戏  | `wx.env.USER_DATA_PATH/`              | 持久化，**关闭小游戏不会清**，需 `removeFileSync`     |
| 原生 iOS / Android  | `native.fileUtils.getWritablePath()/` | 沙箱内                                     |
| Cocos Creator 编辑器 | `<工程>/temp/mng_local_file/`           | 走 Node fs，工程级临时目录                       |
| 浏览器 / Web 预览      | `sys.localStorage`（KV 模拟）             | 受 ~5MB 容量限制；可调 `downloadToLocal` 写到电脑本地 |


---

## 上传协议（与 server.py 对齐）

- `POST <serverAddr><uploadPath>`（默认 `http://<ip>:<port>/upload`）
- `Content-Type: multipart/form-data`
- 文件字段名：`upload.name`（默认 `file`，需与 `server.py` 中一致）
- 表单附加字段：`upload.formData` 里的全部 KV
- 响应：JSON，成功 `{"ok": true, "filename": "<时间戳_uuid_原名>", "size": 123, ...}`
- **服务端按 `时间戳_uuid8_原名` 重命名落盘，永不互相覆盖**
- 客户端 `上传成功后自动清空本地文件`，避免反复测试时累加（行为见 `UIMngLocalFile.uploadByWx` 的 success 分支）

---

## 常见问题

- **微信开发者工具：上传 404 / 网络错误**
→ 确认 url 用的是 PC **局域网 IP**（不是 `localhost`）；勾选 `详情 → 本地设置 → 不校验合法域名/HTTPS`；首次启动 `python.exe` 时 Windows 防火墙务必选「专用网络/允许访问」
- **手机连不上**
→ 手机/PC 同一 WiFi；用手机浏览器先打开 `http://<PC-IP>:8866/`，能拿到 `{"ok":true,...}` 才算网络通
- **上传后内容看起来"累加"了**
→ 这是客户端本地文件未清空导致。`UIMngLocalFile` 在上传成功后会自动 `removeFileSync`；如果你脱 UI 自己写循环上传，记得手动调 `MngLocalFile.removeFileSync(cfg.fileName)`
- **持续追加把文件写得很大**
→ 业务侧可定期 `MngLocalFile.writeFileSync(cfg.fileName, '')` 截断，或换 `fileName`（如带时间分片：`logs/${dateHour}.log`）
- **要写入二进制**
→ `appendFileSync` / `writeFileSync` 都支持传 `ArrayBuffer`；微信小游戏 / 原生 / 编辑器 都已正确处理，浏览器兜底分支不支持二进制（localStorage 限制）
- **本目录下的 `.md` / 资源不要纳入构建**
→ 在工程 `.gitignore` 里加下列两行；README.md 留着没事，Cocos 资源管理器会生成 .meta 但不会被打包到游戏包内
  ```text
  tools/local_file_upload_server/.venv/
  tools/local_file_upload_server/uploads/
  ```

