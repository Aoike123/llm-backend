// HTTP status/type describe the broad category; code identifies the exact cause.
export const API_ERRORS=Object.freeze({
  API_KEY_REQUIRED:{status:401,type:'authentication_error',message:'请提供 API 密钥'},
  API_KEY_INVALID:{status:401,type:'authentication_error',message:'API 密钥无效、已停用或已删除'},
  API_KEY_CONCURRENCY_LIMIT_EXCEEDED:{status:429,type:'rate_limit_error',message:'当前密钥的并发请求数已达到上限，请等待该密钥的已有请求完成'},
  GLOBAL_CONCURRENCY_LIMIT_EXCEEDED:{status:429,type:'rate_limit_error',message:'所有密钥的总并发请求数已达到上限，请等待已有请求完成'},
  API_KEY_REQUEST_RATE_LIMIT_EXCEEDED:{status:429,type:'rate_limit_error',message:'当前密钥的每分钟请求数已达到上限，请等待计数窗口重置'},
  GLOBAL_REQUEST_RATE_LIMIT_EXCEEDED:{status:429,type:'rate_limit_error',message:'所有密钥的每分钟总请求数已达到上限，请等待计数窗口重置'},
  API_KEY_QUEUE_FULL:{status:429,type:'rate_limit_error',message:'当前密钥的等待队列已满，请等待已有任务完成后再提交'},
  GLOBAL_QUEUE_FULL:{status:429,type:'rate_limit_error',message:'服务的总等待队列已满，请稍后再提交'},
  ADMISSION_BODY_BUDGET_EXCEEDED:{status:429,type:'rate_limit_error',message:'等待请求的正文内存预算已满，请等待已有任务完成后再提交'},
  ADMISSION_QUEUE_WAIT_TIMEOUT:{status:503,type:'server_error',message:'等待请求名额超时，任务尚未提交到引擎'},
  CLIENT_REQUEST_CANCELLED:{status:499,type:'request_cancelled',message:'客户端已断开，已移除尚未执行的排队请求'},
  KV_CAPACITY_WAIT_TIMEOUT:{status:429,type:'rate_limit_error',message:'Waiting for KV capacity timed out'},
  GPU_LEASE_QUEUE_TIMEOUT:{status:503,type:'server_error',message:'GPU lease queue timeout'},
});

export class ApiError extends Error {
  constructor(code,{details,retryAfterSeconds}={}) {
    const definition=API_ERRORS[code];
    if(!definition)throw new Error(`Unknown API error code: ${code}`);
    super(definition.message);
    Object.assign(this,{code,status:definition.status,type:definition.type,details,retryAfterSeconds});
  }
  toJSON(){return {error:{code:this.code,type:this.type,message:this.message,...(this.details?{details:this.details}:{})}};}
}
