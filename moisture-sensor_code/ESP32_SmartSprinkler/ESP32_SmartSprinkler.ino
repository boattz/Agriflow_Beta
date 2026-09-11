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

// ==================== Servo (smooth, anti-jerk) ====================
// Tune these to your valve: if 90 hits the hard stop, lower to ~70.
const int VALVE_CLOSED_ANGLE = 0;
const int VALVE_OPEN_ANGLE = 70;
const int SERVO_MIN_US = 500;
const int SERVO_MAX_US = 2400;
const int SERVO_STEP_DEG = 2;      // deg per step
const int SERVO_STEP_MS = 20;      // ms per step → 0→70 takes ~0.7s
const unsigned long REOPEN_COOLDOWN_MS = 5UL * 60UL * 1000UL; // no auto re-open within 5 min

Servo valveServo;
bool valveOpen = false;
unsigned long valveStartTime = 0;
int currentAngle = VALVE_CLOSED_ANGLE;
bool servoAttached = false;
unsigned long lastValveCloseTime = 0;

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
}

// ==================== Reset Button ====================
unsigned long resetPressedSince = 0;

// ==================== Send Timer ====================
unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL = 5000; // 5 seconds

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

// ==================== Setup ====================
void setup() {
  Serial.begin(115200);
  delay(300);

  valveServo.attach(servoPin, SERVO_MIN_US, SERVO_MAX_US);
  servoAttached = true;
  valveServo.write(currentAngle);
  delay(500);
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
    if (!manualActive() && valveOpen) lastValveCloseTime = millis();
  } else {
    // Auto: moisture drops below threshold & valve closed & cooldown passed
    bool cooldownOk = (lastValveCloseTime == 0) ||
                      (millis() - lastValveCloseTime >= REOPEN_COOLDOWN_MS);
    if (!valveOpen && moisturePercent < openThreshold && cooldownOk) {
      Serial.println("Soil Dry -> Open Valve");
      openValve();
    } else if (!valveOpen && moisturePercent < openThreshold && !cooldownOk) {
      Serial.println("Soil Dry but in cooldown -> wait");
    }

    // Close: timer expired
    if (valveOpen) {
      if (millis() - valveStartTime >= (unsigned long)wateringMinutes * 60000UL) {
        Serial.println("Watering Complete -> Close Valve");
        closeValve();
      }
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
