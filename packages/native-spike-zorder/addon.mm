// addon.mm — Spike 3: plain NSView on top of Electron's WKWebView
// Node-API only (NAPI), no raw v8. ARC enabled via -fobjc-arc.

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>

// ---------------------------------------------------------------------------
// SpikeHostView — the translucent red NSView
// ---------------------------------------------------------------------------

@interface SpikeHostView : NSView
@end

@implementation SpikeHostView

- (BOOL)isFlipped {
  // YES → y=0 is the top-left, matching renderer/CSS coordinate space.
  return YES;
}

- (BOOL)acceptsFirstResponder {
  return YES;
}

- (void)mouseDown:(NSEvent *)event {
  NSPoint loc = [self convertPoint:event.locationInWindow fromView:nil];
  NSLog(@"[spike-zorder] mouseDown @ (%.1f, %.1f)", loc.x, loc.y);
}

- (void)mouseUp:(NSEvent *)event {
  NSPoint loc = [self convertPoint:event.locationInWindow fromView:nil];
  NSLog(@"[spike-zorder] mouseUp @ (%.1f, %.1f)", loc.x, loc.y);
}

- (void)mouseDragged:(NSEvent *)event {
  NSPoint loc = [self convertPoint:event.locationInWindow fromView:nil];
  NSLog(@"[spike-zorder] mouseDragged @ (%.1f, %.1f)", loc.x, loc.y);
}

- (void)rightMouseDown:(NSEvent *)event {
  NSPoint loc = [self convertPoint:event.locationInWindow fromView:nil];
  NSLog(@"[spike-zorder] rightMouseDown @ (%.1f, %.1f)", loc.x, loc.y);
}

@end

// ---------------------------------------------------------------------------
// Global state (strong ref so ARC doesn't collect it)
// ---------------------------------------------------------------------------
static SpikeHostView* gSpikeView = nil;

// ---------------------------------------------------------------------------
// mount(handleBuffer, rect) → undefined
// handleBuffer: Buffer<8> — the NSView* pointer from getNativeWindowHandle()
// rect:         { x, y, w, h } in logical pixels (CSS / renderer coords)
// ---------------------------------------------------------------------------
static napi_value Mount(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc < 2) {
    napi_throw_error(env, nullptr, "mount(handleBuffer, rect): requires 2 arguments");
    return nullptr;
  }

  // --- Extract NSView* from Buffer ---
  bool isBuffer = false;
  napi_is_buffer(env, args[0], &isBuffer);
  if (!isBuffer) {
    napi_throw_type_error(env, nullptr, "mount: first argument must be a Buffer");
    return nullptr;
  }
  void* bufData = nullptr;
  size_t bufLen = 0;
  napi_get_buffer_info(env, args[0], &bufData, &bufLen);
  if (bufLen < sizeof(void*)) {
    napi_throw_error(env, nullptr, "mount: buffer too small to hold a pointer");
    return nullptr;
  }
  // ARC requires __unsafe_unretained for raw pointer cast from void*.
  // The contentView is owned by the NSWindow; we don't retain it here.
  NSView* __unsafe_unretained contentView = (__bridge NSView*)(*reinterpret_cast<void**>(bufData));
  if (!contentView) {
    napi_throw_error(env, nullptr, "mount: null contentView pointer");
    return nullptr;
  }

  // --- Extract rect object ---
  napi_value xVal, yVal, wVal, hVal;
  napi_get_named_property(env, args[1], "x", &xVal);
  napi_get_named_property(env, args[1], "y", &yVal);
  napi_get_named_property(env, args[1], "w", &wVal);
  napi_get_named_property(env, args[1], "h", &hVal);

  double x = 0, y = 0, w = 0, h = 0;
  napi_get_value_double(env, xVal, &x);
  napi_get_value_double(env, yVal, &y);
  napi_get_value_double(env, wVal, &w);
  napi_get_value_double(env, hVal, &h);

  // Safety: must not extend into the top 40px (drag strip + traffic lights).
  if (y < 40.0) {
    napi_throw_error(env, nullptr, "mount: rect.y must be >= 40 to avoid drag-strip/traffic-light overlap");
    return nullptr;
  }

  // --- All AppKit work on the main thread ---
  dispatch_async(dispatch_get_main_queue(), ^{
    // Unmount any previous spike view
    if (gSpikeView) {
      [gSpikeView removeFromSuperview];
      gSpikeView = nil;
    }

    // contentView from Electron uses a flipped coordinate system where y=0 is
    // the top. However, macOS NSView's setFrame: uses bottom-left origin by
    // default (isFlipped=NO on the parent contentView). Our SpikeHostView has
    // isFlipped=YES, so AppKit will flip the subview frame origin for us when
    // laying it out — but only if the PARENT is flipped. Electron's
    // WKWebView-containing contentView is NOT flipped (y=0 at bottom).
    //
    // Therefore we must convert from top-left (renderer) coords to
    // bottom-left (AppKit) coords ourselves using the contentView height.
    CGFloat viewH = contentView.bounds.size.height;
    // bottom-left origin y = height - (top + h)
    CGFloat flippedY = viewH - (y + h);
    NSRect frame = NSMakeRect((CGFloat)x, flippedY, (CGFloat)w, (CGFloat)h);

    SpikeHostView* spike = [[SpikeHostView alloc] initWithFrame:frame];
    spike.wantsLayer = YES;

    // Translucent red layer
    CALayer* layer = spike.layer;
    CGColorRef redColor = [NSColor colorWithSRGBRed:1.0
                                              green:0.2
                                               blue:0.2
                                              alpha:0.4].CGColor;
    layer.backgroundColor = redColor;
    layer.cornerRadius = 6.0;

    // Add on top of all existing subviews (NSWindowAbove z-order)
    [contentView addSubview:spike positioned:NSWindowAbove relativeTo:nil];

    gSpikeView = spike;
    NSLog(@"[spike-zorder] mounted SpikeHostView at (%.0f,%.0f) size %.0fx%.0f", x, y, w, h);
  });

  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

// ---------------------------------------------------------------------------
// unmount() → undefined
// ---------------------------------------------------------------------------
static napi_value Unmount(napi_env env, napi_callback_info info) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (gSpikeView) {
      [gSpikeView removeFromSuperview];
      gSpikeView = nil;
      NSLog(@"[spike-zorder] unmounted SpikeHostView");
    }
  });

  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

// ---------------------------------------------------------------------------
// Module initializer
// ---------------------------------------------------------------------------
static napi_value Init(napi_env env, napi_value exports) {
  napi_value mountFn, unmountFn;
  napi_create_function(env, "mount",   NAPI_AUTO_LENGTH, Mount,   nullptr, &mountFn);
  napi_create_function(env, "unmount", NAPI_AUTO_LENGTH, Unmount, nullptr, &unmountFn);
  napi_set_named_property(env, exports, "mount",   mountFn);
  napi_set_named_property(env, exports, "unmount", unmountFn);
  return exports;
}

NAPI_MODULE(native_spike_zorder, Init)
