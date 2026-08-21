#include <windows.h>
#include <winhttp.h>
#include <wincodec.h>
#include <objidl.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <icodecapi.h>
#include <codecapi.h>
#include <mferror.h>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

using namespace std::chrono_literals;

namespace {
std::atomic<bool> running{true};
std::atomic<int> viewers{0};
std::atomic<int> qualityMode{1}; // -1 auto, 0 weak, 1 balanced, 2 sharp
std::atomic<int> tunedWidth{0};
std::atomic<int> tunedFps{0};
std::atomic<int> tunedQuality{0};
std::atomic<int> videoMode{0}; // 0 jpeg, 1 h264, 2 both
std::atomic<bool> forceKeyframe{true};
std::atomic<unsigned long long> inputCount{0};
std::atomic<unsigned long long> inputFailures{0};
std::mutex sendMutex;
HINTERNET webSocket = nullptr;
bool testPattern = false;
std::unordered_set<WORD> activeKeys;
std::unordered_set<int> activeButtons;

struct ComInit {
  ComInit() { CoInitializeEx(nullptr, COINIT_MULTITHREADED); }
  ~ComInit() { CoUninitialize(); }
};

struct MediaFoundationInit {
  HRESULT hr = MFStartup(MF_VERSION);
  ~MediaFoundationInit() { if (SUCCEEDED(hr)) MFShutdown(); }
};

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int count = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring out(count, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), count);
  return out;
}

double jsonNumber(const std::string& text, const char* key, double fallback = 0) {
  const std::string needle = std::string("\"") + key + "\":";
  auto at = text.find(needle);
  if (at == std::string::npos) return fallback;
  at += needle.size();
  char* end = nullptr;
  const double value = std::strtod(text.c_str() + at, &end);
  return end == text.c_str() + at ? fallback : value;
}

std::string jsonString(const std::string& text, const char* key) {
  const std::string needle = std::string("\"") + key + "\":\"";
  auto at = text.find(needle);
  if (at == std::string::npos) return {};
  at += needle.size();
  const auto end = text.find('"', at);
  return end == std::string::npos ? std::string{} : text.substr(at, end - at);
}

bool sendMessage(WINHTTP_WEB_SOCKET_BUFFER_TYPE type, const void* data, DWORD size) {
  std::scoped_lock lock(sendMutex);
  if (!webSocket) return false;
  return WinHttpWebSocketSend(webSocket, type, const_cast<void*>(data), size) == NO_ERROR;
}

void sendText(const std::string& text) {
  sendMessage(WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, text.data(), static_cast<DWORD>(text.size()));
}

bool sendH264AccessUnit(const std::vector<unsigned char>& accessUnit, uint32_t timestamp) {
  if (accessUnit.empty()) return false;
  std::vector<unsigned char> packet(8 + accessUnit.size());
  packet[0] = 'D'; packet[1] = 'S'; packet[2] = 'H'; packet[3] = '2';
  packet[4] = static_cast<unsigned char>((timestamp >> 24) & 0xff);
  packet[5] = static_cast<unsigned char>((timestamp >> 16) & 0xff);
  packet[6] = static_cast<unsigned char>((timestamp >> 8) & 0xff);
  packet[7] = static_cast<unsigned char>(timestamp & 0xff);
  std::memcpy(packet.data() + 8, accessUnit.data(), accessUnit.size());
  return sendMessage(WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE, packet.data(), static_cast<DWORD>(packet.size()));
}

void emitInput(INPUT input) {
  if (SendInput(1, &input, sizeof(input)) == 1) inputCount += 1; else inputFailures += 1;
}

void releaseInputState() {
  for (const WORD vk : activeKeys) {
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = vk;
    input.ki.dwFlags = KEYEVENTF_KEYUP;
    emitInput(input);
  }
  activeKeys.clear();
  for (const int button : activeButtons) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    if (button == 3 || button == 4) {
      input.mi.dwFlags = MOUSEEVENTF_XUP;
      input.mi.mouseData = button == 4 ? XBUTTON2 : XBUTTON1;
    } else if (button == 2) {
      input.mi.dwFlags = MOUSEEVENTF_RIGHTUP;
    } else if (button == 1) {
      input.mi.dwFlags = MOUSEEVENTF_MIDDLEUP;
    } else {
      input.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    }
    emitInput(input);
  }
  activeButtons.clear();
}

WORD virtualKeyForCode(const std::string& code) {
  if (code.size() == 4 && code.rfind("Key", 0) == 0) return static_cast<WORD>(code[3]);
  if (code.size() == 6 && code.rfind("Digit", 0) == 0) return static_cast<WORD>(code[5]);
  if (code.rfind("Arrow", 0) == 0) {
    if (code == "ArrowLeft") return VK_LEFT; if (code == "ArrowRight") return VK_RIGHT;
    if (code == "ArrowUp") return VK_UP; if (code == "ArrowDown") return VK_DOWN;
  }
  if (code == "Enter") return VK_RETURN; if (code == "Escape") return VK_ESCAPE;
  if (code == "Backspace") return VK_BACK; if (code == "Tab") return VK_TAB;
  if (code == "Space") return VK_SPACE; if (code == "Delete") return VK_DELETE;
  if (code == "Home") return VK_HOME; if (code == "End") return VK_END;
  if (code == "PageUp") return VK_PRIOR; if (code == "PageDown") return VK_NEXT;
  if (code == "Insert") return VK_INSERT; if (code == "CapsLock") return VK_CAPITAL;
  if (code == "NumLock") return VK_NUMLOCK; if (code == "ScrollLock") return VK_SCROLL;
  if (code == "PrintScreen") return VK_SNAPSHOT; if (code == "Pause") return VK_PAUSE;
  if (code == "ContextMenu") return VK_APPS;
  if (code == "Semicolon") return VK_OEM_1; if (code == "Equal") return VK_OEM_PLUS;
  if (code == "Comma") return VK_OEM_COMMA; if (code == "Minus") return VK_OEM_MINUS;
  if (code == "Period") return VK_OEM_PERIOD; if (code == "Slash") return VK_OEM_2;
  if (code == "Backquote") return VK_OEM_3; if (code == "BracketLeft") return VK_OEM_4;
  if (code == "Backslash") return VK_OEM_5; if (code == "BracketRight") return VK_OEM_6;
  if (code == "Quote") return VK_OEM_7;
  if (code == "Numpad0") return VK_NUMPAD0; if (code == "Numpad1") return VK_NUMPAD1;
  if (code == "Numpad2") return VK_NUMPAD2; if (code == "Numpad3") return VK_NUMPAD3;
  if (code == "Numpad4") return VK_NUMPAD4; if (code == "Numpad5") return VK_NUMPAD5;
  if (code == "Numpad6") return VK_NUMPAD6; if (code == "Numpad7") return VK_NUMPAD7;
  if (code == "Numpad8") return VK_NUMPAD8; if (code == "Numpad9") return VK_NUMPAD9;
  if (code == "NumpadAdd") return VK_ADD; if (code == "NumpadSubtract") return VK_SUBTRACT;
  if (code == "NumpadMultiply") return VK_MULTIPLY; if (code == "NumpadDivide") return VK_DIVIDE;
  if (code == "NumpadDecimal") return VK_DECIMAL; if (code == "NumpadEnter") return VK_RETURN;
  if (code == "ShiftLeft") return VK_LSHIFT; if (code == "ShiftRight") return VK_RSHIFT;
  if (code == "ControlLeft") return VK_LCONTROL; if (code == "ControlRight") return VK_RCONTROL;
  if (code == "AltLeft") return VK_LMENU; if (code == "AltRight") return VK_RMENU;
  if (code == "MetaLeft") return VK_LWIN; if (code == "MetaRight") return VK_RWIN;
  if (code.size() >= 2 && code[0] == 'F') {
    const int n = std::atoi(code.c_str() + 1); if (n >= 1 && n <= 24) return static_cast<WORD>(VK_F1 + n - 1);
  }
  return 0;
}

void handleControl(const std::string& message) {
  const auto type = jsonString(message, "type");
  if (type == "input-reset") {
    releaseInputState();
    return;
  }
  if (type == "viewers") {
    viewers = static_cast<int>(jsonNumber(message, "count"));
    return;
  }
  if (type == "quality") {
    const auto mode = jsonString(message, "mode");
    qualityMode = mode == "auto" ? -1 : mode == "low" ? 0 : mode == "sharp" ? 2 : 1;
    return;
  }
  if (type == "tune") {
    tunedWidth = static_cast<int>(std::clamp(jsonNumber(message, "width"), 640.0, 1920.0));
    tunedFps = static_cast<int>(std::clamp(jsonNumber(message, "fps"), 5.0, 30.0));
    tunedQuality = static_cast<int>(std::clamp(jsonNumber(message, "jpegQuality"), 25.0, 85.0));
    return;
  }
  if (type == "video-mode") {
    const auto mode = jsonString(message, "mode");
    videoMode = mode == "h264" ? 1 : mode == "both" ? 2 : 0;
    if (videoMode.load() != 0) forceKeyframe = true;
    return;
  }
  if (type == "keyframe") {
    forceKeyframe = true;
    return;
  }
  INPUT input{};
  if (type == "pointer") {
    const auto action = jsonString(message, "action");
    input.type = INPUT_MOUSE;
    if (action == "move" || action == "down" || action == "up") {
      input.mi.dx = static_cast<LONG>(std::clamp(jsonNumber(message, "x"), 0.0, 1.0) * 65535.0);
      input.mi.dy = static_cast<LONG>(std::clamp(jsonNumber(message, "y"), 0.0, 1.0) * 65535.0);
      input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
      const int button = static_cast<int>(jsonNumber(message, "button"));
      if (button == 3 || button == 4) {
        input.mi.dwFlags |= action == "down" ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
        input.mi.mouseData = button == 4 ? XBUTTON2 : XBUTTON1;
      } else if (action == "down") {
        input.mi.dwFlags |= button == 2 ? MOUSEEVENTF_RIGHTDOWN : button == 1 ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
      } else if (action == "up") {
        input.mi.dwFlags |= button == 2 ? MOUSEEVENTF_RIGHTUP : button == 1 ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
      }
      if (action == "down") activeButtons.insert(button);
      if (action == "up") activeButtons.erase(button);
    } else if (action == "wheel") {
      const auto vertical = static_cast<LONG>(std::clamp(-jsonNumber(message, "deltaY"), -4096.0, 4096.0));
      const auto horizontal = static_cast<LONG>(std::clamp(jsonNumber(message, "deltaX"), -4096.0, 4096.0));
      if (vertical != 0) {
        input.mi.dwFlags = MOUSEEVENTF_WHEEL;
        input.mi.mouseData = static_cast<DWORD>(vertical);
        emitInput(input);
      }
      if (horizontal != 0) {
        input.mi = MOUSEINPUT{};
        input.mi.dwFlags = MOUSEEVENTF_HWHEEL;
        input.mi.mouseData = static_cast<DWORD>(horizontal);
        emitInput(input);
      }
      return;
    }
    emitInput(input);
  } else if (type == "key") {
    WORD vk = virtualKeyForCode(jsonString(message, "code"));
    if (!vk) {
      const auto key = utf8ToWide(jsonString(message, "key"));
      if (!key.empty()) {
        const SHORT translated = VkKeyScanW(key[0]);
        if (translated != -1) vk = static_cast<WORD>(translated & 0xff);
      }
    }
    if (!vk) return;
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = vk;
    if (jsonString(message, "action") == "up") {
      input.ki.dwFlags = KEYEVENTF_KEYUP;
      activeKeys.erase(vk);
    } else {
      activeKeys.insert(vk);
    }
    emitInput(input);
  }
}

void receiveLoop() {
  std::vector<unsigned char> buffer(64 * 1024);
  std::string text;
  while (running && webSocket) {
    DWORD read = 0;
    WINHTTP_WEB_SOCKET_BUFFER_TYPE type{};
    const DWORD error = WinHttpWebSocketReceive(webSocket, buffer.data(), static_cast<DWORD>(buffer.size()), &read, &type);
    if (error != NO_ERROR) break;
    if (type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) break;
    if (type == WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE || type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) {
      text.append(reinterpret_cast<char*>(buffer.data()), read);
      if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) { handleControl(text); text.clear(); }
    }
  }
  releaseInputState();
  running = false;
}

class Capturer {
 public:
  Capturer() {
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic_));
    screen_ = GetDC(nullptr);
    memory_ = CreateCompatibleDC(screen_);
  }
  ~Capturer() {
    if (bitmap_) { SelectObject(memory_, old_); DeleteObject(bitmap_); }
    if (memory_) DeleteDC(memory_);
    if (screen_) ReleaseDC(nullptr, screen_);
    if (wic_) wic_->Release();
  }

  bool capturePixels(int targetWidth, int& outWidth, int& outHeight) {
    static bool reported = false;
    auto report = [&](const char* step, HRESULT hr) {
      if (!reported) { std::cerr << "capture " << step << " failed: 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec << "\n"; reported = true; }
    };
    const int sourceWidth = GetSystemMetrics(SM_CXSCREEN);
    const int sourceHeight = GetSystemMetrics(SM_CYSCREEN);
    if (sourceWidth <= 0 || sourceHeight <= 0) return false;
    // NV12 and the H.264 encoder require even dimensions.
    outWidth = std::max(2, std::min(sourceWidth, targetWidth) & ~1);
    outHeight = std::max(2, (sourceHeight * outWidth / sourceWidth) & ~1);
    ensureBitmap(outWidth, outHeight);
    if (!memory_ || !bits_) return false;
    SetStretchBltMode(memory_, HALFTONE);
    SetBrushOrgEx(memory_, 0, 0, nullptr);
    if (testPattern) {
      auto* pixels = static_cast<unsigned char*>(bits_);
      for (int y = 0; y < outHeight; ++y) for (int x = 0; x < outWidth; ++x) {
        const auto at = (y * outWidth + x) * 4;
        pixels[at] = static_cast<unsigned char>(x * 255 / outWidth);
        pixels[at + 1] = static_cast<unsigned char>(y * 255 / outHeight);
        pixels[at + 2] = 42; pixels[at + 3] = 255;
      }
    } else if (!StretchBlt(memory_, 0, 0, outWidth, outHeight, screen_, 0, 0, sourceWidth, sourceHeight, SRCCOPY | CAPTUREBLT)) {
      report("StretchBlt", HRESULT_FROM_WIN32(GetLastError())); return false;
    }
    return true;
  }

  std::vector<unsigned char> encodeJpeg(int jpegQuality, int width, int height) {
    static bool reported = false;
    auto report = [&](const char* step, HRESULT hr) {
      if (!reported) { std::cerr << "JPEG " << step << " failed: 0x" << std::hex << static_cast<unsigned long>(hr) << std::dec << "\n"; reported = true; }
    };

    IWICBitmap* source = nullptr;
    if (!wic_) { report("WIC factory", E_NOINTERFACE); return {}; }
    HRESULT hr = wic_->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppBGR,
        width * 4, width * height * 4, static_cast<BYTE*>(bits_), &source);
    if (FAILED(hr)) { report("CreateBitmapFromMemory", hr); return {}; }
    IWICFormatConverter* converter = nullptr;
    hr = wic_->CreateFormatConverter(&converter);
    if (SUCCEEDED(hr)) hr = converter->Initialize(source, GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone,
          nullptr, 0.0, WICBitmapPaletteTypeCustom);
    if (FAILED(hr)) {
      report("format converter", hr);
      if (converter) converter->Release(); source->Release(); return {};
    }
    IStream* stream = nullptr;
    hr = CreateStreamOnHGlobal(nullptr, TRUE, &stream);
    if (FAILED(hr)) report("CreateStreamOnHGlobal", hr);
    IWICBitmapEncoder* encoder = nullptr;
    IWICBitmapFrameEncode* frame = nullptr;
    IPropertyBag2* props = nullptr;
    hr = wic_->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder);
    if (SUCCEEDED(hr)) hr = encoder->Initialize(stream, WICBitmapEncoderNoCache);
    if (SUCCEEDED(hr)) hr = encoder->CreateNewFrame(&frame, &props);
    if (SUCCEEDED(hr)) {
      PROPBAG2 option{}; option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
      VARIANT value{}; VariantInit(&value); value.vt = VT_R4; value.fltVal = jpegQuality / 100.0f;
      props->Write(1, &option, &value);
      hr = frame->Initialize(props); if (SUCCEEDED(hr)) hr = frame->SetSize(width, height);
      WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR; if (SUCCEEDED(hr)) hr = frame->SetPixelFormat(&format);
      if (SUCCEEDED(hr)) hr = frame->WriteSource(converter, nullptr); if (SUCCEEDED(hr)) hr = frame->Commit();
      if (SUCCEEDED(hr)) hr = encoder->Commit();
    }
    if (FAILED(hr)) report("JPEG encoder", hr);
    std::vector<unsigned char> result;
    HGLOBAL global = nullptr;
    if (SUCCEEDED(GetHGlobalFromStream(stream, &global)) && global) {
      const auto size = GlobalSize(global); const void* data = GlobalLock(global);
      if (data && size) result.assign(static_cast<const unsigned char*>(data), static_cast<const unsigned char*>(data) + size);
      if (data) GlobalUnlock(global);
    }
    if (props) props->Release(); if (frame) frame->Release(); if (encoder) encoder->Release();
    if (stream) stream->Release(); if (converter) converter->Release(); if (source) source->Release();
    return result;
  }

  std::vector<unsigned char> capture(int targetWidth, int jpegQuality, int& outWidth, int& outHeight) {
    if (!capturePixels(targetWidth, outWidth, outHeight)) return {};
    return encodeJpeg(jpegQuality, outWidth, outHeight);
  }

  const unsigned char* pixels() const { return static_cast<const unsigned char*>(bits_); }
  int width() const { return width_; }
  int height() const { return height_; }

 private:
  void ensureBitmap(int width, int height) {
    if (bitmap_ && width == width_ && height == height_) return;
    if (bitmap_) { SelectObject(memory_, old_); DeleteObject(bitmap_); }
    BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    bitmap_ = CreateDIBSection(memory_, &info, DIB_RGB_COLORS, &bits_, nullptr, 0);
    old_ = SelectObject(memory_, bitmap_); width_ = width; height_ = height;
  }
  IWICImagingFactory* wic_ = nullptr;
  HDC screen_ = nullptr; HDC memory_ = nullptr;
  HBITMAP bitmap_ = nullptr; HGDIOBJ old_ = nullptr; void* bits_ = nullptr;
  int width_ = 0; int height_ = 0;
};

// A small synchronous Media Foundation H.264 encoder. The helper feeds it
// NV12 frames produced from the capture DIB and sends the resulting access
// units to the gateway. Hardware MFTs are preferred when Windows exposes a
// synchronous one; the built-in software encoder remains the portable
// fallback. If no H.264 MFT is available, the caller keeps sending JPEG.
class H264Encoder {
 public:
  ~H264Encoder() { reset(); }

  bool ready() const { return mft_ != nullptr; }

  void requestKeyframe() { keyframe_ = true; }

  std::vector<unsigned char> encode(const unsigned char* bgra, int width, int height, int fps, int bitrate) {
    if (!bgra || width <= 0 || height <= 0 || fps <= 0) return {};
    if (!mft_ || width != width_ || height != height_ || fps != fps_ || bitrate != bitrate_) {
      if (!configure(width, height, fps, bitrate)) return {};
    }
    if (keyframe_) {
      setCodecValue(CODECAPI_AVEncVideoForceKeyFrame, static_cast<ULONG>(1));
      keyframe_ = false;
    }
    convertToNv12(bgra, width, height);

    IMFSample* inputSample = nullptr;
    IMFMediaBuffer* inputBuffer = nullptr;
    HRESULT hr = MFCreateSample(&inputSample);
    if (SUCCEEDED(hr)) hr = MFCreateMemoryBuffer(static_cast<DWORD>(nv12_.size()), &inputBuffer);
    if (SUCCEEDED(hr)) {
      BYTE* destination = nullptr;
      DWORD maxLength = 0;
      DWORD currentLength = 0;
      hr = inputBuffer->Lock(&destination, &maxLength, &currentLength);
      if (SUCCEEDED(hr)) {
        std::memcpy(destination, nv12_.data(), nv12_.size());
        inputBuffer->Unlock();
        hr = inputBuffer->SetCurrentLength(static_cast<DWORD>(nv12_.size()));
      }
    }
    if (SUCCEEDED(hr)) hr = inputSample->AddBuffer(inputBuffer);
    if (inputBuffer) inputBuffer->Release();
    if (SUCCEEDED(hr)) {
      const LONGLONG duration = 10'000'000LL / fps_;
      inputSample->SetSampleTime(static_cast<LONGLONG>(frameIndex_) * duration);
      inputSample->SetSampleDuration(duration);
      hr = mft_->ProcessInput(0, inputSample, 0);
      ++frameIndex_;
    }
    if (inputSample) inputSample->Release();
    if (FAILED(hr)) return {};

    std::vector<unsigned char> accessUnit;
    MFT_OUTPUT_STREAM_INFO streamInfo{};
    if (FAILED(mft_->GetOutputStreamInfo(0, &streamInfo))) return {};
    for (int attempt = 0; attempt < 8; ++attempt) {
      MFT_OUTPUT_DATA_BUFFER output{};
      output.dwStreamID = 0;
      IMFSample* suppliedSample = nullptr;
      if ((streamInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) == 0) {
        IMFMediaBuffer* outputBuffer = nullptr;
        const DWORD capacity = std::max<DWORD>(streamInfo.cbSize, static_cast<DWORD>(width_ * height_ * 2));
        if (FAILED(MFCreateSample(&suppliedSample)) || FAILED(MFCreateMemoryBuffer(capacity, &outputBuffer))) {
          if (outputBuffer) outputBuffer->Release();
          if (suppliedSample) suppliedSample->Release();
          break;
        }
        suppliedSample->AddBuffer(outputBuffer);
        outputBuffer->Release();
        output.pSample = suppliedSample;
      }
      DWORD status = 0;
      hr = mft_->ProcessOutput(0, 1, &output, &status);
      if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
        if (output.pSample) output.pSample->Release();
        if (output.pEvents) output.pEvents->Release();
        break;
      }
      if (FAILED(hr)) {
        if (output.pSample && output.pSample != suppliedSample) output.pSample->Release();
        if (suppliedSample) suppliedSample->Release();
        if (output.pEvents) output.pEvents->Release();
        break;
      }
      IMFSample* sample = output.pSample;
      if (sample) {
        IMFMediaBuffer* contiguous = nullptr;
        if (SUCCEEDED(sample->ConvertToContiguousBuffer(&contiguous))) {
          BYTE* bytes = nullptr;
          DWORD maxLength = 0;
          DWORD currentLength = 0;
          if (SUCCEEDED(contiguous->Lock(&bytes, &maxLength, &currentLength)) && bytes && currentLength > 0) {
            accessUnit.insert(accessUnit.end(), bytes, bytes + currentLength);
            contiguous->Unlock();
          }
          contiguous->Release();
        }
      }
      if (sample && sample != suppliedSample) sample->Release();
      if (suppliedSample) suppliedSample->Release();
      if (output.pEvents) output.pEvents->Release();
      if ((status & MFT_OUTPUT_DATA_BUFFER_INCOMPLETE) == 0) break;
    }
    return accessUnit;
  }

 private:
  void reset() {
    if (mft_) {
      mft_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
      mft_->Release();
      mft_ = nullptr;
    }
    if (codec_) { codec_->Release(); codec_ = nullptr; }
    width_ = height_ = fps_ = bitrate_ = 0;
    frameIndex_ = 0;
  }

  bool setCodecValue(const GUID& key, ULONG value) {
    if (!codec_) return false;
    VARIANT variant{};
    VariantInit(&variant);
    variant.vt = VT_UI4;
    variant.ulVal = value;
    const HRESULT hr = codec_->SetValue(&key, &variant);
    VariantClear(&variant);
    return SUCCEEDED(hr);
  }

  static HRESULT setCommonVideoType(IMFMediaType* type, const GUID& subtype, int width, int height, int fps, bool allSamplesIndependent) {
    if (!type) return E_INVALIDARG;
    HRESULT hr = type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    if (SUCCEEDED(hr)) hr = type->SetGUID(MF_MT_SUBTYPE, subtype);
    if (SUCCEEDED(hr)) hr = MFSetAttributeSize(type, MF_MT_FRAME_SIZE, width, height);
    if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(type, MF_MT_FRAME_RATE, fps, 1);
    if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(type, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    if (SUCCEEDED(hr) && allSamplesIndependent) hr = type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    return hr;
  }

  bool configure(int width, int height, int fps, int bitrate) {
    reset();
    IMFActivate** activates = nullptr;
    UINT32 count = 0;
    MFT_REGISTER_TYPE_INFO outputInfo{ MFMediaType_Video, MFVideoFormat_H264 };
    const DWORD baseFlags = MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_LOCALMFT | MFT_ENUM_FLAG_SORTANDFILTER;
    HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, baseFlags | MFT_ENUM_FLAG_HARDWARE,
        nullptr, &outputInfo, &activates, &count);
    if (FAILED(hr) || count == 0) {
      if (activates) { CoTaskMemFree(activates); activates = nullptr; }
      count = 0;
      hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, baseFlags, nullptr, &outputInfo, &activates, &count);
    }
    if (FAILED(hr) || count == 0) {
      if (activates) CoTaskMemFree(activates);
      return false;
    }

    for (UINT32 index = 0; index < count && !mft_; ++index) {
      IMFTransform* candidate = nullptr;
      if (FAILED(activates[index]->ActivateObject(IID_PPV_ARGS(&candidate))) || !candidate) continue;
      ICodecAPI* codec = nullptr;
      candidate->QueryInterface(IID_PPV_ARGS(&codec));
      // These are advisory: a vendor MFT may reject one of them while still
      // accepting the media types. Low-delay VBR and a short GOP are the key
      // properties for an interactive desktop stream.
      if (codec) {
        VARIANT mode{}; VariantInit(&mode); mode.vt = VT_UI4; mode.ulVal = eAVEncCommonRateControlMode_LowDelayVBR;
        codec->SetValue(&CODECAPI_AVEncCommonRateControlMode, &mode); VariantClear(&mode);
        setCodecValueOn(codec, CODECAPI_AVEncCommonMeanBitRate, static_cast<ULONG>(bitrate));
        setCodecValueOn(codec, CODECAPI_AVEncCommonLowLatency, static_cast<ULONG>(1));
        setCodecValueOn(codec, CODECAPI_AVEncCommonRealTime, static_cast<ULONG>(1));
        setCodecValueOn(codec, CODECAPI_AVEncVideoMaxKeyframeDistance, static_cast<ULONG>(std::max(15, fps * 2)));
      }
      IMFMediaType* output = nullptr;
      IMFMediaType* input = nullptr;
      hr = MFCreateMediaType(&output);
      // H.264 inter frames are intentionally not marked independent; setting
      // MF_MT_ALL_SAMPLES_INDEPENDENT on the compressed type can force an
      // all-intra stream or make an encoder reject the media type.
      if (SUCCEEDED(hr)) hr = setCommonVideoType(output, MFVideoFormat_H264, width, height, fps, false);
      if (SUCCEEDED(hr)) hr = output->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(bitrate));
      if (SUCCEEDED(hr)) hr = output->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_ConstrainedBase);
      if (SUCCEEDED(hr)) hr = output->SetUINT32(MF_MT_MPEG2_LEVEL, eAVEncH264VLevel3_1);
      if (SUCCEEDED(hr)) hr = candidate->SetOutputType(0, output, 0);
      if (SUCCEEDED(hr)) hr = MFCreateMediaType(&input);
      if (SUCCEEDED(hr)) hr = setCommonVideoType(input, MFVideoFormat_NV12, width, height, fps, true);
      if (SUCCEEDED(hr)) hr = input->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(width));
      if (SUCCEEDED(hr)) hr = input->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(bitrate));
      if (SUCCEEDED(hr)) hr = candidate->SetInputType(0, input, 0);
      if (output) output->Release();
      if (input) input->Release();
      if (SUCCEEDED(hr)) {
        hr = candidate->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        if (SUCCEEDED(hr)) hr = candidate->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        if (SUCCEEDED(hr)) {
          mft_ = candidate;
          codec_ = codec;
          width_ = width; height_ = height; fps_ = fps; bitrate_ = bitrate;
          frameIndex_ = 0;
          keyframe_ = true;
        } else {
          if (codec) codec->Release();
          candidate->Release();
        }
      } else {
        if (codec) codec->Release();
        candidate->Release();
      }
    }
    for (UINT32 index = 0; index < count; ++index) activates[index]->Release();
    CoTaskMemFree(activates);
    return mft_ != nullptr;
  }

  static void setCodecValueOn(ICodecAPI* codec, const GUID& key, ULONG value) {
    if (!codec) return;
    VARIANT variant{};
    VariantInit(&variant);
    variant.vt = VT_UI4;
    variant.ulVal = value;
    codec->SetValue(&key, &variant);
    VariantClear(&variant);
  }

  void convertToNv12(const unsigned char* bgra, int width, int height) {
    const size_t ySize = static_cast<size_t>(width) * height;
    nv12_.assign(ySize + ySize / 2, 0);
    auto clampByte = [](int value) { return static_cast<unsigned char>(std::clamp(value, 0, 255)); };
    auto pixel = [&](int x, int y, int channel) -> int {
      const auto at = (static_cast<size_t>(y) * width + x) * 4;
      return bgra[at + channel];
    };
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        const int b = pixel(x, y, 0), g = pixel(x, y, 1), r = pixel(x, y, 2);
        nv12_[static_cast<size_t>(y) * width + x] = clampByte(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
      }
    }
    unsigned char* uv = nv12_.data() + ySize;
    for (int y = 0; y < height; y += 2) {
      for (int x = 0; x < width; x += 2) {
        int r = 0, g = 0, b = 0;
        for (int dy = 0; dy < 2; ++dy) for (int dx = 0; dx < 2; ++dx) {
          const int px = std::min(x + dx, width - 1), py = std::min(y + dy, height - 1);
          b += pixel(px, py, 0); g += pixel(px, py, 1); r += pixel(px, py, 2);
        }
        r /= 4; g /= 4; b /= 4;
        const size_t at = static_cast<size_t>(y / 2) * width + x;
        uv[at] = clampByte(((-38 * r - 74 * g + 112 * b + 512) >> 8) + 128);
        uv[at + 1] = clampByte(((112 * r - 94 * g - 18 * b + 512) >> 8) + 128);
      }
    }
  }

  IMFTransform* mft_ = nullptr;
  ICodecAPI* codec_ = nullptr;
  std::vector<unsigned char> nv12_;
  int width_ = 0, height_ = 0, fps_ = 0, bitrate_ = 0;
  unsigned long long frameIndex_ = 0;
  bool keyframe_ = true;
};

HINTERNET connectWebSocket(const std::wstring& url, HINTERNET& session, HINTERNET& connection, HINTERNET& request) {
  std::wstring httpUrl = url;
  if (httpUrl.rfind(L"ws://", 0) == 0) httpUrl.replace(0, 5, L"http://");
  else if (httpUrl.rfind(L"wss://", 0) == 0) httpUrl.replace(0, 6, L"https://");
  URL_COMPONENTS parts{}; parts.dwStructSize = sizeof(parts);
  wchar_t host[256]{}; wchar_t path[2048]{}; wchar_t extra[2048]{};
  parts.lpszHostName = host; parts.dwHostNameLength = 255;
  parts.lpszUrlPath = path; parts.dwUrlPathLength = 2047;
  parts.lpszExtraInfo = extra; parts.dwExtraInfoLength = 2047;
  if (!WinHttpCrackUrl(httpUrl.c_str(), 0, 0, &parts)) return nullptr;
  session = WinHttpOpen(L"DSH Remote Host/1.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, nullptr, nullptr, 0);
  connection = WinHttpConnect(session, std::wstring(host, parts.dwHostNameLength).c_str(), parts.nPort, 0);
  const std::wstring target = std::wstring(path, parts.dwUrlPathLength) + std::wstring(extra, parts.dwExtraInfoLength);
  request = WinHttpOpenRequest(connection, L"GET", target.c_str(), nullptr, nullptr, nullptr,
      parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0);
  if (parts.nScheme == INTERNET_SCHEME_HTTPS) {
    DWORD flags = SECURITY_FLAG_IGNORE_CERT_CN_INVALID | SECURITY_FLAG_IGNORE_CERT_DATE_INVALID |
      SECURITY_FLAG_IGNORE_UNKNOWN_CA | SECURITY_FLAG_IGNORE_CERT_WRONG_USAGE;
    WinHttpSetOption(request, WINHTTP_OPTION_SECURITY_FLAGS, &flags, sizeof(flags));
  }
  WinHttpSetOption(request, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0);
  if (!WinHttpSendRequest(request, nullptr, 0, nullptr, 0, 0, 0) || !WinHttpReceiveResponse(request, nullptr)) return nullptr;
  return WinHttpWebSocketCompleteUpgrade(request, 0);
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  ComInit com;
  MediaFoundationInit mediaFoundation;
  std::wstring gateway;
  for (int i = 1; i < argc; ++i) {
    if (std::wstring(argv[i]) == L"--gateway" && i + 1 < argc) gateway = argv[++i];
    else if (std::wstring(argv[i]) == L"--test-pattern") testPattern = true;
  }
  if (gateway.empty()) { std::cerr << "missing --gateway\n"; return 2; }
  HINTERNET session = nullptr, connection = nullptr, request = nullptr;
  webSocket = connectWebSocket(gateway, session, connection, request);
  if (!webSocket) { std::cerr << "gateway connection failed: " << GetLastError() << "\n"; return 3; }
  std::cout << "desktop capture connected\n";
  std::thread receiver(receiveLoop);
  Capturer capturer;
  H264Encoder h264;
  auto statsAt = std::chrono::steady_clock::now();
  size_t bytes = 0; int frames = 0;
  int lastEncodeMs = 0;
  uint32_t videoTimestamp = 0;
  while (running) {
    const int mode = qualityMode.load();
    const int outputMode = videoMode.load();
    const bool autoTune = mode < 0 && tunedWidth.load() > 0;
    const int width = autoTune ? tunedWidth.load() : mode == 0 ? 960 : mode == 2 ? 1600 : 1280;
    const int targetFps = autoTune ? tunedFps.load() : mode == 0 ? 10 : mode == 2 ? 12 : 15;
    const int fps = viewers.load() > 0 ? std::clamp(targetFps, 5, 30) : 1;
    const int jpegQuality = autoTune ? tunedQuality.load() : mode == 0 ? 45 : mode == 2 ? 78 : 62;
    const auto began = std::chrono::steady_clock::now();
    int outWidth = 0, outHeight = 0;
    const bool captured = capturer.capturePixels(width, outWidth, outHeight);
    bool h264Sent = false;
    size_t frameBytes = 0;
    if (captured && outputMode != 0) {
      const int bitrate = std::clamp(outWidth * outHeight * fps / 8, 250'000, 4'000'000);
      if (forceKeyframe.exchange(false)) h264.requestKeyframe();
      const auto accessUnit = h264.encode(capturer.pixels(), outWidth, outHeight, fps, bitrate);
      if (!accessUnit.empty()) {
        h264Sent = sendH264AccessUnit(accessUnit, videoTimestamp);
        if (h264Sent) frameBytes += accessUnit.size() + 8;
      }
      videoTimestamp += static_cast<uint32_t>(std::max(1, 90'000 / std::max(1, fps)));
    }
    // During encoder startup (or on a Windows edition without an H.264 MFT),
    // keep JPEG flowing until the browser has a decodable media frame. In
    // `both` mode JPEG is deliberately sent as the immediate fallback.
    const bool sendJpeg = outputMode == 0 || outputMode == 2 || (outputMode == 1 && !h264Sent);
    auto image = sendJpeg && captured ? capturer.encodeJpeg(jpegQuality, outWidth, outHeight) : std::vector<unsigned char>{};
    lastEncodeMs = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - began).count());
    if (!image.empty() && sendMessage(WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE, image.data(), static_cast<DWORD>(image.size()))) {
      frameBytes += image.size();
    }
    if (frameBytes > 0) { bytes += frameBytes; ++frames; }
    const auto now = std::chrono::steady_clock::now();
    if (now - statsAt >= 1s) {
      const bool h264Active = outputMode != 0 && h264.ready();
      const char* codec = h264Active ? outputMode == 2 ? "h264+jpeg" : "h264" : "jpeg";
      sendText(std::string("{\"type\":\"stats\",\"codec\":\"") + codec + "\",\"width\":" + std::to_string(outWidth) +
        ",\"height\":" + std::to_string(outHeight) + ",\"fps\":" + std::to_string(frames) +
        ",\"bitrateKbps\":" + std::to_string(bytes * 8 / 1000) +
        ",\"encodeMs\":" + std::to_string(lastEncodeMs) +
        ",\"inputCount\":" + std::to_string(inputCount.load()) +
        ",\"inputFailures\":" + std::to_string(inputFailures.load()) + "}");
      statsAt = now; bytes = 0; frames = 0;
    }
    std::this_thread::sleep_until(began + std::chrono::milliseconds(1000 / fps));
  }
  if (webSocket) WinHttpWebSocketClose(webSocket, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
  if (receiver.joinable()) receiver.join();
  if (webSocket) WinHttpCloseHandle(webSocket); if (request) WinHttpCloseHandle(request);
  if (connection) WinHttpCloseHandle(connection); if (session) WinHttpCloseHandle(session);
  return 0;
}
