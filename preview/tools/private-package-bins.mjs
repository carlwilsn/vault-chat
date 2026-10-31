// npm's own bin-links, using only the pinned lock and genuine copied package metadata.
// No installs, package resolution, command shims, donor writes, or native binary changes.
import assert from 'node:assert/strict';
import {readFileSync,realpathSync,existsSync,lstatSync,readlinkSync,readdirSync} from 'node:fs';
import {resolve,join,isAbsolute,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const npm='/nix/store/y2j5pbj8x9kfgwgkd0hdrwm6aksszb44-nodejs-slim-22.23.2-npm/lib/node_modules/npm';
const binLinks=require(npm+'/node_modules/bin-links');
const normalize=require(npm+'/node_modules/npm-normalize-package-bin');
export async function relinkPrivateBins(destination, installed, lockFile) {
const root=realpathSync(destination),donor=realpathSync(installed);
assert(root.startsWith('/tmp/'),'only disposable private copies may be relinked');
assert.equal(root.split('/').at(-1),'node_modules');
assert.notEqual(root,donor);
assert(!root.startsWith(donor+'/') && !donor.startsWith(root+'/'));
assert(readFileSync(lockFile).equals(readFileSync(join(donor,'../package-lock.json'))),'installed donor lock mismatch');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const inside=(p,base)=>{assert(realpathSync(p).startsWith(base+'/'),p+' escaped '+base);};
const plan=[],expected=new Map(),dirs=new Set();
const lock=JSON.parse(readFileSync(lockFile));
{ for(const [path,meta] of Object.entries(lock.packages)) {
  if(!path || !meta.bin || !existsSync(join(root,path.replace(/^node_modules\//,''),'package.json')))continue;
  const pkgPath=join(root,path.replace(/^node_modules\//,'')),donorPath=join(donor,path.replace(/^node_modules\//,''));
  inside(pkgPath,root);
  const pkg=JSON.parse(readFileSync(join(pkgPath,'package.json')));
  assert.equal(hash(join(pkgPath,'package.json')),hash(join(donorPath,'package.json')));
  assert.equal(pkg.version,meta.version,path);
  assert.deepEqual(normalize({...pkg}).bin,normalize({name:pkg.name,bin:meta.bin}).bin,path);
  const bindir=resolve(pkgPath,pkg.name.startsWith('@')?'../../.bin':'../.bin');
  dirs.add(bindir);
  for(const [name,target] of Object.entries(normalize({...pkg}).bin)) {
   const actual=resolve(pkgPath,target),from=resolve(donorPath,target),link=join(bindir,name);
   inside(actual,pkgPath);assert.equal(hash(actual),hash(from),actual);
   assert(!expected.has(link),'ambiguous lock bin '+link);
   expected.set(link,{actual,sha:hash(actual),version:pkg.version,package:pkg.name});
  }
  plan.push({path:pkgPath,pkg,top:false,force:true});
 }
}
// Refuse to silently retain an unaccounted flattened entrypoint.
for(const dir of dirs)if(existsSync(dir))for(const file of readdirSync(dir))assert(expected.has(join(dir,file)),'unmapped bin '+join(dir,file));
for(const opts of plan)await binLinks(opts);
const entries=[];
for(const [link,e] of expected) {
 assert(lstatSync(link).isSymbolicLink(),link);
 assert(!isAbsolute(readlinkSync(link)),link);
 assert.equal(realpathSync(link),realpathSync(e.actual));inside(link,root);
 assert.equal(hash(e.actual),e.sha,'npm bin fix unexpectedly changed bytes');
 entries.push({link:relative(root,link),target:readlinkSync(link),real:realpathSync(link),package:e.package,version:e.version,sha256:e.sha});
}
// Already copied optional native closure: check bytes, version, and private location; never replace it.
const native=[];
for(const path of ['@esbuild/linux-x64/bin/esbuild','@rollup/rollup-linux-x64-gnu/rollup.linux-x64-gnu.node','tsx/node_modules/@esbuild/linux-x64/bin/esbuild']) {
 if(!existsSync(join(donor,path)))continue;
 const p=join(root,path);inside(p,root);assert.equal(hash(p),hash(join(donor,path)));
 native.push({path,sha256:hash(p)});
}
// Refuse every escaping link, not just package bins/native optionals.
function confined(dir){for(const name of readdirSync(dir)){const p=join(dir,name),st=lstatSync(p);if(st.isSymbolicLink())inside(p,root);else if(st.isDirectory())confined(p);}}
confined(root);
return {ok:true,method:'npm 10.9.8 bin-links / pinned package-lock + actual package.json; private relative symlinks',root,donor,entries,native};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 assert.equal(process.argv.length,5,'Pass private node_modules, installed node_modules, exact lock file');
 console.log(JSON.stringify(await relinkPrivateBins(...process.argv.slice(2)),null,2));
}
