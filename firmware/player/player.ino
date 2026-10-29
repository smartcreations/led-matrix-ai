// LED Matrix Studio player for the Waveshare ESP32-S3-RGB-Matrix + a 64x32 HUB75 panel.
//
// Receives an animation from the web app over USB (Web Serial), saves it to flash
// so it survives a power cycle, and loops it.
//
// Upload format (all little-endian):
//   "LMX1" | width u8 | height u8 | fps u8 | 0 u8 | frames u16 | 0 u16 | payload length u32
//   then frames * width * height pixels, RGB565, 2 bytes each, row by row.
// After a valid header the player replies "GO\n"; the sender then sends the pixels in
// 4096-byte chunks, waiting for a "+" after each. Ends with "OK <frames>\n" or "ERR <reason>\n".
//
// WiFi (see connection.h): a setup hotspot when no WiFi is saved, then a web page for typing
// prompts. The server writes and draws the animation and sends it back in the upload format.
//
// Voice: after the wake word (see wakeword.h), three "typing" dots bounce while it records what
// you say, until you stop talking. The server turns the speech into the prompt; a spinning
// rainbow shows while it draws. Saying nothing gets a surprise animation. Mic levels and wake
// word scores are logged on the serial port.

#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <ESP_I2S.h>
#include <LittleFS.h>
#include <Wire.h>
#include <esp_task_wdt.h>

#include "connection.h"
#include "sound.h"
#include "wakeword.h"

#define PANEL_W 64
#define PANEL_H 32
#define BRIGHTNESS 80     // 0-255
#define MAX_FRAMES 2000
#define SAVE_PATH "/anim.bin"
#define CHUNK 4096        // bytes per acknowledged chunk; keep in sync with lib/panelSerial.ts

// HUB75 pins on the Waveshare ESP32-S3-RGB-Matrix (from Waveshare's examples).
HUB75_I2S_CFG::i2s_pins PINS = {
  4, 5, 6,          // R1 G1 B1
  7, 15, 16,        // R2 G2 B2
  18, 8, 3, 42, 9,  // A B C D E
  40, 2, 41         // LAT OE CLK
};

// Audio on the same board (from Waveshare's BSP): ES7210 mic ADC, controlled over I2C.
#define I2C_SDA 47
#define I2C_SCL 48
#define I2S_MCLK 12
#define I2S_BCLK 43
#define I2S_WS 38
#define I2S_DIN 39
#define I2S_DOUT 21           // to the ES8311 speaker codec
#define ES7210_ADDR 0x40
#define MIC_RATE 16000
#define MAX_SPEECH_S 10        // longest prompt it records
#define END_SILENCE_MS 1000    // this much quiet after speaking ends the prompt
#define NO_SPEECH_MS 5000      // giving up when nothing is said after the wake word
#define MIN_SPEECH_MS 300      // shorter sounds (like the tail of "bro") don't count as the prompt

struct Header {
  char magic[4];
  uint8_t width, height, fps, reserved1;
  uint16_t frames, reserved2;
  uint32_t length;
} __attribute__((packed));

MatrixPanel_I2S_DMA *panel = nullptr;
uint16_t *anim = nullptr;   // frames * W * H pixels, in PSRAM
uint16_t animFrames = 0;
uint8_t animFps = 0;
uint16_t frameIndex = 0;
uint32_t nextFrameAt = 0;

I2SClass mic;
uint32_t messageUntil = 0;  // while millis() is before this, leave a text message on screen
bool messageForever = false;  // the WiFi setup message stays until setup restarts the screen
const char *messageLines[2] = {"", ""};
uint16_t messageColor = 0;
bool messageDrawn = false;

void showText(const char *line1, const char *line2, uint16_t color) {
  panel->clearScreen();
  panel->setTextSize(1);
  panel->setTextWrap(false);
  panel->setTextColor(color);
  panel->setCursor((PANEL_W - strlen(line1) * 6) / 2, 6);
  panel->print(line1);
  panel->setCursor((PANEL_W - strlen(line2) * 6) / 2, 18);
  panel->print(line2);
  panel->flipDMABuffer();
}

void drawFrame(uint16_t i) {
  const uint16_t *px = anim + (size_t)i * PANEL_W * PANEL_H;
  for (int y = 0; y < PANEL_H; y++)
    for (int x = 0; x < PANEL_W; x++)
      panel->drawPixel(x, y, px[y * PANEL_W + x]);
  panel->flipDMABuffer();
}

// Takes ownership of a buffer of `frames` frames and starts playing it.
void play(uint16_t *buf, uint16_t frames, uint8_t fps) {
  if (anim) free(anim);
  anim = buf;
  animFrames = frames;
  animFps = fps;
  frameIndex = 0;
  nextFrameAt = millis();
}

bool readExactly(uint8_t *dst, size_t len, uint32_t timeoutMs) {
  size_t got = 0;
  uint32_t last = millis();
  while (got < len) {
    int n = Serial.read(dst + got, len - got);
    if (n > 0) { got += n; last = millis(); }
    else if (millis() - last > timeoutMs) return false;
    else delay(1);
  }
  return true;
}

bool validHeader(const Header &h) {
  return memcmp(h.magic, "LMX1", 4) == 0 && h.width == PANEL_W && h.height == PANEL_H && h.frames > 0 &&
         h.frames <= MAX_FRAMES && h.fps > 0 && h.fps <= 60 && h.length == (uint32_t)h.frames * PANEL_W * PANEL_H * 2;
}

void saveToFlash(const Header &h, const uint16_t *buf) {
  File f = LittleFS.open(SAVE_PATH, "w");
  if (!f) { Serial.println("WARN could not save"); return; }
  f.write((const uint8_t *)&h, sizeof(h));
  // Flash writes pause both cores; small pieces with breaks let the other tasks keep up.
  for (uint32_t done = 0; done < h.length; done += 4096) {
    f.write((const uint8_t *)buf + done, min((uint32_t)4096, h.length - done));
    delay(3);
  }
  f.close();
}

bool loadFromFlash() {
  File f = LittleFS.open(SAVE_PATH, "r");
  if (!f) return false;
  Header h;
  bool ok = f.read((uint8_t *)&h, sizeof(h)) == sizeof(h) && validHeader(h);
  uint16_t *buf = ok ? (uint16_t *)ps_malloc(h.length) : nullptr;
  ok = buf && f.read((uint8_t *)buf, h.length) == h.length;
  f.close();
  if (!ok) { if (buf) free(buf); return false; }
  play(buf, h.frames, h.fps);
  Serial.printf("Loaded saved animation: %u frames at %u fps\n", h.frames, h.fps);
  return true;
}

// Looks for an upload on the USB serial port and receives it.
// Also takes text commands, one per line (see networkCommand in connection.h).
void checkForUpload() {
  static uint8_t matched = 0;
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      line.trim();
      if (line.length() && !networkCommand(line)) Serial.printf("ERR unknown command %s\n", line.c_str());
      line = "";
    } else if (line.length() < 200) {
      line += c;
    }
    matched = (c == "LMX1"[matched]) ? matched + 1 : (c == 'L' ? 1 : 0);
    if (matched < 4) continue;
    matched = 0;
    line = "";

    Header h;
    memcpy(h.magic, "LMX1", 4);
    if (!readExactly((uint8_t *)&h + 4, sizeof(h) - 4, 2000)) { Serial.println("ERR header timeout"); return; }
    if (h.width != PANEL_W || h.height != PANEL_H) { Serial.printf("ERR size must be %dx%d\n", PANEL_W, PANEL_H); return; }
    if (h.frames == 0 || h.frames > MAX_FRAMES || h.fps == 0 || h.fps > 60) { Serial.println("ERR bad frames or fps"); return; }
    if (h.length != (uint32_t)h.frames * PANEL_W * PANEL_H * 2) { Serial.println("ERR bad length"); return; }

    uint16_t *buf = (uint16_t *)ps_malloc(h.length);
    if (!buf) { Serial.println("ERR out of memory"); return; }
    showText("RECEIVING", "", panel->color565(0, 120, 255));

    // The USB serial port drops bytes when its buffer fills, so the sender waits for
    // "GO" and then for a "+" after each chunk before sending the next one.
    Serial.println("GO");
    for (uint32_t got = 0; got < h.length;) {
      uint32_t n = min((uint32_t)CHUNK, h.length - got);
      if (!readExactly((uint8_t *)buf + got, n, 3000)) {
        free(buf);
        Serial.println("ERR data timeout");
        return;
      }
      got += n;
      Serial.write('+');
      Serial.flush();
    }
    play(buf, h.frames, h.fps);
    Serial.printf("OK %u\n", h.frames);
    saveToFlash(h, anim);
  }
}

bool es7210Write(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(ES7210_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

// Same register sequence as Espressif's es7210 driver: standard I2S, 16-bit,
// 16 kHz with MCLK = 256 x rate, mic bias 2.87 V, 30 dB gain on all mics.
bool startMic() {
  Wire.begin(I2C_SDA, I2C_SCL, 400000);
  const uint8_t init[][2] = {
    {0x00, 0xFF}, {0x00, 0x32},              // reset
    {0x09, 0x30}, {0x0A, 0x30},              // power-up timing
    {0x23, 0x2A}, {0x22, 0x0A}, {0x21, 0x2A}, {0x20, 0x0A},  // high-pass filters
    {0x11, 0x60}, {0x12, 0x00},              // I2S, 16-bit, no TDM
    {0x40, 0xC3},                            // analog power
    {0x41, 0x70}, {0x42, 0x70},              // mic bias 2.87 V
    {0x43, 0x1A}, {0x44, 0x1A}, {0x45, 0x1A}, {0x46, 0x1A},  // 30 dB gain
    {0x47, 0x08}, {0x48, 0x08}, {0x49, 0x08}, {0x4A, 0x08},  // mic power
    {0x07, 0x20}, {0x02, 0xC1}, {0x04, 0x01}, {0x05, 0x00},  // 16 kHz from 4.096 MHz MCLK
    {0x06, 0x04},                            // DLL off
    {0x4B, 0x0F}, {0x4C, 0x0F},              // bias, ADC, PGA on
    {0x00, 0x71}, {0x00, 0x41},              // enable
  };
  Wire.setTimeOut(50);
  for (auto &r : init)
    if (!es7210Write(r[0], r[1])) { Serial.printf("WARN mic chip not answering at 0x%02X\n", ES7210_ADDR); return false; }
  Serial.println("mic chip configured");

  mic.setPins(I2S_BCLK, I2S_WS, I2S_DOUT, I2S_DIN, I2S_MCLK);  // full duplex: mics in, speaker out
  if (!mic.begin(I2S_MODE_STD, MIC_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO)) {
    Serial.println("WARN mic I2S did not start");
    return false;
  }
  return true;
}

// Listens on its own core so the animation keeps its timing. After the wake word it records
// until the speaker goes quiet, then hands the recording to loop() through `speechReady`.
// If the wake word model can't run, any voice counts as the wake word.
volatile bool listening = false;     // recording a prompt: the dots show
volatile bool speechReady = false;   // a recording waits in `speech` for loop() to send
volatile bool surpriseWanted = false;  // the wake word was heard but nothing after it
int16_t *speech = nullptr;           // MAX_SPEECH_S of 16 kHz mono samples, in PSRAM
volatile size_t speechSamples = 0;

void listenTask(void *) {
  static int16_t buf[640];  // 20 ms of stereo audio
  static int16_t mono[320];
  bool wakeWord = wakeWordBegin();
  speech = (int16_t *)ps_malloc(MAX_SPEECH_S * MIC_RATE * sizeof(int16_t));
  float noise = 50;
  uint8_t loudBlocks = 0;
  uint32_t lastLog = 0, recordStart = 0, speechMs = 0, quietMs = 0;
  size_t recorded = 0;
  for (;;) {
    size_t got = 0;
    if (i2s_channel_read(mic.rxChan(), buf, sizeof(buf), &got, 100) != ESP_OK || got < sizeof(buf)) continue;

    float sum = 0;
    for (int i = 0; i < 320; i++) {
      mono[i] = buf[i * 2];  // left channel: first microphone
      sum += (float)mono[i] * mono[i];
    }
    float level = sqrtf(sum / 320);
    bool loud = level > max(noise * 3, 40.0f);  // quiet rooms read about 10, speech 100+

    // The model keeps hearing everything, so its memory of "hey bro" fades while recording;
    // otherwise the same "hey bro" would trigger again right after.
    bool heard = wakeWord && wakeWordFeed(mono, 320);

    if (listening) {
      size_t room = MAX_SPEECH_S * MIC_RATE - recorded;
      memcpy(speech + recorded, mono, min((size_t)320, room) * sizeof(int16_t));
      recorded += min((size_t)320, room);
      if (loud) { speechMs += 20; quietMs = 0; } else quietMs += 20;
      bool spoke = speechMs >= MIN_SPEECH_MS;
      bool done = (spoke && quietMs >= END_SILENCE_MS) || recorded >= MAX_SPEECH_S * MIC_RATE;
      if (!spoke && millis() - recordStart > NO_SPEECH_MS) {
        listening = false;
        surpriseWanted = true;
        Serial.println("Heard nothing after the wake word");
      } else if (done) {
        speechSamples = recorded;
        speechReady = true;
        playSound(SOUND_THINKING);
        listening = false;
        Serial.printf("Recorded %.1f s\n", recorded / (float)MIC_RATE);
      }
      continue;
    }

    if (!loud) noise += (level - noise) * 0.02f;  // slowly follow the room's background
    if (!wakeWord) {
      loudBlocks = loud ? loudBlocks + 1 : 0;
      heard = loudBlocks == 5;
    }
    if (heard && !speechReady && speech) {
      Serial.println("WAKE WORD");
      playSound(SOUND_LISTENING);
      listening = true;
      recordStart = millis();
      recorded = speechMs = quietMs = 0;
    }
    if (millis() - lastLog > 5000) {
      if (wakeWord) Serial.printf("mic level %.0f, background %.0f, best wake word score %.2f\n", level, noise, wakeWordPeak());
      else Serial.printf("mic level %.0f, background %.0f\n", level, noise);
      lastLog = millis();
    }
  }
}

// A rainbow comet circling the middle: the screen is drawing what you asked for.
void drawSpinner(uint32_t t) {
  panel->clearScreen();
  float head = (t % 1000) / 1000.0f * 2 * PI;
  for (int i = 0; i < 14; i++) {
    float a = head - i * 0.22f;
    int x = 32 + (int)roundf(cosf(a) * 11), y = 16 + (int)roundf(sinf(a) * 11);
    float fade = 1 - i / 14.0f;
    uint8_t hue = (uint8_t)((t / 8 + i * 6) & 255);
    uint8_t r = (uint8_t)(max(0.0f, sinf(hue / 255.0f * 2 * PI)) * 255 * fade);
    uint8_t g = (uint8_t)(max(0.0f, sinf(hue / 255.0f * 2 * PI + 2.1f)) * 255 * fade);
    uint8_t b = (uint8_t)(max(0.0f, sinf(hue / 255.0f * 2 * PI + 4.2f)) * 255 * fade);
    panel->fillRect(x, y, 2, 2, panel->color565(r, g, b));
  }
  panel->flipDMABuffer();
}

// Three dots like a chat "typing" indicator: each one hops up and brightens in turn.
void drawDots(uint32_t t) {
  panel->clearScreen();
  for (int i = 0; i < 3; i++) {
    float phase = (t % 1200) / 1200.0f * 2 * PI - i * 1.1f;
    float up = max(0.0f, sinf(phase));  // 0 resting, 1 at the top of the hop
    int x = 22 + i * 8, y = 15 - (int)(up * 4 + 0.5f);
    uint8_t v = 110 + (uint8_t)(up * 145);
    uint16_t c = panel->color565(v, v, v);
    panel->fillRect(x + 1, y, 2, 4, c);  // 4x4 dot with the corners cut off
    panel->fillRect(x, y + 1, 4, 2, c);
  }
  panel->flipDMABuffer();
}

// Plays an animation the server sent back, or shows why it failed.
void takeServerAnimation() {
  uint8_t *data;
  size_t length;
  String title, error;
  if (!takeRequestResult(data, length, title, error)) return;
  Header h;
  if (!error.length() && length >= sizeof(h)) {
    memcpy(&h, data, sizeof(h));
    if (!validHeader(h) || length != sizeof(h) + h.length) error = "bad animation from server";
  } else if (!error.length()) {
    error = "empty reply";
  }
  if (error.length()) {
    if (data) free(data);
    Serial.printf("Server request failed: %s\n", error.c_str());
    showText("OOPS", "TRY AGAIN", panel->color565(255, 59, 47));
    messageUntil = millis() + 2500;
    return;
  }
  memmove(data, data + sizeof(h), h.length);  // pixels to the start of the buffer, which play() owns
  play((uint16_t *)data, h.frames, h.fps);
  playSound(SOUND_DONE);
  saveToFlash(h, anim);
  Serial.printf("Playing \"%s\": %u frames at %u fps\n", title.c_str(), h.frames, h.fps);
}

const char *SURPRISES[] = {
  "Surprise me with a fun, colorful animation of your choice",
  "Something cozy and calming",
  "A tiny scene with a cute animal doing something funny",
  "Something that looks great in a dark room",
  "A cool retro video game moment",
};

void setup() {
  Serial.setRxBufferSize(16384);
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);  // never stall the animation when no computer is reading the logs
  delay(300);
  Serial.println("\nLED Matrix Studio player starting");

  HUB75_I2S_CFG cfg(PANEL_W, PANEL_H, 1, PINS);
  cfg.clkphase = false;
  cfg.driver = HUB75_I2S_CFG::FM6126A;
  cfg.double_buff = true;
  panel = new MatrixPanel_I2S_DMA(cfg);
  if (!panel->begin()) { Serial.println("ERROR panel did not start"); return; }
  panel->setBrightness8(BRIGHTNESS);

  if (!LittleFS.begin(true)) Serial.println("WARN flash storage unavailable");
  bool hasAnimation = loadFromFlash();
  showText("WIFI", "...", panel->color565(0, 120, 255));
  networkBegin();
  if (setupHotspotName()) {
    messageLines[0] = "JOIN WIFI";
    messageLines[1] = setupHotspotName();
    messageColor = panel->color565(0, 120, 255);
    messageForever = true;
  } else if (networkAddress().length()) {
    showText("WIFI OK", "", panel->color565(0, 200, 80));
    messageUntil = millis() + 2000;
  }
  if (!hasAnimation && !setupHotspotName()) showText("READY", "HEY BRO", panel->color565(255, 59, 47));
  // Both cores stay busy on purpose (listening and requests on core 0, the animation loop on
  // core 1), so their idle tasks can go seconds without running while flash is written.
  // Don't reset the board for that.
  esp_task_wdt_config_t wdt = {.timeout_ms = 5000, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&wdt);
  bool micReady = startMic();
  if (micReady) soundBegin(mic);
  if (micReady) xTaskCreatePinnedToCore(listenTask, "listen", 8192, nullptr, 1, nullptr, 0);
  Serial.println(micReady ? "Mic listening" : "Mic unavailable");
  Serial.println("Ready for uploads");
}

void loop() {
  if (!panel) { delay(1000); return; }
  checkForUpload();
  networkLoop();
  if (takeJustConnected()) {
    messageForever = false;
    showText("WIFI OK", "", panel->color565(0, 200, 80));
    messageUntil = millis() + 2000;
  }
  takeServerAnimation();
  if (speechReady) {
    if (!requestFromSpeech(speech, speechSamples, MIC_RATE)) Serial.println("Can't send the prompt: no WiFi or server");
    speechReady = false;
  }
  if (surpriseWanted) {
    surpriseWanted = false;
    requestAnimation(SURPRISES[esp_random() % (sizeof(SURPRISES) / sizeof(SURPRISES[0]))]);
  }
  if (listening || requestBusy()) {
    static uint32_t lastDraw = 0;
    if (millis() - lastDraw >= 30) {
      listening ? drawDots(millis()) : drawSpinner(millis());
      lastDraw = millis();
    }
    nextFrameAt = millis();  // resume the animation right away afterwards
    messageDrawn = false;
    return;
  }
  if (messageForever) {
    if (!messageDrawn) showText(messageLines[0], messageLines[1], messageColor);  // again after the dots
    messageDrawn = true;
    return;
  }
  if ((int32_t)(messageUntil - millis()) > 0) {
    nextFrameAt = millis();
    return;
  }
  if (animFrames && (int32_t)(millis() - nextFrameAt) >= 0) {
    drawFrame(frameIndex);
    frameIndex = (frameIndex + 1) % animFrames;
    nextFrameAt += 1000 / animFps;
    if ((int32_t)(millis() - nextFrameAt) > 200) nextFrameAt = millis();  // don't race to catch up
  }
}
