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
let requests = [], sent = [], history = [], responseData, fetchOptions=[], realisticQuote=false;
let liveQuote=false, liveSerial=0, quoteInputs=[];
let omitMessage=false, omitAvatars=false, joinBubbles=false;
const classes = new Map();
const Api = new Proxy({}, {get(_, key) {
  if (key === 'channels' || key === 'messages' || key === 'stickers') {
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
  if (liveQuote) {
    const os=require('node:os'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
    const stem=path.join(os.tmpdir(),`yvlux-live-${process.pid}-${++liveSerial}`),input=stem+'.json',output=stem+'.bin';
    try {
      fs.writeFileSync(input,JSON.stringify(options.data));
      const {stdout}=await promisify(execFile)('curl.exe',['--silent','--show-error','--max-time','55','--header','Content-Type: application/json','--data-binary','@'+input,'--output',output,'--write-out','%{http_code}',options.url]);
      assert.equal(stdout,'200',`live quote HTTP ${stdout}`);return {data:fs.readFileSync(output),status:200};
    } finally {for(const file of [input,output])try{fs.unlinkSync(file);}catch{}}
  }
  if (options.data.type === 'png' && options.data.style === 'classic') {
    const rows=options.data.messages;
    const rects=rows.map((row,index)=>`<rect x="100" y="${10+index*110}" width="20" height="30" fill="white"/><rect x="140" y="${10+index*110}" width="${Math.max(16,Math.min(480,[...row.from.name].length*20))}" height="30" fill="white"/>`).join('');
    return {data:await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${rows.length*110+30}">${rects}</svg>`)).png().toBuffer(),status:200};
  }
  if (realisticQuote || options.data.messages.length) {
    let y=10;const parts=[];const rows=omitMessage&&options.data.messages.length>1?options.data.messages.filter((_,index)=>index!==1):options.data.messages;
    rows.forEach((row,index)=>{
      const h=row.replyMessage?115:64,w=(row.text||'').length<5?65:260;
      parts.push(`<rect x="80" y="${y}" width="${w}" height="${h}" rx="13" fill="#302737"/><rect x="96" y="${y+15}" width="10" height="15" fill="white"/>`);
      if(row.replyMessage?.media?.kind==='story')parts.push(`<circle cx="128" cy="${y+44}" r="20" fill="#ff77bb"/>`);
      if((index===rows.length-1||row.from.id!==rows[index+1].from.id)&&!(omitAvatars&&rows.length>1))parts.push(`<circle cx="25" cy="${y+h-25}" r="25" fill="#77bbff"/>`);
      if(joinBubbles&&rows.length>1&&index<rows.length-1)parts.push(`<rect x="100" y="${y+h-1}" width="20" height="10" fill="#302737"/>`);
      y+=h+8;
    });
    const native=options.data.type==='png'&&options.data.style==='glass';
    let fixture=sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="${y+10}">${parts.join('')}</svg>`));
    if(native)fixture=fixture.resize(1024,(y+10)*2);
    return {data:native?await fixture.png().toBuffer():await fixture.webp({lossless:true}).toBuffer(),status:200};
  }
  return {data: responseData, status: 200};
};
axios.isAxiosError = () => false;
const client = {
  getMessages: async (_,options) => {fetchOptions.push(options);return history;},
  downloadProfilePhoto: async () => sharp({create:{width:20,height:20,channels:4,background:'#5588bb'}}).png().toBuffer(),
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
vm.runInNewContext(compiled.outputText + '\nexports._expand = expandGlassPadding; exports._tag = getQuoteSenderTag; exports._restore = restoreGlassAvatars;exports._headers = renderQuoteHeaders;exports._parse = parseQuoteOptions;exports._split = splitQuoteMessages;exports._fetch = fetchQuoteMessages;exports._preview=getQuoteMediaPreview;exports._upload=uploadQuoteStickerImage;exports._body=quoteBodyText;exports._clearHeaders=()=>quoteHeaderCache.clear();exports._fit=fitQuoteArtwork;exports._prepare=prepareQuoteSticker;', {
  require: mockRequire, exports: exportsObj, Buffer, console: {log() {}, warn() {}, error() {}},
});
const plugin = exportsObj.default;
plugin.config = {apiUrl: '', stickerSetShortName: ''};
const generate=plugin.generateQuote.bind(plugin);
plugin.generateQuote=async data=>{quoteInputs.push(data);return generate(data);};
const sender = {id: 7, firstName: 'GoMami', color: {color: 6}};
const message = (id, text, who = sender) => ({id, message: text, peerId: 1, entities: [], getSender: async () => who});
async function artworkBounds(buffer) {
  const {data,info}=await sharp(buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let left=info.width,right=-1,top=info.height,bottom=-1;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  return {data,info,left,right,top,bottom};
}
async function assertTightArtwork(buffer) {
  const bounds=await artworkBounds(buffer);
  assert.ok(bounds.left<=1 && bounds.info.width-1-bounds.right<=1,'artwork fills its actual width without transparent side margins');
  assert.ok(bounds.top<=1 && bounds.info.height-1-bounds.bottom<=1,'artwork fills its actual height without transparent top/bottom margins');
  return bounds;
}
async function assertQuoteSticker(buffer) {
  const bounds=await artworkBounds(buffer),{data,info}=bounds;
  assert.equal(Math.max(info.width,info.height),512,'generated sticker has an exact 512px side for sticker-pack compatibility');
  assert.ok(buffer.length<=512*1024,'generated static sticker stays within the 512KB upload limit');
  assert.ok(bounds.left<=1 && info.width-1-bounds.right<=1 && bounds.top<=1,'no outer side or top padding is added');
  for(let y=Math.max(0,info.height-56);y<info.height;y++)for(let x=Math.max(0,info.width-160);x<info.width;x++) {
    assert.equal(data[(y*info.width+x)*4+3],0,'bottom-right timestamp area does not cover quote content');
  }
  return bounds;
}
async function run(command, messages, extra = {}, expectedImages = 1) {
  history = messages; requests = []; sent = []; quoteInputs=[];
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
  for(const file of sent){
    const {info}=await assertQuoteSticker(file.bytes);
    const size=file.attributes.find(attribute=>attribute instanceof Api.DocumentAttributeImageSize);
    assert.equal(size.w,info.width);assert.equal(size.h,info.height,'sent image dimensions match the encoded sticker');
  }
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
  const mediaFixture=await sharp({create:{width:50,height:30,channels:4,background:'#5588bb'}}).png().toBuffer();
  const payload = {messages: [{from: {id:7}, media: {url: 'data:image/png;base64,'+mediaFixture.toString('base64')}}]};
  requests = [];
  await plugin.generateQuote(payload);
  assert.equal(requests[0].url, 'https://quote.yuri.ly/generate.webp');
  assert.equal(requests[0].data.messages[0].media,undefined,'local photos must not switch to legacy API or be sent as unsupported data URLs');
  payload.messages[0].media.url = 'data:image/png;base64,'+mediaFixture.toString('base64');
  requests = [];
  await plugin.generateQuote(payload);
  assert.equal(requests[0].url, 'https://quote.yuri.ly/generate.webp', 'photo quote retains glass backend');
  payload.messages[0].media.url = 'data:image/png;base64,'+mediaFixture.toString('base64');
  requests = [];
  await plugin.generateQuote(payload);
  assert.equal(requests[0].url, 'https://quote.yuri.ly/generate.webp');
  plugin.config.apiUrl='https://quote-api-enhanced.zhetengsha.eu.org/generate.webp';
  requests=[];await plugin.generateQuote(payload);
  assert.equal(requests[0].url,'https://quote.yuri.ly/generate.webp','legacy built-in URL also migrates to glass');
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
  const fittedOnly=await exportsObj._fit(realAvatar);
  const fittedBounds=await assertTightArtwork(fittedOnly);
  const originalBounds=await artworkBounds(realAvatar);
  assert.equal(fittedBounds.info.width,originalBounds.right-originalBounds.left+1);
  assert.equal(fittedBounds.info.height,originalBounds.bottom-originalBounds.top+1,'canvas matches artwork bounds instead of retaining empty space');
  const enlarged=await exportsObj._fit(realAvatar,[{avatar:true,from:{photo:{url:'data:image/png;base64,'+avatarImage.toString('base64')}}}]);
  const enlargedBounds=await assertTightArtwork(enlarged);
  let avatarLeft=enlargedBounds.info.width,avatarRight=-1;
  for(let i=0;i<enlargedBounds.data.length;i+=4)if(enlargedBounds.data[i]===137&&enlargedBounds.data[i+1]===171&&enlargedBounds.data[i+2]===204&&enlargedBounds.data[i+3]>128){const x=(i/4)%enlargedBounds.info.width;avatarLeft=Math.min(avatarLeft,x);avatarRight=Math.max(avatarRight,x);}
  assert.ok(avatarRight-avatarLeft+1>=57&&avatarRight-avatarLeft+1<=59,'50px avatar grows to about 58px without enlarging the bubble');
  let whiteBefore=0,whiteAfter=0;
  for(let i=0;i<restoredPixels.length;i+=4)if(restoredPixels[i]===255&&restoredPixels[i+1]===255&&restoredPixels[i+2]===255&&restoredPixels[i+3]===255)whiteBefore++;
  for(let i=0;i<enlargedBounds.data.length;i+=4)if(enlargedBounds.data[i]===255&&enlargedBounds.data[i+1]===255&&enlargedBounds.data[i+2]===255&&enlargedBounds.data[i+3]===255)whiteAfter++;
  assert.equal(whiteAfter,whiteBefore,'body glyph pixels keep their exact size');
  const ready=await exportsObj._prepare(enlarged);
  const readyBounds=await assertQuoteSticker(ready);
  assert.ok(readyBounds.info.height-1-readyBounds.bottom>=56,'short quote reserves only a bottom timestamp strip');
  const cornerFree=await sharp(Buffer.from('<svg width="512" height="512"><rect width="512" height="350" fill="#302737"/><rect y="350" width="150" height="162" fill="#302737"/></svg>')).png().toBuffer();
  const reusedCorner=await assertQuoteSticker(await exportsObj._prepare(cornerFree));
  assert.ok(reusedCorner.info.height-1-reusedCorner.bottom<=1,'naturally empty lower-right corner does not add a bottom strip');
  for(const [width,height]of [[20,10],[50,300],[2000,5]]){
    const compact=await sharp({create:{width,height,channels:4,background:'#302737'}}).png().toBuffer();
    await assertQuoteSticker(await exportsObj._prepare(compact));
  }
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
  assert.equal(exportsObj._parse('g ""').customTag,'','explicit empty tag hides automatic group label');
  assert.equal(exportsObj._parse('g "r" n "g"').customTag,'r','quoted reserved words can be tags');
  for(const selector of ['','8','p 2,4,6'])for(let flags=0;flags<16;flags++){
    const options=[selector,flags&1?'r':'',flags&2?'n "New Name"':'',flags&4?'t "New Text"':'',flags&8?'g "New Tag"':''].filter(Boolean).reverse().join(' ');
    const combined=exportsObj._parse(options);
    assert.equal(combined.r,!!(flags&1));assert.equal(combined.customName,flags&2?'New Name':undefined);assert.equal(combined.customText,flags&4?'New Text':undefined);assert.equal(combined.customTag,flags&8?'New Tag':undefined);
  }
  for(const bad of ['0','-1','9007199254740992','p 0','p 1,a','3 p 1,2','p 1,2 3','n','n ""','n "missing','t','n A n B','t X t Y','r s','g','g r','n g','g A g B','g "" g B','g A s'])assert.throws(()=>exportsObj._parse(bad),undefined,bad);
  responseData=await sharp({create:{width:320,height:160,channels:4,background:'#302737'}}).webp({lossless:true}).toBuffer();
  const a={id:7,firstName:'Original A',color:{color:6}},b={id:8,firstName:'Original B'};
  const many=Array.from({length:12},(_,i)=>message(10+i*3,`original-${i+1}`,i%3===1?b:a));
  many[0].isReply=true;many[0].getReplyMessage=async()=>message(9,'引用内容');
  fetchOptions=[];
  await run('.yvlux 12 r n "新的 名字" t "第一条已替换" g "自定义群标签"',many,{},3);
  let batches=requests.filter(req=>req.data.type==='quote').map(req=>req.data.messages);
  assert.deepEqual(batches.map(batch=>batch.length),[5,5,2]);
  assert.equal(batches[0][0].text,'第一条已替换');assert.equal(batches[0][0].replyMessage.text,'引用内容');
  assert.equal(batches[0][1].text,'original-2','t only changes first selected message');
  for(const batch of batches){assert.equal(batch[0].avatar,true,'each image starts with full sender profile');for(const item of batch)assert.equal(item.from.first_name,item.from.id===7?'新的 名字':'Original B','n only changes first selected author');}
  for(const batch of quoteInputs)for(const item of batch.messages)if(item.avatar)assert.equal(item.senderTag,item.from.id===7?'自定义群标签':undefined,'custom tag follows only the first selected author across groups and pages');
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
  // 本次报错的根因：空消息被跳过、纯表情改成裸贴纸、布局数量与消息不一致。
  const emojiMessages=[message(10,'👍'),message(12,'😂😂'),message(14,'')];
  const emojiRequest=await run('.yvlux 3',emojiMessages);
  assert.equal(emojiRequest.data.messages[0].text,'👍\u200b');assert.equal(emojiRequest.data.messages[1].text,'😂😂\u200b');
  assert.equal(emojiRequest.data.messages[2].text,'[无文字消息]');assert.equal(emojiMessages[0].message,'👍','normalization only affects backend payload');
  for(const emoji of ['🇨🇳','👨‍👩‍👧‍👦','1️⃣','❤️','🏳️‍🌈','👍🏽'])assert.equal(exportsObj._body({text:emoji}),emoji+'\u200b',`normal bubble for ${emoji}`);
  for(const text of ['123','普通文字','👍 好'])assert.equal(exportsObj._body({text}),text);
  requests=[];omitMessage=true;
  const fallbackPayload={type:'quote',format:'webp',style:'glass',backgroundColor:'#302737/#221d2a',width:512,height:768,scale:2,messages:[
    {avatar:true,from:{id:991,first_name:'Author A',photo:{url:'data:image/png;base64,'+mediaFixture.toString('base64')}},senderTag:'标签 A',text:'甲'},
    {avatar:false,from:{id:991},text:'乙'},
    {avatar:true,from:{id:992,first_name:'Author B'},senderTag:'标签 B',text:'丙'},
  ]};
  const fallback=await plugin.generateQuote(fallbackPayload);
  omitMessage=false;
  const individual=requests.filter(request=>request.data.type==='png'&&request.data.style==='glass');
  assert.equal(individual.length,3,'mismatched backend layout is retried per message, never assigned by guessed pixel order');
  assert.ok(individual.every(request=>request.data.messages.length===1&&request.data.messages[0].avatar),'each retry has a single known message and layout');
  assert.equal(individual[1].data.messages[0].from.first_name,'Author A','continuation restores complete sender metadata');
  const fallbackPixels=await sharp(fallback.buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const fallbackBounds=await assertQuoteSticker(fallback.buffer);
  assert.equal(Math.max(fallbackPixels.info.width,fallbackPixels.info.height),512);
  let avatarBands=0,avatarInBand=false;
  for(let y=0;y<fallbackPixels.info.height;y++) {
    const alpha=fallbackPixels.data[(y*fallbackPixels.info.width+fallbackBounds.left+15)*4+3];
    if(alpha>=128&&!avatarInBand)avatarBands++;
    avatarInBand=alpha>=128;
  }
  assert.equal(avatarBands,2,'one avatar at the end of each sender group after fallback composition');
  for(const fault of ['missing-avatar','joined-bubbles']) {
    requests=[];omitAvatars=fault==='missing-avatar';joinBubbles=fault==='joined-bubbles';
    const recovered=await plugin.generateQuote(fallbackPayload);
    omitAvatars=false;joinBubbles=false;
    assert.equal(requests.filter(request=>request.data.type==='png'&&request.data.style==='glass').length,3,`${fault} also takes the structured retry`);
    const recoveredMeta=await sharp(recovered.buffer).metadata();
    assert.equal(Math.max(recoveredMeta.width,recoveredMeta.height),512);
  }
  console.log('PASS: pure emoji/empty-message normalization; incomplete backend layout retries preserve every message, header/tag alignment, uniform scale, and grouped avatars.');
  const tagLive=process.argv.includes('--tag-live');
  if(tagLive){exportsObj._clearHeaders();liveQuote=true;}
  const taggedRows=Array.from({length:8},(_,i)=>({...message(10+i*2,`tag-${i+1}`,i===1?b:a),peerId:new Api.PeerChannel({channelId:99}),fromRank:i===1?'原标签 B':'原标签 A'}));
  await run('.yvlux g "私人 标签 🌸"',[taggedRows[0]]);
  assert.equal(quoteInputs[0].messages[0].senderTag,'私人 标签 🌸');
  await run('.yvlux p 2,3,4 g "只改 B" n "新 B"',taggedRows);
  assert.equal(quoteInputs[0].messages[0].senderTag,'只改 B');assert.equal(quoteInputs[0].messages[0].from.first_name,'新 B');
  assert.equal(quoteInputs[0].messages[1].senderTag,'原标签 A','other selected authors retain their real group tag');
  if(tagLive&&process.env.YVLUX_PREVIEW_DIR)await sharp(sent[0].bytes).flatten({background:'#0e1621'}).png().toFile(path.join(process.env.YVLUX_PREVIEW_DIR,'yvlux-custom-tag.png'));
  await run('.yvlux 8 g ""',taggedRows,{},2);
  for(const batch of quoteInputs)for(const item of batch.messages)if(item.avatar)assert.equal(item.senderTag,item.from.id===7?'':'原标签 B','empty override stays hidden after paging and returning to the same author');
  assert.equal(taggedRows[0].fromRank,'原标签 A','custom tag never changes source Telegram membership');
  liveQuote=false;omitMessage=true;
  await run('.yvlux 3 g "恢复后的标签"',taggedRows);
  omitMessage=false;
  assert.equal(quoteInputs[0].messages[0].senderTag,'恢复后的标签');assert.equal(quoteInputs[0].messages[1].senderTag,'原标签 B');assert.equal(quoteInputs[0].messages[2].senderTag,'恢复后的标签');
  assert.equal(requests.filter(request=>request.data.type==='png'&&request.data.style==='glass').length,3,'custom tag is preserved on structured layout recovery');
  let compactHelp='';
  await plugin.cmdHandlers.yvlux({message:'.yvlux help',edit:async options=>{compactHelp=options.text;}});
  assert.match(compactHelp,/g "标签"/);assert.match(compactHelp,/组合示例/);assert.equal(plugin.description,compactHelp);
  assert.ok(compactHelp.replace(/<[^>]+>/g,'').length<450,'help stays compact');assert.doesNotMatch(compactHelp,/增强版|高光|本地合成|旧接口|后端/);
  console.log('PASS: g custom/hidden tags, all 48 r/n/t/g selector combinations parsed, author scope, paging, real tag preservation, and compact help.');
  if(process.argv.includes('--layout-only'))return;
  // 所有有效选择器 × r/n/t 子集，分别覆盖文本、图片、贴纸及动画缩略图。
  // --live 只针对合成测试图片访问默认绘图接口，Telegram 始终是模拟客户端。
  const live=process.argv.includes('--live');
  const photo=await sharp(Buffer.from('<svg width="240" height="160"><rect width="240" height="160" fill="#358cbb"/><circle cx="110" cy="70" r="45" fill="#fcbb55"/><path d="M0 160 L60 100 L120 160 L190 90 L240 160" fill="#1d5263"/></svg>')).png().toBuffer();
  const largeThumb=new Api.PhotoSize({w:320,h:240,type:'m'}),smallThumb=new Api.PhotoSize({w:90,h:90,type:'s'});
  let thumbChoice;
  await exportsObj._preview({media:new Api.MessageMediaDocument({document:{mimeType:'video/mp4',thumbs:[smallThumb,largeThumb]}}),downloadMedia:async options=>{thumbChoice=options.thumb;return photo;}});
  assert.equal(thumbChoice,largeThumb,'prefer the largest thumbnail, not a stripped tiny preview');
  assert.equal(await exportsObj._preview({media:new Api.MessageMediaWebPage({}),downloadMedia:async()=>{throw Error('webpage must not be treated as a photo');}}),undefined);
  await assert.rejects(()=>exportsObj._preview({media:new Api.MessageMediaPhoto({}),downloadMedia:async()=>undefined}),/下载失败/);
  if(process.argv.includes('--media-tools')) {
    const os=require('node:os'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yvlux-media-test-'));
    try {
      for(const [extension,mime]of [['mp4','video/mp4'],['webm','video/webm']]) {
        const file=path.join(dir,'sample.'+extension);
        await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=120x80:d=0.2','-frames:v','1',file]);
        const raw=fs.readFileSync(file);
        const preview=await exportsObj._preview({media:new Api.MessageMediaDocument({document:{mimeType:mime}}),downloadMedia:async options=>options?undefined:raw});
        const metadata=await sharp(Buffer.from(preview.url.split(',')[1],'base64')).metadata();assert.equal(metadata.width,120);assert.equal(metadata.height,80);
      }
      const gif=await sharp(photo).gif().toBuffer();
      const preview=await exportsObj._preview({media:new Api.MessageMediaDocument({document:{mimeType:'image/gif'}}),downloadMedia:async options=>options?undefined:gif});
      assert.equal((await sharp(Buffer.from(preview.url.split(',')[1],'base64')).metadata()).format,'png');
    } finally {for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);}
    console.log('PASS: real ffmpeg MP4/WebM first-frame extraction and thumbnail-less GIF preview.');
  }
  client.downloadProfilePhoto=async()=>photo;
  realisticQuote=true;liveQuote=live;
  const selectors=['','8','p 1,2,3,4,5,6'];let matrixCases=0;
  const kinds=live?['photo']:['text','photo','sticker','video','tgs','gif'];
  for(const kind of kinds)for(const selector of selectors)for(let flags=0;flags<8;flags++) {
    const who={id:700,firstName:'Alpha 完整昵称',color:{color:6}},other={id:800,firstName:'Beta 完整昵称',color:{color:5}};
    const rows=Array.from({length:8},(_,i)=>({...message(10+i*2,i===1?'好':`测试消息${i+1}`,i===2?other:who),peerId:new Api.PeerChannel({channelId:99}),fromRank:i===2?'群标签乙':'群标签甲'}));
    if(kind!=='text') {
      rows[0].message='';
      rows[0].media=kind==='photo'?new Api.MessageMediaPhoto({}):new Api.MessageMediaDocument({document:{mimeType:{sticker:'image/webp',video:'video/mp4',tgs:'application/x-tgsticker',gif:'image/gif'}[kind],attributes:kind==='sticker'||kind==='tgs'?[new Api.DocumentAttributeSticker({})]:[]}});
      rows[0].downloadMedia=async()=>photo;
    }
    rows[1].isReply=true;rows[1].getReplyMessage=async()=>rows[0];
    const options=[selector,flags&1?'r':'',flags&2?'n "改名 Alpha"':'',flags&4?'t "自定义内容"':''].filter(Boolean);
    if(flags&2)options.reverse(); // 交错顺序，避免测试只覆盖文档的排列。
    const count=selector===''?1:selector==='8'?8:6;
    await run('.yvlux '+options.join(' '),rows,{},Math.ceil(count/5));
    assert.equal(rows[0].message,kind==='text'?'测试消息1':'','t must not mutate original message');
    const apiRequests=requests.filter(request=>request.data.type==='quote');
    for(const batch of quoteInputs)for(const row of batch.messages)if(row.avatar){
      assert.equal(row.senderTag,row.from.id===700?'群标签甲':'群标签乙','every sender and page retains the unboxed group tag');
      assert.equal(row.from.first_name,row.from.id===700&&(flags&2)?'改名 Alpha':row.from.id===700?'Alpha 完整昵称':'Beta 完整昵称','rename does not affect another author');
    }
    for(const request of apiRequests) {
      assert.equal(request.url,'https://quote.yuri.ly/generate.webp');
      assert.ok(request.data.messages.every(row=>row.media===undefined),'unsupported media data URLs stay local');
    }
    if((flags&1)&&count>1&&kind!=='text')assert.equal(apiRequests[0].data.messages[1].replyMessage.media.kind,'story','photo-only reply reserves a thumbnail');
    for(const file of sent) {
      const {data,info}=await sharp(file.bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      assert.equal(Math.max(info.width,info.height),512);
      let glass=0,blue=0;
      for(let i=0;i<data.length;i+=4){if(data[i+3]>200&&data[i+3]<250&&Math.max(data[i],data[i+1],data[i+2])<90)glass++;if(Math.abs(data[i]-53)<3&&Math.abs(data[i+1]-140)<3&&Math.abs(data[i+2]-187)<3)blue++;}
      assert.ok(glass>10,`${kind}/${selector}/${flags}: visible translucent glass`);
      assert.ok(blue>10,`${kind}/${selector}/${flags}: local avatar/media retained`);
    }
    if(live&&selector==='8'&&flags===7&&process.env.YVLUX_PREVIEW_DIR) {
      fs.mkdirSync(process.env.YVLUX_PREVIEW_DIR,{recursive:true});
      for(const [index,file]of sent.entries())await sharp(file.bytes).flatten({background:'#0e1621'}).png().toFile(path.join(process.env.YVLUX_PREVIEW_DIR,`yvlux-fixed-combination-${index+1}.png`));
    }
    matrixCases++;
    if(live)console.log(`LIVE ${matrixCases}/24: ${options.join(' ')||'single'} (${sent.length} image(s))`);
    else if(matrixCases%24===0)console.log(`LOCAL ${matrixCases}/144 mode combinations passed`);
  }
  const photoSource={...message(5,''),media:new Api.MessageMediaPhoto({}),downloadMedia:async()=>photo};
  const reply={...message(10,'回复图片',{id:801,firstName:'Reply Author'}),isReply:true,getReplyMessage:async()=>photoSource,peerId:new Api.PeerChannel({channelId:99}),fromRank:'引用者标签'};
  await run('.yvlux r n "引用名" t "新的正文"',[reply]);
  assert.ok(quoteInputs[0].messages[0].replyMessage.media.url.startsWith('data:image/png;'));
  assert.equal(quoteInputs[0].messages[0].replyMessage.text,'图片','photo-only referenced message is not dropped');
  assert.equal(quoteInputs[0].messages[0].senderTag,'引用者标签');
  reply.replyTo={quote:true,quoteText:'节选文字',quoteEntities:[]};
  await run('.yvlux r',[reply]);assert.equal(quoteInputs[0].messages[0].replyMessage.text,'节选文字','partial quote retains text and thumbnail together');
  if(live&&process.env.YVLUX_PREVIEW_DIR)await sharp(sent[0].bytes).flatten({background:'#0e1621'}).png().toFile(path.join(process.env.YVLUX_PREVIEW_DIR,'yvlux-fixed-image-reply.png'));
  await run('.yvlux p 2,4 r n "只改 Beta" t "跳选正文"',[photoSource,reply,message(14,'skip'),message(17,'Alpha 原名')]);
  assert.equal(quoteInputs[0].messages[0].from.first_name,'只改 Beta');assert.equal(quoteInputs[0].messages[1].from.first_name,'GoMami');
  liveQuote=false;realisticQuote=false;
  console.log(`PASS: ${matrixCases} complete mode combinations (${live?'real drawing API':'local image fixtures'}), glass material, local photos, photo-only replies, tags, rename scope, immutable source messages, and pagination.`);
  // s/config/api/help 路由以及真正的上传文件/文档类型；不连接 Telegram。
  const os=require('node:os'),configDir=fs.mkdtempSync(path.join(os.tmpdir(),'yvlux-config-test-'));
  plugin.configPath=path.join(configDir,'config.json');
  fs.writeFileSync(plugin.configPath,JSON.stringify({apiUrl:'',stickerSetShortName:'TestQuotes'}));
  let calls=[],uploads=[],packExists=true;
  client.getMe=async()=>({id:7});
  client.uploadFile=async({file})=>{
    assert.equal(typeof file.size,'number');assert.equal(typeof file.arrayBuffer,'function');
    const bytes=Buffer.from(await file.arrayBuffer());assert.equal(bytes.length,file.size);
    const metadata=await sharp(bytes).metadata();assert.equal(metadata.format,'webp');assert.equal(Math.max(metadata.width,metadata.height),512);
    uploads.push(bytes);return new Api.InputFile({id:123,name:file.name});
  };
  client.invoke=async request=>{
    calls.push(request);
    if(request.className==='messages.GetStickerSet'){if(!packExists)throw {errorMessage:'STICKERSET_INVALID'};return new Api.messages.StickerSet({});}
    if(request.className==='messages.UploadMedia'){
      assert.ok(request.peer instanceof Api.InputPeerSelf);assert.ok(request.media instanceof Api.InputMediaUploadedDocument);assert.equal(request.media.mimeType,'image/webp');
      return new Api.MessageMediaDocument({document:{id:999,accessHash:888,fileReference:Buffer.from('ref')}});
    }
    if(request.className==='stickers.AddStickerToSet'||request.className==='stickers.CreateStickerSet') {
      const item=request.sticker||request.stickers[0];assert.ok(item.document instanceof Api.InputDocument,'stickerset accepts InputDocument, never the upload InputFile');
    }
    return {};
  };
  const route=async(command,reply)=>{
    let text='';requests=[];
    await plugin.cmdHandlers.yvlux({message:'.yvlux '+command,peerId:1,id:200,edit:async o=>{text=o.text;},getReplyMessage:async()=>reply});
    assert.equal(requests.length,0,'management routes must not call drawing API');return text;
  };
  try {
    for(const help of ['help','h','?'])assert.match(await route(help),/组合示例/);
    assert.match(await route('api'),/当前 API/);assert.match(await route('api example.com'),/https:\/\/example.com\/generate.webp/);
    const savedUrl=JSON.parse(fs.readFileSync(plugin.configPath)).apiUrl;
    assert.match(await route('api reset r'),/单独使用/);assert.equal(JSON.parse(fs.readFileSync(plugin.configPath)).apiUrl,savedUrl);
    assert.match(await route('api reset'),/重置/);assert.equal(JSON.parse(fs.readFileSync(plugin.configPath)).apiUrl,'');
    assert.match(await route('config'),/当前配置/);assert.match(await route('config sticker UpdatedQuotes'),/已设置/);
    assert.equal(JSON.parse(fs.readFileSync(plugin.configPath)).stickerSetShortName,'UpdatedQuotes');
    assert.match(await route('config sticker bad-name'),/字母、数字和下划线/);
    assert.match(await route('s r'),/单独使用/);assert.match(await route('s'),/请回复/);assert.match(await route('s',message(10,'text')),/不包含媒体/);
    const image={...message(10,''),media:new Api.MessageMediaPhoto({}),downloadMedia:async()=>photo};
    assert.match(await route('s',image),/成功/);assert.equal(uploads.length,1);assert.ok(calls.some(c=>c.className==='messages.UploadMedia'));
    packExists=false;assert.match(await route('s',image),/创建竣工/);assert.equal(uploads.length,2);
    for(const mime of ['image/webp','application/x-tgsticker','video/webm']) {
      calls=[];const sticker={...message(10,''),media:new Api.MessageMediaDocument({document:{id:33,accessHash:44,mimeType:mime,attributes:[new Api.DocumentAttributeSticker({})]}})};
      packExists=true;assert.match(await route('s',sticker),/成功/);assert.equal(uploads.length,2,'original sticker is reused without conversion');
      packExists=false;assert.match(await route('s',sticker),/创建竣工/);
      const create=calls.find(c=>c.className==='stickers.CreateStickerSet');assert.equal(!!create.animated,mime==='application/x-tgsticker');assert.equal(!!create.videos,mime==='video/webm');
    }
  } finally {fs.unlinkSync(plugin.configPath);fs.rmdirSync(configDir);}
  console.log('PASS: help, configuration persistence/validation, API reset/isolation, photo upload and existing/new sticker packs, static/TGS/video sticker preservation (mock Telegram).');
  console.log('PASS: syntax/rendering; unboxed single-line full names; proportional sizing; combined p/r/n/t; quoted/legacy parsing; removed count/position caps; 12-message pagination; rename scope; cross-image sender restoration; partial-send errors and cleanup; media/API compatibility.');
})().catch(e => {console.error(e); process.exitCode = 1;});
