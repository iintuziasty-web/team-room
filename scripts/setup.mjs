import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const token=crypto.randomBytes(32).toString('base64url');
const value='PUBLIC_URL=http://127.0.0.1:4173\nHOST=127.0.0.1\nPORT=4173\nTEAM_ROOM_HUB_ONLY=1\nTEAM_ROOM_SETUP_TOKEN='+token+'\nTEAM_ROOM_DOMAIN=\n';
try{await fs.writeFile(new URL('../.env',import.meta.url),value,{mode:0o600,flag:'wx'});console.log('Created .env. Your first-owner setup code is saved in TEAM_ROOM_SETUP_TOKEN. Open .env locally to copy it. Do not share or commit this file.');}catch(error){if(error.code==='EEXIST')console.log('.env already exists; nothing changed.');else throw error;}
