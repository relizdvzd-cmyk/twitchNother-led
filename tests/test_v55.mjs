import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {TextEncoder,TextDecoder} from 'node:util';
const firmware=readFileSync('source/Twitch_LED_Builder_ESP32_v5_5.ino','utf8');
const app=readFileSync('app-v55.js','utf8');
const html=readFileSync('builder-v55.html','utf8');
const css=readFileSync('builder-v55.css','utf8');
const guard=readFileSync('firmware-guard-v55.mjs','utf8');
for(const token of [
  'TIME_BLOCK=4','WEEKDAY_BLOCK=5','NICK_BLOCK=6','COUNT_BLOCK=7','PIXEL_BLOCK=8',
  'bool validPixels(','frameCount(','drawPixelFrame(','matrix.getGraphicObject()',
  'blocks[cursor+1].type==JOIN_BLOCK','validLayout(stagingCount,true)',
  'VERSION TWITCHLED 5.5','V5.5 PIXEL OK','ESP32-Twitch-LED-Builder/5.5',
  'gfx->setColumn(31-col,bits)','PIXEL_BLOCK||', // pixel exclusion from joins
]) assert.ok(firmware.includes(token),'Firmware missing '+token);
for(const token of [
  "type==='pixel'",'function paintPixel(','function renderPixelEditor()',
  "'weekday','nick','count','pixel'",'decodeFrame(', 'previewPixelStartedAt',
  'previewGroupEnd+1','firmwareVersion<5.5','validConnectorPositions'
]) assert.ok(app.includes(token),'Browser missing '+token);
for(const token of ['id="addTime"','id="addWeekday"','id="addNick"','id="addCount"','id="twitchDisplayMode"',
  'id="addPixel"','id="pixelGrid"',
  'id="pixelAdd"','id="pixelDelete"','id="pixelFrameMs"','id="pixelDurationMs"'])
  assert.ok(html.includes(token),'HTML missing '+token);
assert.ok(html.includes('value="nick"')&&html.includes('value="count"'),
  'Twitch format selector must have nick-only and count-only options');
assert.ok(css.includes('.pixel-grid'), 'Pixel grid CSS missing');
assert.ok(guard.includes("twitch-led-v5.5.bin"),'Safe updater must use v5.5 binary');

// Simulate core browser interactions, no USB or network needed.
function fakeElement(){
  const events={},children=[],classes=new Set();
  const x={events,children,style:{},dataset:{},disabled:false,hidden:false,
    value:'',textContent:'',className:'',selectedIndex:0,
    classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),
      toggle:(k,v)=>{if(v===undefined)v=!classes.has(k);v?classes.add(k):classes.delete(k);},
      contains:k=>classes.has(k)},
    setAttribute(){},addEventListener(type,cb){(events[type]??=[]).push(cb);},
    replaceChildren(){children.length=0;},append(...items){children.push(...items);},
    closest(sel){
      if(sel==='button[data-pixel]'&&this.dataset.pixel!==undefined)return this;
      if(sel==='button[data-action]'&&this.dataset.action!==undefined)return this;
      return null;
    },
    focus(){},scrollIntoView(){},click(){}};
  return x;
}
const elements=new Map(),get=id=>{
  if(!elements.has(id))elements.set(id,fakeElement());
  return elements.get(id);
};
const document={getElementById:get,createElement:()=>fakeElement(),
  querySelectorAll:()=>[],addEventListener(){}};
let saved=JSON.stringify({schema:2,blocks:[
 {type:'text',value:'Подписчики',speed:65,pauseMs:300},
 {type:'twitch',value:'pwgood',speed:65,pauseMs:300}]});
const localStorage={getItem:()=>saved,setItem:(_,value)=>{saved=value}};
const ctx={document,window:{isSecureContext:true,confirm:()=>true},navigator:{serial:{}},
 localStorage,TextEncoder,TextDecoder,Intl,URL,Blob,Date,
 setTimeout:()=>1,clearTimeout:()=>{},console};
vm.runInNewContext(app,ctx,{timeout:3000});
assert.equal(get('addJoin').disabled,false,'JOIN button available between two contents');
get('addJoin').events.click[0]();
assert.deepEqual(JSON.parse(saved).blocks.map(x=>x.type),['text','join','twitch']);
// The user can select full/nick/count display or add them as separate playlist blocks.
const selectTwitch=fakeElement();
selectTwitch.dataset.action='select';selectTwitch.dataset.index='2';
get('blocksList').events.click[0]({target:selectTwitch});
assert.equal(get('twitchDisplayMode').value,'twitch');
get('twitchDisplayMode').events.change[0]({target:{value:'count'}});
assert.deepEqual(JSON.parse(saved).blocks.map(x=>x.type),['text','join','count']);
assert.equal(get('twitchDisplayMode').value,'count');
assert.equal(get('addNick').disabled,false);
assert.equal(get('addCount').disabled,false);
get('twitchDisplayMode').events.change[0]({target:{value:'nick'}});
assert.equal(JSON.parse(saved).blocks[2].type,'nick');
get('twitchDisplayMode').events.change[0]({target:{value:'count'}});
assert.equal(JSON.parse(saved).blocks[2].type,'count');
assert.equal(get('addPixel').disabled,false);
get('addPixel').events.click[0]();
let current=JSON.parse(saved).blocks;
assert.equal(current.at(-1).type,'pixel','PIXEL added after joined phrase');
assert.equal(current.at(-1).value.length,64,'single 8x32 image encoded as 64 hex');
assert.equal(get('pixelGrid').children.length,256,'exactly 256 drawing dots');
get('pixelAdd').events.click[0]();
current=JSON.parse(saved).blocks;
assert.equal(current.at(-1).value.split('.').length,2,'two animation frames');
const firstDot=get('pixelGrid').children[0];
get('pixelGrid').events.pointerdown[0]({target:firstDot,preventDefault(){}});
current=JSON.parse(saved).blocks;
assert.equal(current.at(-1).value.split('.')[1].slice(0,2),'01','pixel toggled in second frame');
assert.equal(get('savePlaylist').disabled,true,'Never send new blocks to an unknown / old board');
console.log('PASS: v5.5 firmware, single Twitch mode selector, guarded updater, 256-pixel drawing and frames');
