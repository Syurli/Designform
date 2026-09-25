/** 基础签名白名单；运行时还需在显示 / 试听前执行实际解码。 */
export const MEDIA_LIMIT = 64 * 1024 * 1024;
export function detectMedia(bytes:Uint8Array):{mime:string;extension:string;kind:'image'|'audio'} {
 const ascii=(start:number,n:number)=>String.fromCharCode(...bytes.slice(start,start+n));
 if(bytes.length<12||bytes.length>MEDIA_LIMIT)throw new Error('媒体文件为空、损坏或超过单文件 64 MiB 上限');
 if(bytes[0]===137&&ascii(1,3)==='PNG'&&bytes[4]===13&&bytes[5]===10)return {mime:'image/png',extension:'png',kind:'image'};
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {mime:'image/jpeg',extension:'jpg',kind:'image'};
 if(['GIF87a','GIF89a'].includes(ascii(0,6)))return {mime:'image/gif',extension:'gif',kind:'image'};
 if(ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP')return {mime:'image/webp',extension:'webp',kind:'image'};
 if(ascii(0,4)==='RIFF'&&ascii(8,4)==='WAVE')return {mime:'audio/wav',extension:'wav',kind:'audio'};
 if(ascii(0,4)==='OggS')return {mime:'audio/ogg',extension:'ogg',kind:'audio'};
 if(ascii(0,3)==='ID3'||bytes[0]===255&&(bytes[1]&0xe0)===0xe0)return {mime:'audio/mpeg',extension:'mp3',kind:'audio'};
 if(ascii(4,4)==='ftyp'&&/M4A |isom|mp42/.test(ascii(8,4)))return {mime:'audio/mp4',extension:'m4a',kind:'audio'};
 throw new Error('不支持的媒体内容。接受 PNG/JPEG/GIF/WebP 与 WAV/MP3/Ogg/M4A；不接受脚本、SVG 或伪装扩展名');
}
