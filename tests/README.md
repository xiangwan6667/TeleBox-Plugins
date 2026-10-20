# yvlux 本地回归检查

使用 Node.js 22+，需要 `typescript` 和 `sharp`。可使用现有依赖，或通过 `YVLUX_TEST_DEPS` 指向单独安装这些包的目录。

```text
node tests/yvlux.test.cjs
```

测试使用模拟 Telegram 客户端及本地生成的图片，覆盖组合命令、分张、改名范围、跳选序号、无框标签、完整单行昵称、比例缩放和失败进度。测试不访问绘图接口，也不发送 Telegram 消息。

## aix 头像参考与生成回归检查

需要 Node.js 22+、`typescript@5.9.3`（使用 `transpileModule` API）和 `sharp`，可通过 `AIX_TEST_DEPS` 指向依赖目录。

```text
node tests/aix.test.cjs
```

使用模拟 Telegram 客户端和本地红、蓝头像，检查原有 `a`、`aa`、文生图和图生图，以及 `p` 模式的起点计数、稀疏消息编号、服务消息与命令排除、跳选顺序、跨页查找、重复作者缓存、无效序号和附图上限。同时覆盖批量优化校验、立即生图、重试保留参考、读取取消与超时、超时交付部分结果和主动停止。部分结果、相册和长提示词经过真实的本地媒体发送流程，检查上传参数、临时文件内容和文字长度。测试不访问模型接口，也不发送 Telegram 消息。
