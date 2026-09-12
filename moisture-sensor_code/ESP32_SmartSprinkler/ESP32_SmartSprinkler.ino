#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>
#include <WebServer.h>   // LAN fast path: serve /local-data + /local-valve (no cloud round-trip)
#include <ESPmDNS.h>      // → http://agriflow.local
#include "config_portal.h"   // WiFi + server IP via captive portal (NVS-persisted)

// Optional API key (agriscan-style): copy secrets.h.example → secrets.h and
// paste the key matching Render env SENSOR_API_KEY. Missing file = no key.
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef SENSOR_API_KEY
#define SENSOR_API_KEY ""
#endif

// ==================== Config (loaded from NVS) ===================
DeviceConfig cfg;

// ==================== LAN Server (fast local dashboard) ===================
// Dashboard polls this directly when on the same WiFi (every 3s, plain HTTP).
// Cloud push (Render) stays as history/LINE/config source.
WebServer lanServer(80);

// ==================== Cloud HTTPS (persistent — handshake once, reuse) ===================
// Full TLS handshake every 15s kept failing (-1/-5). Reusing one connection
// avoids it; broken conns are dropped and re-made on the next send.
WiFiClientSecure cloudTls;
HTTPClient cloudHttp;
bool cloudBegun = false;

void cloudEnd() {
  if (cloudBegun) { cloudHttp.end(); cloudBegun = false; }
  cloudTls.stop();
}

// Returns HTTP code (200/401/-1/-5…) or -10 if begin failed. 200 fills responseOut.
int cloudPost(const String &json, String &responseOut) {
  if (cfg.serverUrl.startsWith("https")) {
    if (!cloudBegun) {
      cloudTls.setInsecure();
      cloudTls.setTimeout(15000);
      cloudHttp.setReuse(true);
      cloudHttp.setTimeout(15000);
      if (!cloudHttp.begin(cloudTls, cfg.serverUrl)) return -10;
      cloudBegun = true;
    }
    cloudHttp.addHeader("Content-Type", "application/json");
    if (String(SENSOR_API_KEY).length() > 0) cloudHttp.addHeader("X-API-Key", SENSOR_API_KEY);
    int code = cloudHttp.POST(json);
    if (code == 200) { responseOut = cloudHttp.getString(); return code; }
    cloudEnd(); // drop broken conn → fresh handshake next send
    return code;
  }
  // Plain HTTP (local dev): one-shot, no reuse needed
  HTTPClient http;
  WiFiClient plain;
  http.begin(plain, cfg.serverUrl);
  http.addHeader("Content-Type", "application/json");
  if (String(SENSOR_API_KEY).length() > 0) http.addHeader("X-API-Key", SENSOR_API_KEY);
  http.setTimeout(15000);
  int code = http.POST(json);
  if (code == 200) responseOut = http.getString();
  http.end();
  return code;
}

// ==================== Sensor ==================
const int moisturePin = 34;
const int servoPin = 18;

// ==================== Calibration ====================
const int dryValue = 3200;
const int wetValue = 800;

// ==================== Config (synced from dashboard) ====================
int openThreshold = 40;
int wateringMinutes = 3;

// ==================== Servo (smooth, anti-jerk) ====================
// Tune these to your valve: if 90 hits the hard stop, lower to ~70.
const int VALVE_CLOSED_ANGLE = 0;
const int VALVE_OPEN_ANGLE = 90;
const int SERVO_MIN_US = 500;
const int SERVO_MAX_US = 2400;
const int SERVO_STEP_DEG = 2;      // deg per step
const int SERVO_STEP_MS = 20;      // ms per step → 0→70 takes ~0.7s
const unsigned long REOPEN_COOLDOWN_MS = 1UL * 60UL * 1000UL; // short guard against rapid on/off cycling
const int REOPEN_RISE_PCT = 3;       // must see moisture rise this far above threshold after a close
const unsigned long REOPEN_FALLBACK_MS = 1UL * 60UL * 1000UL; // ...before re-opening anyway (slow drainage)

Servo valveServo;
bool valveOpen = false;
unsigned long valveStartTime = 0;
int currentAngle = VALVE_CLOSED_ANGLE;
bool servoAttached = false;
unsigned long lastValveCloseTime = 0;
int peakMoistureSinceClose = -1; // wettest reading seen while closed (-1 = none yet)

// Manual override from dashboard (temporary, local timeout)
unsigned long manualUntil = 0;
bool manualOpen = false;
bool manualActive() { return manualUntil != 0 && millis() < manualUntil; }

void servoEnsureAttached() {
  if (!servoAttached) {
    valveServo.attach(servoPin, SERVO_MIN_US, SERVO_MAX_US);
    servoAttached = true;
    delay(50);
  }
}
void servoRelax() {
  delay(300); // let horn settle before cutting PWM hum
  valveServo.detach();
  servoAttached = false;
}
// Gradual sweep instead of instant write() → no jerk/current spike
void moveServoSlow(int target) {
  target = constrain(target, 0, 180);
  servoEnsureAttached();
  int step = (target > currentAngle) ? SERVO_STEP_DEG : -SERVO_STEP_DEG;
  while (currentAngle != target) {
    currentAngle += step;
    if ((step > 0 && currentAngle > target) || (step < 0 && currentAngle < target))
      currentAngle = target;
    valveServo.write(currentAngle);
    delay(SERVO_STEP_MS);
  }
}
void openValve() {
  moveServoSlow(VALVE_OPEN_ANGLE);
  servoRelax();
  valveOpen = true;
  valveStartTime = millis();
}
void closeValve() {
  moveServoSlow(VALVE_CLOSED_ANGLE);
  servoRelax();
  valveOpen = false;
  lastValveCloseTime = millis();
  peakMoistureSinceClose = -1; // restart hysteresis tracking
}

// ==================== Reset Button ====================
unsigned long resetPressedSince = 0;

// ==================== Send Timer ====================
unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL = 15000; // 15 seconds (TLS handshake every send is heavy — 5s just spams Render free tier and causes -1/-5 errors)

// ==================== WiFi Connect ====================
// NOTE: never wipes saved credentials here. A router reboot or dead zone must
// NOT erase config — wipe happens only via BOOT button or dashboard reset.
// Setup retries longer then reboots (retries with same creds); loop() retries
// briefly and keeps running valve control offline.
bool ensureWiFi(int maxAttempts) {
  if (WiFi.status() == WL_CONNECTED) return true;

  Serial.print("Connecting to WiFi: ");
  Serial.println(cfg.wifiSsid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < maxAttempts) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.println("================================");
    Serial.println("WiFi Connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.println("================================");
    return true;
  }
  Serial.println("\n⚠️ WiFi not reachable — continuing offline, will retry.");
  return false;
}

void connectWiFi() {
  // Setup path: try ~20s, then reboot and try again (creds kept).
  // Hold BOOT ~3s if credentials are truly wrong and portal is needed.
  if (!ensureWiFi(40)) {
    Serial.println("❌ WiFi failed — rebooting to retry (config kept).");
    delay(1000);
    ESP.restart();
  }
}

// ==================== Parse Config from Server ====================
void parseConfig(String response) {
  int idx;

  idx = response.indexOf("\"openThreshold\":");
  if (idx >= 0) {
    int start = idx + 16;
    int end = response.indexOf(',', start);
    if (end < 0) end = response.indexOf('}', start);
    int val = response.substring(start, end).toInt();
    if (val >= 5 && val <= 95 && val != openThreshold) {
      openThreshold = val;
      Serial.print("[CONFIG] openThreshold -> ");
      Serial.println(openThreshold);
    }
  }

  idx = response.indexOf("\"wateringMinutes\":");
  if (idx >= 0) {
    int start = idx + 18;
    int end = response.indexOf(',', start);
    if (end < 0) end = response.indexOf('}', start);
    int val = response.substring(start, end).toInt();
    if (val >= 1 && val <= 30 && val != wateringMinutes) {
      wateringMinutes = val;
      Serial.print("[CONFIG] wateringMinutes -> ");
      Serial.println(wateringMinutes);
    }
  }

  // Manual valve override from dashboard (temporary)
  idx = response.indexOf("\"valveOverride\":");
  if (idx >= 0) {
    if (response.indexOf("\"valveOverride\":null", idx) >= 0 && response.indexOf("\"valveOverride\":null", idx) == idx) {
      if (manualUntil != 0) {
        Serial.println("[VALVE] Manual override cleared → back to AUTO");
        manualUntil = 0;
        if (valveOpen) lastValveCloseTime = millis(); // don't auto re-open instantly
      }
    } else {
      bool wantOpen = response.indexOf("\"action\":\"open\"", idx) >= 0 &&
                      response.indexOf("\"action\":\"open\"", idx) < idx + 120;
      bool wantClose = response.indexOf("\"action\":\"close\"", idx) >= 0 &&
                       response.indexOf("\"action\":\"close\"", idx) < idx + 120;
      if ((wantOpen || wantClose) && !manualActive()) {
        manualOpen = wantOpen;
        manualUntil = millis() + (unsigned long)wateringMinutes * 60000UL;
        Serial.print("[VALVE] Manual override -> ");
        Serial.println(manualOpen ? "OPEN" : "CLOSE");
      }
    }
  }

  // Check for WiFi reset request from dashboard
  idx = response.indexOf("\"resetWifi\":true");
  if (idx >= 0) {
    Serial.println("[RESET] WiFi reset requested from dashboard!");
    Serial.println("[RESET] Clearing config and rebooting...");
    clearConfig();
    delay(500);
    ESP.restart();
  }
}

// ==================== LAN Handlers ====================
void handleLocalOptions() {
  lanServer.sendHeader("Access-Control-Allow-Origin", "*");
  lanServer.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  lanServer.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  lanServer.send(200, "text/plain", "");
}

void handleLocalData() {
  lanServer.sendHeader("Access-Control-Allow-Origin", "*");
  int rawValue = analogRead(moisturePin);
  int moisturePercent = constrain(map(rawValue, dryValue, wetValue, 0, 100), 0, 100);
  String json = "{";
  json += "\"device\":\"ESP32_Sprinkler\",";
  json += "\"raw\":" + String(rawValue) + ",";
  json += "\"moisture\":" + String(moisturePercent) + ",";
  json += "\"threshold\":" + String(openThreshold) + ",";
  json += "\"wateringMinutes\":" + String(wateringMinutes) + ",";
  json += "\"valve\":\"" + String(valveOpen ? "OPEN" : "CLOSE") + "\"";
  json += "}";
  lanServer.send(200, "application/json", json);
}

void handleLocalValve() {
  lanServer.sendHeader("Access-Control-Allow-Origin", "*");
  String body = lanServer.arg("plain");
  bool wantAuto = body.indexOf("auto") >= 0;
  bool wantOpen = body.indexOf("open") >= 0;
  bool wantClose = body.indexOf("close") >= 0;
  if (wantAuto) {
    manualUntil = 0;
    Serial.println("[LAN] Valve -> AUTO");
    lanServer.send(200, "application/json", "{\"ok\":true,\"mode\":\"auto\"}");
  } else if (wantOpen || wantClose) {
    manualOpen = wantOpen;
    manualUntil = millis() + (unsigned long)wateringMinutes * 60000UL;
    if (wantOpen && !valveOpen) openValve();
    else if (wantClose && valveOpen) closeValve();
    Serial.print("[LAN] Valve -> ");
    Serial.println(wantOpen ? "OPEN" : "CLOSE");
    lanServer.send(200, "application/json", "{\"ok\":true,\"mode\":\"manual\"}");
  } else {
    lanServer.send(400, "application/json", "{\"error\":\"action must be open, close or auto\"}");
  }
}

// Lite status page (agriscan-style self-contained): open http://agriflow.local/
void handleLocalRoot() {
  lanServer.sendHeader("Access-Control-Allow-Origin", "*");
  int rawValue = analogRead(moisturePin);
  int moisturePercent = constrain(map(rawValue, dryValue, wetValue, 0, 100), 0, 100);
  String html = "<!DOCTYPE html><html lang='th'><head><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<meta http-equiv='refresh' content='5'>"
    "<title>Agriflow (ESP32)</title></head>"
    "<body style='font-family:sans-serif;background:#040810;color:#e8f4f0;text-align:center;padding:32px'>"
    "<h1>🌱 Agriflow — ESP32 ตรง</h1>"
    "<p style='font-size:3rem;margin:8px'> " + String(moisturePercent) + "%</p>"
    "<p>Raw " + String(rawValue) + " | วาล์ว " + String(valveOpen ? "OPEN 🟢" : "CLOSE ⚪") + "</p>"
    "<p>เกณฑ์ &lt;" + String(openThreshold) + "% · รด " + String(wateringMinutes) + " นาที</p>"
    "<p><a style='color:#38eb9c' href='/local-data'>JSON</a> · <a style='color:#38eb9c' href='https://agriflow-mvt7.onrender.com/'>dashboard หลัก</a></p>"
    "</body></html>";
  lanServer.send(200, "text/html", html);
}

void startLanServer() {
  lanServer.on("/", HTTP_GET, handleLocalRoot);
  lanServer.on("/local-data", HTTP_GET, handleLocalData);
  lanServer.on("/local-data", HTTP_OPTIONS, handleLocalOptions);
  lanServer.on("/local-valve", HTTP_POST, handleLocalValve);
  lanServer.on("/local-valve", HTTP_OPTIONS, handleLocalOptions);
  lanServer.onNotFound([]() {
    lanServer.sendHeader("Access-Control-Allow-Origin", "*");
    lanServer.send(404, "text/plain", "not found");
  });
  lanServer.begin();
  if (MDNS.begin("agriflow")) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("[LAN] mDNS ready → http://agriflow.local/local-data");
  }
}

// ==================== Setup ====================
void setup() {
  Serial.begin(115200);
  delay(300);

  valveServo.attach(servoPin, SERVO_MIN_US, SERVO_MAX_US);
  servoAttached = true;
  valveServo.write(currentAngle);
  delay(500);

  // Boot self-test: sweep 0 → 70 → 0 so a dead servo/power issue is obvious
  Serial.println("[SERVO] Self-test: sweeping...");
  for (int a = 0; a <= VALVE_OPEN_ANGLE; a += 5) { valveServo.write(a); delay(40); }
  delay(300);
  for (int a = VALVE_OPEN_ANGLE; a >= 0; a -= 5) { valveServo.write(a); delay(40); }
  currentAngle = VALVE_CLOSED_ANGLE;
  Serial.println("[SERVO] Self-test done");
  servoRelax();

  // Reset button is on the BOOT pin.
  pinMode(CP_RESET_PIN, INPUT_PULLUP);

  // First boot (or after reset) → open the captive portal to configure.
  if (!loadConfig(cfg)) {
    startConfigPortal();
    // After saving, reload then reboot so everything starts clean.
    if (!loadConfig(cfg)) ESP.restart();
  }

  connectWiFi();

  // LAN fast path for dashboard on the same WiFi (port 80 free: portal stopped)
  startLanServer();

  // Test internet connectivity with a real HTTPS request (plain TCP to
  // port 443 can never succeed — old check always printed UNREACHABLE).
  Serial.println("[NET] Testing internet...");
  {
    HTTPClient http;
    WiFiClientSecure tls;
    WiFiClient plain;
    tls.setInsecure();
    tls.setTimeout(10000);
    http.setTimeout(10000);
    String healthUrl = cfg.serverUrl;
    int apiIdx = healthUrl.indexOf("/api/sensor");
    if (apiIdx >= 0) healthUrl = healthUrl.substring(0, apiIdx) + "/api/health";
    else healthUrl = "https://agriflow-mvt7.onrender.com/api/health";
    if (healthUrl.startsWith("https")) http.begin(tls, healthUrl);
    else http.begin(plain, healthUrl);
    int code = http.GET();
    if (code == 200) Serial.println("[NET] Server reachable ✓");
    else Serial.print("[NET] Server check failed, HTTP "); Serial.println(code);
    http.end();
  }

  Serial.println("Agriflow Started");
  Serial.print("Server: ");
  Serial.println(cfg.serverUrl);
}

// ==================== Main Loop ====================
void loop() {

  // Reset button: hold BOOT ~3s to wipe config & reopen the portal.
  if (checkResetButton(resetPressedSince)) {
    Serial.println("[RESET] Button held — clearing config and rebooting.");
    clearConfig();
    delay(200);
    ESP.restart();
  }

  // Short non-blocking reconnect (~8s max). Valve control below keeps
  // running offline; sensor upload is skipped until WiFi is back.
  if (WiFi.status() != WL_CONNECTED) {
    ensureWiFi(16);
  }

  // Serve LAN dashboard requests (non-blocking)
  if (WiFi.status() == WL_CONNECTED) lanServer.handleClient();

  // ---------- Read Sensor ----------
  int rawValue = analogRead(moisturePin);
  int moisturePercent = map(rawValue, dryValue, wetValue, 0, 100);
  moisturePercent = constrain(moisturePercent, 0, 100);

  // ---------- Valve Control ----------
  if (manualActive()) {
    // Dashboard override wins; auto logic paused until it expires
    if (manualOpen && !valveOpen) {
      Serial.println("Manual -> Open Valve");
      openValve();
    } else if (!manualOpen && valveOpen) {
      Serial.println("Manual -> Close Valve");
      closeValve();
    } else if (valveOpen && manualOpen &&
               millis() - valveStartTime >= (unsigned long)wateringMinutes * 60000UL) {
      Serial.println("Manual time up -> Close Valve");
      closeValve();
      manualUntil = 0;
    }
  } else {
    // Hysteresis: remember the wettest reading seen while closed, so a new
    // cycle requires proof the soil actually got wetter after last watering.
    if (!valveOpen && moisturePercent > peakMoistureSinceClose) {
      peakMoistureSinceClose = moisturePercent;
    }
    // Auto: dry + cooldown passed + (risen enough since close, or fallback time)
    bool cooldownOk = (lastValveCloseTime == 0) ||
                      (millis() - lastValveCloseTime >= REOPEN_COOLDOWN_MS);
    bool roseOk = (peakMoistureSinceClose < 0) ||
                  (peakMoistureSinceClose >= openThreshold + REOPEN_RISE_PCT);
    bool fallbackOk = (lastValveCloseTime != 0) &&
                      (millis() - lastValveCloseTime >= REOPEN_FALLBACK_MS);
    // Wait notices: print only on change (not every 100ms loop)
    static int lastWaitMsg = 0; // 0=none, 1=cooldown, 2=rise
    if (!valveOpen && moisturePercent < openThreshold && cooldownOk && (roseOk || fallbackOk)) {
      Serial.println("Soil Dry -> Open Valve");
      lastWaitMsg = 0;
      openValve();
    } else if (!valveOpen && moisturePercent < openThreshold && !cooldownOk) {
      if (lastWaitMsg != 1) { Serial.println("Soil Dry but in cooldown -> wait"); lastWaitMsg = 1; }
    } else if (!valveOpen && moisturePercent < openThreshold) {
      if (lastWaitMsg != 2) { Serial.println("Soil Dry but waiting for moisture rise -> wait"); lastWaitMsg = 2; }
    } else {
      lastWaitMsg = 0;
    }

    // Close: timer expired
    if (valveOpen) {
      if (millis() - valveStartTime >= (unsigned long)wateringMinutes * 60000UL) {
        Serial.println("Watering Complete -> Close Valve");
        closeValve();
      }
    }
  }

  // ---------- Serial Monitor (throttled: every 2s, not every loop) ----------
  static unsigned long lastPrintTime = 0;
  if (millis() - lastPrintTime >= 2000) {
    lastPrintTime = millis();
    Serial.print("Raw: ");        Serial.print(rawValue);
    Serial.print(" | Moisture: ");Serial.print(moisturePercent); Serial.print("%");
    Serial.print(" | Threshold: ");Serial.print(openThreshold); Serial.print("%");
    Serial.print(" | Water: ");   Serial.print(wateringMinutes); Serial.print("min");
    Serial.print(" | Valve: ");   Serial.print(valveOpen ? "OPEN" : "CLOSE");
    Serial.print(" | RSSI: ");    Serial.print(WiFi.RSSI()); Serial.print("dBm");

    if (valveOpen) {
      unsigned long remain = ((unsigned long)wateringMinutes * 60000UL - (millis() - valveStartTime)) / 1000UL;
      Serial.print(" | Remaining: "); Serial.print(remain); Serial.print("s");
    }
    Serial.println();
  }

  // ---------- Send to Dashboard (every SEND_INTERVAL) ----------
  if (millis() - lastSendTime >= SEND_INTERVAL && WiFi.status() == WL_CONNECTED) {
    lastSendTime = millis();

    String json = "{";
    json += "\"device\":\"ESP32_Sprinkler\",";
    json += "\"raw\":" + String(rawValue) + ",";
    json += "\"moisture\":" + String(moisturePercent) + ",";
    json += "\"threshold\":" + String(openThreshold) + ",";
    json += "\"wateringMinutes\":" + String(wateringMinutes) + ",";
    json += "\"valve\":\"" + String(valveOpen ? "OPEN" : "CLOSE") + "\"";
    json += "}";

    Serial.print("[SEND] "); Serial.println(json);

    // Pre-check: DNS
    IPAddress resolved;
    if (WiFi.hostByName("agriflow-mvt7.onrender.com", resolved)) {
      Serial.print("[NET] DNS OK → "); Serial.println(resolved);
    } else {
      Serial.println("[NET] DNS FAILED — no internet?");
    }

    int httpCode = 0;
    int retries = 0;
    while (httpCode != 200 && retries <= 3) {
      String response;
      httpCode = cloudPost(json, response);

      if (httpCode == 200) {
        parseConfig(response);
        Serial.println("[OK] Sent + config synced");
      } else if (httpCode == 401) {
        // Wrong/missing key never fixes itself by retrying — stop and say so
        Serial.println("[ERR] HTTP 401 — X-API-Key ไม่ตรงกับ server (เช็ค secrets.h + Render env SENSOR_API_KEY)");
        break;
      } else {
        Serial.print("[ERR] HTTP "); Serial.println(httpCode);
      }

      if (httpCode != 200 && retries < 3) {
        retries++;
        int waitSec = retries * 5; // 5/10/15s — fail fast, and keep LAN alive while waiting
        Serial.print("[RETRY "); Serial.print(retries); Serial.print("] wait ");
        Serial.print(waitSec); Serial.println("s ...");
        for (int w = 0; w < waitSec * 10; w++) {
          if (WiFi.status() == WL_CONNECTED) lanServer.handleClient();
          delay(100);
        }
      } else {
        break;
      }
    }
  }

  delay(100); // Small delay to prevent CPU spinning
}
