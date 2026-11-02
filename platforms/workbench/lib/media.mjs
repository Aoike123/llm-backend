import {apiRoot} from './storage.mjs';
// Synchronous API media without a job directory, served as /artifacts/<name>.
export const artifactsDirectory=()=>apiRoot()+'/';
// Anything that fails before the backend accepted the work left nothing behind.
export async function beforeSubmission(work) {
  try {return await work();} catch(e) {e.code='NOT_SUBMITTED';throw e;}
}
