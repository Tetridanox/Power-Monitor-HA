import {messages} from './i18n-messages.js?v=1.0.226';
const KEY='power-monitor-language';
const supported=new Set(['ru','uk','en']);
let profile='ru',override='auto';
try{const saved=globalThis.localStorage?.getItem(KEY);if(supported.has(saved))override=saved}catch{}
const reverse=new Map();
for(const [source,translations]of Object.entries(messages))for(const value of translations)if(value&&!reverse.has(value))reverse.set(value,source);
export const language=()=>override==='auto'?profile:override;
export const languagePreference=()=>override;
export const locale=()=>({ru:'ru-RU',uk:'uk-UA',en:'en-GB'})[language()];
export function t(source){const value=String(source??'');const key=messages[value]?value:reverse.get(value)||value;return language()==='ru'?key:messages[key]?.[language()==='uk'?0:1]??value}
export function technical(source){const value=String(source??'');const key=messages[value]?value:reverse.get(value)||value;return messages[key]?.[1]??({'В·А':'VA','А·ч':'Ah','Вт':'W','Гц':'Hz','мин':'min','дни':'days','В':'V','А':'A'}[value])??value}
export const isApplicationMessage=value=>typeof value==='string'&&(Object.hasOwn(messages,value)||reverse.has(value));
function changed(){globalThis.window?.dispatchEvent(new Event('power-monitor-language-changed'))}
export function setProfileLanguage(value){const next=String(value||'').split('-')[0];const resolved=supported.has(next)?next:'en';if(profile!==resolved){profile=resolved;if(override==='auto')changed()}}
export function setLanguage(value){if(value!=='auto'&&!supported.has(value))return;override=value;try{globalThis.localStorage?.setItem(KEY,value)}catch{}changed()}
const textBinding=Symbol('pm-text'),attributeBindings=Symbol('pm-attributes');
export function setText(node,getter,translate=false){const read=typeof getter==='function'?getter:()=>getter;node[textBinding]=()=>translate?t(read()):String(read()??'');const value=node[textBinding]();if(node.textContent!==value)node.textContent=value;return node}
export function bindAttribute(node,key,getter,raw=false){const read=typeof getter==='function'?getter:()=>getter;(node[attributeBindings]??={})[key]=()=>raw?String(read()):t(read());node.setAttribute(key,node[attributeBindings][key]())}
export function refreshTranslations(root){
 for(const node of Array.from(root.childNodes||[])){
  if(node[textBinding]){const value=node[textBinding]();if(node.textContent!==value)node.textContent=value}
  if(node[attributeBindings])for(const [key,read]of Object.entries(node[attributeBindings]))node.setAttribute(key,read());
  if(node.shadowRoot)refreshTranslations(node.shadowRoot);
  if(!node[textBinding])refreshTranslations(node);
 }
}
// Only compile-time marked application strings are translated in markup.
// Device names and values interpolated into HTML never receive these markers.
export function setMarkup(root,markup){
 root.innerHTML=markup;
 const walk=node=>{for(const child of Array.from(node.childNodes||[])){
  if(child.nodeType===8&&child.data.startsWith('pm-i18n:')&&child.nextSibling?.nodeType===3){const source=decodeURIComponent(child.data.slice(8)),text=child.nextSibling;if(text.textContent.startsWith(source)){if(text.textContent.length>source.length)text.splitText(source.length);setText(text,()=>t(source))}}
  if(child.nodeType===1){for(const attr of Array.from(child.attributes||[]))if(attr.name.startsWith('data-pm-i18n-'))bindAttribute(child,attr.name.slice(13),decodeURIComponent(attr.value));walk(child)}
 }};walk(root);
}
export function watchLanguage(owner,extra){const update=()=>{refreshTranslations(owner.shadowRoot);extra?.()};globalThis.window?.addEventListener('power-monitor-language-changed',update);return()=>globalThis.window?.removeEventListener('power-monitor-language-changed',update)}
