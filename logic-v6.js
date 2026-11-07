/* Twitch LED Logic v6: standalone Scratch-inspired visual program editor.
   Runs without third-party libraries. Changes only this page's local project.
   USB SCRIPT upload is gated on a v6 firmware capability response (SCRIPT1). */
(()=>{
"use strict";
const $=id=>document.getElementById(id);
const enc=new TextEncoder();
const zones={BERLIN:"Europe/Berlin",MOSCOW:"Europe/Moscow",VLADIVOSTOK:"Asia/Vladivostok",UTC:"UTC"};
const MAX_NODES=42,MAX_DEPTH=3,STORAGE="twitch-led-logic-v6";
let serialNumber=0;
const uid=()=>("n"+(++serialNumber).toString(36));
const blankPixels=()=>("00").repeat(32);
const blankProject=()=>({schema:6,version:"6.0",steps:[
  {id:uid(),kind:"text",text:"ПРИВЕТ!",speed:65,pause:300},
  {id:uid(),kind:"wait",ms:700},
  {id:uid(),kind:"twitch",login:"pwgood",format:"count",speed:65,pause:300},
]});
let project=blankProject();
let active={parent:"root",branch:"root",index:project.steps.length};
let selectedId=null,pixelEditFrame=0,pixelPainting=false,pixelPaintOn=true;
let simulation=0,port=null,reader=null,readTask=null,rx="",pending=null,firmwareOK=false,busy=false;
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
function newNode(kind){
  const id=uid();
  if(kind==="text")return {id,kind,text:"ПРИВЕТ!",speed:65,pause:300};
  if(kind==="twitch")return {id,kind,login:"pwgood",format:"full",speed:65,pause:300};
  if(kind==="clock")return {id,kind,zone:"BERLIN",mode:"TIME",speed:65,pause:300};
  if(kind==="pixel")return {id,kind,pixels:blankPixels(),frameMs:250,duration:3000};
  if(kind==="wait")return {id,kind,ms:1000};
  if(kind==="repeat")return {id,kind,times:3,body:[newNode("text")]};
  if(kind==="if")return {id,kind,condition:"wifi",login:"pwgood",threshold:100,zone:"BERLIN",hour:18,body:[newNode("text")],otherwise:[]};
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
  return val;
}
function importProject(data){
  if(data&&data.schema===6&&Array.isArray(data.steps)){
    project={schema:6,version:"6.0",steps:data.steps.map(defaults)};
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
    project={schema:6,version:"6.0",steps:nodes};
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
function nodeClass(n){return ["wait","repeat"].includes(n.kind)?"control":n.kind==="if"?"conditional":"screen"}
function nodeFields(n){
  const tag=(s)=>'<span class="labelsmall">'+s+'</span>';
  if(n.kind==="text")return field(n,"text","wide")+tag("скорость")+field(n,"speed","normal","number",35,140)+tag("мс");
  if(n.kind==="twitch")return field(n,"login")+
    select(n,"format",[["full","ник + число"],["count","только число"]])+
    tag("скорость")+field(n,"speed","normal","number",35,140);
  if(n.kind==="clock")return select(n,"mode",[["TIME","время"],["DATE","дата"],["WEEKDAY","день недели"]])+
    select(n,"zone",zoneChoices)+tag("скорость")+field(n,"speed","normal","number",35,140);
  if(n.kind==="pixel")return '<button type="button" class="edit-pixel" data-action="editPixel" data-id="'+n.id+'">▦ Рисовать</button>'+
    tag("кадр")+field(n,"frameMs","normal","number",100,900)+tag("мс")+tag("показ")+field(n,"duration","normal","number",500,9000)+tag("мс");
  if(n.kind==="wait")return field(n,"ms","normal","number",100,30000)+tag("мс");
  if(n.kind==="repeat")return field(n,"times","normal","number",1,10)+tag("раз");
  if(n.kind==="if"){
    let out=select(n,"condition",[["wifi","Wi-Fi подключён"],["followers","подписчиков ≥"],["hour","час ≥"]]);
    if(n.condition==="followers")out+=field(n,"login")+field(n,"threshold","normal","number",0,100000000);
    if(n.condition==="hour")out+=select(n,"zone",zoneChoices)+field(n,"hour","normal","number",0,23);
    return out;
  }
  return "";
}
function nodeLabel(n){
  return ({text:"показать",twitch:"показать Twitch",clock:"показать",pixel:"изображение",wait:"ждать",repeat:"повторить",if:"если"})[n.kind]||n.kind;
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
  if(n.kind==="if"||n.kind==="repeat"){
    out+='<div class="scope"><div class="scope-head">'+(n.kind==="if"?"ТО":"ДЕЙСТВИЯ")+'</div>'+
      renderGroup(n.body,n.id,"body")+'</div>';
    if(n.kind==="if")out+='<div class="scope"><div class="scope-head">ИНАЧЕ</div>'+
      renderGroup(n.otherwise,n.id,"otherwise")+'</div>';
  }
  return out+"</article>";
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
        case "clock":
          commands.push("CLOCK "+safeZone(n.zone)+" "+(["TIME","DATE","WEEKDAY"].includes(n.mode)?n.mode:"TIME")+
          " "+int(n.speed,35,140,65)+" "+int(n.pause,0,2500,300));break;
        case "pixel":
          if(!/^[0-9A-F]{64}(\.[0-9A-F]{64}){0,3}$/.test(n.pixels||""))bad("Рисунок должен содержать от 1 до 4 кадров 8×32.");
          commands.push("PIXEL "+(n.pixels||blankPixels())+" "+int(n.frameMs,100,900,250)+" "+int(n.duration,500,9000,3000));break;
        case "wait":
          commands.push("WAIT "+int(n.ms,100,30000,1000));break;
        case "repeat":
          commands.push("REPEAT "+int(n.times,1,10,3));visit(n.body||[],depth+1);commands.push("ENDREPEAT");break;
        case "if":
          if(n.condition==="followers"){
            if(!normLogin(n.login))bad("Неверный Twitch-логин в условии.");
            commands.push("IF FOLLOWERS "+(normLogin(n.login)||"pwgood")+" "+int(n.threshold,0,100000000,100));
          }else if(n.condition==="hour")commands.push("IF HOUR "+safeZone(n.zone)+" "+int(n.hour,0,23,18));
          else commands.push("IF WIFI");
          visit(n.body||[],depth+1);commands.push("ELSE");
          visit(n.otherwise||[],depth+1);commands.push("ENDIF");break;
        default: bad("Неизвестный элемент "+n.kind);
      }
    }
  }
  visit(project.steps);
  if(commands.length===0)bad("Добавь хотя бы одно действие.");
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
  $("pixelTools").hidden=!selectedId||getNode(selectedId)?.node.kind!=="pixel";
  if(!$("pixelTools").hidden)renderPixelEditor();
}
function updateLight(){const {errors}=validateAndCompile();
  $("validation").className="validation"+(errors.length?" error":"");
  $("validation").textContent=errors.length?errors.join(" "):"✓ Программа корректна · "+countNodes()+" блоков.";
  $("sendScript").disabled=!firmwareOK||busy||errors.length>0;
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
function addToActive(kind){
  if(countNodes()>=MAX_NODES-3){message("Слишком много блоков — предел "+MAX_NODES);return}
  try{
    const list=getList(active.parent,active.branch);
    const node=newNode(kind);
    list.splice(Math.min(active.index,list.length),0,node);
    selectedId=node.id;
    active.index++;
    if(maxDepth()>MAX_DEPTH){list.splice(list.indexOf(node),1);throw Error("Слишком глубокая вложенность")}
    persist();render(); message("Добавлен блок «"+nodeLabel(node)+"»");
  }catch(e){message(e.message);}
}
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
  const btn=e.target.closest("button[data-action]");if(!btn)return;
  const action=btn.dataset.action;
  if(action==="insertHere"){
    active={parent:btn.dataset.parent,branch:btn.dataset.branch,index:Number(btn.dataset.index)};
    render();message("Выбрано место вставки. Добавь блок из библиотеки слева.");return;
  }
  if(action==="up"||action==="down"||action==="duplicate"||action==="remove"||action==="editPixel")actionBlock(action,btn.dataset.id);
});
$("program").addEventListener("input",e=>{
  const inp=e.target.closest("input[data-field]");if(!inp)return;
  changeNode(inp.dataset.id,inp.dataset.field,inp.value);
});
$("program").addEventListener("change",e=>{
  const elem=e.target.closest("[data-field]");if(!elem)return;
  changeNode(elem.dataset.id,elem.dataset.field,elem.value);
  if(elem.tagName==="SELECT")render();
  else if(elem.type==="number")elem.value=getNode(elem.dataset.id)?.node[elem.dataset.field]??elem.value;
});
document.querySelectorAll("[data-add]").forEach(button=>button.addEventListener("click",()=>addToActive(button.dataset.add)));
let dragged=null;
$("program").addEventListener("dragstart",e=>{
  const handle=e.target.closest(".drag-handle");if(!handle)return;
  dragged=handle.dataset.id;
  e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",dragged);
  handle.closest(".node")?.classList.add("dragging");
});
$("program").addEventListener("dragend",()=>{dragged=null;document.querySelectorAll(".dragging,.drop-over").forEach(el=>el.classList.remove("dragging","drop-over"))});
$("program").addEventListener("dragover",e=>{
  const p=e.target.closest(".insert-point");if(!p||!dragged)return;
  e.preventDefault();p.classList.add("drop-over");
});
$("program").addEventListener("dragleave",e=>{e.target.closest(".insert-point")?.classList.remove("drop-over")});
$("program").addEventListener("drop",e=>{
  const p=e.target.closest(".insert-point");if(!p||!dragged)return;
  e.preventDefault();
  moveNode(dragged,p.dataset.parent,p.dataset.branch,Number(p.dataset.index));
  dragged=null;
});
$("reset").addEventListener("click",()=>{if(!confirm("Создать новый проект? Сохрани текущий в JSON, если нужен."))return;project=blankProject();selectedId=null;active={parent:"root",branch:"root",index:project.steps.length};persist();render()});
$("exportBtn").addEventListener("click",()=>{
  const blob=new Blob([JSON.stringify(project,null,2)],{type:"application/json"});
  const a=document.createElement("a"),url=URL.createObjectURL(blob);
  a.href=url;a.download="twitch-led-logic-v6.json";a.click();
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
function readCondition(n) {
  if(n.condition==="wifi")return true; // virtual WiFi is connected
  if(n.condition==="followers")return 475070>=int(n.threshold,0,100000000,0);
  if(n.condition==="hour"){
    const fmt=new Intl.DateTimeFormat("en-US",{timeZone:zones[safeZone(n.zone)],hour:"numeric",hourCycle:"h23"});
    return Number(fmt.format(new Date()))>=int(n.hour,0,23,0);
  }
  return false;
}
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
      $("simState").textContent="Условие: "+node.condition+" → "+(readCondition(node)?"да":"нет")+" (демо)";
      await simulateList(readCondition(node)?node.body:node.otherwise,token);continue;
    }
    if(node.kind==="repeat"){
      for(let n=0;n<node.times&&simIsActive(token);n++)await simulateList(node.body,token);
      continue;
    }
    if(node.kind==="wait"){message("Ожидание "+node.ms+" мс");await pause(Math.min(1600,node.ms));continue;}
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
    await showSimText(text,token);await pause(200);
  }
}
$("playDemo").addEventListener("click",async()=>{
  const token=++simulation;
  $("simState").textContent="Демо работает. Значение Twitch условное (475070).";
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
function waitAck(prefix,timeout=10000){
  if(pending)throw Error("Не завершена предыдущая команда");
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(pending===item){pending=null;reject(Error("Нет ответа: "+prefix))}},timeout);
    const item={prefix,resolve:x=>{clearTimeout(timer);resolve(x)},reject};
    pending=item;
  });
}
async function cmd(command,prefix,timeout=10000){
  const promise=waitAck(prefix,timeout);
  await serialSend(command);
  return promise;
}
function onSerialLine(line){
  const s=line.trim();if(!s)return;
  usbLog(s.slice(0,500));
  if(/^VERSION TWITCHLED 6\.\d+/.test(s)&&/\bSCRIPT1\b/.test(s)){
    firmwareOK=true;usbStatus("Совместимая прошивка v6 (SCRIPT1)",true);render();
  }
  if(pending&&(s.startsWith(pending.prefix)||s.startsWith("ERR"))){
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
$("usbConnect").addEventListener("click",async()=>{
  if(!("serial" in navigator)){usbStatus("Нужен Chrome/Edge с Web Serial");return}
  try{
    port=await navigator.serial.requestPort();
    await port.open({baudRate:115200,bufferSize:8192,flowControl:"none"});
    firmwareOK=false;usbStatus("Проверяю прошивку...");
    $("usbConnect").disabled=true;$("usbDisconnect").disabled=false;
    readTask=serialRead();
    await pause(1250);
    await serialSend("VERSION");await pause(400);
    if(!firmwareOK)usbStatus("Соединено, но SCRIPT1 не обнаружен: отправка заблокирована");
  }catch(e){usbStatus("Ошибка USB: "+e.message);try{await port?.close()}catch(_){}port=null}
});
$("usbDisconnect").addEventListener("click",async()=>{
  firmwareOK=false;busy=false;
  try{await reader?.cancel();if(readTask)await readTask;await port?.close()}catch(_){}
  port=null;rx="";pending=null;
  $("usbConnect").disabled=false;$("usbDisconnect").disabled=true;
  usbStatus("Не подключено");render();
});
$("sendScript").addEventListener("click",async()=>{
  if(!firmwareOK||busy)return;
  const {commands,errors}=validateAndCompile();if(errors.length){message(errors.join(" "));return}
  if(!confirm("Записать "+commands.length+" команд на ESP32 с SCRIPT1? Прежняя версия сценария на устройстве будет заменена."))return;
  busy=true;render();
  try{
    await cmd("SCRIPT BEGIN","OK SCRIPT BEGIN");
    for(let i=0;i<commands.length;i++){
      await cmd("SCRIPT ADD "+commands[i],"OK SCRIPT ADD",12000);
      usbStatus("Передаю программу: "+(i+1)+"/"+commands.length,true);
    }
    await cmd("SCRIPT COMMIT","OK SCRIPT SAVED");
    await cmd("SCRIPT RUN","OK SCRIPT RUN");
    usbStatus("Программа записана и запущена!",true);
    message("Устройство подтвердило запись "+commands.length+" команд");
  }catch(e){
    usbStatus("Ошибка передачи: "+e.message);
    usbLog("Попробуй SCRIPT CANCEL, старую прошивку не стирай.");
    try{await serialSend("SCRIPT CANCEL")}catch(_){}
  }finally{busy=false;render()}
});
try{
  const raw=localStorage.getItem(STORAGE);
  if(raw)importProject(JSON.parse(raw));
}catch(e){message("Черновик не загружен: "+e.message)}
initMatrix();render();$("pixelTools").hidden=true;
if(!window.isSecureContext||!("serial" in navigator))usbStatus("Браузерное USB требует HTTPS и Chrome/Edge");
})();