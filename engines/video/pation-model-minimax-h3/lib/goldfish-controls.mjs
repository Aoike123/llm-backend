// Public controls mirror original GUI groups. UI-only group toggles become graph bypasses.
const obj=properties=>({type:'object',properties,additionalProperties:false});
const num=(minimum,maximum,description)=>({type:'number',minimum,maximum,description});
const integer=(minimum,maximum,description)=>({type:'integer',minimum,maximum,description});
const bool=(value,description)=>({type:'boolean',default:value,description});
const choice=(values,description)=>({type:'string',enum:values,description});
export const GOLDFISH_LORAS=[
 ['dmad','53','minimax_h3_dmad_full_dareties_v4_step600_comfy_fro.safetensors',true,0.8000000000000002],
 ['mystic','400','MysticXXX_MMH3-V1.safetensors',true,0.35],
 ['combat','342','H3_Combat_V2.safetensors',false,0.6500000000000001],
 ['motion_speed','343','motion_speed_slider_mmh3_v1.1.safetensors',false,3.0000000000000004],
 ['motion_repair','344','Motion_Repair_V2.safetensors',false,0.3500000000000001],
 ['fight_flow','345','H3_Fight_Flow_V1.safetensors',false,0.3500000000000001]
];
export const GOLDFISH_CONTROLS={
 reference_slots:{...obj(Object.fromEntries([['images',9],['videos',3],['audios',3]].map(([key,maxItems])=>[key,{type:'array',items:{type:'boolean'},maxItems,description:'按对应素材数组顺序逐槽位开关，省略的位置默认开启；关闭保留输入槽位，但原生提示词标签按开启素材重新连续编号。'}]))),description:'原版各参考素材槽位独立开关。'},
 use_image_references:bool(true,'图像参考总开关；按数组顺序映射 Picture 1–9，未提供的槽位关闭。'),
 use_video_references:bool(true,'视频参考总开关；最多3段，合计≤15秒，预处理为24fps。'),
 use_audio_references:bool(true,'独立音频参考总开关；最多3段，合计≤15秒，须同时有图像或视频参考。'),
 reference_video_audio:bool(false,'使用参考视频自带的声音；仅对有音轨的视频生效。'),
 reference_image_size:choice(['match','max'],'参考图尺寸策略；原版 match。'),
 loras:{...obj(Object.fromEntries(GOLDFISH_LORAS.map(([key,,file,enabled,strength])=>[key,{...obj({enabled:bool(enabled,'启用此 LoRA；关闭时真正旁路节点。'),strength:{...num(-20,20,'LoRA 强度'),default:strength}}),description:file}]))),description:'原版六层 LoRA，顺序保持不变；默认仅 dmad、mystic 开启。'},
 resolution:obj({aspect_ratio:choice(['1:1 (Square)','2:3 (Portrait Photo)','3:2 (Photo)','3:4 (Portrait Standard)','4:3 (Standard)','9:16 (Portrait Widescreen)','16:9 (Widescreen)','21:9 (Ultrawide)'],'原版 16:9 (Widescreen)。'),megapixels:{...num(0.1,16,'原版1.5MP；尺寸始终按32对齐。'),default:1.5}}),
 sampling:obj({steps:{...integer(2,10000,'总步数；必须大于 transition_step。'),default:10},cfg:{...num(0,100,'原版1。'),default:1},transition_step:{...integer(1,9999,'SelfLift 由低分辨率转到高分辨率的步数，原版6。'),default:6},lowres_scale:{...num(.25,1,'低分辨率比例，原版0.6。'),default:.6},rho:{...num(0,1,'原版0；upscaler_model=none 时必须大于0，SelfLift-zero 建议从0.6开始。'),default:0},w_min:num(0,1,'原版0.5，须≤w_max。'),w_max:num(0,1,'原版1。'),upscaler_model:{...choice(['none','h3_upscaler_lms_v0.1.safetensors'],'原版专用放大模型；none 关闭该模型，须同时设置 rho>0。'),default:'h3_upscaler_lms_v0.1.safetensors'},highres_tiling:bool(false,'高分辨率分块。'),upscaler_unload:bool(true,'放大后卸载放大模型。')}),
 optimizations:obj({attention_enabled:bool(true,'旁路/启用原版 comfy kitchen attention 覆盖。'),sparse_enabled:bool(true,'旁路/启用原版 sol-attn 稀疏注意力。'),sparse_tau:num(0,4,'sol-attn tau，原版1.3。'),sparse_start:num(0,1,'稀疏注意力起始比例，原版0.2。'),sparse_end:num(0,1,'结束比例，原版1。'),sigma_shift_enabled:bool(true,'旁路/启用视频与音频 sigma shift。'),shift_video:num(.01,100,'原版12。'),shift_audio:num(.01,100,'原版3。'),feed_forward_enabled:bool(true,'旁路/启用前馈分块。'),chunks:integer(1,64,'前馈分块数，原版2。'),seq_threshold:{...integer(256,262144,'序列阈值，原版4096，须为256的倍数。'),multipleOf:256},low_vram_enabled:bool(true,'旁路/启用低显存注意力分块。'),head_chunks:integer(1,56,'注意力头分块数，原版4。'),preview_enabled:bool(true,'旁路/启用原版预览覆盖节点。')}),
 output:obj({include_audio:bool(true,'是否解码并合成生成音轨；不改变模型内部联合音视频采样。'),crf:{...integer(0,51,'H.264 CRF，原版19，越低质量越高。'),default:19},save_metadata:bool(true,'保存视频工作流元数据。'),trim_to_audio:bool(false,'将画面裁到音轨长度。'),pingpong:bool(false,'往返播放。'),loop_count:integer(0,100,'原版0。')})
};
export function validateGoldfishControls(input){
 const s=input.sampling??{},o=input.optimizations??{};
 if((s.transition_step??6)>=(s.steps??10))throw Error('sampling.transition_step must be less than steps');
 if((s.rho??0)===0&&s.upscaler_model==='none')throw Error('sampling.upscaler_model=none requires sampling.rho > 0 (default 0); set rho to 0.6 for SelfLift-zero or select h3_upscaler_lms_v0.1.safetensors');
 if((s.w_min??.5)>(s.w_max??1))throw Error('sampling.w_min must not exceed w_max');
 if((o.sparse_start??.2)>(o.sparse_end??1))throw Error('optimizations.sparse_start must not exceed sparse_end');
}

export function goldfishReferenceSlots(input,kind,values=[]){
 const group={images:'image',videos:'video',audios:'audio'}[kind];
 return input['use_'+group+'_references']===false?[]:values.flatMap((value,index)=>input.reference_slots?.[kind]?.[index]===false?[]:[{value,index}]);
}
