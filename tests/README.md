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

使用模拟 Telegram 客户端和本地红、蓝头像，检查 `aa` 模式的头像来源、拼图顺序、提示词优化、多张生成、原提示词重试、附图上限、缺失头像提示，以及原有单头像和图生图用法。测试不访问模型接口，也不发送 Telegram 消息。
