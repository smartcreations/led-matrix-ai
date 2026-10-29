#include <cstdint>

#include "tensorflow/lite/experimental/microfrontend/lib/kiss_fft_common.h"

#define FIXED_POINT 16
namespace kissfft_fixed16 {
#include "kiss_fft.inc"
#include "tools/kiss_fftr.inc"
}  // namespace kissfft_fixed16
#undef FIXED_POINT
