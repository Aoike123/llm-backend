// MCP exposes independent image services and one approved native Goldfish workflow.
import {ID as BASE_ID,MODELS as MEDIA_MODELS,TOOLS as MEDIA_TOOLS,validateToolInput} from '../workbench/lib/media-manifest.mjs';
export const ID={...BASE_ID,version:'0.4.1'};
export const WORKFLOWS=[{id:'yz-h3-ultimate-original',name:'H3 视频生成（原版工作流）',tool:'generate_video',execution_runtime:'comfy',reference_images:9,reference_videos:3,reference_audios:3,controls:['参考组与槽位','六层 LoRA 开关与强度','SelfLift 采样','画幅与分辨率','显存优化与预览','音视频输出']}];
export const MODELS=MEDIA_MODELS.filter(model=>model.kind==='image'||model.kind==='audio');
export const TOOLS=MEDIA_TOOLS.map(tool=>{
 if(tool.name==='list_media_models')return {...tool,description:'List independent image/audio models and the registered Goldfish native workflow. Does not load a model.'};
 if(tool.name==='import_media')return {...tool,description:'导入允许目录内的图像、视频或音频，返回所属用户的 asset_id。供图像工具与视频参考分支使用；不会加载模型。'};
 return tool;
});
export const validateInput=(name,input)=>validateToolInput(TOOLS,name,input);
