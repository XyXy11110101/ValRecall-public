# 结构说明

ValRecall 是 Manifest V3 扩展，用 React 和严格模式的 TypeScript 编写。所有数据都在本地。

## 入口

| 文件                               | 作用                                  |
| ---------------------------------- | ------------------------------------- |
| `src/background/index.ts`          | Service worker：捕获流程、截图、提醒  |
| `src/content/index.ts`             | 内容脚本：收到捕获消息后才读取视频页  |
| `sidepanel.html`、`src/sidepanel/` | 侧边栏：写问题、保存                  |
| `dashboard.html`、`src/dashboard/` | 首页：复习、资料库、待办、设置        |
| `mobile.html`、`src/mobile/`       | 手机 App 里的网页界面                 |
| `native/android/`                  | 手机 App 外壳和局域网客户端（Kotlin） |
| `native/windows/`                  | Windows 同步助手（C#）                |

## 主要模块

| 目录              | 作用                                                       |
| ----------------- | ---------------------------------------------------------- |
| `src/adapters/`   | 各网站的页面读取。网站相关的选择器大多在这里               |
| `src/database/`   | IndexedDB 仓库层、迁移和备份。只有这里访问数据库           |
| `src/fsrs/`       | `FsrsService`，封装 `ts-fsrs`。界面不直接计算复习时间      |
| `src/generators/` | `LearningItemGenerator`，按规则生成条目，不用 AI           |
| `src/models/`     | 数据模型和带版本的消息协议                                 |
| `src/reminders/`  | 提醒和每日计划                                             |
| `src/sync/`       | 和同步助手通信                                             |
| `src/edition/`    | 只属于这个公开版的代码：首次引导、数据安全提示、奖励开关等 |

B 站字幕的选择器不只在 `src/adapters/`。`src/background/page-subtitle-bridge.ts` 也写了一份，因为它要在页面环境里单独运行。B 站改版时，两处都要查。

跨边界的数据（消息、存储、导入文件）先当作 `unknown`，通过运行时检查后才使用。读取可选信息失败只算警告，不会挡住保存。

## 版本开关

`edition.json` 决定构建版本，构建时变成常量 `__VALRECALL_PUBLIC_RELEASE__`（见 `vite.edition.ts`）。这个仓库由作者的个人版本导出，开关在这里是 `true`。`src/edition/` 里的组件通过动态加载引入。内容脚本的构建没有这个常量，所以内容脚本不能使用它。

## 依赖

依赖越少越好。运行时只有四个直接依赖：

| 依赖                 | 为什么需要                        |
| -------------------- | --------------------------------- |
| `react`、`react-dom` | 界面                              |
| `ts-fsrs`            | FSRS 复习算法的官方实现，不自己写 |
| `qrcode-generator`   | 显示手机配对二维码，不需要联网    |

开发工具有 Vite、TypeScript、Vitest、ESLint、Prettier。`fake-indexeddb` 和 `jsdom` 只用于测试。IndexedDB、消息和截图都直接用浏览器 API。

## 构建和发布

- `npm run build`：输出到 `dist`。
- `npm run build:mobile`：输出到 `build/mobile-web`，给手机 App 用。
- `node scripts/package-release.mjs`：把 `dist` 打成 `build/release/ValRecall-版本号.zip`，并加入许可证文件。如果发现角色图片、MiSans 字体文件或 `.map` 文件，会拒绝打包。

公开版的 `manifest.json` 里有固定的 `key`，所以扩展 ID 不随文件夹变化。这个 `key` 只是公钥，仓库里没有对应的私钥。

隐私相关的设计见 `docs/PRIVACY.md`。
