/* Guarded Twitch LED v6.0 Web Serial updater. NO eraseFlash and eraseAll:false. */
import {APP_OFFSET,assertRelease,assertImage,assertChipAndFlash,assertBootDigestNotBlank,assertPartitionDigest} from './firmware-guard-v6.mjs';
const $=id=>document.getElementById(id);
const logEl=$('log');
let release=null,image=null,loader=null,transport=null,ready=false,busy=false;
let phase='ожидание';
let lastPercent=-1;
function log(msg){
  if(logEl.textContent==='Ожидание...')logEl.textContent='';
  logEl.textContent+='['+new Date().toLocaleTimeString('ru-RU')+'] '+msg+'\n';
  if(logEl.textContent.length>13000)logEl.textContent=logEl.textContent.slice(-10000);
  logEl.scrollTop=logEl.scrollHeight;
}
function state(msg,style=''){const el=$('state');el.textContent=msg;el.className=style;}
function controls(){
  $('connect').disabled=busy||!release||!!transport;
  $('disconnect').disabled=busy||!transport;
  $('ack').disabled=busy||!ready;
  $('flash').disabled=busy||!ready||!$('ack').checked||!release||!image;
}
async function load(){
  try{
    if(!window.isSecureContext||!('serial' in navigator))throw Error('Нужен Chrome/Edge через HTTPS с поддержкой USB Web Serial.');
    const metaUrl=new URL('firmware/update-v6.0.json',document.baseURI);
    const resp=await fetch(metaUrl,{cache:'no-store'});
    if(!resp.ok)throw Error('Обновление пока не опубликовано. HTTP '+resp.status);
    const item=assertRelease(await resp.json());
    const fileUrl=new URL(item.file,metaUrl);
    const expectedDir=new URL('firmware/',document.baseURI);
    if(fileUrl.origin!==expectedDir.origin||!fileUrl.pathname.startsWith(expectedDir.pathname))
      throw Error('Недопустимый адрес прошивки.');
    const r=await fetch(fileUrl,{cache:'no-store'});
    if(!r.ok)throw Error('BIN недоступен (HTTP '+r.status+').');
    const bytes=new Uint8Array(await r.arrayBuffer());
    await assertImage(bytes,item);
    release=item;image=bytes;
    $('version').textContent='v'+item.version;
    $('packageStatus').textContent='✓ SHA-256 подтверждена, '+Math.round(image.length/1024)+' КиБ. '+(item.notes||'');
    state('Образ проверен, подключи ESP32.','ok');
    log('SHA-256 файла совпала: '+item.sha256.slice(0,16)+'...');
  }catch(e){
    $('packageStatus').textContent='Запись отключена: '+e.message;
    $('version').textContent='Недоступен';
    state('Запись заблокирована.','err');
    log('Пакет: '+e.message);
  }
  controls();
}
async function disconnect(){
  try{if(transport)await transport.disconnect();}catch(e){log('USB: '+e.message);}
  transport=null;loader=null;ready=false;$('ack').checked=false;
  controls();
}
$('connect').addEventListener('click',async()=>{
  if(!release||!image||busy)return;
  busy=true;controls();state('Проверяю ESP32...');
  try{
    // The port selector MUST be invoked immediately in the user click gesture.
    phase='выбор COM-порта';
    log('Этап 1/6: выбор USB-порта (запись в Flash НЕ производится).');
    const port=await navigator.serial.requestPort();
    const info=port.getInfo();
    log('COM выбран: VID '+(info.usbVendorId??'неизвестен')+', PID '+(info.usbProductId??'неизвестен'));
    phase='загрузка библиотеки';
    const m=await import('https://unpkg.com/esptool-js@0.7.1/bundle.js');
    if(!m.ESPLoader||!m.Transport)throw Error('Библиотека esptool-js недоступна.');
    transport=new m.Transport(port,false);
    const terminal={clean(){},write(){},writeLine(s){const t=String(s).trim();if(t&&/chip|flash|error|sync|stub|connect|reset|ESP32/i.test(t))log('esptool: '+t.slice(0,180));}};
    loader=new m.ESPLoader({transport,baudrate:115200,terminal,debugLogging:false});
    phase='синхронизация ROM / загрузка stub';
    const manual=Boolean($('manualBoot').checked);
    log('Этап 2/6: '+(manual?'ручной режим BOOT, без DTR/RTS (no_reset)':'автоматический сброс DTR/RTS (default_reset)')+'.');
    const result=await loader.main(manual?'no_reset':'default_reset');
    log('Этап 2/6: соединение с загрузчиком установлено.');
    const chip=String(result||loader.chip?.CHIP_NAME||'');
    phase='определение Flash';
    log('Этап 3/6: определяю размер памяти Flash.');
    const flash=await loader.detectFlashSize();
    assertChipAndFlash(chip,flash);
    log('Определено: '+chip+' / '+flash);
    // IMPORTANT: esptool-js@0.7.1 readFlash() fails to drain the final 16-byte
    // digest sent by the ESP32 stub; a following command can desynchronise.
    // ESP_SPI_FLASH_MD5 is a self-contained command (no streaming packets).
    phase='MD5 заголовка загрузчика 0x1000';
    log('Этап 4/6: вычисляю MD5 первых 16 байт загрузчика на ESP32 (без READ_FLASH).');
    const bootDigest=String(await loader.flashMd5sum(0x1000,16)).toLowerCase();
    assertBootDigestNotBlank(bootDigest);
    log('Загрузчик не пустой, MD5 начала: '+bootDigest);
    phase='MD5 таблицы разделов 0x8000';
    log('Этап 5/6: вычисляю MD5 '+release.partition_table_bytes+' байт таблицы разделов прямо на ESP32.');
    const partitionDigest=String(await loader.flashMd5sum(0x8000,release.partition_table_bytes)).toLowerCase();
    assertPartitionDigest(partitionDigest,release);
    phase='проверка схемы разделов';
    log('Этап 6/6: MD5 таблицы совпадает с эталоном стандартной разметки, APP @0x10000.');
    const app={label:'factory',size:0x140000};
    ready=true;
    $('deviceState').textContent='✓ '+chip+' / Flash '+flash+'; раздел '+app.label+' @0x10000 ('+Math.round(app.size/1024)+' КиБ). NVS не затрагивается.';
    state('Проверка пройдена. Подтверди установку.','ok');
    log('MD5 таблицы разделов совпала, проверка завершена без записи Flash.');
  }catch(e){
    ready=false;state('Проверка не пройдена. Ничего не записано.','err');
    $('deviceState').textContent='Плата не прошла проверки. Используй Arduino IDE.';
    log('Ошибка на этапе «'+phase+'»: '+(e.message||e));
    log('Это была только диагностика, стирание и запись Flash НЕ выполнялись.');
    if(/Serial data stream stopped|noise|corruption|Failed to connect|Timed out|timeout/i.test(String(e.message||e))){
      log('Совет: закрой Serial Monitor, убери USB-хаб; затем попробуй «Ручной BOOT»: BOOT удерживать → EN нажать/отпустить → BOOT отпустить → подключить без сброса.');
    }
    await disconnect();
  }finally{busy=false;controls();}
});
$('disconnect').addEventListener('click',async()=>{
  if(busy)return;busy=true;controls();await disconnect();busy=false;
  $('deviceState').textContent='ESP32 отключена.';state('Отключено.');log('USB-порт закрыт.');controls();
});
$('ack').addEventListener('change',controls);
$('flash').addEventListener('click',async()=>{
  if(busy||!ready||!$('ack').checked||!loader||!image||!release)return;
  busy=true;controls();lastPercent=-1;state('Идёт запись, не отключай USB...');
  log('Запись только APP по 0x10000, eraseAll:false. Загрузчик и NVS не меняются.');
  let verified=false;
  try{
    await loader.writeFlash({
      fileArray:[{data:image,address:APP_OFFSET}],
      flashMode:'keep',flashFreq:'keep',flashSize:'4MB',
      eraseAll:false,compress:true,
      reportProgress(_index,written,total){
        const pct=Math.min(100,Math.round(100*written/total));
        $('progress').value=pct;$('percentage').textContent=pct+'%';
        if(pct>=lastPercent+10){lastPercent=pct;log('Запись '+pct+'%');}
      }
    });
    state('Проверяю MD5 памяти ESP32...');
    const md5=String(await loader.flashMd5sum(APP_OFFSET,image.length)).toLowerCase();
    if(md5!==release.md5.toLowerCase())throw Error('MD5 записанного файла не совпадает! На плате '+md5+', ожидалось '+release.md5);
    verified=true;
    log('✓ MD5 совпадает: '+md5);
    await loader.after('hard_reset');
    state('Готово: v6.0 записана и проверена!','ok');
    log('✓ ESP32 перезапущена, проверь V6 LOGIC и команду VERSION.');
  }catch(e){
    state('Запись не подтверждена. Если плата не запускается, открой Arduino IDE.','err');
    log('Ошибка записи: '+(e.message||e));
    if(!verified)log('Повторно не запускай вслепую: проверь порт и состояние устройства.');
  }finally{await disconnect();busy=false;controls();}
});
load();
