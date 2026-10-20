const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const dependencies = process.env.YVLUX_TEST_DEPS ? createRequire(path.resolve(process.env.YVLUX_TEST_DEPS,'package.json')) : require;
const ts = dependencies('typescript');
const sharp = dependencies('sharp');
const root = path.resolve(__dirname,'..');
const source = fs.readFileSync(path.join(root, 'plugins/yvlux.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: 'yvlux.ts', reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
assert.equal(compiled.diagnostics.length, 0, 'TypeScript syntax');
let requests = [], sent = [], history = [], responseData, fetchOptions=[];
const classes = new Map();
const Api = new Proxy({}, {get(_, key) {
  if (key === 'channels' || key === 'messages') {
    if (!classes.has(key)) classes.set(key, new Proxy({}, {get(_, name) {
      const fullName = `${key}.${String(name)}`;
      if (!classes.has(fullName)) classes.set(fullName, class {constructor(args) {Object.assign(this, args);this.className = fullName;}});
      return classes.get(fullName);
    }}));
    return classes.get(key);
  }
  if (!classes.has(key)) classes.set(key, class { constructor(args) { Object.assign(this, args); } });
  return classes.get(key);
}});
const axios = async options => {
  requests.push(options);
  if (options.data.type === 'png' && options.data.style === 'classic') {
    const rows=options.data.messages;
    const rects=rows.map((row,index)=>`<rect x="100" y="${10+index*110}" width="20" height="30" fill="white"/><rect x="140" y="${10+index*110}" width="${Math.max(16,Math.min(480,[...row.from.name].length*20))}" height="30" fill="white"/>`).join('');
    return {data:await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${rows.length*110+30}">${rects}</svg>`)).png().toBuffer(),status:200};
  }
  return {data: responseData, status: 200};
};
axios.isAxiosError = () => false;
const client = {
  getMessages: async (_,options) => {fetchOptions.push(options);return history;},
  downloadProfilePhoto: async () => Buffer.from('synthetic-avatar'),
  sendFile: async (_, options) => { sent.push({...options, bytes: fs.readFileSync(options.file)}); },
};
const exportsObj = {};
const mockRequire = name => {
  if (name === 'axios') return {default: axios};
  if (name === 'sharp') return {default: sharp};
  if (name === 'teleproto') return {Api};
  if (name === '@utils/pluginManager') return {getPrefixes: () => ['.']};
  if (name === '@utils/pluginBase') return {Plugin: class {}};
  if (name === '@utils/pathHelpers') return {createDirectoryInAssets: () => __dirname};
  if (name === '@utils/runtimeManager') return {getGlobalClient: async () => client};
  if (name === '@utils/tlRevive') return {reviveEntities: e => e};
  return require(name);
};
vm.runInNewContext(compiled.outputText + '\nexports._expand = expandGlassPadding; exports._tag = getQuoteSenderTag; exports._restore = restoreGlassAvatars;exports._headers = renderQuoteHeaders;exports._parse = parseQuoteOptions;exports._split = splitQuoteMessages;exports._fetch = fetchQuoteMessages;', {
  require: mockRequire, exports: exportsObj, Buffer, console: {log() {}, warn() {}, error() {}},
});
const plugin = exportsObj.default;
plugin.config = {apiUrl: '', stickerSetShortName: ''};
const sender = {id: 7, firstName: 'GoMami', color: {color: 6}};
const message = (id, text, who = sender) => ({id, message: text, peerId: 1, entities: [], getSender: async () => who});
async function run(command, messages, extra = {}, expectedImages = 1) {
  history = messages; requests = []; sent = [];
  let deleted = false, edits = [];
  const msg = {
    id: 200, peerId: 1, message: command, ...extra,
    getReplyMessage: async () => messages[0],
    edit: async options => edits.push(options.text),
    delete: async options => { assert.equal(options.revoke, true); deleted = true; },
  };
  await plugin.cmdHandlers.yvlux(msg);
  assert.equal(deleted, true, edits.join('\n'));
  const quoteRequests=requests.filter(request=>request.data.type==='quote');
  assert.equal(quoteRequests.length, expectedImages);
  assert.equal(sent.length, expectedImages);
  assert.equal(quoteRequests[0].data.style, 'glass');
  assert.equal(quoteRequests[0].data.backgroundColor, '#302737/#221d2a');
  assert.equal(sent[0].replyTo, messages[0].id);
  return quoteRequests[0];
}
(async () => {
  responseData = await sharp({create: {width: 320, height: 160, channels: 4, background: '#302737'}}).webp({lossless:true}).toBuffer();
  let req = await run('.yvlux', [message(10, '小炸不算炸')]);
  assert.equal(req.url, 'https://quote.yuri.ly/generate.webp');
  assert.equal(req.data.messages[0].from.accentColorId, 6);
  req = await run('.yvlux', [{...message(10, '带成员标签'), peerId:new Api.PeerChannel({channelId: 1}), fromRank:'香香软软小男娘'}]);
  assert.equal(req.data.messages[0].senderTag, undefined,'backend header disabled');
  assert.equal((await exportsObj._tag({peerId:new Api.PeerChannel({channelId:1}),fromRank:'香香软软小男娘'},sender,client,new Map())).senderTagRole,'member','plain unboxed tag preset');
  req = await run('.yvlux 3', [message(10, '第一条'), message(12, '第二条'), message(19, '第三条', {id: 8, firstName: 'Another'})]);
  const same = req.data.messages[1];
  assert.equal(same.from.name, false);
  assert.equal(same.from.first_name, 'GoMami');
  assert.equal(same.from.photo, undefined, 'inline avatars stay local');
  assert.equal(req.data.messages[2].from.first_name, 'Another');
  assert.equal(req.data.messages[2].from.name, false,'full header is composed locally for every sender');
  req = await run('.yvlux pick 1,3', [message(10, '第一条'), message(12, '跳过'), message(19, '第三条')]);
  assert.equal(req.data.messages.length, 2);
  assert.equal(req.data.messages[1].text, '第三条');
  req = await run('.yvlux 自定义语录', [message(10, '原文')]);
  assert.equal(req.data.messages[0].text, '自定义语录');
  req = await run('.yvlux r', [{...message(10, '回复内容'), isReply:true, getReplyMessage: async () => message(9, '引用原文')}]);
  assert.equal(req.data.messages[0].replyMessage.text, '引用原文');
  const payload = {messages: [{from: {id:7}, media: {url: 'data:video/webm;base64,AA=='}}]};
  requests = [];
  await plugin.generateQuote(payload);
  assert.equal(requests[0].url, 'https://quote-api-enhanced.zhetengsha.eu.org/generate.webp');
  payload.messages[0].media.url = 'data:image/jpeg;base64,AA==';
  requests = [];
  await plugin.generateQuote(payload);
  assert.equal(requests[0].url, 'https://quote-api-enhanced.zhetengsha.eu.org/generate.webp', 'photo quote retains media backend');
  const animatedWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPANIM'), Buffer.alloc(10)]);
  payload.messages[0].media.url = 'data:image/webp;base64,' + animatedWebp.toString('base64');
  requests = [];
  await plugin.generateQuote(payload);
  assert.equal(requests[0].url, 'https://quote-api-enhanced.zhetengsha.eu.org/generate.webp');
  plugin.config.apiUrl = 'https://example.invalid/generate.webp';
  requests = [];
  await plugin.generateQuote(payload);
  assert.equal(requests[0].url, plugin.config.apiUrl);
  assert.equal(requests[0].data, payload, 'custom backend payload retained');
  plugin.config.apiUrl = '';
  responseData = await sharp({create: {width:400, height:1800, channels:4, background:'#302737'}}).png().toBuffer();
  const result = await plugin.generateQuote({messages:[]});
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.height, 512);
  assert.ok(metadata.width <= 512);
  const fixture = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="240"><rect x="80" y="10" width="260" height="120" rx="26" fill="#302737" stroke="#808080" stroke-width="2"/><rect x="100" y="38" width="20" height="20" fill="#ffffff"/><circle cx="25" cy="101" r="25" fill="#ff4444"/></svg>')).webp({lossless:true}).toBuffer();
  const expanded = await exportsObj._expand(fixture);
  const beforePixels = await sharp(fixture).ensureAlpha().raw().toBuffer();
  const afterPixels = await sharp(expanded).ensureAlpha().raw().toBuffer();
  assert.equal((await sharp(expanded).metadata()).width,512);
  const pixel = (data,x,y) => [...data.subarray((y*512+x)*4,(y*512+x)*4+4)];
  assert.deepEqual(pixel(afterPixels,112,50), pixel(beforePixels,110,48), 'content shifts by only 2px without font scaling');
  assert.equal(pixel(afterPixels,182,10)[3],255,'highlight stays on the top edge');
  assert.deepEqual(pixel(afterPixels,25,105), pixel(beforePixels,25,101), 'avatar moves down without scaling');
  assert.equal(pixel(beforePixels,342,70)[3],0);
  assert.equal(pixel(afterPixels,342,70)[3],255,'bubble padding increases slightly');
  const avatarImage=await sharp({create:{width:20,height:20,channels:4,background:'#89abcc'}}).png().toBuffer();
  const realAvatar=await exportsObj._restore(expanded,[{avatar:true,from:{photo:{url:'data:image/png;base64,'+avatarImage.toString('base64')}}}]);
  const restoredPixels=await sharp(realAvatar).ensureAlpha().raw().toBuffer();
  assert.deepEqual(pixel(restoredPixels,25,105),[137,171,204,255],'local avatar replaces API placeholder');
  for(let i=3;i<afterPixels.length;i+=4)assert.equal(restoredPixels[i],afterPixels[i],'avatar restoration preserves alpha and glass translucency');
  const peer = new Api.PeerChannel({channelId: 20});
  let lookups = 0;
  const tagClient = {
    getInputEntity: async e => e === peer ? {channelId:20, accessHash:123} : {userId:e.id},
    invoke: async request => {lookups++;return {participant:{className:'ChannelParticipant',rank:'萝卜宝贝的镇北王'}};},
  };
  let cache = new Map();
  const plain = {peerId:peer};
  let tag = await exportsObj._tag(plain,sender,tagClient,cache);
  assert.equal(tag.senderTag,'萝卜宝贝的镇北王');
  await exportsObj._tag(plain,sender,tagClient,cache);
  assert.equal(lookups,1,'participant lookup cached per generation');
  assert.equal(Object.keys(await exportsObj._tag({...plain,fwdFrom:{}},sender,tagClient,cache)).length,0,'forwarded author does not inherit forwarding member tag');
  assert.equal(Object.keys(await exportsObj._tag({peerId:1},sender,tagClient,cache)).length,0,'no group tags in private messages');
  assert.equal(Object.keys(await exportsObj._tag(plain,sender,{getInputEntity:async()=>{throw Error('forbidden');}},new Map())).length,0,'tag lookup failure is nonfatal');
  const basic = {peerId:new Api.PeerChat({chatId:30})};
  lookups = 0; cache = new Map();
  const basicClient = {invoke:async()=>{lookups++;return {fullChat:{participants:{participants:[{userId:7,className:'ChatParticipantCreator'},{userId:8,className:'ChatParticipant',rank:'可爱成员'}]}}};}};
  assert.equal((await exportsObj._tag(basic,sender,basicClient,cache)).senderTag,'群主');
  assert.equal((await exportsObj._tag(basic,{id:8},basicClient,cache)).senderTag,'可爱成员');
  assert.equal(lookups,1,'basic group member list loaded once');
  const fullName='Wan 13:10 ☁19°C 🌸 这是一个需要完整显示的很长用户名 END';
  const fullTag='萝卜宝贝的镇北王';
  const headerMessages=[{avatar:true,from:{id:123456,name:fullName,first_name:fullName,accentColorId:6},senderTag:fullTag,senderTagRole:'member'}];
  requests=[];
  const [fullHeader]=await exportsObj._headers(headerMessages);
  const headerRequest=requests.find(request=>request.data.style==='classic');
  assert.ok(headerRequest,'one glyph sheet request');
  assert.equal(headerRequest.data.messages.map(message=>message.from.name.replace(/^H /,'')).join('').replace(/\s/g,''),(fullName+fullTag).replace(/\s/g,''),'all name and tag characters are sent without truncation');
  assert.ok(headerRequest.data.messages.every(message=>!message.senderTag),'no API pill or capped name/tag row');
  const headerMeta=await sharp(fullHeader).metadata();
  assert.ok(headerMeta.width>headerMeta.height*8,'complete header stays on one line');
  const headerAlpha=await sharp(fullHeader).ensureAlpha().raw().toBuffer();
  assert.ok(headerAlpha.filter((_,i)=>i%4===3 && headerAlpha[i]===0).length>0,'header background stays transparent');
  const beforeCache=requests.length;
  await exportsObj._headers(headerMessages);
  assert.equal(requests.length,beforeCache,'header cache avoids repeat request');
  const assembled=await exportsObj._expand(fixture,[fullHeader]);
  const assembledMeta=await sharp(assembled).metadata();
  assert.equal(Math.max(assembledMeta.width,assembledMeta.height),512,'whole quote scales into sticker bounds');
  assert.ok(assembledMeta.height<240,'long single-line header widens the quote and scales all text together');
  const parsed=exportsObj._parse('12 r n "新的 名字" t "新的 内容"');
  assert.equal(parsed.count,12);assert.equal(parsed.r,true);assert.equal(parsed.customName,'新的 名字');assert.equal(parsed.customText,'新的 内容');
  const selected=exportsObj._parse('n "r" t "p n r" r p 8,1,6，6');
  assert.equal(selected.count,8);assert.deepEqual([...selected.pickPositions],[1,6,8]);assert.equal(selected.customName,'r');assert.equal(selected.customText,'p n r');
  assert.equal(exportsObj._parse('r 3 你好  世界\n第二行').customText,'你好  世界\n第二行');
  assert.equal(exportsObj._parse('p 1,6,8,11,50,101,200').pickPositions.length,7,'no 5-message or 100-position plugin cap');
  assert.equal(exportsObj._parse('500').count,500,'large continuous count accepted');
  for(const bad of ['0','-1','9007199254740992','p 0','p 1,a','3 p 1,2','p 1,2 3','n','n ""','n "missing','t','n A n B','t X t Y','r s'])assert.throws(()=>exportsObj._parse(bad),undefined,bad);
  responseData=await sharp({create:{width:320,height:160,channels:4,background:'#302737'}}).webp({lossless:true}).toBuffer();
  const a={id:7,firstName:'Original A',color:{color:6}},b={id:8,firstName:'Original B'};
  const many=Array.from({length:12},(_,i)=>message(10+i*3,`original-${i+1}`,i%3===1?b:a));
  many[0].isReply=true;many[0].getReplyMessage=async()=>message(9,'引用内容');
  fetchOptions=[];
  await run('.yvlux 12 r n "新的 名字" t "第一条已替换"',many,{},3);
  let batches=requests.filter(req=>req.data.type==='quote').map(req=>req.data.messages);
  assert.deepEqual(batches.map(batch=>batch.length),[5,5,2]);
  assert.equal(batches[0][0].text,'第一条已替换');assert.equal(batches[0][0].replyMessage.text,'引用内容');
  assert.equal(batches[0][1].text,'original-2','t only changes first selected message');
  for(const batch of batches){assert.equal(batch[0].avatar,true,'each image starts with full sender profile');for(const item of batch)assert.equal(item.from.first_name,item.from.id===7?'新的 名字':'Original B','n only changes first selected author');}
  assert.equal(a.firstName,'Original A','real sender object remains unchanged');
  assert.equal(fetchOptions[0].maxId,200,'command excluded from continuous fetch');
  const sameAuthor=Array.from({length:12},(_,i)=>message(10+i,`same-${i+1}`,a));
  await run('.yvlux 12 n Nick',sameAuthor,{},3);
  batches=requests.filter(req=>req.data.type==='quote').map(req=>req.data.messages);
  assert.ok(batches.every(batch=>batch[0].avatar && batch[0].from.first_name==='Nick'),'same-author continuation restores header on every image');
  const seven=Array.from({length:8},(_,i)=>message(10+i*2,`pick-${i+1}`,i===2?b:a));
  await run('.yvlux p 1,2,3,4,5,6,8 r n New t Custom',seven,{},2);
  batches=requests.filter(req=>req.data.type==='quote').map(req=>req.data.messages);
  assert.equal(batches.flat().length,7);assert.equal(batches[1][1].text,'pick-8');
  const past100=Array.from({length:110},(_,i)=>message(10+i,`position-${i+1}`,i===100?b:a));
  await run('.yvlux p 101,102 n Picked',past100,{replyTo:{quoteText:'must not override message 101'}});
  const distant=requests.find(req=>req.data.type==='quote').data.messages;
  assert.equal(distant[0].text,'position-101');assert.equal(distant[0].from.first_name,'Picked');assert.equal(distant[1].from.first_name,'Original A');
  assert.equal(fetchOptions.at(-1).limit,100);
  const service=new Api.MessageService({id:11,peerId:1});
  const pagedHistory=[message(10,'start'),service,message(15,'second'),message(18,'third'),message(200,'command')];
  let pages=0;
  const pagedClient={getMessages:async(_,options)=>{pages++;return pagedHistory.filter(item=>item.id>options.offsetId&&item.id<options.maxId).slice(0,options.limit);}};
  const paged=await exportsObj._fetch(pagedClient,pagedHistory[0],200,3);
  assert.deepEqual(Array.from(paged,item=>item.id),[10,15,18],'services and numeric message-id gaps do not consume p positions');
  assert.equal(pages,2,'fetches the missing real message after a service entry');
  history=sameAuthor;requests=[];sent=[];
  const normalSend=client.sendFile;let failureText='',revoked=false,failedPath;
  client.sendFile=async(peer,options)=>{if(sent.length===1){failedPath=options.file;throw Error('synthetic upload failure');}return normalSend(peer,options);};
  await plugin.cmdHandlers.yvlux({id:200,peerId:1,message:'.yvlux 12',getReplyMessage:async()=>sameAuthor[0],edit:async options=>{failureText=options.text;},delete:async()=>{revoked=true;}});
  client.sendFile=normalSend;
  assert.equal(sent.length,1);assert.equal(revoked,false);assert.match(failureText,/第 2 张发送失败（已发送 1 张）/);assert.equal(fs.existsSync(failedPath),false,'failed upload temporary file is cleaned up');
  console.log('PASS: syntax/rendering; unboxed single-line full names; proportional sizing; combined p/r/n/t; quoted/legacy parsing; removed count/position caps; 12-message pagination; rename scope; cross-image sender restoration; partial-send errors and cleanup; media/API compatibility.');
})().catch(e => {console.error(e); process.exitCode = 1;});
