/*
 * ESP32 Offline Data Logger & BLE Sync
 *
 * Hardware:
 * - ESP32 (Microcontroller)
 * - DS1307 RTC (Real Time Clock) - Keeps track of real-world time while offline
 * - AHT20 (Temperature & Humidity Sensor)
 * - LTR390 (UV Sensor)
 * - TSL25911 / Analog Light Sensor (Lux)
 *
 * Libraries required:
 * - BLEDevice, BLEUtils, BLEServer, BLE2902 (Built-in ESP32 BLE)
 * - Wire (I2C communication)
 * - RTClib (For DS1307 RTC)
 * - Adafruit_AHTX0 (For AHT20)
 * - DFRobot_LTR390UV (For LTR390)
 * - ArduinoJson (For formatting data to send to the phone)
 * - LittleFS (For saving data to the ESP32's internal flash memory)
 */

#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <Wire.h>
#include <RTClib.h>           
#include <Adafruit_AHTX0.h>
#include <DFRobot_LTR390UV.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_TSL2591.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include "mbedtls/md.h"
#include <esp_random.h>  

// BLE UUIDs (Unique Identifiers gia ta Bluetooth Services/Characteristics)
// Lene tin efarmogi POU tha psaksoun gia sugkekrimena dedomena.
#define SERVICE_UUID           "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define DATA_CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8" // Etsi o ESP32 eidopoiei to kinito gia nea data
#define AUTH_CHARACTERISTIC_UUID "8b19e27c-3729-45e0-84c1-65b161405e3f" // Etsi to kinito stelnei password kai xrono

const String SECRET_KEY = "makisDimakis";

// SENSORS OBJECTS
RTC_DS1307 rtc; 
Adafruit_AHTX0 aht; 
DFRobot_LTR390UV ltr390(/*addr=*/0x1C, /*pWire=*/&Wire);
Adafruit_TSL2591 tsl = Adafruit_TSL2591(2591); // TSL25911 light sensor (I2C address -> 0x29)
BLECharacteristic* pDataChar = NULL;
BLECharacteristic* pAuthChar = NULL;   
String currentNonce = "";    // hex challenge gia auti ti sundesi
String   authNonce = "";   // to nonce pou xrisimopoiithike sto AUTH — kleidonei ta MAC autou tou session
volatile bool   nonceValid   = false;  // single-use guard

// STATE VARIABLES
volatile bool deviceConnected = false;
volatile bool isAuthenticated = false;
volatile bool forceSync = false;
volatile bool pendingWipe   = false;   // BLE task sets, loop() executes

// Plausible-epoch window (2025-01-01 .. ~2049) gia RTC / phone timestamp checks
const uint32_t MIN_VALID_EPOCH = 1735689600UL;
const uint32_t MAX_VALID_EPOCH = 2500000000UL;

// TIME AND SYNC TRACKING VARIABLES
uint32_t lastSyncedTime = 0; 
int sessionStartHead = 0;  // Marks where this specific boot session started in the array
int sessionLogged = 0;   // posa entries grafike se AUTO to session (gia fix 8)
uint32_t lastSentTime = 0; // Tracks the newest timestamp sent to the phone in this connection
uint32_t msgSeq    = 0;    // auksanei se KATHE notification (anti-replay)

// DATA STORAGE STRUCTURE
// data packet pou kouvalaei ena reading
struct LogEntry { 
  uint32_t time;  // Unix timestamp (Seconds since Jan 1, 1970)
  float t, h, uv, light; // Temperature, Humidity, UV indexn, light
}; //OLA AUTA 20 BYTES

// KUKLIKOS BUFFER
// Mporei max 1500 readings. Otan ftasei tis 1500, to 'head' paei pali sto 0 kai
// kanei overwrite ta palia data (den exoume overflow mnimis)
const int MAX_HIST = 1500; 
LogEntry history[MAX_HIST]; 
int head = 0; // current index opou tha apothikeutei to EPOMENO reading 

// SMOOTHING BUFFERS
const int SMOOTH_N = 5;
float tempBuffer[SMOOTH_N] = {0}; //ola ta stoixeia exoun ti timi 0
float humBuffer[SMOOTH_N]  = {0};
float uvBuffer[SMOOTH_N]   = {0};
float luxBuffer[SMOOTH_N]  = {0};
int   smoothIdx = 0;
bool  bufferInitialized = false;

// Apothikeuoun tis teleutaies smoothed times gia ton 15-min logger
float latestSmoothedTemp  = 0;
float latestSmoothedHum   = 0;
float latestSmoothedUV    = 0;
float latestSmoothedLux   = 0;

// TIMERS
unsigned long lastLiveTick = 0;      // 1-second timer (Reads sensors)
unsigned long lastHistoryTick = 0;   // 10-minute timer (Logs to history)
unsigned long lastBatchTick = 0;     // 10-second timer (Syncs to phone)
const unsigned long SENSOR_POLL_INTERVAL = 180000;  // 3 minutes — prosthetei ston buffer - feeds the buffer
const unsigned long LOG_INTERVAL         = 900000;  // 15 minutes — mpainei sto average - logs the average

unsigned long lastSensorPollTick = 0;


float smoothedAverage(float* buf, float newVal) { 
  //float* buf einai o pointer gia tous buffers, newVal einai to pio prosfato raw reading
  // Arxika vazoume ola ta slots 1 eos 5 me to proto reading 
  if (!bufferInitialized) {
    for (int i = 0; i < SMOOTH_N; i++) buf[i] = newVal;
  }
  buf[smoothIdx % SMOOTH_N] = newVal; //thesi 1-4 i nea timi
  float sum = 0;
  for (int i = 0; i < SMOOTH_N; i++) sum += buf[i];
  return sum / SMOOTH_N; //i mesi timi
}

// Vgazei kainourio challenge meta apo KATHE epityximeni entoli.
// Etsi krataei to single-use (anti-replay) alla epitrepei RESET meta to AUTH.
void rotateNonce() {
  currentNonce = generateNonce();
  nonceValid   = true;
  if (pAuthChar) pAuthChar->setValue(currentNonce.c_str());
}

// HANDSHAKE KAI CALLBACKS
// Edo lamvanei dedomena APO tin efarmogh Android 
class AuthCallbacks: public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pChar) {
    String value = pChar->getValue().c_str();
    if (!nonceValid) { Serial.println("No active challenge."); return; }

    int firstColon = value.indexOf(':');
    if (firstColon == -1) return;
    String cmd  = value.substring(0, firstColon);
    String rest = value.substring(firstColon + 1);

    // AUTH:<timestamp>:<hmac>  — hmac over  nonce + ":AUTH:" + timestamp
    if (cmd == "AUTH") {
      int c2 = rest.indexOf(':');
      if (c2 == -1) return;
      String tsStr    = rest.substring(0, c2);
      String recvHmac = rest.substring(c2 + 1);

      String expected = hmacSha256Hex(SECRET_KEY, currentNonce + ":AUTH:" + tsStr);
      if (constantTimeEquals(expected, recvHmac)) {
        isAuthenticated = true;
        forceSync = true;
        authNonce = currentNonce;   //prin to rotate
        msgSeq    = 0;              
        rotateNonce();   // kainourio challenge gia tin epomeni entoli (px RESET)
        uint32_t phoneTime = (uint32_t)strtoul(tsStr.c_str(), NULL, 10);
        if (phoneTime >= MIN_VALID_EPOCH && phoneTime <= MAX_VALID_EPOCH) {
          rtc.adjust(DateTime(phoneTime));
          Serial.println("Authenticated (HMAC) & time synced.");
        } else {
          // Piase to klassiko lathos: Date.now() se ms anti gia seconds
          Serial.print("Authenticated, but timestamp rejected: ");
          Serial.println(tsStr);
        }
      } else {
        Serial.println("HMAC mismatch.");
      }
    }
    // RESET:<hmac>  — hmac over  nonce + ":RESET"
    else if (cmd == "RESET") {
      String expected = hmacSha256Hex(SECRET_KEY, currentNonce + ":RESET");
        if (constantTimeEquals(expected, rest)) {
        // MIN peiraksoume to history apo edo — trexoume se allo task apo to loop().
        // Apla deixnoume kai to loop() to ektelei me asfaleia.
        pendingWipe = true;
        rotateNonce();
        Serial.println("Wipe requested (authenticated) — will execute in loop().");
      } else {
        Serial.println("RESET HMAC mismatch.");
      }
    }
  }
};

// Kanei trigger otan to kinito sundeetai i aposundeetai fusika
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) { 
      deviceConnected = true;
      isAuthenticated = false;
      lastSentTime = 0;
      currentNonce = generateNonce();
      nonceValid = true;
      if (pAuthChar) pAuthChar->setValue(currentNonce.c_str());  // phone READs this
    }
    void onDisconnect(BLEServer* pServer) { 
      deviceConnected = false; 
      lastSyncedTime = 0; 
      BLEDevice::startAdvertising(); // To ksanakanei discoverable apo kinita
    }
};

// FLASH MEMORY FUNCTIONS
// Vazei olo ton pinaka sti mnimi tou ESP32 (apo RAM state se permanent file tou flash memory)
void saveToFlash() {
  // Grafoume se temp file kai kanoume rename — an kopei to reuma sti mesi,
  // to palio /history.bin menei akeraio.
  File f = LittleFS.open("/history.tmp", "w");
  if (!f) { Serial.println("Flash open failed."); return; }

  size_t w1 = f.write((uint8_t*)&head, sizeof(head));
  size_t w2 = f.write((uint8_t*)history, sizeof(history));
  f.close();

  if (w1 != sizeof(head) || w2 != sizeof(history)) {
    LittleFS.remove("/history.tmp");
    Serial.println("Flash write incomplete — previous history kept.");
    return;
  }

  LittleFS.remove("/history.bin");                  // rename apotygxanei an yparxei to destination
  LittleFS.rename("/history.tmp", "/history.bin");
}

// Kanei load ton pinaka sti mnimi RAM tou ESP32 otan kanei boot up
void loadFromFlash() {
  if (LittleFS.exists("/history.tmp")) LittleFS.remove("/history.tmp");
  if (LittleFS.exists("/history.bin")) {
    File f = LittleFS.open("/history.bin", "r");
    if (f) {
      // Elegxos megethous PRIN empisteutoume otidipote apo to arxeio
      if (f.size() != (sizeof(head) + sizeof(history))) {
        Serial.println("history.bin wrong size — starting fresh.");
        f.close();
        head = 0;
        memset(history, 0, sizeof(history));
        return;
      }
      f.read((uint8_t*)&head, sizeof(head));
      f.read((uint8_t*)history, sizeof(history));
      f.close();

      // head mporei na einai garbage akoma kai me sosto file size
      if (head < 0 || head >= MAX_HIST) {
        Serial.println("head out of range — reset to 0.");
        head = 0;
      }
    }
  }
}

void setup() {
  Serial.begin(115200); 
  Wire.begin(); //Gia tous I2C sensors
  
  // Den pagonei o ESP32 an aposundethei kapoios sensor
  Wire.setTimeOut(1000); 
  
  rtc.begin();
  if (!rtc.isrunning()) {
    Serial.println("RTC not running (lost power / dead cell). Time invalid until phone sync.");
  }
  aht.begin(); 
  ltr390.begin();
  ltr390.setMode(ltr390.eUVSMode);                        // UV sensing mode
  ltr390.setALSOrUVSGain(ltr390.eGain18);                 // 18x — apaitoumeno gia ton divisor 2300
  ltr390.setALSOrUVSMeasRate(ltr390.e20bit, ltr390.e500ms); // 20-bit (400ms conversion) + 500ms rate
  delay(1000);                                            // settling — oi protes metriseis meta to config einai garbage

  // TSL25911 light sensor
  if (!tsl.begin()) {
    Serial.println("TSL25911 not found!");
  }
  tsl.setGain(TSL2591_GAIN_LOW);                // 1x — low gain gia bright/sunlit environments (den exoume koresmo)
  tsl.setTiming(TSL2591_INTEGRATIONTIME_100MS); // short integration — dinei to plires 0-88000 lux range
  
  // Format ti flash an den ginetai mounted
  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS Fail");
  }
  loadFromFlash(); 
  sessionStartHead = head; // Prota load, meta markarei pou arxizei to session

  // Initialize Bluetooth Server
  BLEDevice::init("ESP-SN-0014");
  BLEServer* pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks()); //kanei wire tous handlers (connect/disconnect)
  
  BLEService* pService = pServer->createService(SERVICE_UUID); //Service einai ena container pou katigoriopoiei sxetika xaraktiristika se ena UUID
  
  // Setup the Data Sender Characteristic (Xrisimopoiei "NOTIFY" gia na steilei data sto app xoris na erotithei)
  pDataChar = pService->createCharacteristic(DATA_CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  pDataChar->addDescriptor(new BLE2902()); //Xreiazetai gia na doulepsei to NOTIFY (ESP32 -> phone)
  
  // Setup the Auth Receiver Characteristic
  //Write gia na steilei SECRET_KEY:timestamp (phone -> ESP32) kai READ
  pAuthChar = pService->createCharacteristic(AUTH_CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_READ);
  pAuthChar->setCallbacks(new AuthCallbacks()); //Kanei attach to onWrite handler
  
  pService->start();
  BLEDevice::getAdvertising()->start(); //Arxizei to broadcast
  Serial.println("System Ready.");
  //hardware bus -> sensors -> storage (with data restored) -> Bluetooth -> advertising
}

// Helpers - Margins
bool isValidReading(float temp, float hum, float uv, float light) {
  if (isnan(temp) || isnan(hum) || isnan(uv) || isnan(light)) return false; 
  if (temp < -40.0f || temp > 85.0f)   return false; // oria AHT20
  if (hum < 0.0f   || hum > 100.0f)   return false;
  if (uv < 0.0f    || uv > 16.0f)     return false; // UV index cap
  if (light < 0.0f || light > 88000.0f) return false; // To range tou TSL25911
  return true;
}

bool timeIsValid() {
  if (!rtc.isrunning()) return false;
  uint32_t t = rtc.now().unixtime();
  return (t >= MIN_VALID_EPOCH && t <= MAX_VALID_EPOCH);
}

// Auto-range: xamilo gain gia ilio, ypsili gia skoteino container.
// allowHighGain = false -> grigoro read (~120ms) gia to live path.
float readLuxAutoRange(bool allowHighGain) {
  tsl.setGain(TSL2591_GAIN_LOW);
  tsl.setTiming(TSL2591_INTEGRATIONTIME_100MS);
  uint32_t lum  = tsl.getFullLuminosity();
  uint16_t full = lum & 0xFFFF;

  if (allowHighGain && full < 100) {   // poly skoteino — anevase euaisthisia
    tsl.setGain(TSL2591_GAIN_MED);                 // 25x
    tsl.setTiming(TSL2591_INTEGRATIONTIME_300MS);
    delay(350);                                    // afise ena pliri integration cycle
    lum  = tsl.getFullLuminosity();
    full = lum & 0xFFFF;
  }

  uint16_t ir = lum >> 16;
  float lux = tsl.calculateLux(full, ir);          // to library kanei to scaling apo gain/timing
  if (lux < 0) lux = 88000.0;                      // -1 = koresmos
  return lux;
}

//ASFALEIA
// Random 16-byte challenge san ena 32-char hex string
String generateNonce() {
  char hex[33];
  for (int i = 0; i < 16; i += 4) {
    uint32_t r = esp_random();
    sprintf(hex + i*2, "%02x%02x%02x%02x",
            r & 0xFF, (r >> 8) & 0xFF, (r >> 16) & 0xFF, (r >> 24) & 0xFF);
  }
  hex[32] = '\0';
  return String(hex);
}

// HMAC-SHA256(key, msg) as lowercase hex
String hmacSha256Hex(const String& key, const String& msg) {
  uint8_t out[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, info, 1);   // 1 = HMAC mode
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)key.c_str(), key.length());
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)msg.c_str(), msg.length());
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i*2, "%02x", out[i]);
  hex[64] = '\0';
  return String(hex);
}

// Constant-time compare (avoids leaking match progress via timing)
bool constantTimeEquals(const String& a, const String& b) {
  if (a.length() != b.length()) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < a.length(); i++) diff |= (a[i] ^ b[i]);
  return diff == 0;
}

// Stelnei signed packet:  <json>|<seq>|<tag>
// To '|' den emfanizetai pote mesa se JSON, ara einai asfales delimiter.
void notifySigned(const String& body) {
  if (!pDataChar) return;
  msgSeq++;
  String preimage = authNonce + ":" + String(msgSeq) + ":" + body;
  String tag = hmacSha256Hex(SECRET_KEY, preimage).substring(0, 16);  // 64-bit tag
  String out = body + "|" + String(msgSeq) + "|" + tag;
  pDataChar->setValue(out.c_str());
  pDataChar->notify();
}

void loop() {
  unsigned long nowMillis = millis(); //Metraei ta millis apo tin arxi pou anoiksei o ESP32

  // Ektelesi tou wipe sto loop task, oxi sto BLE callback
  if (pendingWipe) {
    pendingWipe = false;
    memset(history, 0, sizeof(history));
    head             = 0;
    sessionStartHead = 0;
    sessionLogged    = 0;
    lastSentTime     = 0;
    LittleFS.remove("/history.bin");
    LittleFS.remove("/history.tmp");
    Serial.println("Memory wiped.");
  }

  // --- 1. SENSOR POLLING LOGIC ---
  bool isTimeForSensorPoll = (nowMillis - lastSensorPollTick >= SENSOR_POLL_INTERVAL || lastSensorPollTick == 0); 
  //SENSOR_POLL_INTERVAL = 3 lepta. Deutero kommati = pairnei timi sto proto loop
  bool isTimeForHistory    = (nowMillis - lastHistoryTick >= LOG_INTERVAL || lastHistoryTick == 0);
  //LOG_INTERVAL = 15 lepta. 
  bool isLiveUpdateNeeded  = (deviceConnected && isAuthenticated && (nowMillis - lastLiveTick >= 1000));

  if (isTimeForSensorPoll || isLiveUpdateNeeded) {

    // Read raw sensor values
    DateTime now = rtc.now();
    sensors_event_t hum, temp; //standard struct from Adafruit's Unified Sensor library
    aht.getEvent(&hum, &temp); //Me pointer, etsi grafei i function ta apotelesmata stis metavlites anti na ta kanei return
    float uv    = ltr390.readOriginalData() / 2300.0f; //calibration divisor apo to datasheet
    
    // TSL25911 — read full-spectrum + IR channels, convert to lux
    float light = readLuxAutoRange(isTimeForSensorPoll);

    // A. Live data — raw, unsmoothed, responsive
    if (isLiveUpdateNeeded) {
      lastLiveTick = nowMillis;
      JsonDocument liveDoc; //xtizei ena mikro JSON object
      liveDoc["live"] = true; //tag pou epitrepei to React Native app na ksexorizei live apo istorika data
      liveDoc["t"] = String(temp.temperature, 1);
      liveDoc["h"] = String(hum.relative_humidity, 0);
      liveDoc["u"] = String(uv, 4);
      liveDoc["l"] = light;
      String liveOut;
      serializeJson(liveDoc, liveOut); //Ta metatrepei se String
      notifySigned(liveOut);
    }

    // B. Prosthese sta smoothing buffers kathe 3 lepta
    if (isTimeForSensorPoll) {
      lastSensorPollTick = nowMillis;
      // Elegxos tou RAW reading PRIN mpei sto smoothing buffer.
      // Ena NaN sto buffer den fevgei pote — xalaei to average gia panta.
      if (!isValidReading(temp.temperature, hum.relative_humidity, uv, light)) {
        Serial.println("Raw reading invalid (out of range / NaN) — NOT added to buffer.");
      } else {
        latestSmoothedTemp = smoothedAverage(tempBuffer, temp.temperature);
        latestSmoothedHum  = smoothedAverage(humBuffer,  hum.relative_humidity);
        latestSmoothedUV   = smoothedAverage(uvBuffer,   uv);
        latestSmoothedLux  = smoothedAverage(luxBuffer,  light);

        if (!bufferInitialized) bufferInitialized = true;
        smoothIdx++;
      }

    // Print raw readings
      Serial.println("------ 3-min Poll ------");
      Serial.print("  RAW  → Temp: "); Serial.print(temp.temperature, 2);
      Serial.print(" °C | Hum: ");     Serial.print(hum.relative_humidity, 1);
      Serial.print(" % | UV: ");       Serial.print(uv, 4);
      Serial.print(" | Lux: ");        Serial.println(light, 1);

      // Print smoothed averages
      Serial.print("  AVG  → Temp: "); Serial.print(latestSmoothedTemp, 2);
      Serial.print(" °C | Hum: ");     Serial.print(latestSmoothedHum, 1);
      Serial.print(" % | UV: ");       Serial.print(latestSmoothedUV, 4);
      Serial.print(" | Lux: ");        Serial.println(latestSmoothedLux, 1);
      Serial.println("------------------------");
    }
  }

// C. Vale to smoothed average kathe 15 lepta 
if (isTimeForHistory) {
  lastHistoryTick = nowMillis;
    if (!timeIsValid()) {
    Serial.println("RTC time not valid (not synced yet) — log skipped.");
  } else if (!bufferInitialized) {
    Serial.println("No valid sample collected yet — log skipped.");
  } else if (isValidReading(latestSmoothedTemp, latestSmoothedHum, latestSmoothedUV, latestSmoothedLux)) {
  DateTime now = rtc.now();
  history[head] = { (uint32_t)now.unixtime(), latestSmoothedTemp, latestSmoothedHum, latestSmoothedUV, latestSmoothedLux };
  head = (head + 1) % MAX_HIST; //circular-buffer advance, meta apo 1499 to kanei 0 
  if (sessionLogged < MAX_HIST) sessionLogged++;
  saveToFlash();

  // Print
    Serial.println("====== 15-min LOG SAVED ======");
    Serial.print("  Temp: "); Serial.print(latestSmoothedTemp, 2); Serial.println(" °C");
    Serial.print("  Hum:  "); Serial.print(latestSmoothedHum, 1);  Serial.println(" %");
    Serial.print("  UV:   "); Serial.println(latestSmoothedUV, 4);
    Serial.print("  Lux:  "); Serial.println(latestSmoothedLux, 1);
    Serial.println("==============================");
  } else {
    Serial.println("Smoothed average failed range check — skipped!!!");
  }
}

  // --- 2. BLUETOOTH HISTORY SYNC BLOCK ---
  // If a phone is connected, authenticated, and it has been 10 seconds (or is forced)
  if (deviceConnected && isAuthenticated && (nowMillis - lastBatchTick >= 10000 || forceSync)) {
      lastBatchTick = nowMillis;
      forceSync = false;
      // Ypologise posa entries exoume apo to boot tou ESP32
      // Metrame me counter, otan o buffer kanei akrivos ena plires wrap piso sto sessionStartHead.
      int count = sessionLogged;
      
      // Loop through ONLY the points from this current session
      for (int i = 0; i < count; i++) {
          int idx = (sessionStartHead + i) % MAX_HIST;
          
          // An to timestamp atuou tou simeiou einai neotero apo to teleutaio pou steilame
          if (history[idx].time > lastSentTime && history[idx].time > 0) {
              
              // Pack the data into a JSON format so Javascript/React Native can easily read it
              JsonDocument doc;
              doc["time"] = history[idx].time; 
              doc["t"] = String(history[idx].t, 1);
              doc["h"] = String(history[idx].h, 0); 
              doc["u"] = String(history[idx].uv, 4);
              doc["l"] = history[idx].light;
              
              String out;
              serializeJson(doc, out);
              
              notifySigned(out);
              
              // Remember that we sent this timestamp so we don't send it again
              lastSentTime = history[idx].time; 
              delay(35); // A brief 35ms pause so the BLE antenna doesn't get overwhelmed
          }
      }
  }
}