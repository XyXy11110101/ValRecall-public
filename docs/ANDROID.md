# 自己构建手机版

本仓库不提供手机安装包。想用手机版，要自己构建。需要 Android 8.0 或更新的手机。

这个手机版用来看、添加和完成待办，不含学习内容。它要配合电脑上的同步助手使用，见 `docs/LOCAL_SYNC.md`。

## Windows：调试版（最简单）

先装好 Node.js，然后在仓库目录打开 PowerShell。如果提示 `running scripts is disabled`（禁止运行脚本），先在同一个窗口运行下面这行。它只对这个窗口有效，关掉窗口就失效：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

然后运行：

```powershell
npm ci
npm run build:mobile
.\scripts\build-android.ps1 -Bootstrap -Configuration Debug
```

`-Bootstrap` 会下载 JDK 17、Gradle 9.3.1 和 Android SDK 到 `%LOCALAPPDATA%\ValRecall\toolchains`，并核对校验值。以后再构建可以去掉它。

结果在 `build\android\ValRecall-debug.apk`。脚本不会自动安装到手机。把这个文件传到手机上安装即可，也可以用 SDK 里的 `adb install`。

## Windows：正式版

```powershell
npm ci
npm run build:mobile
.\scripts\build-android.ps1 -Bootstrap -Configuration Release
```

第一次运行时，脚本会在 `%LOCALAPPDATA%\ValRecall\android-signing` 为你创建自己的签名密钥。密钥文件是 `valrecall-release.p12`，它的密码加密存在 `password.dpapi`，只有当前 Windows 用户能解开。

结果在 `build\android\ValRecall-release.apk`。

**这把密钥要自己保管好。** 更新已安装的 App 必须用同一把密钥。丢了密钥，只能卸载 App 再重装，手机上的数据也会被删除。

不要加 `-RequireExistingSigningKey`。这个参数要求密钥已经存在，否则直接报错。

调试版和正式版的签名不同，不能互相覆盖安装。

## 其他系统

作者只在 Windows 上构建过，其他系统上的步骤没有实际试过。构建脚本只支持 Windows，所以要手动准备：

- JDK 17
- Android SDK：`platforms;android-37.0`
- Gradle 9.3.1（本仓库不带 Gradle wrapper）
- Node.js

然后在仓库目录运行：

```sh
npm ci
npm run build:mobile
export ANDROID_HOME=你的 SDK 路径
gradle -p native/android --no-daemon testDebugUnitTest assembleDebug
```

结果在 `native/android/app/build/outputs/apk/debug/app-debug.apk`。

构建正式版要自己用 `keytool` 创建密钥（别名用 `valrecall`），设置环境变量 `VALRECALL_ANDROID_KEYSTORE`、`VALRECALL_ANDROID_STORE_PASSWORD` 和 `VALRECALL_ANDROID_KEY_PASSWORD`，再运行 `gradle -p native/android --no-daemon assembleRelease`。

## 权限和隐私

App 要用相机扫配对二维码，要用本地网络连接电脑。详情见 `docs/PRIVACY.md`。
