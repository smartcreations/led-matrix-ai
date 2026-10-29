// WiFi for the player: setup hotspot, a small web page for typing prompts, and requests to
// the LED Matrix Studio server, which writes and draws the animation (app/api/device).
#pragma once
#include <Arduino.h>

// Joins the saved WiFi, or starts the setup hotspot when there is none (or it can't connect).
void networkBegin();

// Serves the web pages. Call often from loop().
void networkLoop();

// The setup hotspot's name while it is running, else nullptr.
const char *setupHotspotName();

// This screen's address on the home network ("192.168.1.42"), or "" when not connected.
String networkAddress();

// Starts asking the server for an animation in the background. False if busy, offline or not set up.
bool requestAnimation(const String &prompt);
// Same, from what was said after the wake word: the server turns the speech into the prompt.
bool requestFromSpeech(const int16_t *samples, size_t count, uint32_t sampleRate);
bool requestBusy();

// A finished request: the whole server reply (upload header + pixels, ownership passes to the
// caller) or an error message. Returns false while nothing is waiting.
bool takeRequestResult(uint8_t *&data, size_t &length, String &title, String &error);

// Handles setup commands typed on the USB serial port. Returns false if `line` isn't one.
//   WIFI <name>|<password>   SERVER <https://...>   KEY <device key>   PROMPT <text>   NET
//   BYPASS <secret>   (Vercel deployment protection bypass, if the site is protected)
bool networkCommand(const String &line);
