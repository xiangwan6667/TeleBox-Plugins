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
const source = fs.readFileSync(path.join(__dirname, '../plugins/aix.ts'), 'utf8');
// Exercise the real image command without starting the plugin's database/client.
const compiled = ts.transpileModule(source.replace(
  'export default new AIXPlugin();',
  'export { ImageFeature, MessageUtils };',
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
exportsObj.MessageUtils.prototype.sendImages = async (_msg, images, caption, replyToId) => {
  sent = {images, caption, replyToId};
};

async function run(args, options = {}) {
  sent = undefined;
  const avatars = new Map([[11, options.replyAvatar], [22, options.senderAvatar]]);
  const downloads = [], mediaDownloads = [], edits = [], optimizations = [];
  let textGenerations = 0, releases = 0;
  const status = {delete: async () => {}};
  const attached = options.attached || [];
  const client = {
    downloadProfilePhoto: async id => {
      downloads.push(id);
      return avatars.get(Number(id));
    },
    downloadMedia: async msg => {
      mediaDownloads.push(msg.id);
      return msg.testImage;
    },
    sendMessage: async () => status,
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
  };
  const controller = new AbortController();
  const token = {
    signal: controller.signal, aborted: false,
    abort: reason => {throw new Error(reason);}, throwIfAborted() {},
  };
  const ai = {
    createAbortToken: () => token,
    releaseToken: () => releases++,
    callAI: async (prompt, images) => {
      optimizations.push({prompt, images});
      return {text: '两位角色一起喝茶', images: []};
    },
    editImage: async (prompt, image) => {
      edits.push({prompt, image});
      if (options.failFirstEdit && edits.length === 1) throw new Error('test edit failure');
      if (options.failAllEdits) throw new Error('test edit failure');
      return [{data: options.replyAvatar, mimeType: 'image/png'}];
    },
    generateImage: async () => {textGenerations++; return [];},
  };
  const feature = new exportsObj.ImageFeature(ai, Promise.resolve({getConfig: () => config}), {});
  let error;
  try {await feature.execute(msg, args, ['.']);} catch (e) {error = e;}
  return {error, downloads, mediaDownloads, edits, optimizations, sent, textGenerations, releases};
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
  assert.equal(result.optimizations.length, 2);
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
  assert.ok(result.downloads.every(id => id === 11), 'single-avatar mode still uses reply sender');
  assert.equal((await sharp(result.edits[0].image.data).metadata()).width, 512);
  result = await run(['image', '一起喝茶'], options);
  assert.ifError(result.error);
  assert.equal(result.downloads.length, 0, 'ordinary image mode does not fetch avatars');
  assert.equal(result.mediaDownloads[0], 10);
  console.log('aix: dual-avatar command, reference order, optimization, counts, fallback, errors and existing modes passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
