import {ROOT} from './backend.mjs';
// Synchronous API media without a job directory is served from here as /artifacts/<name>.
export const ARTIFACTS=ROOT+'workspace/outputs/api/';
// Anything that fails before the backend accepted the work left nothing behind.
export async function beforeSubmission(work) {
  try {return await work();} catch(e) {e.code='NOT_SUBMITTED';throw e;}
}
