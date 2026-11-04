import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  APP_OFFSET,assertRelease,assertChipAndFlash,
  assertBootDigestNotBlank,assertPartitionDigest
} from '../firmware-guard.mjs';

const release={
  available:true, version:'5.3', protocol:'esp32-app-only-no-erase-v1',
  board:'ESP32', flash_size:'4MB', app_offset:APP_OFFSET,
  file:'twitch-led-v5.3.bin',size:1075600,
  sha256:'a'.repeat(64),md5:'b'.repeat(32),
  partition_table_bytes:3072,partition_table_md5:'c'.repeat(32)
};
assert.equal(assertRelease(release),release);
assertChipAndFlash('ESP32-D0WD-V3 (revision 3)','4MB');
assertBootDigestNotBlank('0123456789abcdef0123456789abcdef');
assertPartitionDigest('C'.repeat(32),release);
assert.throws(()=>assertRelease({...release,partition_table_md5:undefined}),/заблокирована/);
assert.throws(()=>assertPartitionDigest('d'.repeat(32),release),/НЕ совпадает/);
assert.throws(()=>assertBootDigestNotBlank('8d79cbc9a4ecdde112fc91ba625b13c2'),/пуст/);
assert.throws(()=>assertBootDigestNotBlank('4ae71336e44bf9bf79d2752e234818a5'),/пуст/);
assert.throws(()=>assertChipAndFlash('ESP32-S3','4MB'),/Неподдерживаемый/);
assert.throws(()=>assertChipAndFlash('ESP32-C3','4MB'),/Неподдерживаемый/);
assert.throws(()=>assertChipAndFlash('ESP32','8MB'),/Flash/);
const up=readFileSync(new URL('../updater.js',import.meta.url),'utf8');
assert.doesNotMatch(up,/loader\.readFlash\s*\(/);
assert.match(up,/loader\.flashMd5sum\(0x8000,release\.partition_table_bytes\)/);
assert.match(up,/loader\.flashMd5sum\(APP_OFFSET,image\.length\)/);
assert.match(up,/eraseAll:false/);
assert.doesNotMatch(up,/eraseAll:true|\.eraseFlash\s*\(/);
assert.doesNotMatch(up,/address:\s*0x1000|address:\s*0x8000/);
console.log('PASS: read-free MD5 preflight, exact partition digest, no-erase app-only flash guards');
