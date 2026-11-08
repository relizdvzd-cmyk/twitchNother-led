#pragma once
// Twitch LED Logic 6.3: isolated binary video storage. The verified default
// partition table is unchanged. Never format any data partition automatically.
#include <LittleFS.h>
#include <mbedtls/base64.h>
#include <ctype.h>
static const uint16_t VIDEO_MAX_FRAMES=16384;
static const uint32_t VIDEO_MAX_BYTES=512UL*1024UL;
static const uint8_t VIDEO_HEADER_SIZE=12;
bool videoFsReady=false,videoUploadOpen=false,videoPresent=false;
File videoUploadFile,videoPlaybackFile;
uint32_t videoUploadBytes=0,videoUploadCRC=0xFFFFFFFF,videoExpectedBytes=0,videoExpectedCRC=0;
uint16_t videoExpectedFrames=0,videoSavedFrames=0,videoPlayFrame=0;
uint8_t videoExpectedFPS=0,videoSavedFPS=0;
uint32_t videoPlayAt=0;

uint32_t videoCRCStep(uint32_t crc,const uint8_t* data,size_t len){
  for(size_t i=0;i<len;i++){
    crc^=data[i];
    for(uint8_t j=0;j<8;j++)crc=(crc&1)?((crc>>1)^0xEDB88320UL):(crc>>1);
  }
  return crc;
}
String videoToken(const String& s,uint8_t index){
  uint16_t pos=0;
  for(uint8_t i=0;i<index;i++){
    int p=s.indexOf(' ',pos);
    if(p<0)return "";
    pos=p+1;
  }
  int end=s.indexOf(' ',pos);
  return end<0?s.substring(pos):s.substring(pos,end);
}
bool videoNumber(const String& s,uint32_t min,uint32_t max,uint32_t& out){
  if(s.isEmpty()||s.length()>10)return false;
  uint64_t n=0;
  for(size_t i=0;i<s.length();i++){
    if(s[i]<'0'||s[i]>'9')return false;
    n=n*10+(s[i]-'0');
    if(n>max)return false;
  }
  out=(uint32_t)n;return n>=min;
}
bool videoParseCRC(const String& s,uint32_t& crc){
  if(s.length()!=8)return false;
  for(size_t i=0;i<8;i++)if(!isxdigit((unsigned char)s[i]))return false;
  crc=(uint32_t)strtoul(s.c_str(),nullptr,16);
  return true;
}
bool videoReadInfo(){
  videoPresent=false;videoSavedFrames=0;videoSavedFPS=0;
  if(!videoFsReady||!LittleFS.exists("/clip.bin"))return false;
  File f=LittleFS.open("/clip.bin","r");
  if(!f)return false;
  uint8_t h[VIDEO_HEADER_SIZE]={0};
  const bool header=f.read(h,sizeof(h))==sizeof(h);
  const uint16_t frames=(uint16_t)h[4]|((uint16_t)h[5]<<8);
  const uint8_t fps=h[6];
  const bool valid=header&&memcmp(h,"TLV1",4)==0&&h[7]==0&&
    frames>0&&frames<=VIDEO_MAX_FRAMES&&fps>=2&&fps<=20&&
    (uint32_t)frames*32UL<=VIDEO_MAX_BYTES&&
    f.size()==VIDEO_HEADER_SIZE+(uint32_t)frames*32UL;
  f.close();
  if(!valid)return false;
  videoSavedFrames=frames;videoSavedFPS=fps;videoPresent=true;return true;
}
void videoInitFS(){
  if(videoFsReady)return;
  videoFsReady=LittleFS.begin(false,"/littlefs",10,"spiffs");
  if(!videoFsReady){Serial.println("VIDEO FS UNFORMATTED");return;}
  // Recover the prior clip if power was lost during atomic replacement.
  if(LittleFS.exists("/clip.bak")){
    if(!LittleFS.exists("/clip.bin")||!videoReadInfo()){
      if(LittleFS.exists("/clip.bin"))LittleFS.remove("/clip.bin");
      LittleFS.rename("/clip.bak","/clip.bin");
    }else LittleFS.remove("/clip.bak");
  }
  if(LittleFS.exists("/clip.tmp"))LittleFS.remove("/clip.tmp");
  videoReadInfo();
}
void printMemoryInfo(){
  uint32_t scriptBytes=0;
  for(uint8_t i=0;i<scriptCount;i++)scriptBytes+=scriptLines[i].length()+1;
  const uint32_t total=videoFsReady?LittleFS.totalBytes():0;
  const uint32_t used=videoFsReady?LittleFS.usedBytes():0;
  const uint32_t freeBytes=total>=used?total-used:0;
  Serial.print("MEM fs=");Serial.print(videoFsReady?1:0);
  Serial.print(" total=");Serial.print(total);
  Serial.print(" used=");Serial.print(used);
  Serial.print(" free=");Serial.print(freeBytes);
  Serial.print(" video=");Serial.print(videoPresent?(uint32_t)videoSavedFrames*32UL:0);
  Serial.print(" frames=");Serial.print(videoPresent?videoSavedFrames:0);
  Serial.print(" fps=");Serial.print(videoPresent?videoSavedFPS:0);
  Serial.print(" script=");Serial.print(scriptBytes);
  Serial.print(" cmds=");Serial.println(scriptCount);
}
void videoAbort(){
  if(videoUploadFile)videoUploadFile.close();
  videoUploadOpen=false;videoUploadBytes=0;
  if(videoFsReady&&LittleFS.exists("/clip.tmp"))LittleFS.remove("/clip.tmp");
}
void videoStopPlayback(){
  if(videoPlaybackFile)videoPlaybackFile.close();
  matrix.displaySuspend(false);
}
bool videoDrawNext(){
  if(!videoPlaybackFile)return false;
  uint8_t columns[32];
  if(videoPlaybackFile.read(columns,sizeof(columns))!=sizeof(columns))return false;
  MD_MAX72XX* gfx=matrix.getGraphicObject();
  gfx->update(MD_MAX72XX::OFF);
  for(uint8_t col=0;col<32;col++)gfx->setColumn(31-col,columns[col]);
  gfx->update();gfx->update(MD_MAX72XX::ON);
  return true;
}
bool videoStartPlayback(){
  if(!videoPresent||videoUploadOpen||!videoFsReady)return false;
  videoStopPlayback();
  videoPlaybackFile=LittleFS.open("/clip.bin","r");
  if(!videoPlaybackFile||!videoPlaybackFile.seek(VIDEO_HEADER_SIZE,SeekSet)){
    videoStopPlayback();return false;
  }
  videoPlayFrame=0;videoPlayAt=millis();
  matrix.displaySuspend(true);
  if(!videoDrawNext()){videoStopPlayback();return false;}
  videoPlayFrame=1;return true;
}
void videoTick(uint32_t now){
  if(!videoPlaybackFile){scriptMode=0;matrix.displaySuspend(false);return;}
  if(now-videoPlayAt<(uint32_t)(1000U/videoSavedFPS))return;
  videoPlayAt=now;
  if(videoPlayFrame>=videoSavedFrames||!videoDrawNext()){
    videoStopPlayback();scriptMode=0;return;
  }
  videoPlayFrame++;
}
void videoCommand(String args){
  args.trim();
  const String op=videoToken(args,0);
  if(op=="INFO"){printMemoryInfo();return;}
  if(op=="FORMAT"){
    if(videoToken(args,1)!="CONFIRM"||videoToken(args,2)!=""){
      Serial.println("ERR VIDEO FORMAT CONFIRM REQUIRED");return;
    }
    if(videoUploadOpen){Serial.println("ERR VIDEO UPLOAD ACTIVE");return;}
    if(videoFsReady){Serial.println("OK VIDEO FORMAT ALREADY");printMemoryInfo();return;}
    videoFsReady=LittleFS.begin(true,"/littlefs",10,"spiffs");
    if(!videoFsReady){Serial.println("ERR VIDEO FORMAT FAILED");return;}
    videoReadInfo();
    Serial.println("OK VIDEO FORMAT");printMemoryInfo();return;
  }
  if(op=="ABORT"){
    videoAbort();Serial.println("OK VIDEO ABORT");printMemoryInfo();return;
  }
  if(op=="CLEAR"){
    if(videoToken(args,1)!="CONFIRM"||!videoFsReady||videoUploadOpen){
      Serial.println("ERR VIDEO CLEAR INVALID");return;
    }
    videoStopPlayback();
    if(scriptMode==4)scriptMode=0;
    if(LittleFS.exists("/clip.bin"))LittleFS.remove("/clip.bin");
    videoReadInfo();Serial.println("OK VIDEO CLEAR");printMemoryInfo();return;
  }
  if(op=="BEGIN"){
    if(!videoFsReady){Serial.println("ERR VIDEO FS NOT READY");return;}
    if(videoUploadOpen){Serial.println("ERR VIDEO UPLOAD ACTIVE");return;}
    uint32_t frames=0,fps=0;
    if(!videoNumber(videoToken(args,1),1,VIDEO_MAX_FRAMES,frames)||
       !videoNumber(videoToken(args,2),2,20,fps)||
       !videoParseCRC(videoToken(args,3),videoExpectedCRC)||
       videoToken(args,4)!=""){
      Serial.println("ERR VIDEO INVALID HEADER");return;
    }
    const uint32_t bytes=frames*32UL;
    const uint32_t total=LittleFS.totalBytes(),used=LittleFS.usedBytes();
    if(bytes>VIDEO_MAX_BYTES||used>total||
       total-used<bytes+VIDEO_HEADER_SIZE+8192UL){
      Serial.println("ERR VIDEO NOT ENOUGH FREE SPACE");return;
    }
    videoStopPlayback();
    if(scriptMode==4)scriptMode=0;
    if(LittleFS.exists("/clip.tmp"))LittleFS.remove("/clip.tmp");
    videoUploadFile=LittleFS.open("/clip.tmp","w");
    if(!videoUploadFile){Serial.println("ERR VIDEO FILE OPEN");return;}
    const uint8_t h[VIDEO_HEADER_SIZE]={'T','L','V','1',
       (uint8_t)(frames&255),(uint8_t)((frames>>8)&255),(uint8_t)fps,0,
       (uint8_t)(videoExpectedCRC&255),(uint8_t)((videoExpectedCRC>>8)&255),
       (uint8_t)((videoExpectedCRC>>16)&255),(uint8_t)((videoExpectedCRC>>24)&255)};
    if(videoUploadFile.write(h,sizeof(h))!=sizeof(h)){
      videoAbort();Serial.println("ERR VIDEO FILE WRITE");return;
    }
    videoExpectedFrames=(uint16_t)frames;videoExpectedFPS=(uint8_t)fps;
    videoExpectedBytes=bytes;videoUploadBytes=0;videoUploadCRC=0xFFFFFFFF;
    videoUploadOpen=true;
    Serial.println("OK VIDEO BEGIN");return;
  }
  if(op=="DATA"){
    if(!videoUploadOpen||!videoUploadFile){Serial.println("ERR VIDEO BEGIN FIRST");return;}
    const String raw=videoToken(args,1);
    if(raw.length()==0||raw.length()>344||videoToken(args,2)!=""){
      Serial.println("ERR VIDEO DATA SIZE");return;
    }
    uint8_t decoded[256];size_t len=0;
    if(mbedtls_base64_decode(decoded,sizeof(decoded),&len,
         (const unsigned char*)raw.c_str(),raw.length())!=0 ||
       len==0||len>256||len%32!=0||videoUploadBytes+len>videoExpectedBytes){
      Serial.println("ERR VIDEO BAD DATA");return;
    }
    if(videoUploadFile.write(decoded,len)!=len){
      videoAbort();Serial.println("ERR VIDEO FILE WRITE");return;
    }
    videoUploadCRC=videoCRCStep(videoUploadCRC,decoded,len);
    videoUploadBytes+=len;
    Serial.print("OK VIDEO DATA ");Serial.println(videoUploadBytes);return;
  }
  if(op=="COMMIT"){
    if(!videoUploadOpen){Serial.println("ERR VIDEO BEGIN FIRST");return;}
    videoUploadFile.flush();videoUploadFile.close();videoUploadOpen=false;
    if(videoUploadBytes!=videoExpectedBytes||
       (videoUploadCRC^0xFFFFFFFFUL)!=videoExpectedCRC){
      LittleFS.remove("/clip.tmp");Serial.println("ERR VIDEO CRC OR LENGTH");return;
    }
    const bool hadOld=LittleFS.exists("/clip.bin");
    if(LittleFS.exists("/clip.bak"))LittleFS.remove("/clip.bak");
    if(hadOld&&!LittleFS.rename("/clip.bin","/clip.bak")){
      Serial.println("ERR VIDEO BACKUP FAILED");return;
    }
    if(!LittleFS.rename("/clip.tmp","/clip.bin")){
      if(hadOld)LittleFS.rename("/clip.bak","/clip.bin");
      Serial.println("ERR VIDEO COMMIT FAILED");return;
    }
    if(!videoReadInfo()){
      LittleFS.remove("/clip.bin");
      if(hadOld)LittleFS.rename("/clip.bak","/clip.bin");
      videoReadInfo();Serial.println("ERR VIDEO VALIDATION FAILED");return;
    }
    if(hadOld)LittleFS.remove("/clip.bak");
    Serial.println("OK VIDEO COMMIT");printMemoryInfo();return;
  }
  Serial.println("ERR VIDEO UNKNOWN COMMAND");
}
