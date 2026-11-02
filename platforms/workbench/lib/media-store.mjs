import {mkdir,open,rename,readFile,readdir,rm,stat,statfs,chmod} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {join,dirname} from 'node:path';
import {STORAGE,stateRoot,artifactsRoot,artifactsOnline,offline} from './storage.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import sharp from 'sharp';
export const uid=prefix=>prefix+'_'+randomUUID().replaceAll('-','');
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export async function atomic(file,value){
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomUUID()+'.tmp';const fd=await open(tmp,'wx',0o600);
  try{await fd.writeFile(JSON.stringify(value,null,2)+'\n');await fd.sync();}finally{await fd.close();}
  await rename(tmp,file);const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
}
// Job records, imported materials and telemetry live in the state root (internal NVMe); generated
// media in the artifacts root (resource disk) under <kind>/<YYYY-MM>/<job_id>. Both come from the
// storage block of platforms/platform.json; tests pass `root` to keep everything in one directory.
export class MediaStore{
  constructor({root,state=root??stateRoot(),artifacts=root??artifactsRoot(),requireMarker=!root,maxBytes=STORAGE.quota_gib*2**30,minFreeBytes=STORAGE.min_free_gib*2**30}={}){
    Object.assign(this,{state,artifacts,requireMarker,maxBytes,minFreeBytes});this.root=artifacts;
    this.images=join(artifacts,'images');this.videos=join(artifacts,'videos');this.audio=join(artifacts,'audio');
    this.assets=join(state,'materials');this.jobs=join(state,'jobs');this.telemetry=join(state,'telemetry');this.assetIndex=new Map();this.uploads=0;this.usedBytes=0;this.mediaSizes=new Map();
  }
  online(){return !this.requireMarker||artifactsOnline(this.artifacts);}
  async open(){
    for(const dir of [this.assets,this.jobs,this.telemetry])await mkdir(dir,{recursive:true,mode:0o700});
    for(const id of await readdir(this.assets)){
      if(!/^asset_[a-f0-9]{32}$/.test(id))continue;
      try{const asset=JSON.parse(await readFile(join(this.assets,id,'asset.json'),'utf8'));this.assetIndex.set(id,asset);}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    // The gateway starts with the resource disk offline; media requests fail until it returns.
    if(this.online())await this.measure();
    return this;
  }
  // Include orphaned/staging media after a crash, so incomplete files cannot bypass quota.
  async measure(){
    const size=async directory=>{let total=0;let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return 0;throw e;}for(const entry of entries){const path=join(directory,entry.name);if(entry.isDirectory())total+=await size(path);else if(entry.isFile()){const bytes=(await stat(path)).size;this.mediaSizes.set(path,bytes);total+=bytes;}}return total;};
    for(const dir of [this.images,this.videos,this.audio])await mkdir(dir,{recursive:true,mode:0o700});
    this.usedBytes=await size(this.assets)+await size(this.images)+await size(this.videos)+await size(this.audio);this.measured=true;
  }
  account(file,bytes){this.usedBytes+=bytes-(this.mediaSizes.get(file)??0);this.mediaSizes.set(file,bytes);}
  async quota(reserve=0){
    if(!this.online())throw offline();
    if(!this.measured)await this.measure();
    if(this.usedBytes+reserve>this.maxBytes)throw fail('Media storage quota reached; archive old media before submitting more',507);
    for(const root of [this.artifacts,this.state]){const fs=await statfs(root);if(fs.bavail*fs.bsize<reserve+this.minFreeBytes)throw fail('Insufficient free disk space for media',507);}
  }
  getAsset(owner,id,kind){const a=this.assetIndex.get(id);if(!a||a.owner_id!==owner||(kind&&a.kind!==kind))throw fail('Asset not found',404);return a;}
  async import(owner,kind,stream){
    if(!['image','video','audio'].includes(kind))throw fail('Invalid media kind');
    if(this.uploads>=2)throw fail('Too many simultaneous imports',429);
    if(this.assetIndex.size>=1000||[...this.assetIndex.values()].filter(a=>a.owner_id===owner).length>=200)throw fail('Asset count quota reached',429);
    // Audio may arrive inside a long video; only its soundtrack is kept.
    const limit=(kind==='image'?16:kind==='audio'?1024:128)*2**20;this.uploads++;try{await this.quota(this.uploads*128*2**20);}catch(e){this.uploads--;throw e;}
    const id=uid('asset'),directory=join(this.assets,id),source=join(directory,'upload');let bytes=0;
    try{
      await mkdir(directory,{mode:0o700});
      await pipeline(stream,new Transform({transform(chunk,_,done){bytes+=chunk.length;done(bytes>limit?fail('Media file exceeds size limit',413):null,chunk);}}),createWriteStream(source,{flags:'wx',mode:0o600}));
      const fd=await open(source,'r');try{await fd.sync();}finally{await fd.close();}
      if(!bytes)throw fail('Empty media file');
      let file=source,metadata={};
      if(kind==='image'){
        file=join(directory,'source.png');
        const image=sharp(source,{limitInputPixels:16777216,animated:false,failOn:'warning'}),info=await image.metadata();
        if(!['png','jpeg','webp'].includes(info.format)||(info.pages??1)>1)throw fail('Use a single PNG, JPEG or WebP image');
        await image.rotate().png().toFile(file);await chmod(file,0o600);await rm(source);const normalized=await sharp(file).metadata();
        metadata={width:normalized.width,height:normalized.height,has_alpha:!!normalized.hasAlpha};bytes=(await stat(file)).size;
        if(bytes>16*2**20)throw fail('Normalized image exceeds 16 MiB');
      }else if(kind==='audio'){
        const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const run=promisify(execFile);
        const formats='wav,mp3,flac,ogg,aac,mov,matroska,webm';
        let probe;try{probe=JSON.parse((await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',formats,'-show_streams','-show_format','-of','json',source],{timeout:30000,maxBuffer:2**20})).stdout);}catch{throw fail('Invalid audio file');}
        const audio=probe.streams?.find(s=>s.codec_type==='audio'),seconds=Number(audio?.duration??probe.format?.duration);
        // Full length is kept: separation and transcription take long recordings; engines that need
        // short references (H3, voice cloning) trim their own copy.
        if(!audio||!Number.isFinite(seconds)||seconds<=0||seconds>1800.05)throw fail('Audio must contain at most 30 minutes');
        file=join(directory,'source.wav');
        try{await run('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-format_whitelist',formats,'-i',source,'-map','0:a:0','-ar','44100','-ac',String(Math.min(2,Number(audio.channels)||1)),'-c:a','pcm_s16le','-y',file],{timeout:300000,maxBuffer:2**20});}catch{throw fail('Audio could not be normalized');}
        await chmod(file,0o600);await rm(source);bytes=(await stat(file)).size;metadata={seconds,sample_rate:44100,channels:Math.min(2,Number(audio.channels)||1)};
      }else{
        // ffprobe never receives a caller-supplied path or URL.
        const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
        let probe;try{probe=JSON.parse((await promisify(execFile)('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts','-show_streams','-show_format','-of','json',source],{timeout:30000,maxBuffer:2**20})).stdout);}catch{throw fail('Invalid video file');}
        const v=probe.streams?.find(s=>s.codec_type==='video'),seconds=Number(v?.duration??probe.format?.duration);
        if(!v||!Number.isFinite(seconds)||seconds<2||seconds>15.05||v.width*v.height>4096*2160)throw fail('Video must be 2–15 seconds and ≤4096×2160 pixels');
        metadata={width:v.width,height:v.height,seconds,has_audio:probe.streams.some(s=>s.codec_type==='audio')};
        file=join(directory,'source.video');await rename(source,file);
      }
      const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);
      const asset={asset_id:id,owner_id:owner,kind,file,bytes,sha256:digest.digest('hex'),...metadata,created_at:new Date().toISOString()};
      await atomic(join(directory,'asset.json'),asset);this.assetIndex.set(id,asset);this.account(file,bytes);return this.publicAsset(asset);
    }catch(e){await rm(directory,{recursive:true,force:true});throw e;}finally{this.uploads--;}
  }
  publicAsset({file,owner_id,...asset}){return asset;}
  // One directory per month keeps the resource disk browsable as jobs accumulate.
  // Transcripts come from the audio tool and sit with its other results.
  outputDirectory(job){return join(job.kind==='image'?this.images:job.kind==='video'?this.videos:this.audio,(job.created_at??new Date().toISOString()).slice(0,7),job.job_id);}
}
