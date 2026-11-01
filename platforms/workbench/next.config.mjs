import {readFileSync} from 'node:fs';
// `./lab services deploy` builds into the directory the running service reads; set
// WORKBENCH_NEXT_DIST only to stage a build without replacing it.
const platform=JSON.parse(readFileSync(new URL('../platform.json',import.meta.url),'utf8'));
export default {distDir:process.env.WORKBENCH_NEXT_DIST??platform.next_dist};
