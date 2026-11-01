const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const dependencies = process.env.TELEBOX_TEST_DEPS
  ? createRequire(path.resolve(process.env.TELEBOX_TEST_DEPS, 'package.json')) : require;
const ts = dependencies('typescript');
const classes = new Map();
function apiClass(name) {
  if (!classes.has(name)) classes.set(name, class {
    constructor(args = {}) { Object.assign(this, args); this.className = name; }
  });
  return classes.get(name);
}
const Api = new Proxy({}, {get(_target, key) {
  if (key === 'messages') return new Proxy({}, {get(_namespace, name) {return apiClass(`messages.${String(name)}`);}});
  return apiClass(String(key));
}});

function loadPlugin(name, prefixes = ['.']) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', `${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: `${name}.ts`, reportDiagnostics: true,
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  });
  assert.equal(compiled.diagnostics.length, 0, `${name} TypeScript syntax`);
  const exports = {}, timers = [];
  vm.runInNewContext(compiled.outputText, {
    exports, console: {log() {}, error() {}},
    setTimeout: (fn, ms) => {timers.push({fn, ms}); return timers.length;},
    require(moduleName) {
      if (moduleName === 'teleproto') return {Api};
      if (moduleName === 'teleproto/events') return {Raw: class {constructor(args) {Object.assign(this, args);}}};
      if (moduleName === '@utils/pluginBase') return {Plugin: class {}};
      if (moduleName === '@utils/pluginManager') return {getPrefixes: () => prefixes};
      if (moduleName === '@utils/authGuards') return {safeGetMe: async () => ({id: 7, username: 'tester'})};
      return require(moduleName);
    },
  });
  return {plugin: exports.default, timers};
}

(async () => {
  const tj = loadPlugin('tj', ['!']).plugin;
  const sent = [], requests = [], edits = [];
  const client = {
    sendMessage: async (peer, options) => {sent.push({peer, ...options}); return {id: 99};},
    getInputEntity: async peer => `resolved:${peer}`,
    invoke: async request => {
      requests.push(request);
      return {messages: [
        {id: 12, sender: {firstName: '乙'}, message: '第二条'},
        {id: 11, sender: {firstName: '甲'}, message: '第一条'},
      ]};
    },
  };
  const message = text => ({message: text, peerId: 'chat', client, replyTo: {replyToMsgId: 10},
    getInputChat: async () => 'current', edit: async options => edits.push(options)});
  for (const sub of ['help', 'h', '?']) {
    await tj.cmdHandlers.tj(message(`!tj ${sub}`));
    assert.match(edits.at(-1).text, /!tj help/);
  }
  assert.equal(requests.length, 0);
  assert.equal(sent.length, 0, 'help neither fetches replies nor sends a statistics result');
  await tj.cmdHandlers.tj(message('!tj'));
  assert.equal(requests[0].msgId, 10);
  assert.equal(requests[0].peer, 'current');
  assert.match(sent[0].message, /共 2 条/);
  assert.ok(sent[0].message.indexOf('第一条') < sent[0].message.indexOf('第二条'));
  await tj.cmdHandlers.tj(message('!tj https://t.me/example/20'));
  assert.equal(requests[1].peer, 'resolved:example');
  assert.equal(requests[1].msgId, 20);
  assert.match(loadPlugin('tj', []).plugin.description, /\.tj help/);

  const {plugin: ban, timers} = loadPlugin('ban_ad_spam', ['!']);
  const voteSends = [], voteEdits = [], helpEdits = [];
  let approvals = 2;
  const voteClient = {
    sendMessage: async (peer, options) => {voteSends.push({peer, ...options}); return {id: 40};},
    editMessage: async (peer, options) => {voteEdits.push({peer, ...options});},
    getReactionUsers: async () => ({reactions: Array.from({length: approvals}, () => ({reaction: new Api.ReactionEmoji({emoticon: '👍'})}))}),
  };
  await ban.cmdHandlers.ban_ad_spam({message: '!ban_ad_spam help', edit: async options => helpEdits.push(options)});
  assert.match(helpEdits[0].text, /!ban_ad_spam help/);
  assert.match(helpEdits[0].text, /5 分钟内达到 3 个/);
  assert.equal(voteSends.length, 0, 'help does not initiate a vote');
  const trigger = {out: false, client: voteClient, peerId: 'group', message: '@tester ban广告',
    mentioned: true, replyTo: {replyToMsgId: 10}};
  await ban.listenMessageHandler({...trigger, out: true});
  await ban.listenMessageHandler({...trigger, mentioned: false});
  assert.equal(voteSends.length, 0, 'own messages or messages without a mention are ignored');
  await ban.listenMessageHandler(trigger);
  assert.equal(voteSends.length, 1);
  assert.equal(voteSends[0].replyTo, 10);
  assert.equal(timers[0].ms, 5 * 60 * 1000);
  await ban.eventHandlers[0].handler({msgId: 40});
  assert.equal(voteSends.length, 1, 'two approvals do not send spam');
  approvals = 3;
  await ban.eventHandlers[0].handler({msgId: 40});
  assert.equal(voteSends[1].message, '/spam');
  assert.equal(voteSends[1].replyTo, 10);
  assert.match(voteEdits.at(-1).text, /投票通过/);
  assert.match(loadPlugin('ban_ad_spam', []).plugin.description, /\.ban_ad_spam help/);
  console.log('PASS: TJ help and reply/link statistics; vote help, trigger, approval threshold, and custom/default prefixes.');
})().catch(error => {console.error(error); process.exitCode = 1;});
