// Local pin check always runs; --peer adds mandatory cross-repository byte parity.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const paths=(r)=>existsSync(resolve(r,'src/lib/searchIntent.ts'))?
  ['src/lib/searchIntent.ts','src/lib/searchIntent.fixtures.json']:['src/discovery-contract.ts','src/discovery-contract.fixtures.json'];
const files=paths(root);
const manifest=JSON.parse(readFileSync(resolve(root,'discovery-contract.manifest.json'),'utf8'));
for (const [n,logical] of ['schema','fixtures'].entries()) {
  const data=readFileSync(resolve(root,files[n]));
  if(createHash('sha256').update(data).digest('hex')!==manifest.sha256[logical]) throw new Error(`Discovery ${logical} drift: edit canonical source, mirror, then update both manifests`);
  const peerIndex=process.argv.indexOf('--peer');
  if(peerIndex!==-1){
    const peer=resolve(process.argv[peerIndex+1]??'__missing_peer__');
    if(!data.equals(readFileSync(resolve(peer,paths(peer)[n])))) throw new Error(`Cross-repository ${logical} drift`);
  }
}
console.log('Discovery contract v1 pins'+(process.argv.includes('--peer')?' + peer parity':'')+': PASS');
