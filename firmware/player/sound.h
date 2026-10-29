// Short sound effects on the board's speaker (ES8311 codec + amplifier), sharing the I2S bus
// with the microphones.
#pragma once
#include <ESP_I2S.h>

enum Sound { SOUND_LISTENING, SOUND_THINKING };

// Sets up the speaker side of the codec. `i2s` must already run in full duplex.
bool soundBegin(I2SClass &i2s);

// Plays in the background; returns at once.
void playSound(Sound s);
