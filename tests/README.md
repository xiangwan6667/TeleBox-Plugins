# yvlux 本地回归检查

使用 Node.js 22+，需要 `typescript` 和 `sharp`。可使用现有依赖，或通过 `YVLUX_TEST_DEPS` 指向单独安装这些包的目录。

```text
node tests/yvlux.test.cjs
```

测试使用模拟 Telegram 客户端及本地生成的图片，覆盖组合命令、分张、改名范围、跳选序号、无框标签、完整单行昵称、比例缩放和失败进度。测试不访问绘图接口，也不发送 Telegram 消息。
