/** No service control, no implicit live paths. See global-conversations-offline.ts. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { assertHostStopped } from './offline-event-log.ts';
import { previewGlobalConversations, applyGlobalConversations, recoverGlobalConversations, rollbackGlobalConversations, type CohortOptions } from './global-conversations-offline.ts';
export async function globalConversationsCli(args: string[]) {
 const confirmation='--all-legacy-writers-and-supervisors-stopped';
 if(!args.includes(confirmation)) throw new Error('Explicit operator confirmation required: '+confirmation+'; advisory flock does not exclude old v22 writers. Requirements and the exact cohort must be reviewed/approved first.');
 args=args.filter(x=>x!==confirmation);
 const [mode,path,...extra]=args;
 if(!path||extra.length||!['preview','apply','recover','rollback'].includes(mode)) throw new Error('Usage: global-conversations-cli.ts preview COHORT.json | apply PREVIEW.json | recover APPLY.json | rollback APPLY.json '+confirmation);
 const hooks={assertStopped:assertHostStopped};
 await assertHostStopped();
 if(mode==='preview') {
  const options=JSON.parse(await readFile(resolve(path),'utf8')) as CohortOptions;
  return previewGlobalConversations(options,hooks);
 }
 if(mode==='apply') return applyGlobalConversations(resolve(path),hooks);
 if(mode==='recover') return recoverGlobalConversations(resolve(path),hooks);
 return rollbackGlobalConversations(resolve(path),hooks);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 globalConversationsCli(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error((e as Error).message);process.exitCode=1;});
}
