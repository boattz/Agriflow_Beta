#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>
#include "config_portal.h"   // WiFi + server IP via captive portal (NVS-persisted)

// ==================== Config (loaded from NVS) ===================
DeviceConfig cfg;

// ==================== Sensor ==================
const int moisturePin = 34;
const int servoPin = 18;

// ==================== Calibration ====================
const int dryValue = 3200;
const int wetValue = 800;

// ==================== Config (synced from dashboard) ====================
int openThreshold = 40;
int wateringMinutes = 3;

// ==================== Servo ====================
Servo valveServo;
bool valveOpen = false;
unsigned long valveStartTime = 0;

// ==================== Reset Button ====================
unsigned long resetPressedSince = 0;

// ==================== Send Timer ====================
unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL = 5000; // 10 seconds

// ==================== WiFi Connect ====================
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.print("Connecting to WiFi: ");
  Serial.println(cfg.wifiSsid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (++attempts > 40) {
      Serial.println("\n❌ WiFi failed after retries — opening config portal.");
      // Credentials may be wrong/changed: wipe & reconfigure.
      clearConfig();
      startConfigPortal();
      ESP.restart();
    }
  }

  Serial.println();
  Serial.println("================================");
  Serial.println("WiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
  Serial.println("================================");
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
    if (val >= 1 && val <= 60 && val != wateringMinutes) {
      wateringMinutes = val;
      Serial.print("[CONFIG] wateringMinutes -> ");
      Serial.println(wateringMinutes);
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

// ==================== Setup ====================
void setup() {
  Serial.begin(115200);
  delay(300);

  valveServo.attach(servoPin);
  valveServo.write(0);

  // Reset button is on the BOOT pin.
  pinMode(CP_RESET_PIN, INPUT_PULLUP);

  // First boot (or after reset) → open the captive portal to configure.
  if (!loadConfig(cfg)) {
    startConfigPortal();
    // After saving, reload then reboot so everything starts clean.
    if (!loadConfig(cfg)) ESP.restart();
  }

  connectWiFi();

  // Test internet connectivity
  Serial.println("[NET] Testing internet...");
  WiFiClient testClient;
  if (testClient.connect("agriflow-mvt7.onrender.com", 443)) {
    Serial.println("[NET] Render reachable ✓");
    testClient.stop();
  } else {
    Serial.println("[NET] Render UNREACHABLE — check WiFi/internet");
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

  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  // ---------- Read Sensor ----------
  int rawValue = analogRead(moisturePin);
  int moisturePercent = map(rawValue, dryValue, wetValue, 0, 100);
  moisturePercent = constrain(moisturePercent, 0, 100);

  // ---------- Valve Control ----------
  // Open: moisture drops below threshold & valve is closed
  if (!valveOpen && moisturePercent < openThreshold) {
    Serial.println("Soil Dry -> Open Valve");
    valveServo.write(90);
    valveOpen = true;
    valveStartTime = millis();
  }

  // Close: timer expired
  if (valveOpen) {
    if (millis() - valveStartTime >= (unsigned long)wateringMinutes * 60000UL) {
      Serial.println("Watering Complete -> Close Valve");
      valveServo.write(0);
      valveOpen = false;
    }
  }

  // ---------- Serial Monitor ----------
  Serial.print("Raw: ");        Serial.print(rawValue);
  Serial.print(" | Moisture: ");Serial.print(moisturePercent); Serial.print("%");
  Serial.print(" | Threshold: ");Serial.print(openThreshold); Serial.print("%");
  Serial.print(" | Water: ");   Serial.print(wateringMinutes); Serial.print("min");
  Serial.print(" | Valve: ");   Serial.print(valveOpen ? "OPEN" : "CLOSE");

  if (valveOpen) {
    unsigned long remain = ((unsigned long)wateringMinutes * 60000UL - (millis() - valveStartTime)) / 1000UL;
    Serial.print(" | Remaining: "); Serial.print(remain); Serial.print("s");
  }
  Serial.println();

  // ---------- Send to Dashboard (every 10 seconds) ----------
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
      HTTPClient http;
      WiFiClientSecure secureClient;
      WiFiClient plainClient;

      if (cfg.serverUrl.startsWith("https")) {
        secureClient.setInsecure();
        secureClient.setTimeout(30000);
        http.begin(secureClient, cfg.serverUrl);
      } else {
        http.begin(plainClient, cfg.serverUrl);
      }
      http.addHeader("Content-Type", "application/json");
      http.setTimeout(30000);

      httpCode = http.POST(json);

      if (httpCode == 200) {
        String response = http.getString();
        parseConfig(response);
        Serial.println("[OK] Sent + config synced");
      } else {
        Serial.print("[ERR] HTTP "); Serial.println(httpCode);
      }
      http.end();

      if (httpCode != 200 && retries < 3) {
        retries++;
        int waitSec = retries * 10;
        Serial.print("[RETRY "); Serial.print(retries); Serial.print("] wait ");
        Serial.print(waitSec); Serial.println("s ...");
        delay(waitSec * 1000UL);
      } else {
        break;
      }
    }
  }

  delay(100); // Small delay to prevent CPU spinning
}
