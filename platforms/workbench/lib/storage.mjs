// Where everything is stored, from the single `storage` block of platforms/platform.json (see
// .workbench/storage.py for the layout). The artifacts root must hold the marker file: without it
// the resource disk counts as offline and media requests fail instead of writing elsewhere.
import {existsSync,readFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
export const STORAGE=JSON.parse(readFileSync(ROOT+'platforms/platform.json','utf8')).storage;
const path=value=>isAbsolute(value)?value:join(ROOT,value);
export const stateRoot=()=>process.env.MEDIA_STATE_ROOT??path(STORAGE.state);
export const artifactsRoot=()=>process.env.MEDIA_ARTIFACTS_ROOT??path(STORAGE.artifacts);
export const artifactsOnline=(root=artifactsRoot())=>existsSync(join(root,STORAGE.marker));
export const offline=()=>Object.assign(new Error('Artifact storage is offline: the resource disk is not mounted'),{status:503,code:'ARTIFACT_STORAGE_OFFLINE'});
export function requireArtifacts(){if(!artifactsOnline())throw offline();return artifactsRoot();}
export const canvasRoot=()=>join(artifactsRoot(),'canvas');
export const apiRoot=()=>join(artifactsRoot(),'api');
export const importRoots=()=>STORAGE.import_roots;
