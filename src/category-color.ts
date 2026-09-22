import { currentTheme } from './theme';

/** 同一分类身份在浅色下保持色相，使用足够深且有饱和度的实体色。 */
export function categoryColor(hex: string, light = currentTheme() === 'light') {
  if(!light || !/^#[\da-f]{6}$/i.test(hex))return hex;
  const values=[1,3,5].map(at=>parseInt(hex.slice(at,at+2),16)/255),max=Math.max(...values),min=Math.min(...values),delta=max-min;
  if(delta<.04)return '#52677b';
  const [r,g,b]=values;let hue=max===r?(g-b)/delta+(g<b?6:0):max===g?(b-r)/delta+2:(r-g)/delta+4;
  hue=Math.round(hue*60);return `hsl(${hue}, ${hue>35&&hue<180?57:52}%, ${hue>35&&hue<180?30:36}%)`;
}
