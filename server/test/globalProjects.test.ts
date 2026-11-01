// Only small throwaway roots. Never open the operator's logs or registry.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureContext, resetContextConfig, withVault } from '../context/config';
import { makeProject, readProject, listProjects, deleteProjectFiles, restoreProjectFiles, renameProject } from '../context/projects';
import { registeredFolder, registeredFolders, setFolderWalls, FOLDERS_FILE } from '../projectFolders';
import { ownerOfFolder, projectsList } from '../projectRoutes';
let root = '';
afterEach(() => { resetContextConfig(); if (root) rmSync(root, {recursive:true, force:true}); });
function fixture() {
 root=mkdtempSync(join(tmpdir(),'vc-global-projects-'));
 const owner=join(root,'defaultvault'), school=join(root,'school2'), code=join(root,'code'), folder=join(root,'external','Physics');
 for(const p of [owner,school,code,folder]) { mkdirSync(p,{recursive:true}); setFolderWalls(p,{home:root,protect:()=>[]}); }
 configureContext({vault:owner, conversationRoot:owner, vaults:()=>[owner,school,code]});
 return {owner,school,code,folder, refs:[{name:'Main',path:owner,main:true},{name:'school2',path:school},{name:'code',path:code}]};
}
describe('global project ownership, independent file workspaces',()=>{
 it('registers once globally from any workspace; project cwd, memory and rules agree everywhere',()=>{
 const f=fixture(); writeFileSync(join(f.folder,'AGENTS.md'),'Physics instructions');
 const p=withVault(f.school,()=>makeProject(f.folder)); expect(p).toHaveProperty('slug','physics');
 writeFileSync(join(f.folder,'.vault-chat','project-memory.md'),'original memory');
 writeFileSync(join(f.folder,'.vault-chat','rules.md'),'original rules');
 for(const workspace of [f.school,f.code,f.owner]) withVault(workspace,()=>{
 expect(listProjects().map(p=>p.slug)).toEqual(['physics']);
 expect(readProject('physics')).toMatchObject({folder:f.folder,notes:'original memory',rules:'original rules'});
 expect(registeredFolder(workspace,'physics')).toBe(f.folder);
 });
 expect(existsSync(join(f.owner,FOLDERS_FILE))).toBe(true);
 expect(existsSync(join(f.school,FOLDERS_FILE))).toBe(false);
 expect(existsSync(join(f.code,FOLDERS_FILE))).toBe(false);
 expect(ownerOfFolder(join(f.school,'nested'),f.refs).path).toBe(f.owner);
 expect(projectsList(f.refs).projects).toHaveLength(1);
 expect(projectsList(f.refs).projects[0]).not.toHaveProperty('vault');
 });
 it('delete/restore from another workspace keeps the original folder and memory',()=>{
 const f=fixture(); withVault(f.school,()=>makeProject(f.folder));
 const memory=readFileSync(join(f.folder,'.vault-chat','project-memory.md'),'utf8');
 withVault(f.code,()=>deleteProjectFiles('physics'));
 expect(withVault(f.school,()=>listProjects())).toEqual([]);
 expect(existsSync(f.folder)).toBe(true);
 withVault(f.owner,()=>restoreProjectFiles('physics'));
 expect(withVault(f.code,()=>readProject('physics'))?.notes).toBe(memory);
 expect(registeredFolders(f.school)).toEqual(registeredFolders(f.code));
 });
 it('reads unmigrated legacy registry/memory without copying peers; canonical delete and restore shadow it',()=>{
 const f=fixture(), peer=join(root,'external','Chemistry'); mkdirSync(peer,{recursive:true});
 mkdirSync(join(f.school,'.vault-chat','local'),{recursive:true});
 writeFileSync(join(f.school,FOLDERS_FILE),JSON.stringify({folders:{physics:{path:f.folder,at:'2026-01-01'},chemistry:{path:peer,at:'2026-01-02'}},deleted:{}}));
 mkdirSync(join(f.school,'agent-projects','physics'),{recursive:true});
 writeFileSync(join(f.school,'agent-projects','physics','project.md'),'legacy original memory');
 const original=readFileSync(join(f.school,FOLDERS_FILE),'utf8');
 expect(withVault(f.code,()=>readProject('physics'))?.notes).toBe('legacy original memory');
 expect(existsSync(join(f.owner,FOLDERS_FILE))).toBe(false);
 withVault(f.code,()=>deleteProjectFiles('physics'));
 expect(withVault(f.school,()=>listProjects()).map(p=>p.slug)).toEqual(['chemistry']);
 expect(JSON.parse(readFileSync(join(f.owner,FOLDERS_FILE),'utf8')).folders).toEqual({});
 withVault(f.owner,()=>restoreProjectFiles('physics'));
 expect(withVault(f.code,()=>readProject('physics'))?.notes).toBe('legacy original memory');
 withVault(f.code,()=>renameProject('physics','Renamed physics'));
 expect(withVault(f.school,()=>readProject('physics'))?.notes).toBe('legacy original memory');
 expect(readFileSync(join(f.school,FOLDERS_FILE),'utf8')).toBe(original);
 expect(JSON.parse(readFileSync(join(f.owner,FOLDERS_FILE),'utf8')).folders).not.toHaveProperty('chemistry');
 });

 it('does not borrow same-slug memory from another registered folder; ambiguous legacy slugs require review',()=>{
 const f=fixture(), replacement=join(root,'external','Other physics'); mkdirSync(replacement);
 for(const workspace of [f.school,f.code,f.owner]) mkdirSync(join(workspace,'.vault-chat/local'),{recursive:true});
 mkdirSync(join(f.school,'agent-projects/physics'),{recursive:true});
 writeFileSync(join(f.school,'agent-projects/physics/project.md'),'NOT THIS PROJECT');
 writeFileSync(join(f.school,FOLDERS_FILE),JSON.stringify({folders:{physics:{path:f.folder,at:'2026-01-01'}},deleted:{}}));
 writeFileSync(join(f.code,FOLDERS_FILE),JSON.stringify({folders:{physics:{path:replacement,at:'2026-01-01'}},deleted:{}}));
 expect(()=>withVault(f.owner,()=>listProjects())).toThrow(/offline review required/);
 writeFileSync(join(f.owner,FOLDERS_FILE),JSON.stringify({folders:{physics:{path:replacement,at:'2026-01-01'}},deleted:{}}));
 expect(withVault(f.owner,()=>readProject('physics'))?.notes).toBe('');
 });

});
