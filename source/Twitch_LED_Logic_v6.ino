/*
  Twitch LED Logic v6.0
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
    PLAYLIST ADD DATE BERLIN 65 300
    PLAYLIST ADD JOIN SPACE 65 0
    PLAYLIST ADD TIME BERLIN 65 300
    PLAYLIST ADD WEEKDAY BERLIN 65 300
    PLAYLIST ADD NICK pwgood 65 300
    PLAYLIST ADD COUNT pwgood 65 300
    PLAYLIST ADD PIXEL <64HEX[.64HEX...] (1..4 frames)> 250 3000
    PLAYLIST COMMIT
    PLAYLIST CANCEL
  Legacy-compatible: STREAMER, WIFI SSID|PASSWORD, STATUS, REFRESH, HELP.

  Wi-Fi credentials, layout and speeds are saved in Preferences/NVS.
  DecAPI is a third-party service, not the official Twitch API; availability
  and exact figures are not guaranteed.

  Text is UTF-8 stored in Preferences. Custom Cyrillic glyphs (CP1251)
  are displayed by MD_Parola without transliteration.
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
#include <time.h>

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

enum BlockType : uint8_t {
  TWITCH_BLOCK=0, TEXT_BLOCK=1, DATE_BLOCK=2, JOIN_BLOCK=3,
  TIME_BLOCK=4, WEEKDAY_BLOCK=5, NICK_BLOCK=6, COUNT_BLOCK=7, PIXEL_BLOCK=8
};
// Date-specific timezone profiles; ESP32 SNTP uses UTC, tzset() calculates local day.
// Europe/Berlin automatically switches CET/CEST; others use fixed UTC offsets.
const char* dateZonePOSIX(const String& zone) {
  if(zone=="BERLIN")return "CET-1CEST,M3.5.0,M10.5.0/3";
  if(zone=="MOSCOW")return "MSK-3";
  if(zone=="VLADIVOSTOK")return "VLAT-10";
  if(zone=="UTC")return "UTC0";
  return nullptr;
}
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
uint8_t currentGroupEnd = 0;
bool animationStarted = false;
bool bootAnnouncement = false;
bool pixelPlaying=false;
uint32_t pixelStartedAt=0;
uint8_t pixelFrame=0;
uint32_t pixelFrameAt=0;
bool ntpStarted = false;
uint32_t lastClockConnectAt = 0;
static const uint32_t CLOCK_CONNECT_RETRY_MS = 60UL * 1000UL;

String wifiSsid;
String wifiPassword;
String serialBuffer;
static const uint8_t SCRIPT_MAX=42;
static const uint8_t SCRIPT_FOLLOW_MAX=8;
String scriptLines[SCRIPT_MAX],scriptStaging[SCRIPT_MAX];
uint8_t scriptCount=0,scriptStageCount=0,scriptPC=0,scriptMode=0,scriptDepth=0;
bool scriptEnabled=false,scriptStageOpen=false;
uint32_t scriptWaitUntil=0,scriptPixelStart=0,scriptPixelFrameAt=0;
uint16_t scriptPixelFrameMs=250,scriptPixelDuration=3000;
uint8_t scriptPixelIndex=0;
String scriptPixelData;
struct ScriptLoop { uint8_t start; uint8_t remaining; } scriptLoops[3];
struct ScriptFollow { String name; uint32_t count=0,nextAt=0; bool valid=false; } scriptFollow[SCRIPT_FOLLOW_MAX];
uint8_t scriptFollowCount=0;
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

// Original Russian / Latin 5x7 font, CP1251, MD_MAX72XX format v2.
// AUTO-GENERATED by tools/build_cyrillic_v52.py. Single-height 8x32 MAX7219.
// The first 7 rows are used. MD_MAX72XX v2 column bit 0 is top row.
const MD_MAX72XX::fontType_t TWITCH_LED_RU_CP1251[] PROGMEM = {
  0x46, 0x02, 0x00, 0x20, 0x00, 0xFF, 0x08, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x00,
  0x00, 0x5F, 0x00, 0x00, 0x05, 0x00, 0x07, 0x00, 0x07, 0x00, 0x05, 0x0A, 0x1F, 0x0A, 0x1F,
  0x0A, 0x05, 0x24, 0x2A, 0x7F, 0x2A, 0x12, 0x05, 0x13, 0x0B, 0x34, 0x32, 0x01, 0x05, 0x36,
  0x49, 0x55, 0x22, 0x50, 0x05, 0x00, 0x00, 0x07, 0x00, 0x00, 0x05, 0x00, 0x1C, 0x22, 0x41,
  0x00, 0x05, 0x00, 0x41, 0x22, 0x1C, 0x00, 0x05, 0x2A, 0x1C, 0x3E, 0x1C, 0x2A, 0x05, 0x08,
  0x08, 0x3E, 0x08, 0x08, 0x05, 0x00, 0x40, 0x30, 0x00, 0x00, 0x05, 0x08, 0x08, 0x08, 0x08,
  0x08, 0x05, 0x00, 0x00, 0x60, 0x00, 0x00, 0x05, 0x60, 0x10, 0x08, 0x04, 0x03, 0x05, 0x3E,
  0x51, 0x4D, 0x43, 0x3E, 0x05, 0x00, 0x42, 0x7F, 0x40, 0x00, 0x05, 0x42, 0x61, 0x51, 0x49,
  0x46, 0x05, 0x41, 0x49, 0x49, 0x49, 0x36, 0x05, 0x18, 0x14, 0x12, 0x7F, 0x10, 0x05, 0x4F,
  0x49, 0x49, 0x49, 0x31, 0x05, 0x3E, 0x49, 0x49, 0x49, 0x30, 0x05, 0x01, 0x71, 0x09, 0x05,
  0x03, 0x05, 0x36, 0x49, 0x49, 0x49, 0x36, 0x05, 0x06, 0x49, 0x49, 0x49, 0x3E, 0x05, 0x00,
  0x00, 0x36, 0x00, 0x00, 0x05, 0x00, 0x40, 0x36, 0x00, 0x00, 0x05, 0x08, 0x14, 0x22, 0x41,
  0x00, 0x05, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x05, 0x00, 0x41, 0x22, 0x14, 0x08, 0x05, 0x02,
  0x01, 0x51, 0x09, 0x06, 0x05, 0x3E, 0x41, 0x5D, 0x55, 0x1E, 0x05, 0x7E, 0x09, 0x09, 0x09,
  0x7E, 0x05, 0x7F, 0x49, 0x49, 0x49, 0x36, 0x05, 0x3E, 0x41, 0x41, 0x41, 0x41, 0x05, 0x7F,
  0x41, 0x41, 0x41, 0x3E, 0x05, 0x7F, 0x49, 0x49, 0x49, 0x41, 0x05, 0x7F, 0x09, 0x09, 0x09,
  0x01, 0x05, 0x3E, 0x41, 0x49, 0x49, 0x79, 0x05, 0x7F, 0x08, 0x08, 0x08, 0x7F, 0x05, 0x41,
  0x41, 0x7F, 0x41, 0x41, 0x05, 0x30, 0x40, 0x41, 0x3F, 0x01, 0x05, 0x7F, 0x08, 0x14, 0x22,
  0x41, 0x05, 0x7F, 0x40, 0x40, 0x40, 0x40, 0x05, 0x7F, 0x02, 0x0C, 0x02, 0x7F, 0x05, 0x7F,
  0x02, 0x04, 0x08, 0x7F, 0x05, 0x3E, 0x41, 0x41, 0x41, 0x3E, 0x05, 0x7F, 0x09, 0x09, 0x09,
  0x06, 0x05, 0x3E, 0x41, 0x51, 0x21, 0x5E, 0x05, 0x7F, 0x09, 0x19, 0x29, 0x46, 0x05, 0x46,
  0x49, 0x49, 0x49, 0x31, 0x05, 0x01, 0x01, 0x7F, 0x01, 0x01, 0x05, 0x3F, 0x40, 0x40, 0x40,
  0x3F, 0x05, 0x1F, 0x20, 0x40, 0x20, 0x1F, 0x05, 0x3F, 0x40, 0x38, 0x40, 0x3F, 0x05, 0x63,
  0x14, 0x08, 0x14, 0x63, 0x05, 0x03, 0x04, 0x78, 0x04, 0x03, 0x05, 0x61, 0x51, 0x49, 0x45,
  0x43, 0x05, 0x00, 0x7F, 0x41, 0x41, 0x00, 0x05, 0x03, 0x04, 0x08, 0x10, 0x60, 0x05, 0x00,
  0x41, 0x41, 0x7F, 0x00, 0x05, 0x04, 0x02, 0x01, 0x02, 0x04, 0x05, 0x40, 0x40, 0x40, 0x40,
  0x40, 0x05, 0x00, 0x01, 0x02, 0x04, 0x00, 0x05, 0x30, 0x4A, 0x4A, 0x2A, 0x7C, 0x05, 0x7F,
  0x44, 0x44, 0x44, 0x38, 0x05, 0x3C, 0x42, 0x42, 0x42, 0x42, 0x05, 0x38, 0x44, 0x44, 0x44,
  0x7F, 0x05, 0x3C, 0x4A, 0x4A, 0x4A, 0x2C, 0x05, 0x08, 0x7E, 0x09, 0x01, 0x02, 0x05, 0x24,
  0x4A, 0x4A, 0x4A, 0x3E, 0x05, 0x7F, 0x04, 0x04, 0x04, 0x78, 0x05, 0x00, 0x44, 0x7D, 0x40,
  0x00, 0x05, 0x20, 0x40, 0x44, 0x3D, 0x00, 0x05, 0x7F, 0x08, 0x08, 0x14, 0x62, 0x05, 0x00,
  0x41, 0x7F, 0x40, 0x00, 0x05, 0x7E, 0x02, 0x7C, 0x02, 0x7C, 0x05, 0x7E, 0x02, 0x02, 0x02,
  0x7C, 0x05, 0x3C, 0x42, 0x42, 0x42, 0x3C, 0x05, 0x7E, 0x0A, 0x0A, 0x0A, 0x04, 0x05, 0x04,
  0x0A, 0x0A, 0x0A, 0x7E, 0x05, 0x7E, 0x04, 0x02, 0x02, 0x04, 0x05, 0x44, 0x4A, 0x4A, 0x4A,
  0x32, 0x05, 0x04, 0x3F, 0x44, 0x40, 0x20, 0x05, 0x3E, 0x40, 0x40, 0x20, 0x7E, 0x05, 0x1E,
  0x20, 0x40, 0x20, 0x1E, 0x05, 0x3E, 0x40, 0x3E, 0x40, 0x3E, 0x05, 0x62, 0x14, 0x08, 0x14,
  0x62, 0x05, 0x26, 0x48, 0x48, 0x48, 0x3E, 0x05, 0x62, 0x52, 0x4A, 0x46, 0x42, 0x05, 0x00,
  0x08, 0x36, 0x41, 0x00, 0x05, 0x00, 0x00, 0x7F, 0x00, 0x00, 0x05, 0x00, 0x41, 0x36, 0x08,
  0x00, 0x05, 0x08, 0x04, 0x08, 0x08, 0x04, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00,
  0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03,
  0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00,
  0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03,
  0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00,
  0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x05, 0x7C, 0x55, 0x54, 0x55, 0x44, 0x03, 0x00, 0x00,
  0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03,
  0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x05, 0x38, 0x55,
  0x54, 0x55, 0x18, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00,
  0x00, 0x05, 0x7E, 0x09, 0x09, 0x09, 0x7E, 0x05, 0x7F, 0x49, 0x49, 0x49, 0x31, 0x05, 0x7F,
  0x49, 0x49, 0x49, 0x36, 0x05, 0x7F, 0x01, 0x01, 0x01, 0x01, 0x05, 0x70, 0x1F, 0x11, 0x1F,
  0x70, 0x05, 0x7F, 0x49, 0x49, 0x49, 0x41, 0x07, 0x63, 0x14, 0x7F, 0x1C, 0x7F, 0x14, 0x63,
  0x05, 0x41, 0x49, 0x49, 0x49, 0x36, 0x05, 0x7F, 0x10, 0x0C, 0x02, 0x7F, 0x05, 0x7C, 0x21,
  0x12, 0x09, 0x7C, 0x05, 0x7F, 0x08, 0x14, 0x22, 0x41, 0x05, 0x60, 0x1E, 0x01, 0x01, 0x7F,
  0x05, 0x7F, 0x02, 0x0C, 0x02, 0x7F, 0x05, 0x7F, 0x08, 0x08, 0x08, 0x7F, 0x05, 0x3E, 0x41,
  0x41, 0x41, 0x3E, 0x05, 0x7F, 0x01, 0x01, 0x01, 0x7F, 0x05, 0x7F, 0x09, 0x09, 0x09, 0x06,
  0x05, 0x3E, 0x41, 0x41, 0x41, 0x41, 0x05, 0x01, 0x01, 0x7F, 0x01, 0x01, 0x05, 0x43, 0x24,
  0x18, 0x04, 0x03, 0x05, 0x1C, 0x22, 0x7F, 0x22, 0x1C, 0x05, 0x63, 0x14, 0x08, 0x14, 0x63,
  0x06, 0x3F, 0x20, 0x20, 0x20, 0x3F, 0x60, 0x05, 0x07, 0x08, 0x08, 0x08, 0x7F, 0x05, 0x7F,
  0x40, 0x7F, 0x40, 0x7F, 0x06, 0x3F, 0x20, 0x3F, 0x20, 0x3F, 0x60, 0x05, 0x01, 0x7F, 0x48,
  0x48, 0x30, 0x07, 0x7F, 0x48, 0x48, 0x30, 0x7F, 0x00, 0x7F, 0x05, 0x7F, 0x48, 0x48, 0x48,
  0x30, 0x05, 0x41, 0x49, 0x49, 0x49, 0x3E, 0x07, 0x7F, 0x08, 0x3E, 0x41, 0x41, 0x3E, 0x00,
  0x05, 0x46, 0x29, 0x19, 0x09, 0x7F, 0x05, 0x30, 0x4A, 0x4A, 0x2A, 0x7C, 0x05, 0x3C, 0x4A,
  0x49, 0x49, 0x31, 0x05, 0x7E, 0x4A, 0x4A, 0x4A, 0x34, 0x05, 0x7E, 0x02, 0x02, 0x02, 0x02,
  0x05, 0x70, 0x1E, 0x12, 0x1E, 0x70, 0x05, 0x3C, 0x4A, 0x4A, 0x4A, 0x2C, 0x07, 0x62, 0x14,
  0x7E, 0x1C, 0x7E, 0x14, 0x62, 0x05, 0x42, 0x4A, 0x4A, 0x4A, 0x34, 0x05, 0x7E, 0x10, 0x08,
  0x04, 0x7E, 0x05, 0x7C, 0x21, 0x12, 0x09, 0x7C, 0x05, 0x7E, 0x08, 0x08, 0x14, 0x62, 0x05,
  0x60, 0x1C, 0x02, 0x02, 0x7E, 0x05, 0x7E, 0x04, 0x18, 0x04, 0x7E, 0x05, 0x7E, 0x08, 0x08,
  0x08, 0x7E, 0x05, 0x3C, 0x42, 0x42, 0x42, 0x3C, 0x05, 0x7E, 0x02, 0x02, 0x02, 0x7E, 0x05,
  0x7E, 0x0A, 0x0A, 0x0A, 0x04, 0x05, 0x3C, 0x42, 0x42, 0x42, 0x42, 0x05, 0x02, 0x02, 0x7E,
  0x02, 0x02, 0x05, 0x46, 0x48, 0x48, 0x48, 0x3E, 0x05, 0x18, 0x24, 0x7E, 0x24, 0x18, 0x05,
  0x62, 0x14, 0x08, 0x14, 0x62, 0x06, 0x3E, 0x20, 0x20, 0x20, 0x3E, 0x60, 0x05, 0x06, 0x08,
  0x08, 0x08, 0x7E, 0x05, 0x7E, 0x40, 0x7E, 0x40, 0x7E, 0x06, 0x3E, 0x20, 0x3E, 0x20, 0x3E,
  0x60, 0x05, 0x02, 0x7E, 0x48, 0x48, 0x30, 0x07, 0x7E, 0x48, 0x48, 0x30, 0x7E, 0x00, 0x7E,
  0x05, 0x7E, 0x48, 0x48, 0x48, 0x30, 0x05, 0x42, 0x4A, 0x4A, 0x4A, 0x3C, 0x07, 0x7E, 0x08,
  0x3C, 0x42, 0x42, 0x3C, 0x00, 0x05, 0x44, 0x2A, 0x1A, 0x0A, 0x7E,
};

// Convert stored UTF-8 into single-byte CP1251 for the original font.
// Russian uppercase, lowercase, Yo/yo are preserved as real Cyrillic glyphs.
// Invalid/unsupported Unicode -> '?'; common punctuation becomes ASCII.
String encodeForMatrix(const String& input) {
  String out;
  out.reserve(input.length()+1);
  for (size_t i=0; i<input.length();) {
    uint8_t a=(uint8_t)input[i++];
    uint32_t cp=0;
    if (a<0x80) { cp=a; }
    else {
      uint8_t continuation=0;
      uint32_t minCp=0;
      if ((a & 0xE0)==0xC0) { continuation=1; cp=a & 0x1F; minCp=0x80; }
      else if ((a & 0xF0)==0xE0) { continuation=2; cp=a & 0x0F; minCp=0x800; }
      else if ((a & 0xF8)==0xF0) { continuation=3; cp=a & 0x07; minCp=0x10000; }
      else { out+='?'; continue; }
      if (i+continuation>input.length()) { out+='?'; break; }
      bool valid=true;
      for (uint8_t j=0; j<continuation; ++j) {
        uint8_t b=(uint8_t)input[i+j];
        if ((b & 0xC0)!=0x80) { valid=false; break; }
        cp=(cp<<6)|(b & 0x3F);
      }
      if (!valid || cp<minCp || cp>0x10FFFF || (cp>=0xD800 && cp<=0xDFFF)) {
        out+='?'; continue;
      }
      i+=continuation;
    }
    if (cp>=32 && cp<=126) out+=(char)cp;
    else if (cp>=0x0410 && cp<=0x044F) out+=(char)(0xC0+cp-0x0410);
    else if (cp==0x0401) out+=(char)0xA8;
    else if (cp==0x0451) out+=(char)0xB8;
    else if (cp==0x00A0 || cp=='\n' || cp=='\r' || cp=='\t') out+=' ';
    else if (cp==0x2013 || cp==0x2014 || cp==0x2212) out+='-';
    else if (cp==0x2018 || cp==0x2019 || cp==0x02BC) out+='\'';
    else if (cp==0x201C || cp==0x201D || cp==0x00AB || cp==0x00BB) out+='"';
    else if (cp==0x2026) out+="...";
    else if (cp==0x2116) out+="N";
    else out+='?';
  }
  if (!out.length()) out=' ';
  return out;
}

void showText(String content,uint16_t speed=DEFAULT_SPEED,uint16_t pauseMs=DEFAULT_PAUSE) {
  pixelPlaying=false;
  matrix.displaySuspend(false);
  encodeForMatrix(content).toCharArray(displayBuffer,sizeof(displayBuffer));
  matrix.displayClear();
  matrix.displayText(displayBuffer,PA_LEFT,speed,pauseMs,PA_SCROLL_LEFT,PA_SCROLL_LEFT);
}

// Native timezone-aware date/time: time is only shown once NTP sync succeeds.
String formattedClock(const String& zone,uint8_t mode) {
  time_t now=time(nullptr);
  if(now<1704067200)return mode==0?"--.--.----":mode==1?"--:--":"--";
  const char* rule=dateZonePOSIX(zone);
  if(!rule)return "--";
  setenv("TZ",rule,1);tzset();
  struct tm localTime;
  if(!localtime_r(&now,&localTime))return "--";
  if(mode==2) {
    static const char* names[]={
      "ВОСКРЕСЕНЬЕ","ПОНЕДЕЛЬНИК","ВТОРНИК","СРЕДА",
      "ЧЕТВЕРГ","ПЯТНИЦА","СУББОТА"
    };
    return String(names[localTime.tm_wday]);
  }
  char out[16];
  if(!strftime(out,sizeof(out),mode==1?"%H:%M":"%d.%m.%Y",&localTime))return "--";
  return String(out);
}
String formattedDate(const String& zone){return formattedClock(zone,0);}

// Each frame: 32 column bytes (64 hex characters), bit y means LED row y.
// Frames separated with '.'; maximum four frames per PIXEL block.
uint8_t pixelHex(char c) {
  if(c>='0'&&c<='9')return (uint8_t)(c-'0');
  if(c>='A'&&c<='F')return (uint8_t)(c-'A'+10);
  return 255;
}
bool validPixels(const String& data) {
  if(data.length()<64||data.length()>259)return false;
  uint16_t segment=0;
  uint8_t frames=1;
  for(size_t i=0;i<data.length();i++) {
    if(data[i]=='.') {
      if(segment!=64||frames>=4)return false;
      segment=0;frames++;
    }else{
      if(pixelHex(data[i])==255||++segment>64)return false;
    }
  }
  return segment==64;
}
uint8_t frameCount(const String& data){
  uint8_t n=1;for(size_t i=0;i<data.length();i++)if(data[i]=='.')n++;
  return n;
}
void drawPixelFrame(uint8_t blockIndex,uint8_t frameIndex) {
  const String& data=blocks[blockIndex].value;
  const uint16_t start=(uint16_t)frameIndex*65;
  MD_MAX72XX* gfx=matrix.getGraphicObject();
  gfx->update(MD_MAX72XX::OFF);
  for(uint8_t col=0;col<32;col++) {
    const uint16_t p=start+(uint16_t)col*2;
    const uint8_t bits=(pixelHex(data[p])<<4)|pixelHex(data[p+1]);
    gfx->setColumn(31-col,bits); // MD_MAX72XX col 0 is rightmost; editor x=0 is leftmost
  }
  gfx->update();
  gfx->update(MD_MAX72XX::ON);
}

// JOIN is a marker separating adjacent content blocks; one merged scroll.
// SPACE adds a single blank, NONE concatenates without adding a character.
String displayPart(uint8_t index) {
  const DisplayBlock& b=blocks[index];
  if(b.type==TWITCH_BLOCK) {
    String shown=b.value;shown.toUpperCase();shown+=": ";
    shown+=b.hasFollowers?String(b.followers):String("NO DATA");
    return shown;
  }
  if(b.type==NICK_BLOCK){String shown=b.value;shown.toUpperCase();return shown;}
  if(b.type==COUNT_BLOCK)return b.hasFollowers?String(b.followers):String("NO DATA");
  if(b.type==DATE_BLOCK)return formattedDate(b.value);
  if(b.type==TIME_BLOCK)return formattedClock(b.value,1);
  if(b.type==WEEKDAY_BLOCK)return formattedClock(b.value,2);
  return b.value;
}

// JOIN may connect any text-renderable item. Pixel blocks stand alone.
bool validLayout(uint8_t count,bool fromStaging) {
  const DisplayBlock* list=fromStaging?staging:blocks;
  if(count==0||count>MAX_BLOCKS)return false;
  size_t groupBytes=0;
  for(uint8_t i=0;i<count;i++){
    const DisplayBlock& b=list[i];
    if(b.type==JOIN_BLOCK){
      if(i==0||i+1>=count||list[i-1].type==JOIN_BLOCK||
         list[i+1].type==JOIN_BLOCK||list[i-1].type==PIXEL_BLOCK||
         list[i+1].type==PIXEL_BLOCK||
         (b.value!="SPACE"&&b.value!="NONE"))return false;
      groupBytes+=b.value=="SPACE"?1:0;
    }else{
      if(i==0||list[i-1].type!=JOIN_BLOCK)groupBytes=0;
      switch(b.type) {
        case TEXT_BLOCK:groupBytes+=b.value.length();break;
        case TWITCH_BLOCK:groupBytes+=45;break;
        case NICK_BLOCK:groupBytes+=25;break;
        case COUNT_BLOCK:groupBytes+=12;break;
        case DATE_BLOCK:groupBytes+=10;break;
        case TIME_BLOCK:groupBytes+=5;break;
        case WEEKDAY_BLOCK:groupBytes+=25;break;
        case PIXEL_BLOCK:
          if(!validPixels(b.value)||b.speed<100||b.speed>900||
             b.pauseMs<500||b.pauseMs>9000)return false;
          groupBytes=0;
          break;
        default:return false;
      }
    }
    if(groupBytes>375)return false;
  }
  return true;
}

void showCurrentBlock() {
  if(blockCount==0){showText("NO BLOCKS");animationStarted=true;return;}
  if(currentBlock>=blockCount)currentBlock=0;
  if(blocks[currentBlock].type==JOIN_BLOCK)currentBlock=0;
  const uint8_t first=currentBlock;
  if(blocks[first].type==PIXEL_BLOCK){
    matrix.displaySuspend(true);
    pixelPlaying=true;
    pixelStartedAt=millis();
    pixelFrameAt=pixelStartedAt;
    pixelFrame=0;
    currentGroupEnd=first;
    drawPixelFrame(first,0);
    return;
  }
  uint8_t cursor=first;
  String shown=displayPart(first);
  while(cursor+2<blockCount&&blocks[cursor+1].type==JOIN_BLOCK&&
        blocks[cursor+2].type!=JOIN_BLOCK&&blocks[cursor+2].type!=PIXEL_BLOCK){
    if(blocks[cursor+1].value=="SPACE")shown+=' ';
    shown+=displayPart(cursor+2);
    cursor+=2;
  }
  currentGroupEnd=cursor;
  shown+="   ";
  showText(shown,blocks[first].speed,blocks[first].pauseMs);
  animationStarted=true;
}

void animateMatrix(){
  if(pixelPlaying){
    const DisplayBlock& b=blocks[currentBlock];
    const uint32_t now=millis();
    if(now-pixelStartedAt>=b.pauseMs){
      pixelPlaying=false;
      matrix.displaySuspend(false);
      currentBlock=(currentGroupEnd+1)%blockCount;
      showCurrentBlock();
    }else if(now-pixelFrameAt>=b.speed){
      pixelFrame=(pixelFrame+1)%frameCount(b.value);
      pixelFrameAt=now;
      drawPixelFrame(currentBlock,pixelFrame);
    }
    return;
  }
  if(matrix.displayAnimate()){
    if(bootAnnouncement){
      bootAnnouncement=false;
      showCurrentBlock();
    }else{
      if(blockCount)currentBlock=(currentGroupEnd+1)%blockCount;
      showCurrentBlock();
    }
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
    if(blocks[i].type==TWITCH_BLOCK||blocks[i].type==COUNT_BLOCK||blocks[i].type==NICK_BLOCK) {
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
      if(t==PIXEL_BLOCK){
        if(speed<100||speed>900)speed=250;
        if(pause<500||pause>9000)pause=3000;
      }else{
        if(speed<35||speed>140)speed=DEFAULT_SPEED;
        if(pause>2500)pause=DEFAULT_PAUSE;
      }
      if(t==TWITCH_BLOCK||t==NICK_BLOCK||t==COUNT_BLOCK)v=normalizeStreamer(v);
      if(t>PIXEL_BLOCK || v.length()<1 ||
         (t==JOIN_BLOCK && v!="SPACE" && v!="NONE") ||
         ((t==DATE_BLOCK||t==TIME_BLOCK||t==WEEKDAY_BLOCK)&&!dateZonePOSIX(v))||
         (t==TEXT_BLOCK && v.length()>MAX_CUSTOM_TEXT_BYTES)||
         (t==PIXEL_BLOCK && !validPixels(v))) {
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
  if(saved>0 && !validLayout(saved,false)) {
    Serial.println("ERR SAVED PLAYLIST: JOIN OR SIZE; RESET TO DEFAULT");
    saved=0;
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
  for(uint8_t i=0;i<blockCount;i++)if(blocks[i].type==TWITCH_BLOCK||
        blocks[i].type==COUNT_BLOCK||blocks[i].type==NICK_BLOCK) {
    ch=blocks[i].value;
    if(blocks[i].hasFollowers)count=String(blocks[i].followers);
    break;
  }
  Serial.print("STATUS streamer="); Serial.print(ch);
  Serial.print(" wifi="); Serial.print(wifiSsid.length()?wifiSsid:"NOT_SET");
  Serial.print(" connected="); Serial.print(WiFi.status()==WL_CONNECTED?"YES":"NO");
  Serial.print(" count="); Serial.print(count);
  Serial.print(" firmware=6.0 blocks=");Serial.print(blockCount);
  Serial.print(" clock=");Serial.println(time(nullptr)>1704067200?"SYNCED":"WAITING");
}

void printPlaylist() {
  Serial.print("PLAYLIST COUNT ");Serial.println(blockCount);
  for(uint8_t i=0;i<blockCount;i++) {
    Serial.print("PLAYLIST ITEM "); Serial.print(i);
    const char* names[]={"TWITCH","TEXT","DATE","JOIN","TIME","WEEKDAY","NICK","COUNT","PIXEL"};
    Serial.print(' ');Serial.print(names[blocks[i].type]);Serial.print(' ');
    Serial.print(blocks[i].speed);Serial.print(' ');Serial.print(blocks[i].pauseMs);
    Serial.print(' ');
    Serial.println(blocks[i].type==TEXT_BLOCK?b64Encode(blocks[i].value):blocks[i].value);
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
  if(ty=="PIXEL"){
    if(speed<100||speed>900||pause<500||pause>9000){Serial.println("ERR PLAYLIST: PIXEL TIMING");return false;}
  }else if(speed<35||speed>140||pause<0||pause>2500){
    Serial.println("ERR PLAYLIST: TIMING RANGE");return false;
  }
  DisplayBlock next;
  if(ty=="TWITCH") {
    next.type=TWITCH_BLOCK;
    next.value=normalizeStreamer(val);
    if(!next.value.length()){Serial.println("ERR PLAYLIST: TWITCH LOGIN");return false;}
  }else if(ty=="TEXT") {
    next.type=TEXT_BLOCK;
    if(!b64Decode(val,next.value)){Serial.println("ERR PLAYLIST: TEXT BASE64");return false;}
  }else if(ty=="DATE") {
    next.type=DATE_BLOCK;
    next.value=val;
    if(!dateZonePOSIX(next.value)){Serial.println("ERR PLAYLIST: DATE TZ");return false;}
  }else if(ty=="JOIN") {
    next.type=JOIN_BLOCK;next.value=val;
    if(val!="SPACE"&&val!="NONE"){Serial.println("ERR PLAYLIST: JOIN SEPARATOR");return false;}
  }else if(ty=="NICK"||ty=="COUNT"){
    next.type=ty=="NICK"?NICK_BLOCK:COUNT_BLOCK;
    next.value=normalizeStreamer(val);
    if(!next.value.length()){Serial.println("ERR PLAYLIST: TWITCH LOGIN");return false;}
  }else if(ty=="TIME"||ty=="WEEKDAY"){
    next.type=ty=="TIME"?TIME_BLOCK:WEEKDAY_BLOCK;next.value=val;
    if(!dateZonePOSIX(val)){Serial.println("ERR PLAYLIST: TIME ZONE");return false;}
  }else if(ty=="PIXEL"){
    next.type=PIXEL_BLOCK;next.value=val;
    if(!validPixels(val)){Serial.println("ERR PLAYLIST: BAD PIXEL DATA");return false;}
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
      if(!validLayout(stagingCount,true)){
        Serial.println("ERR PLAYLIST: JOIN BETWEEN BLOCKS ONLY; GROUP MAX 375 BYTES");
        return; // preserve old saved playlist on error
      }
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
  else if(cmd=="SCRIPT"){handleScriptCommand(arg);return;}
  else if(cmd=="VERSION") Serial.println("VERSION TWITCHLED 6.0 SCRIPT1 PLAYLIST4 DATE1 CYRILLIC1 JOIN1 CLOCK1 TWITCHPARTS1 PIXEL1");
  else if(cmd=="STREAMER") {
    String ch=normalizeStreamer(arg);
    if(!ch.length()){Serial.println("ERR STREAMER: INVALID");return;}
    uint8_t index=0;
    for(;index<blockCount;index++)if(blocks[index].type==TWITCH_BLOCK||blocks[index].type==NICK_BLOCK||
       blocks[index].type==COUNT_BLOCK)break;
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
  else if(cmd=="CLOCK") {
    Serial.print("CLOCK synced=");Serial.print(time(nullptr)>1704067200?"YES":"NO");
    Serial.print(" BERLIN=");Serial.print(formattedDate("BERLIN"));
    Serial.print(" MOSCOW=");Serial.print(formattedDate("MOSCOW"));
    Serial.print(" VLADIVOSTOK=");Serial.println(formattedDate("VLADIVOSTOK"));
  }
  else if(cmd=="STATUS")printStatus();
  else if(cmd=="REFRESH") {
    for(uint8_t i=0;i<blockCount;i++)blocks[i].nextFetchAt=0;
    lastNetworkAt=millis()-NETWORK_SPACING_MS;
    Serial.println("OK REFRESH SCHEDULED");
  }
  else if(cmd=="HELP") {
    Serial.println("Twitch LED Builder v5.5; 115200 / Newline");
    Serial.println("VERSION | STATUS | PLAYLIST GET | PLAYLIST BEGIN");
    Serial.println("PLAYLIST ADD TWITCH pwgood 65 300");
    Serial.println("PLAYLIST ADD TEXT SEVMTE8= 65 300");
    Serial.println("PLAYLIST ADD DATE BERLIN 65 300");
    Serial.println("PLAYLIST ADD JOIN SPACE 65 0 (or JOIN NONE)");
    Serial.println("PLAYLIST ADD TIME BERLIN 65 300");
    Serial.println("PLAYLIST ADD WEEKDAY BERLIN 65 300");
    Serial.println("PLAYLIST ADD NICK pwgood 65 300");
    Serial.println("PLAYLIST ADD COUNT pwgood 65 300");
    Serial.println("PLAYLIST ADD PIXEL <64HEX[.64HEX...] (1..4)> 250 3000");
    Serial.println("JOIN between content blocks = one continuous scroll.");
    Serial.println("CLOCK | DATE: DD.MM.YYYY via NTP; timezone per block");
    Serial.println("PLAYLIST COMMIT | PLAYLIST CANCEL | REFRESH");
    Serial.println("WIFI MySSID|MyPassword | STREAMER pwgood");
    Serial.println("Text is UTF-8 base64; Russian Cyrillic displays as real pixels.");
  }
  else Serial.println("ERR UNKNOWN COMMAND. Type HELP");
}

void pollSerial() {
  while(Serial.available()>0) {
    char c=(char)Serial.read();
    if(c=='\r'||c=='\n') {
      if(serialBuffer.length()) {handleCommand(serialBuffer);serialBuffer="";}
    } else if(serialBuffer.length()<640) serialBuffer+=c;
    else {serialBuffer="";Serial.println("ERR LINE TOO LONG");}
  }
}

bool connectWiFi() {
  if(WiFi.status()==WL_CONNECTED){
    if(!ntpStarted){
      configTime(0,0,"pool.ntp.org","time.cloudflare.com");
      ntpStarted=true;
      Serial.println("CLOCK NTP STARTED");
    }
    return true;
  }
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
  if(!ntpStarted){
    configTime(0,0,"pool.ntp.org","time.cloudflare.com");
    ntpStarted=true;
    Serial.println("CLOCK NTP STARTED");
  }
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
  http.setUserAgent("ESP32-Twitch-LED-Logic/6.0");
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
    if((b.type!=TWITCH_BLOCK&&b.type!=COUNT_BLOCK)||
       (int32_t)(now-b.nextFetchAt)<0)continue;
    // Avoid duplicate queries for the same Twitch login in one playlist.
    bool reused=false;
    for(uint8_t j=0;j<blockCount;j++)if(i!=j&&(blocks[j].type==TWITCH_BLOCK||blocks[j].type==COUNT_BLOCK)&&
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
      if((blocks[j].type==TWITCH_BLOCK||blocks[j].type==COUNT_BLOCK) && blocks[j].value==b.value) {
        if(ok){blocks[j].followers=count;blocks[j].hasFollowers=true;}
        blocks[j].nextFetchAt=due;
      }
    }
    if(ok){Serial.print("FOLLOWERS ");Serial.print(b.value);Serial.print(' ');Serial.println(count);}
    else {Serial.print("ERR FOLLOWERS ");Serial.println(b.value);}
    return; // Only one HTTPS request in each loop iteration
  }
}

void maybeConnectClock() {
  bool hasDate=false;
  for(uint8_t i=0;i<blockCount;i++)if(blocks[i].type==DATE_BLOCK||
      blocks[i].type==TIME_BLOCK||blocks[i].type==WEEKDAY_BLOCK){hasDate=true;break;}
  if(!hasDate||ntpStarted||!wifiSsid.length())return;
  if(millis()-lastClockConnectAt<CLOCK_CONNECT_RETRY_MS)return;
  lastClockConnectAt=millis();
  connectWiFi(); // NTP starts on successful Wi-Fi, no fabricated dates when offline
}


// ----------------------------- Logic v6 SCRIPT1 -----------------------------
// This is a separate non-blocking bytecode interpreter. v5 playlists, Wi-Fi,
// NVS and the classic firmware updater's partition layout are untouched.
// Each command is persisted as an NVS string, with count written LAST.
// On incomplete storage / invalid program, the legacy playlist is recovered.

String scriptToken(const String& src,uint8_t which){
  int start=0;
  for(uint8_t i=0;i<which;i++){
    int sp=src.indexOf(' ',start);
    if(sp<0)return "";
    start=sp+1;
  }
  int end=src.indexOf(' ',start);
  return end<0?src.substring(start):src.substring(start,end);
}
bool scriptNumber(const String& s,uint32_t minV,uint32_t maxV){
  if(s.isEmpty()||s.length()>10)return false;
  for(size_t i=0;i<s.length();i++)if(s[i]<'0'||s[i]>'9')return false;
  uint64_t n=0;for(size_t i=0;i<s.length();i++)n=n*10+(s[i]-'0');
  return n>=minV&&n<=maxV;
}
bool scriptSpeedPause(const String& s,uint8_t pos){
  return scriptNumber(scriptToken(s,pos),35,140)&&scriptNumber(scriptToken(s,pos+1),0,2500);
}
bool scriptValidLine(const String& s){
  if(s.length()<2||s.length()>450)return false;
  String kind=scriptToken(s,0);
  if(kind=="TEXT"){
    String v;
    return b64Decode(scriptToken(s,1),v)&&v.length()&&
      scriptSpeedPause(s,2)&&scriptToken(s,4)=="";
  }
  if(kind=="TWITCH"){
    const String v=scriptToken(s,1),format=scriptToken(s,2);
    return normalizeStreamer(v)==v&&(format=="FULL"||format=="COUNT")&&
      scriptSpeedPause(s,3)&&scriptToken(s,5)=="";
  }
  if(kind=="CLOCK"){
    const String z=scriptToken(s,1),m=scriptToken(s,2);
    return dateZonePOSIX(z)&&(m=="TIME"||m=="DATE"||m=="WEEKDAY")&&
      scriptSpeedPause(s,3)&&scriptToken(s,5)=="";
  }
  if(kind=="PIXEL")return validPixels(scriptToken(s,1))&&
    scriptNumber(scriptToken(s,2),100,900)&&
    scriptNumber(scriptToken(s,3),500,9000)&&scriptToken(s,4)=="";
  if(kind=="WAIT")return scriptNumber(scriptToken(s,1),100,30000)&&scriptToken(s,2)=="";
  if(kind=="REPEAT")return scriptNumber(scriptToken(s,1),1,10)&&scriptToken(s,2)=="";
  if(kind=="ENDREPEAT"||kind=="ELSE"||kind=="ENDIF")return scriptToken(s,1)=="";
  if(kind=="IF"){
    const String t=scriptToken(s,1);
    if(t=="WIFI")return scriptToken(s,2)=="";
    if(t=="FOLLOWERS")return normalizeStreamer(scriptToken(s,2))==scriptToken(s,2)&&
      scriptNumber(scriptToken(s,3),0,100000000)&&scriptToken(s,4)=="";
    if(t=="HOUR")return dateZonePOSIX(scriptToken(s,2))&&
      scriptNumber(scriptToken(s,3),0,23)&&scriptToken(s,4)=="";
  }
  return false;
}
bool scriptValidStructure(uint8_t count,bool staged){
  if(count==0||count>SCRIPT_MAX)return false;
  uint8_t depth=0,stack[3]={0,0,0};
  bool seenElse[3]={false,false,false};
  for(uint8_t i=0;i<count;i++){
    const String& line=staged?scriptStaging[i]:scriptLines[i];
    if(!scriptValidLine(line))return false;
    String kind=scriptToken(line,0);
    if(kind=="IF"||kind=="REPEAT"){
      if(depth>=3)return false;
      stack[depth]=(kind=="IF")?1:2;
      seenElse[depth]=false;
      depth++;
    }else if(kind=="ELSE"){
      if(depth==0||stack[depth-1]!=1||seenElse[depth-1])return false;
      seenElse[depth-1]=true;
    }else if(kind=="ENDIF"){
      if(depth==0||stack[depth-1]!=1||!seenElse[depth-1])return false;
      depth--;
    }else if(kind=="ENDREPEAT"){
      if(depth==0||stack[depth-1]!=2)return false;
      depth--;
    }
  }
  return depth==0;
}
void scriptResetRunner(){
  scriptPC=0;scriptMode=0;scriptDepth=0;scriptPixelIndex=0;
  matrix.displaySuspend(false);
  matrix.displayClear();
}
void scriptRegisterFollower(const String& raw){
  String v=normalizeStreamer(raw);
  if(v.isEmpty())return;
  for(uint8_t i=0;i<scriptFollowCount;i++)if(scriptFollow[i].name==v)return;
  if(scriptFollowCount>=SCRIPT_FOLLOW_MAX)return;
  scriptFollow[scriptFollowCount].name=v;
  scriptFollow[scriptFollowCount].valid=false;
  scriptFollow[scriptFollowCount].nextAt=0;
  scriptFollowCount++;
}
void scriptRegisterTemplateFollowers(const String& src){
  int start=0;
  while(start<(int)src.length()){
    int at=src.indexOf("{followers:",start);
    if(at<0)break;
    int end=src.indexOf('}',at+11);
    if(end<0)break;
    scriptRegisterFollower(src.substring(at+11,end));
    start=end+1;
  }
}
void scriptCollectFollowers(){
  scriptFollowCount=0;
  for(uint8_t i=0;i<scriptCount;i++){
    String kind=scriptToken(scriptLines[i],0);
    if(kind=="TWITCH")scriptRegisterFollower(scriptToken(scriptLines[i],1));
    else if(kind=="IF"&&scriptToken(scriptLines[i],1)=="FOLLOWERS")
      scriptRegisterFollower(scriptToken(scriptLines[i],2));
    else if(kind=="TEXT"){
      String decoded;if(b64Decode(scriptToken(scriptLines[i],1),decoded))
        scriptRegisterTemplateFollowers(decoded);
    }
  }
}
bool scriptCachedCount(const String& login,uint32_t& value){
  for(uint8_t i=0;i<scriptFollowCount;i++)if(scriptFollow[i].name==login){
    if(!scriptFollow[i].valid)return false;
    value=scriptFollow[i].count;return true;
  }
  return false;
}
void loadScript(){
  scriptCount=prefs.getUChar("scnt",0);
  scriptEnabled=false;
  if(scriptCount==0||scriptCount>SCRIPT_MAX){scriptCount=0;return;}
  for(uint8_t i=0;i<scriptCount;i++)
    scriptLines[i]=prefs.getString((String("sc")+i).c_str(),"");
  if(!scriptValidStructure(scriptCount,false)){
    Serial.println("ERR SCRIPT NVS INCOMPLETE; LEGACY PLAYLIST RESTORED");
    scriptCount=0;return;
  }
  scriptCollectFollowers();
  scriptEnabled=prefs.getBool("sen",false);
  scriptResetRunner();
  Serial.print("SCRIPT LOADED ");Serial.println(scriptCount);
}
void handleScriptCommand(String args){
  args.trim();
  int sp=args.indexOf(' ');
  String sub=sp<0?args:args.substring(0,sp);
  String payload=sp<0?"":args.substring(sp+1);
  sub.toUpperCase();
  if(sub=="BEGIN"){
    scriptStageOpen=true;scriptStageCount=0;
    Serial.println("OK SCRIPT BEGIN");return;
  }
  if(sub=="CANCEL"){
    scriptStageOpen=false;scriptStageCount=0;
    Serial.println("OK SCRIPT CANCEL");return;
  }
  if(sub=="ADD"){
    if(!scriptStageOpen){Serial.println("ERR SCRIPT BEGIN FIRST");return;}
    if(scriptStageCount>=SCRIPT_MAX){Serial.println("ERR SCRIPT FULL");return;}
    if(!scriptValidLine(payload)){Serial.println("ERR SCRIPT INVALID LINE");return;}
    scriptStaging[scriptStageCount++]=payload;
    Serial.print("OK SCRIPT ADD ");Serial.println(scriptStageCount);return;
  }
  if(sub=="COMMIT"){
    if(!scriptStageOpen||!scriptValidStructure(scriptStageCount,true)){
      Serial.println("ERR SCRIPT BAD STRUCTURE");return;
    }
    // Store commands first, count and enabled LAST. Old v5 playlists stay intact.
    prefs.putBool("sen",false);
    prefs.putUChar("scnt",0);
    for(uint8_t i=0;i<scriptStageCount;i++){
      if(!prefs.putString((String("sc")+i).c_str(),scriptStaging[i])){
        Serial.println("ERR SCRIPT NVS CAPACITY; LEGACY PLAYLIST AVAILABLE");
        scriptEnabled=false;scriptCount=0;return;
      }
    }
    if(!prefs.putUChar("scnt",scriptStageCount)){
      Serial.println("ERR SCRIPT COUNT SAVE");scriptEnabled=false;scriptCount=0;return;
    }
    scriptCount=scriptStageCount;
    for(uint8_t i=0;i<scriptCount;i++)scriptLines[i]=scriptStaging[i];
    scriptStageOpen=false;scriptStageCount=0;
    scriptEnabled=false;scriptCollectFollowers();scriptResetRunner();
    Serial.print("OK SCRIPT SAVED ");Serial.println(scriptCount);return;
  }
  if(sub=="RUN"){
    if(scriptCount==0){Serial.println("ERR SCRIPT EMPTY");return;}
    scriptEnabled=true;prefs.putBool("sen",true);scriptResetRunner();
    Serial.println("OK SCRIPT RUN");return;
  }
  if(sub=="STOP"){
    scriptEnabled=false;prefs.putBool("sen",false);scriptResetRunner();
    currentBlock=0;showCurrentBlock();
    Serial.println("OK SCRIPT STOP");return;
  }
  if(sub=="GET"){
    Serial.print("SCRIPT COUNT ");Serial.println(scriptCount);
    for(uint8_t i=0;i<scriptCount;i++){
      Serial.print("SCRIPT ITEM ");Serial.print(i);Serial.print(' ');
      Serial.println(scriptLines[i]);
    }
    Serial.println("SCRIPT END");return;
  }
  Serial.println("ERR SCRIPT UNKNOWN COMMAND");
}
String scriptExpanded(const String& src){
  String out;out.reserve(src.length()+30);
  int pos=0;
  while(pos<(int)src.length() && out.length()<365){
    int at=src.indexOf('{',pos);
    if(at<0){out+=src.substring(pos);break;}
    out+=src.substring(pos,at);
    int end=src.indexOf('}',at+1);
    if(end<0){out+=src.substring(at);break;}
    String key=src.substring(at+1,end);
    int sep=key.indexOf(':');
    String kind=sep<0?"":key.substring(0,sep);
    String arg=sep<0?"":key.substring(sep+1);
    if(kind=="followers"){
      uint32_t n=0;out+=scriptCachedCount(normalizeStreamer(arg),n)?String(n):String("NO DATA");
    }else if(kind=="time"||kind=="date"||kind=="weekday"){
      out+=dateZonePOSIX(arg)?formattedClock(arg,kind=="time"?1:kind=="weekday"?2:0):String("--");
    }else out+=src.substring(at,end+1);
    pos=end+1;
  }
  if(out.length()>370)out.remove(370);
  return out;
}
bool scriptIfTrue(const String& line){
  String type=scriptToken(line,1);
  if(type=="WIFI")return WiFi.status()==WL_CONNECTED;
  if(type=="FOLLOWERS"){
    uint32_t count=0;return scriptCachedCount(scriptToken(line,2),count)&&
      count>=(uint32_t)scriptToken(line,3).toInt();
  }
  if(type=="HOUR"){
    if(time(nullptr)<1704067200)return false;
    String zone=scriptToken(line,2);
    const char* tz=dateZonePOSIX(zone);
    if(!tz)return false;
    setenv("TZ",tz,1);tzset();
    time_t now=time(nullptr);
    struct tm local;
    if(!localtime_r(&now,&local))return false;
    return local.tm_hour>=scriptToken(line,3).toInt();
  }
  return false;
}
uint8_t scriptSkipIf(uint8_t start,bool skipToElse){
  int depth=0;
  for(uint8_t i=start+1;i<scriptCount;i++){
    String kind=scriptToken(scriptLines[i],0);
    if(kind=="IF")depth++;
    else if(kind=="ENDIF"){
      if(depth==0)return i+1;
      depth--;
    }else if(kind=="ELSE"&&depth==0&&skipToElse)return i+1;
  }
  return scriptCount;
}
void drawScriptFrame(uint8_t frameIndex){
  const uint16_t base=(uint16_t)frameIndex*65;
  MD_MAX72XX* gfx=matrix.getGraphicObject();
  gfx->update(MD_MAX72XX::OFF);
  for(uint8_t col=0;col<32;col++){
    uint16_t p=base+(uint16_t)col*2;
    uint8_t value=(pixelHex(scriptPixelData[p])<<4)|pixelHex(scriptPixelData[p+1]);
    gfx->setColumn(31-col,value);
  }
  gfx->update();gfx->update(MD_MAX72XX::ON);
}
void scriptTick(){
  if(!scriptEnabled||scriptCount==0)return;
  uint32_t now=millis();
  if(scriptMode==1){
    if(matrix.displayAnimate())scriptMode=0;
    return;
  }
  if(scriptMode==2){
    if((int32_t)(now-scriptWaitUntil)>=0)scriptMode=0;
    return;
  }
  if(scriptMode==3){
    if(now-scriptPixelStart>=scriptPixelDuration){
      matrix.displaySuspend(false);
      scriptMode=0;
    }else if(now-scriptPixelFrameAt>=scriptPixelFrameMs){
      scriptPixelFrameAt=now;
      scriptPixelIndex=(scriptPixelIndex+1)%frameCount(scriptPixelData);
      drawScriptFrame(scriptPixelIndex);
    }
    return;
  }
  if(scriptPC>=scriptCount){scriptPC=0;scriptDepth=0;return;}
  // Bound zero-time opcodes each tick to protect other ESP32 activities.
  for(uint8_t safety=0;safety<48&&scriptPC<scriptCount;safety++){
    String line=scriptLines[scriptPC++];
    String kind=scriptToken(line,0);
    if(kind=="WAIT"){
      scriptWaitUntil=millis()+(uint32_t)scriptToken(line,1).toInt();
      scriptMode=2;return;
    }
    if(kind=="TEXT"){
      String shown;
      if(!b64Decode(scriptToken(line,1),shown))shown="BAD TEXT";
      showText(scriptExpanded(shown),(uint16_t)scriptToken(line,2).toInt(),
        (uint16_t)scriptToken(line,3).toInt());
      scriptMode=1;return;
    }
    if(kind=="TWITCH"){
      String name=scriptToken(line,1);
      uint32_t count=0;
      String num=scriptCachedCount(name,count)?String(count):String("NO DATA");
      String message=scriptToken(line,2)=="COUNT"?num:String(name).toUpperCase()+": "+num;
      showText(message,(uint16_t)scriptToken(line,3).toInt(),(uint16_t)scriptToken(line,4).toInt());
      scriptMode=1;return;
    }
    if(kind=="CLOCK"){
      String zone=scriptToken(line,1),mode=scriptToken(line,2);
      String shown=formattedClock(zone,mode=="DATE"?0:mode=="WEEKDAY"?2:1);
      showText(shown,(uint16_t)scriptToken(line,3).toInt(),(uint16_t)scriptToken(line,4).toInt());
      scriptMode=1;return;
    }
    if(kind=="PIXEL"){
      scriptPixelData=scriptToken(line,1);
      scriptPixelFrameMs=(uint16_t)scriptToken(line,2).toInt();
      scriptPixelDuration=(uint16_t)scriptToken(line,3).toInt();
      scriptPixelStart=scriptPixelFrameAt=millis();scriptPixelIndex=0;
      matrix.displaySuspend(true);drawScriptFrame(0);scriptMode=3;return;
    }
    if(kind=="IF"){
      if(!scriptIfTrue(line))scriptPC=scriptSkipIf(scriptPC-1,true);
      continue;
    }
    if(kind=="ELSE"){scriptPC=scriptSkipIf(scriptPC-1,false);continue;}
    if(kind=="ENDIF")continue;
    if(kind=="REPEAT"){
      if(scriptDepth>=3){scriptEnabled=false;Serial.println("ERR SCRIPT LOOP STACK");return;}
      scriptLoops[scriptDepth].start=scriptPC;
      scriptLoops[scriptDepth].remaining=(uint8_t)scriptToken(line,1).toInt();
      scriptDepth++;continue;
    }
    if(kind=="ENDREPEAT"){
      if(!scriptDepth){scriptEnabled=false;Serial.println("ERR SCRIPT ENDREPEAT");return;}
      if(--scriptLoops[scriptDepth-1].remaining>0)scriptPC=scriptLoops[scriptDepth-1].start;
      else scriptDepth--;
      continue;
    }
  }
}
void maybeUpdateScriptFollowers(){
  if(!scriptEnabled||!scriptFollowCount)return;
  uint32_t now=millis();
  if(now-bootAt<BOOT_GRACE_MS||now-lastConfigAt<CONFIG_SETTLE_MS||
     now-lastNetworkAt<NETWORK_SPACING_MS)return;
  for(uint8_t i=0;i<scriptFollowCount;i++){
    if((int32_t)(now-scriptFollow[i].nextAt)<0)return;
    lastNetworkAt=now;
    uint32_t count=0;bool ok=fetchCountFor(scriptFollow[i].name,count);
    scriptFollow[i].nextAt=millis()+(ok?FOLLOWER_UPDATE_MS:ERROR_RETRY_MS);
    if(ok){
      scriptFollow[i].count=count;scriptFollow[i].valid=true;
      Serial.print("FOLLOWERS ");Serial.print(scriptFollow[i].name);
      Serial.print(' ');Serial.println(count);
    }
    return; // at most one network request
  }
}
void maybeConnectScriptClock(){
  if(!scriptEnabled||ntpStarted||!wifiSsid.length())return;
  if(millis()-lastClockConnectAt<CLOCK_CONNECT_RETRY_MS)return;
  lastClockConnectAt=millis();connectWiFi();
}

void setup() {
  Serial.begin(115200);
  serialBuffer.reserve(650);
  matrix.begin();
  matrix.setFont(TWITCH_LED_RU_CP1251);
  matrix.setIntensity(3);
  matrix.displayClear();
  prefs.begin("twitch-led",false); // Same namespace as v3, preserves Wi-Fi
  wifiSsid=prefs.getString("ssid","");
  wifiPassword=prefs.getString("password","");
  loadBlocks();
  loadScript();
  WiFi.mode(WIFI_STA);WiFi.persistent(false);
  currentBlock=0;
  showText("V6 LOGIC",55,250); // Visible confirmation of successful update
  bootAnnouncement=true;
  bootAt=millis();lastConfigAt=millis();
  lastNetworkAt=millis()-NETWORK_SPACING_MS;
  lastClockConnectAt=millis()-CLOCK_CONNECT_RETRY_MS;
  Serial.println("Twitch LED Logic v6.0 READY");
  printStatus();
}

void loop() {
  pollSerial();
  if(scriptEnabled){
    scriptTick();
    maybeUpdateScriptFollowers();
    maybeConnectScriptClock();
  }else{
    animateMatrix();
    maybeUpdateFollowers();
    maybeConnectClock();
  }
  delay(1);
}