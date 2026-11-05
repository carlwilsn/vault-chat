import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeTauri, makeTempVault } from './fakes.ts';
import { FakeBox } from './fakeBox.ts';
const school=makeTempVault('vc-global-school-'), code=makeTempVault('vc-global-code-');
const fake=installFakeTauri(school), box=new FakeBox();
fake.setHandler('vault_box_config', ({vault})=>({box:box.url,vault:vault===school?'school2':'code'}));
fake.setHandler('box_get_json', async ({url,timeoutMs})=>{const r=await fetch(url,{signal:AbortSignal.timeout(timeoutMs??20000)});return {status:r.status,body:await r.text()};});
fake.setHandler('box_post_json',async({url,body})=>{const r=await fetch(url,{method:'POST',body,headers:{'content-type':'application/json'}});return {status:r.status,body:await r.text()};});
const {useStore}=await import('../../src/store.ts');
const bc=await import('../../src/boxChat.ts');
const {openVaultAt}=await import('../../src/openVault.ts');
fake.setHandler('list_markdown_files',({vault})=>[{path:vault+'/README.md',name:'README.md',is_dir:false}]);
fake.setHandler('git_init_if_needed',()=>false);
async function until(fn:()=>boolean) { const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('fixture deadline');await new Promise(r=>setTimeout(r,10));} }
test('workspace switch preserves global project messages, running state and session; only file panes reset',async()=>{
 await box.start();
 try {
 box.create('project-physics','Physics'); box.startTurn('project-physics'); box.user('project-physics','original-client','original question'); box.stream('project-physics','assistant','original answer'); box.endTurn('project-physics');
 useStore.setState({vaultPath:school}); await useStore.getState().loadConversations();
 await until(()=>useStore.getState().conversations.some(c=>c.id==='project-physics'));
 useStore.getState().selectConversation('project-physics'); await until(()=>useStore.getState().messages.length===2);
 const session=bc._boxChatSession(), conv=useStore.getState().activeConversationId;
 box.startTurn('project-physics'); const stream=box.open('project-physics','assistant'); stream.delta('in flight');
 await until(()=>useStore.getState().busy && useStore.getState().streamingText==='in flight');
 const messages=useStore.getState().messages;
 useStore.setState({currentFile:school+'/a.md',currentContent:'school file'});
 await openVaultAt(code);
 assert.equal(useStore.getState().activeConversationId,conv);
 assert.strictEqual(useStore.getState().messages,messages);
 assert.equal(useStore.getState().busy,true);
 assert.equal(useStore.getState().streamingText,'in flight');
 assert.equal(useStore.getState().currentFile,null);
 assert.equal(useStore.getState().currentContent,'');
 await bc.startBoxChat(code);
 assert.strictEqual(bc._boxChatSession(),session);
 assert.equal(useStore.getState().activeConversationId,conv);
 assert.equal(bc.boxChatOn(),true);
 assert.ok(!box.intents.some(i=>i.type==='stop'),'workspace picker never sends Stop');
 const literal=school+'/Poll.md <rules>not rewritten</rules>';
 await bc.boxSend({text:literal,contextPreamble:literal,convId:conv});
 assert.equal(box.intents.at(-1).text,literal);
 assert.equal(box.intents.at(-1).context,literal);
 assert.equal(box.seen.filter(r=>r.route==='POST /api/v2/intent').at(-1)?.vault,'code');
 await openVaultAt(school); await bc.startBoxChat(school);
 assert.strictEqual(bc._boxChatSession(),session);
 assert.equal(useStore.getState().activeConversationId,conv);
 } finally { bc.stopBoxChat(); await box.close(); }
});

test('a mounted inline popover pins only its absolute file workspace across a vault switch',async()=>{
 const file=school+'/private-side.md';
 useStore.setState({vaultPath:school,currentFile:file,currentContent:'private selection',inlinePromptCount:1});
 try {
  await openVaultAt(code);
  assert.equal(useStore.getState().vaultPath,code);
  assert.equal(useStore.getState().currentFile,file);
  assert.equal(useStore.getState().currentContent,'private selection');
  assert.equal(useStore.getState().files[0].path,code+'/README.md');
  useStore.setState({inlinePromptCount:0});
  await openVaultAt(school);
  assert.equal(useStore.getState().currentFile,null);
  assert.equal(useStore.getState().currentContent,'');
 } finally {useStore.setState({inlinePromptCount:0});}
});
