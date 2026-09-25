import sharp from 'sharp';
import {writeFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const assets=[];
for(let i=0;i<10;i++){
 const map=i<2;
 const paper='#e5dfce',line='#293d45',light='#879b98';
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="${paper}"/><g stroke="${line}" fill="none" stroke-width="4">${map?`<path d="M65 410H870M65 440H870M150 405V445M240 405V445M330 405V445M420 405V445M510 405V445M600 405V445M690 405V445M780 405V445"/><rect x="110" y="95" width="240" height="170" fill="${light}"/><rect x="530" y="70" width="300" height="180"/><path d="M390 90v190h100V90M110 300H830M390 330L460 365 530 330"/><path stroke-dasharray="14 8" d="M100 365H400L500 280 880 280"/><circle cx="455" cy="165" r="25"/><path d="M95 70V40l-10 18m10-18 10 18"/>`:`<path d="M0 330L240 220 670 235 960 350M190 0v325M750 0v330M0 465l360-150 270 0 330 150"/><path d="M260 210V70h360v155M280 215V100h120v120M430 215V100h170v122"/><rect x="${330+(i%3)*90}" y="230" width="100" height="135" fill="${light}"/><circle cx="${200+i*35}" cy="${210+(i%2)*30}" r="23" fill="${paper}"/><path stroke-width="10" d="M${200+i*35} ${236+(i%2)*30}v95m0-63-36 30m36-30 31 30m-31 32-23 62m23-62 28 58"/><path d="M660 330v-160m-38-28h77l-18 28h-42Z"/><ellipse cx="${560-(i%3)*90}" cy="465" rx="100" ry="8" fill="${light}"/><path stroke-dasharray="10 7" d="M90 480l180-95m-180 95 50-5m-50 5 20-40"/>`}</g><text x="30" y="35" font-family="sans-serif" font-size="18" fill="${line}">${map?'FOG HARBOR / MAP '+(i+1):'FOG HARBOR / BOARD '+(i-1)}</text><text x="30" y="518" font-family="sans-serif" font-size="15" fill="${line}">SCHEMATIC DEMO - NOT FINAL ART - 2D ONLY</text></svg>`;
 const bytes=await sharp(Buffer.from(svg)).png({palette:true}).toBuffer();assets.push({name:`${map?'map':'board'}-${i}.png`,mime:'image/png',durationMs:0,data:bytes.toString('base64')});
}
assets.push(...JSON.parse(readFileSync(path.join(root,'templates/creative/demo-voices.json'),'utf8')));
writeFileSync(path.join(root,'shared/creative/sample-media.generated.ts'),'/** 构建期生成的虚构示意素材。音频为 eSpeak 合成，不是原作者或真人声音。 */\nexport const sampleMedia: {name:string;mime:string;durationMs:number;data:string;text?:string}[] = '+JSON.stringify(assets)+';\n');
