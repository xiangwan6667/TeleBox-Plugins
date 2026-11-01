# TeleBox-Plugins

基于 [Wyatt323/TeleBox-Plugins](https://github.com/Wyatt323/TeleBox-Plugins) 维护的 TeleBox 插件仓库。

## 添加与安装

在 TeleBox 聊天中添加仓库，然后按需安装：

```text
.tpm source add https://github.com/xiangwan6667/TeleBox-Plugins
.tpm i tj
.tpm i aix
.tpm i stsave
.tpm i ban_ad_spam
.tpm i yvlux
```

使用 `.tpm source` 查看自定义源，使用 `.tpm update` 更新插件。

## 命令格式

命令统一写成 `前缀 + 插件名 + 子命令 + 参数`。下面以默认前缀 `.` 为例；如果在 TeleBox 中修改了前缀，请使用自己的前缀。方括号表示可省略，`|` 表示从中选择一项，参数之间用空格分开。

| 插件 | 帮助命令 | 功能 |
| --- | --- | --- |
| `tj` | `.tj help` | 统计指定消息的回复 |
| `aix` | `.aix help` | AI 对话、搜索、图片和视频生成 |
| `stsave` | `.stsave help` | 保存贴纸，或将图片、GIF、视频转换成贴纸 |
| `ban_ad_spam` | `.ban_ad_spam help` | 根据消息自动发起广告举报投票 |
| `yvlux` | `.yvlux help` | 从消息生成语录贴纸、保存贴纸 |

有配置功能的插件都可通过 `.插件名 config` 查看配置。各插件独立运行，贴纸包设置互不共享。

## TJ · 回复统计

| 命令 | 说明 |
| --- | --- |
| `.tj` | 回复目标消息后发送，统计其回复 |
| `.tj 消息链接` | 统计链接指向的消息，支持公开链接和 `t.me/c/...` 链接 |
| `.tj help` | 查看帮助 |

## BAN_AD_SPAM · 广告举报投票

插件自动监听：他人回复目标消息、@当前账号并在文字中包含 `ban广告` 时，会针对目标消息发起投票。5 分钟内有 3 人对投票消息添加 👍，插件才会回复目标消息 `/spam`；超时未达票数则结束投票。发送 `.ban_ad_spam help` 查看说明。

## STSAVE · 贴纸保存

以下保存命令需要回复贴纸、图片、GIF 或视频。

| 命令 | 说明 |
| --- | --- |
| `.stsave save` | 保存贴纸，或转换媒体后保存 |
| `.stsave to 包短名称` | 只为本次保存指定贴纸包 |
| `.stsave config` | 查看目标贴纸包和默认表情 |
| `.stsave config sticker 包短名称` | 设置固定目标贴纸包 |
| `.stsave config auto` | 恢复自动选择或创建贴纸包 |
| `.stsave config emoji ⭐` | 设置无标签贴纸使用的默认表情 |
| `.stsave help` | 查看帮助 |

静态、TGS 和 WebM 贴纸使用同一个混合贴纸包。原有贴纸优先直接保存；图片转换为静态 WebP，GIF 和视频转换为视频 WebM。视频转换需要安装 FFmpeg（包含 `ffmpeg` 和 `ffprobe`）。

兼容旧写法：`.stsave`、`.st`、`.stsave set 包短名称`、`.stsave auto`、`.stsave clear`、`.stsave emoji ⭐` 和 `.stsave status` 仍可使用；`.st` 也可代替 `.stsave` 使用子命令。

## YVLUX · 语录贴纸

生成命令需要回复一条消息；以该消息为起点，按时间顺序计数，跳过服务消息和当前命令。一次最多选择 **5 条**，跳选序号可以大于 5。

| 命令 | 说明 |
| --- | --- |
| `.yvlux` | 生成回复消息的语录 |
| `.yvlux 3` | 连续选取 3 条消息 |
| `.yvlux p 1,6,8` | 按消息序号跳选；`pick` 也可使用 |
| `.yvlux r 3` | 选取 3 条，包含它们的回复引用 |
| `.yvlux n "新名字"` | 修改首条所选消息作者的显示名 |
| `.yvlux g "新标签"` | 修改首条所选消息作者的标签；`g ""` 隐藏标签 |
| `.yvlux 新的内容` | 替换回复消息的正文 |
| `.yvlux save` | 回复图片或贴纸，保存到已配置的贴纸包 |
| `.yvlux config` | 查看配置 |
| `.yvlux config sticker 包短名称` | 设置贴纸包 |
| `.yvlux config api URL` | 设置绘图接口 |
| `.yvlux config api reset` | 恢复默认绘图接口 |
| `.yvlux help` | 查看帮助 |

连续数量与 `p` 跳选二选一；`r`、`n`、`g`、`t` 可与任意一种选取方式组合，选项顺序可变。`n` 和 `g` 修改首条所选消息的作者，同一作者的后续消息沿用；`t` 替换首条所选消息的正文。包含空格或与选项同名的内容请使用引号。

```text
.yvlux 3 r n "新名字"
.yvlux p 1,6,8 n "新的 昵称"
.yvlux r p 1,6,8 n "新名字" g "自定义标签" t "替换首条消息内容"
```

旧写法 `.yvlux s`、`.yvlux api URL` 和 `.yvlux api reset` 继续可用。单独的 `.yvlux save` 现在表示保存贴纸；如果要把正文改成字面上的 `save`，请使用 `.yvlux t save`。

默认语录使用深紫渐变玻璃气泡、透明背景，保留完整昵称和可获取的群标签。文字和媒体语录使用 `https://quote.yuri.ly/generate.webp`，真实头像、图片和引用缩略图由插件本地合成。视频、GIF 和动态贴纸在语录中使用静态预览；保存已有贴纸时保留原文件。自定义绘图接口需要支持 `style: "glass"`。

## AIX · AI 助手

| 命令 | 说明 |
| --- | --- |
| `.aix 文字` | 向 AI 提问；回复消息后单独发送 `.aix` 可针对回复提问 |
| `.aix a [问题]` | 回复消息并识别其作者头像；问题可省略 |
| `.aix search 文字` | 联网搜索并回答 |
| `.aix image [数量] 文字` | 生成图片，或回复图片进行修改 |
| `.aix image a 文字` | 参考被回复者的头像 |
| `.aix image aa 文字` | 同时参考被回复者和命令发送者的头像 |
| `.aix image ac [文字]` | 参考被回复消息发布者的头像与消息内容 |
| `.aix image p 1,3 文字` | 从被回复消息起，按序号选择消息作者的头像 |
| `.aix video 文字` | 文生视频或参考图片生成视频 |
| `.aix video first 文字` | 使用首帧生成视频 |
| `.aix video firstlast 文字` | 使用首尾帧生成视频 |
| `.aix video a 文字` | 参考被回复者的头像生成视频 |
| `.aix stop` | 取消正在执行的 AIX 任务 |
| `.aix help` | 查看帮助 |

### 配置与模型

| 命令 | 说明 |
| --- | --- |
| `.aix config` | 查看 API 配置 |
| `.aix config add 标签 URL 密钥 [类型]` | 添加 API 配置；未指定类型时按 URL 自动识别 |
| `.aix config del 标签` | 删除 API 配置 |
| `.aix config type 标签 类型` | 设置 `openai-compatible`、`openai`、`gemini`、`doubao`、`moonshot` 或 `local-cliproxy` |
| `.aix config stream 标签 on\|off` | 设置流式输出 |
| `.aix config responses 标签 on\|off` | 设置 Responses API |
| `.aix model` | 查看当前模型 |
| `.aix model chat\|search\|image\|video 标签 模型` | 分别设置对话、搜索、图片或视频模型 |
| `.aix model preset add 名称 标签 模型` | 保存模型预设 |
| `.aix model preset list` | 查看模型预设 |
| `.aix model preset del 名称` | 删除模型预设 |
| `.aix model chat\|search\|image\|video 名称` | 使用模型预设 |
| `.aix prompt` / `.aix prompt set 文字` / `.aix prompt del` | 查看、设置或删除提示词 |
| `.aix prompt rule add 关键词 规则` | 添加生图关键词规则 |
| `.aix prompt rule list` / `.aix prompt rule del 关键词` | 查看或删除生图关键词规则 |

添加 API 密钥需要在收藏消息中操作。`chat|search|image|video`、`on|off` 等表示选择其中一个值，例如 `.aix model image 标签 模型`。

| 命令 | 说明 |
| --- | --- |
| `.aix image optimize on\|off\|short\|medium\|long` | 图片提示词优化开关或优化长度 |
| `.aix video optimize on\|off\|short\|medium\|long` | 视频提示词优化开关或优化长度 |
| `.aix image preview on\|off` / `.aix video preview on\|off` | 图片或视频预览 |
| `.aix video audio on\|off` / `.aix video duration 秒数` | 视频音频与时长 |
| `.aix collapse on\|off` | 折叠输出 |
| `.aix telegraph on\|off` | 长文 Telegraph 开关 |
| `.aix telegraph limit 数量` / `.aix telegraph del 序号\|all` | 设置记录数量或删除记录 |
| `.aix timeout 秒数` | 设置请求超时 |

图片和视频生成均可通过 `--n 2` 指定数量。图片生成可使用 `--opt` 强制启用本次提示词优化。视频时长范围为 5–20 秒，请求超时范围为 1–1800 秒。

### 头像参考生图

回复目标消息，双头像模式中 `IMAGE A` 为被回复者头像，`IMAGE B` 为命令发送者头像：

```text
.aix image aa 两个人一起喝茶，保留各自的外观特征
.aix image aa --n 2 两个人一起喝茶，生成不同的动作和表情
```

`ac` 同时参考发布者头像和消息原文、图片或贴纸；相册会读取同组消息的文字和图片。可以不写额外提示词：

```text
.aix image ac
.aix image ac 把这条消息画成表情包，保留原话
.aix image ac --n 2 根据这条消息画出不同的动作和表情
```

`avatar-content`、`头像内容` 与 `ac` 等价。按消息序号选取头像时，被回复消息为第 1 条，服务消息和 AIX 命令不计入，头像按输入顺序排列：

```text
.aix image p 1,3 两个人一起喝茶
.aix image p 3,1 --n 2 两个人一起喝茶，动作和表情有所区别
```

`pick` 与 `p` 等价，序号也可用中文逗号分隔。头像与附图合计最多 6 张；附图的命令需写在图片说明中。需要回复的模式缺少目标、头像或可用内容时会提示错误。素材读取和生成支持 `stop` 与 `timeout`；超时后会交付已完成的图片。

## 本地检查

参见 [tests/README.md](tests/README.md)。自动化测试使用模拟 Telegram 客户端，不发送真实消息，也不创建或修改真实贴纸包。
