# ValRecall

看视频时按一个快捷键，把这一刻记下来。写一个问题，到时间再来回答。

ValRecall 是 Microsoft Edge 扩展。它支持 B 站、YouTube 和抖音的视频页。它会保存视频时间、当前画面和能读到的字幕，用 FSRS 算法安排复习。数据只存在你的电脑上。不用注册账号。

## 安装

你不需要会编程。这个扩展没有上架应用商店，所以要用 Edge 的“开发人员模式”来加载。

1. 打开 [Releases 页面](https://github.com/XyXy11110101/ValRecall-public/releases)，下载 `ValRecall-版本号.zip`。
2. 把它解压到一个不会被删的文件夹，比如“文档”里的 `ValRecall`。解压后，这个文件夹里应该直接能看到 `manifest.json`。
3. 在 Edge 地址栏输入 `edge://extensions`，按回车。
4. 打开页面上的“开发人员模式”开关。
5. 点“加载解压缩的扩展”，选第 2 步的文件夹。

装好后会自动打开 ValRecall 首页，按上面的三步卡片开始就行。

**这个文件夹要一直留着。** Edge 每次都从这里读取扩展，删掉它扩展就不能用了。

Edge 有时会提示“关闭开发人员模式下的扩展”或“关闭开发人员模式?”。不要选择关闭，否则 ValRecall 就不能用了。如果有“2 周后提醒”，可以选它。

### 更新

1. 先在 ValRecall 里导出一份备份（见下面的“备份”）。
2. 下载新版 zip，解压。
3. 用新版的文件替换原文件夹里的全部内容。不要在 `edge://extensions` 里点“删除”。
4. 回到 `edge://extensions`，点 ValRecall 上的“重新加载”按钮。

你的数据不在这个文件夹里，替换文件不会丢数据。

## 怎么用

1. 打开一个 B 站、YouTube 或抖音视频。
2. 看到想记住的地方，按 **Alt+Shift+M**。
3. 在侧边栏写一个问题和答案，保存。
4. 到时间后，打开 ValRecall 首页复习。先想答案，再看答案，然后给自己打分。

快捷键按了没反应，或者和别的软件冲突，就到 `edge://extensions/shortcuts` 改一个。

首页的待办可以点“开始”，把一件放进“工作中”卡片。卡片里可以写明计划：开始和结束时间、交付物和完成标准，比如“看完第九章，并写下三条笔记”，而不是只写“学习中”。计划只存在这台电脑上，不会同步到手机。

网站改版后，字幕、作者这些信息可能读不到。缺这些信息时仍然可以保存。

## 这个版本没有什么

- 没有角色形象。代码里还留着这部分功能，但这个版本没有任何角色图片。
- 没有 MiSans 字体。它的授权不允许单独分发，这里用霞鹜文楷和思源黑体。
- 这个版本和作者自用的版本不同。这个仓库由作者的个人版本导出，所以代码里能看到 `__VALRECALL_PUBLIC_RELEASE__` 这样的开关。
- 界面是中文的，没有英文版。少数文字还是英文。每次复习的评分按钮都是英文（Again、Hard、Good、Easy），复习总结里也用这些名称。部分错误提示和“技术提取详情”也是英文。

零花钱奖励默认隐藏。这个开关只管显示。关着时，账本照常记录，这些记录也会进入导出文件和手机同步。它只是自我奖励的记录，不是真钱。

## 手机版和同步助手（进阶，要自己构建）

这部分不需要也能正常使用。本仓库不提供手机安装包和同步助手安装包，需要你自己构建。

- 手机版：见 [docs/ANDROID.md](docs/ANDROID.md)。
- 手机和电脑在同一个 Wi-Fi 下同步待办：见 [docs/LOCAL_SYNC.md](docs/LOCAL_SYNC.md)。

## 你的数据

- 学习内容、截图和复习记录只存在这台电脑的 Edge 里。
- 没有账号，没有云同步，没有统计，没有广告。
- 只有你主动捕获时，才会读取当前页面。

详细说明见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 备份

**卸载扩展会删除全部数据。** 换电脑或重装 Edge 也一样。

建议每周导出一次。在 ValRecall 打开“设置”，进“备份与恢复”，点“导出全部数据”，把文件存到安全的地方。导出后，请确认文件已经存好。这个文件含有你的全部学习内容，不要发给别人。

移动扩展文件夹不会丢数据：在新位置重新加载就行，不要先卸载。

## 从源码构建

需要 Node.js，版本是 `^20.19`、`^22.13` 或 `24` 以上。作者用 Node 22 跑持续集成。

```powershell
npm ci
npm run build
```

如果提示 `running scripts is disabled`（禁止运行脚本），先在同一个窗口运行下面这行。它只对这个窗口有效，关掉窗口就失效：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

结果在 `dist` 文件夹，可以直接在 Edge 里加载。打成 zip：

```powershell
node scripts/package-release.mjs
```

zip 在 `build/release`。常用检查命令：`npm run typecheck`、`npm run lint`、`npm run test:run`、`npm run format:check`。

结构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可证

代码用 [MIT 许可证](LICENSE)。用到的第三方代码和字体见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## English summary

ValRecall is a Microsoft Edge extension for remembering moments from Bilibili, YouTube and Douyin videos. Press Alt+Shift+M while watching, write a question, and review it later on an FSRS schedule. All data stays in your browser: there is no account, cloud sync or analytics.

To install, download the zip from [Releases](https://github.com/XyXy11110101/ValRecall-public/releases) and unzip it to a folder you will keep. Open `edge://extensions`, turn on developer mode and load that folder. To update, replace the folder's contents and reload the extension; do not remove it, because removing it deletes your data. Export a backup from Settings first.

This edition has no character art and differs from the author's personal one. The interface is in Chinese, with no English version. The rating buttons on every review (Again, Hard, Good, Easy), a few error messages and technical details are still in English. The Android app and the Windows sync helper are optional and you build them yourself. To build the extension, use Node 22 and run `npm ci` then `npm run build`. Licensed under MIT.
