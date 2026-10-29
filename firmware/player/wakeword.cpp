#include "wakeword.h"

#include <Arduino.h>

#include <MicroFrontend.h>

#include "tensorflow/lite/micro/micro_allocator.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"
#include "tensorflow/lite/schema/schema_generated.h"
#include "wakeword_model.h"

// Feature settings the models are trained with (same as pymicro-features).
#define FEATURES 40
#define SAMPLE_RATE 16000
#define FEATURE_SCALE 0.0390625f
#define COOLDOWN_MS 1500  // ignore the tail of the same "hey bro"

static FrontendState frontend;
static tflite::MicroInterpreter *interpreter = nullptr;
static TfLiteTensor *input = nullptr;
static int stride = 0;           // feature frames the model takes per run
static int pendingFrames = 0;
static uint8_t scores[WAKEWORD_WINDOW];
static int scoreIndex = 0;
static float peak = 0;
static uint32_t quietUntil = 0;

bool wakeWordBegin() {
  FrontendConfig config;
  config.window.size_ms = 30;
  config.window.step_size_ms = 10;
  config.filterbank.num_channels = FEATURES;
  config.filterbank.lower_band_limit = 125.0;
  config.filterbank.upper_band_limit = 7500.0;
  config.noise_reduction.smoothing_bits = 10;
  config.noise_reduction.even_smoothing = 0.025;
  config.noise_reduction.odd_smoothing = 0.06;
  config.noise_reduction.min_signal_remaining = 0.05;
  config.pcan_gain_control.enable_pcan = 1;
  config.pcan_gain_control.strength = 0.95;
  config.pcan_gain_control.offset = 80.0;
  config.pcan_gain_control.gain_bits = 21;
  config.log_scale.enable_log = 1;
  config.log_scale.scale_shift = 6;
  if (!FrontendPopulateState(&config, &frontend, SAMPLE_RATE)) {
    Serial.println("WARN wake word: audio frontend did not start");
    return false;
  }

  static tflite::MicroMutableOpResolver<20> ops;
  ops.AddCallOnce();
  ops.AddVarHandle();
  ops.AddReshape();
  ops.AddReadVariable();
  ops.AddStridedSlice();
  ops.AddConcatenation();
  ops.AddAssignVariable();
  ops.AddConv2D();
  ops.AddMul();
  ops.AddAdd();
  ops.AddMean();
  ops.AddFullyConnected();
  ops.AddLogistic();
  ops.AddQuantize();
  ops.AddDepthwiseConv2D();
  ops.AddAveragePool2D();
  ops.AddMaxPool2D();
  ops.AddPad();
  ops.AddPack();
  ops.AddSplitV();

  // The streaming model keeps its state in resource variables, which also live in the arena.
  // Internal RAM is fastest; PSRAM works too when WiFi and Bluetooth have taken most of it.
  const size_t arenaSize = WAKEWORD_ARENA + 4096;
  uint8_t *arena = (uint8_t *)heap_caps_aligned_alloc(16, arenaSize, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!arena) arena = (uint8_t *)heap_caps_aligned_alloc(16, arenaSize, MALLOC_CAP_SPIRAM);
  if (!arena) { Serial.println("WARN wake word: no memory for the model"); return false; }
  tflite::MicroAllocator *allocator = tflite::MicroAllocator::Create(arena, arenaSize);
  tflite::MicroResourceVariables *variables = tflite::MicroResourceVariables::Create(allocator, 20);
  interpreter = new tflite::MicroInterpreter(tflite::GetModel(WAKEWORD_MODEL), ops, allocator, variables);
  if (interpreter->AllocateTensors() != kTfLiteOk) {
    Serial.println("WARN wake word: model did not load");
    interpreter = nullptr;
    return false;
  }
  input = interpreter->input(0);
  stride = input->dims->data[1];
  Serial.printf("Wake word \"%s\" ready (%d frames per step, %u bytes of arena used)\n", WAKEWORD_NAME, stride,
                (unsigned)interpreter->arena_used_bytes());
  return true;
}

// Runs the model on the frames collected in the input tensor and returns its score, 0-1.
static float runModel() {
  if (interpreter->Invoke() != kTfLiteOk) return 0;
  TfLiteTensor *out = interpreter->output(0);
  if (out->type == kTfLiteUInt8) return out->data.uint8[0] / 255.0f;
  return (out->data.int8[0] - out->params.zero_point) * out->params.scale;
}

bool wakeWordFeed(const int16_t *samples, size_t count) {
  if (!interpreter) return false;
  bool heard = false;
  while (count > 0) {
    size_t used = 0;
    FrontendOutput features = FrontendProcessSamples(&frontend, samples, count, &used);
    samples += used;
    count -= used;
    if (features.size != FEATURES) continue;

    // Quantize this frame into its slot of the model's int8 input.
    int8_t *slot = input->data.int8 + pendingFrames * FEATURES;
    for (int i = 0; i < FEATURES; i++) {
      int32_t q = lroundf(features.values[i] * FEATURE_SCALE / input->params.scale) + input->params.zero_point;
      slot[i] = (int8_t)constrain(q, -128, 127);
    }
    if (++pendingFrames < stride) continue;
    pendingFrames = 0;

    float score = runModel();
    peak = max(peak, score);
    scores[scoreIndex] = (uint8_t)(score * 255);
    scoreIndex = (scoreIndex + 1) % WAKEWORD_WINDOW;
    uint32_t sum = 0;
    for (int i = 0; i < WAKEWORD_WINDOW; i++) sum += scores[i];
    if ((int32_t)(millis() - quietUntil) >= 0 && sum / (255.0f * WAKEWORD_WINDOW) > WAKEWORD_CUTOFF) {
      memset(scores, 0, sizeof(scores));
      quietUntil = millis() + COOLDOWN_MS;
      heard = true;
    }
  }
  return heard;
}

float wakeWordPeak() {
  float p = peak;
  peak = 0;
  return p;
}
