// Panel test for the Waveshare ESP32-S3-RGB-Matrix board + a 64x32 HUB75 panel.
// Cycles solid colors, then a border with corner markers and scrolling text,
// and logs each step over USB so we can see the board is alive.

#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>

#define PANEL_W 64
#define PANEL_H 32
#define BRIGHTNESS 60  // 0-255; kept low for testing

// HUB75 pins on the Waveshare ESP32-S3-RGB-Matrix (from Waveshare's examples).
HUB75_I2S_CFG::i2s_pins PINS = {
  4, 5, 6,     // R1 G1 B1
  7, 15, 16,   // R2 G2 B2
  18, 8, 3, 42, 9,  // A B C D E
  40, 2, 41    // LAT OE CLK
};

MatrixPanel_I2S_DMA *panel = nullptr;

void solid(uint8_t r, uint8_t g, uint8_t b, const char *name) {
  Serial.printf("Fill %s\n", name);
  panel->fillScreen(panel->color565(r, g, b));
  delay(800);
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("\nSmart Creation panel test starting");
  Serial.printf("PSRAM: %u bytes, flash: %u bytes\n", ESP.getPsramSize(), ESP.getFlashChipSize());

  HUB75_I2S_CFG cfg(PANEL_W, PANEL_H, 1, PINS);
  cfg.clkphase = false;
  cfg.driver = HUB75_I2S_CFG::FM6126A;  // same as Waveshare's examples

  panel = new MatrixPanel_I2S_DMA(cfg);
  if (!panel->begin()) {
    Serial.println("ERROR: panel->begin() failed");
    return;
  }
  panel->setBrightness8(BRIGHTNESS);
  panel->clearScreen();
  Serial.println("Panel started (64x32)");
}

void loop() {
  if (!panel) { delay(1000); return; }

  solid(255, 0, 0, "red");
  solid(0, 255, 0, "green");
  solid(0, 0, 255, "blue");
  solid(255, 255, 255, "white");

  // Border plus a different color in each corner: shows the panel isn't mirrored or shifted.
  Serial.println("Border + corners");
  panel->clearScreen();
  panel->drawRect(0, 0, PANEL_W, PANEL_H, panel->color565(255, 255, 0));
  panel->fillRect(1, 1, 4, 4, panel->color565(255, 0, 0));                         // top-left red
  panel->fillRect(PANEL_W - 5, 1, 4, 4, panel->color565(0, 255, 0));               // top-right green
  panel->fillRect(1, PANEL_H - 5, 4, 4, panel->color565(0, 0, 255));               // bottom-left blue
  panel->fillRect(PANEL_W - 5, PANEL_H - 5, 4, 4, panel->color565(255, 255, 255)); // bottom-right white
  delay(2500);

  Serial.println("Scrolling text");
  const char *msg = "SMART CREATION LLC";
  int textW = strlen(msg) * 6;
  panel->setTextWrap(false);
  panel->setTextSize(1);
  for (int x = PANEL_W; x > -textW; x--) {
    panel->clearScreen();
    panel->setCursor(x, (PANEL_H - 8) / 2);
    uint8_t hue = (uint8_t)(x * 4);
    panel->setTextColor(panel->color565(255, hue, 255 - hue));
    panel->print(msg);
    delay(30);
  }
}
