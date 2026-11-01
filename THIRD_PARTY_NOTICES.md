# 第三方组件说明

ValRecall 本身用 MIT 许可证，见 `LICENSE`。下面是它用到的别人的代码和字体。

## 随扩展一起发布的代码

| 组件               | 版本   | 许可证 | 版权声明                                           |
| ------------------ | ------ | ------ | -------------------------------------------------- |
| `react`            | 19.2.7 | MIT    | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `react-dom`        | 19.2.7 | MIT    | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `scheduler`        | 0.27.0 | MIT    | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `ts-fsrs`          | 5.4.1  | MIT    | Copyright (c) 2026 Open Spaced Repetition          |
| `qrcode-generator` | 2.0.4  | MIT    | Copyright (c) 2009 Kazuhiko Arase                  |

版本和许可证来自 `package-lock.json` 和各组件自带的文件。`qrcode-generator` 没有单独的许可证文件，它的版权和许可证写在 `dist/qrcode.js` 开头。那里还写明：The word 'QR Code' is registered trademark of DENSO WAVE INCORPORATED。

MIT 许可证全文：

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 字体

| 字体               | 许可证      | 许可证文件                  |
| ------------------ | ----------- | --------------------------- |
| LXGW WenKai Screen | SIL OFL 1.1 | `public/fonts/LXGW-OFL.txt` |
| Noto Sans SC       | SIL OFL 1.1 | `public/fonts/OFL.txt`      |

版权声明见 `public/fonts/FONT-COPYRIGHT.txt`。在安装包里，这些文件都在 `fonts/` 文件夹。

LXGW WenKai Screen 来自 npm 包 `lxgw-wenkai-screen-webfont` 1.7.0。这个包自身的外壳文件是 MIT，字体文件是 SIL OFL 1.1，这里只用了字体文件。来源和哈希记录在 `src/assets/fonts/lxgw/provenance.json`。

Noto Sans SC 来自 Google Fonts。来源和哈希记录在 `src/assets/fonts/provenance.json`。

这个版本不带 MiSans 字体。

## 手机 App（只有你自己构建时才会用到）

本仓库不发布手机安装包。你构建时，Gradle 会下载下面这些组件并打进 APK。许可证读自它们在 Maven 上的 POM 文件。

| 组件                                     | 版本   | 许可证     |
| ---------------------------------------- | ------ | ---------- |
| `androidx.activity:activity-ktx`         | 1.10.1 | Apache-2.0 |
| `androidx.webkit:webkit`                 | 1.16.0 | Apache-2.0 |
| `com.journeyapps:zxing-android-embedded` | 4.3.0  | Apache-2.0 |
| `com.google.zxing:core`                  | 3.4.1  | Apache-2.0 |

AndroidX 还会带来更多间接依赖，比如 Kotlin 标准库。这份清单没有逐个列出，它们的许可证见各自的 POM 文件。Apache-2.0 全文：<https://www.apache.org/licenses/LICENSE-2.0.txt>

下面两个只用来跑测试，不进 APK：

| 组件            | 版本     | 许可证                     |
| --------------- | -------- | -------------------------- |
| `junit:junit`   | 4.13.2   | Eclipse Public License 1.0 |
| `org.json:json` | 20250517 | Public Domain              |

## 同步助手（只有你自己构建时才会用到）

Windows 同步助手的项目没有添加 NuGet 库。但它打包时自带运行库，所以构建时会从 NuGet 下载 `Microsoft.NETCore.App.Runtime.win-x64` 和 `Microsoft.AspNetCore.App.Runtime.win-x64`，并放进助手。第一次构建要联网。

这两个包的许可证是 MIT。许可证和第三方说明在包里的 `LICENSE` 和 `THIRD-PARTY-NOTICES` 文件。下载后，包在 `%USERPROFILE%\.nuget\packages`。

## 开发工具

`package.json` 里 `devDependencies` 下的工具（Vite、TypeScript、ESLint 等）只在开发和构建时使用，不进安装包。它们的许可证见 `node_modules` 下各自的文件。
