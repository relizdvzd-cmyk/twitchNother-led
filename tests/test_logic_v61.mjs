import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {TextEncoder,TextDecoder} from 'node:util';
const app=readFileSync('logic-v61.js','utf8');
const html=readFileSync('logic-v61.html','utf8');
const css=readFileSync('logic-v61.css','utf8');
const fw=readFileSync('source/Twitch_LED_Logic_v6_1.ino','utf8');
new vm.Script(app,{filename:'logic-v61.js'});
for(const k of ['weekday','date','time','hour','followers','nick','wifi','text','number','bool'])
  assert.ok(html.includes('data-reporter="'+k+'"'),'Reporter missing '+k);
for(const k of ['text','twitch','clock','pixel','wait','repeat','if'])
  assert.ok(html.includes('data-add="'+k+'"'),'Action missing '+k);
assert.ok(css.includes('.operand-slot')&&css.includes('.condition-wrapper'));
assert.ok(html.includes('SCRIPT2')&&html.includes('logic-v61.js'));
assert.ok(fw.includes('VERSION TWITCHLED 6.1 SCRIPT2'));
for(const k of ['scriptCompareValid(','scriptCompareValues(','scriptFoldText(','IFCMP2','scriptOperandType(','scriptRegisterCompareSource('])
  assert.ok(fw.includes(k),'Firmware missing '+k);
assert.ok(fw.includes('loadBlocks();')&&fw.includes('loadScript();'));
function element(){
  const events={},children=[],classes=new Set();
  return {
    events,children,dataset:{},style:{},disabled:false,hidden:false,
    textContent:'',innerHTML:'',value:'',className:'',title:'',
    classList:{
      add:k=>classes.add(k),remove:k=>classes.delete(k),
      toggle:(k,v)=>{if(v===undefined)v=!classes.has(k);v?classes.add(k):classes.delete(k)},
      contains:k=>classes.has(k)
    },
    addEventListener(k,fn){(events[k]??=[]).push(fn)},
    append(...items){children.push(...items)},
    replaceChildren(){children.length=0},
    click(){for(const fn of events.click||[])fn()},
    setAttribute(){},scrollIntoView(){},focus(){},
    closest(sel){
      if(sel==='.operand-slot'&&this.dataset.socketOwner)return this;
      if(sel==='.insert-point'&&this.dataset.parent)return this;
      if(sel==='button[data-cond-action]'&&this.dataset.condAction)return this;
      if(sel==='button[data-action]'&&this.dataset.action)return this;
      if(sel==='[data-combine]'&&this.dataset.combine)return this;
      if(sel==='[data-comp-op]'&&this.dataset.compOp)return this;
      if(sel==='[data-expr-kind]'&&this.dataset.exprKind)return this;
      if(sel==='[data-expr-field]'&&this.dataset.exprField)return this;
      if(sel==='input[data-expr-field]'&&this.dataset.exprField)return this;
      if(sel==='input[data-field]'&&this.dataset.field)return this;
      if(sel==='[data-field]'&&this.dataset.field)return this;
      if(sel==='.drag-handle'&&this.className==='drag-handle')return this;
      if(sel==='button[data-x]'&&this.dataset.x!==undefined)return this;
      return null;
    }
  };
}
const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element());return els.get(id)};
const actions=new Map(),reporters=new Map();
for(const k of ['text','twitch','clock','pixel','wait','repeat','if']){
  const e=element();e.dataset.add=k;actions.set(k,e);
}
for(const k of ['weekday','date','time','hour','followers','nick','wifi','text','number','bool']){
  const e=element();e.dataset.reporter=k;reporters.set(k,e);
}
const document={
  getElementById:get,createElement:element,
  querySelectorAll(sel){
    if(sel==='[data-add]')return [...actions.values()];
    if(sel==='[data-reporter]')return [...reporters.values()];
    return [];
  },
  addEventListener(){}
};
const saved=new Map(),localStorage={
  getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)
};
const ctx={document,window:{isSecureContext:true},navigator:{serial:{}},localStorage,
  TextEncoder,TextDecoder,Intl,URL,Blob,Date,console,setTimeout:()=>1,clearTimeout(){},
  confirm:()=>true,btoa:s=>Buffer.from(s,'binary').toString('base64'),
  atob:s=>Buffer.from(s,'base64').toString('binary')};
const testHooks='window.__qa={project:()=>project,compile:()=>validateAndCompile(),evalIf:evaluateIf,importProject,setOperand};})();';
const instrumented=app.replace(/\}\)\(\);\s*$/,testHooks);
assert.notEqual(instrumented,app,'Test hook injection failed');
vm.runInNewContext(instrumented,ctx,{timeout:3000});
let p=ctx.window.__qa.project();
assert.equal(p.steps[0].kind,'if');
assert.equal(p.steps[0].tests[0].left.kind,'weekday');
assert.equal(p.steps[0].tests[0].right.value,'СУББОТА');
let compiled=ctx.window.__qa.compile();
assert.equal(compiled.errors.length,0);
assert.ok(compiled.commands[0].startsWith('IFCMP EQ DAY@BERLIN TXT@'));
assert.equal(Buffer.from(compiled.commands[0].split('TXT@')[1],'base64').toString('utf8'),'СУББОТА');
assert.equal(get('sendScript').disabled,true,'Unknown board upload must be disabled');
const id=p.steps[0].id;
const socket=element();socket.dataset.socketOwner=id;socket.dataset.socketIndex='0';socket.dataset.socketSide='left';
get('program').events.click[0]({target:socket});
reporters.get('followers').click();
p=ctx.window.__qa.project();
assert.equal(p.steps[0].tests[0].left.kind,'followers');
assert.equal(p.steps[0].tests[0].right.kind,'number');
compiled=ctx.window.__qa.compile();
assert.ok(compiled.commands[0].startsWith('IFCMP EQ FOLLOW@pwgood NUM@100'));
const transfer={effectAllowed:'',dropEffect:'',setData(){}};
reporters.get('weekday').events.dragstart[0]({dataTransfer:transfer});
let accepted=false;
get('program').events.dragover[0]({target:socket,dataTransfer:transfer,preventDefault(){accepted=true}});
assert.ok(accepted);
get('program').events.drop[0]({target:socket,dataTransfer:transfer,preventDefault(){}});
assert.equal(ctx.window.__qa.project().steps[0].tests[0].left.kind,'weekday');
assert.equal(ctx.window.__qa.project().steps[0].tests[0].right.kind,'text');
const append=element();append.dataset.condAction='append';append.dataset.condNode=id;
get('program').events.click[0]({target:append});
assert.equal(ctx.window.__qa.project().steps[0].tests.length,2);
const combo=element();combo.dataset.combine=id;combo.value='OR';
get('program').events.change[0]({target:combo});
compiled=ctx.window.__qa.compile();
assert.equal(compiled.errors.length,0,compiled.errors.join('; '));
assert.ok(compiled.commands[0].startsWith('IFCMP2 OR EQ DAY@BERLIN TXT@'));
actions.get('text').events.dragstart[0]({dataTransfer:transfer});
const point=element();point.dataset.parent=id;point.dataset.branch='body';point.dataset.index='0';
get('program').events.drop[0]({target:point,dataTransfer:transfer,preventDefault(){}});
assert.equal(ctx.window.__qa.project().steps[0].body.length,2);
ctx.window.__qa.project().steps[0].tests[0].right={kind:'number',value:100};
compiled=ctx.window.__qa.compile();
assert.ok(compiled.errors.some(e=>e.includes('разные типы')));
ctx.window.__qa.importProject({schema:6,steps:[{kind:'if',condition:'hour',hour:18,zone:'BERLIN',
  body:[{kind:'text',text:'OK',speed:65,pause:300}],otherwise:[]}]});
assert.equal(ctx.window.__qa.project().steps[0].tests[0].left.kind,'hour');
assert.equal(ctx.window.__qa.project().steps[0].tests[0].right.kind,'number');
assert.equal(ctx.window.__qa.compile().errors.length,0);
assert.ok(saved.has('twitch-led-logic-v61'));
console.log('PASS: typed comparison, Cyrillic weekday, palette + reporter DnD, AND/OR, strict types, v6 migration, SCRIPT2 gate');
