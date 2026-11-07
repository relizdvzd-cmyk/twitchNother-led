/* Twitch Followers LED — USB settings + typed playlist constructor v5.5.
   All browser-to-ESP32 configuration happens locally over Web Serial.
   The only persisted browser data is the display playlist (no Wi-Fi secret).
*/
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const encoder=new TextEncoder();
  const decoder=new TextDecoder();
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const MAX_BLOCKS=12, MAX_TEXT_BYTES=120, STORAGE_KEY='twitch-led-builder-v5';
  const defaultBlock=()=>({type:'twitch',value:'pwgood',speed:65,pauseMs:300});
  const DATE_ZONES={BERLIN:'Europe/Berlin',MOSCOW:'Europe/Moscow',VLADIVOSTOK:'Asia/Vladivostok',UTC:'UTC'};
  function localDate(zone){
    const timeZone=DATE_ZONES[zone]||DATE_ZONES.BERLIN;
    try{return new Intl.DateTimeFormat('ru-RU',{timeZone,day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date());}
    catch(_){return '--.--.----';}
  }
  function localClock(zone,format){
    const timeZone=DATE_ZONES[zone]||DATE_ZONES.BERLIN;
    try{
      const opt=format==='time'?{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}:{weekday:'long'};
      const v=new Intl.DateTimeFormat('ru-RU',{timeZone,...opt}).format(new Date());
      return format==='weekday'?v.toLocaleUpperCase('ru-RU'):v;
    }catch(_){return format==='time'?'--:--':'--';}
  }
  const PIXEL_FRAMES_MAX=4, PIXEL_FRAME_HEX=64;
  const blankFrame=()=>('00').repeat(32);
  const isPixelValue=s=>typeof s==='string'&&s.length<=259&&
    s.split('.').length>=1&&s.split('.').length<=4&&
    s.split('.').every(f=>/^[0-9A-F]{64}$/.test(f));
  function decodeFrame(hex){
    const cols=[];for(let i=0;i<32;i++)cols.push(parseInt(hex.slice(i*2,i*2+2),16)||0);
    return cols;
  }
  function encodeFrame(cols){
    return cols.map(n=>Math.max(0,Math.min(255,n|0)).toString(16).padStart(2,'0')).join('').toUpperCase();
  }
  let blocks=[defaultBlock()], selected=0, dirty=false;
  let port=null, reader=null, readTask=null, connected=false, busy=false, fw5=false, firmwareVersion=0;
  let rxBuffer='', pendingReply=null, incomingPlaylist=null;
  let counts=new Map();
  let previewTimer=null, previewIndex=0, previewColumn=0, previewColumns=[], previewGroupEnd=0, previewPixelStartedAt=0;
  let pixelEditFrame=0, pixelPainting=false, pixelPaintTo=true;
  const logEl=$('log');
  const navButtons=Array.from(document.querySelectorAll('nav button[data-tab]'));
  const stamp=()=>new Date().toLocaleTimeString('ru-RU');

  function log(message,severity='') {
    if(logEl.textContent==='Ожидание подключения...')logEl.textContent='';
    logEl.textContent+=`[${stamp()}] ${severity?severity+': ':''}${message}\n`;
    if(logEl.textContent.length>35000)logEl.textContent=logEl.textContent.slice(-28000);
    logEl.scrollTop=logEl.scrollHeight;
  }
  function banner(message){$('banner').textContent=message;}
  function notify(message){$('playlistState').textContent=message;}
  function switchTab(name){
    navButtons.forEach(b=>{
      b.classList.toggle('active',b.dataset.tab===name);
      b.setAttribute('aria-current',b.dataset.tab===name?'page':'false');
    });
    for(const name0 of ['builder','configure','updates','journal'])$('tab-'+name0).hidden=name0!==name;
  }
  navButtons.forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
  function normalizeStreamer(str){
    let s=String(str).trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^(www\.|m\.)/,'').replace(/^twitch\.tv\//,'').replace(/^@/,'');
    s=s.split(/[\/?#]/)[0].trim();
    return /^[a-z0-9_]{1,25}$/.test(s)?s:null;
  }
  const byteLength=s=>encoder.encode(s).length;
  const clamp=(n,min,max,fallback)=>Number.isFinite(Number(n))?Math.min(max,Math.max(min,Math.round(Number(n)))):fallback;
  const shorten=(s,n=52)=>s.length>n?s.slice(0,n-1)+'…':s;
  const byteToB64=str=>{
    const bytes=encoder.encode(str);
    let data='';for(const b of bytes)data+=String.fromCharCode(b);
    return btoa(data);
  };
  const b64ToText=b64=>{
    const data=atob(b64);const bytes=Uint8Array.from(data,character=>character.charCodeAt(0));
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  };
  function validConnectorPositions(list) {
    if(!Array.isArray(list)||list.length<1)return false;
    for(let i=0;i<list.length;i++){
      if(list[i].type==='join'&&(i===0||i===list.length-1||
         list[i-1].type==='join'||list[i+1].type==='join'||
         list[i-1].type==='pixel'||list[i+1].type==='pixel'))return false;
    }
    return true;
  }
  function sanitizeBlock(item){
    const validTypes=['twitch','text','date','join','time','weekday','nick','count','pixel'];
    if(!item||!validTypes.includes(item.type))throw Error('Неизвестный тип элемента');
    let value=String(item.value??'').trim();
    if(['twitch','nick','count'].includes(item.type)){
      value=normalizeStreamer(value);
      if(!value)throw Error('Проверь логин Twitch: латиница, цифры и _');
    }else if(['date','time','weekday'].includes(item.type)){
      if(!Object.hasOwn(DATE_ZONES,value))throw Error('Выбери часовой пояс');
    }else if(item.type==='join'){
      value=value.toUpperCase();
      if(!['SPACE','NONE'].includes(value))throw Error('Выбери пробел или соединение вплотную');
    }else if(item.type==='pixel'){
      value=value.toUpperCase();
      if(!isPixelValue(value))throw Error('Неверные данные 8×32: от 1 до 4 кадров по 64 HEX символа');
    }else{
      if(!value||/[\r\n\x00-\x1f]/.test(value))throw Error('Текст не должен быть пустым или содержать переносы');
      if(byteLength(value)>MAX_TEXT_BYTES)throw Error('Текст не должен превышать 120 байт UTF-8');
    }
    if(item.type==='pixel'){
      return {type:item.type,value,speed:clamp(item.speed,100,900,250),
        pauseMs:clamp(item.pauseMs,500,9000,3000)};
    }
    return {type:item.type,value,speed:item.type==='join'?65:clamp(item.speed,35,140,65),
      pauseMs:item.type==='join'?0:clamp(item.pauseMs,0,2500,300)};
  }
  function validatePlaylist(arr){
    if(!Array.isArray(arr)||arr.length<1||arr.length>MAX_BLOCKS)
      throw Error('Нужен хотя бы 1 элемент (максимум 12)');
    const clean=arr.map(sanitizeBlock);
    if(!validConnectorPositions(clean))
      throw Error('Соединение должно находиться между двумя текстовыми/числовыми блоками, не рядом с пикселями');
    let groupBytes=0;
    for(let i=0;i<clean.length;i++){
      const b=clean[i];
      if(b.type==='join')groupBytes+=b.value==='SPACE'?1:0;
      else{
        if(i===0||clean[i-1].type!=='join')groupBytes=0;
        groupBytes+=b.type==='text'?byteLength(b.value):b.type==='twitch'?45:
          b.type==='nick'?25:b.type==='count'?12:b.type==='weekday'?25:
          b.type==='date'?10:b.type==='time'?5:0;
      }
      if(groupBytes>375)throw Error('Объединённая строка слишком длинная (не более 375 байт)');
    }
    return clean;
  }
  function loadLocalDraft(){
    try{
      const raw=localStorage.getItem(STORAGE_KEY);
      if(raw){const data=JSON.parse(raw);blocks=validatePlaylist(data.blocks);dirty=true;}
    }catch(e){log('Локальный черновик не загружен: '+e.message,'Инфо');}
  }
  function persistDraft(){
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({schema:1,blocks}));}catch(e){log('Не удалось сохранить черновик: '+e.message,'Инфо');}
  }
  function markDirty(){dirty=true;persistDraft();updateBuilderButtons();}
  const hasCyrillicText=()=>blocks.some(b=>b.type==='text'&&/[А-Яа-яЁё]/.test(b.value));
  function updateBuilderButtons(){
    const needsNewFirmware=(blocks.some(b=>b.type==='date')&&firmwareVersion<5.1)||
      (hasCyrillicText()&&firmwareVersion<5.2)||
      (blocks.some(b=>b.type==='join')&&firmwareVersion<5.4)||
      (blocks.some(b=>['time','weekday','nick','count','pixel'].includes(b.type))&&firmwareVersion<5.5);
    $('savePlaylist').disabled=!(connected&&fw5&&!needsNewFirmware&&!busy&&blocks.length>0);
    $('reloadPlaylist').disabled=!(connected&&fw5&&!busy);
    $('builderConnect').disabled=connected||busy;
    $('playlistState').dataset.dirty=String(dirty);
    if(!connected) notify('Черновик в браузере. Подключи ESP32, чтобы записать сценарий на устройство.');
    else if(!fw5)notify('Подключено. Для конструктора нужна прошивка v5 и новее.');
    else if(needsNewFirmware)notify('Для часов, ника/числа Twitch и пиксельной анимации нужна v5.5. «Соединение» работает с v5.4.');
    else if(busy)notify('Передача настроек по USB…');
    else if(dirty)notify('Есть несохранённые изменения. Нажми «Сохранить сценарий на ESP32».');
    else notify('Сценарий загружен с ESP32 и готов к работе.');
  }
  function setConnected(yes){
    connected=yes;
    if(!yes){fw5=false;firmwareVersion=0;}
    $('connectionDot').classList.toggle('on',yes);
    $('connectionText').textContent=yes?'ESP32 подключена':'ESP32 не подключена';
    $('connectedBadge').textContent=yes?'Подключено · 115200':'Не подключена';
    for(const id of ['disconnect','saveWifi','status','refresh','journalStatus','sendCommand'])$(id).disabled=!yes;
    $('connect').disabled=yes;
    updateBuilderButtons();
  }
  const pendingMatches=(s)=>{
    const pending=pendingReply;
    if(!pending)return;
    if(s.startsWith('ERR ')){pendingReply=null;pending.reject(new Error(s));return;}
    if(s.startsWith(pending.prefix)) {pendingReply=null;pending.resolve(s);}
  };
  function receiveLine(line){
    const s=line.trim();if(!s)return;
    if(/^(rst:|load:|ets )/.test(s))return;
    log('ESP32: '+s);
    pendingMatches(s);
    const status=s.match(/^STATUS streamer=(\S+) wifi=(.*?) connected=(\S+) count=(\S+)/);
    if(status){
      $('currentStreamer').textContent=status[1];
      $('currentWifi').textContent=status[2];
      $('currentCount').textContent=status[4];
      const version=s.match(/ firmware=([\d.]+)/);
      if(version){firmwareVersion=Number(version[1]);$('firmwareInfo').textContent='Прошивка: '+version[1];fw5=firmwareVersion>=5;updateBuilderButtons();}
    }
    if(/^VERSION TWITCHLED 5\.\d+/.test(s)){
      fw5=true;firmwareVersion=Number(s.split(' ')[2]);$('firmwareInfo').textContent='Прошивка: '+s.split(' ')[2]+' (конструктор доступен)';updateBuilderButtons();
    }
    const changed=s.match(/^OK STREAMER\s+(\S+)/);
    if(changed)$('currentStreamer').textContent=changed[1];
    const follow=s.match(/^FOLLOWERS\s+([a-z0-9_]+)\s+(\d+)/);
    if(follow){counts.set(follow[1],follow[2]);$('currentCount').textContent=Number(follow[2]).toLocaleString('ru-RU');restartPreview();}
    const begin=s.match(/^PLAYLIST COUNT (\d+)$/);
    if(begin) {
      const n=Number(begin[1]);incomingPlaylist=n<=MAX_BLOCKS?{expected:n,blocks:[]}:null;
    }
    const item=s.match(/^PLAYLIST ITEM (\d+) (TWITCH|TEXT|DATE|JOIN|TIME|WEEKDAY|NICK|COUNT|PIXEL) (\d+) (\d+) (.+)$/);
    if(item&&incomingPlaylist){
      try{
        const i=Number(item[1]);if(i!==incomingPlaylist.blocks.length)throw Error('Порядок блоков не совпал');
        incomingPlaylist.blocks.push(sanitizeBlock({
          type:item[2].toLowerCase(),value:item[2]==='TEXT'?b64ToText(item[5]):item[5],
          speed:Number(item[3]),pauseMs:Number(item[4])
        }));
      }catch(e){incomingPlaylist=null;log('Некорректный блок устройства: '+e.message,'Ошибка');}
    }
    if(s==='PLAYLIST END'){
      if(incomingPlaylist&&incomingPlaylist.blocks.length===incomingPlaylist.expected){
        if(!dirty||window.confirm('На ESP32 есть сохранённый сценарий. Заменить им локальный черновик?')){
          blocks=incomingPlaylist.blocks;
          if(!blocks.length)blocks=[defaultBlock()];
          selected=0;dirty=false;persistDraft();renderBuilder();
          banner('Сценарий прочитан с ESP32.');
        }
      }else log('Не удалось прочитать полный сценарий с ESP32','Ошибка');
      incomingPlaylist=null;updateBuilderButtons();
    }
  }
  async function readLoop(){
    try{
      while(port&&port.readable){
        reader=port.readable.getReader();
        try{
          while(true){
            const {value,done}=await reader.read();
            if(done)return;
            if(value){
              rxBuffer+=decoder.decode(value,{stream:true});
              let pos;while((pos=rxBuffer.indexOf('\n'))>=0){receiveLine(rxBuffer.slice(0,pos).replace(/\r/g,''));rxBuffer=rxBuffer.slice(pos+1);}
              if(rxBuffer.length>7000)rxBuffer=rxBuffer.slice(-3500);
            }
          }
        }finally{reader.releaseLock();reader=null;}
      }
    }catch(err){if(connected)log('Чтение порта: '+err.message,'Ошибка');}
  }
  async function send(command,record){
    if(!connected||!port?.writable)throw Error('Сначала подключи ESP32');
    const writer=port.writable.getWriter();
    try{await writer.write(encoder.encode(command+'\n'));}finally{writer.releaseLock();}
    if(record)log(record);
  }
  async function sendAck(command,prefix,description=''){
    if(pendingReply)throw Error('Другая команда ожидает ответа');
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const slot={prefix,resolve,reject};pendingReply=slot;
    const timer=setTimeout(()=>{if(pendingReply===slot){pendingReply=null;reject(new Error('Нет ответа ESP32 на '+prefix));}},13000);
    try{await send(command,description);return await promise;}
    finally{clearTimeout(timer);if(pendingReply===slot)pendingReply=null;}
  }
  async function connect(){
    if(!('serial' in navigator)){banner('Web Serial недоступен. Открой опубликованный HTTPS-сайт в Chrome или Edge на компьютере.');return;}
    try{
      port=await navigator.serial.requestPort();
      await port.open({baudRate:115200,bufferSize:4096,flowControl:'none'});
      if(port.setSignals){try{await port.setSignals({dataTerminalReady:false,requestToSend:false});}catch(_){}}
      setConnected(true);log('Порт открыт (115200 бод).');readTask=readLoop();
      await sleep(1500);
      if(!connected)return;
      await send('VERSION','Запрошена версия прошивки.');
      await sleep(110);
      await send('STATUS','Запрошен статус.');
      await sleep(110);
      await send('PLAYLIST GET','Запрошен сценарий.');
    }catch(e){
      if(e.name!=='NotFoundError')log('Подключение: '+e.message,'Ошибка');
      else log('Выбор порта отменён.');
      if(port&&!connected){try{await port.close();}catch(_){}port=null;}
    }
  }
  $('connect').addEventListener('click',connect);
  $('builderConnect').addEventListener('click',connect);
  async function disconnect(){
    if(!port)return;
    setConnected(false);
    try{
      if(reader)await reader.cancel();
      if(readTask)await readTask;
      await port.close();
      log('USB-порт закрыт.');
    }catch(e){log('Отключение: '+e.message,'Ошибка');}
    finally{port=null;readTask=null;rxBuffer='';incomingPlaylist=null;setConnected(false);}
  }
  $('disconnect').addEventListener('click',disconnect);
  $('status').addEventListener('click',()=>send('STATUS','Запрошен статус.').catch(e=>log(e.message,'Ошибка')));
  $('journalStatus').addEventListener('click',()=>send('STATUS','Запрошен статус.').catch(e=>log(e.message,'Ошибка')));
  $('refresh').addEventListener('click',()=>send('REFRESH','Запрошено обновление счётчиков.').catch(e=>log(e.message,'Ошибка')));
  $('saveWifi').addEventListener('click',async()=>{
    const ssid=$('ssid').value,pass=$('wifiPassword').value;
    if(!ssid||!pass){banner('Для смены сети введи и имя Wi-Fi, и пароль.');return;}
    if(ssid.includes('|')||/[\r\n]/.test(ssid+pass)||byteLength(ssid)>32||byteLength(pass)>64){banner('Некорректный Wi-Fi: SSID максимум 32 байта, пароль 64 байта.');return;}
    try{
      await send('WIFI '+ssid+'|'+pass,'Переданы новые Wi-Fi параметры (пароль не записан в журнал).');
      $('wifiPassword').value='';
      banner('Команда Wi-Fi отправлена. Убедись в ответе OK WIFI SAVED во вкладке «Диагностика».');
    }catch(e){banner('Ошибка отправки Wi-Fi: '+e.message);}
  });
  $('clearLog').addEventListener('click',()=>logEl.textContent='');
  $('sendCommand').addEventListener('click',()=>{
    const cmd=$('customCommand').value.trim();
    if(!cmd||cmd.length>290||/[\r\n]/.test(cmd)){banner('Некорректная команда.');return;}
    if(/^(WIFI|PLAYLIST ADD)/i.test(cmd)){banner('Для этих настроек используй вкладки «Устройство» и «Конструктор».');return;}
    send(cmd,'Команда: '+cmd).catch(e=>log(e.message,'Ошибка'));
  });
  $('customCommand').addEventListener('keydown',e=>{if(e.key==='Enter')$('sendCommand').click();});

  // --- Builder: add, select, edit, reorder, delete, save ---
  function itemName(block) {
    if(block.type==='join')return block.value==='NONE'?'Соединить без пробела':'Соединить с пробелом';
    return block.type==='twitch'?block.value||'Не указан логин':
      block.type==='date'?localDate(block.value):block.value||'Пустой текст';
  }
  function renderList(){
    const list=$('blocksList');list.replaceChildren();
    blocks.forEach((block,index)=>{
      const card=document.createElement('div');
      card.className='block-card '+block.type+(selected===index?' selected':'');
      card.setAttribute('role','listitem');
      const num=document.createElement('span');num.className='block-number';num.textContent=index+1;
      const main=document.createElement('button');main.type='button';main.className='block-main';main.dataset.action='select';main.dataset.index=index;
      const type=document.createElement('span');type.className='block-type';type.textContent=block.type==='twitch'?'TWITCH · ФОЛЛОВЕРЫ':block.type==='date'?'СЕГОДНЯШНЯЯ ДАТА':
        block.type==='join'?'↔ СОЕДИНЕНИЕ':'СВОЙ ТЕКСТ';
      const value=document.createElement('span');value.className='block-value';value.textContent=shorten(itemName(block));
      main.append(type,value);main.title='Открыть настройки элемента';
      const actions=document.createElement('div');actions.className='block-actions';
      for(const [action,txt,hint] of [['select','⚙','Настройки'],['up','↑','Переместить выше'],['down','↓','Переместить ниже'],['remove','×','Удалить']]){
        const b=document.createElement('button');b.type='button';b.textContent=txt;b.title=hint;b.setAttribute('aria-label',hint+' элемент '+(index+1));
        b.dataset.action=action;b.dataset.index=index;
        if(action==='select')b.classList.add('gear');
        if((action==='up'&&index===0)||(action==='down'&&index===blocks.length-1)||(action==='remove'&&blocks.length===1))b.disabled=true;
        actions.append(b);
      }
      card.append(num,main,actions);list.append(card);
    });
    const n=blocks.length;$('itemCount').textContent=n+' '+(n===1?'элемент':n>=2&&n<=4?'элемента':'элементов');
    $('addText').disabled=n>=MAX_BLOCKS;
    $('addDate').disabled=n>=MAX_BLOCKS;
    $('addTwitch').disabled=n>=MAX_BLOCKS;
    $('addJoin').disabled=n>=MAX_BLOCKS||selected>=n-1||
      blocks[selected].type==='join'||blocks[selected+1]?.type==='join';
    $('addJoin').title=$('addJoin').disabled?'Выбери первый из двух соседних обычных блоков':'Вставить соединитель после выбранного блока';
    $('removeSelected').disabled=n===1;
  }
  function renderEditor(){
    selected=Math.min(selected,blocks.length-1);
    const block=blocks[selected];
    $('selectedPosition').textContent='№ '+(selected+1);
    $('editHeading').textContent=block.type==='twitch'?'Счётчик фолловеров Twitch':
      block.type==='date'?'Сегодняшняя дата':block.type==='join'?'Соединение двух элементов':'Произвольный текст';
    $('twitchSettings').hidden=block.type!=='twitch';
    $('textSettings').hidden=block.type!=='text';
    $('dateSettings').hidden=block.type!=='date';
    $('joinSettings').hidden=block.type!=='join';
    $('timingSettings').hidden=block.type==='join';
    $('itemJoinSeparator').value=block.type==='join'?block.value:'SPACE';
    $('itemDateZone').value=block.type==='date'?block.value:'BERLIN';
    $('itemStreamer').value=block.type==='twitch'?block.value:'';
    $('itemText').value=block.type==='text'?block.value:'';
    $('itemSpeed').value=block.speed;
    $('speedLabel').textContent=block.speed+' мс';
    $('itemPause').value=String(block.pauseMs);
    if($('itemPause').selectedIndex<0)$('itemPause').value='300';
    $('textBytes').textContent=byteLength($('itemText').value)+' / '+MAX_TEXT_BYTES+' байт';
  }
  function renderBuilder(){renderList();renderEditor();updateBuilderButtons();restartPreview();}
  $('blocksList').addEventListener('click',e=>{
    const button=e.target.closest('button[data-action]');if(!button)return;
    const index=Number(button.dataset.index),action=button.dataset.action;
    if(index<0||index>=blocks.length)return;
    if(action==='select'){
      selected=index;renderList();renderEditor();
      $('builderEditor').scrollIntoView({behavior:'smooth',block:'nearest'});
    }else if((action==='up'&&index>0)||(action==='down'&&index<blocks.length-1)){
      const other=action==='up'?index-1:index+1;
      const candidate=blocks.slice();
      [candidate[index],candidate[other]]=[candidate[other],candidate[index]];
      if(!validConnectorPositions(candidate)){
        banner('Нельзя переместить соединение на край или поставить два соединения рядом.');
        return;
      }
      blocks=candidate;selected=other;markDirty();renderBuilder();
    }else if(action==='remove'&&blocks.length>1){
      removeBlock(index);
    }
  });
  function removeBlock(index) {
    blocks.splice(index,1);
    // Deleting content removes markers that no longer have two neighbors.
    blocks=blocks.filter((b,i,arr)=>b.type!=='join'||
      (i>0&&i+1<arr.length&&arr[i-1].type!=='join'&&arr[i+1].type!=='join'));
    if(!blocks.length)blocks=[defaultBlock()];
    selected=Math.min(index,blocks.length-1);markDirty();renderBuilder();
  }
  function addBlock(type){
    if(blocks.length>=MAX_BLOCKS){banner('Можно добавить не более 12 элементов.');return;}
    if(type==='join') {
      if(selected>=blocks.length-1||blocks[selected].type==='join'||blocks[selected+1].type==='join'){
        banner('Сначала выбери первый из двух соседних обычных элементов.');return;
      }
      blocks.splice(selected+1,0,{type:'join',value:'SPACE',speed:65,pauseMs:0});
      selected+=1;markDirty();renderBuilder();$('itemJoinSeparator').focus();
      return;
    }
    const newBlock=type==='date'?{type,value:'BERLIN',speed:65,pauseMs:300}:type==='text'?{type,value:'Привет, мир!',speed:65,pauseMs:300}:defaultBlock();
    // Insertion after JOIN is fine (keeps the marker between two contents).
    blocks.splice(selected+1,0,newBlock);selected+=1;markDirty();renderBuilder();
    (type==='date'?$('itemDateZone'):type==='text'?$('itemText'):$('itemStreamer')).focus();
  }
  $('addTwitch').addEventListener('click',()=>addBlock('twitch'));
  $('addText').addEventListener('click',()=>addBlock('text'));
  $('addDate').addEventListener('click',()=>addBlock('date'));
  $('addJoin').addEventListener('click',()=>addBlock('join'));
  $('removeSelected').addEventListener('click',()=>{
    if(blocks.length<=1)return;
    removeBlock(selected);
  });
  $('itemStreamer').addEventListener('input',e=>{
    if(blocks[selected].type!=='twitch')return;
    blocks[selected].value=e.target.value;markDirty();renderList();restartPreview();
  });
  $('itemStreamer').addEventListener('blur',()=>{
    if(blocks[selected].type!=='twitch')return;
    const normalized=normalizeStreamer($('itemStreamer').value);
    if(normalized){blocks[selected].value=normalized;$('itemStreamer').value=normalized;markDirty();renderList();restartPreview();}
  });
  $('itemText').addEventListener('input',e=>{
    if(blocks[selected].type!=='text')return;
    blocks[selected].value=e.target.value;
    const len=byteLength(e.target.value);
    $('textBytes').textContent=len+' / '+MAX_TEXT_BYTES+' байт';
    $('textBytes').style.color=len>MAX_TEXT_BYTES?'#fc9094':'';
    markDirty();renderList();restartPreview();
  });
  $('itemJoinSeparator').addEventListener('change',e=>{
    if(blocks[selected].type!=='join')return;
    blocks[selected].value=e.target.value;markDirty();renderList();restartPreview();
  });
  $('itemDateZone').addEventListener('change',e=>{
    if(blocks[selected].type!=='date')return;
    blocks[selected].value=e.target.value;
    markDirty();renderList();restartPreview();
  });
  $('itemSpeed').addEventListener('input',e=>{
    blocks[selected].speed=Number(e.target.value);$('speedLabel').textContent=e.target.value+' мс';markDirty();restartPreview();
  });
  $('itemPause').addEventListener('change',e=>{blocks[selected].pauseMs=Number(e.target.value);markDirty();restartPreview();});
  $('savePlaylist').addEventListener('click',async()=>{
    if(busy)return;
    if(!connected||!fw5){banner('Подключи ESP32 с прошивкой v5 или новее.');return;}
    if(blocks.some(b=>b.type==='date')&&firmwareVersion<5.1){banner('Для даты нужна прошивка v5.1 и новее.');return;}
    if(blocks.some(b=>b.type==='join')&&firmwareVersion<5.4){banner('Для соединения нужна прошивка v5.4+; пока экспортируй JSON.');return;}
    if(blocks.some(b=>['time','weekday','nick','count','pixel'].includes(b.type))&&firmwareVersion<5.5){
      banner('Для новых блоков нужна прошивка v5.5; пока можно экспортировать JSON.');return;
    }
    if(hasCyrillicText()&&firmwareVersion<5.2){banner('Для настоящей кириллицы установи v5.2 через Arduino IDE.');return;}
    let clean;
    try{clean=validatePlaylist(blocks);}catch(e){banner('Ошибка сценария: '+e.message);return;}
    busy=true;updateBuilderButtons();
    let committed=false;
    try{
      await sendAck('PLAYLIST BEGIN','OK PLAYLIST BEGIN','Начало передачи сценария.');
      for(let i=0;i<clean.length;i++){
        const item=clean[i],encoded=item.type==='text'?byteToB64(item.value):item.value;
        await sendAck(`PLAYLIST ADD ${item.type.toUpperCase()} ${encoded} ${item.speed} ${item.pauseMs}`,'OK PLAYLIST ADD',`Блок ${i+1}/${clean.length}: ${item.type==='date'?'дата':item.type==='text'?'текст':item.type==='join'?'соединение':'Twitch'}`);
      }
      await sendAck('PLAYLIST COMMIT','OK PLAYLIST SAVED','Запись сценария во флеш-память ESP32.');
      committed=true;blocks=clean;dirty=false;persistDraft();
      renderList();renderEditor();
      banner('Готово! '+clean.length+' элементов сохранены на ESP32. После выключения питания они останутся.');
      await send('PLAYLIST GET','Проверка сценария после сохранения.');
    }catch(e){
      banner('Не удалось сохранить сценарий: '+e.message);log(e.message,'Ошибка');
      if(!committed&&connected){try{await send('PLAYLIST CANCEL','Откат несохранённого сценария.');}catch(_){}}
    }finally{busy=false;updateBuilderButtons();}
  });
  $('reloadPlaylist').addEventListener('click',()=>send('PLAYLIST GET','Повторное чтение сценария.').catch(e=>banner(e.message)));
  $('exportPlaylist').addEventListener('click',()=>{
    let clean;try{clean=validatePlaylist(blocks);}catch(e){banner('Проверь сценарий перед экспортом: '+e.message);return;}
    const blob=new Blob([JSON.stringify({schema:3,app:'Twitch LED Builder',blocks:clean},null,2)],{type:'application/json'});
    const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='twitch-led-playlist.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(u),3000);
  });
  $('importPlaylist').addEventListener('change',async e=>{
    const f=e.target.files?.[0];if(!f)return;
    try{
      if(f.size>20000)throw Error('JSON слишком большой');
      const data=JSON.parse(await f.text());
      const arr=validatePlaylist(data.blocks);
      blocks=arr;selected=0;markDirty();renderBuilder();
      banner(`Импортировано ${arr.length} элементов. Для применения нажми «Сохранить сценарий на ESP32».`);
    }catch(err){banner('Ошибка импорта: '+err.message);}finally{e.target.value='';}
  });

  // --- Approximate 5x7 matrix scrolling simulator ---
  // EXACT same original 5x7 Russian/Latin pixels as the ESP32 v5.2 firmware.
  const font={
    "A":"01110/10001/10001/11111/10001/10001/10001" ,
    "B":"11110/10001/10001/11110/10001/10001/11110" ,
    "C":"01111/10000/10000/10000/10000/10000/01111" ,
    "D":"11110/10001/10001/10001/10001/10001/11110" ,
    "E":"11111/10000/10000/11110/10000/10000/11111" ,
    "F":"11111/10000/10000/11110/10000/10000/10000" ,
    "G":"01111/10000/10000/10111/10001/10001/01111" ,
    "H":"10001/10001/10001/11111/10001/10001/10001" ,
    "I":"11111/00100/00100/00100/00100/00100/11111" ,
    "J":"00111/00010/00010/00010/10010/10010/01100" ,
    "K":"10001/10010/10100/11000/10100/10010/10001" ,
    "L":"10000/10000/10000/10000/10000/10000/11111" ,
    "M":"10001/11011/10101/10101/10001/10001/10001" ,
    "N":"10001/11001/10101/10011/10001/10001/10001" ,
    "O":"01110/10001/10001/10001/10001/10001/01110" ,
    "P":"11110/10001/10001/11110/10000/10000/10000" ,
    "Q":"01110/10001/10001/10001/10101/10010/01101" ,
    "R":"11110/10001/10001/11110/10100/10010/10001" ,
    "S":"01111/10000/10000/01110/00001/00001/11110" ,
    "T":"11111/00100/00100/00100/00100/00100/00100" ,
    "U":"10001/10001/10001/10001/10001/10001/01110" ,
    "V":"10001/10001/10001/10001/10001/01010/00100" ,
    "W":"10001/10001/10001/10101/10101/10101/01010" ,
    "X":"10001/10001/01010/00100/01010/10001/10001" ,
    "Y":"10001/10001/01010/00100/00100/00100/00100" ,
    "Z":"11111/00001/00010/00100/01000/10000/11111" ,
    "0":"01110/10011/10101/10101/11001/10001/01110" ,
    "1":"00100/01100/00100/00100/00100/00100/01110" ,
    "2":"01110/10001/00001/00010/00100/01000/11111" ,
    "3":"11110/00001/00001/01110/00001/00001/11110" ,
    "4":"00010/00110/01010/10010/11111/00010/00010" ,
    "5":"11111/10000/10000/11110/00001/00001/11110" ,
    "6":"01110/10000/10000/11110/10001/10001/01110" ,
    "7":"11111/00001/00010/00100/01000/01000/01000" ,
    "8":"01110/10001/10001/01110/10001/10001/01110" ,
    "9":"01110/10001/10001/01111/00001/00001/01110" ,
    ":":"00000/00100/00100/00000/00100/00100/00000" ,
    ".":"00000/00000/00000/00000/00000/00100/00100" ,
    "!":"00100/00100/00100/00100/00100/00000/00100" ,
    "?":"01110/10001/00001/00010/00100/00000/00100" ,
    "-":"00000/00000/00000/11111/00000/00000/00000" ,
    "_":"00000/00000/00000/00000/00000/00000/11111" ,
    "/":"00001/00001/00010/00100/01000/10000/10000" ,
    " ":"00000/00000/00000/00000/00000/00000/00000" ,
    ",":"00000/00000/00000/00000/00100/00100/01000" ,
    "\"":"01010/01010/01010/00000/00000/00000/00000" ,
    "'":"00100/00100/00100/00000/00000/00000/00000" ,
    "(":"00010/00100/01000/01000/01000/00100/00010" ,
    ")":"01000/00100/00010/00010/00010/00100/01000" ,
    "=":"00000/11111/00000/11111/00000/00000/00000" ,
    "+":"00000/00100/00100/11111/00100/00100/00000" ,
    "%":"11001/11010/00100/01000/10110/00110/00000" ,
    "#":"01010/11111/01010/11111/01010/00000/00000" ,
    "@":"01110/10001/10111/10101/10111/10000/01110" ,
    "*":"00000/10101/01110/11111/01110/10101/00000" ,
    "&":"01100/10010/10100/01000/10101/10010/01101" ,
    ";":"00000/00100/00100/00000/00100/00100/01000" ,
    "\\":"10000/10000/01000/00100/00010/00001/00001" ,
    "<":"00010/00100/01000/10000/01000/00100/00010" ,
    ">":"01000/00100/00010/00001/00010/00100/01000" ,
    "[":"01110/01000/01000/01000/01000/01000/01110" ,
    "]":"01110/00010/00010/00010/00010/00010/01110" ,
    "{":"00010/00100/00100/01000/00100/00100/00010" ,
    "}":"01000/00100/00100/00010/00100/00100/01000" ,
    "|":"00100/00100/00100/00100/00100/00100/00100" ,
    "~":"00000/00000/01001/10110/00000/00000/00000" ,
    "^":"00100/01010/10001/00000/00000/00000/00000" ,
    "`":"01000/00100/00010/00000/00000/00000/00000" ,
    "$":"00100/01111/10100/01110/00101/11110/00100" ,
    "a":"00000/01110/00001/01111/10001/10011/01101" ,
    "b":"10000/10000/11110/10001/10001/10001/11110" ,
    "c":"00000/01111/10000/10000/10000/10000/01111" ,
    "d":"00001/00001/01111/10001/10001/10001/01111" ,
    "e":"00000/01110/10001/11111/10000/10001/01110" ,
    "f":"00110/01001/01000/11100/01000/01000/01000" ,
    "g":"00000/01111/10001/01111/00001/10001/01110" ,
    "h":"10000/10000/11110/10001/10001/10001/10001" ,
    "i":"00100/00000/01100/00100/00100/00100/01110" ,
    "j":"00010/00000/00110/00010/00010/10010/01100" ,
    "k":"10000/10001/10010/11100/10010/10001/10001" ,
    "l":"01100/00100/00100/00100/00100/00100/01110" ,
    "m":"00000/11010/10101/10101/10101/10101/10101" ,
    "n":"00000/11110/10001/10001/10001/10001/10001" ,
    "o":"00000/01110/10001/10001/10001/10001/01110" ,
    "p":"00000/11110/10001/11110/10000/10000/10000" ,
    "q":"00000/01111/10001/01111/00001/00001/00001" ,
    "r":"00000/10110/11001/10000/10000/10000/10000" ,
    "s":"00000/01111/10000/01110/00001/00001/11110" ,
    "t":"01000/01000/11100/01000/01000/01001/00110" ,
    "u":"00000/10001/10001/10001/10001/10011/01101" ,
    "v":"00000/10001/10001/10001/10001/01010/00100" ,
    "w":"00000/10101/10101/10101/10101/10101/01010" ,
    "x":"00000/10001/01010/00100/01010/10001/10001" ,
    "y":"00000/10001/10001/01111/00001/10001/01110" ,
    "z":"00000/11111/00010/00100/01000/10000/11111" ,
    "А":"01110/10001/10001/11111/10001/10001/10001" ,
    "Б":"11111/10000/10000/11110/10001/10001/11110" ,
    "В":"11110/10001/10001/11110/10001/10001/11110" ,
    "Г":"11111/10000/10000/10000/10000/10000/10000" ,
    "Д":"01110/01010/01010/01010/11111/10001/10001" ,
    "Е":"11111/10000/10000/11110/10000/10000/11111" ,
    "Ё":"01010/00000/11111/10000/11110/10000/11111" ,
    "Ж":"1010101/1010101/0111110/0011100/0111110/1010101/1010101" ,
    "З":"11110/00001/00001/01110/00001/00001/11110" ,
    "И":"10001/10011/10101/10101/11001/10001/10001" ,
    "Й":"01010/00100/10001/10011/10101/11001/10001" ,
    "К":"10001/10010/10100/11000/10100/10010/10001" ,
    "Л":"00111/01001/01001/01001/01001/10001/10001" ,
    "М":"10001/11011/10101/10101/10001/10001/10001" ,
    "Н":"10001/10001/10001/11111/10001/10001/10001" ,
    "О":"01110/10001/10001/10001/10001/10001/01110" ,
    "П":"11111/10001/10001/10001/10001/10001/10001" ,
    "Р":"11110/10001/10001/11110/10000/10000/10000" ,
    "С":"01111/10000/10000/10000/10000/10000/01111" ,
    "Т":"11111/00100/00100/00100/00100/00100/00100" ,
    "У":"10001/10001/01010/00100/00100/01000/10000" ,
    "Ф":"00100/01110/10101/10101/10101/01110/00100" ,
    "Х":"10001/10001/01010/00100/01010/10001/10001" ,
    "Ц":"100010/100010/100010/100010/100010/111111/000001" ,
    "Ч":"10001/10001/10001/01111/00001/00001/00001" ,
    "Ш":"10101/10101/10101/10101/10101/10101/11111" ,
    "Щ":"101010/101010/101010/101010/101010/111111/000001" ,
    "Ъ":"11000/01000/01000/01110/01001/01001/01110" ,
    "Ы":"1000101/1000101/1000101/1110101/1001101/1001101/1110101" ,
    "Ь":"10000/10000/10000/11110/10001/10001/11110" ,
    "Э":"11110/00001/00001/01111/00001/00001/11110" ,
    "Ю":"1001100/1010010/1010010/1110010/1010010/1010010/1001100" ,
    "Я":"01111/10001/10001/01111/00101/01001/10001" ,
    "а":"00000/01110/00001/01111/10001/10011/01101" ,
    "б":"00111/01000/10000/11110/10001/10001/01110" ,
    "в":"00000/11110/10001/11110/10001/10001/11110" ,
    "г":"00000/11111/10000/10000/10000/10000/10000" ,
    "д":"00000/01110/01010/01010/11111/10001/10001" ,
    "е":"00000/01110/10001/11111/10000/10001/01110" ,
    "ё":"01010/00000/01110/10001/11111/10000/01110" ,
    "ж":"0000000/1010101/0111110/0011100/0111110/1010101/1010101" ,
    "з":"00000/11110/00001/01110/00001/00001/11110" ,
    "и":"00000/10001/10011/10101/11001/10001/10001" ,
    "й":"01010/00100/10001/10011/10101/11001/10001" ,
    "к":"00000/10001/10010/11100/10010/10001/10001" ,
    "л":"00000/00111/01001/01001/01001/10001/10001" ,
    "м":"00000/10001/11011/10101/10101/10001/10001" ,
    "н":"00000/10001/10001/11111/10001/10001/10001" ,
    "о":"00000/01110/10001/10001/10001/10001/01110" ,
    "п":"00000/11111/10001/10001/10001/10001/10001" ,
    "р":"00000/11110/10001/11110/10000/10000/10000" ,
    "с":"00000/01111/10000/10000/10000/10000/01111" ,
    "т":"00000/11111/00100/00100/00100/00100/00100" ,
    "у":"00000/10001/10001/01111/00001/00001/11110" ,
    "ф":"00000/00100/01110/10101/10101/01110/00100" ,
    "х":"00000/10001/01010/00100/01010/10001/10001" ,
    "ц":"000000/100010/100010/100010/100010/111111/000001" ,
    "ч":"00000/10001/10001/01111/00001/00001/00001" ,
    "ш":"00000/10101/10101/10101/10101/10101/11111" ,
    "щ":"000000/101010/101010/101010/101010/111111/000001" ,
    "ъ":"00000/11000/01000/01110/01001/01001/01110" ,
    "ы":"0000000/1000101/1000101/1110101/1001101/1001101/1110101" ,
    "ь":"00000/10000/10000/11110/10001/10001/11110" ,
    "э":"00000/11110/00001/01111/00001/00001/11110" ,
    "ю":"0000000/1001100/1010010/1110010/1010010/1010010/1001100" ,
    "я":"00000/01111/10001/01111/00101/01001/10001" 
  };
  function matrixText(s){
    return Array.from(s).map(c=>{
      if(c==='\u00a0'||c==='\n'||c==='\r'||c==='\t')return ' ';
      if(/[–—−]/.test(c))return '-';
      if(/[‘’ʼ]/.test(c))return "'";
      if(/[“”«»]/.test(c))return '"';
      if(c==='…')return '...';
      if(c==='№')return 'N';
      return Object.hasOwn(font,c)?c:'?';
    }).join('');
  }
  const dots=[];
  function createMatrix(){
    const holder=$('ledGrid');holder.replaceChildren();
    for(let i=0;i<256;i++){
      const dot=document.createElement('i');holder.append(dot);dots.push(dot);
    }
  }
  function previewPart(item){
    if(item.type==='text')return item.value||' ';
    if(item.type==='date')return localDate(item.value);
    if(item.type==='twitch'){
      const login=normalizeStreamer(item.value)||'pwgood';
      return login.toUpperCase()+': '+(counts.get(login)||'123456');
    }
    return '';
  }
  function currentPreviewMessage(){
    if(blocks[previewIndex]?.type==='join')previewIndex=0;
    let at=previewIndex;
    let message=previewPart(blocks[at]||defaultBlock());
    while(at+2<blocks.length&&blocks[at+1].type==='join'&&blocks[at+2].type!=='join'){
      if(blocks[at+1].value==='SPACE')message+=' ';
      message+=previewPart(blocks[at+2]);
      at+=2;
    }
    previewGroupEnd=at;
    return matrixText(message);
  }
  function generatePreview(){
    const message=currentPreviewMessage();
    const columns=[];
    for(let i=0;i<32;i++)columns.push(0);
    for(const letter of message){
      const shape=(font[letter]||font['?']).split('/');
      for(let x=0;x<(shape[0]?.length||5);x++){
        let bits=0;
        for(let y=0;y<7;y++)if(shape[y]?.[x]==='1')bits|=(1<<y);
        columns.push(bits);
      }
      columns.push(0);
    }
    for(let i=0;i<34;i++)columns.push(0);
    return columns;
  }
  function restartPreview(){
    if(!blocks.length)return;
    previewIndex=0; // rerender the entire merged scenario from its first group
    previewColumn=0;previewColumns=generatePreview();
    if(previewTimer)clearTimeout(previewTimer);
    previewTick();
  }
  function previewTick(){
    const columns=previewColumns;
    for(let x=0;x<32;x++){
      const mask=columns[previewColumn+x]||0;
      for(let y=0;y<8;y++)dots[y*32+x].classList.toggle('on',Boolean(mask&(1<<y)));
    }
    previewColumn++;
    if(previewColumn+32>=columns.length){
      previewIndex=(previewGroupEnd+1)%blocks.length;
      previewColumn=0;
      previewColumns=generatePreview();
    }
    const speed=clamp(blocks[previewIndex]?.speed,35,140,65);
    previewTimer=setTimeout(previewTick,speed);
  }

  // Browser flashing DISABLED: app-only binary could erase bootloader on new install.
  loadLocalDraft();createMatrix();renderBuilder();
  if(!('serial' in navigator))banner('Для подключения нужен Chrome или Edge с Web Serial на компьютере. Конструктор можно редактировать офлайн.');
  else if(!window.isSecureContext)banner('Для работы с USB опубликуй сайт по HTTPS (например, GitHub Pages).');
})();