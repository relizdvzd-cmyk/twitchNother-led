import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {TextEncoder,TextDecoder} from 'node:util';

const app=readFileSync('logic-v6.js','utf8');
const html=readFileSync('logic-v6.html','utf8');
const css=readFileSync('logic-v6.css','utf8');
const fw=readFileSync('source/Twitch_LED_Logic_v6.ino','utf8');
const guard=readFileSync('firmware-guard-v6.mjs','utf8');
const updater=readFileSync('updater-v6.js','utf8');
const updaterHTML=readFileSync('updater-v6.html','utf8');
assert.ok(guard.includes("twitch-led-v6.0.bin")&&guard.includes("r.version!=='6.0'"));
assert.ok(guard.includes("assertChipAndFlash")&&guard.includes("assertPartitionDigest"));
assert.ok(updater.includes("eraseAll:false")&&!updater.includes("eraseAll:true"));
assert.ok(updater.includes("loader.flashMd5sum(")&&!updater.includes("loader.readFlash("));
assert.ok(updater.includes("firmware/update-v6.0.json"));
assert.ok(updaterHTML.includes("LILYGO T-Energy S3"));

new vm.Script(app,{filename:'logic-v6.js'});
assert.ok(html.includes('logic-v6.js?v=6.0.0'),'Dedicated v6 app must load');
assert.ok(html.includes('href="./index.html"'),'Fallback v5.5 editor link must remain');
assert.ok(html.includes("href=\"./updater-v6.html\""),'Separate safe v6 updater must be discoverable');

for(const kind of ['text','twitch','clock','pixel','wait','repeat','if'])
  assert.ok(html.includes('data-add="'+kind+'"'),'Missing '+kind+' palette block');
for(const name of ['dragstart','dragover','drop','getList(','renderGroup(','validateAndCompile(','simulateList(','SCRIPT BEGIN','SCRIPT COMMIT','SCRIPT RUN'])
  assert.ok(app.includes(name),'Missing visual logic / USB feature: '+name);
for(const name of ['scriptValidStructure(','scriptIfTrue(','scriptTick(','maybeUpdateScriptFollowers(','SCRIPT1','SCRIPT SAVED','SCRIPT COUNT','scnt'])
  assert.ok(fw.includes(name),'Missing embedded logic feature: '+name);
assert.ok(fw.includes('loadBlocks();')&&fw.includes('loadScript();'),'Preserve legacy data');
assert.ok(!html.includes('updater-v55.html')||html.includes('index.html'),'Old updater stays independent');
assert.ok(css.includes('.node.conditional')&&css.includes('.scope'),'Nested Scratch-like blocks must be styled');

// Lightweight DOM that executes production JS in a realistic dependency-free environment.
function element(){
  const events={},children=[];
  return {
    events,children,dataset:{},style:{},hidden:false,disabled:false,
    innerHTML:'',textContent:'',value:'',className:'',
    addEventListener(k,fn){(events[k]??=[]).push(fn)},
    classList:{add(){},remove(){},toggle(){},contains(){return false}},
    setAttribute(){},append(...items){children.push(...items)},
    replaceChildren(){children.length=0},
    click(){(events.click||[]).forEach(fn=>fn())},
    closest(){return null},focus(){},
  }
}
const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element());return els.get(id)};
const palette=new Map(['text','twitch','clock','pixel','wait','repeat','if'].map(k=>{
  const el=element();el.dataset.add=k;return [k,el];
}));
const document={
  getElementById:get,createElement:element,
  querySelectorAll(sel){return sel==='[data-add]'?[...palette.values()]:[]}
};
const state=new Map(),localStorage={getItem:k=>state.get(k)||null,setItem:(k,v)=>state.set(k,v)};
const ctx={
  document,window:{isSecureContext:true},navigator:{serial:{}},localStorage,
  TextEncoder,TextDecoder,Intl,Date,URL,Blob,
  setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,console,
  confirm:()=>true,btoa:s=>Buffer.from(s,'binary').toString('base64'),
  atob:s=>Buffer.from(s,'base64').toString('binary'),
};
vm.runInNewContext(app,ctx,{timeout:3000});
assert.match(get('rootList').innerHTML,/показать Twitch/,'Initial test scenario renders');
assert.equal(get('nodeCount').textContent,'3','Three default visual blocks');
assert.match(get('validation').textContent,/корректна/i);
palette.get('repeat').click();
assert.match(get('rootList').innerHTML,/повторить/);
assert.match(get('rootList').innerHTML,/ДЕЙСТВИЯ/);
palette.get('if').click();
assert.match(get('rootList').innerHTML,/если/);
assert.match(get('rootList').innerHTML,/ИНАЧЕ/);
assert.equal(get('validation').className,'validation');
assert.ok(state.has('twitch-led-logic-v6'),'Project stored locally');
assert.match(state.get('twitch-led-logic-v6'),/repeat/);
assert.match(state.get('twitch-led-logic-v6'),/"if"/);
assert.equal(get('sendScript').disabled,true,'Do not upload script to unknown legacy firmware');
assert.equal(get('pixelTools').hidden,true);
console.log('PASS: v6 visual logic blocks, nested C control, local JSON, simulator, SCRIPT1 safety gate and firmware hooks');
