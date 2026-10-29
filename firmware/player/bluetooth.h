// Bluetooth (BLE) for the phone app: the screen advertises itself under its name ("LED-9990")
// so the app finds it nearby, and offers one service to set up WiFi and send prompts.
//
// Service 6e1b0001-5ae1-4c1e-9d8a-1ed9f00d0001, characteristics (UTF-8 text):
//   ...0002 networks  read          WiFi names the screen can see, one per line
//   ...0003 wifi      write         "<name>\n<password>": saves and joins that WiFi
//   ...0004 status    read, notify  JSON: {"name","wifi":"connected|connecting|failed|none",
//                                         "ssid","ip","busy"}
//   ...0005 prompt    write         text: the screen asks the server for that animation
// Keep in sync with the app (led-matrix-app, src/ble.ts).
#pragma once

void bluetoothBegin(const char *name);

// Sends the current status to a connected app. Call when WiFi or the request state changes.
void bluetoothNotifyStatus();
