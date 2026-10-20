# TeleBox-Plugins

基于 [Wyatt323/TeleBox-Plugins](https://github.com/Wyatt323/TeleBox-Plugins) 维护，包含文字语录玻璃气泡样式调整。

## 添加插件仓库

在 TeleBox 聊天中发送：

```text
.tpm source add https://github.com/xiangwan6667/TeleBox-Plugins
```

查看当前自定义源：

```text
.tpm source
```

## 插件功能

| 安装名 | 命令 | 功能简介 |
| --- | --- | --- |
| `tj` | `.tj` | 统计指定消息的全部回复，列出回复用户、时间和消息内容。 |
| `aix` | `.aix` | AI 对话、绘图、模型与提示词等 AI 功能。 |
| `stsave` | `.stsave` / `.st` | 保存贴纸，或将回复的图片、视频等媒体转换后保存到贴纸包。 |
| `ban_ad_spam` | 自动监听 | 别人回复消息并 @你 且包含 `ban广告` 时，自动对目标消息回复 `/spam`。 |
| `yvlux` | `.yvlux` | 根据消息生成语录贴纸，并支持保存到贴纸包。 |

`yvlux` 的文字语录默认使用深紫渐变的玻璃气泡：大圆角、气泡尾巴、细描边和顶部高光，头像靠下对齐，昵称保留发送者的强调色。绘图由 [Quote API](https://github.com/LyoSU/quote-api) 的 `glass` 样式完成，贴纸外围保持透明。

气泡按参考图保持紧凑比例：内边距从约 16px 微增至 18px，圆角约 27px，高光和描边沿用原样式。文字语录会自动在昵称旁显示当前群的成员标签（绿色胶囊）或管理员头衔；优先读取消息自带的标签，再查询群成员信息。转发消息不套用转发者的群标签，查不到标签时正常生成。新成员标签需要宿主的 `teleproto` 支持对应 Telegram 协议字段。

默认文字接口为 `https://quote.yuri.ly/generate.webp`，真实头像由插件在本地合成（使用宿主已有的 `sharp`）；带媒体的语录仍走原增强版接口。手动配置过 API 的用户会继续使用自己的地址，后端需要支持 `style: "glass"` 才能呈现同样质感。回复消息发送 `.yvlux` 即可生成；发送 `.yvlux api reset` 可恢复默认接口。

## 安装插件

```text
.tpm i tj
.tpm i aix
.tpm i stsave
.tpm i ban_ad_spam
.tpm i yvlux
```

## 更新插件

```text
.tpm update
```
