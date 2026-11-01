# 手机同步（可选）

不用手机版，就不用看这一页。电脑上的功能不需要它。

手机同步只传待办和奖励记录，不传学习内容。它不走云端，电脑和手机要连同一个可信的 Wi-Fi。一台电脑只配对一部手机。

## 你需要先准备

- Windows 电脑和 Edge。
- 免费的 .NET 10 SDK。第一次构建要联网，它会从 NuGet 下载运行库。
- 自己构建的手机 App，做法见 `docs/ANDROID.md`。本仓库不提供安装包。

这个版本的扩展 ID 是固定的：

```text
mboaajohmmgoghaedmnjemhhbncjhcgd
```

可以在 `edge://extensions` 核对。如果你改过 `manifest.json` 里的 `key`，要换成你自己的 ID。已经装过助手的话，先看下面的“卸载助手”。

## 构建和安装同步助手

在仓库目录打开 PowerShell。如果提示 `running scripts is disabled`（禁止运行脚本），先在同一个窗口运行下面这行。它只对这个窗口有效，关掉窗口就失效：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

1. 构建助手。它会先跑测试，测试要求电脑已连上局域网：

   ```powershell
   .\scripts\build-sync-helper.ps1
   ```

   如果手机同步正开着（助手在运行），端口被占用，测试会失败，提示里有 `real init status`。先在设置里关闭手机同步，或者关闭 Edge，再构建。

2. 安装助手：

   ```powershell
   .\scripts\install-sync-helper.ps1 -ExtensionId 'mboaajohmmgoghaedmnjemhhbncjhcgd'
   ```

这一步只给当前 Windows 用户注册助手，不会自动打开同步，也不改防火墙。想先看看它会做什么，可以加 `-WhatIf`。助手运行时，加了 `-WhatIf` 也一样会报错，要先关掉。

## 打开同步

打开 ValRecall 的「设置」，展开「手机同步（可选）」，按页面提示启用，然后用手机扫二维码配对。二维码 5 分钟内有效，只能用一次。

手机配对成功后，电脑页面应该会自动显示“已配对手机”。如果二维码已过期或页面没有变化，点“刷新同步状态”。这个自动更新只用模拟的助手测过，还没用真手机测过。

第一次启用时，Windows 可能弹出防火墙提示。确认是可信的家庭网络后，选允许。

同步时，电脑要开着 Edge。不用打开 ValRecall 页面。手机离线时可以先记下操作，下次连上时再同步。

## 连不上时

- 确认手机和电脑在同一个 Wi-Fi 上。有些路由器会挡住设备发现，这时可以重新配对：先在设置里点“解除手机配对”，再生成二维码扫码。如果路由器开了“设备隔离”，要先关掉它，或者换一个网络。
- 如果防火墙挡住了连接：先确认当前是可信的家庭网络。然后在设置里关闭手机同步，或者关闭 Edge，因为助手运行时安装命令会报错。再用管理员窗口运行安装命令，并加上 `-AllowPrivateLanFirewall`。它只放行助手程序、专用网络和本地子网。完成后重新打开同步。不要关闭防火墙。
- 如果当时没有选允许，Windows 可能已经记下阻止规则，名字是 `valrecall.synchost.exe`。阻止规则优先，只加上面的放行规则不够。要先在“高级安全 Windows Defender 防火墙”的“入站规则”里删掉这条阻止规则。

助手使用 TCP 和 UDP 端口 19284。

## 想换手机，或恢复了备份

要配对另一部手机，先在设置里点“解除手机配对”。

在电脑上恢复备份时，选“替换学习和任务数据”会结束配对，需要重新配对。选“合并”不影响配对。

在“备份与恢复”里删除学习内容，也会结束配对，需要重新配对。

## 卸载助手

```powershell
.\scripts\install-sync-helper.ps1 -ExtensionId 'mboaajohmmgoghaedmnjemhhbncjhcgd' -Uninstall
```

这只取消注册，不删除文件和加密后的配对信息。它们在 `%LOCALAPPDATA%\ValRecall\Sync`，不需要了可以手动删除。如果当初加过防火墙规则，卸载时用管理员窗口并加上 `-AllowPrivateLanFirewall`，会删除这两条规则。

如果扩展 ID 变了，只卸载还不够，直接安装新 ID 会报错。要按这个顺序做：

1. 在设置里关闭手机同步，或者关闭 Edge。
2. 用旧 ID 运行上面的卸载命令。
3. 删除旧的注册文件。只删这一个，其他文件不用动：

   ```powershell
   Remove-Item -LiteralPath "$env:LOCALAPPDATA\ValRecall\Sync\Host\com.valrecall.sync.json"
   ```

4. 用新 ID 运行安装命令。

隐私说明见 `docs/PRIVACY.md`。更多技术细节见 `native/windows/README.md`。
