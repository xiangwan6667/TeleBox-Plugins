# yvlux 本地回归检查

使用 Node.js 22+，需要 `typescript` 和 `sharp`。可使用现有依赖，或通过 `YVLUX_TEST_DEPS` 指向单独安装这些包的目录。

```text
node tests/yvlux.test.cjs
```

测试使用模拟 Telegram 客户端及本地生成的图片，覆盖组合命令、分张、改名范围、跳选序号、无框标签、完整单行昵称、比例缩放和失败进度。测试不访问绘图接口，也不发送 Telegram 消息。

## aix 双头像生图回归检查

需要 Node.js 22+、`typescript@5.9.3`（使用 `transpileModule` API）和 `sharp`，可通过 `AIX_TEST_DEPS` 指向依赖目录。

```text
node tests/aix.test.cjs
```

使用模拟 Telegram 客户端和本地红、蓝头像，检查头像来源与拼图顺序、单头像只下载一次、批量优化与无效结果回退、优化后立即生图、参考图复用、原提示词重试、附图上限、旧相册定位与原图保留、素材读取取消与超时、生成超时交付部分结果，以及主动停止不继续发送。文生图和部分结果交付会经过真实的本地媒体发送流程，检查临时文件内容及相册上传参数。测试不访问模型接口，也不发送 Telegram 消息。
