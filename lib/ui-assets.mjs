import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const entryAssets=['app.js','app.css','phone.css','boot.js','usage-popover.css','split-workspace.css','fonts.css','typography.css','profile-menu.css','sidebar-layout.css','chat-tools.css','preview-annotations.css','session-board.css','session-board.js'];
// Content versions invalidate old WebKit entries without touching auth cookies.
// Read the tiny entry assets when rendering HTML so live UI patches are covered.
export async function versionUiDocument(bytes,publicRoot){
 const assets=await Promise.all(entryAssets.map(async name=>({name,version:crypto.createHash('sha256').update(await fs.readFile(path.join(publicRoot,name))).digest('hex').slice(0,20)})));
 let html=bytes.toString('utf8');
 for(const {name,version}of assets)html=html.split('"/'+name+'"').join('"/'+name+'?v='+version+'"');
 return Buffer.from(html);
}
