#include "bluetooth.h"

#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>

#include "connection.h"

#define SERVICE_UUID  "6e1b0001-5ae1-4c1e-9d8a-1ed9f00d0001"
#define NETWORKS_UUID "6e1b0002-5ae1-4c1e-9d8a-1ed9f00d0001"
#define WIFI_UUID     "6e1b0003-5ae1-4c1e-9d8a-1ed9f00d0001"
#define STATUS_UUID   "6e1b0004-5ae1-4c1e-9d8a-1ed9f00d0001"
#define PROMPT_UUID   "6e1b0005-5ae1-4c1e-9d8a-1ed9f00d0001"

static BLECharacteristic *status = nullptr;
static bool appConnected = false;

class ServerEvents : public BLEServerCallbacks {
  void onConnect(BLEServer *) override {
    appConnected = true;
    refreshNetworks();
    Serial.println("Bluetooth: app connected");
  }
  void onDisconnect(BLEServer *) override {
    appConnected = false;
    BLEDevice::startAdvertising();  // be findable again
    Serial.println("Bluetooth: app disconnected");
  }
};

class NetworksRead : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *c) override { c->setValue(visibleNetworks().substring(0, 500)); }
};

class StatusRead : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *c) override { c->setValue(statusJson()); }
};

class WifiWrite : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String v = c->getValue();
    int nl = v.indexOf('\n');
    if (nl <= 0) return;
    joinWifi(v.substring(0, nl), v.substring(nl + 1));
  }
};

class PromptWrite : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String prompt = c->getValue();
    prompt.trim();
    if (prompt.length()) requestAnimation(prompt);
    bluetoothNotifyStatus();
  }
};

void bluetoothBegin(const char *name) {
  BLEDevice::init(name);
  BLEDevice::setMTU(512);  // room for the network list and status in one read
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerEvents());
  BLEService *service = server->createService(SERVICE_UUID);

  service->createCharacteristic(NETWORKS_UUID, BLECharacteristic::PROPERTY_READ)->setCallbacks(new NetworksRead());
  service->createCharacteristic(WIFI_UUID, BLECharacteristic::PROPERTY_WRITE)->setCallbacks(new WifiWrite());
  status = service->createCharacteristic(STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  status->setCallbacks(new StatusRead());
  status->addDescriptor(new BLE2902());
  service->createCharacteristic(PROMPT_UUID, BLECharacteristic::PROPERTY_WRITE)->setCallbacks(new PromptWrite());
  service->start();

  BLEAdvertising *ads = BLEDevice::getAdvertising();
  ads->addServiceUUID(SERVICE_UUID);
  ads->setScanResponse(true);  // the name goes in the scan response, next to the service
  BLEDevice::startAdvertising();
  Serial.printf("Bluetooth: advertising as %s\n", name);
}

void bluetoothNotifyStatus() {
  if (!status || !appConnected) return;
  status->setValue(statusJson());
  status->notify();
}
