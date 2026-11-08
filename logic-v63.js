/* Twitch LED Logic v6.3: standalone Scratch-inspired visual program editor.
   Runs without third-party libraries. Changes only this page's local project.
   USB SCRIPT upload is gated on a v6.3 firmware capability response (SCRIPT2). */
(()=>{
"use strict";
const $=id=>document.getElementById(id);
const enc=new TextEncoder();
const zones={BERLIN:"Europe/Berlin",MOSCOW:"Europe/Moscow",VLADIVOSTOK:"Asia/Vladivostok",UTC:"UTC"};
const MAX_NODES=42,MAX_DEPTH=3,STORAGE="twitch-led-logic-v63";
let serialNumber=0;
const uid=()=>("n"+(++serialNumber).toString(36));
const blankPixels=()=>("00").repeat(32);
const blankProject=()=>({schema:63,version:"6.3",steps:[
  {id:uid(),kind:"if",combine:"AND",tests:[{
    op:"EQ",left:{kind:"weekday",zone:"BERLIN"},right:{kind:"text",value:"СУББОТА"}
  }],body:[{id:uid(),kind:"text",text:"ВЫХОДНЫЕ!!",speed:65,pause:300}],
    otherwise:[{id:uid(),kind:"text",text:"БУДНИ",speed:65,pause:300}]},
  {id:uid(),kind:"twitch",login:"pwgood",format:"count",speed:65,pause:300}
]});
let project=blankProject();
let active={parent:"root",branch:"root",index:project.steps.length};
let selectedId=null,pixelEditFrame=0,pixelPainting=false,pixelPaintOn=true;
let activeSocket=null; // {id,index,side}, used for reporter insertion by click
let simulation=0,port=null,reader=null,readTask=null,rx="",pending=null,firmwareOK=false,busy=false;
let versionCheckSeq=0,versionProbeBusy=false,versionReply="";
let deviceMemory=null,videoData=null,videoConverting=false,videoSending=false,videoConversionSeq=0,videoPreviewTimer=null;
const VIDEO_SOURCE_LIMIT=100*1024*1024,VIDEO_MAX_FRAMES=2400;
const matrixDots=[];
const escapeHtml=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const int=(n,low,high,alt)=>Number.isFinite(+n)?Math.max(low,Math.min(high,Math.round(+n))):alt;
const bytes=s=>enc.encode(String(s)).length;
const normLogin=s=>{const v=String(s??"").trim().toLowerCase().replace(/^https?:\/\//,"").replace(/^twitch\.tv\//,"").replace(/^@/,"").split(/[/?#]/)[0];return /^[a-z0-9_]{1,25}$/.test(v)?v:null};
const b64=s=>btoa(Array.from(enc.encode(s),b=>String.fromCharCode(b)).join(""));
const safeZone=z=>Object.hasOwn(zones,z)?z:"BERLIN";
function outputDate(zone,mode) {
  try{
    const tz=zones[safeZone(zone)];
    const cfg=mode==="DATE"?{day:"2-digit",month:"2-digit",year:"numeric"}:
      mode==="WEEKDAY"?{weekday:"long"}:{hour:"2-digit",minute:"2-digit",hourCycle:"h23"};
    const out=new Intl.DateTimeFormat("ru-RU",{timeZone:tz,...cfg}).format(new Date());
    return mode==="WEEKDAY"?out.toLocaleUpperCase("ru-RU"):out;
  }catch(_){return mode==="TIME"?"--:--":"--";}
}
function followerValue(login){return "475070";} // explicitly synthetic browser preview
function expandPreviewText(text){
  return String(text).replace(/\{(followers|time|date|weekday):([a-z0-9_]+)\}/gi,(_,kind,term)=>{
    kind=kind.toLowerCase();
    if(kind==="followers")return followerValue(term);
    return outputDate(term,kind==="time"?"TIME":kind==="date"?"DATE":"WEEKDAY");
  });
}
// Typed report blocks: the same values can be displayed OR compared.
const REPORTER_KINDS=["weekday","date","time","hour","followers","nick","live","wifi","text","number","bool"];
const EXPR_LABELS={
 weekday:"ДЕНЬ НЕДЕЛИ",date:"ДАТА",time:"ВРЕМЯ",hour:"ЧАС",
 followers:"ФОЛЛОВЕРЫ",nick:"НИК TWITCH",live:"СТРИМЕР ОНЛАЙН?",wifi:"WI-FI",
 text:"ТЕКСТ",number:"ЧИСЛО",bool:"ЛОГИКА"
};
const COMPARE_OPS=[["EQ","="],["NE","≠"],["GT",">"],["GTE","≥"],["LT","<"],["LTE","≤"],["CONTAINS","содержит"]];
function newExpr(kind){
  if(["weekday","date","time","hour"].includes(kind))return {kind,zone:"BERLIN"};
  if(["followers","nick","live"].includes(kind))return {kind,login:"pwgood"};
  if(kind==="wifi")return {kind};
  if(kind==="text")return {kind,value:"СУББОТА"};
  if(kind==="number")return {kind,value:100};
  if(kind==="bool")return {kind,value:true};
  throw Error("Неизвестный блок значения "+kind);
}
function exprType(expr){
  if(["weekday","date","time","nick","text"].includes(expr?.kind))return "text";
  if(["hour","followers","number"].includes(expr?.kind))return "number";
  if(["wifi","bool","live"].includes(expr?.kind))return "bool";
  return null;
}
function defaultOther(type){
  return type==="number"?newExpr("number"):type==="bool"?newExpr("bool"):newExpr("text");
}
function makeCompare(left=newExpr("weekday"),right=newExpr("text")){
  return {op:"EQ",left,right};
}
function migrateLegacyIf(n){
  if(Array.isArray(n.tests)&&n.tests.length)return n.tests.slice(0,2).map(t=>({
    op:COMPARE_OPS.some(([v])=>v===t.op)?t.op:"EQ",
    left:REPORTER_KINDS.includes(t.left?.kind)?{...newExpr(t.left.kind),...t.left}:newExpr("weekday"),
    right:REPORTER_KINDS.includes(t.right?.kind)?{...newExpr(t.right.kind),...t.right}:newExpr("text")
  }));
  if(n.condition==="followers")return [makeCompare({kind:"followers",login:n.login||"pwgood"},{kind:"number",value:n.threshold||100})];
  if(n.condition==="hour")return [makeCompare({kind:"hour",zone:n.zone||"BERLIN"},{kind:"number",value:n.hour||18})];
  if(n.condition==="wifi")return [makeCompare(newExpr("wifi"),newExpr("bool"))];
  return [makeCompare()];
}

function newNode(kind){
  const id=uid();
  if(kind==="text")return {id,kind,text:"ПРИВЕТ!",speed:65,pause:300};
  if(kind==="twitch")return {id,kind,login:"pwgood",format:"full",speed:65,pause:300};
  if(kind==="live")return {id,kind,login:"pwgood",format:"full",speed:65,pause:300};
  if(kind==="clock")return {id,kind,zone:"BERLIN",mode:"TIME",speed:65,pause:300};
  if(kind==="pixel")return {id,kind,pixels:blankPixels(),frameMs:250,duration:3000};
  if(kind==="video")return {id,kind};
  if(kind==="wait")return {id,kind,ms:1000};
  if(kind==="repeat")return {id,kind,times:3,body:[newNode("text")]};
  if(kind==="if")return {id,kind,combine:"AND",tests:[makeCompare()],body:[newNode("text")],otherwise:[]};
  throw Error("Неизвестный тип блока");
}
function getNode(id,steps=project.steps){
  for(let i=0;i<steps.length;i++){
    const node=steps[i];
    if(node.id===id)return {node,list:steps,index:i};
    for(const branch of ["body","otherwise"])if(Array.isArray(node[branch])){
      const found=getNode(id,node[branch]);if(found)return found;
    }
  }
  return null;
}
function getList(parent,branch){
  if(parent==="root")return project.steps;
  const found=getNode(parent);if(!found)throw Error("Ветка больше не существует");
  if(!["body","otherwise"].includes(branch)||!Array.isArray(found.node[branch]))throw Error("Неверная ветка");
  return found.node[branch];
}
function containsId(node,id){
  if(node.id===id)return true;
  for(const key of ["body","otherwise"])for(const child of node[key]||[])if(containsId(child,id))return true;
  return false;
}
function countNodes(steps=project.steps){
  return steps.reduce((acc,node)=>acc+1+countNodes(node.body||[])+countNodes(node.otherwise||[]),0);
}
function maxDepth(steps=project.steps,level=0){
  return steps.reduce((m,n)=>Math.max(m,
    n.kind==="if"||n.kind==="repeat"?
      Math.max(maxDepth(n.body||[],level+1),maxDepth(n.otherwise||[],level+1)):level),level);
}
function persist(){try{localStorage.setItem(STORAGE,JSON.stringify(project))}catch(_){}}
function defaults(node){
  const src=newNode(node.kind),val={...src,...node};
  val.id=uid();
  if(Array.isArray(src.body))val.body=(node.body||[]).map(defaults);
  if(Array.isArray(src.otherwise))val.otherwise=(node.otherwise||[]).map(defaults);
  if(node.kind==="if"){val.tests=migrateLegacyIf(node);val.combine=node.combine==="OR"?"OR":"AND";}
  return val;
}
function importProject(data){
  if(data&&[63,62,61,6].includes(data.schema)&&Array.isArray(data.steps)){
    project={schema:63,version:"6.3",steps:data.steps.map(defaults)};
  }else if(data&&Array.isArray(data.blocks)){ // Import old v5 JSON, retaining joined messages.
    const nodes=[],blocks=data.blocks;
    const content=(b)=>{
      if(b.type==="text")return String(b.value);
      if(b.type==="count")return "{followers:"+b.value+"}";
      if(b.type==="twitch")return String(b.value).toUpperCase()+": {followers:"+b.value+"}";
      if(b.type==="nick")return String(b.value).toUpperCase();
      if(["date","time","weekday"].includes(b.type))return "{"+b.type+":"+b.value+"}";
      return "";
    };
    for(let i=0;i<blocks.length;i++){
      const b=blocks[i];if(b.type==="join")continue;
      if(i+1<blocks.length&&blocks[i+1].type==="join"){
        const begin=b,parts=[content(b)];
        while(i+2<blocks.length&&blocks[i+1].type==="join"){
          const separator=blocks[i+1].value==="NONE"?"":" ";
          parts.push(separator+content(blocks[i+2]));i+=2;
        }
        nodes.push({...newNode("text"),text:parts.join(""),speed:begin.speed,pause:begin.pauseMs});
        continue;
      }
      const result=b.type==="text"?{kind:"text",text:String(b.value),speed:b.speed,pause:b.pauseMs}:
        ["twitch","count","nick"].includes(b.type)?{kind:"twitch",login:b.value,format:b.type==="count"?"count":"full",speed:b.speed,pause:b.pauseMs}:
        ["date","time","weekday"].includes(b.type)?{kind:"clock",zone:b.value,mode:b.type.toUpperCase(),speed:b.speed,pause:b.pauseMs}:
        b.type==="pixel"?{kind:"pixel",pixels:b.value,frameMs:b.speed,duration:b.pauseMs}:null;
      if(result)nodes.push({...newNode(result.kind),...result});
    }
    if(!nodes.length)throw Error("В JSON нет совместимых блоков");
    project={schema:63,version:"6.3",steps:nodes};
  }else throw Error("Файл не содержит программу Twitch LED");
  active={parent:"root",branch:"root",index:project.steps.length};
  selectedId=null;pixelEditFrame=0;
  render();persist();
}
function field(node,key,size="normal",type="text",lo=null,hi=null){
  const val=node[key]??"";
  return '<input aria-label="'+escapeHtml(key)+'" data-id="'+node.id+'" data-field="'+key+'" type="'+type+'"'+
    (lo!==null?' min="'+lo+'" max="'+hi+'"':'')+
    ' class="'+(size==="wide"?"textwide":"")+'" value="'+escapeHtml(val)+'">';
}
function select(node,key,opts) {
  return '<select aria-label="'+escapeHtml(key)+'" data-id="'+node.id+'" data-field="'+key+'">'+
    opts.map(([v,label])=>'<option value="'+v+'"'+(node[key]===v?' selected':'')+'>'+escapeHtml(label)+'</option>').join("")+
    "</select>";
}
const zoneChoices=Object.keys(zones).map(z=>[z,{BERLIN:"Берлин",MOSCOW:"Москва",VLADIVOSTOK:"Хабаровск",UTC:"UTC"}[z]]);
function exprField(node,testIndex,side,key,expr,choices=null) {
  const attrs='data-expr-owner="'+node.id+'" data-expr-index="'+testIndex+
    '" data-expr-side="'+side+'" data-expr-field="'+key+'"';
  if(choices)return '<select class="expr-field" '+attrs+'>'+
    choices.map(([v,label])=>'<option value="'+escapeHtml(v)+'"'+(String(expr[key])===String(v)?' selected':'')+'>'+escapeHtml(label)+'</option>').join("")+
    '</select>';
  return '<input class="expr-field" type="'+(key==="value"&&expr.kind==="number"?"number":"text")+
    '" '+attrs+' value="'+escapeHtml(expr[key]??"")+'"'+
    (key==="value"&&expr.kind==="number"?' min="-100000" max="100000000" step="1"':'')+'>';
}
function renderSocket(node,index,side,expr) {
  const sel=activeSocket&&activeSocket.id===node.id&&activeSocket.index===index&&activeSocket.side===side;
  const type=exprType(expr);
  const opts=REPORTER_KINDS.map(k=>'<option value="'+k+'"'+(k===expr.kind?' selected':'')+'>'+escapeHtml(EXPR_LABELS[k])+'</option>').join("");
  let extras='';
  if(["weekday","date","time","hour"].includes(expr.kind))
    extras=exprField(node,index,side,"zone",expr,zoneChoices);
  if(["followers","nick","live"].includes(expr.kind))
    extras=exprField(node,index,side,"login",expr);
  if(["text","number"].includes(expr.kind))
    extras=exprField(node,index,side,"value",expr);
  if(expr.kind==="bool")
    extras=exprField(node,index,side,"value",expr,[[true,"ИСТИНА"],[false,"ЛОЖЬ"]]);
  return '<div class="operand-slot'+(sel?' selected':'')+'" tabindex="0" role="group"'+
    ' data-socket-owner="'+node.id+'" data-socket-index="'+index+'" data-socket-side="'+side+'"'+
    ' aria-label="'+(side==="left"?"Левое":"Правое")+' значение для сравнения">'+
    '<span class="socket-heading">'+(side==="left"?"1 · ПЕРВОЕ ЗНАЧЕНИЕ":"2 · ВТОРОЕ ЗНАЧЕНИЕ")+'</span>'+
    '<div class="expr-controls"><select class="expr-kind" data-expr-kind="1" data-expr-owner="'+node.id+
    '" data-expr-index="'+index+'" data-expr-side="'+side+'">'+opts+'</select>'+extras+'</div>'+
    '<span class="expr-type">'+({text:"Текст",number:"Число",bool:"Истина/ложь"}[type]||"Неверный тип")+
    ' · перетащи сюда блок</span></div>';
}
function renderComparisons(node){
  const tests=(node.tests||[]).slice(0,2);
  let out='<div class="condition-wrapper"><div class="condition-heading">◇ СРАВНЕНИЕ ДАННЫХ <span>Перетащи значение в слот</span></div>';
  for(let i=0;i<tests.length;i++){
    const test=tests[i];
    if(i===1)out+='<div class="condition-tools"><span class="join-label">Условия объединяются через</span>'+
      '<select class="combo-select" data-combine="'+node.id+'">'+
      '<option value="AND"'+(node.combine!=="OR"?' selected':'')+'>И (оба истинны)</option>'+
      '<option value="OR"'+(node.combine==="OR"?' selected':'')+'>ИЛИ (хотя бы одно)</option></select></div>';
    out+='<div class="condition-row" data-test-index="'+i+'">'+
      renderSocket(node,i,"left",test.left)+
      '<select class="comp-op" data-comp-op="'+node.id+'" data-comp-index="'+i+'" aria-label="Оператор сравнения">'+
      COMPARE_OPS.map(([op,label])=>'<option value="'+op+'"'+(test.op===op?' selected':'')+'>'+escapeHtml(label)+'</option>').join("")+
      '</select>'+renderSocket(node,i,"right",test.right)+'</div>';
  }
  out+='<div class="condition-tools">';
  if(tests.length<2)out+='<button type="button" class="btn-inline" data-cond-action="append" data-cond-node="'+node.id+'">＋ Добавить сравнение (И / ИЛИ)</button>';
  if(tests.length>1)out+='<button type="button" class="btn-inline danger" data-cond-action="remove" data-cond-node="'+node.id+'">− Убрать второе сравнение</button>';
  out+='</div></div>';
  return out;
}

function nodeClass(n){return ["wait","repeat"].includes(n.kind)?"control":n.kind==="if"?"conditional":"screen"}
function nodeFields(n){
  const tag=(s)=>'<span class="labelsmall">'+s+'</span>';
  if(n.kind==="text")return field(n,"text","wide")+tag("скорость")+field(n,"speed","normal","number",35,140)+tag("мс");
  if(n.kind==="twitch")return field(n,"login")+
    select(n,"format",[["full","ник + число"],["count","только число"]])+
    tag("скорость")+field(n,"speed","normal","number",35,140);
  if(n.kind==="live")return field(n,"login")+
    select(n,"format",[["full","ник + статус"],["state","только статус"]])+
    tag("скорость")+field(n,"speed","normal","number",35,140);
  if(n.kind==="clock")return select(n,"mode",[["TIME","время"],["DATE","дата"],["WEEKDAY","день недели"]])+
    select(n,"zone",zoneChoices)+tag("скорость")+field(n,"speed","normal","number",35,140);
  if(n.kind==="video")return '<span class="labelsmall">Воспроизвести видео, сохранённое на ESP32</span>';
  if(n.kind==="pixel")return '<button type="button" class="edit-pixel" data-action="editPixel" data-id="'+n.id+'">▦ Рисовать</button>'+
    tag("кадр")+field(n,"frameMs","normal","number",100,900)+tag("мс")+tag("показ")+field(n,"duration","normal","number",500,9000)+tag("мс");
  if(n.kind==="wait")return field(n,"ms","normal","number",100,30000)+tag("мс");
  if(n.kind==="repeat")return field(n,"times","normal","number",1,10)+tag("раз");
  if(n.kind==="if")return '<span class="labelsmall">вычислить условие ниже ↓</span>';
  return "";
}
function nodeLabel(n){
  return ({text:"показать",twitch:"показать Twitch",live:"статус стримера",clock:"показать",pixel:"изображение",video:"видео 32×8",wait:"ждать",repeat:"повторить",if:"если"})[n.kind]||n.kind;
}
function insertPoint(parent,branch,index){
  const targeted=active.parent===parent&&active.branch===branch&&active.index===index;
  return '<div class="insert-point'+(targeted?" targeted":"")+'" data-parent="'+parent+'" data-branch="'+branch+
    '" data-index="'+index+'" role="group" aria-label="Место вставки">'+
    '<button type="button" data-action="insertHere" data-parent="'+parent+'" data-branch="'+branch+
    '" data-index="'+index+'">＋ вставить сюда</button></div>';
}
function renderGroup(list,parent,branch){
  let out=insertPoint(parent,branch,0);
  list.forEach((node,i)=>{
    out+=renderNode(node);
    out+=insertPoint(parent,branch,i+1);
  });
  return out;
}
function renderNode(n){
  let out='<article class="node '+nodeClass(n)+(selectedId===n.id?' is-selected':'')+
    '" data-id="'+n.id+'" data-kind="'+n.kind+'">';
  out+='<div class="node-header">'+
    '<span class="node-label">'+({"screen":"▣","control":"↻","conditional":"◇"}[nodeClass(n)]||"▣")+" "+nodeLabel(n)+'</span>'+
    '<div class="fields">'+nodeFields(n)+'</div>'+
    '<div class="node-ops">'+
    '<button draggable="true" type="button" class="drag-handle" data-id="'+n.id+'" title="Перетащить">⠿</button>'+
    '<button type="button" data-action="up" data-id="'+n.id+'" title="Вверх">↑</button>'+
    '<button type="button" data-action="down" data-id="'+n.id+'" title="Вниз">↓</button>'+
    '<button type="button" data-action="duplicate" data-id="'+n.id+'" title="Дублировать">⧉</button>'+
    '<button type="button" data-action="remove" data-id="'+n.id+'" title="Удалить">×</button>'+
    '</div></div>';
  if(n.kind==="text")out+='<div class="helptext">Подстановки: {followers:pwgood}, {time:BERLIN}, {date:BERLIN}, {weekday:BERLIN}</div>';
  if(n.kind==="if")out+=renderComparisons(n);
  if(n.kind==="if"||n.kind==="repeat"){
    out+='<div class="scope"><div class="scope-head">'+(n.kind==="if"?"ТО":"ДЕЙСТВИЯ")+'</div>'+
      renderGroup(n.body,n.id,"body")+'</div>';
    if(n.kind==="if")out+='<div class="scope"><div class="scope-head">ИНАЧЕ</div>'+
      renderGroup(n.otherwise,n.id,"otherwise")+'</div>';
  }
  return out+"</article>";
}
function compileOperand(expr,errors){
  const kind=expr?.kind;
  if(!REPORTER_KINDS.includes(kind)){errors.push("Неизвестный блок значения");return "TXT@0";}
  if(["weekday","date","time","hour"].includes(kind))
    return ({weekday:"DAY",date:"DATE",time:"TIME",hour:"HOUR"}[kind])+"@"+safeZone(expr.zone);
  if(["followers","nick","live"].includes(kind)){
    const login=normLogin(expr.login);
    if(!login)errors.push("Некорректный ник Twitch внутри сравнения");
    return (kind==="followers"?"FOLLOW":kind==="nick"?"NICK":"LIVE")+"@"+(login||"pwgood");
  }
  if(kind==="wifi")return "WIFI";
  if(kind==="number"){
    const raw=String(expr.value??"");
    if(!/^-?\d{1,9}$/.test(raw)||Number(raw)<-100000||Number(raw)>100000000)
      errors.push("Число в сравнении должно быть целым от −100000 до 100000000");
    return "NUM@"+int(raw,-100000,100000000,0);
  }
  if(kind==="bool")return "BOOL@"+(expr.value===false||expr.value==="false"?"0":"1");
  const value=String(expr.value??"");
  if(!value||bytes(value)>48||/[\r\n\x00-\x1f]/.test(value))
    errors.push("Литерал сравнения должен содержать 1–48 байт текста без переносов");
  return "TXT@"+b64(value||" ");
}
function testValidOperator(test,errors){
  const a=exprType(test?.left),b=exprType(test?.right);
  if(!a||a!==b){errors.push("Нельзя сравнить разные типы данных: "+(a||"?")+" и "+(b||"?"));return;}
  if(["GT","GTE","LT","LTE"].includes(test.op)&&a!=="number")
    errors.push("Операторы >, ≥, <, ≤ работают только с числами");
  if(test.op==="CONTAINS"&&a!=="text")
    errors.push("«Содержит» работает только с текстом");
  if(!COMPARE_OPS.some(([v])=>v===test.op))errors.push("Неизвестный оператор сравнения");
}
function compileComparisonNode(node,errors){
  const tests=node.tests||[];
  if(!tests.length||tests.length>2){errors.push("В условии допускается 1 или 2 сравнения");return "IF WIFI";}
  const pieces=tests.map(t=>{
    testValidOperator(t,errors);
    return t.op+" "+compileOperand(t.left,errors)+" "+compileOperand(t.right,errors);
  });
  const command=tests.length===1?"IFCMP "+pieces[0]:
    "IFCMP2 "+(node.combine==="OR"?"OR":"AND")+" "+pieces.join(" ");
  if(command.length>440)errors.push("Условие длиннее предела прошивки (440 символов)");
  return command;
}
function evaluateOperand(expr){
  const kind=expr?.kind;
  if(["weekday","date","time"].includes(kind))
    return {type:"text",value:outputDate(expr.zone,kind.toUpperCase()),valid:true};
  if(kind==="hour"){
    try{
      const value=Number(new Intl.DateTimeFormat("en-US",{timeZone:zones[safeZone(expr.zone)],hour:"numeric",hourCycle:"h23"}).format(new Date()));
      return {type:"number",value,valid:Number.isInteger(value)};
    }catch(_){return {type:"number",value:0,valid:false}}
  }
  if(kind==="followers")return {type:"number",value:475070,valid:true};
  if(kind==="nick")return {type:"text",value:String(normLogin(expr.login)||"PWGOOD").toUpperCase(),valid:true};
  if(kind==="live"){const value=$("demoLive").value;return {type:"bool",value:value==="online",valid:value==="online"||value==="offline"};}
  if(kind==="wifi")return {type:"bool",value:true,valid:true};
  if(kind==="number"){const n=Number(expr.value);return {type:"number",value:n,valid:Number.isInteger(n)}}
  if(kind==="bool")return {type:"bool",value:!(expr.value===false||expr.value==="false"),valid:true};
  if(kind==="text")return {type:"text",value:String(expr.value??""),valid:true};
  return {type:null,value:null,valid:false};
}
function evaluateTest(test){
  const l=evaluateOperand(test.left),r=evaluateOperand(test.right);
  if(!l.valid||!r.valid||l.type!==r.type)return null;
  const a=l.type==="text"?String(l.value).trim().toLocaleUpperCase("ru-RU"):l.value;
  const b=r.type==="text"?String(r.value).trim().toLocaleUpperCase("ru-RU"):r.value;
  switch(test.op){
    case "EQ":return a===b;
    case "NE":return a!==b;
    case "GT":return l.type==="number"&&a>b;
    case "GTE":return l.type==="number"&&a>=b;
    case "LT":return l.type==="number"&&a<b;
    case "LTE":return l.type==="number"&&a<=b;
    case "CONTAINS":return l.type==="text"&&a.includes(b);
    default:return false;
  }
}
function evaluateIf(node){
  if(Array.isArray(node.tests)&&node.tests.length){
    const values=node.tests.map(evaluateTest);
    if(values.includes(null))return null; // An unknown live state must not trigger ELSE as if offline.
    return node.combine==="OR"?values.some(Boolean):values.every(Boolean);
  }
  return false;
}

function validateAndCompile(){
  const commands=[],errors=[];
  function bad(msg){errors.push(msg)}
  function visit(list,depth=0){
    if(depth>MAX_DEPTH)bad("Слишком много вложенных управляющих блоков: максимум "+MAX_DEPTH);
    for(const n of list){
      if(!n||!n.kind)continue;
      switch(n.kind){
        case "text":
          if(!n.text||bytes(n.text)>120)bad("Текст не должен быть пустым или длиннее 120 байт.");
          commands.push("TEXT "+b64(n.text||" ")+" "+int(n.speed,35,140,65)+" "+int(n.pause,0,2500,300));break;
        case "twitch":
          if(!normLogin(n.login))bad("Неверный логин Twitch.");
          commands.push("TWITCH "+(normLogin(n.login)||"pwgood")+" "+(n.format==="count"?"COUNT":"FULL")+" "+int(n.speed,35,140,65)+" "+int(n.pause,0,2500,300));break;
        case "live":{
          const login=normLogin(n.login);
          if(!login)bad("Неверный логин для статуса стримера.");
          commands.push("LIVE "+(login||"pwgood")+" "+(n.format==="state"?"STATE":"FULL")+" "+int(n.speed,35,140,65)+" "+int(n.pause,0,2500,300));break;
        }
        case "clock":
          commands.push("CLOCK "+safeZone(n.zone)+" "+(["TIME","DATE","WEEKDAY"].includes(n.mode)?n.mode:"TIME")+
          " "+int(n.speed,35,140,65)+" "+int(n.pause,0,2500,300));break;
        case "video":commands.push("VIDEO PLAY");break;
        case "pixel":
          if(!/^[0-9A-F]{64}(\.[0-9A-F]{64}){0,3}$/.test(n.pixels||""))bad("Рисунок должен содержать от 1 до 4 кадров 8×32.");
          commands.push("PIXEL "+(n.pixels||blankPixels())+" "+int(n.frameMs,100,900,250)+" "+int(n.duration,500,9000,3000));break;
        case "wait":
          commands.push("WAIT "+int(n.ms,100,30000,1000));break;
        case "repeat":
          commands.push("REPEAT "+int(n.times,1,10,3));visit(n.body||[],depth+1);commands.push("ENDREPEAT");break;
        case "if":
          commands.push(compileComparisonNode(n,errors));
          visit(n.body||[],depth+1);commands.push("ELSE");
          visit(n.otherwise||[],depth+1);commands.push("ENDIF");break;
        default: bad("Неизвестный элемент "+n.kind);
      }
    }
  }
  visit(project.steps);
  if(commands.length===0)bad("Добавь хотя бы одно действие.");
  const liveLogins=new Set();
  for(const cmd of commands){for(const match of cmd.matchAll(/(?:^LIVE | LIVE@)([a-z0-9_]+)/g))liveLogins.add(match[1]);}
  if(liveLogins.size>8)bad("Одна программа поддерживает не более 8 разных стримеров для проверки онлайн-статуса.");
  if(commands.length>MAX_NODES)bad("Программа слишком длинная: "+commands.length+" команд, максимум "+MAX_NODES+".");
  if(maxDepth()>MAX_DEPTH)bad("Допустимо не более трёх уровней вложения.");
  if(!project.steps.some(n=>n.kind!=="wait"))bad("Добавь вывод на экран или условие.");
  return {commands,errors};
}
function render(){
  $("rootList").innerHTML=renderGroup(project.steps,"root","root");
  $("nodeCount").textContent=String(countNodes());
  const {commands,errors}=validateAndCompile();
  $("validation").className="validation"+(errors.length?" error":"");
  $("validation").textContent=errors.length?"Исправить: "+errors.join(" "):
    "✓ Логика корректна. После компиляции: "+commands.length+" команд. Повтор всей программы — автоматически.";
  $("sendScript").disabled=!firmwareOK||busy||errors.length>0;
  $("stopScript").disabled=!firmwareOK||busy;
  $("wifiSave").disabled=!firmwareOK||busy;
  $("checkFirmware").disabled=!port||busy||versionProbeBusy;
  renderResourceStats();
  $("pixelTools").hidden=!selectedId||getNode(selectedId)?.node.kind!=="pixel";
  if(!$("pixelTools").hidden)renderPixelEditor();
}
function updateLight(){const {errors}=validateAndCompile();
  $("validation").className="validation"+(errors.length?" error":"");
  $("validation").textContent=errors.length?errors.join(" "):"✓ Программа корректна · "+countNodes()+" блоков.";
  $("sendScript").disabled=!firmwareOK||busy||errors.length>0;
  $("stopScript").disabled=!firmwareOK||busy;
  $("wifiSave").disabled=!firmwareOK||busy;
  $("checkFirmware").disabled=!port||busy||versionProbeBusy;
  renderResourceStats();
}
function changeNode(id,key,value){
  const found=getNode(id);if(!found)return;
  const n=found.node;
  if(["ms","times","speed","pause","duration","frameMs","threshold","hour"].includes(key)){
    const bounds={ms:[100,30000],times:[1,10],speed:[35,140],pause:[0,2500],
      duration:[500,9000],frameMs:[100,900],threshold:[0,100000000],hour:[0,23]};
    const [lo,hi]=bounds[key];value=int(value,lo,hi,lo);
  }
  n[key]=value;
  persist();updateLight();
}
function setOperand(nodeId,index,side,expr){
  const found=getNode(nodeId);
  if(!found||found.node.kind!=="if"||index<0||index>=found.node.tests.length)return;
  const test=found.node.tests[index];
  if(!REPORTER_KINDS.includes(expr?.kind))return;
  test[side]={...newExpr(expr.kind),...expr};
  const otherSide=side==="left"?"right":"left";
  if(exprType(test[otherSide])!==exprType(test[side]))
    test[otherSide]=defaultOther(exprType(test[side]));
  // Text and boolean comparisons may not use numeric ordering.
  if(exprType(test.left)!=="number"&&["GT","GTE","LT","LTE"].includes(test.op))test.op="EQ";
  if(exprType(test.left)!=="text"&&test.op==="CONTAINS")test.op="EQ";
  activeSocket={id:nodeId,index,side};
  persist();render();
}
function exprFromAction(node){
  if(!node)return null;
  if(node.kind==="text")return {kind:"text",value:String(node.text||"")};
  if(node.kind==="clock")return {kind:({TIME:"time",DATE:"date",WEEKDAY:"weekday"}[node.mode]||"time"),zone:node.zone||"BERLIN"};
  if(node.kind==="twitch")return {kind:"followers",login:node.login||"pwgood"}; // dynamic Twitch metric; nickname reporter is separate
  if(node.kind==="live")return {kind:"live",login:node.login||"pwgood"};
  return null;
}
function setSelectedSocket(el){
  if(!el)return;
  activeSocket={id:el.dataset.socketOwner,index:Number(el.dataset.socketIndex),side:el.dataset.socketSide};
  if(typeof document.querySelectorAll==="function")
    document.querySelectorAll(".operand-slot").forEach(x=>x.classList.toggle("selected",
      x.dataset.socketOwner===activeSocket.id&&Number(x.dataset.socketIndex)===activeSocket.index&&
      x.dataset.socketSide===activeSocket.side));
}
function setExpressionField(owner,index,side,key,value,reregister=false){
  const node=getNode(owner)?.node;
  if(!node||node.kind!=="if"||!node.tests[index]||!node.tests[index][side])return;
  const expr=node.tests[index][side];
  if(key==="zone")expr.zone=safeZone(value);
  else if(key==="login")expr.login=String(value);
  else if(key==="value"){
    expr.value=expr.kind==="bool"?value!=="false":expr.kind==="number"?String(value):value;
  }
  persist();updateLight();
  if(reregister)render();
}
function insertAt(kind,parent,branch,index){
  if(countNodes()>=MAX_NODES-3){message("Превышен лимит блоков: "+MAX_NODES);return;}
  try{
    const list=getList(parent,branch);
    const node=newNode(kind);
    const pos=Math.min(Math.max(0,index),list.length);
    list.splice(pos,0,node);
    if(maxDepth()>MAX_DEPTH){list.splice(pos,1);throw Error("Глубина вложенности не более "+MAX_DEPTH)}
    active={parent,branch,index:pos+1};
    selectedId=node.id;persist();render();message("Блок «"+nodeLabel(node)+"» вставлен в программу");
  }catch(e){message(e.message)}
}

function addToActive(kind){insertAt(kind,active.parent,active.branch,active.index)}
function moveNode(id,parent,branch,index){
  const found=getNode(id);if(!found)return;
  try{
    const targetList=getList(parent,branch);
    const parentNode=parent==="root"?null:getNode(parent)?.node;
    if(parentNode&&containsId(found.node,parentNode.id))throw Error("Нельзя переместить блок внутрь самого себя");
    const prev=found.list,old=found.index;
    let dest=Math.min(index,targetList.length);
    if(prev===targetList&&old<dest)dest--;
    if(prev===targetList&&dest===old)return;
    prev.splice(old,1);
    targetList.splice(dest,0,found.node);
    if(maxDepth()>MAX_DEPTH){
      targetList.splice(dest,1);prev.splice(old,0,found.node);
      throw Error("Максимальная вложенность: 3 уровня");
    }
    active={parent,branch,index:dest+1};persist();render();
  }catch(e){message(e.message);}
}
function actionBlock(action,id){
  const found=getNode(id);if(!found)return;
  const {list,index,node}=found;
  if(action==="remove"){list.splice(index,1);selectedId=null;}
  if(action==="up"&&index>0){[list[index-1],list[index]]=[list[index],list[index-1]]}
  if(action==="down"&&index<list.length-1){[list[index+1],list[index]]=[list[index],list[index+1]]}
  if(action==="duplicate"){
    if(countNodes()>=MAX_NODES-3){message("Достигнут лимит блоков");return}
    list.splice(index+1,0,defaults(node));
  }
  if(action==="editPixel"){selectedId=id;pixelEditFrame=0;}
  persist();render();
}
function message(txt){$("simState").textContent=txt;}
$("program").addEventListener("click",e=>{
  const comparison=e.target.closest("button[data-cond-action]");
  if(comparison){
    const node=getNode(comparison.dataset.condNode)?.node;
    if(!node||node.kind!=="if")return;
    if(comparison.dataset.condAction==="append"&&node.tests.length<2)
      node.tests.push(makeCompare(newExpr("followers"),newExpr("number")));
    if(comparison.dataset.condAction==="remove"&&node.tests.length>1)node.tests.pop();
    persist();render();return;
  }
  const socket=e.target.closest(".operand-slot");
  if(socket){setSelectedSocket(socket);return}
  const btn=e.target.closest("button[data-action]");if(!btn)return;
  const action=btn.dataset.action;
  if(action==="insertHere"){
    active={parent:btn.dataset.parent,branch:btn.dataset.branch,index:Number(btn.dataset.index)};
    render();message("Выбрано место вставки. Нажми или перетащи команду из палитры.");return;
  }
  if(["up","down","duplicate","remove","editPixel"].includes(action))actionBlock(action,btn.dataset.id);
});
$("program").addEventListener("input",e=>{
  const field=e.target.closest("input[data-expr-field]");
  if(field){
    setExpressionField(field.dataset.exprOwner,Number(field.dataset.exprIndex),field.dataset.exprSide,
      field.dataset.exprField,field.value,false);return;
  }
  const inp=e.target.closest("input[data-field]");if(!inp)return;
  changeNode(inp.dataset.id,inp.dataset.field,inp.value);
});
$("program").addEventListener("change",e=>{
  const el=e.target;
  const kind=el.closest("[data-expr-kind]");
  if(kind){
    setOperand(kind.dataset.exprOwner,Number(kind.dataset.exprIndex),kind.dataset.exprSide,
      newExpr(kind.value));return;
  }
  const field=el.closest("[data-expr-field]");
  if(field){
    setExpressionField(field.dataset.exprOwner,Number(field.dataset.exprIndex),field.dataset.exprSide,
      field.dataset.exprField,field.value,false);
    render();return;
  }
  const op=el.closest("[data-comp-op]");
  if(op){
    const n=getNode(op.dataset.compOp)?.node;
    if(n?.kind==="if"&&n.tests[Number(op.dataset.compIndex)]){
      n.tests[Number(op.dataset.compIndex)].op=op.value;persist();render();
    }
    return;
  }
  const combine=el.closest("[data-combine]");
  if(combine){
    const n=getNode(combine.dataset.combine)?.node;
    if(n?.kind==="if"){n.combine=combine.value==="OR"?"OR":"AND";persist();render()}
    return;
  }
  const elem=el.closest("[data-field]");if(!elem)return;
  changeNode(elem.dataset.id,elem.dataset.field,elem.value);
  if(elem.tagName==="SELECT")render();
  else if(elem.type==="number")elem.value=getNode(elem.dataset.id)?.node[elem.dataset.field]??elem.value;
});
document.querySelectorAll("[data-add]").forEach(button=>{
  button.addEventListener("click",()=>addToActive(button.dataset.add));
  button.addEventListener("dragstart",e=>{
    dragged={source:"palette-action",kind:button.dataset.add};
    e.dataTransfer.effectAllowed="copy";
    e.dataTransfer.setData("text/plain","action:"+dragged.kind);
  });
  button.addEventListener("dragend",clearDrag);
});
document.querySelectorAll("[data-reporter]").forEach(button=>{
  button.addEventListener("click",()=>{
    if(!activeSocket){message("Выбери ячейку сравнения внутри блока «если»");return;}
    setOperand(activeSocket.id,activeSocket.index,activeSocket.side,newExpr(button.dataset.reporter));
  });
  button.addEventListener("dragstart",e=>{
    dragged={source:"palette-reporter",kind:button.dataset.reporter};
    e.dataTransfer.effectAllowed="copy";
    e.dataTransfer.setData("text/plain","reporter:"+dragged.kind);
  });
  button.addEventListener("dragend",clearDrag);
});
let dragged=null;
function clearDrag(){
  dragged=null;
  document.querySelectorAll(".dragging,.drop-over").forEach(el=>el.classList.remove("dragging","drop-over"));
}
$("program").addEventListener("dragstart",e=>{
  const handle=e.target.closest(".drag-handle");if(!handle)return;
  dragged={source:"node",id:handle.dataset.id};
  e.dataTransfer.effectAllowed="copyMove";
  e.dataTransfer.setData("text/plain","node:"+dragged.id);
  handle.closest(".node")?.classList.add("dragging");
});
$("program").addEventListener("dragend",clearDrag);
$("program").addEventListener("dragover",e=>{
  if(!dragged)return;
  const socket=e.target.closest(".operand-slot");
  if(socket&&(dragged.source==="palette-reporter"||
      (dragged.source==="node"&&exprFromAction(getNode(dragged.id)?.node)))){
    e.preventDefault();e.dataTransfer.dropEffect="copy";socket.classList.add("drop-over");return;
  }
  const place=e.target.closest(".insert-point");
  if(place&&["palette-action","node"].includes(dragged.source)){
    e.preventDefault();e.dataTransfer.dropEffect=dragged.source==="node"?"move":"copy";
    place.classList.add("drop-over");
  }
});
$("program").addEventListener("dragleave",e=>{
  const el=e.target.closest(".insert-point,.operand-slot");
  if(el)el.classList.remove("drop-over");
});
$("program").addEventListener("drop",e=>{
  if(!dragged)return;
  const dropped=dragged;
  const socket=e.target.closest(".operand-slot");
  if(socket&&["palette-reporter","node"].includes(dropped.source)){
    const expr=dropped.source==="palette-reporter"?newExpr(dropped.kind):
      exprFromAction(getNode(dropped.id)?.node);
    if(expr){
      e.preventDefault();
      setOperand(socket.dataset.socketOwner,Number(socket.dataset.socketIndex),socket.dataset.socketSide,expr);
      message("Блок-значение вставлен в сравнение");
      clearDrag();return;
    }
  }
  const place=e.target.closest(".insert-point");
  if(place&&["palette-action","node"].includes(dropped.source)){
    e.preventDefault();
    const parent=place.dataset.parent,branch=place.dataset.branch,index=Number(place.dataset.index);
    if(dropped.source==="palette-action")insertAt(dropped.kind,parent,branch,index);
    else moveNode(dropped.id,parent,branch,index);
    clearDrag();return;
  }
});
$("reset").addEventListener("click",()=>{if(!confirm("Создать новый проект? Сохрани текущий в JSON, если нужен."))return;project=blankProject();selectedId=null;active={parent:"root",branch:"root",index:project.steps.length};persist();render()});
$("exportBtn").addEventListener("click",()=>{
  const blob=new Blob([JSON.stringify(project,null,2)],{type:"application/json"});
  const a=document.createElement("a"),url=URL.createObjectURL(blob);
  a.href=url;a.download="twitch-led-logic-v6.3.json";a.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
});
$("importBtn").addEventListener("click",()=>$("importFile").click());
$("importFile").addEventListener("change",async e=>{
  const file=e.target.files?.[0];if(!file)return;
  try{if(file.size>40000)throw Error("Файл больше 40 КБ");const data=JSON.parse(await file.text());importProject(data);message("Проект импортирован");}
  catch(err){message("Ошибка импорта: "+err.message)}finally{e.target.value=""}
});
function decodeFrames(data){return String(data).split(".").map(f=>{
  const arr=[];for(let col=0;col<32;col++)arr.push(parseInt(f.slice(col*2,col*2+2),16)||0);
  return arr;
})}
function encodeFrames(arr){return arr.map(cols=>cols.map(n=>(n&255).toString(16).toUpperCase().padStart(2,"0")).join("")).join(".")}
function renderPixelEditor(){
  const n=getNode(selectedId)?.node;if(!n||n.kind!=="pixel")return;
  const frames=decodeFrames(n.pixels);pixelEditFrame=Math.min(pixelEditFrame,frames.length-1);
  const cols=frames[pixelEditFrame];
  $("pixelFrameInfo").textContent="Кадр "+(pixelEditFrame+1)+"/"+frames.length;
  $("pixelAddFrame").disabled=frames.length>=4;$("pixelRemoveFrame").disabled=frames.length<=1;
  const container=$("pixelGrid");container.replaceChildren();
  for(let y=0;y<8;y++)for(let x=0;x<32;x++){
    const b=document.createElement("button");b.type="button";
    b.dataset.x=x;b.dataset.y=y;b.setAttribute("aria-label","Пиксель "+x+"," +y);
    b.classList.toggle("on",Boolean(cols[x]&(1<<y)));container.appendChild(b);
  }
}
function pixelMutate(fn){
  const n=getNode(selectedId)?.node;if(!n||n.kind!=="pixel")return;
  const frames=decodeFrames(n.pixels);fn(frames);
  n.pixels=encodeFrames(frames);persist();renderPixelEditor();updateLight();
}
$("pixelGrid").addEventListener("pointerdown",e=>{
  const button=e.target.closest("button[data-x]");if(!button)return;
  pixelPainting=true;
  const n=getNode(selectedId).node,cols=decodeFrames(n.pixels)[pixelEditFrame];
  pixelPaintOn=!(cols[Number(button.dataset.x)]&(1<<Number(button.dataset.y)));
  paintPixelButton(button,pixelPaintOn);
});
$("pixelGrid").addEventListener("pointerover",e=>{
  if(pixelPainting)paintPixelButton(e.target.closest("button[data-x]"),pixelPaintOn);
});
$("pixelGrid").addEventListener("pointermove",e=>{
  if(!pixelPainting||typeof document.elementFromPoint!=="function")return;
  const b=document.elementFromPoint(e.clientX,e.clientY)?.closest("button[data-x]");
  if(b&&$("pixelGrid").contains(b))paintPixelButton(b,pixelPaintOn);
});
for(const event of ["pointerup","pointercancel","pointerleave"])$("pixelGrid").addEventListener(event,()=>pixelPainting=false);
function paintPixelButton(b,on){
  if(!b)return;
  const x=Number(b.dataset.x),y=Number(b.dataset.y),n=getNode(selectedId)?.node;
  if(!n||n.kind!=="pixel")return;
  const frames=decodeFrames(n.pixels);
  if(on)frames[pixelEditFrame][x]|=1<<y;
  else frames[pixelEditFrame][x]&=~(1<<y);
  n.pixels=encodeFrames(frames);
  b.classList.toggle("on",on);persist();updateLight();
}
$("pixelPrev").addEventListener("click",()=>{pixelEditFrame=Math.max(0,pixelEditFrame-1);renderPixelEditor()});
$("pixelNext").addEventListener("click",()=>{const n=getNode(selectedId)?.node;if(!n)return;pixelEditFrame=Math.min(decodeFrames(n.pixels).length-1,pixelEditFrame+1);renderPixelEditor()});
$("pixelAddFrame").addEventListener("click",()=>pixelMutate(frames=>{if(frames.length<4){frames.splice(pixelEditFrame+1,0,[...frames[pixelEditFrame]]);pixelEditFrame++}}));
$("pixelRemoveFrame").addEventListener("click",()=>pixelMutate(frames=>{if(frames.length>1){frames.splice(pixelEditFrame,1);pixelEditFrame=Math.max(0,pixelEditFrame-1)}}));
$("pixelClear").addEventListener("click",()=>pixelMutate(frames=>frames[pixelEditFrame]=Array(32).fill(0)));
$("pixelInvert").addEventListener("click",()=>pixelMutate(frames=>frames[pixelEditFrame]=frames[pixelEditFrame].map(b=>b^255)));
function initMatrix(){
  const box=$("ledMatrix");box.replaceChildren();
  for(let i=0;i<256;i++){const dot=document.createElement("i");box.append(dot);matrixDots.push(dot)}
}
function showMatrix(columns){
  for(let y=0;y<8;y++)for(let x=0;x<32;x++){
    const v=(columns[x]||0)&(1<<y);
    matrixDots[y*32+x].classList.toggle("on",Boolean(v));
  }
}
function textColumns(text){
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(64,Math.min(1200,Math.ceil(text.length*7.5)+40));canvas.height=8;
  const ctx=canvas.getContext("2d");
  if(!ctx)return Array(40).fill(0);
  ctx.clearRect(0,0,canvas.width,8);
  ctx.font="bold 8px monospace";ctx.textBaseline="top";ctx.fillStyle="#ffffff";
  ctx.fillText(text,33,-1);
  const data=ctx.getImageData(0,0,canvas.width,8).data,cols=[];
  for(let x=0;x<canvas.width;x++){
    let b=0;for(let y=0;y<8;y++)if(data[(y*canvas.width+x)*4+3]>70)b|=1<<y;
    cols.push(b);
  }
  cols.push(...Array(34).fill(0));return cols;
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function stopSimulation(){simulation++;$("simState").textContent="Симуляция остановлена";}
function simIsActive(token){return token===simulation}
function readCondition(n) {return evaluateIf(n);}
async function showSimText(text,token){
  const columns=textColumns(text);
  $("previewLabel").textContent=text;
  for(let p=0;p<Math.max(1,columns.length-31);p++){
    if(!simIsActive(token))return;
    showMatrix(columns.slice(p,p+32));await pause(24);
  }
}
async function simulateList(list,token){
  for(const node of list){
    if(!simIsActive(token))return;
    if(node.kind==="if"){
      const result=readCondition(node);
      $("simState").textContent="СРАВНЕНИЕ → "+(result===null?"нет данных":result?"истина":"ложь")+" (симуляция)";
      if(result!==null)await simulateList(result?node.body:node.otherwise,token);continue;
    }
    if(node.kind==="repeat"){
      for(let n=0;n<node.times&&simIsActive(token);n++)await simulateList(node.body,token);
      continue;
    }
    if(node.kind==="wait"){message("Ожидание "+node.ms+" мс");await pause(Math.min(1600,node.ms));continue;}
    if(node.kind==="video"){
      if(!videoData){await showSimText("NO VIDEO",token);continue;}
      for(let f=0;f<videoData.frames&&simIsActive(token);f++){
        showMatrix(Array.from(videoData.data.slice(f*32,f*32+32)));
        $("previewLabel").textContent="Видео · кадр "+(f+1)+"/"+videoData.frames;
        await pause(Math.round(1000/videoData.fps));
      }
      continue;
    }
    if(node.kind==="pixel"){
      const frames=decodeFrames(node.pixels),start=Date.now();
      $("previewLabel").textContent="Пиксельная картинка · "+frames.length+" кадр(а)";
      while(simIsActive(token)&&Date.now()-start<Math.min(node.duration,9000)){
        const i=Math.floor((Date.now()-start)/node.frameMs)%frames.length;
        showMatrix(frames[i]);await pause(Math.min(150,node.frameMs));
      }continue;
    }
    let text="";
    if(node.kind==="text")text=expandPreviewText(node.text);
    if(node.kind==="twitch")text=node.format==="count"?followerValue(node.login):
      String(node.login).toUpperCase()+": "+followerValue(node.login);
    if(node.kind==="clock")text=outputDate(node.zone,node.mode);
    if(node.kind==="live"){
      const v=$("demoLive").value;
      const status=v==="online"?"ОНЛАЙН":v==="offline"?"ОФЛАЙН":"НЕТ ДАННЫХ";
      text=node.format==="state"?status:String(node.login).toUpperCase()+": "+status;
    }
    await showSimText(text,token);await pause(200);
  }
}
$("playDemo").addEventListener("click",async()=>{
  const token=++simulation;
  $("simState").textContent="Демо: Twitch и онлайн-статус моделируются, реальные запросы делает ESP32.";
  while(simIsActive(token)){
    await simulateList(project.steps,token);
    if(!simIsActive(token))return;
    await pause(250);
  }
});
$("stopDemo").addEventListener("click",stopSimulation);
/* USB: local Web Serial only. Never flash from this page. The classic web updater
   remains separate and cannot be used for ESP32-S3. */
function usbLog(msg){const pre=$("usbLog");if(pre.textContent==="Нет соединения")pre.textContent="";pre.textContent+="\n"+msg;pre.scrollTop=pre.scrollHeight}
function usbStatus(msg,okay=false){$("deviceStatus").textContent="● "+msg;$("deviceStatus").classList.toggle("ready",okay)}
async function serialSend(s){
  if(!port?.writable)throw Error("USB не подключён");
  const writer=port.writable.getWriter();
  try{await writer.write(enc.encode(s+"\n"))}finally{writer.releaseLock()}
}
function waitAck(prefix,timeout=10000,errorPrefix="ERR"){
  if(pending)throw Error("Не завершена предыдущая команда");
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(pending===item){pending=null;reject(Error("Нет ответа: "+prefix))}},timeout);
    const item={prefix,errorPrefix,resolve:x=>{clearTimeout(timer);resolve(x)},reject};
    pending=item;
  });
}
async function cmd(command,prefix,timeout=10000){
  const promise=waitAck(prefix,timeout,"ERR "+command.split(" ")[0]);
  await serialSend(command);
  return promise;
}
function onSerialLine(line){
  const s=line.trim();if(!s)return;
  usbLog(s.slice(0,500));
  if(/^MEM fs=/.test(s)){readMemoryInfo(s);return;}
  if(/^VERSION TWITCHLED(?:\s|$)/.test(s)){
    versionReply=s;
    firmwareOK=/^VERSION TWITCHLED 6\.3(?:\s|$)/.test(s)&&/\bSCRIPT2\b/.test(s)&&/\bLIVE1\b/.test(s)&&/\bVIDEO1\b/.test(s)&&/\bMEM1\b/.test(s);
    if(firmwareOK)usbStatus("Совместимая прошивка v6.3 (SCRIPT2 LIVE1 VIDEO1 MEM1)",true);
    else usbStatus("Плата ответила: "+s.slice(0,90)+" — несовместимая версия");
    render(); // Accept a late VERSION answer without reconnecting.
  }
  if(pending&&(s.startsWith(pending.prefix)||s.startsWith(pending.errorPrefix))){
    const p=pending;pending=null;
    if(s.startsWith("ERR"))p.reject(Error(s));else p.resolve(s);
  }
}
async function serialRead(){
  try{
    while(port?.readable){
      reader=port.readable.getReader();
      try{
        while(true){
          const {value,done}=await reader.read();if(done)break;
          rx+=new TextDecoder().decode(value,{stream:true});
          let i;while((i=rx.indexOf("\n"))!==-1){onSerialLine(rx.slice(0,i));rx=rx.slice(i+1);}
          if(rx.length>4000)rx="";
        }
      }finally{reader.releaseLock();reader=null}
    }
  }catch(e){usbLog("Ошибка чтения: "+e.message)}
}
// Web Serial can reset the board on open; check repeatedly rather than assuming
// a lack of reply after 400 ms means old firmware.
async function probeFirmware(){
  if(!port?.writable||busy){usbStatus("Сначала подключи ESP32 через USB");return;}
  const seq=++versionCheckSeq;
  versionProbeBusy=true;versionReply="";firmwareOK=false;
  usbStatus("Запрашиваю VERSION у ESP32...");render();
  try{
    for(const delay of [800,1500,2400,3000]){
      if(seq!==versionCheckSeq||!port?.writable||versionReply)break;
      usbLog("→ VERSION");
      await serialSend("VERSION");
      await pause(delay);
    }
    if(seq!==versionCheckSeq||!port)return;
    if(firmwareOK)await serialSend("MEM INFO");
    if(!versionReply){
      usbStatus("Нет ответа на VERSION. Нажми EN/RESET на ESP32, затем «Проверить версию»");
      usbLog("Нет ответа на VERSION: это ещё не доказательство старой прошивки.");
    }
  }catch(e){
    if(seq===versionCheckSeq){
      usbStatus("Не удалось проверить VERSION: "+e.message);
      usbLog("Ошибка запроса VERSION: "+e.message);
    }
  }finally{
    if(seq===versionCheckSeq){versionProbeBusy=false;render();}
  }
}
$("checkFirmware").addEventListener("click",probeFirmware);
$("usbConnect").addEventListener("click",async()=>{
  if(!("serial" in navigator)){usbStatus("Нужен Chrome/Edge с Web Serial");return}
  try{
    port=await navigator.serial.requestPort();
    await port.open({baudRate:115200,bufferSize:8192,flowControl:"none"});
    firmwareOK=false;deviceMemory=null;usbStatus("Проверяю прошивку...");
    $("usbConnect").disabled=true;$("usbDisconnect").disabled=false;
    readTask=serialRead();
    await pause(1250);
    if(port)await probeFirmware();
  }catch(e){
    usbStatus("Ошибка USB: "+e.message);
    deviceMemory=null;
    const opened=port;port=null;versionCheckSeq++;versionProbeBusy=false;
    try{await reader?.cancel();if(readTask)await readTask;await opened?.close()}catch(_){}
    $("usbConnect").disabled=false;$("usbDisconnect").disabled=true;render();
  }
});
$("usbDisconnect").addEventListener("click",async()=>{
  firmwareOK=false;busy=false;versionCheckSeq++;versionProbeBusy=false;versionReply="";deviceMemory=null;
  // Drop the shared reference before cancelling read, so serialRead's loop exits.
  const oldPort=port;port=null;
  try{await reader?.cancel();if(readTask)await readTask;await oldPort?.close()}catch(e){usbLog("USB: "+e.message);}
  rx="";pending=null;readTask=null;
  $("usbConnect").disabled=false;$("usbDisconnect").disabled=true;
  usbStatus("Не подключено");render();
});
$("stopScript").addEventListener("click",async()=>{
  if(!firmwareOK||busy)return;
  if(!confirm("Остановить программу Logic v6 и вернуться к предыдущему сценарию v5.5 на ESP32?"))return;
  busy=true;render();
  try{await cmd("SCRIPT STOP","OK SCRIPT STOP");usbStatus("Логика остановлена, старый сценарий возобновлён",true);}
  catch(e){usbStatus("Не удалось остановить скрипт: "+e.message)}
  finally{busy=false;render()}
});
$("wifiSave").addEventListener("click",async()=>{
  if(!firmwareOK||busy)return;
  const ssid=$("wifiSsid").value,password=$("wifiPassword").value;
  if(!ssid||!password||bytes(ssid)>32||bytes(password)>64||
      ssid.includes("|")||/[\r\n]/.test(ssid+password)){
    usbStatus("Проверь SSID и пароль: не более 32/64 байт и без переносов");return;
  }
  busy=true;render();
  try{
    const result=await cmd("WIFI "+ssid+"|"+password,"OK WIFI SAVED");
    $("wifiPassword").value="";
    usbStatus("Wi-Fi сохранён на ESP32 ("+ssid+")",true);
    usbLog("Wi-Fi: "+result);
  }catch(e){usbStatus("Ошибка настройки Wi-Fi: "+e.message)}
  finally{busy=false;render()}
});
$("sendScript").addEventListener("click",async()=>{
  if(!firmwareOK||busy)return;
  const {commands,errors}=validateAndCompile();if(errors.length){message(errors.join(" "));return}
  if(!confirm("Записать "+commands.length+" команд на ESP32 с SCRIPT2 LIVE1? Прежняя версия сценария на устройстве будет заменена."))return;
  busy=true;render();
  try{
    await cmd("SCRIPT BEGIN","OK SCRIPT BEGIN");
    for(let i=0;i<commands.length;i++){
      await cmd("SCRIPT ADD "+commands[i],"OK SCRIPT ADD",12000);
      usbStatus("Передаю программу: "+(i+1)+"/"+commands.length,true);
    }
    await cmd("SCRIPT COMMIT","OK SCRIPT SAVED");
    await cmd("SCRIPT RUN","OK SCRIPT RUN");
    await serialSend("MEM INFO");
    usbStatus("Программа записана и запущена!",true);
    message("Устройство подтвердило запись "+commands.length+" команд");
  }catch(e){
    usbStatus("Ошибка передачи: "+e.message);
    usbLog("Попробуй SCRIPT CANCEL, старую прошивку не стирай.");
    try{await serialSend("SCRIPT CANCEL")}catch(_){}
  }finally{busy=false;render()}
});
// --------------------- Logic v6.3 video + resource manager ------------------
const formatBytes=n=>{
  if(!Number.isFinite(n)||n<0)return "—";
  const val=n>=1048576?n/1048576:n>=1024?n/1024:n;
  const unit=n>=1048576?"МБ":n>=1024?"КБ":"Б";
  return new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(val)+" "+unit;
};
function readMemoryInfo(line){
  const fields={};
  for(const [_,key,val] of line.matchAll(/\b(fs|total|used|free|video|frames|fps|script|cmds)=(\d+)\b/g))
    fields[key]=Number(val);
  if(!Number.isFinite(fields.fs)||!Number.isFinite(fields.total)||
     !Number.isFinite(fields.free)||fields.total<0||fields.free>fields.total)return;
  deviceMemory=fields;renderResourceStats();
}
function renderResourceStats(){
  const {commands}=validateAndCompile();
  // Exact UTF-8 payload, not a claim about NVS allocation/overhead.
  const scriptBytes=commands.reduce((sum,c)=>sum+bytes(c)+1,0);
  $("scriptSize").textContent=formatBytes(scriptBytes)+" · "+commands.length+" команд";
  $("scriptSaved").textContent=deviceMemory?formatBytes(deviceMemory.script||0):"—";
  const fs=deviceMemory?.fs===1,total=fs?deviceMemory.total:0,free=fs?deviceMemory.free:0;
  $("fsFree").textContent=fs?formatBytes(free)+" из "+formatBytes(total):deviceMemory?"Не подготовлено":"— (подключи ESP32)";
  $("fsBar").style.width=fs&&total>0?Math.max(0,Math.min(100,(total-free)/total*100)).toFixed(1)+"%":"0%";
  $("deviceClip").textContent=fs&&deviceMemory.video>0?
    formatBytes(deviceMemory.video)+" · "+deviceMemory.frames+" кадров / "+deviceMemory.fps+" FPS":
    fs?"Нет видео":deviceMemory?"Раздел не подготовлен":"—";
  $("videoEstimate").textContent=videoData?
    formatBytes(videoData.data.length+12)+" · "+videoData.frames+" кадров / "+videoData.fps+" FPS":
    "Загрузите и обработайте видео";
  $("initVideoFs").disabled=!firmwareOK||busy||videoSending||!deviceMemory||deviceMemory.fs!==0;
  $("deleteVideo").disabled=!firmwareOK||busy||videoSending||!fs||!(deviceMemory.video>0);
  $("uploadVideo").disabled=!firmwareOK||busy||videoSending||videoConverting||
    !videoData||!fs||free<videoData.data.length+12+8192;
  $("convertVideo").disabled=videoConverting||videoSending||!$("videoFile").files?.length;
  $("cancelVideo").disabled=!videoConverting;
}
function videoStatus(text){$("videoStatus").textContent=text;}
function videoCRC32(buffer){
  let crc=0xFFFFFFFF;
  for(const b of buffer){
    crc=(crc^b)>>>0;
    for(let bit=0;bit<8;bit++)crc=(crc&1)?((crc>>>1)^0xEDB88320):(crc>>>1);
  }
  return (crc^0xFFFFFFFF)>>>0;
}
function showVideoFrame(frame){
  if(!videoData)return;
  const index=Math.max(0,Math.min(videoData.frames-1,Number(frame)||0));
  const ctx=$("videoPreview").getContext("2d");
  if(!ctx)return;
  const image=ctx.createImageData(32,8);
  for(let y=0;y<8;y++)for(let x=0;x<32;x++){
    const lit=Boolean(videoData.data[index*32+x]&(1<<y));
    const p=(y*32+x)*4;
    image.data[p]=lit?245:13;
    image.data[p+1]=lit?90:22;
    image.data[p+2]=lit?93:36;
    image.data[p+3]=255;
  }
  ctx.putImageData(image,0,0);
  $("videoPosition").textContent=(index+1)+" / "+videoData.frames;
  $("videoScrub").value=String(index);
}
function stopPreviewAnimation(){
  if(videoPreviewTimer!==null)clearInterval(videoPreviewTimer);
  videoPreviewTimer=null;$("previewVideo").textContent="▶ Предпросмотр";
}
$("videoScrub").addEventListener("input",e=>{stopPreviewAnimation();showVideoFrame(e.target.value)});
$("previewVideo").addEventListener("click",()=>{
  if(!videoData)return;
  if(videoPreviewTimer!==null){stopPreviewAnimation();return;}
  let pos=Number($("videoScrub").value)||0;
  $("previewVideo").textContent="■ Стоп";
  videoPreviewTimer=setInterval(()=>{
    if(!videoData){stopPreviewAnimation();return;}
    if(pos>=videoData.frames){pos=0;stopPreviewAnimation();return;}
    showVideoFrame(pos++);
  },Math.max(50,Math.round(1000/videoData.fps)));
});
$("videoFile").addEventListener("change",()=>{
  videoData=null;stopPreviewAnimation();
  const file=$("videoFile").files?.[0];
  videoStatus(file?file.name+" · "+formatBytes(file.size)+" · нажми «Преобразовать»":"Файл не выбран");
  renderResourceStats();
});
$("cancelVideo").addEventListener("click",()=>{
  videoConversionSeq++;
  videoStatus("Отмена обработки запрошена.");
});
function videoEvent(video,event,timeout=20000){
  return new Promise((resolve,reject)=>{
    const cancel=()=>{video.removeEventListener(event,ok);video.removeEventListener("error",bad);clearTimeout(timer);};
    const ok=()=>{cancel();resolve();};
    const bad=()=>{cancel();reject(Error("Браузер не смог декодировать видео. Попробуй MP4/H.264 или WebM."));};
    const timer=setTimeout(()=>{cancel();reject(Error("Декодирование видео заняло слишком много времени."))},timeout);
    video.addEventListener(event,ok,{once:true});
    video.addEventListener("error",bad,{once:true});
  });
}
async function seekVideo(video,time){
  if(Math.abs(video.currentTime-time)<0.001&&video.readyState>=2)return;
  const ready=videoEvent(video,"seeked");
  video.currentTime=time;
  await ready;
}
function drawVideoSized(ctx,video,mode){
  ctx.fillStyle="#000";ctx.fillRect(0,0,32,8);
  const sw=video.videoWidth,sh=video.videoHeight;
  if(mode==="stretch"){ctx.drawImage(video,0,0,32,8);return;}
  const k=mode==="fit"?Math.min(32/sw,8/sh):Math.max(32/sw,8/sh);
  if(mode==="fit"){
    const w=sw*k,h=sh*k;
    ctx.drawImage(video,(32-w)/2,(8-h)/2,w,h);
  }else{
    const w=32/k,h=8/k;
    ctx.drawImage(video,(sw-w)/2,(sh-h)/2,w,h,0,0,32,8);
  }
}
$("convertVideo").addEventListener("click",async()=>{
  if(videoConverting||videoSending)return;
  const file=$("videoFile").files?.[0];
  if(!file)return;
  if(file.size>VIDEO_SOURCE_LIMIT){videoStatus("Исходный файл больше 100 МБ.");return;}
  if(!/^video\//.test(file.type)&&!/\.(mp4|webm|ogv|mov)$/i.test(file.name)){
    videoStatus("Поддерживаются видео MP4/WebM, если браузер может их декодировать.");return;
  }
  videoConverting=true;const seq=++videoConversionSeq;
  stopPreviewAnimation();videoData=null;renderResourceStats();
  const fps=Math.max(2,Math.min(20,Number($("videoFps").value)||10));
  const seconds=Math.max(1,Math.min(120,Number($("videoSeconds").value)||30));
  const threshold=Math.max(0,Math.min(255,Number($("videoThreshold").value)||128));
  const mode=$("videoFit").value;
  const invert=$("videoInvert").checked;
  const video=document.createElement("video");
  video.muted=true;video.preload="auto";video.playsInline=true;
  const url=URL.createObjectURL(file);
  try{
    const loaded=videoEvent(video,"loadeddata",30000);
    video.src=url;video.load();await loaded;
    if(!Number.isFinite(video.duration)||video.duration<=0||video.videoWidth===0)
      throw Error("Не удалось определить длительность и разрешение видео.");
    const span=Math.min(video.duration,seconds,VIDEO_MAX_FRAMES/fps);
    const frames=Math.max(1,Math.ceil(span*fps));
    const canvas=document.createElement("canvas");canvas.width=32;canvas.height=8;
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    if(!ctx)throw Error("Canvas 2D недоступен в браузере.");
    const output=new Uint8Array(frames*32);
    for(let frame=0;frame<frames;frame++){
      if(seq!==videoConversionSeq)throw Error("Обработка отменена.");
      const time=Math.max(0,Math.min(video.duration-0.001,(frame+0.5)/fps));
      await seekVideo(video,time);
      drawVideoSized(ctx,video,mode);
      const rgba=ctx.getImageData(0,0,32,8).data;
      for(let y=0;y<8;y++)for(let x=0;x<32;x++){
        const i=(y*32+x)*4;
        const brightness=0.2126*rgba[i]+0.7152*rgba[i+1]+0.0722*rgba[i+2];
        if((brightness>=threshold)!==invert)output[frame*32+x]|=1<<y;
      }
      if(frame%10===0||frame===frames-1){
        $("videoProgress").value=Math.round(100*(frame+1)/frames);
        videoStatus("Обрабатывается кадр "+(frame+1)+"/"+frames);
        await pause(0);
      }
    }
    if(seq!==videoConversionSeq)throw Error("Обработка отменена.");
    videoData={data:output,frames,fps,crc:videoCRC32(output)};
    $("videoScrub").min="0";$("videoScrub").max=String(frames-1);$("videoScrub").value="0";
    showVideoFrame(0);
    videoStatus("Готово: "+frames+" кадров, "+formatBytes(output.length+12)+
      ". Исходник "+formatBytes(file.size)+"; используется "+span.toFixed(1)+" с.");
  }catch(e){
    videoStatus("Не удалось обработать видео: "+e.message);
  }finally{
    video.pause();video.removeAttribute("src");video.load();URL.revokeObjectURL(url);
    videoConverting=false;renderResourceStats();
  }
});
$("initVideoFs").addEventListener("click",async()=>{
  if(!firmwareOK||busy||!deviceMemory||deviceMemory.fs!==0)return;
  if(!confirm("Подготовить раздел файловой системы для видео? Если в этом разделе есть старые файлы, они могут быть СТЁРТЫ. Прошивку, настройки Wi-Fi и сценарии NVS это не затрагивает."))return;
  busy=true;renderResourceStats();
  try{
    await cmd("VIDEO FORMAT CONFIRM","OK VIDEO FORMAT",30000);
    await serialSend("MEM INFO");
    videoStatus("Файловая система для видео подготовлена.");
  }catch(e){videoStatus("Ошибка подготовки памяти: "+e.message)}
  finally{busy=false;renderResourceStats()}
});
$("deleteVideo").addEventListener("click",async()=>{
  if(!firmwareOK||busy||!deviceMemory?.video)return;
  if(!confirm("Удалить загруженную LED-анимацию с ESP32? Сценарии и Wi-Fi останутся."))return;
  busy=true;renderResourceStats();
  try{await cmd("VIDEO CLEAR CONFIRM","OK VIDEO CLEAR");await serialSend("MEM INFO");videoStatus("Видео удалено с ESP32.")}
  catch(e){videoStatus("Не удалось удалить видео: "+e.message)}
  finally{busy=false;renderResourceStats()}
});
$("refreshMemory").addEventListener("click",async()=>{
  if(!firmwareOK||busy)return;
  try{await serialSend("MEM INFO")}catch(e){videoStatus("Ошибка запроса памяти: "+e.message)}
});
$("uploadVideo").addEventListener("click",async()=>{
  if(!firmwareOK||busy||videoSending||!videoData||deviceMemory?.fs!==1)return;
  const clip=videoData;
  if(deviceMemory.free<clip.data.length+12+8192){
    videoStatus("На ESP32 недостаточно свободного места. Удали старое видео или сократи новое.");return;
  }
  if(!confirm("Загрузить "+formatBytes(clip.data.length+12)+" на ESP32? Предыдущее видео будет заменено только после успешной проверки CRC32."))return;
  videoSending=true;busy=true;renderResourceStats();
  try{
    const crc=clip.crc.toString(16).padStart(8,"0").toUpperCase();
    await cmd("VIDEO BEGIN "+clip.frames+" "+clip.fps+" "+crc,"OK VIDEO BEGIN",15000);
    const step=256;
    for(let start=0;start<clip.data.length;start+=step){
      const chunk=clip.data.subarray(start,Math.min(start+step,clip.data.length));
      const payload=btoa(Array.from(chunk,b=>String.fromCharCode(b)).join(""));
      await cmd("VIDEO DATA "+payload,"OK VIDEO DATA",15000);
      $("videoProgress").value=Math.round(100*(start+chunk.length)/clip.data.length);
      if(start%(step*8)===0||start+chunk.length===clip.data.length)
        videoStatus("Передача на ESP32: "+formatBytes(start+chunk.length)+
                    " / "+formatBytes(clip.data.length));
    }
    await cmd("VIDEO COMMIT","OK VIDEO COMMIT",20000);
    await serialSend("MEM INFO");
    videoStatus("✓ Видео проверено CRC32 и сохранено на ESP32. Добавь в программу блок «видео 32×8».");
  }catch(e){
    videoStatus("Ошибка передачи: "+e.message+"; прежнее видео не должно заменяться.");
    try{await serialSend("VIDEO ABORT")}catch(_){}
  }finally{videoSending=false;busy=false;renderResourceStats()}
});

try{
  const raw=localStorage.getItem(STORAGE)||localStorage.getItem("twitch-led-logic-v62")||localStorage.getItem("twitch-led-logic-v61");
  if(raw)importProject(JSON.parse(raw));
}catch(e){message("Черновик не загружен: "+e.message)}
initMatrix();render();$("pixelTools").hidden=true;
if(!window.isSecureContext||!("serial" in navigator))usbStatus("Браузерное USB требует HTTPS и Chrome/Edge");
})();