#include "sound.h"

#include <Wire.h>

#define ES8311_ADDR 0x18
#define PA_ENABLE 11      // speaker amplifier on/off (from Waveshare's BSP)
#define RATE 16000
#define VOLUME 70         // percent

static I2SClass *out = nullptr;
static QueueHandle_t queue;

static bool writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(ES8311_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static uint8_t readReg(uint8_t reg) {
  Wire.beginTransmission(ES8311_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((uint16_t)ES8311_ADDR, (uint8_t)1, true);
  return Wire.available() ? Wire.read() : 0;
}

// Same steps as Waveshare's ES8311 driver, for 16 kHz with MCLK = 256 x rate, 16-bit samples.
static bool startCodec() {
  bool ok = writeReg(0x00, 0x1F);  // reset
  delay(20);
  ok &= writeReg(0x00, 0x00);
  ok &= writeReg(0x00, 0x80);  // power on, slave mode
  ok &= writeReg(0x01, 0x3F);  // clocks on, from MCLK
  ok &= writeReg(0x03, 0x10);                             // ADC oversampling
  ok &= writeReg(0x04, 0x10);                             // DAC oversampling
  ok &= writeReg(0x05, 0x00);                             // ADC and DAC dividers 1
  ok &= writeReg(0x06, (readReg(0x06) & 0xC0) | 0x03);    // BCLK = MCLK / 4, not inverted
  ok &= writeReg(0x07, readReg(0x07) & 0xC0);             // LRCK = MCLK / 256
  ok &= writeReg(0x08, 0xFF);
  ok &= writeReg(0x09, readReg(0x09) | 0x0C);             // 16-bit in
  ok &= writeReg(0x0A, readReg(0x0A) | 0x0C);             // 16-bit out
  ok &= writeReg(0x0D, 0x01);  // analog power
  ok &= writeReg(0x0E, 0x02);
  ok &= writeReg(0x12, 0x00);  // DAC on
  ok &= writeReg(0x13, 0x10);  // headphone/speaker driver on
  ok &= writeReg(0x1C, 0x6A);
  ok &= writeReg(0x37, 0x08);
  ok &= writeReg(0x32, VOLUME * 256 / 100 - 1);
  return ok;
}

// One tone with a soft attack and release, so it blips instead of clicking.
static void tone(float hz, int ms, float level) {
  static int16_t buf[2 * 160];  // 10 ms of stereo
  const int total = RATE * ms / 1000, fade = RATE / 200;  // 5 ms fades
  float phase = 0, step = 2 * PI * hz / RATE;
  for (int i = 0; i < total;) {
    int n = min(160, total - i);
    for (int k = 0; k < n; k++, i++) {
      float env = min(1.0f, min(i, total - i) / (float)fade);
      int16_t v = (int16_t)(sinf(phase) * level * env * 12000);
      buf[2 * k] = buf[2 * k + 1] = v;
      phase += step;
    }
    out->write((uint8_t *)buf, n * 4);
  }
}

static void silence(int ms) {
  static int16_t zeros[2 * 160] = {};
  for (int i = 0; i < ms / 10; i++) out->write((uint8_t *)zeros, sizeof(zeros));
}

static void soundTask(void *) {
  Sound s;
  for (;;) {
    if (xQueueReceive(queue, &s, portMAX_DELAY) != pdTRUE) continue;
    if (s == SOUND_LISTENING) {        // rising blip: "I'm listening"
      tone(880, 60, 0.8f);
      tone(1320, 90, 0.8f);
    } else if (s == SOUND_THINKING) {  // falling blip: "got it, working on it"
      tone(1320, 60, 0.6f);
      tone(990, 90, 0.6f);
    } else {                           // three quick notes up: "here it is"
      tone(1047, 60, 0.6f);
      tone(1319, 60, 0.6f);
      tone(1568, 110, 0.6f);
    }
    silence(60);
  }
}

bool soundBegin(I2SClass &i2s) {
  out = &i2s;
  pinMode(PA_ENABLE, OUTPUT);
  digitalWrite(PA_ENABLE, HIGH);
  if (!startCodec()) {
    Serial.println("WARN speaker codec not answering");
    return false;
  }
  queue = xQueueCreate(4, sizeof(Sound));
  xTaskCreatePinnedToCore(soundTask, "sound", 4096, nullptr, 2, nullptr, 0);
  return true;
}

void playSound(Sound s) {
  if (queue) xQueueSend(queue, &s, 0);
}
