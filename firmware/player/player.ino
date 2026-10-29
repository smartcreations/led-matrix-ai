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

#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <LittleFS.h>

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

void saveToFlash(const Header &h, const uint16_t *buf) {
  File f = LittleFS.open(SAVE_PATH, "w");
  if (!f) { Serial.println("WARN could not save"); return; }
  f.write((const uint8_t *)&h, sizeof(h));
  f.write((const uint8_t *)buf, h.length);
  f.close();
}

bool loadFromFlash() {
  File f = LittleFS.open(SAVE_PATH, "r");
  if (!f) return false;
  Header h;
  bool ok = f.read((uint8_t *)&h, sizeof(h)) == sizeof(h) && memcmp(h.magic, "LMX1", 4) == 0 &&
            h.width == PANEL_W && h.height == PANEL_H && h.frames > 0 && h.frames <= MAX_FRAMES &&
            h.length == (uint32_t)h.frames * PANEL_W * PANEL_H * 2;
  uint16_t *buf = ok ? (uint16_t *)ps_malloc(h.length) : nullptr;
  ok = buf && f.read((uint8_t *)buf, h.length) == h.length;
  f.close();
  if (!ok) { if (buf) free(buf); return false; }
  play(buf, h.frames, h.fps);
  Serial.printf("Loaded saved animation: %u frames at %u fps\n", h.frames, h.fps);
  return true;
}

// Looks for an upload on the USB serial port and receives it.
void checkForUpload() {
  static uint8_t matched = 0;
  while (Serial.available()) {
    char c = Serial.read();
    matched = (c == "LMX1"[matched]) ? matched + 1 : (c == 'L' ? 1 : 0);
    if (matched < 4) continue;
    matched = 0;

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

void setup() {
  Serial.setRxBufferSize(16384);
  Serial.begin(115200);
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
  if (!loadFromFlash()) showText("READY", "send from app", panel->color565(255, 59, 47));
  Serial.println("Ready for uploads");
}

void loop() {
  if (!panel) { delay(1000); return; }
  checkForUpload();
  if (animFrames && (int32_t)(millis() - nextFrameAt) >= 0) {
    drawFrame(frameIndex);
    frameIndex = (frameIndex + 1) % animFrames;
    nextFrameAt += 1000 / animFps;
    if ((int32_t)(millis() - nextFrameAt) > 200) nextFrameAt = millis();  // don't race to catch up
  }
}
