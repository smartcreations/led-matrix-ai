# To do

Next ideas for LED Matrix Studio, across this repo and [led-matrix-app](https://github.com/smartcreations/led-matrix-app).

- [ ] **Faster questions.** Merge the router and answer steps into one call when no web search is needed (saves ~1 s per question). `lib/router.ts`, `lib/deviceAnimation.ts`.
- [ ] **Phone relay mode.** When the screen has no usable WiFi (captive portals, travel), the app does the internet part: the screen sends the prompt to the phone over Bluetooth, the phone calls the server, and the animation comes back over Bluetooth. Firmware `bluetooth.cpp` + app `src/ble.ts`.
- [ ] **Voice in the app.** A mic button in the app that records and sends to `/api/device/voice`, as an alternative to "Hey bro".
- [ ] **MCP integrations.** First live source (Gmail or Slack) in the answer step, so "any new emails?" works. `lib/router.ts` `answerPrompt`.
