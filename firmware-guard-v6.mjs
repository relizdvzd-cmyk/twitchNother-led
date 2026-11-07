/* Pure classic ESP32 4MB safety checks. Never writes Flash. */
export const APP_OFFSET=0x10000;
export const ESP32_FLASH_BYTES=4*1024*1024;
export const EXPECTED_FILE='twitch-led-v6.0.bin';
export function assertRelease(r){
  if(!r||r.available!==true||r.protocol!=='esp32-app-only-no-erase-v1'||r.version!=='6.0'||
     r.board!=='ESP32'||r.flash_size!=='4MB'||r.app_offset!==APP_OFFSET||
     r.file!==EXPECTED_FILE||!Number.isSafeInteger(r.size)||r.size<65536||r.size>0x140000||
     !/^[a-f0-9]{64}$/i.test(r.sha256||'')||!/^[a-f0-9]{32}$/i.test(r.md5||'')||
     !Number.isSafeInteger(r.partition_table_bytes)||r.partition_table_bytes<192||r.partition_table_bytes>4096||
     !/^[a-f0-9]{32}$/i.test(r.partition_table_md5||'')){
    throw Error('Пакет прошивки не опубликован или несовместим. Запись заблокирована.');
  }
  return r;
}
export function assertChipAndFlash(chipName,flashSize){
  const chip=String(chipName||'').trim().toUpperCase();
  if(!/^ESP32(?:$|[- (])/.test(chip)||/^ESP32[- ](?:S\d|C\d|H\d|P\d)/.test(chip))
    throw Error('Неподдерживаемый контроллер '+chip+'. Нужна классическая ESP32.');
  if(String(flashSize||'').toUpperCase()!=='4MB')
    throw Error('Размер Flash '+flashSize+' не равен 4MB. Запись запрещена.');
}
// Use ESP_SPI_FLASH_MD5 to validate flash without READ_FLASH. Older
// esptool-js readFlash() leaves the final data digest unread.
export function assertBootDigestNotBlank(md5) {
  const actual=String(md5||'').trim().toLowerCase();
  if(!/^[a-f0-9]{32}$/.test(actual)||
     actual==='8d79cbc9a4ecdde112fc91ba625b13c2'|| // MD5(16 x FF)
     actual==='4ae71336e44bf9bf79d2752e234818a5') // MD5(16 x 00)
    throw Error('Загрузчик пуст или контрольная сумма не получена. Запись запрещена.');
  return actual;
}
export function assertPartitionDigest(md5, release) {
  assertRelease(release);
  const actual=String(md5||'').trim().toLowerCase();
  if(!/^[a-f0-9]{32}$/.test(actual)||
     actual!==release.partition_table_md5.toLowerCase())
    throw Error('Таблица разделов НЕ совпадает с эталоном ESP32 4MB Default (ожидалось '+
       release.partition_table_md5+', получено '+actual+'). Запись запрещена.');
  return true;
}
export function parsePartitions(data){
  if(!(data instanceof Uint8Array)||data.length<32)throw Error('Нет таблицы разделов.');
  const dv=new DataView(data.buffer,data.byteOffset,data.byteLength),parts=[];
  for(let n=0;n+32<=data.length;n+=32){
    if(dv.getUint16(n,true)!==0x50AA)break;
    const type=data[n+2],subtype=data[n+3],offset=dv.getUint32(n+4,true),size=dv.getUint32(n+8,true);
    const labelBytes=Array.from(data.slice(n+12,n+28)),stop=labelBytes.findIndex(x=>x===0||x===255);
    const label=labelBytes.slice(0,stop<0?16:stop).map(x=>String.fromCharCode(x)).join('');
    if(size<0x1000||offset%0x1000!==0||size%0x1000!==0||offset+size>ESP32_FLASH_BYTES)
      throw Error('Повреждённая таблица разделов: '+label);
    parts.push({type,subtype,offset,size,label});
  }
  return parts;
}
export function assertSafeAppPartition(partitions,imageSize,bootHeader){
  if(!bootHeader||bootHeader[0]!==0xE9)throw Error('Загрузчик по адресу 0x1000 не найден; веб-обновление запрещено.');
  if(!Array.isArray(partitions)||partitions.length<2)throw Error('Нет корректной таблицы разделов.');
  const app=partitions.find(p=>p.type===0&&(p.subtype===0||p.subtype===0x10)&&p.offset===APP_OFFSET);
  const nvs=partitions.find(p=>p.type===1&&p.subtype===2&&p.offset===0x9000);
  const ota=partitions.find(p=>p.type===1&&p.subtype===0&&p.offset===0xE000);
  if(!app||app.size<imageSize)throw Error('Раздел APP по 0x10000 не найден или слишком мал.');
  if(!nvs||nvs.size!==0x5000||!ota||ota.size!==0x2000)
    throw Error('Нестандартная таблица NVS/OTA. Сохранность настроек не гарантирована.');
  const end=APP_OFFSET+imageSize;
  for(const p of partitions)if(p!==app&&APP_OFFSET<p.offset+p.size&&end>p.offset)
    throw Error('Образ пересекает раздел '+p.label);
  return app;
}
export async function assertImage(bytes,release){
  assertRelease(release);
  if(!(bytes instanceof Uint8Array)||bytes.byteLength!==release.size||bytes[0]!==0xE9)
    throw Error('Повреждённый образ приложения или неверный заголовок ESP32.');
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hex=Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
  if(hex.toLowerCase()!==release.sha256.toLowerCase())
    throw Error('SHA-256 не совпадает! Прошивка заблокирована.');
  return true;
}
