/*
  Twitch Followers LED Builder v5.0
  Board: classic ESP32 Dev Module; MAX7219 4 x 8x8 FC-16, 8 x 32 total
  Wiring: DIN=GPIO23, CLK=GPIO18, CS=GPIO5; power=5V, common GND.
  Libraries: MD_Parola, MD_MAX72XX (Arduino IDE Library Manager).
  Serial: 115200 baud, Newline. ESP32 Arduino core 2.x / 3.x.

  Extensible USB playlist protocol:
    VERSION
    PLAYLIST GET
    PLAYLIST BEGIN
    PLAYLIST ADD TWITCH pwgood 65 300
    PLAYLIST ADD TEXT SEVMTE8= 65 300
    PLAYLIST COMMIT
    PLAYLIST CANCEL
  Legacy-compatible: STREAMER, WIFI SSID|PASSWORD, STATUS, REFRESH, HELP.

  Wi-Fi credentials, layout and speeds are saved in Preferences/NVS.
  DecAPI is a third-party service, not the official Twitch API; availability
  and exact figures are not guaranteed.

  Text is UTF-8 stored in Preferences. Cyrillic is transliterated to Latin
  when scrolling because MD_Parola's standard font is ASCII-oriented.
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <MD_Parola.h>
#include <MD_MAX72xx.h>
#include <SPI.h>
#include <mbedtls/base64.h>

#define HARDWARE_TYPE MD_MAX72XX::FC16_HW
#define MAX_DEVICES 4
#define DIN_PIN 23
#define CLK_PIN 18
#define CS_PIN 5

MD_Parola matrix(HARDWARE_TYPE, DIN_PIN, CLK_PIN, CS_PIN, MAX_DEVICES);
Preferences prefs;

static const uint8_t MAX_BLOCKS = 12;
static const size_t MAX_CUSTOM_TEXT_BYTES = 120;
static const uint16_t DEFAULT_SPEED = 65;
static const uint16_t DEFAULT_PAUSE = 300;
static const uint32_t FOLLOWER_UPDATE_MS = 5UL * 60UL * 1000UL;
static const uint32_t ERROR_RETRY_MS = 30UL * 1000UL;
static const uint32_t WIFI_TIMEOUT_MS = 12000UL;
static const uint32_t BOOT_GRACE_MS = 4000UL;
static const uint32_t CONFIG_SETTLE_MS = 1000UL;
static const uint32_t NETWORK_SPACING_MS = 1800UL;

enum BlockType : uint8_t { TWITCH_BLOCK = 0, TEXT_BLOCK = 1 };
struct DisplayBlock {
  BlockType type = TWITCH_BLOCK;
  String value = "";
  uint16_t speed = DEFAULT_SPEED;
  uint16_t pauseMs = DEFAULT_PAUSE;
  uint32_t followers = 0;
  bool hasFollowers = false;
  uint32_t nextFetchAt = 0;
};

DisplayBlock blocks[MAX_BLOCKS];
DisplayBlock staging[MAX_BLOCKS];
uint8_t blockCount = 0;
uint8_t stagingCount = 0;
bool stagingOpen = false;
uint8_t currentBlock = 0;
bool animationStarted = false;

String wifiSsid;
String wifiPassword;
String serialBuffer;
char displayBuffer[400] = "STARTING";
uint32_t bootAt = 0;
uint32_t lastConfigAt = 0;
uint32_t lastNetworkAt = 0;

String normalizeStreamer(String s) {
  s.trim(); s.toLowerCase();
  if (s.startsWith("https://")) s.remove(0,8);
  else if (s.startsWith("http://")) s.remove(0,7);
  if (s.startsWith("www.")) s.remove(0,4);
  if (s.startsWith("m.")) s.remove(0,2);
  if (s.startsWith("twitch.tv/")) s.remove(0,10);
  if (s.startsWith("@")) s.remove(0,1);
  int sep = s.indexOf('/'); if (sep >= 0) s = s.substring(0,sep);
  sep = s.indexOf('?'); if (sep >= 0) s = s.substring(0,sep);
  sep = s.indexOf('#'); if (sep >= 0) s = s.substring(0,sep);
  s.trim();
  if (s.length() < 1 || s.length() > 25) return "";
  for (size_t i=0;i<s.length();++i) {
    char c=s[i];
    if (!((c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='_')) return "";
  }
  return s;
}

String b64Encode(const String& in) {
  unsigned char buf[220] = {0};
  size_t len=0;
  if (in.length() > MAX_CUSTOM_TEXT_BYTES ||
      mbedtls_base64_encode(buf,sizeof(buf)-1,&len,
                            (const unsigned char*)in.c_str(),in.length()) != 0) return "";
  buf[len] = 0;
  return String((char*)buf);
}

bool b64Decode(const String& src, String& result) {
  if (src.length() < 4 || src.length() > 164 || src.length()%4!=0) return false;
  unsigned char buf[MAX_CUSTOM_TEXT_BYTES+1] = {0};
  size_t len=0;
  if (mbedtls_base64_decode(buf,MAX_CUSTOM_TEXT_BYTES,&len,
                            (const unsigned char*)src.c_str(),src.length()) != 0) return false;
  if (len < 1 || len > MAX_CUSTOM_TEXT_BYTES) return false;
  for(size_t i=0;i<len;i++) {
    if (buf[i]==0 || buf[i]=='\n' || buf[i]=='\r' || buf[i]=='\t') return false;
  }
  buf[len]=0;
  result = String((char*)buf);
  result.trim();
  return result.length() > 0;
}

// Standard 5x7 font in MD_Parola is not Unicode. Transliterate Russian
// UTF-8 to a predictable readable form, preserving stored original text.
String transliterateForMatrix(const String& input) {
  static const char* const RU[32] = {
    "A","B","V","G","D","E","ZH","Z","I","Y","K","L","M","N","O","P",
    "R","S","T","U","F","KH","TS","CH","SH","SCH","","Y","","E","YU","YA"
  };
  String out; out.reserve(input.length()*2+12);
  for(size_t i=0;i<input.length();) {
    uint8_t b=(uint8_t)input[i];
    if (b<128) {
      if (b >= 32 && b <= 126) out += (char)toupper(b);
      else out += ' ';
      ++i;
      continue;
    }
    uint32_t cp=0;
    size_t span=1;
    if ((b&0xE0)==0xC0 && i+1<input.length()) {
      cp=((uint32_t)(b&0x1F)<<6)|((uint8_t)input[i+1]&0x3F);span=2;
    } else if((b&0xF0)==0xE0 && i+2<input.length()) {
      cp=((uint32_t)(b&0x0F)<<12)|(((uint8_t)input[i+1]&0x3F)<<6)|((uint8_t)input[i+2]&0x3F);span=3;
    } else if((b&0xF8)==0xF0 && i+3<input.length()) {
      span=4;
    }
    i+=span;
    if(cp>=0x0410&&cp<=0x042F) out+=RU[cp-0x0410];
    else if(cp>=0x0430&&cp<=0x044F) out+=RU[cp-0x0430];
    else if(cp==0x0401||cp==0x0451) out+="YO";
    else if(cp==0x2014||cp==0x2013) out+='-';
    else if(cp==0x2018||cp==0x2019) out+='\'';
    else if(cp==0x201C||cp==0x201D) out+='"';
    else if(cp==0x2026) out+="...";
    else out+='?';
  }
  if(!out.length())out=" ";
  return out;
}

void showText(String content,uint16_t speed=DEFAULT_SPEED,uint16_t pauseMs=DEFAULT_PAUSE) {
  content.toCharArray(displayBuffer,sizeof(displayBuffer));
  matrix.displayClear();
  matrix.displayText(displayBuffer,PA_LEFT,speed,pauseMs,PA_SCROLL_LEFT,PA_SCROLL_LEFT);
}

void showCurrentBlock() {
  if (blockCount==0) {showText("NO BLOCKS");animationStarted=true;return;}
  if (currentBlock>=blockCount) currentBlock=0;
  const DisplayBlock& b=blocks[currentBlock];
  String shown;
  if (b.type==TWITCH_BLOCK) {
    shown = b.value;
    shown.toUpperCase();
    shown += ": ";
    shown += b.hasFollowers?String(b.followers):String("NO DATA");
  } else shown=transliterateForMatrix(b.value);
  shown += "   ";
  showText(shown,b.speed,b.pauseMs);
  animationStarted=true;
}

void animateMatrix() {
  if (matrix.displayAnimate()) {
    if (blockCount) currentBlock=(currentBlock+1)%blockCount;
    showCurrentBlock();
  }
}

void saveBlocks() {
  for(uint8_t i=0;i<blockCount;i++) {
    String n=String(i);
    prefs.putUChar((String("t")+n).c_str(),(uint8_t)blocks[i].type);
    prefs.putString((String("v")+n).c_str(),blocks[i].value);
    prefs.putUShort((String("s")+n).c_str(),blocks[i].speed);
    prefs.putUShort((String("p")+n).c_str(),blocks[i].pauseMs);
  }
  prefs.putUChar("bcount",blockCount); // commit length last
  for(uint8_t i=0;i<blockCount;i++) {
    if(blocks[i].type==TWITCH_BLOCK) {
      prefs.putString("channel",blocks[i].value); // supports legacy v3 tools
      break;
    }
  }
}

void loadBlocks() {
  uint8_t saved=prefs.getUChar("bcount",0);
  if(saved>0 && saved<=MAX_BLOCKS) {
    for(uint8_t i=0;i<saved;i++) {
      String n=String(i);
      uint8_t t=prefs.getUChar((String("t")+n).c_str(),0);
      String v=prefs.getString((String("v")+n).c_str(),"");
      uint16_t speed=prefs.getUShort((String("s")+n).c_str(),DEFAULT_SPEED);
      uint16_t pause=prefs.getUShort((String("p")+n).c_str(),DEFAULT_PAUSE);
      if(speed<35||speed>140)speed=DEFAULT_SPEED;
      if(pause>2500)pause=DEFAULT_PAUSE;
      if(t==0)v=normalizeStreamer(v);
      if(t>1 || v.length()<1 || (t==1 && v.length()>MAX_CUSTOM_TEXT_BYTES)) {
        Serial.println("ERR SAVED PLAYLIST; RESET TO DEFAULT");saved=0;break;
      }
      blocks[i].type=(BlockType)t;
      blocks[i].value=v;
      blocks[i].speed=speed;
      blocks[i].pauseMs=pause;
      blocks[i].hasFollowers=false;
      blocks[i].nextFetchAt=0;
    }
  }
  if(saved==0) {
    blocks[0].type=TWITCH_BLOCK;
    blocks[0].value=normalizeStreamer(prefs.getString("channel","pwgood"));
    if(!blocks[0].value.length()) blocks[0].value="pwgood";
    blocks[0].speed=DEFAULT_SPEED;
    blocks[0].pauseMs=DEFAULT_PAUSE;
    blockCount=1;
    // Migration from v3 is in-memory until user saves a new playlist.
  } else blockCount=saved;
}

void printStatus() {
  String ch="NONE"; String count="N/A";
  for(uint8_t i=0;i<blockCount;i++)if(blocks[i].type==TWITCH_BLOCK) {
    ch=blocks[i].value;
    if(blocks[i].hasFollowers)count=String(blocks[i].followers);
    break;
  }
  Serial.print("STATUS streamer="); Serial.print(ch);
  Serial.print(" wifi="); Serial.print(wifiSsid.length()?wifiSsid:"NOT_SET");
  Serial.print(" connected="); Serial.print(WiFi.status()==WL_CONNECTED?"YES":"NO");
  Serial.print(" count="); Serial.print(count);
  Serial.print(" firmware=5.0 blocks="); Serial.println(blockCount);
}

void printPlaylist() {
  Serial.print("PLAYLIST COUNT ");Serial.println(blockCount);
  for(uint8_t i=0;i<blockCount;i++) {
    Serial.print("PLAYLIST ITEM "); Serial.print(i);
    Serial.print(blocks[i].type==TWITCH_BLOCK?" TWITCH ":" TEXT ");
    Serial.print(blocks[i].speed);Serial.print(' ');Serial.print(blocks[i].pauseMs);
    Serial.print(' ');
    Serial.println(blocks[i].type==TWITCH_BLOCK?blocks[i].value:b64Encode(blocks[i].value));
  }
  Serial.println("PLAYLIST END");
}

bool addStaging(const String& args) {
  if(!stagingOpen){Serial.println("ERR PLAYLIST: BEGIN FIRST");return false;}
  if(stagingCount>=MAX_BLOCKS){Serial.println("ERR PLAYLIST: FULL");return false;}
  // Arguments: TYPE VALUE SPEED PAUSE; VALUE is a login or base64-encoded UTF-8.
  int a=args.indexOf(' ');int b=args.indexOf(' ',a+1);int c=args.indexOf(' ',b+1);
  if(a<=0||b<=a||c<=b){Serial.println("ERR PLAYLIST: FORMAT");return false;}
  String ty=args.substring(0,a);ty.toUpperCase();
  String val=args.substring(a+1,b);
  String speedText=args.substring(b+1,c);
  String pauseText=args.substring(c+1);
  if(speedText.length()<1||pauseText.length()<1||speedText.length()>3||pauseText.length()>4){Serial.println("ERR PLAYLIST: TIMING");return false;}
  for(size_t i=0;i<speedText.length();i++)if(!isDigit(speedText[i])){Serial.println("ERR PLAYLIST: SPEED");return false;}
  for(size_t i=0;i<pauseText.length();i++)if(!isDigit(pauseText[i])){Serial.println("ERR PLAYLIST: PAUSE");return false;}
  long speed=speedText.toInt(), pause=pauseText.toInt();
  if(speed<35||speed>140||pause<0||pause>2500){Serial.println("ERR PLAYLIST: TIMING RANGE");return false;}
  DisplayBlock next;
  if(ty=="TWITCH") {
    next.type=TWITCH_BLOCK;
    next.value=normalizeStreamer(val);
    if(!next.value.length()){Serial.println("ERR PLAYLIST: TWITCH LOGIN");return false;}
  }else if(ty=="TEXT") {
    next.type=TEXT_BLOCK;
    if(!b64Decode(val,next.value)){Serial.println("ERR PLAYLIST: TEXT BASE64");return false;}
  }else {Serial.println("ERR PLAYLIST: UNKNOWN TYPE");return false;}
  next.speed=(uint16_t)speed;
  next.pauseMs=(uint16_t)pause;
  staging[stagingCount++]=next;
  Serial.print("OK PLAYLIST ADD ");Serial.println(stagingCount);
  return true;
}

void handleCommand(String line) {
  line.trim();if(!line.length())return;
  int sp=line.indexOf(' ');
  String cmd=sp<0?line:line.substring(0,sp);
  String arg=sp<0?"":line.substring(sp+1);
  cmd.toUpperCase();

  if(cmd=="PLAYLIST") {
    int pos=arg.indexOf(' ');
    String sub=pos<0?arg:arg.substring(0,pos);
    String rest=pos<0?"":arg.substring(pos+1);
    sub.toUpperCase();
    if(sub=="GET") { printPlaylist(); }
    else if(sub=="BEGIN") {
      stagingOpen=true;stagingCount=0;
      Serial.println("OK PLAYLIST BEGIN");
    }
    else if(sub=="ADD") {addStaging(rest);}
    else if(sub=="CANCEL") {
      stagingOpen=false;stagingCount=0;
      Serial.println("OK PLAYLIST CANCEL");
    }
    else if(sub=="COMMIT") {
      if(!stagingOpen||stagingCount==0){Serial.println("ERR PLAYLIST: EMPTY OR NOT STARTED");return;}
      blockCount=stagingCount;
      for(uint8_t i=0;i<blockCount;i++)blocks[i]=staging[i];
      saveBlocks();
      stagingOpen=false;stagingCount=0;
      currentBlock=0;showCurrentBlock();
      lastConfigAt=millis();lastNetworkAt=millis()-NETWORK_SPACING_MS;
      Serial.print("OK PLAYLIST SAVED ");Serial.println(blockCount);
      printStatus();
    }
    else Serial.println("ERR PLAYLIST: UNKNOWN SUBCOMMAND");
  }
  else if(cmd=="VERSION") Serial.println("VERSION TWITCHLED 5.0 PLAYLIST1");
  else if(cmd=="STREAMER") {
    String ch=normalizeStreamer(arg);
    if(!ch.length()){Serial.println("ERR STREAMER: INVALID");return;}
    uint8_t index=0;
    for(;index<blockCount;index++)if(blocks[index].type==TWITCH_BLOCK)break;
    if(index==blockCount) {
      if(blockCount>=MAX_BLOCKS){Serial.println("ERR STREAMER: PLAYLIST FULL");return;}
      blocks[blockCount++].type=TWITCH_BLOCK;
    }
    blocks[index].value=ch;
    blocks[index].hasFollowers=false;
    blocks[index].nextFetchAt=0;
    saveBlocks();currentBlock=0;showCurrentBlock();
    lastConfigAt=millis();lastNetworkAt=millis()-NETWORK_SPACING_MS;
    Serial.print("OK STREAMER ");Serial.println(ch);
  }
  else if(cmd=="WIFI") {
    int divider=arg.indexOf('|');
    if(divider<1){Serial.println("ERR WIFI: USE WIFI SSID|PASSWORD");return;}
    String s=arg.substring(0,divider),p=arg.substring(divider+1);
    if(s.length()==0||s.length()>32||p.length()>64){Serial.println("ERR WIFI: INVALID LENGTH");return;}
    wifiSsid=s;wifiPassword=p;
    prefs.putString("ssid",wifiSsid);prefs.putString("password",wifiPassword);
    WiFi.disconnect(true);
    for(uint8_t i=0;i<blockCount;i++)blocks[i].nextFetchAt=0;
    lastConfigAt=millis();lastNetworkAt=millis()-NETWORK_SPACING_MS;
    Serial.print("OK WIFI SAVED ssid=");Serial.println(wifiSsid);
  }
  else if(cmd=="STATUS")printStatus();
  else if(cmd=="REFRESH") {
    for(uint8_t i=0;i<blockCount;i++)blocks[i].nextFetchAt=0;
    lastNetworkAt=millis()-NETWORK_SPACING_MS;
    Serial.println("OK REFRESH SCHEDULED");
  }
  else if(cmd=="HELP") {
    Serial.println("Twitch LED Builder v5.0; 115200 / Newline");
    Serial.println("VERSION | STATUS | PLAYLIST GET | PLAYLIST BEGIN");
    Serial.println("PLAYLIST ADD TWITCH pwgood 65 300");
    Serial.println("PLAYLIST ADD TEXT SEVMTE8= 65 300");
    Serial.println("PLAYLIST COMMIT | PLAYLIST CANCEL | REFRESH");
    Serial.println("WIFI MySSID|MyPassword | STREAMER pwgood");
    Serial.println("Text is UTF-8 base64; Cyrillic scrolls transliterated.");
  }
  else Serial.println("ERR UNKNOWN COMMAND. Type HELP");
}

void pollSerial() {
  while(Serial.available()>0) {
    char c=(char)Serial.read();
    if(c=='\r'||c=='\n') {
      if(serialBuffer.length()) {handleCommand(serialBuffer);serialBuffer="";}
    } else if(serialBuffer.length()<300) serialBuffer+=c;
    else {serialBuffer="";Serial.println("ERR LINE TOO LONG");}
  }
}

bool connectWiFi() {
  if(WiFi.status()==WL_CONNECTED)return true;
  if(!wifiSsid.length())return false;
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(),wifiPassword.c_str());
  uint32_t started=millis();
  String startingSsid=wifiSsid;
  while(WiFi.status()!=WL_CONNECTED) {
    animateMatrix();pollSerial();
    if(startingSsid!=wifiSsid)return false;
    if(millis()-started>=WIFI_TIMEOUT_MS) {
      Serial.print("ERR WIFI TIMEOUT status=");Serial.println((int)WiFi.status());
      return false;
    }
    delay(10);
  }
  Serial.print("WIFI OK IP=");Serial.println(WiFi.localIP());
  return true;
}

bool fetchCountFor(const String& name,uint32_t& count) {
  if(!connectWiFi())return false;
  WiFiClientSecure client;
  client.setInsecure(); // Prototype only: certificate validation disabled
  HTTPClient http;
  http.setTimeout(8000);
  String url="https://decapi.me/twitch/followcount/"+name;
  if(!http.begin(client,url))return false;
  http.addHeader("Accept","text/plain");
  http.addHeader("Accept-Encoding","identity");
  http.setUserAgent("ESP32-Twitch-LED-Builder/5.0");
  int code=http.GET();
  if(code!=200) {Serial.print("ERR HTTP ");Serial.println(code);http.end();return false;}
  String body=http.getString();http.end();body.trim();body.replace(",","");
  if(body.length()<1||body.length()>10)return false;
  for(size_t i=0;i<body.length();i++)if(body[i]<'0'||body[i]>'9')return false;
  count=(uint32_t)strtoul(body.c_str(),nullptr,10);
  return true;
}

void maybeUpdateFollowers() {
  uint32_t now=millis();
  if(now-bootAt<BOOT_GRACE_MS || now-lastConfigAt<CONFIG_SETTLE_MS ||
     now-lastNetworkAt<NETWORK_SPACING_MS)return;
  for(uint8_t i=0;i<blockCount;i++) {
    DisplayBlock& b=blocks[i];
    if(b.type!=TWITCH_BLOCK || (int32_t)(now-b.nextFetchAt)<0)continue;
    // Avoid duplicate queries for the same Twitch login in one playlist.
    bool reused=false;
    for(uint8_t j=0;j<blockCount;j++)if(i!=j&&blocks[j].type==TWITCH_BLOCK&&
      blocks[j].value==b.value && blocks[j].hasFollowers) {
        b.followers=blocks[j].followers;b.hasFollowers=true;
        b.nextFetchAt=blocks[j].nextFetchAt;reused=true;break;
    }
    if(reused)continue;
    lastNetworkAt=millis();
    uint32_t count=0;
    bool ok=fetchCountFor(b.value,count);
    uint32_t due=millis()+(ok?FOLLOWER_UPDATE_MS:ERROR_RETRY_MS);
    for(uint8_t j=0;j<blockCount;j++) {
      if(blocks[j].type==TWITCH_BLOCK && blocks[j].value==b.value) {
        if(ok){blocks[j].followers=count;blocks[j].hasFollowers=true;}
        blocks[j].nextFetchAt=due;
      }
    }
    if(ok){Serial.print("FOLLOWERS ");Serial.print(b.value);Serial.print(' ');Serial.println(count);}
    else {Serial.print("ERR FOLLOWERS ");Serial.println(b.value);}
    return; // Only one HTTPS request in each loop iteration
  }
}

void setup() {
  Serial.begin(115200);
  serialBuffer.reserve(310);
  matrix.begin();
  matrix.setIntensity(3);
  matrix.displayClear();
  prefs.begin("twitch-led",false); // Same namespace as v3, preserves Wi-Fi
  wifiSsid=prefs.getString("ssid","");
  wifiPassword=prefs.getString("password","");
  loadBlocks();
  WiFi.mode(WIFI_STA);WiFi.persistent(false);
  currentBlock=0;showCurrentBlock();
  bootAt=millis();lastConfigAt=millis();
  lastNetworkAt=millis()-NETWORK_SPACING_MS;
  Serial.println("Twitch LED Builder v5.0 READY");
  printStatus();
}

void loop() {
  pollSerial();
  animateMatrix();
  maybeUpdateFollowers();
  delay(1);
}