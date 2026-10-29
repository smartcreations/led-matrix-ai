#include "connection.h"

#include <DNSServer.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_mac.h>

#define MAX_REPLY (8 * 1024 * 1024)  // biggest animation the player accepts, with room to spare
#define CONNECT_TIMEOUT_MS 15000

static WebServer web(80);
static DNSServer dns;
static char name[16];          // "LED-4F2A": hotspot name and .local address
static bool inSetup = false;
static String ssid, password, serverUrl, deviceKey, bypass;  // bypass: Vercel deployment protection
static String status = "Ready";

// One request at a time: the prompt goes to fetchTask, its result comes back under `lock`.
static volatile bool busy = false;
// The request fetchTask sends: a typed prompt (JSON) or recorded speech (WAV, in PSRAM).
static String pendingPath, pendingType, pendingJson;
static uint8_t *pendingAudio = nullptr;
static size_t pendingAudioLength = 0;
static SemaphoreHandle_t lock;
static bool resultReady = false;
static uint8_t *resultData = nullptr;
static size_t resultLength = 0;
static String resultTitle, resultError;

// ---- settings ----

static void loadSettings() {
  Preferences p;
  p.begin("lmx", true);
  ssid = p.getString("ssid", "");
  password = p.getString("pass", "");
  serverUrl = p.getString("server", "");
  deviceKey = p.getString("key", "");
  bypass = p.getString("bypass", "");
  p.end();
}

static void saveSetting(const char *key, const String &value) {
  Preferences p;
  p.begin("lmx", false);
  p.putString(key, value);
  p.end();
}

// ---- web pages ----

static String escapeHtml(const String &s) {
  String out;
  for (char c : s) {
    if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '&') out += "&amp;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

static String page(const String &title, const String &body) {
  return "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
         "<title>" + title + "</title><style>"
         "body{font:16px system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:20px;max-width:480px}"
         "h1{font-size:22px}input,select,textarea,button{font:inherit;width:100%;box-sizing:border-box;padding:10px;"
         "margin:6px 0 14px;border-radius:8px;border:1px solid #444;background:#1c1c1c;color:#eee}"
         "button{background:#ff3b2f;border:0;color:#fff;font-weight:600}.muted{color:#999;font-size:14px}a{color:#ff8a80}"
         "</style></head><body><h1>" + title + "</h1>" + body + "</body></html>";
}

// Nearby WiFi names, scanned once before the hotspot starts: scanning while it runs makes the
// radio leave the hotspot's channel and drops the phone.
static String networkOptions;

static void scanNetworks() {
  int found = WiFi.scanNetworks();
  networkOptions = "";
  for (int i = 0; i < found; i++) {
    String n = WiFi.SSID(i);
    if (n.length() && networkOptions.indexOf("value=\"" + escapeHtml(n) + "\"") < 0)
      networkOptions += "<option value=\"" + escapeHtml(n) + "\"" + (n == ssid ? " selected" : "") + ">" + escapeHtml(n) + "</option>";
  }
  WiFi.scanDelete();
  Serial.printf("Found %d WiFi networks\n", found);
}

static void sendSetupPage() {
  String options = networkOptions;
  web.send(200, "text/html", page("LED Matrix setup",
    "<form method=post action=/save>"
    "<label>WiFi network</label><select name=ssid>" + options + "<option value=''>Other (type below)</option></select>"
    "<input name=other placeholder='Network name, if not listed'>"
    "<label>WiFi password</label><input name=pass type=password>"
    "<details><summary class=muted>Advanced</summary>"
    "<label>Server</label><input name=server value=\"" + escapeHtml(serverUrl) + "\" placeholder='https://...'>"
    "<label>Device key</label><input name=key type=password placeholder='" + String(deviceKey.length() ? "(saved)" : "") + "'>"
    "</details><button>Save and connect</button></form>"
    "<p class=muted>The screen restarts and joins your WiFi. Then open <b>http://" + String(name) + ".local</b> on the same WiFi.</p>"));
}

static void sendHomePage() {
  web.send(200, "text/html", page("LED Matrix",
    "<form method=post action=/prompt><label>What should the screen show?</label>"
    "<textarea name=prompt rows=3 placeholder='Snow falling on a little house'></textarea><button>Show it</button></form>"
    "<p>" + escapeHtml(status) + "</p>"
    "<p class=muted>" + String(name) + " · " + WiFi.localIP().toString() + " · <a href=/settings>WiFi settings</a></p>"
    "<script>setTimeout(()=>{if(!document.querySelector('textarea').value)location.reload()},5000)</script>"));
}

static void handleSave() {
  String network = web.arg("ssid").length() ? web.arg("ssid") : web.arg("other");
  if (network.length()) { saveSetting("ssid", network); saveSetting("pass", web.arg("pass")); }
  if (web.arg("server").length()) saveSetting("server", web.arg("server"));
  if (web.arg("key").length()) saveSetting("key", web.arg("key"));
  web.send(200, "text/html", page("Saved", "<p>Connecting to <b>" + escapeHtml(network) + "</b>… The screen will show WIFI OK.</p>"));
  delay(1000);
  ESP.restart();
}

static void handlePrompt() {
  String prompt = web.arg("prompt");
  prompt.trim();
  if (prompt.length() && !requestAnimation(prompt) && !busy) status = "Can't reach the server: check the settings.";
  web.sendHeader("Location", "/");
  web.send(303);
}

// ---- WiFi ----

static void startSetupHotspot() {
  WiFi.mode(WIFI_AP_STA);
  scanNetworks();
  WiFi.softAP(name);
  if (ssid.length()) WiFi.begin(ssid.c_str(), password.c_str());  // keep trying the saved WiFi
  dns.start(53, "*", WiFi.softAPIP());  // every address leads to the setup page
  inSetup = true;
  WiFi.onEvent([](arduino_event_t *e) { Serial.println("Setup hotspot: a phone joined"); }, ARDUINO_EVENT_WIFI_AP_STACONNECTED);
  WiFi.onEvent([](arduino_event_t *e) { Serial.println("Setup hotspot: phone got an address"); }, ARDUINO_EVENT_WIFI_AP_STAIPASSIGNED);
  Serial.printf("Setup hotspot \"%s\" at http://%s\n", name, WiFi.softAPIP().toString().c_str());
}

static bool justConnected = false;

static void startMdns() {
  String host = String(name);
  host.toLowerCase();
  if (MDNS.begin(host.c_str())) MDNS.addService("http", "tcp", 80);
}

void networkBegin() {
  lock = xSemaphoreCreateMutex();
  loadSettings();
  uint8_t mac[6];
  esp_efuse_mac_get_default(mac);  // WiFi.macAddress() is all zeros before WiFi starts
  snprintf(name, sizeof(name), "LED-%02X%02X", mac[4], mac[5]);

  bool connected = false;
  if (ssid.length()) {
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(name);
    WiFi.setAutoReconnect(true);
    WiFi.begin(ssid.c_str(), password.c_str());
    for (uint32_t start = millis(); millis() - start < CONNECT_TIMEOUT_MS && WiFi.status() != WL_CONNECTED;) delay(100);
    connected = WiFi.status() == WL_CONNECTED;
    Serial.printf(connected ? "WiFi \"%s\" connected: http://%s\n" : "WiFi \"%s\" did not connect\n", ssid.c_str(),
                  WiFi.localIP().toString().c_str());
  }
  // If the saved WiFi is just slow or down (a router restart), the hotspot offers setup while
  // the screen keeps trying it in the background; networkLoop() switches over when it connects.
  if (connected) startMdns();
  else startSetupHotspot();

  web.on("/", [] {
    Serial.printf("Web page requested by %s\n", web.client().remoteIP().toString().c_str());
    inSetup ? sendSetupPage() : sendHomePage();
  });
  web.on("/settings", HTTP_GET, sendSetupPage);
  web.on("/save", HTTP_POST, handleSave);
  web.on("/prompt", HTTP_POST, handlePrompt);
  // Phones probe sites like connectivitycheck.gstatic.com when they join the hotspot; sending
  // those to our page makes them open it. Anything else at our own address is just missing.
  web.onNotFound([] {
    String self = (inSetup ? WiFi.softAPIP() : WiFi.localIP()).toString();
    Serial.printf("Web %s %s%s\n", web.method() == HTTP_GET ? "GET" : "other", web.hostHeader().c_str(), web.uri().c_str());
    if (web.hostHeader() == self || web.hostHeader().endsWith(".local")) {
      web.send(404, "text/plain", "Not found");
      return;
    }
    web.sendHeader("Location", "http://" + self + "/");
    web.send(302, "text/plain", "");
  });
  web.begin();
}

void networkLoop() {
  if (inSetup) {
    dns.processNextRequest();
    if (ssid.length() && WiFi.status() == WL_CONNECTED) {
      dns.stop();
      WiFi.softAPdisconnect(true);
      WiFi.mode(WIFI_STA);
      inSetup = false;
      startMdns();
      justConnected = true;
      Serial.printf("WiFi \"%s\" connected after all: http://%s\n", ssid.c_str(), WiFi.localIP().toString().c_str());
    }
  }
  web.handleClient();
}

bool takeJustConnected() {
  bool was = justConnected;
  justConnected = false;
  return was;
}

const char *setupHotspotName() { return inSetup ? name : nullptr; }

String networkAddress() { return WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : ""; }

// ---- requests to the server ----

static String jsonString(const String &s) {
  String out = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if ((uint8_t)c < 0x20) out += ' ';
    else out += c;
  }
  return out + "\"";
}

static String urlDecode(const String &s) {
  String out;
  for (size_t i = 0; i < s.length(); i++) {
    if (s[i] == '%' && i + 2 < s.length()) { out += (char)strtol(s.substring(i + 1, i + 3).c_str(), nullptr, 16); i += 2; }
    else out += s[i];
  }
  return out;
}

// Collects a download in PSRAM, growing as needed.
struct PsramSink : public Stream {
  uint8_t *data = nullptr;
  size_t length = 0, capacity = 0;
  bool failed = false;

  explicit PsramSink(int expected) { grow(expected > 0 ? expected : 512 * 1024); }
  bool grow(size_t want) {
    if (want > MAX_REPLY) return !(failed = true);
    uint8_t *bigger = (uint8_t *)ps_realloc(data, want);
    if (!bigger) return !(failed = true);
    data = bigger;
    capacity = want;
    return true;
  }
  size_t write(const uint8_t *buf, size_t n) override {
    if (failed || (length + n > capacity && !grow(max(min(capacity * 2, (size_t)MAX_REPLY), length + n)))) return 0;
    memcpy(data + length, buf, n);
    length += n;
    return n;
  }
  size_t write(uint8_t b) override { return write(&b, 1); }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
};

static void finish(uint8_t *data, size_t length, const String &title, const String &error) {
  xSemaphoreTake(lock, portMAX_DELAY);
  resultData = data;
  resultLength = length;
  resultTitle = title;
  resultError = error;
  resultReady = true;
  xSemaphoreGive(lock);
  status = error.length() ? "Error: " + error : "Showing “" + title + "”";
  busy = false;
}

static void fetch() {
  NetworkClientSecure secure;
  NetworkClient plain;
  HTTPClient http;
  String url = serverUrl + pendingPath;
  if (url.startsWith("https://")) {
    secure.useBuiltinCACertBundle();
    http.begin(secure, url);
  } else {
    http.begin(plain, url);
  }
  http.setConnectTimeout(10000);
  http.setTimeout(65000);  // the most HTTPClient allows; writing the animation can take Claude 30 s+
  http.addHeader("Content-Type", pendingType);
  http.addHeader("Authorization", "Bearer " + deviceKey);
  if (bypass.length()) http.addHeader("x-vercel-protection-bypass", bypass);
  const char *headers[] = {"X-Animation-Title", "X-Prompt"};
  http.collectHeaders(headers, 2);

  int code = pendingAudio ? http.POST(pendingAudio, pendingAudioLength) : http.POST(pendingJson);
  free(pendingAudio);
  pendingAudio = nullptr;
  if (code != 200) {
    String why = code == 422 ? "didn't catch that"
               : code > 0   ? "server answered " + String(code) + " " + http.getString().substring(0, 60)
                            : http.errorToString(code);
    http.end();
    finish(nullptr, 0, "", why);
    return;
  }

  // HTTPClient decodes chunked replies (whose length isn't known in advance) into the sink.
  PsramSink sink(http.getSize());
  int written = http.writeToStream(&sink);
  String title = urlDecode(http.header("X-Animation-Title"));
  if (http.hasHeader("X-Prompt")) Serial.printf("Heard: %s\n", urlDecode(http.header("X-Prompt")).c_str());
  http.end();
  if (written < 0 || sink.failed) {
    free(sink.data);
    finish(nullptr, 0, "", sink.failed ? "reply too big or out of memory" : "download failed: " + http.errorToString(written));
  } else {
    finish(sink.data, sink.length, title, "");
  }
}

static void fetchTask(void *) {
  fetch();  // its HTTP client is cleaned up before the task ends
  vTaskDelete(nullptr);
}

static bool startRequest() {
  if (xTaskCreatePinnedToCore(fetchTask, "fetch", 12288, nullptr, 1, nullptr, 0) == pdPASS) return true;
  free(pendingAudio);
  pendingAudio = nullptr;
  busy = false;
  return false;
}

static bool canRequest() { return !busy && WiFi.status() == WL_CONNECTED && serverUrl.length() && deviceKey.length(); }

bool requestAnimation(const String &prompt) {
  if (!canRequest()) return false;
  busy = true;
  pendingPath = "/api/device/animation";
  pendingType = "application/json";
  pendingJson = "{\"prompt\":" + jsonString(prompt) + ",\"mode\":\"rgb\"}";
  status = "Making “" + prompt + "”…";
  Serial.printf("Asking the server for: %s\n", prompt.c_str());
  return startRequest();
}

bool requestFromSpeech(const int16_t *samples, size_t count, uint32_t sampleRate) {
  if (!canRequest()) return false;
  // A WAV file: 44-byte header, then the 16-bit mono samples.
  uint32_t dataBytes = count * 2;
  uint8_t *wav = (uint8_t *)ps_malloc(44 + dataBytes);
  if (!wav) return false;
  auto put32 = [&](int at, uint32_t v) { memcpy(wav + at, &v, 4); };
  auto put16 = [&](int at, uint16_t v) { memcpy(wav + at, &v, 2); };
  memcpy(wav, "RIFF", 4);
  put32(4, 36 + dataBytes);
  memcpy(wav + 8, "WAVEfmt ", 8);
  put32(16, 16);
  put16(20, 1);               // PCM
  put16(22, 1);               // mono
  put32(24, sampleRate);
  put32(28, sampleRate * 2);  // bytes per second
  put16(32, 2);               // bytes per sample
  put16(34, 16);              // bits per sample
  memcpy(wav + 36, "data", 4);
  put32(40, dataBytes);
  memcpy(wav + 44, samples, dataBytes);

  busy = true;
  pendingPath = "/api/device/voice";
  pendingType = "audio/wav";
  pendingAudio = wav;
  pendingAudioLength = 44 + dataBytes;
  status = "Listening to what you said…";
  Serial.printf("Sending %.1f s of speech to the server\n", count / (float)sampleRate);
  return startRequest();
}

bool requestBusy() { return busy; }

bool takeRequestResult(uint8_t *&data, size_t &length, String &title, String &error) {
  if (!resultReady) return false;
  xSemaphoreTake(lock, portMAX_DELAY);
  data = resultData;
  length = resultLength;
  title = resultTitle;
  error = resultError;
  resultReady = false;
  resultData = nullptr;
  xSemaphoreGive(lock);
  return true;
}

// ---- USB setup commands ----

bool networkCommand(const String &line) {
  int space = line.indexOf(' ');
  String cmd = space < 0 ? line : line.substring(0, space);
  String arg = space < 0 ? "" : line.substring(space + 1);
  arg.trim();
  if (cmd == "WIFI") {
    int bar = arg.indexOf('|');
    saveSetting("ssid", bar < 0 ? arg : arg.substring(0, bar));
    saveSetting("pass", bar < 0 ? "" : arg.substring(bar + 1));
    Serial.println("OK WiFi saved, restarting");
    delay(200);
    ESP.restart();
  } else if (cmd == "SERVER") {
    if (arg.endsWith("/")) arg.remove(arg.length() - 1);
    saveSetting("server", arg);
    serverUrl = arg;
    Serial.println("OK server saved");
  } else if (cmd == "KEY") {
    saveSetting("key", arg);
    deviceKey = arg;
    Serial.println("OK key saved");
  } else if (cmd == "BYPASS") {
    saveSetting("bypass", arg);
    bypass = arg;
    Serial.println("OK bypass saved");
  } else if (cmd == "PROMPT") {
    Serial.println(requestAnimation(arg) ? "OK asking" : "ERR busy, offline or not set up");
  } else if (cmd == "NET") {
    Serial.printf("name %s, wifi \"%s\" %s, address %s, server %s, key %s\n", name, ssid.c_str(),
                  WiFi.status() == WL_CONNECTED ? "connected" : "not connected", networkAddress().c_str(),
                  serverUrl.c_str(), deviceKey.length() ? "set" : "missing");
  } else {
    return false;
  }
  return true;
}
