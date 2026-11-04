/* Twitch Followers LED — USB settings + typed playlist constructor v5.1.
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
  let blocks=[defaultBlock()], selected=0, dirty=false;
  let port=null, reader=null, readTask=null, connected=false, busy=false, fw5=false, firmwareVersion=0;
  let rxBuffer='', pendingReply=null, incomingPlaylist=null;
  let counts=new Map();
  let previewTimer=null, previewIndex=0, previewColumn=0, previewColumns=[];
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
  function sanitizeBlock(item) {
    if(!item || !['twitch','text','date'].includes(item.type))throw Error('Неизвестный тип элемента');
    let value=String(item.value??'').trim();
    if(item.type==='twitch'){
      value=normalizeStreamer(value);
      if(!value)throw Error('Проверь логин Twitch — латиница, цифры и _');
    }else if(item.type==='date'){
      if(!Object.hasOwn(DATE_ZONES,value))throw Error('Выбери часовой пояс для даты');
    }else{
      if(!value || /[\r\n\x00-\x1f]/.test(value))throw Error('Свой текст не должен быть пустым или содержать переносы строк');
      if(byteLength(value)>MAX_TEXT_BYTES)throw Error(`Свой текст не должен превышать ${MAX_TEXT_BYTES} байт UTF-8`);
    }
    return {type:item.type,value,speed:clamp(item.speed,35,140,65),pauseMs:clamp(item.pauseMs,0,2500,300)};
  }
  function validatePlaylist(arr){
    if(!Array.isArray(arr)||arr.length<1||arr.length>MAX_BLOCKS)throw Error('Нужен хотя бы 1 элемент (максимум 12)');
    return arr.map(sanitizeBlock);
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
  function updateBuilderButtons(){
    const needsNewFirmware=blocks.some(b=>b.type==='date')&&firmwareVersion<5.1;
    $('savePlaylist').disabled=!(connected&&fw5&&!needsNewFirmware&&!busy&&blocks.length>0);
    $('reloadPlaylist').disabled=!(connected&&fw5&&!busy);
    $('builderConnect').disabled=connected||busy;
    $('playlistState').dataset.dirty=String(dirty);
    if(!connected) notify('Черновик в браузере. Подключи ESP32, чтобы записать сценарий на устройство.');
    else if(!fw5)notify('Подключено. Для конструктора нужна прошивка v5 и новее.');
    else if(needsNewFirmware)notify('Для блока даты нужно обновить прошивку до v5.1 через вкладку «Обновления».');
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
    const item=s.match(/^PLAYLIST ITEM (\d+) (TWITCH|TEXT|DATE) (\d+) (\d+) (.+)$/);
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
  function itemName(block){return block.type==='twitch'?block.value||'Не указан логин':block.type==='date'?localDate(block.value):block.value||'Пустой текст';}
  function renderList(){
    const list=$('blocksList');list.replaceChildren();
    blocks.forEach((block,index)=>{
      const card=document.createElement('div');
      card.className='block-card '+block.type+(selected===index?' selected':'');
      card.setAttribute('role','listitem');
      const num=document.createElement('span');num.className='block-number';num.textContent=index+1;
      const main=document.createElement('button');main.type='button';main.className='block-main';main.dataset.action='select';main.dataset.index=index;
      const type=document.createElement('span');type.className='block-type';type.textContent=block.type==='twitch'?'TWITCH · ФОЛЛОВЕРЫ':block.type==='date'?'СЕГОДНЯШНЯЯ ДАТА':'СВОЙ ТЕКСТ';
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
    $('removeSelected').disabled=n===1;
  }
  function renderEditor(){
    selected=Math.min(selected,blocks.length-1);
    const block=blocks[selected];
    $('selectedPosition').textContent='№ '+(selected+1);
    $('editHeading').textContent=block.type==='twitch'?'Счётчик фолловеров Twitch':block.type==='date'?'Сегодняшняя дата':'Произвольный текст';
    $('twitchSettings').hidden=block.type!=='twitch';
    $('textSettings').hidden=block.type!=='text';
    $('dateSettings').hidden=block.type!=='date';
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
    }else if(action==='up'&&index>0){
      [blocks[index-1],blocks[index]]=[blocks[index],blocks[index-1]];selected=index-1;markDirty();renderBuilder();
    }else if(action==='down'&&index<blocks.length-1){
      [blocks[index+1],blocks[index]]=[blocks[index],blocks[index+1]];selected=index+1;markDirty();renderBuilder();
    }else if(action==='remove'&&blocks.length>1){
      blocks.splice(index,1);selected=Math.min(index,blocks.length-1);markDirty();renderBuilder();
    }
  });
  function addBlock(type){
    if(blocks.length>=MAX_BLOCKS){banner('Можно добавить не более 12 элементов.');return;}
    const newBlock=type==='date'?{type,value:'BERLIN',speed:65,pauseMs:300}:type==='text'?{type,value:'PRIVET!',speed:65,pauseMs:300}:defaultBlock();
    blocks.splice(selected+1,0,newBlock);selected+=1;markDirty();renderBuilder();
    (type==='date'?$('itemDateZone'):type==='text'?$('itemText'):$('itemStreamer')).focus();
  }
  $('addTwitch').addEventListener('click',()=>addBlock('twitch'));
  $('addText').addEventListener('click',()=>addBlock('text'));
  $('addDate').addEventListener('click',()=>addBlock('date'));
  $('removeSelected').addEventListener('click',()=>{
    if(blocks.length<=1)return;
    blocks.splice(selected,1);selected=Math.min(selected,blocks.length-1);markDirty();renderBuilder();
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
    if(blocks.some(b=>b.type==='date')&&firmwareVersion<5.1){banner('Для даты обнови прошивку до v5.1.');return;}
    let clean;
    try{clean=validatePlaylist(blocks);}catch(e){banner('Ошибка сценария: '+e.message);return;}
    busy=true;updateBuilderButtons();
    let committed=false;
    try{
      await sendAck('PLAYLIST BEGIN','OK PLAYLIST BEGIN','Начало передачи сценария.');
      for(let i=0;i<clean.length;i++){
        const item=clean[i],encoded=item.type==='text'?byteToB64(item.value):item.value;
        await sendAck(`PLAYLIST ADD ${item.type.toUpperCase()} ${encoded} ${item.speed} ${item.pauseMs}`,'OK PLAYLIST ADD',`Блок ${i+1}/${clean.length}: ${item.type==='date'?'дата':item.type==='text'?'текст':'Twitch'}`);
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
    const blob=new Blob([JSON.stringify({schema:2,app:'Twitch LED Builder',blocks:clean},null,2)],{type:'application/json'});
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
  const font={
    'A':'01110/10001/10001/11111/10001/10001/10001','B':'11110/10001/10001/11110/10001/10001/11110',
    'C':'01111/10000/10000/10000/10000/10000/01111','D':'11110/10001/10001/10001/10001/10001/11110',
    'E':'11111/10000/10000/11110/10000/10000/11111','F':'11111/10000/10000/11110/10000/10000/10000',
    'G':'01111/10000/10000/10111/10001/10001/01111','H':'10001/10001/10001/11111/10001/10001/10001',
    'I':'11111/00100/00100/00100/00100/00100/11111','J':'00111/00010/00010/00010/10010/10010/01100',
    'K':'10001/10010/10100/11000/10100/10010/10001','L':'10000/10000/10000/10000/10000/10000/11111',
    'M':'10001/11011/10101/10101/10001/10001/10001','N':'10001/11001/10101/10011/10001/10001/10001',
    'O':'01110/10001/10001/10001/10001/10001/01110','P':'11110/10001/10001/11110/10000/10000/10000',
    'Q':'01110/10001/10001/10001/10101/10010/01101','R':'11110/10001/10001/11110/10100/10010/10001',
    'S':'01111/10000/10000/01110/00001/00001/11110','T':'11111/00100/00100/00100/00100/00100/00100',
    'U':'10001/10001/10001/10001/10001/10001/01110','V':'10001/10001/10001/10001/10001/01010/00100',
    'W':'10001/10001/10001/10101/10101/10101/01010','X':'10001/10001/01010/00100/01010/10001/10001',
    'Y':'10001/10001/01010/00100/00100/00100/00100','Z':'11111/00001/00010/00100/01000/10000/11111',
    '0':'01110/10011/10101/10101/11001/10001/01110','1':'00100/01100/00100/00100/00100/00100/01110',
    '2':'01110/10001/00001/00010/00100/01000/11111','3':'11110/00001/00001/01110/00001/00001/11110',
    '4':'00010/00110/01010/10010/11111/00010/00010','5':'11111/10000/10000/11110/00001/00001/11110',
    '6':'01110/10000/10000/11110/10001/10001/01110','7':'11111/00001/00010/00100/01000/01000/01000',
    '8':'01110/10001/10001/01110/10001/10001/01110','9':'01110/10001/10001/01111/00001/00001/01110',
    ':':'00000/00100/00100/00000/00100/00100/00000','.':'00000/00000/00000/00000/00000/00100/00100',
    '!':'00100/00100/00100/00100/00100/00000/00100','?':'01110/10001/00001/00010/00100/00000/00100',
    '-':'00000/00000/00000/11111/00000/00000/00000','_':'00000/00000/00000/00000/00000/00000/11111',
    '/':'00001/00001/00010/00100/01000/10000/10000',' ':'00000/00000/00000/00000/00000/00000/00000'
  };
  const rus=['A','B','V','G','D','E','ZH','Z','I','Y','K','L','M','N','O','P','R','S','T','U','F','KH','TS','CH','SH','SCH','','Y','','E','YU','YA'];
  function matrixText(s){
    return Array.from(s).map(c=>{
      const cp=c.codePointAt(0);
      if(cp>=0x410&&cp<=0x42F)return rus[cp-0x410];
      if(cp>=0x430&&cp<=0x44F)return rus[cp-0x430];
      if(cp===0x401||cp===0x451)return 'YO';
      if(cp===0x2013||cp===0x2014)return '-';
      if(cp===0x2018||cp===0x2019)return "'";
      if(cp===0x201C||cp===0x201D)return '"';
      if(cp===0x2026)return '...';
      return cp<128?c.toUpperCase():'?';
    }).join('');
  }
  const dots=[];
  function createMatrix(){
    const holder=$('ledGrid');holder.replaceChildren();
    for(let i=0;i<256;i++){
      const dot=document.createElement('i');holder.append(dot);dots.push(dot);
    }
  }
  function currentPreviewMessage(){
    const item=blocks[previewIndex]||blocks[0];
    if(item.type==='text')return matrixText(item.value||' ');
    if(item.type==='date')return localDate(item.value);
    const login=normalizeStreamer(item.value)||'PWGOOD';
    return login.toUpperCase()+': '+(counts.get(login)||'123456');
  }
  function generatePreview(){
    const message=currentPreviewMessage();
    const columns=[];
    for(let i=0;i<32;i++)columns.push(0);
    for(const letter of message){
      const shape=(font[letter]||font['?']).split('/');
      for(let x=0;x<5;x++){
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
    if(previewIndex>=blocks.length)previewIndex=0;
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
    if(previewColumn+32>=columns.length){previewIndex=(previewIndex+1)%blocks.length;previewColumn=0;previewColumns=generatePreview();}
    const speed=clamp(blocks[previewIndex]?.speed,35,140,65);
    previewTimer=setTimeout(previewTick,speed);
  }

  // --- Optional ESP Web Tools software flashing ---
  let onlineManifestUrl=null,localManifestUrl=null,localFirmwareUrl=null;
  const firmwareBase=new URL('./firmware/',document.baseURI);
  function makeManifest(binUrl,version){
    const data={name:'Twitch Followers LED',version,new_install_prompt_erase:true,new_install_improv_wait_time:0,
      builds:[{chipFamily:'ESP32',parts:[{path:binUrl,offset:65536}]}]};
    return URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));
  }
  async function lookupRelease(){
    try{
      const response=await fetch(new URL('release.json',firmwareBase),{cache:'no-store'});
      if(!response.ok)throw Error('HTTP '+response.status);
      const item=await response.json();
      if(!item.available||!item.file){$('releaseStatus').textContent='Опубликованной прошивки пока нет';return;}
      if(!/^[\w.\-]+\.bin$/.test(item.file))throw Error('Некорректный путь .bin');
      const fileUrl=new URL(item.file,firmwareBase).href;
      onlineManifestUrl=makeManifest(fileUrl,String(item.version||'latest'));
      $('onlineInstaller').manifest=onlineManifestUrl;
      $('releaseVersion').textContent='Версия '+String(item.version||'новая');
      $('releaseNotes').textContent=String(item.notes||'Доступная версия.');
      $('noRelease').hidden=true;$('releaseBlock').hidden=false;
      $('releaseStatus').textContent='Версия '+String(item.version||'latest')+' доступна';
    }catch(e){$('releaseStatus').textContent='Проверить версию не удалось';log(e.message,'Инфо');}
  }
  $('confirmOnline').addEventListener('change',e=>{$('onlineHolder').hidden=!e.target.checked;});
  $('confirmLocal').addEventListener('change',e=>{$('localHolder').hidden=!(e.target.checked&&localManifestUrl);});
  $('firmwareFile').addEventListener('change',e=>{
    const file=e.target.files?.[0];
    $('localHolder').hidden=true;$('confirmLocal').checked=false;
    if(!file){$('fileInfo').textContent='Файл не выбран';localManifestUrl=null;return;}
    if(!file.name.toLowerCase().endsWith('.bin')||file.size<4096||file.size>3*1024*1024){
      $('fileInfo').textContent='Нужен совместимый .bin от 4 КБ до 3 МБ.';localManifestUrl=null;return;
    }
    localFirmwareUrl=URL.createObjectURL(file);
    localManifestUrl=makeManifest(localFirmwareUrl,'local-'+file.name.replace(/[^a-zA-Z0-9_.-]/g,'_'));
    $('localInstaller').manifest=localManifestUrl;
    $('fileInfo').textContent=`Выбран ${file.name} · ${(file.size/1024).toFixed(1)} КиБ. Файл остаётся на компьютере.`;
  });

  loadLocalDraft();createMatrix();renderBuilder();
  if(!('serial' in navigator))banner('Для подключения нужен Chrome или Edge с Web Serial на компьютере. Конструктор можно редактировать офлайн.');
  else if(!window.isSecureContext)banner('Для работы с USB опубликуй сайт по HTTPS (например, GitHub Pages).');
  lookupRelease();
})();