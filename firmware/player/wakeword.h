// On-device wake word detection: the TensorFlow Lite Micro audio frontend turns 16 kHz audio
// into speech features, and a small streaming model (trained with microWakeWord, see
// wakeword_model.h) scores each 30 ms of them.
#pragma once
#include <stddef.h>
#include <stdint.h>

// Loads the model. Returns false (and logs why) if it can't run.
bool wakeWordBegin();

// Feeds 16 kHz mono samples. Returns true right after the wake word was heard.
bool wakeWordFeed(const int16_t *samples, size_t count);

// Highest score (0-1) seen since the last call, for tuning the cutoff from the logs.
float wakeWordPeak();
