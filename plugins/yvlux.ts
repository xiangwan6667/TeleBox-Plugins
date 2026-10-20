// YVLU Plugin - 生成文字语录贴纸 (TGS + MP4 + 自定义文字 + API配置 完整增强版)
//@ts-nocheck
// 导入网络请求、实用工具库
import axios from "axios";
import _ from "lodash";
// 导入 TeleBox 插件系统的相关依赖
import { getPrefixes, dealCommandPluginWithMessage, getCommandFromMessage } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto"; // 统一使用 teleproto 以匹配新版架构
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import { getGlobalClient } from "@utils/runtimeManager";
import { reviveEntities } from "@utils/tlRevive";
import { sleep } from "teleproto/Helpers";
import dayjs from "dayjs";
// 【BUG 修复】：彻底移除了 CustomFile 的导入，避免原型链冲突引发 [object Object] 类型异常
import * as zlib from "zlib";
import { execFile } from "child_process";
import { promisify } from "util";

// 将 execFile 转换为 Promise 版本以便于在 async/await 中使用
const execFileAsync = promisify(execFile);

// 定义全局的超时时间，防止 API 请求卡死
const timeout = 60000; 
// Python 路径配置，可根据宿主环境的虚拟环境进行修改
const PYTHON_PATH = "python3"; 

// ===================== 辅助函数区域 =====================

/**
 * 知识点：计算字符串的哈希值
 * 用于在无法获取用户确切 ID 时，根据用户名生成一个相对唯一且固定的数字标识
 */
const hashCode = (s: any) => {
  const l = s.length;
  let h = 0;
  let i = 0;
  if (l > 0) {
    while (i < l) {
      h = ((h << 5) - h + s.charCodeAt(i++)) | 0;
    }
  }
  return h;
};

/**
 * 知识点：判断 Buffer 数据是否为 WebM 视频格式
 * 通过读取文件头部的 4 个字节 (魔数 Magic Number) 进行匹配
 * WebM EBML Header: 0x1A 0x45 0xDF 0xA3
 */
function isWebmFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) return false;
  return (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  );
}

/**
 * 知识点：判断 Buffer 数据是否为 TGS 贴纸格式
 * TGS 本质上是经过 gzip 压缩的 Lottie JSON 动画文件
 * gzip 的魔数是: 0x1F 0x8B
 */
function isTgsFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 2) return false;
  return buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * 知识点：检查系统是否具备 TGS 转码为 WebM 的依赖环境
 * 1. 检查 Python 的 rlottie_python 库是否安装
 * 2. 检查 ffmpeg 是否可用
 */
async function checkTgsDependencies(): Promise<{ ok: boolean; message: string }> {
  try {
    await execFileAsync(PYTHON_PATH, ["-c", "from rlottie_python import LottieAnimation"]);
  } catch (e) {
    return {
      ok: false,
      message: "缺少 rlottie-python 依赖，请运行: pip3 install rlottie-python Pillow --break-system-packages",
    };
  }
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch (e) {
    return {
      ok: false,
      message: "缺少 ffmpeg，请安装: apt-get install -y ffmpeg",
    };
  }
  return { ok: true, message: "" };
}

/**
 * 知识点：将 TGS 动画转换为 WebM 视频格式
 * 过程：TGS ->(rlottie)-> GIF ->(ffmpeg)-> WebM (VP9 + Yuva420p 支持透明通道)
 */
async function convertTgsToWebm(tgsBuffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const tmpDir = os.tmpdir();
  // 生成唯一标识防止文件冲突
  const uniqueId = Date.now().toString() + "_" + Math.random().toString(36).slice(2);
  const tgsPath = path.join(tmpDir, `sticker_${uniqueId}.tgs`);
  const gifPath = path.join(tmpDir, `sticker_${uniqueId}.gif`);
  const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`);

  try {
    fs.writeFileSync(tgsPath, tgsBuffer);

    // 构建并执行 Python 脚本，将 TGS 转为 GIF
    const pythonScript = `
import sys
from rlottie_python import LottieAnimation
anim = LottieAnimation.from_tgs(sys.argv[1])
anim.save_animation(sys.argv[2])
`;
    await execFileAsync(PYTHON_PATH, ["-c", pythonScript, tgsPath, gifPath]);

    // 使用 ffmpeg 将 GIF 转为透明通道的 WebM
    await execFileAsync("ffmpeg", [
      "-i", gifPath, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
      "-b:v", "400k", "-auto-alt-ref", "0", "-an", "-y", webmPath,
    ]);

    const webmBuffer = fs.readFileSync(webmPath);
    return webmBuffer;
  } finally {
    // 无论成功还是失败，最终都要清理临时文件，防止存储空间泄漏
    try { fs.unlinkSync(tgsPath); } catch (e) {}
    try { fs.unlinkSync(gifPath); } catch (e) {}
    try { fs.unlinkSync(webmPath); } catch (e) {}
  }
}

/**
 * 知识点：检测是否为动态 WebP
 * 通过解析 RIFF 头部并向下搜索 'ANIM' 块来确定 WebP 中是否包含动画帧
 */
function isAnimatedWebP(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;

  // 检查 RIFF + WEBP 头
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return false;
  }

  // 搜索 ANIM 块
  for (let i = 12; i < buffer.length - 4; i++) {
    if (buffer.toString("ascii", i, i + 4) === "ANIM") {
      return true;
    }
  }
  return false;
}

/**
 * 知识点：检测是否为 MP4 格式视频
 * 读取偏移量 4-8 字节，匹配 'ftyp' 魔数
 */
function isMp4Format(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  const ftyp = buffer.toString("ascii", 4, 8);
  return ftyp === "ftyp";
}

/**
 * 知识点：将 MP4/GIF 视频转换为 WebM 格式
 * 使用 ffmpeg，开启 VP9 编码器和透明通道像素格式 (yuva420p)
 */
async function convertMp4ToWebm(mp4Buffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const tmpDir = os.tmpdir();
  const uniqueId = Date.now().toString() + "_" + Math.random().toString(36).slice(2);
  const mp4Path = path.join(tmpDir, `video_${uniqueId}.mp4`);
  const webmPath = path.join(tmpDir, `video_${uniqueId}.webm`);

  try {
    fs.writeFileSync(mp4Path, mp4Buffer);

    await execFileAsync("ffmpeg", [
      "-i", mp4Path, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
      "-b:v", "400k", "-auto-alt-ref", "0", "-an", "-y", webmPath,
    ]);

    const webmBuffer = fs.readFileSync(webmPath);
    return webmBuffer;
  } finally {
    try { fs.unlinkSync(mp4Path); } catch (e) {}
    try { fs.unlinkSync(webmPath); } catch (e) {}
  }
}

/**
 * 知识点：手动解析 WebP 文件的二进制头信息来获取图片宽和高
 * 支持 VP8(有损), VP8L(无损), VP8X(扩展) 三种编码格式的头部解析
 */
function getWebPDimensions(imageBuffer: any): { width: number; height: number } {
  try {
    // 如果是 WebM 格式，直接返回 Telegram 规定的贴纸标准默认尺寸
    if (isWebmFormat(imageBuffer)) {
      return { width: 512, height: 512 };
    }

    if (imageBuffer.length < 30) throw new Error("Invalid WebP file: too short");
    if (imageBuffer.toString("ascii", 0, 4) !== "RIFF") throw new Error("Invalid WebP file: missing RIFF header");
    if (imageBuffer.toString("ascii", 8, 12) !== "WEBP") throw new Error("Invalid WebP file: missing WEBP signature");

    const chunkHeader = imageBuffer.toString("ascii", 12, 16);

    if (chunkHeader === "VP8 ") {
      // VP8 格式：宽高信息在偏移 26 和 28 处，占 14 bits
      const width = imageBuffer.readUInt16LE(26) & 0x3fff;
      const height = imageBuffer.readUInt16LE(28) & 0x3fff;
      return { width, height };
    } else if (chunkHeader === "VP8L") {
      // VP8L 格式：位操作提取宽高
      const data = imageBuffer.readUInt32LE(21);
      const width = (data & 0x3fff) + 1;
      const height = ((data >> 14) & 0x3fff) + 1;
      return { width, height };
    } else if (chunkHeader === "VP8X") {
      // VP8X 格式：24位整数提取
      const width = (imageBuffer.readUInt32LE(24) & 0xffffff) + 1;
      const height = (imageBuffer.readUInt32LE(27) & 0xffffff) + 1;
      return { width, height };
    }

    console.warn("Unknown WebP format, using default dimensions");
    return { width: 512, height: 768 };
  } catch (error) {
    console.warn("Failed to parse WebP dimensions:", error);
    return { width: 512, height: 768 };
  }
}

/**
 * 知识点：从不同的 Peer 类型中提取纯数字 ID
 */
const getPeerNumericId = (peer?: Api.TypePeer): number | undefined => {
  if (!peer) return undefined;
  if (peer instanceof Api.PeerUser) return peer.userId;
  if (peer instanceof Api.PeerChat) return -peer.chatId; // ChatID 转换为负数
  if (peer instanceof Api.PeerChannel) return -peer.channelId; // ChannelID 转换为负数
  return undefined;
};

/**
 * 知识点：解析消息转发头部 (Forward Header) 的发送者信息
 * 针对隐私保护设置导致无法直接获取发信人的情况提供回退降级方案
 */
const resolveForwardSenderFromHeader = async (forwardHeader: Api.MessageFwdHeader, client: any) => {
  if (!forwardHeader) return undefined;

  const displayName = forwardHeader.fromName || forwardHeader.savedFromName || forwardHeader.postAuthor || "";
  const fallbackName = displayName || "未知来源";

  const peerCandidates = [
    forwardHeader.fromId,
    forwardHeader.savedFromPeer,
    forwardHeader.savedFromId,
  ].filter(Boolean);

  for (const peer of peerCandidates) {
    try {
      const entity = await client?.getEntity(peer as any);
      if (entity) {
        return entity;
      }
    } catch (error) {
      const errMsg = (error?.errorMessage || error?.message || "").toString();
      // 忽略因频道私有化报出的权限错误
      if (!errMsg.includes("CHANNEL_PRIVATE")) {
        console.warn("解析转发发送者失败", error);
      }
    }
  }

  // 降级：构造一个虚拟的用户实体
  return {
    id: getPeerNumericId(forwardHeader.fromId || forwardHeader.savedFromId || forwardHeader.savedFromPeer) || hashCode(fallbackName),
    firstName: fallbackName,
    lastName: "",
    username: forwardHeader.postAuthor || undefined,
    title: fallbackName,
    name: fallbackName,
  };
};

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
// 使用 yvlux 避免与官方 yvlu 插件的命令重名；保留配置目录 assets/yvlu，迁移时不会丢失现有设置。
const pluginName = "yvlux";
const commandName = `${mainPrefix}${pluginName}`;

function parsePickPositions(value: string): number[] {
  if (!/^\d+(?:[,，]\d+)*$/.test(value)) throw new Error(`用法：${commandName} p 1,6,8（序号之间用逗号，不加空格）`);
  const positions = [...new Set(value.split(/[,，]/).map(Number))].sort((a, b) => a - b);
  if (positions.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error("消息序号必须是正整数");
  return positions;
}
function selectPickedMessages<T>(messages: T[], positions: number[]): T[] {
  const missing = positions.filter(n => n > messages.length);
  if (missing.length) throw new Error(`未找到第 ${missing.join("、")} 条消息；当前范围内只有 ${messages.length} 条`);
  return positions.map(n => messages[n - 1]);
}

function parseQuoteOptions(input: string) {
  const tokens: { value: string; start: number; quoted: boolean }[] = [];
  for (let i = 0; i < input.length;) {
    if (/\s/.test(input[i])) { i++; continue; }
    const start = i, quote = input[i] === '"' || input[i] === "'" ? input[i++] : "";
    let value = "", closed = !quote;
    while (i < input.length) {
      if (quote && input[i] === quote) { i++; closed = true; break; }
      if (!quote && /\s/.test(input[i])) break;
      if (quote && input[i] === "\\" && (input[i + 1] === quote || input[i + 1] === "\\")) i++;
      value += input[i++];
    }
    if (!closed) throw new Error("引号没有闭合");
    if (quote && i < input.length && !/\s/.test(input[i])) throw new Error("引号后的选项之间需要空格");
    tokens.push({ value, start, quoted: !!quote });
  }
  let count = 1, countSet = false, pickPositions: number[] | undefined, r = false;
  let customName: string | undefined, customText: string | undefined, customTag: string | undefined;
  const valueAfter = (index: number, mode: string, allowEmpty = false) => {
    const token = tokens[index + 1];
    if (!token || (!token.value.trim() && !(allowEmpty && token.quoted)) || (!token.quoted && /^(p|pick|r|n|t|g|s|config|api)$/i.test(token.value))) throw new Error(`${mode} 后需要提供内容；包含空格或保留字时用引号包住`);
    return token.value;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], mode = token.quoted ? "" : token.value.toLowerCase();
    if (mode === "p" || mode === "pick") {
      if (pickPositions || countSet) throw new Error("连续数量和 p 跳选只能选择一种");
      pickPositions = parsePickPositions(valueAfter(i, "p"));
      count = pickPositions[pickPositions.length - 1]; i++;
    } else if (mode === "r") {
      r = true;
    } else if (mode === "n") {
      if (customName !== undefined) throw new Error("n 改名只能设置一次");
      customName = valueAfter(i, "n"); i++;
    } else if (mode === "t") {
      if (customText !== undefined) throw new Error("自定义文字只能设置一次");
      customText = valueAfter(i, "t"); i++;
    } else if (mode === "g") {
      if (customTag !== undefined) throw new Error("g 标签只能设置一次");
      customTag = valueAfter(i, "g", true).trim(); i++;
    } else if (!token.quoted && /^[+-]?\d+$/.test(token.value)) {
      if (countSet || pickPositions) throw new Error("连续数量和 p 跳选只能选择一种");
      count = Number(token.value); countSet = true;
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("消息数量必须是正整数");
    } else if (["s", "config", "api"].includes(mode)) {
      throw new Error("保存、配置和 API 命令需要单独使用");
    } else {
      if (customText !== undefined) throw new Error("自定义文字只能设置一次；组合使用时请用 t \"文字\"");
      customText = token.quoted && i === tokens.length - 1 ? token.value : input.slice(token.start);
      break;
    }
  }
  return { count, pickPositions, r, customName, customText, customTag };
}

function splitQuoteMessages(items: any[], perImage = 5): any[][] {
  const batches: any[][] = [];
  let batch: any[] = [], profile: any, tag: any, previousId: any;
  for (const item of items) {
    if (item.avatar || !profile || item.from.id !== previousId) {
      profile = item.from; tag = { senderTag: item.senderTag, senderTagRole: item.senderTagRole };
    }
    if (batch.length === perImage) { batches.push(batch); batch = []; }
    // 新一张的首条必须有完整昵称和头像，即使它与上一张末条是同一个人。
    batch.push(!batch.length && !item.avatar ? { ...item, ...tag, avatar: true, from: { ...profile } } : item);
    previousId = item.from.id;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function fetchQuoteMessages(client: any, replied: any, beforeId: number, needed: number): Promise<any[]> {
  const found = new Map<number, any>();
  if (replied.id < beforeId && !(replied instanceof Api.MessageService)) found.set(replied.id, replied);
  let cursor = replied.id;
  while (found.size < needed) {
    const page = await client.getMessages(replied.peerId, {
      offsetId: cursor, limit: Math.min(100, needed - found.size), reverse: true, maxId: beforeId,
    });
    let next = cursor;
    for (const message of page || []) {
      if (message.id <= cursor || message.id >= beforeId) continue;
      next = Math.max(next, message.id);
      if (!(message instanceof Api.MessageService)) found.set(message.id, message);
    }
    if (next <= cursor) break;
    cursor = next;
  }
  return [...found.values()].sort((a, b) => a.id - b.id).slice(0, needed);
}

// 简洁的命令菜单，同时用于插件说明和 help。
const help_text = `
<b>YVLUX · 语录贴纸</b>
回复消息使用，多条自动分张。

<b>生成语录</b>
• <code>${commandName} [数量]</code> — 单条 / 连续多条
• <code>${commandName} p 1,3,6</code> — 跳选消息
• <code>${commandName} r [数量]</code> — 包含回复引用
• <code>${commandName} n "名字"</code> — 自定义姓名
• <code>${commandName} g "标签"</code> — 自定义标签
• <code>${commandName} g ""</code> — 隐藏标签
• <code>${commandName} 文字</code> — 自定义正文

<b>组合示例</b>
<code>${commandName} 3 n "小王" g "群友"</code>
<code>${commandName} p 1,3 r t "文字"</code>
数量与 p 二选一；n/g 只改首条作者，t 只改首条消息。带空格或与选项同名的内容加引号。

<b>贴纸与设置（单独使用）</b>
• <code>${commandName} s</code> — 保存图片 / 贴纸
• <code>${commandName} config sticker 名称</code> — 设置贴纸包
• <code>${commandName} api URL</code> — 设置接口
• <code>${commandName} api reset</code> — 重置接口
`;

/**
 * 知识点：Telegram 消息实体 (Entity) 映射转换器
 * 将 MTProto 协议里的内联样式、URL、提及、隐藏文字等转换为 quote-api 可识别的 JSON 结构
 */
function convertEntities(entities: Api.TypeMessageEntity[]): any[] {
  if (!entities) return [];

  return entities.map((entity) => {
    const baseEntity = {
      offset: entity.offset,
      length: entity.length,
    };

    if (entity instanceof Api.MessageEntityBold) {
      return { ...baseEntity, type: "bold" };
    } else if (entity instanceof Api.MessageEntityItalic) {
      return { ...baseEntity, type: "italic" };
    } else if (entity instanceof Api.MessageEntityUnderline) {
      return { ...baseEntity, type: "underline" };
    } else if (entity instanceof Api.MessageEntityStrike) {
      return { ...baseEntity, type: "strikethrough" };
    } else if (entity instanceof Api.MessageEntityCode) {
      return { ...baseEntity, type: "code" };
    } else if (entity instanceof Api.MessageEntityPre) {
      return { ...baseEntity, type: "pre" };
    } else if (entity instanceof Api.MessageEntityCustomEmoji) {
      const documentId = (entity as any).documentId;
      const custom_emoji_id = documentId?.value?.toString() || documentId?.toString() || "";
      return { ...baseEntity, type: "custom_emoji", custom_emoji_id };
    } else if (entity instanceof Api.MessageEntityUrl) {
      return { ...baseEntity, type: "url" };
    } else if (entity instanceof Api.MessageEntityTextUrl) {
      return { ...baseEntity, type: "text_link", url: (entity as any).url || "" };
    } else if (entity instanceof Api.MessageEntityMention) {
      return { ...baseEntity, type: "mention" };
    } else if (entity instanceof Api.MessageEntityMentionName) {
      return { ...baseEntity, type: "text_mention", user: { id: (entity as any).userId } };
    } else if (entity instanceof Api.MessageEntityHashtag) {
      return { ...baseEntity, type: "hashtag" };
    } else if (entity instanceof Api.MessageEntityCashtag) {
      return { ...baseEntity, type: "cashtag" };
    } else if (entity instanceof Api.MessageEntityBotCommand) {
      return { ...baseEntity, type: "bot_command" };
    } else if (entity instanceof Api.MessageEntityEmail) {
      return { ...baseEntity, type: "email" };
    } else if (entity instanceof Api.MessageEntityPhone) {
      return { ...baseEntity, type: "phone_number" };
    } else if (entity instanceof Api.MessageEntitySpoiler) {
      return { ...baseEntity, type: "spoiler" };
    }

    return baseEntity;
  });
}

// ===================== 类定义区域 =====================

/**
 * 知识点：定义配置文件的接口格式，规范化管理持久化状态
 */
interface YvluConfig {
  stickerSetShortName: string;
  apiUrl: string;
  _comment?: string;
}

// 默认文字绘图共用 glass 路径；头像、媒体和引用预览在本地合成。
const DEFAULT_API_URL = "https://quote.yuri.ly/generate.webp";
const MEDIA_API_URL = "https://quote-api-enhanced.zhetengsha.eu.org/generate.webp";
const QUOTE_APPEARANCE = {
  style: "glass",
  backgroundColor: "#302737/#221d2a",
};

function quoteBodyText(message: any): string {
  let text = typeof message.text === "string" ? message.text : String(message.text || "");
  if (!text.trim()) {
    // 无文字媒体仍须保留一个基础气泡，不能让接口跳过此条、导致后续姓名错位。
    text = message.media ? "\u200b" : message.replyMessage ? "\u200b" : "[无文字消息]";
  }
  // 后端会将 1–3 个纯表情改成无气泡的大贴纸。末尾加不可见字符保留普通气泡；
  // 只追加后缀，不改变正文或任何实体的 UTF-16 偏移。
  if (/^[\p{Emoji}\p{Emoji_Component}\s]+$/u.test(text) && /\p{Emoji_Presentation}|\p{Extended_Pictographic}|\u20e3/u.test(text)) text += "\u200b";
  return text;
}

class QuoteLayoutError extends Error {
  constructor(details: string) { super(details); this.name = "QuoteLayoutError"; }
}

async function getQuoteSenderTag(message: any, sender: any, client: any, cache: Map<string, Promise<any>>) {
  // 转发消息使用原作者，不能把转发者在当前群的标签贴到原作者身上。
  if (message.fwdFrom || !sender?.id || message.fromId instanceof Api.PeerChannel) return {};
  const peer = message.peerId;
  if (!(peer instanceof Api.PeerChannel) && !(peer instanceof Api.PeerChat)) return {};
  const directRank = message.fromRank ?? message.from_rank;
  // 新版超级群消息自带 from_rank，直接使用消息上的标签，无需额外查询。
  if (typeof directRank === "string" && directRank.trim()) {
    return { senderTag: directRank.trim(), senderTagRole: "member" };
  }
  try {
    let participant: any;
    if (peer instanceof Api.PeerChannel) {
      const key = `channel:${peer.channelId}:${sender.id}`;
      if (!cache.has(key)) cache.set(key, (async () => {
        const input = await client.getInputEntity(peer);
        const result = await client.invoke(new Api.channels.GetParticipant({
          channel: new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash }),
          participant: await client.getInputEntity(sender),
        }));
        return result.participant;
      })());
      participant = await cache.get(key);
    } else {
      const key = `chat:${peer.chatId}`;
      if (!cache.has(key)) cache.set(key, client.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId })));
      const full = await cache.get(key);
      const members = full.fullChat?.participants;
      participant = (members?.participants || [members?.selfParticipant]).find((member: any) =>
        member?.userId?.toString() === sender.id.toString());
    }
    const kind = participant?.className || participant?.constructor?.name || "";
    const owner = /ParticipantCreator$/.test(kind);
    const admin = /ParticipantAdmin$/.test(kind);
    const rank = typeof participant?.rank === "string" ? participant.rank.trim() : "";
    const text = rank || (owner ? "群主" : admin ? "管理员" : "");
    return text ? { senderTag: text, senderTagRole: "member" } : {};
  } catch {
    // 旧协议或无权查询成员时仍正常生成语录。
    return {};
  }
}

// 用同一后端绘制短文字片段，再在本地排版，避开后端 300px 标题行的淡出截断。
// 头像、中文字体、普通及自定义 Emoji 仍由已有渲染路径处理。
const quoteHeaderCache = new Map<string, Buffer>();
async function renderQuoteHeaders(messages: any[], emojiBrand = "apple"): Promise<(Buffer | undefined)[]> {
  const sharp = (await import("sharp")).default;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const chunks = (text: string) => {
    const units = Array.from(segmenter.segment(text), item => item.segment);
    const result: { text: string; space: boolean }[] = [];
    for (let i = 0; i < units.length; i += 11) {
      const raw = units.slice(i, i + 11).join("");
      if (raw.trim()) result.push({ text: raw.trim(), space: i > 0 && /\s/.test(units[i - 1] + units[i]) });
    }
    return result;
  };
  const entries = messages.map(message => {
    if (!message.avatar) return undefined;
    const from = message.from || {};
    const name = (from.name || [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "").replace(/[\r\n\t\u2028\u2029]/g, " ").trim();
    const tag = (message.senderTag || "").replace(/[\r\n\t\u2028\u2029]/g, " ").trim();
    const key = JSON.stringify([from.id, name, tag, from.accentColorId, from.emoji_status, emojiBrand]);
    return { key, name, tag, from };
  });
  const missing = new Map<string, any>();
  const rendered = new Map<string, Buffer>();
  for (const entry of entries) if (entry && quoteHeaderCache.has(entry.key)) rendered.set(entry.key, quoteHeaderCache.get(entry.key)!);
  for (const entry of entries) if (entry && !quoteHeaderCache.has(entry.key)) missing.set(entry.key, entry);
  const rows: any[] = [];
  for (const entry of missing.values()) {
    for (const [kind, text] of [["name", entry.name], ["tag", entry.tag]]) {
      const pieces = chunks(text);
      for (const [index, piece] of pieces.entries()) rows.push({ entry, kind, ...piece, status: kind === "name" && index === pieces.length - 1 ? entry.from.emoji_status : undefined });
    }
  }
  if (rows.length) {
    const response = await axios({
      method: "post", url: DEFAULT_API_URL, timeout, responseType: "arraybuffer",
      headers: { "Content-Type": "application/json", "User-Agent": "TeleBox/0.2.1" },
      data: {
        type: "png", format: "png", style: "classic", backgroundColor: "#00000000",
        width: 512, height: 768, scale: 2, emojiBrand,
        messages: rows.map((row, index) => ({
          chatId: index + 1, avatar: false, text: "", entities: [],
          // 临时 H 用于定位共同基线，合成前去掉；避免 Emoji/CJK 导致文字高低不齐。
          from: { id: row.entry.from.id, name: `H ${row.text}`, accentColorId: row.entry.from.accentColorId, emoji_status: row.status },
        })),
      },
    });
    const sheet = Buffer.from(response.data);
    const { data, info } = await sharp(sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const bands: { top: number; bottom: number }[] = [];
    let band: any;
    for (let y = 0; y < info.height; y++) {
      let ink = false;
      for (let x = 0; x < info.width && !ink; x++) ink = data[(y * info.width + x) * 4 + 3] > 8;
      if (!ink) continue;
      if (!band || y - band.bottom > 56) { band = { top: y, bottom: y }; bands.push(band); }
      else band.bottom = y;
    }
    if (bands.length !== rows.length) throw new Error("昵称文字渲染不完整，请稍后重试");
    for (const [index, row] of rows.entries()) {
      const band = bands[index];
      const columns = new Uint8Array(info.width);
      for (let y = band.top; y <= band.bottom; y++) for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3] > 8) columns[x] = 1;
      }
      const markerLeft = columns.findIndex(Boolean);
      let markerRight = markerLeft;
      while (markerRight + 1 < info.width && columns[markerRight + 1]) markerRight++;
      let left = markerRight + 1, right = info.width - 1, baseline = band.top;
      while (left < info.width && !columns[left]) left++;
      while (right >= left && !columns[right]) right--;
      if (right < left) throw new Error("昵称文字渲染不完整，请稍后重试");
      for (let y = band.top; y <= band.bottom; y++) for (let x = markerLeft; x <= markerRight; x++) {
        if (data[(y * info.width + x) * 4 + 3] > 8) baseline = Math.max(baseline, y + 1);
      }
      row.baseline = baseline - band.top;
      row.image = await sharp(sheet).extract({ left, top: band.top, width: right - left + 1, height: band.bottom - band.top + 1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (row.kind === "tag") {
        for (let p = 0; p < row.image.data.length; p += 4) {
          row.image.data[p] = 180; row.image.data[p + 1] = 171; row.image.data[p + 2] = 191;
          row.image.data[p + 3] = Math.round(row.image.data[p + 3] * 0.78);
        }
      }
    }
    for (const entry of missing.values()) {
      const layers: any[] = [];
      let x = 0, baseline = 0, below = 0, previousKind = "";
      for (const row of rows.filter(row => row.entry === entry)) {
        const factor = (row.kind === "name" ? 20 : 15) / 22;
        const width = Math.max(1, Math.round(row.image.info.width * factor));
        const height = Math.max(1, Math.round(row.image.info.height * factor));
        // 姓名和无框标签始终在同一行；宽度随内容增长，最终整张贴纸统一缩放。
        if (x) x += row.kind !== previousKind ? 16 : row.space ? 12 : 2;
        const image = await sharp(row.image.data, { raw: { width: row.image.info.width, height: row.image.info.height, channels: 4 } }).resize(width, height).png().toBuffer();
        const rowBaseline = Math.round(row.baseline * factor);
        layers.push({ input: image, left: x, top: 0, baseline: rowBaseline });
        x += width; baseline = Math.max(baseline, rowBaseline); below = Math.max(below, height - rowBaseline); previousKind = row.kind;
      }
      if (!layers.length) continue;
      const header = await sharp({ create: { width: x, height: baseline + below, channels: 4, background: "#00000000" } })
        .composite(layers.map(({ baseline: rowBaseline, ...layer }) => ({ ...layer, top: baseline - rowBaseline }))).png().toBuffer();
      if (quoteHeaderCache.size >= 64) quoteHeaderCache.delete(quoteHeaderCache.keys().next().value);
      quoteHeaderCache.set(entry.key, header);
      rendered.set(entry.key, header);
    }
  }
  return entries.map(entry => entry ? rendered.get(entry.key) : undefined);
}

/** 扩大气泡内边距，复用原文字图层和 glass 高光参数。 */
async function expandGlassPadding(buffer: Buffer, headers: (Buffer | undefined)[] = [], messages: any[] = [], normalize = true): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const seen = new Uint8Array(width * height);
  const parts: any[] = [];
  for (let seed = 0; seed < seen.length; seed++) {
    if (seen[seed] || data[seed * 4 + 3] < 128) continue;
    const pixels = [seed];
    seen[seed] = 1;
    let left = width, right = 0, top = height, bottom = 0;
    for (let i = 0; i < pixels.length; i++) {
      const pixel = pixels[i], x = pixel % width, y = Math.floor(pixel / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const next of [x ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1, y ? pixel - width : -1, y + 1 < height ? pixel + width : -1]) {
        if (next >= 0 && !seen[next] && data[next * 4 + 3] >= 128) {
          seen[next] = 1; pixels.push(next);
        }
      }
    }
    parts.push({ left, right, top, bottom, pixels });
  }
  const avatars = parts.filter(p => p.left === 0 && p.right >= 7 && Math.abs(p.right + 1 - (p.bottom - p.top + 1)) <= 3);
  if (!avatars.length) {
    if (messages.length) throw new QuoteLayoutError("未识别到头像布局");
    return buffer;
  }
  const scale = (avatars[0].right + 1) / 50;
  const bubbles = parts.filter(p => p.left >= 44 * scale && p.right - p.left + 1 >= 32 * scale && p.pixels.length > (p.right - p.left + 1) * (p.bottom - p.top + 1) * 0.65)
    .sort((a, b) => a.top - b.top);
  if (!bubbles.length) {
    if (messages.length) throw new QuoteLayoutError("未识别到消息气泡");
    return buffer;
  }
  // 按参考图保持紧凑比例：原内边距 16px → 18px，不缩放字形。
  const extra = Math.max(1, Math.round(2 * scale));
  if (headers.length && bubbles.length !== headers.length) throw new QuoteLayoutError(`消息气泡数量不匹配：${bubbles.length}/${headers.length}`);
  const renderedHeaders = await Promise.all(bubbles.map(async (_, index) => {
    if (!headers[index]) return undefined;
    const meta = await sharp(headers[index]).metadata();
    const w = Math.max(1, Math.round(meta.width! * scale / 2)), h = Math.max(1, Math.round(meta.height! * scale / 2));
    return { buffer: await sharp(headers[index]).resize(w, h).png().toBuffer(), width: w, height: h };
  }));
  const decodeImage = (url?: string) => {
    const match = /^data:image\/[\w.+-]+;base64,(.+)$/i.exec(url || "");
    return match ? Buffer.from(match[1], "base64") : undefined;
  };
  const images = await Promise.all(bubbles.map(async (_, index) => {
    const source = decodeImage(messages[index]?.media?.url);
    if (!source) return undefined;
    const result = await sharp(source).resize({ width: Math.max(1, Math.round(300 * scale)), height: Math.max(1, Math.round(220 * scale)), fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    return { buffer: result.data, width: result.info.width, height: result.info.height };
  }));
  const extraHeaderHeight = renderedHeaders.reduce((sum, header) => sum + (header ? header.height + Math.round(12 * scale) : 0), 0);
  const extraImageHeight = images.reduce((sum, image) => sum + (image ? image.height + Math.round(12 * scale) : 0), 0);
  // 只扩大消息之间的留白：同人约 2→8px，不同人约 8→14px，保留分组层级。
  const messageGap = Math.max(1, Math.round(6 * scale));
  const outWidth = Math.max(width + extra * 2, Math.ceil(112 * scale) + Math.max(0, ...renderedHeaders.map(header => header?.width || 0), ...images.map(image => image?.width || 0)));
  const outHeight = height + bubbles.length * extra * 2 + extraHeaderHeight + extraImageHeight + (bubbles.length - 1) * messageGap;
  const layers: any[] = [];
  const finishMasks: any[] = [];
  const finishRegions: any[] = [];
  const protectedImages: any[] = [];
  let start = 0, offsetY = 0;
  for (const [index, bubble] of bubbles.entries()) {
    if (index) offsetY += messageGap;
    const end = index + 1 < bubbles.length ? Math.floor((bubble.bottom + bubbles[index + 1].top) / 2) + 1 : height;
    const bandAvatars = avatars.filter(p => (p.top + p.bottom) / 2 >= start && (p.top + p.bottom) / 2 < end);
    const middle = Math.floor((bubble.top + bubble.bottom) / 2);
    const bodyLeft = Math.min(...bubble.pixels.filter((pixel: number) => Math.floor(pixel / width) === middle).map((pixel: number) => pixel % width));
    const oldW = bubble.right - bodyLeft + 1, oldH = bubble.bottom - bubble.top + 1;
    const header = renderedHeaders[index], headerHeight = header ? header.height + Math.round(12 * scale) : 0;
    const image = images[index], imageHeight = image ? image.height + Math.round(12 * scale) : 0;
    const w = Math.max(oldW + extra * 2, Math.max(header?.width || 0, image?.width || 0) + Math.round(36 * scale)), h = oldH + extra * 2 + headerHeight + imageHeight;
    // 参考图的圆角与正文字号比例约为 1.1，保持饱满且紧凑。
    const radius = Math.min(27 * scale, w / 2, h / 2), grouped = 7 * scale;
    // 相邻气泡原来的小圆角可由边角 alpha 判断，保留同人连续消息的分组形状。
    const probe = Math.max(1, Math.round(3 * scale));
    const round = (x: number, y: number) => data[(y * width + x) * 4 + 3] >= 128 ? grouped : radius;
    const radii = [round(bodyLeft + probe, bubble.top + probe), round(bubble.right - probe, bubble.top + probe), round(bubble.right - probe, bubble.bottom - probe), round(bodyLeft + probe, bubble.bottom - probe)];
    const group = messages[index]?._quoteGroup;
    if (group) { radii[0] = group.previousSame ? grouped : radius; radii[3] = group.nextSame ? grouped : radius; }
    const tail = (!group || !group.nextSame) && bubble.left < bodyLeft - scale ? 14 * scale : 0;
    const [rTL, rTR, rBR] = radii;
    // 尾巴附近的 alpha 本来就是实心，不能把它误判为分组的小圆角。
    const rBL = tail ? radius : radii[3];
    const shape = `M ${rTL} 0 H ${w - rTR} A ${rTR} ${rTR} 0 0 1 ${w} ${rTR} V ${h - rBR} A ${rBR} ${rBR} 0 0 1 ${w - rBR} ${h} ` +
      (tail ? `H ${-tail} C ${-tail * 0.4} ${h} 0 ${h - rBL * 0.3} 0 ${h - rBL}` : `H ${rBL} A ${rBL} ${rBL} 0 0 1 0 ${h - rBL}`) +
      ` V ${rTL} A ${rTL} ${rTL} 0 0 1 ${rTL} 0 Z`;
    const lw = 2 * scale;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}"><defs>
      <linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="${extra}" y1="${extra}" x2="${extra + oldW}" y2="${extra + oldH}"><stop stop-color="#302737"/><stop offset="1" stop-color="#221d2a"/></linearGradient>
      <linearGradient id="light" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${h * 0.4}"><stop stop-color="white" stop-opacity="0.22"/><stop offset="1" stop-color="white" stop-opacity="0"/></linearGradient>
      <clipPath id="bubble"><path d="${shape}"/></clipPath>
      <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${3 * scale}"/></filter>
      </defs><g transform="translate(${bodyLeft} ${bubble.top + offsetY})">
      <path d="${shape}" transform="translate(0 ${2 * scale})" fill="black" opacity="0.24" filter="url(#shadow)"/>
      <path d="${shape}" fill="url(#fill)"/>
      <g clip-path="url(#bubble)" fill="none"><path d="${shape}" stroke="white" stroke-opacity="0.09" stroke-width="${lw * 2}"/><path d="${shape}" stroke="url(#light)" stroke-width="${lw * 2.6}"/></g></g></svg>`;
    layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
    // 材质只作用在气泡内部，避开现有描边和顶部高光。
    finishMasks.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}"><path transform="translate(${bodyLeft} ${bubble.top + offsetY})" d="${shape}" fill="white" stroke="black" stroke-width="${lw * 4}"/></svg>`), left: 0, top: 0 });
    finishRegions.push({ left: bodyLeft, top: bubble.top + offsetY, width: w, height: h });
    // 光学内边距按可见字形计量；底部多保留一段，以免裁掉字母下伸部。
    const side = Math.round(16 * scale), above = Math.round(12 * scale), below = Math.round(8 * scale);
    const content = { left: bodyLeft + side, top: bubble.top + above, width: oldW - side * 2, height: oldH - above - below };
    if (content.width <= 0 || content.height <= 0) throw new QuoteLayoutError("消息内容区域不完整");
    layers.push({ input: await sharp(buffer).extract(content).png().toBuffer(), left: content.left + extra, top: content.top + offsetY + extra + headerHeight });
    if (header) layers.push({ input: header.buffer, left: bodyLeft + Math.round(18 * scale), top: bubble.top + offsetY + Math.round(18 * scale) });
    const addImage = async (source: Buffer, left: number, top: number, imageW: number, imageH: number, radius: number) => {
      const rounded = await sharp(source).resize(imageW, imageH, { fit: "cover" }).composite([{ input: Buffer.from(`<svg width="${imageW}" height="${imageH}"><rect width="${imageW}" height="${imageH}" rx="${radius}" fill="white"/></svg>`), blend: "dest-in" }]).png().toBuffer();
      layers.push({ input: rounded, left, top });
      protectedImages.push({ left, top, width: imageW, height: imageH });
    };
    if (image) await addImage(image.buffer, bodyLeft + Math.round(18 * scale), bubble.bottom + offsetY + extra + headerHeight + Math.round(4 * scale), image.width, image.height, Math.max(1, Math.round(8 * scale)));
    const replyImage = decodeImage(messages[index]?.replyMessage?.media?.url);
    if (replyImage) {
      // 后端只接受远程图片 URL。先用 story 环预留 40px 缩略图，再以本地图片替换。
      const thumbX = bodyLeft + Math.round(28 * scale), centerX = thumbX + Math.round(20 * scale);
      let thumbY = bubble.top + Math.round(24 * scale);
      for (let y = bubble.top + Math.round(18 * scale); y < Math.min(bubble.bottom, bubble.top + Math.round(42 * scale)); y++) {
        const p = (y * width + centerX) * 4, rgb = [data[p], data[p + 1], data[p + 2]];
        if (Math.max(...rgb) > 90 && Math.max(...rgb) - Math.min(...rgb) > 35) { thumbY = y - 1; break; }
      }
      const size = Math.max(1, Math.round(40 * scale));
      const left = thumbX + extra, top = thumbY + offsetY + extra + headerHeight, radius = Math.max(1, Math.round(4 * scale));
      // 先擦除占位环，透明贴纸的空白处不能透出原来的 story 图案。
      const sampleX = Math.min(width - 1, thumbX + size + Math.round(3 * scale)), sampleY = Math.min(height - 1, thumbY + Math.round(size / 2));
      const sample = (sampleY * width + sampleX) * 4;
      layers.push({ input: Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="rgb(${data[sample]},${data[sample + 1]},${data[sample + 2]})"/></svg>`), left, top });
      await addImage(replyImage, left, top, size, size, radius);
    }
    // 头像只移动到底部，大小和内容保持原样。
    for (const avatar of bandAvatars) {
      layers.push({ input: await sharp(buffer).extract({ left: avatar.left, top: avatar.top, width: avatar.right - avatar.left + 1, height: avatar.bottom - avatar.top + 1 }).png().toBuffer(), left: avatar.left, top: avatar.top + offsetY + extra * 2 + headerHeight + imageHeight });
    }
    start = end;
    offsetY += extra * 2 + headerHeight + imageHeight;
  }
  const output = await sharp({ create: { width: outWidth, height: outHeight, channels: 4, background: "#00000000" } }).composite(layers).raw().toBuffer();
  const finishMask = await sharp({ create: { width: outWidth, height: outHeight, channels: 4, background: "#00000000" } }).composite(finishMasks).raw().toBuffer();
  for (const region of finishRegions) {
    for (let y = region.top; y < Math.min(outHeight, region.top + region.height); y++) {
      for (let x = region.left; x < Math.min(outWidth, region.left + region.width); x++) {
        const pixel = (y * outWidth + x) * 4;
        if (protectedImages.some(image => x >= image.left && x < image.left + image.width && y >= image.top && y < image.top + image.height)) continue;
        const mask = finishMask[pixel] * finishMask[pixel + 3] / (255 * 255);
        const brightest = Math.max(output[pixel], output[pixel + 1], output[pixel + 2]);
        // 保留文字、昵称和标签的亮色；背景用宽柔光和轻微透光呈现玻璃层次。
        const weight = mask * Math.max(0, Math.min(1, (86 - brightest) / 26));
        if (!weight) continue;
        const u = (x - region.left) / region.width, v = (y - region.top) / region.height;
        const softLight = 9 * Math.exp(-Math.pow((u - 0.18) / 0.8, 2) - Math.pow((v - 0.12) / 0.65, 2))
          + 2 * Math.exp(-Math.pow((u - 0.86) / 0.45, 2) - Math.pow((v - 0.82) / 0.7, 2));
        // 固定的细颗粒，避免每次生成出现不同强度的噪点。
        const hash = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
        const grain = ((Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 0) / 4294967295 - 0.5) * 0.6;
        const lift = (softLight + grain) * weight;
        for (let channel = 0; channel < 3; channel++) output[pixel + channel] = Math.max(0, Math.min(255, Math.round(output[pixel + channel] + lift)));
        output[pixel + 3] = Math.round(output[pixel + 3] * (1 - 0.07 * weight));
      }
    }
  }
  let right = 0, bottom = 0;
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
    if (output[(y * outWidth + x) * 4 + 3]) { right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  // 优先利用原贴纸的透明区域；超出 Telegram 尺寸时再整体缩小。
  const image = sharp(output, { raw: { width: outWidth, height: outHeight, channels: 4 } })
    .extract({ left: 0, top: 0, width: Math.max(width, right + 1), height: Math.max(height, bottom + 1) });
  if (!normalize) return image.png().toBuffer();
  return image.resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).webp({ lossless: true }).toBuffer();
}

/** 新版 API 只接受远程头像 URL；用本地已下载的头像替换它绘制的圆形占位头像。 */
async function restoreGlassAvatars(buffer: Buffer, messages: any[]): Promise<Buffer> {
  const groups = messages.filter(message => message.avatar);
  if (!groups.some(message => message.from.photo?.url?.startsWith("data:"))) return buffer;
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const visited = new Uint8Array(width * height);
  const circles: { left: number; top: number; right: number; bottom: number }[] = [];
  // 头像独占最左侧一列。沿 alpha 连通区域寻找圆形，不依赖文字长度或缩放比例。
  for (let y = 0; y < height; y++) {
    const seed = y * width;
    if (visited[seed] || data[seed * 4 + 3] < 128) continue;
    const queue = [seed];
    visited[seed] = 1;
    let left = 0, right = 0, top = y, bottom = y;
    for (let i = 0; i < queue.length; i++) {
      const pixel = queue[i], px = pixel % width, py = Math.floor(pixel / width);
      right = Math.max(right, px); top = Math.min(top, py); bottom = Math.max(bottom, py);
      const neighbors = [px > 0 ? pixel - 1 : -1, px + 1 < width ? pixel + 1 : -1, py > 0 ? pixel - width : -1, py + 1 < height ? pixel + width : -1];
      for (const next of neighbors) {
        if (next >= 0 && !visited[next] && data[next * 4 + 3] >= 128) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    const w = right - left + 1, h = bottom - top + 1;
    if (w >= 8 && Math.abs(w - h) <= 3 && w < width / 2) circles.push({ left, right, top, bottom });
  }
  if (circles.length !== groups.length) {
    console.warn("[yvlux] 头像布局未匹配，保留 API 返回的头像");
    return buffer;
  }
  for (const [index, circle] of circles.entries()) {
    const photo = /^data:image\/[\w.+-]+;base64,(.+)$/i.exec(groups[index].from.photo?.url || "");
    if (!photo) continue;
    const w = circle.right - circle.left + 1, h = circle.bottom - circle.top + 1;
    const avatar = await sharp(Buffer.from(photo[1], "base64")).resize(w, h, { fit: "cover" }).ensureAlpha().raw().toBuffer();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const target = ((circle.top + y) * width + circle.left + x) * 4, source = (y * w + x) * 4;
        avatar.copy(data, target, source, source + 3);
        data[target + 3] = Math.round(data[target + 3] * avatar[source + 3] / 255);
      }
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).webp({ lossless: true }).toBuffer();
}

/** 语录中的媒体统一为本地预览，避免旧媒体接口绕过玻璃、全名和群标签处理。 */
async function getQuoteMediaPreview(message: any): Promise<{ url: string } | undefined> {
  const media = message.media;
  if (!(media instanceof Api.MessageMediaPhoto) && !(media instanceof Api.MessageMediaDocument)) return undefined;
  const mime = media.document?.mimeType || "image/jpeg";
  if (!/^(image\/|video\/|application\/x-tgsticker)/.test(mime)) return undefined;
  const sharp = (await import("sharp")).default;
  const isPhoto = media instanceof Api.MessageMediaPhoto;
  // 照片取正文；视频/动画先用 Telegram 提供的缩略图，避免不必要的转码依赖。
  let buffer: Buffer | undefined;
  if (!isPhoto) {
    try {
      const thumbs = (media.document?.thumbs || []).filter((thumb: any) => thumb.w && thumb.h).sort((a: any, b: any) => b.w * b.h - a.w * a.h);
      const thumb = await message.downloadMedia({ thumb: thumbs[0] || 0 });
      if (Buffer.isBuffer(thumb) && thumb.length) buffer = await sharp(thumb).png().toBuffer();
    } catch {}
  }
  if (!buffer) {
    const full = await message.downloadMedia();
    if (!Buffer.isBuffer(full) || !full.length) throw new Error("媒体预览下载失败");
    if (isTgsFormat(full)) {
      const dependencies = await checkTgsDependencies();
      if (!dependencies.ok) throw new Error(dependencies.message);
      buffer = await convertTgsToWebm(full);
    } else buffer = full;
    if (isWebmFormat(buffer) || isMp4Format(buffer)) {
      const os = await import("os");
      const input = path.join(os.tmpdir(), `yvlux_preview_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      try {
        fs.writeFileSync(input, buffer);
        const { stdout } = await execFileAsync("ffmpeg", ["-v", "error", "-i", input, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
        buffer = stdout as any;
      } finally { try { fs.unlinkSync(input); } catch {} }
    }
  }
  const png = await sharp(buffer).rotate().resize({ width: 900, height: 900, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return { url: `data:image/png;base64,${png.toString("base64")}` };
}

async function uploadQuoteStickerImage(client: any, source: Buffer): Promise<any> {
  const sharp = (await import("sharp")).default;
  let buffer = await sharp(source).rotate().resize({ width: 512, height: 512, fit: "inside" }).webp({ lossless: true }).toBuffer();
  if (buffer.length > 512 * 1024) buffer = await sharp(buffer).webp({ quality: 85 }).toBuffer();
  const { width, height } = await sharp(buffer).metadata();
  // uploadFile 需要 size/arrayBuffer；裸 Buffer 加 name 仍不是有效的上传文件。
  const file = await client.uploadFile({ file: {
    name: "sticker.webp", size: buffer.length,
    arrayBuffer: async () => Uint8Array.from(buffer).buffer,
  }, workers: 1 });
  const uploaded = await client.invoke(new Api.messages.UploadMedia({
    peer: new Api.InputPeerSelf(),
    media: new Api.InputMediaUploadedDocument({
      file, mimeType: "image/webp",
      attributes: [new Api.DocumentAttributeFilename({ fileName: "sticker.webp" }), new Api.DocumentAttributeImageSize({ w: width!, h: height! })],
    }),
  }));
  const doc = uploaded?.document;
  if (!doc?.id || !doc.accessHash) throw new Error("未能取得上传图片的贴纸文档");
  return new Api.InputDocument({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference || Buffer.alloc(0) });
}


class YvluPlugin extends Plugin {
  // 设置插件帮助描述（会被核心管理器抓取显示）
  description: string = help_text;
  private config: YvluConfig | null = null;
  private configPath: string = "";

  /**
   * 知识点：生命周期函数 onLoad
   * 在插件挂载时初始化存储目录和默认的 config.json 文件
   */
  async onLoad() {
    const configDir = createDirectoryInAssets("yvlu");
    this.configPath = path.join(configDir, "config.json");

    console.log(`yvlu 配置文件路径: ${this.configPath}`);

    if (!fs.existsSync(this.configPath)) {
      const defaultConfig: YvluConfig = {
        stickerSetShortName: "",
        apiUrl: "",
        _comment: "shortName 只能包含字母、数字和下划线; apiUrl为空时使用默认",
      };
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
      console.log(`已创建默认配置文件: ${this.configPath}`);
    }

    await this.loadConfig();
  }

  /**
   * 知识点：加载本地配置文件
   * 提供异常捕获，防止因为 JSON 格式错误导致整个插件卡死
   */
  async loadConfig() {
    try {
      if (!this.configPath || this.configPath === "") {
        const configDir = createDirectoryInAssets("yvlu");
        this.configPath = path.join(configDir, "config.json");
      }

      if (!fs.existsSync(this.configPath)) {
        this.config = { stickerSetShortName: "", apiUrl: "" };
        return;
      }

      const configData = fs.readFileSync(this.configPath, "utf-8");
      this.config = JSON.parse(configData);
    } catch (error) {
      console.error("加载 yvlu 配置失败:", error);
      this.config = { stickerSetShortName: "", apiUrl: "" };
    }
  }

  /**
   * 知识点：持久化保存最新配置至硬盘
   */
  async saveConfig() {
    if (this.config && this.configPath) {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
    }
  }

  /**
   * 知识点：调用后端 quote-api 核心函数
   * 发送组装好的 JSON 给远端，要求返回 arraybuffer 流 (贴纸图片或动图)
   */
  private async renderQuoteRows(quoteData: any, data: any, headers: (Buffer | undefined)[]): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    const scale = 2, shadowPad = 4 * scale;
    const messages = quoteData.messages;
    const profiles: any[] = [];
    let profile: any;
    for (const message of messages) {
      if (!profile || profile.id !== message.from.id || message.avatar) profile = message.from;
      profiles.push({ ...profile, ...message.from, photo: message.from.photo || profile.photo });
    }
    const rows: any[] = new Array(messages.length);
    let next = 0;
    const render = async () => {
      while (next < messages.length) {
        const index = next++, message = messages[index];
        const previousSame = index > 0 && messages[index - 1].from.id === message.from.id;
        const nextSame = index + 1 < messages.length && messages[index + 1].from.id === message.from.id;
        const response = await axios({
          method: "post", url: DEFAULT_API_URL, timeout, responseType: "arraybuffer",
          headers: { "Content-Type": "application/json", "User-Agent": "TeleBox/0.2.1" },
          // 原生 PNG 保留统一字号；不能逐条先缩到 512，再以不同倍率拼接。
          data: { ...data, type: "png", format: "png", scale, messages: [{ ...data.messages[index], avatar: true }] },
        });
        const local = { ...message, avatar: true, from: profiles[index], _quoteGroup: { previousSame, nextSame } };
        let buffer = await expandGlassPadding(Buffer.from(response.data), [headers[index]], [local], false);
        if (nextSame) {
          const meta = await sharp(buffer).metadata();
          buffer = await sharp(buffer).composite([{ input: Buffer.from(`<svg width="${meta.width}" height="${meta.height}"><rect width="${50 * scale}" height="${meta.height}" fill="white"/></svg>`), blend: "dest-out" }]).png().toBuffer();
        } else buffer = await restoreGlassAvatars(buffer, [local]);
        const { data: pixels, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let top = info.height, bottom = -1;
        for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
          if (pixels[(y * info.width + x) * 4 + 3] >= 128) { top = Math.min(top, y); bottom = y; break; }
        }
        if (bottom < top) throw new Error(`第 ${index + 1} 条消息渲染为空`);
        const cropTop = Math.max(0, top - shadowPad), cropBottom = Math.min(info.height, bottom + shadowPad + 1);
        rows[index] = {
          buffer: await sharp(buffer).extract({ left: 0, top: cropTop, width: info.width, height: cropBottom - cropTop }).png().toBuffer(),
          width: info.width, height: cropBottom - cropTop, topPad: top - cropTop, bottomPad: cropBottom - bottom - 1,
        };
      }
    };
    // 最多两个逐条请求同时处理，避免大图一起解码占用过多内存。
    await Promise.all(Array.from({ length: Math.min(2, messages.length) }, () => render()));
    const layers: any[] = [];
    let height = 0;
    for (const [index, row] of rows.entries()) {
      if (index) {
        const same = messages[index - 1].from.id === messages[index].from.id;
        height += (same ? 8 : 14) * scale - rows[index - 1].bottomPad - row.topPad;
      }
      layers.push({ input: row.buffer, left: 0, top: height });
      height += row.height;
    }
    const combined = await sharp({ create: { width: Math.max(394 * scale, ...rows.map(row => row.width)), height, channels: 4, background: "#00000000" } })
      .composite(layers).png().toBuffer();
    return sharp(combined).resize({ width: 512, height: 512, fit: "inside" }).webp({ lossless: true }).toBuffer();
  }

  async generateQuote(quoteData: any): Promise<{ buffer: Buffer; ext: string }> {
    try {
      let url = this.config?.apiUrl;
      // 检查当前配置中是否有自定义地址，没有则使用默认
      if (!url || !url.trim() || url.trim() === MEDIA_API_URL) {
        url = DEFAULT_API_URL;
      }

      let data = quoteData;
      if (url === DEFAULT_API_URL) {
        // glass 把同一人的头像移到末条气泡；为后续气泡补齐发送者资料。
        // name=false 隐藏重复昵称，同时保留无头像时生成首字母所需的名字。
        let groupFrom: any;
        data = {
          ...quoteData,
          messages: quoteData.messages.map((message: any) => {
            if (!groupFrom || groupFrom.id !== message.from.id || message.avatar) {
              groupFrom = message.from;
            }
            const localContent = {
              ...message, senderTag: undefined, senderTagRole: undefined, media: undefined,
              // 即使图片没有配文也保留一个可识别的基础气泡，实际图片稍后本地合成。
              text: quoteBodyText(message),
              replyMessage: message.replyMessage ? {
                ...message.replyMessage,
                media: message.replyMessage.media?.url?.startsWith("data:image/") ? { kind: "story" } : undefined,
              } : undefined,
            };
            if (message.avatar) return {
              ...localContent,
              from: { ...message.from, name: false, first_name: message.from.first_name || message.from.name, photo: undefined },
            };
            return {
              ...localContent,
              from: {
                ...groupFrom,
                ...message.from,
                name: false,
                first_name: groupFrom.first_name || groupFrom.name,
                last_name: groupFrom.last_name,
                photo: undefined,
                username: groupFrom.username,
              },
            };
          }),
        };
      }

      const [response, headers] = await Promise.all([axios({
        method: "post",
        timeout,
        url: url,
        data,
        responseType: "arraybuffer",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "TeleBox/0.2.1",
        },
      }), url === DEFAULT_API_URL ? renderQuoteHeaders(quoteData.messages, quoteData.emojiBrand) : Promise.resolve([])]);

      console.log("quote-api响应状态:", response.status);
      let buffer = Buffer.from(response.data);
      // 新版 API 对很长的语录可能返回 PNG，不能继续按 WebP 尺寸解析。
      if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        const sharp = (await import("sharp")).default;
        buffer = await sharp(buffer).resize({ width: 512, height: 512, fit: "inside" }).webp({ lossless: true }).toBuffer();
      }
      if (url === DEFAULT_API_URL) {
        try {
          buffer = await expandGlassPadding(buffer, headers, quoteData.messages);
          buffer = await restoreGlassAvatars(buffer, quoteData.messages);
        } catch (error) {
          if (!(error instanceof QuoteLayoutError) || quoteData.messages.length < 2) throw error;
          console.warn(`[yvlux] 整图布局异常，改为逐条渲染后合成: ${error.message}`);
          buffer = await this.renderQuoteRows(quoteData, data, headers);
        }
      }
      return { buffer, ext: "webp" };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error(`quote-api请求失败:`, {
          status: error.response?.status,
          statusText: error.response?.statusText,
        });
      } else {
        console.error(`调用quote-api失败: ${error}`);
      }
      throw error;
    }
  }

  // 核心指令注册器
  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    yvlux: async (msg: Api.Message, trigger?: Api.Message) => {
      const start = Date.now();
      const args = msg.message.trim().split(/\s+/);
      const subCmd = args[1]?.toLowerCase();

      let count = 1;
      let pickPositions: number[] | undefined;
      let r = false;
      let valid = false;
      let customText: string | undefined;
      let customName: string | undefined;
      let customTag: string | undefined;

      // ================= 路由控制 =================
      // 1. 配置管理路由
      if (subCmd === "config") {
        await this.handleConfigCommand(msg, args.slice(2));
        return;
      }

      // 2. API 管理路由 (自定义功能合并)
      if (subCmd === "api") {
        await this.handleApiCommand(msg, args.slice(2));
        return;
      }

      // 3. 保存贴纸/图片路由
      if (subCmd === "s") {
        if (args.length !== 2) { await msg.edit({ text: "s 保存模式请单独使用，不与生成选项组合" }); return; }
        await this.handleSaveStickerToSet(msg);
        return;
      }
      if (["help", "h", "?"].includes(subCmd)) {
        await msg.edit({ text: help_text, parseMode: "html" }); return;
      }

      // ================= 语录生成解析 =================
      try {
        const parsed = parseQuoteOptions(msg.message.replace(/^\s*\S+\s*/, ""));
        ({ count, pickPositions, r, customText, customName, customTag } = parsed);
        valid = true;
      } catch (error) {
        await msg.edit({ text: `❌ ${error instanceof Error ? error.message : "选项无效"}` });
        return;
      }

      if (valid) {
        let replied = await msg.getReplyMessage();
        if (!replied) {
          await msg.edit({ text: "请回复一条消息" });
          return;
        }
        await msg.edit({ text: "正在生成语录贴纸..." });

        let sentCount = 0;
        try {
          const client = await getGlobalClient();

          // 分页按实际消息计数，跳过服务消息，并始终排除当前命令。
          const ordered = await fetchQuoteMessages(client, replied, msg.id, count);
          const messages = pickPositions ? selectPickedMessages(ordered, pickPositions) : ordered;

          if (!messages || messages.length === 0) {
            await msg.edit({ text: "未找到消息" });
            return;
          }

          const items = [] as any[];
          const participantCache = new Map<string, Promise<any>>();
          let previousUserIdentifier: string | null = null;
          let firstSenderIdentifier: string | null = null;

          for await (const [i, message] of messages.entries()) {
            // 获取发送者信息
            let sender: any = await message.getSender();

            // 如果无法直接获取发送者（可能是以频道身份发言），尝试从 peerId 找回
            if (!sender) {
              try {
                const peerId = (message as any).peerId || (message as any).fromId;
                if (peerId) sender = await client.getEntity(peerId);
              } catch (e) {
                console.warn("从 peerId 获取发送者失败", e);
              }
            }

            // 检查转发状态，若存在，覆盖发件人信息为原始发件人
            if (message.fwdFrom) {
              let forwardedSender = message.forward?.sender || message.forward?.chat;
              if (!forwardedSender) {
                try { forwardedSender = await message.forward?.getSender(); } catch (error) {}
              }
              if (!forwardedSender) {
                forwardedSender = await resolveForwardSenderFromHeader(message.fwdFrom, client);
              }
              if (!forwardedSender) {
                const fallbackName = "未知来源";
                forwardedSender = {
                  id: hashCode(fallbackName),
                  firstName: fallbackName,
                  lastName: "",
                  title: fallbackName,
                  name: fallbackName,
                };
              }
              sender = forwardedSender;
            }

            if (!sender) {
              await msg.edit({ text: "无法获取消息发送者信息" });
              return;
            }

            // 组装用户元数据
            const userId = (sender as any).id?.toString();
            let name = (sender as any).name || "";
            let firstName = (sender as any).firstName || (sender as any).title || "";
            let lastName = (sender as any).lastName || "";
            const username = (sender as any).username || "";
            const emojiStatus = (sender as any).emojiStatus?.documentId?.toString() || null;

            // 根据前序用户标识决定是否连通气泡（不在气泡旁绘制头像）
            const currentUserIdentifier = userId || hashCode(name || `${firstName}|${lastName}` || `user_${i}`).toString();
            if (i === 0) firstSenderIdentifier = currentUserIdentifier;
            if (customName !== undefined && currentUserIdentifier === firstSenderIdentifier) {
              name = customName; firstName = customName; lastName = "";
            }
            const shouldShowAvatar = currentUserIdentifier !== previousUserIdentifier;
            previousUserIdentifier = currentUserIdentifier;

            // 下载用户头像 (仅需渲染的时候才进行网络请求)
            let photo: { url: string } | undefined = undefined;
            if (shouldShowAvatar) {
              try {
                const buffer = await client.downloadProfilePhoto(sender as any, { isBig: false });
                if (Buffer.isBuffer(buffer) && buffer.length > 0) {
                  const base64 = buffer.toString("base64");
                  photo = { url: `data:image/jpeg;base64,${base64}` };
                }
              } catch (e) {
                console.warn("下载用户头像失败", e);
              }
            }

            // 只修改本次渲染副本，避免 n/t/局部引用影响后续组合或原消息对象。
            let messageText = message.message || "", messageEntities = message.entities || [];
            // ================= 自定义文字覆盖逻辑 (合并项) =================
            // i === 0 意味着这是你刚刚 Reply 对准的那条消息
            if (i === 0) {
              let replyTo = (trigger || msg)?.replyTo;
              if (customText) {
                // 如果传入了自定义文字，强行替换文案并清空原本的排版样式（Entities）
                messageText = customText;
                messageEntities = [];
              } else if (replyTo?.quoteText && message.id === replied.id) {
                // 如果使用了 Telegram 原生部分文字引用功能，覆盖为引用文本
                messageText = replyTo.quoteText;
                messageEntities = replyTo.quoteEntities || [];
              }
            }

            const entities = convertEntities(messageEntities);

            // ================= 回复块(Reply Header)构造逻辑 =================
            let replyBlock: any | undefined;
            let replySource: any;
            if (r) {
              try {
                const replyHeader: any = (message as any).replyTo;
                // 1) 优先尝试提取 quote（局部引用回复）
                if (replyHeader?.quote && replyHeader.quoteText) {
                  let replyName = "unknown";
                  let replyChatId: number | undefined = undefined;
                  try {
                    const repliedMsg = await message.getReplyMessage();
                    if (repliedMsg) {
                      replySource = repliedMsg;
                      const repliedSender = await repliedMsg.getSender();
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const rFirst = (repliedSender as any).firstName || (repliedSender as any).title || "";
                        const rLast = (repliedSender as any).lastName || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || (repliedSender as any).username || "unknown";
                      }
                    }
                  } catch {}

                  const revived = reviveEntities(replyHeader.quoteEntities);
                  const replyEntities = convertEntities(revived || []);

                  replyBlock = {
                    name: replyName,
                    text: replyHeader.quoteText,
                    entities: replyEntities,
                    ...(replyChatId ? { chatId: replyChatId } : {}),
                  };
                } 
                // 2) 如果是标准的全局回复
                else if ((message as any).isReply || replyHeader?.replyToMsgId) {
                  try {
                    const repliedMsg = await message.getReplyMessage();
                    if (repliedMsg) {
                      replySource = repliedMsg;
                      const repliedSender = await repliedMsg.getSender();
                      let replyName = "unknown";
                      let replyChatId: number | undefined;
                      if (repliedSender) {
                        replyChatId = Number(repliedSender.id);
                        const rFirst = (repliedSender as any).firstName || (repliedSender as any).title || "";
                        const rLast = (repliedSender as any).lastName || "";
                        const composed = `${rFirst} ${rLast}`.trim();
                        replyName = composed || (repliedSender as any).username || "unknown";
                      }

                      const replyText = repliedMsg.message || "";
                      const replyEntities = convertEntities(repliedMsg.entities || []);

                      if (replyText || repliedMsg.media) {
                        replyBlock = {
                          name: replyName,
                          text: replyText,
                          entities: replyEntities,
                          ...(replyChatId ? { chatId: replyChatId } : {}),
                        };
                      }
                    }
                  } catch {}
                }
              } catch (e) {
                console.warn("处理回复引用失败: ", e);
              }
              if (replySource?.media) {
                const preview = await getQuoteMediaPreview(replySource);
                if (preview && replyBlock) replyBlock = { ...replyBlock, text: replyBlock.text || "图片", media: preview };
              }
            }

            // 文本和媒体共用本地玻璃合成；下载失败直接报告，不静默漏掉图片。
            const media = await getQuoteMediaPreview(message);

            items.push({
              ...(shouldShowAvatar ? customTag !== undefined && currentUserIdentifier === firstSenderIdentifier
                ? { senderTag: customTag, senderTagRole: "member" }
                : await getQuoteSenderTag(message, sender, client, participantCache) : {}),
              from: {
                id: userId ? parseInt(userId) : hashCode(sender.name || `${firstName}|${lastName}`),
                name: shouldShowAvatar ? name : "",
                first_name: shouldShowAvatar ? firstName || undefined : undefined,
                last_name: shouldShowAvatar ? lastName || undefined : undefined,
                username: photo && shouldShowAvatar ? username || undefined : undefined,
                photo,
                emoji_status: shouldShowAvatar ? emojiStatus || undefined : undefined,
                // 保留 Telegram 的昵称强调色，不把所有人的昵称强制改成同一种颜色。
                accentColorId: (sender as any).color?.color,
              },
              text: messageText,
              entities: entities,
              avatar: shouldShowAvatar,
              media,
              ...(replyBlock ? { replyMessage: replyBlock } : {}),
            });
          }

          const batches = splitQuoteMessages(items);
          for (const [batchIndex, batch] of batches.entries()) {
            if (batches.length > 1) await msg.edit({ text: `正在生成语录 ${batchIndex + 1}/${batches.length}（已发送 ${sentCount} 张）...` });
            // 核心网络请求数据装配
            const quoteData = {
              type: "quote",
              format: "webp", // 强行指定后端生成 webp（包含 webm 帧容器）
              ...QUOTE_APPEARANCE,
              width: 512,
              height: 768,
              scale: 2,
              emojiBrand: "apple", // Emoji 样式设为苹果风
              messages: batch,
            };

            const quoteResult = await this.generateQuote(quoteData);
            const imageBuffer = quoteResult.buffer;
            const imageExt = quoteResult.ext;

            if (!imageBuffer || imageBuffer.length === 0) {
              await msg.edit({ text: "生成的图片数据为空" });
              return;
            }

            console.log(`[yvlu] API返回: buffer长度=${imageBuffer?.length}, ext=${imageExt}`);

            try {
              // 解析生成好的 WebP 文件，计算其尺寸以及确认它是否为动态图片(webm/webp animated)
              const dimensions = getWebPDimensions(imageBuffer);
              const isWebm = isWebmFormat(imageBuffer);
              const isAnimated = isAnimatedWebP(imageBuffer);

              console.log(`检测到的图片尺寸: ${dimensions.width}x${dimensions.height}, 格式: ${isWebm ? "webm" : "webp"}, 动态: ${isWebm || isAnimated}`);

              // 【BUG 修复】：摒弃 CustomFile，无论动态静态，统一使用操作系统临时文件路径传递，底层 fs 流能完美解析
              const os = await import("os");
              const tmpDir = os.tmpdir();
              const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

              if (isWebm) {
                const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`);

                try {
                  fs.writeFileSync(webmPath, imageBuffer);
                  // 必须走文件路径上传，Telegram Client 针对 WebM 贴纸有特殊的二进制封装要求
                  await client.sendFile(msg.peerId, {
                    file: webmPath,
                    attributes: [
                      new Api.DocumentAttributeSticker({
                        alt: "📝",
                        stickerset: new Api.InputStickerSetEmpty(),
                      }),
                    ],
                    replyTo: replied?.id,
                  });
                  console.log("[yvlu] 动态贴纸发送成功 (webm)");
                } finally {
                  try { fs.unlinkSync(webmPath); } catch (e) {}
                }
              } else {
                const staticPath = path.join(tmpDir, `sticker_${uniqueId}.${imageExt}`);
              
                try {
                  fs.writeFileSync(staticPath, imageBuffer);

                  const stickerAttr = new Api.DocumentAttributeSticker({
                    alt: "📝",
                    stickerset: new Api.InputStickerSetEmpty(),
                  });
                  const imageSizeAttr = new Api.DocumentAttributeImageSize({
                    w: dimensions.width,
                    h: dimensions.height,
                  });
                  const filenameAttr = new Api.DocumentAttributeFilename({
                    fileName: `sticker.${imageExt}`,
                  });

                  await client.sendFile(msg.peerId, {
                    file: staticPath, // 直接传入 String 文件路径
                    forceDocument: false,
                    attributes: [stickerAttr, imageSizeAttr, filenameAttr],
                    replyTo: replied?.id,
                  });

                  console.log("[yvlu] 静态贴纸发送成功");
                } finally {
                  try { fs.unlinkSync(staticPath); } catch (e) {}
                }
              }
            } catch (fileError) {
              console.error(`发送文件失败: ${fileError}`);
              await msg.edit({ text: `第 ${batchIndex + 1} 张发送失败（已发送 ${sentCount} 张）: ${fileError}` });
              return;
            }
            sentCount++;
          }

          // 生成和发送完成：显式 revoke，确保命令对所有聊天成员撤回。
          await msg.delete({ revoke: true });

          const end = Date.now();
          console.log(`语录生成耗时: ${end - start}ms`);
        } catch (error) {
          console.error(`语录生成失败: ${error}`);
          await msg.edit({ text: `语录生成失败${sentCount ? `（已发送 ${sentCount} 张）` : ""}: ${error}` });
        }
      } else {
        // 命令无法匹配任何规则时，弹出使用帮助菜单
        await msg.edit({ text: help_text, parseMode: "html" });
      }
    },
  };

  /**
   * 知识点：处理配置贴纸包命令 (config)
   */
  async handleConfigCommand(msg: Api.Message, args: string[]) {
    try {
      await this.loadConfig();

      if (args.length === 0) {
        const configInfo = `
<b>📋 当前配置:</b>

<b>贴纸包名称:</b> <code>${this.config?.stickerSetShortName || "(未设置)"}</code>
${this.config?.stickerSetShortName ? `<b>贴纸包链接:</b> t.me/addstickers/${this.config.stickerSetShortName}` : ""}

<b>API URL:</b> <code>${this.config?.apiUrl || "默认"}</code>

<b>配置文件路径:</b>
<code>${this.configPath}</code>

<b>可用配置命令:</b>
<code>${commandName} config sticker 贴纸包名称</code> - 设置贴纸包名称
<code>${commandName} api [URL]</code> - 设置 API
`;
        await msg.edit({ text: configInfo, parseMode: "html" });
        return;
      }

      const subCommand = args[0].toLowerCase();

      switch (subCommand) {
        case "sticker":
        case "stickerset":
        case "set": {
          const newName = args.slice(1).join("_");

          if (!newName) {
            await msg.edit({ text: `❌ 请提供贴纸包名称\n用法: <code>${commandName} config sticker 贴纸包名称</code>`, parseMode: "html" });
            return;
          }

          // Telegram ShortName 规范检测
          if (!/^[a-zA-Z0-9_]+$/.test(newName)) {
            await msg.edit({ text: "❌ 贴纸包名称只能包含字母、数字和下划线", parseMode: "html" });
            return;
          }

          if (newName.length < 1 || newName.length > 64) {
            await msg.edit({ text: "❌ 贴纸包名称长度应在 1-64 个字符之间", parseMode: "html" });
            return;
          }

          this.config!.stickerSetShortName = newName;
          await this.saveConfig(); // 持久化更新
          
          await msg.edit({ text: `✅ 贴纸包名称已设置为: <code>${newName}</code>\n贴纸包链接: t.me/addstickers/${newName}`, parseMode: "html" });
          break;
        }

        default:
          await msg.edit({
            text: `❌ 未知的配置项: <code>${subCommand}</code>\n\n可用配置命令:\n<code>${commandName} config sticker 贴纸包名称</code> - 设置贴纸包名称`,
            parseMode: "html",
          });
      }
    } catch (error: any) {
      console.error("处理配置命令失败:", error);
      await msg.edit({ text: `❌ 配置操作失败: ${error.message || error}` });
    }
  }

  /**
   * 知识点：处理修改后台 API 请求地址的指令 (api)
   * 包含了容错机制如补全 https 前缀，规范化后缀路由 (/generate.webp)
   */
  async handleApiCommand(msg: Api.Message, args: string[]) {
    try {
      if (args.length > 1) throw new Error("API 设置请单独使用，只提供一个 URL 或 reset");
      await this.loadConfig();
      const sub = args[0];

      if (!sub) {
        await msg.edit({ text: `当前 API: <code>${this.config?.apiUrl || "默认"}</code>\n使用 <code>${commandName} api reset</code> 恢复默认。`, parseMode: "html" });
      } else if (sub.toLowerCase() === "reset") {
        this.config!.apiUrl = "";
        await this.saveConfig();
        await msg.edit({ text: "✅ API 已重置为默认值。" });
      } else {
        let url = sub;
        if (!url.startsWith("http")) url = "https://" + url;
        // 如果给出的地址缺少标准后缀，强制为其补全
        if (!url.includes("/generate")) url = url.replace(/\/$/, "") + "/generate.webp";
        
        this.config!.apiUrl = url;
        await this.saveConfig();
        await msg.edit({ text: `✅ API 已更新设为: \n<code>${url}</code>`, parseMode: "html" });
      }
    } catch (error: any) {
      console.error("处理 API 设置失败:", error);
      await msg.edit({ text: `❌ 操作失败: ${error.message || error}` });
    }
  }

  /**
   * 知识点：捕获用户对某张图片/贴纸的回复并将其吸纳进自己预设的贴纸包中
   */
  async handleSaveStickerToSet(msg: Api.Message) {
    try {
      await this.loadConfig();

      if (!this.config || !this.config.stickerSetShortName || this.config.stickerSetShortName.trim() === "") {
        await msg.edit({ text: `❌ 未配置贴纸包!\n请执行指令: <code>${commandName} config sticker &lt;贴纸包简称&gt;</code> 进行设置。`, parseMode: "html" });
        return;
      }

      const replied = await msg.getReplyMessage();
      if (!replied) {
        await msg.edit({ text: "❌ 请回复一张贴纸或图片" });
        return;
      }

      if (!replied.media) {
        await msg.edit({ text: "❌ 回复的消息不包含媒体素材" });
        return;
      }

      const client = await getGlobalClient();

      let isSticker = false;
      let isPhoto = false;
      let documentToAdd: Api.InputDocument | null = null;

      // 解析 Telegram 内部的文件数据结构
      if (replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any;
        if (doc && doc.attributes) {
          isSticker = doc.attributes.some((a: any) => a instanceof Api.DocumentAttributeSticker);
        }
        if (isSticker && doc.id && doc.accessHash) {
          documentToAdd = new Api.InputDocument({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          });
        }
      } else if (replied.media instanceof Api.MessageMediaPhoto) {
        isPhoto = true;
      }

      if (!isSticker && !isPhoto) {
        await msg.edit({ text: "❌ 不支持的媒体类型,请回复贴纸或图片" });
        return;
      }

      // 验证云端是否存在该贴纸包
      let stickerSetExists = false;
      try {
        const stickerSet = await client.invoke(
          new Api.messages.GetStickerSet({
            stickerset: new Api.InputStickerSetShortName({
              shortName: this.config.stickerSetShortName,
            }),
            hash: 0,
          })
        );
        stickerSetExists = stickerSet instanceof Api.messages.StickerSet;
      } catch (error: any) {
        if (error.errorMessage === "STICKERSET_INVALID") {
          stickerSetExists = false;
        } else {
          throw error;
        }
      }

      // 若未创建过，触发底层的贴纸包创建协议
      if (!stickerSetExists) {
        await this.createStickerSet(client, msg, replied, isSticker, isPhoto);
        return;
      }

      // 对现有的包执行 AddStickerToSet 追加动作
      if (isSticker && documentToAdd) {
        try {
          await client.invoke(
            new Api.stickers.AddStickerToSet({
              stickerset: new Api.InputStickerSetShortName({
                shortName: this.config.stickerSetShortName,
              }),
              sticker: new Api.InputStickerSetItem({
                document: documentToAdd,
                emoji: "📝", // 默认 Emoji 映射
              }),
            })
          );
          await msg.edit({ text: `✅ 已成功添加到贴纸包!\n传送门: t.me/addstickers/${this.config.stickerSetShortName}` });
        } catch (error: any) {
          console.error("添加贴纸失败:", error);
          await msg.edit({ text: `❌ 添加贴纸失败: ${error.message || error}` });
        }
        return;
      }

      // 如果是对静态相片进行操作，需要先把图片作为文件重新走一次上传通道
      if (isPhoto) {
        try {
          const buffer = await replied.downloadMedia();
          if (!Buffer.isBuffer(buffer)) {
            await msg.edit({ text: "❌ 图片流提取失败" });
            return;
          }

          const document = await uploadQuoteStickerImage(client, buffer);

          await client.invoke(
            new Api.stickers.AddStickerToSet({
              stickerset: new Api.InputStickerSetShortName({
                shortName: this.config.stickerSetShortName,
              }),
              sticker: new Api.InputStickerSetItem({
                document,
                emoji: "📝",
              }),
            })
          );

          await msg.edit({ text: `✅ 图像已成功上链贴纸包!\n传送门: t.me/addstickers/${this.config.stickerSetShortName}` });
        } catch (error: any) {
          console.error("处理图片上链失败:", error);
          await msg.edit({ text: `❌ 图片转换上链失败: ${error.message || error}` });
        }
        return;
      }
    } catch (error: any) {
      console.error("保存贴纸异常:", error);
      await msg.edit({ text: `❌ 操作中止: ${error.message || error}` });
    }
  }

  /**
   * 知识点：创建全新的属于当前机器人的/用户的 Telegram 贴纸包
   */
  async createStickerSet(client: any, msg: Api.Message, replied: Api.Message, isSticker: boolean, isPhoto: boolean) {
    try {
      let firstSticker: any = null;

      if (isSticker && replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any;
        if (doc && doc.id && doc.accessHash) {
          firstSticker = new Api.InputDocument({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([]),
          });
        }
      } else if (isPhoto) {
        const buffer = await replied.downloadMedia();
        if (!Buffer.isBuffer(buffer)) {
          await msg.edit({ text: "❌ 首帧源文件下载破损" });
          return;
        }

        firstSticker = await uploadQuoteStickerImage(client, buffer);
      }

      if (!firstSticker) {
        await msg.edit({ text: "❌ 无法装配封面的数据矩阵" });
        return;
      }

      const me = await client.getMe();

      // 发起协议级的创建动作 (CreateStickerSet)
      await client.invoke(
        new Api.stickers.CreateStickerSet({
          userId: me,
          title: `${this.config!.stickerSetShortName}`,
          shortName: this.config!.stickerSetShortName,
          animated: isSticker && (replied.media as any)?.document?.mimeType === "application/x-tgsticker" || undefined,
          videos: isSticker && (replied.media as any)?.document?.mimeType === "video/webm" || undefined,
          stickers: [
            new Api.InputStickerSetItem({
              document: firstSticker,
              emoji: "📝",
            }),
          ],
        })
      );

      await msg.edit({ text: `✅ 贴纸集合创建竣工，并已录入首图!\n传送门: t.me/addstickers/${this.config!.stickerSetShortName}` });
    } catch (error: any) {
      console.error("生成贴纸包骨架失败:", error);
      await msg.edit({ text: `❌ 核心结构创立失败: ${error.message || error}` });
    }
  }
}

// 导出单例类的实例，供插件注册机抓取
export default new YvluPlugin();
