const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const run=promisify(execFile);
const dependencies=process.env.STSAVE_TEST_DEPS?createRequire(path.resolve(process.env.STSAVE_TEST_DEPS,'package.json')):require;
const ts=dependencies('typescript'),sharp=dependencies('sharp');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'stsave-test-'));
const configPath=path.join(temp,'config.json');
const source=fs.readFileSync(path.resolve(__dirname,'../plugins/stsave.ts'),'utf8');
const compiled=ts.transpileModule(source,{fileName:'stsave.ts',reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
assert.equal(compiled.diagnostics.length,0,'TypeScript syntax');
const classes=new Map();
function apiClass(name){if(!classes.has(name))classes.set(name,class{constructor(value){Object.assign(this,value);this.className=name;}});return classes.get(name);}
const Api=new Proxy({},{get(_,key){
  if(key==='messages'||key==='stickers')return new Proxy({},{get(_namespace,name){return apiClass(`${key}.${String(name)}`);}});
  return apiClass(String(key));
}});
let state;
function reset(options={}){
  state={calls:[],uploads:[],paths:[],commands:[],downloads:0,deleted:0,create:false,originalError:'',retryError:'',...options};
  fs.writeFileSync(configPath,JSON.stringify({pack:'TestQuotes',defaultEmoji:'⭐'}));
}
const trackedExecFile=()=>{throw Error('Use promisified execFile');};
trackedExecFile[promisify.custom]=async(file,args,options)=>{
  state.commands.push({file,args});
  if(state.processError)throw Object.assign(Error(`spawn ${file} ENOENT`),{code:'ENOENT'});
  return run(file,args,options);
};
const client={
  downloadMedia:async()=>{state.downloads++;return state.input;},
  sendFile:async(peer,options)=>{
    assert.equal(peer,'me');state.paths.push(options.file);
    const bytes=fs.readFileSync(options.file);state.uploads.push({bytes,options});
    if(state.uploadError)throw Error('synthetic upload failure');
    const size=options.attributes.find(attribute=>attribute instanceof Api.DocumentAttributeImageSize);
    assert.ok(size,'uploaded sticker has explicit dimensions');assert.equal(size.w,512);assert.equal(size.h,512);
    if(options.mimeType==='video/webm'){
      const video=options.attributes.find(attribute=>attribute instanceof Api.DocumentAttributeVideo);
      assert.ok(video,'WebM upload includes video metadata');assert.equal(video.w,512);assert.equal(video.h,512);
      assert.equal(video.nosound,true);assert.ok(video.duration>0&&video.duration<=3.001);
    }
    return {media:new Api.MessageMediaDocument({document:new Api.Document({id:999,accessHash:888,fileReference:Buffer.from('new'),mimeType:options.mimeType,attributes:options.attributes})}),
      delete:async options=>{assert.equal(options.revoke,true);state.deleted++;}};
  },
  invoke:async request=>{
    if(request.className==='messages.GetStickerSet'){
      if(state.create)throw {errorMessage:'STICKERSET_INVALID'};
      return new Api.messages.StickerSet({set:{creator:true,count:1},documents:[]});
    }
    if(request.className==='stickers.AddStickerToSet'||request.className==='stickers.CreateStickerSet'){
      state.calls.push(request);const item=request.sticker||request.stickers[0];
      assert.ok(item.document instanceof Api.InputDocument);
      assert.equal(request.shortName||request.stickerset.shortName,'TestQuotes','repair keeps the same target pack');
      if(item.document.id===123&&state.originalError)throw {errorMessage:state.originalError};
      if(item.document.id===999&&state.retryError)throw {errorMessage:state.retryError};
      return {};
    }
    throw Error('Unexpected API call '+request.className);
  },
};
const exportsObj={};
vm.runInNewContext(compiled.outputText+'\nexports._convert=convertVideoToWebm;exports._probe=probeStickerVideo;exports._friendly=friendlyError;',{
  exports:exportsObj,Buffer,console:{error(){},warn(){}},require(name){
    if(name==='teleproto')return {Api};
    if(name==='sharp')return sharp;
    if(name==='child_process')return {execFile:trackedExecFile};
    if(name==='@utils/pluginBase')return {Plugin:class{}};
    if(name==='@utils/pluginManager')return {getPrefixes:()=>['.']};
    if(name==='@utils/runtimeManager')return {getGlobalClient:async()=>client};
    if(name==='@utils/pathHelpers')return {createDirectoryInAssets:()=>temp};
    if(name==='@utils/authGuards')return {safeGetMe:async()=>new Api.User({id:7,username:'tester'})};
    if(name==='@utils/safeGetMessages')return {safeGetReplyMessage:async message=>message.reply};
    return require(name);
  },
});
const plugin=exportsObj.default;
function sticker(mime='video/webm'){
  return {sticker:new Api.Document({id:123,accessHash:456,fileReference:Buffer.from('old'),mimeType:mime,attributes:[new Api.DocumentAttributeSticker({alt:'🌸'}),new Api.DocumentAttributeVideo({w:100,h:100,duration:4})]})};
}
async function command(reply,text='.stsave'){
  const edits=[];
  await plugin.cmdHandlers[text.split(/\s/)[0]==='.st'?'st':'stsave']({message:text,isReply:true,reply,edit:async options=>edits.push(options.text)});
  for(const file of state.paths)assert.equal(fs.existsSync(file),false,'temporary upload file is cleaned');
  for(const {file,args}of state.commands){
    const files=file==='ffprobe'?[args.at(-1)]:[args[args.indexOf('-i')+1],args.at(-1)];
    for(const candidate of files)if(path.basename(candidate||'').startsWith('stsave_video_'))assert.equal(fs.existsSync(candidate),false,'temporary conversion file is cleaned');
  }
  return edits.at(-1);
}
async function inspectVideo(bytes){
  const file=path.join(temp,'inspect.webm');fs.writeFileSync(file,bytes);
  const {stdout}=await run('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',file]);
  const info=JSON.parse(stdout),video=info.streams.find(stream=>stream.codec_type==='video');
  assert.equal(video.width,512);assert.equal(video.height,512);assert.equal(video.codec_name,'vp9');
  assert.ok(Number(info.format.duration)>0&&Number(info.format.duration)<=3.001);assert.ok(Number(video.nb_read_frames)>1);
  const [n,d]=video.avg_frame_rate.split('/').map(Number);assert.ok(n/d<=30);
  assert.ok(info.streams.every(stream=>stream.codec_type!=='audio'));assert.ok(bytes.length<=256*1024);
  assert.equal(video.sample_aspect_ratio,'1:1');
  return file;
}
async function frame(file,time){
  const {stdout}=await run('ffmpeg',['-v','error','-c:v','libvpx-vp9','-i',file,'-ss',String(time),'-frames:v','1','-f','image2pipe','-c:v','png','pipe:1'],{encoding:'buffer',maxBuffer:5*1024*1024});
  return sharp(stdout).ensureAlpha().raw().toBuffer({resolveWithObject:true});
}
(async()=>{
  for(const [i,color]of ['#ff3333','#3388ff'].entries())await sharp(Buffer.from(`<svg width="100" height="100"><rect x="20" y="20" width="60" height="60" fill="${color}"/></svg>`)).png().toFile(path.join(temp,`frame_0${i}.png`));
  const originalPath=path.join(temp,'small-alpha.webm');
  await run('ffmpeg',['-v','error','-y','-stream_loop','-1','-framerate','2','-i',path.join(temp,'frame_%02d.png'),'-t','4','-an','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0',originalPath]);
  const input=fs.readFileSync(originalPath);
  for(const mime of ['video/webm','application/x-tgsticker','image/webp']){
    reset({input});assert.match(await command(sticker(mime)),/贴纸保存成功/);
    assert.equal(state.calls.length,1);assert.equal(state.calls[0].sticker.document.id,123);
    assert.equal(state.downloads,0);assert.equal(state.uploads.length,0);assert.equal(state.commands.length,0,'valid existing sticker is reused without conversion');
  }
  console.log('PASS: existing WebM, TGS and static stickers keep their original documents.');
  reset({input,originalError:'STICKER_VIDEO_DIMENSIONS'});
  const original=sticker(),before=original.sticker.attributes[1].w;
  assert.match(await command(original,'.st'),/贴纸保存成功/);
  assert.equal(state.calls.length,2);assert.equal(state.downloads,1);assert.equal(state.uploads.length,1);assert.equal(state.deleted,1);
  assert.equal(state.calls[1].sticker.emoji,'🌸');assert.equal(original.sticker.attributes[1].w,before,'source sticker is not modified');
  const fixed=await inspectVideo(state.uploads[0].bytes);
  const first=await frame(fixed,0),next=await frame(fixed,.6);
  assert.equal(first.data[3],0,'transparent corner survives VP9 decoding and conversion');
  const center=(256*first.info.width+256)*4;
  assert.equal(first.data[center+3],255);assert.ok(first.data[center]>first.data[center+2]+100);
  assert.ok(next.data[center+2]>next.data[center]+100,'animation changes frame, rather than becoming a static image');
  console.log('PASS: dimension rejection repairs a real 100px transparent WebM to 512px VP9, <=3s, <=30 FPS, <=256KB; alpha and animation survive.');
  reset({input,create:true,originalError:'STICKER_VIDEO_DIMENSIONS'});
  assert.match(await command(sticker()),/贴纸保存成功/);assert.equal(state.calls.length,2);assert.ok(state.calls.every(call=>call.className==='stickers.CreateStickerSet'));
  assert.equal(state.calls[1].stickers[0].emoji,'🌸');
  reset({input,originalError:'STICKER_VIDEO_DIMENSIONS',retryError:'STICKER_VIDEO_DIMENSIONS'});
  assert.match(await command(sticker()),/视频贴纸尺寸不符合/);assert.equal(state.calls.length,2);assert.equal(state.uploads.length,1,'only one repair attempt');
  for(const error of ['FLOOD_WAIT_60','STICKERS_TOO_MUCH']){
    reset({input,originalError:error});assert.match(await command(sticker()),/保存失败/);assert.equal(state.uploads.length,0);assert.equal(state.downloads,0,'unrelated failures do not trigger conversion');
  }
  reset({input,originalError:'STICKER_VIDEO_DIMENSIONS',uploadError:true});
  assert.match(await command(sticker()),/synthetic upload failure/);assert.equal(state.calls.length,1);
  reset({input,originalError:'STICKER_VIDEO_DIMENSIONS',processError:true});
  assert.match(await command(sticker()),/需要安装 FFmpeg/);assert.equal(state.uploads.length,0);
  console.log('PASS: add/create retry uses the same pack and emoji; retry is bounded; unrelated failures and upload/dependency failures clean up.');
  const mp4=path.join(temp,'audio.mp4');
  await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=red:s=120x80:r=60:d=0.3','-f','lavfi','-i','sine=frequency=440:duration=0.3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',mp4]);
  reset({input:fs.readFileSync(mp4)});
  const videoMessage={media:new Api.MessageMediaDocument({document:new Api.Document({mimeType:'video/mp4',attributes:[]})})};
  assert.match(await command(videoMessage),/贴纸保存成功/);assert.equal(state.uploads.length,1);
  const converted=await inspectVideo(state.uploads[0].bytes),convertedFrame=await frame(converted,0);
  assert.equal(convertedFrame.data[3],0,'letterbox padding is transparent even for opaque MP4 input');
  const gif=path.join(temp,'animation.gif');
  await run('ffmpeg',['-v','error','-y','-framerate','5','-i',path.join(temp,'frame_%02d.png'),'-t','0.4','-loop','0',gif]);
  reset({input:fs.readFileSync(gif)});
  assert.match(await command({media:new Api.MessageMediaDocument({document:new Api.Document({mimeType:'image/gif',attributes:[]})})}),/贴纸保存成功/);
  await inspectVideo(state.uploads[0].bytes);
  console.log('PASS: MP4/GIF conversion sends matching image/video size attributes, removes audio, and preserves transparent padding.');
  reset();assert.match(await command(undefined,'.stsave help'),/贴纸保存插件/);
  assert.equal(exportsObj._friendly({errorMessage:'STICKER_VIDEO_DIMENSIONS'}).includes('512px'),true);
  console.log('PASS: stsave local regressions; all Telegram operations mocked, actual ffmpeg/ffprobe used.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  const resolved=fs.realpathSync(temp),base=fs.realpathSync(os.tmpdir())+path.sep;
  if(!resolved.startsWith(base)||!path.basename(resolved).startsWith('stsave-test-'))throw Error('Unsafe test cleanup target');
  for(const entry of fs.readdirSync(resolved)){const file=path.join(resolved,entry);if(fs.statSync(file).isFile())fs.unlinkSync(file);}
  fs.rmdirSync(resolved);
});
