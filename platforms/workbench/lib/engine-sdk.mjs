// What engine adapters may use from the gateway. Adapters import only this module, so the
// gateway can change its internals without touching engine packages.
export {call,ROOT} from './backend.mjs';
export {pause} from './core.mjs';
export {fail} from './media-store.mjs';

export {str,id,seed,list,choice,object,prompt,PROMPT_MAX_LENGTH,validateSchema} from './media-tools.mjs';

// A single-request backend that answered with an HTTP error has finished; only a lost answer is uncertain.
export const answered=async request=>{try{return await request();}catch(e){if(e.status)e.code='BACKEND_FAILED';throw e;}};
export {beforeSubmission} from './media.mjs';
