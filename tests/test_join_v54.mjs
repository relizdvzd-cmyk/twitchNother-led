import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {TextEncoder,TextDecoder} from 'node:util';

const firmware=readFileSync('source/Twitch_LED_Builder_ESP32_v5_4.ino','utf8');
const app=readFileSync('app.js','utf8');
const html=readFileSync('index.html','utf8');
for(const token of [
  'JOIN_BLOCK = 3','validLayout(staging,stagingCount)',
  'blocks[cursor+1].type==JOIN_BLOCK','(currentGroupEnd+1)%blockCount',
  'PLAYLIST ADD JOIN SPACE','PLAYLIST3 DATE1 CYRILLIC1 JOIN1',
  'showText("V5.4 JOIN OK"'
])assert.ok(firmware.includes(token), 'Firmware missing '+token);
for(const token of [
  "type==='join'","JOIN","itemJoinSeparator","validConnectorPositions",
  "previewGroupEnd+1","firmwareVersion<5.4"
])assert.ok(app.includes(token), 'Browser JS missing '+token);
for(const token of ['id="addJoin"','id="joinSettings"','id="timingSettings"'])
  assert.ok(html.includes(token), 'HTML missing '+token);

// Run the actual browser script with a lightweight document and persisted draft.
// This checks insertion of a connector and editing its separator without a device.
function fakeElement() {
  const events={};
  return {
    events,style:{},dataset:{},disabled:false,hidden:false,
    value:'',textContent:'',className:'',title:'',selectedIndex:0,
    classList:{add(){},remove(){},toggle(){}},
    setAttribute(){},addEventListener(type,cb){(events[type]??=[]).push(cb);},
    replaceChildren(){},append(){},focus(){},scrollIntoView(){},click(){}
  };
}
const elements=new Map();
const get=id=>{if(!elements.has(id))elements.set(id,fakeElement());return elements.get(id);};
const document={
  getElementById:get,
  createElement:()=>fakeElement(),
  querySelectorAll:()=>[]
};
let saved=JSON.stringify({schema:1,blocks:[
  {type:'text',value:'Подписчики',speed:65,pauseMs:300},
  {type:'twitch',value:'pwgood',speed:65,pauseMs:300}
]});
const localStorage={getItem:()=>saved,setItem:(_key,value)=>{saved=value;}};
const ctx={document,window:{isSecureContext:true,confirm:()=>true},navigator:{serial:{}},
  localStorage,TextEncoder,TextDecoder,Intl,URL,Blob,
  setTimeout:()=>1,clearTimeout:()=>{},console};
vm.runInNewContext(app,ctx,{timeout:3000});
assert.equal(get('addJoin').disabled,false);
assert.ok(get('addJoin').events.click?.length);
get('addJoin').events.click[0]();
let result=JSON.parse(saved).blocks;
assert.deepEqual(result.map(x=>x.type),['text','join','twitch']);
assert.equal(result[1].value,'SPACE');
get('itemJoinSeparator').events.change[0]({target:{value:'NONE'}});
result=JSON.parse(saved).blocks;
assert.equal(result[1].value,'NONE');
assert.equal(get('addJoin').disabled,true);
assert.ok(get('savePlaylist').disabled, 'Must not save JOIN to older firmware');
console.log('PASS: firmware JOIN rendering markers, browser integration, real UI insertion and options');
