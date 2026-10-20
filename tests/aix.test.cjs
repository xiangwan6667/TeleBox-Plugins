const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const dependencies = process.env.AIX_TEST_DEPS
  ? createRequire(path.resolve(process.env.AIX_TEST_DEPS, 'package.json'))
  : require;
const ts = dependencies('typescript');
const sharp = dependencies('sharp');
const tempRoot = path.resolve(require('node:os').tmpdir());
const runtimeDir = fs.mkdtempSync(path.join(tempRoot, 'telebox-aix-tests-'));
const source = fs.readFileSync(path.join(__dirname, '../plugins/aix.ts'), 'utf8');
// Exercise the real image command without starting the plugin's database/client.
const compiled = ts.transpileModule(source.replace(
  'export default new AIXPlugin();',
  'export { ImageFeature, MessageUtils, getMessageImageParts, getGroupedMessageIds, runAbortable, createAbortToken };',
), {
  fileName: 'aix.ts', reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
});
assert.equal(compiled.diagnostics.length, 0, 'TypeScript syntax');
const classes = new Map();
const Api = new Proxy({}, {get(_, key) {
  if (!classes.has(key)) classes.set(key, class {constructor(args) {Object.assign(this, args);}});
  return classes.get(key);
}});
const exportsObj = {};
vm.runInNewContext(compiled.outputText, {
  require: name => {
    if (name === 'sharp') return sharp;
    if (name === 'teleproto') return {Api};
    if (name === '@utils/pluginBase') return {Plugin: class {}};
    if (name === '@utils/pluginManager') return {getPrefixes: () => ['.']};
    if (name === '@utils/pathHelpers') return {createDirectoryInAssets: () => runtimeDir};
    if (name === '@utils/safeGetMessages') return {safeGetReplyMessage: msg => msg.getReplyMessage()};
    if (name.startsWith('@utils/') || name === 'axios' || name === 'lowdb/node') return {};
    return require(name);
  },
  exports: exportsObj, Buffer, AbortController, console,
  // Skip status-display pauses. Keep request timeouts real and non-blocking.
  setTimeout: (fn, ms, ...args) => {
    const timer = setTimeout(fn, ms >= 12000 ? ms : 0, ...args);
    if (ms >= 12000) timer.unref();
    return timer;
  },
  clearTimeout,
});

let sent;
const realSendImages = exportsObj.MessageUtils.prototype.sendImages;
exportsObj.MessageUtils.prototype.sendImages = async function (_msg, images, caption, replyToId, token) {
  token?.throwIfAborted();
  sent = {images, caption, replyToId, token};
  if (_msg.testRealDelivery) await realSendImages.call(this, _msg, images, caption, replyToId, token);
};

async function run(args, options = {}) {
  sent = undefined;
  const avatars = new Map([[11, options.replyAvatar], [22, options.senderAvatar]]);
  const downloads = [], mediaDownloads = [], edits = [], optimizations = [], statuses = [], tokens = [], fileUploads = [];
  let textGenerations = 0, releases = 0;
  const status = {delete: async () => {}};
  const attached = options.attached || [];
  const client = {
    downloadProfilePhoto: async id => {
      downloads.push(id);
      if (options.cancelDuringAvatar) {
        queueMicrotask(() => tokens[0].abort('__AIX_SILENT_CANCEL__'));
        return new Promise(() => {});
      }
      if (options.timeoutDuringAvatar) {
        queueMicrotask(() => tokens[0].abort('素材读取超时'));
        return new Promise(() => {});
      }
      return avatars.get(Number(id));
    },
    downloadMedia: async msg => {
      mediaDownloads.push(msg.id);
      if (options.cancelDuringMedia) {
        queueMicrotask(() => tokens[0].abort('__AIX_SILENT_CANCEL__'));
        return new Promise(() => {});
      }
      return msg.testImage;
    },
    sendMessage: async (_, {message}) => {
      const state = {message, deleted: false, delete: async () => {state.deleted = true;}};
      statuses.push(state);
      return state;
    },
    sendFile: async (_, options) => {
      const files = Array.isArray(options.file) ? options.file : [options.file];
      fileUploads.push({...options, bytes: files.map(file => fs.readFileSync(file))});
    },
    deleteMessages: async () => {},
    async *iterMessages() {yield* attached;},
  };
  const reply = new Api.Message({
    id: 10, senderId: 11, peerId: 1, client,
    // The replied-to photo must not replace either avatar in aa mode.
    media: new Api.MessageMediaPhoto({}), testImage: options.extraImage,
  });
  const msg = new Api.Message({
    id: 20, senderId: 22, peerId: 1, client,
    getReplyMessage: async () => options.noReply ? undefined : reply,
    testRealDelivery: !!options.realDelivery,
    edit: async () => status, delete: async () => {},
  });
  if (attached.length) {
    msg.groupedId = 100;
    for (const item of attached) Object.assign(item, {groupedId: 100, client, peerId: 1});
  }
  const config = {
    currentImageTag: 'test', currentImageModel: 'test-image',
    currentChatTag: 'test', currentChatModel: 'test-chat', configs: {test: {}},
    promptOptimize: !!options.optimize, timeout: 30, imagePromptRules: {},
    imagePreview: true, collapse: false,
  };
  const ai = {
    createAbortToken: () => {const token = exportsObj.createAbortToken(); tokens.push(token); return token;},
    releaseToken: () => releases++,
    callAI: async (prompt, images) => {
      optimizations.push({prompt, images});
      if (options.optimizedText !== undefined) return {text: options.optimizedText, images: []};
      const count = args.includes('2') ? 2 : args.includes('3') ? 3 : 1;
      if (count > 1) return {text: JSON.stringify(Array.from({length: count}, (_, i) => `两位角色一起喝茶，第${i + 1}张展示不同动作`)), images: []};
      return {text: '两位角色一起喝茶', images: []};
    },
    editImage: async (prompt, image) => {
      edits.push({prompt, image});
      if (options.optimize && edits.length === 1) {
        assert.ok(statuses.some(item => /提示词已优化|已使用原提示词/.test(item.message) && !item.deleted),
          'image generation begins while the optimization notice is still visible');
      }
      if (edits.length === 2 && (options.abortOnSecondEdit || options.cancelOnSecondEdit)) {
        tokens[0].abort(options.cancelOnSecondEdit ? '__AIX_SILENT_CANCEL__' : '请求超时');
        throw new Error('timeout');
      }
      if (options.failSecondImage && /第 2\//.test(prompt)) throw new Error('second image failed');
      if (options.failFirstEdit && edits.length === 1) throw new Error('test edit failure');
      if (options.failAllEdits) throw new Error('test edit failure');
      return [{data: options.replyAvatar || options.extraImage, mimeType: 'image/png'}];
    },
    generateImage: async () => {
      textGenerations++;
      return options.textImage ? [{data: options.extraImage, mimeType: 'image/png'}] : [];
    },
  };
  const feature = new exportsObj.ImageFeature(ai, Promise.resolve({getConfig: () => config}), {});
  let error;
  try {await feature.execute(msg, args, ['.']);} catch (e) {error = e;}
  return {error, downloads, mediaDownloads, edits, optimizations, statuses, tokens, fileUploads, sent, textGenerations, releases};
}

async function assertAvatarOrder(image) {
  const {data, info} = await sharp(image.data).removeAlpha().raw().toBuffer({resolveWithObject: true});
  // The actual merged reference must contain the red reply avatar on the left,
  // and the blue command-sender avatar on the right, below their labels.
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  assert.deepEqual(pixel(280, 326), [255, 0, 0]);
  assert.deepEqual(pixel(816, 326), [0, 0, 255]);
}

(async () => {
  const solid = color => sharp({create: {width: 512, height: 512, channels: 3, background: color}}).png().toBuffer();
  const replyAvatar = await solid('#ff0000');
  const senderAvatar = await solid('#0000ff');
  const extraImage = await solid('#00ff00');
  const options = {replyAvatar, senderAvatar, extraImage};
  let result = await run(['image', 'aa', '一起喝茶'], options);
  assert.ifError(result.error);
  assert.deepEqual(result.downloads, [11, 22]);
  assert.deepEqual(result.mediaDownloads, [], 'ignore media on the replied-to message');
  assert.equal(result.edits.length, 1);
  assert.match(result.edits[0].prompt, /IMAGE A.*被回复者.*IMAGE B.*发送/);
  assert.doesNotMatch(result.edits[0].prompt, /\baa\b/, 'mode token is consumed');
  await assertAvatarOrder(result.edits[0].image);
  assert.equal(result.sent.replyToId, 10);
  assert.equal(result.releases, 1);

  result = await run(['image', 'aa', '2', '一起喝茶'], {...options, optimize: true});
  assert.ifError(result.error);
  assert.equal(result.optimizations.length, 1, 'optimize the whole batch in a single request');
  assert.equal(result.edits.length, 2);
  assert.equal(result.sent.images.length, 2);
  for (const request of result.optimizations) {
    assert.match(request.prompt, /IMAGE A.*被回复者.*IMAGE B.*发送/);
    assert.equal(request.images[0].image_url.url.split(',')[1], replyAvatar.toString('base64'));
    assert.equal(request.images[1].image_url.url.split(',')[1], senderAvatar.toString('base64'));
  }
  for (const edit of result.edits) {
    assert.match(edit.prompt, /IMAGE A.*被回复者.*IMAGE B.*发送/);
    await assertAvatarOrder(edit.image);
  }

  result = await run(['image', 'aa', '一起喝茶'], {...options, optimize: true, failFirstEdit: true});
  assert.ifError(result.error);
  assert.equal(result.edits.length, 2, 'retry with original prompt');
  assert.equal(result.edits[0].image, result.edits[1].image, 'reuse the prepared reference on fallback');
  assert.match(result.edits[1].prompt, /一起喝茶/);
  await assertAvatarOrder(result.edits[1].image);
  assert.match(result.edits[1].prompt, /IMAGE A.*被回复者.*IMAGE B.*发送/);

  for (const [missing, expected] of [['noReply', /需要回复/], ['replyAvatar', /被回复者的头像/], ['senderAvatar', /命令发送者的头像/]]) {
    result = await run(['image', 'aa', '一起喝茶'], {...options, [missing]: missing === 'noReply' ? true : undefined});
    assert.match(result.error?.message || '', expected);
    assert.equal(result.edits.length, 0);
    assert.equal(result.sent, undefined);
  }

  const album = count => Array.from({length: count}, (_, i) => new Api.Message({
    id: 20 + i, media: new Api.MessageMediaPhoto({}), testImage: extraImage,
  }));
  result = await run(['image', 'aa', '一起喝茶'], {...options, attached: album(4)});
  assert.ifError(result.error);
  assert.equal(result.mediaDownloads.length, 4);
  await assertAvatarOrder(result.edits[0].image);
  result = await run(['image', 'aa', '一起喝茶'], {...options, attached: album(5)});
  assert.match(result.error?.message || '', /最多支持6张/);
  assert.equal(result.edits.length, 0);

  result = await run(['image', 'aa', '一起喝茶'], {...options, failAllEdits: true});
  assert.match(result.error?.message || '', /test edit failure/);
  assert.equal(result.textGenerations, 0, 'never drop avatar references on failure');

  result = await run(['image', 'a', '一起喝茶'], options);
  assert.ifError(result.error);
  assert.deepEqual(result.downloads, [11], 'single-avatar mode fetches the reply avatar only once');
  assert.deepEqual(result.mediaDownloads, [], 'do not download discarded reply media');
  assert.equal((await sharp(result.edits[0].image.data).metadata()).width, 512);
  result = await run(['image', '一起喝茶'], options);
  assert.ifError(result.error);
  assert.equal(result.downloads.length, 0, 'ordinary image mode does not fetch avatars');
  assert.equal(result.mediaDownloads[0], 10);

  result = await run(['image', '2', '星空'], {...options, noReply: true, textImage: true, optimize: true, realDelivery: true});
  assert.ifError(result.error);
  assert.equal(result.optimizations.length, 1);
  assert.equal(result.textGenerations, 2, 'text-to-image still generates the requested count');
  assert.equal(result.edits.length, 0);
  assert.equal(result.fileUploads.length, 1, 'completed images retain album delivery');
  assert.equal(result.fileUploads[0].bytes.length, 2);
  assert.equal(result.sent.replyToId, undefined);

  result = await run(['image', 'aa', '3', '一起喝茶'], {...options, abortOnSecondEdit: true, realDelivery: true});
  assert.ifError(result.error);
  assert.equal(result.edits.length, 2, 'stop generating immediately on task timeout');
  assert.equal(result.sent.images.length, 1, 'deliver the image completed before timeout');
  assert.notEqual(result.sent.token, result.tokens[0], 'delivery uses an uncancelled token');
  assert.equal(result.releases, 2);
  assert.equal(result.fileUploads.length, 1, 'the real media sender uploads partial results after timeout');
  assert.deepEqual(result.fileUploads[0].bytes[0], replyAvatar);
  assert.ok(result.statuses.some(item => /1\/3.*|后续生成超时/.test(item.message)));
  result = await run(['image', 'aa', '3', '一起喝茶'], {...options, cancelOnSecondEdit: true});
  assert.match(result.error?.message || '', /__AIX_SILENT_CANCEL__/);
  assert.equal(result.sent, undefined, 'explicit cancellation does not start new delivery');
  assert.equal(result.tokens.length, 1);

  result = await run(['image', 'aa', '2', '一起喝茶'], {...options, failSecondImage: true});
  assert.ifError(result.error);
  assert.equal(result.sent.images.length, 1);
  assert.ok(!result.sent.caption.includes('2.'), 'captions only describe completed images');

  for (const invalid of ['not json', '["重复", "重复"]', '["仅一条"]', '["", "非空"]', '[1, 2]']) {
    result = await run(['image', 'aa', '2', '一起喝茶'], {...options, optimize: true, optimizedText: invalid});
    assert.ifError(result.error);
    assert.equal(result.optimizations.length, 1, 'invalid batches never trigger N new chat requests');
    assert.equal(result.sent.images.length, 2);
    assert.match(result.edits[0].prompt, /一起喝茶/);
    assert.notEqual(result.edits[0].prompt, result.edits[1].prompt);
    assert.ok(result.statuses.some(item => /已使用原提示词/.test(item.message)));
  }

  result = await run(['image', 'a', '一起喝茶'], {...options, failAllEdits: true});
  assert.match(result.error?.message || '', /test edit failure/);
  assert.equal(result.textGenerations, 0, 'single-avatar failures must retain references too');
  result = await run(['image', 'a', '一起喝茶'], {...options, replyAvatar: undefined});
  assert.ifError(result.error);
  assert.deepEqual(result.mediaDownloads, [10], 'only read reply media when avatar is missing');

  for (const flag of ['cancelDuringAvatar', 'timeoutDuringAvatar', 'cancelDuringMedia']) {
    result = await run(['image', 'aa', '一起喝茶'], {
      ...options, [flag]: true, ...(flag === 'cancelDuringMedia' ? {attached: album(1)} : {}),
    });
    assert.match(result.error?.message || '', /__AIX_SILENT_CANCEL__|素材读取超时/);
    assert.equal(result.edits.length, 0);
    assert.equal(result.releases, 1, 'release tokens on preparation failure');
  }

  let historyOptions;
  const old = new Api.Message({id: 500, groupedId: 77, peerId: 1,
    media: new Api.MessageMediaPhoto({}), testImage: replyAvatar});
  const sibling = new Api.Message({id: 501, groupedId: 77, peerId: 1,
    media: new Api.MessageMediaPhoto({}), testImage: senderAvatar});
  const unrelated = new Api.Message({id: 502, groupedId: 78, peerId: 1,
    media: new Api.MessageMediaPhoto({}), testImage: extraImage});
  old.client = {
    async *iterMessages(_, request) {historyOptions = request; yield sibling; yield unrelated;},
    downloadMedia: async item => item.testImage,
  };
  sibling.client = old.client;
  const oldParts = await exportsObj.getMessageImageParts(old);
  assert.equal(oldParts.length, 2, 'keep the reply and find its neighboring album image');
  assert.equal(oldParts[0].image_url.url.split(',')[1], replyAvatar.toString('base64'));
  assert.equal(oldParts[1].image_url.url.split(',')[1], senderAvatar.toString('base64'));
  assert.equal(historyOptions.offsetId, 501, 'history is anchored to the reply instead of latest messages');
  assert.ok(historyOptions.addOffset < 0, 'include album messages after the reply');
  assert.deepEqual(Array.from(await exportsObj.getGroupedMessageIds(old)), [500, 501]);
  old.client.iterMessages = async function* () {throw new Error('history unavailable');};
  assert.equal((await exportsObj.getMessageImageParts(old)).length, 1, 'keep the reply on history failure');

  const cancelled = exportsObj.createAbortToken();
  cancelled.abort('stop');
  let started = false;
  await assert.rejects(exportsObj.runAbortable(async () => {started = true;}, cancelled), /stop/);
  assert.equal(started, false, 'do not start RPCs after cancellation');
  await assert.rejects(exportsObj.runAbortable(() => new Promise(() => {}), undefined, 5), /素材读取超时/);
  console.log('aix: reference modes, old albums, batched optimization, immediate generation, timeout delivery, cancellation and retries passed');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => {
  assert.equal(path.dirname(path.resolve(runtimeDir)), tempRoot);
  assert.ok(path.basename(runtimeDir).startsWith('telebox-aix-tests-'));
  fs.rmSync(runtimeDir, {recursive: true, force: true});
});
