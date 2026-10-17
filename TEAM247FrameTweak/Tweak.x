#import "frame_stage.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreVideo/CoreVideo.h>
#import <objc/runtime.h>

#if !__has_feature(objc_arc)
#error TEAM247FrameTweak requires ARC
#endif

_Static_assert(kCVPixelFormatType_32BGRA == TEAM247_PIXEL_FORMAT_BGRA,
               "32BGRA fourcc must match the IPC pixelFormat field");

/*
 * AVCaptureVideoDataOutput does not implement
 * captureOutput:didOutputSampleBuffer:fromConnection:. That selector is the
 * sample-buffer delegate callback. The tweak hooks
 * setSampleBufferDelegate:queue: and forwards through a proxy that implements
 * the callback. With no staged frame the proxy does not write the buffer.
 * A staged 32BGRA frame is copied only when width, height, and format match.
 */

static char kTeam247ProxyKey;
static Team247Store *gStore;
static Team247Listener *gListener;
static int gLoggedCopy;
static int gLoggedMismatch;

static void Team247NSLogLine(const char *line) {
    NSLog(@"%s", line ? line : "");
}

@interface Team247SampleBufferProxy : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@property (nonatomic, weak) id<AVCaptureVideoDataOutputSampleBufferDelegate> target;
@end

static void Team247ApplySampleBuffer(CMSampleBufferRef sampleBuffer) {
    CVImageBufferRef imageBuffer;
    OSType pixelFormat;
    size_t width;
    size_t height;
    size_t bytesPerRow;
    void *base;
    Team247ApplyResult result;

    if (!gStore || !sampleBuffer) {
        return;
    }
    imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!imageBuffer || CVPixelBufferIsPlanar(imageBuffer)) {
        return;
    }
    width = CVPixelBufferGetWidth(imageBuffer);
    height = CVPixelBufferGetHeight(imageBuffer);
    bytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer);
    if (width > UINT32_MAX || height > UINT32_MAX || bytesPerRow > UINT32_MAX) {
        return;
    }
    if (CVPixelBufferLockBaseAddress(imageBuffer, 0) != kCVReturnSuccess) {
        return;
    }

    pixelFormat = CVPixelBufferGetPixelFormatType(imageBuffer);
    base = CVPixelBufferGetBaseAddress(imageBuffer);
    result = TEAM247_APPLY_BAD_DEST;
    if (base) {
        result = Team247StoreCopyInto(gStore,
                                      (uint8_t *)base,
                                      (uint32_t)width,
                                      (uint32_t)height,
                                      (uint32_t)bytesPerRow,
                                      (uint32_t)pixelFormat);
    }
    CVPixelBufferUnlockBaseAddress(imageBuffer, 0);

    if (result == TEAM247_APPLY_COPIED && !gLoggedCopy) {
        gLoggedCopy = 1;
        NSLog(@"[TEAM247FrameTweak] copied staged frame into %zux%zu 32BGRA buffer", width, height);
    } else if (result == TEAM247_APPLY_MISMATCH && !gLoggedMismatch) {
        gLoggedMismatch = 1;
        NSLog(@"[TEAM247FrameTweak] staged frame not copied; camera buffer is %zux%zu format=%u",
              width, height, (unsigned)pixelFormat);
    }
}

@implementation Team247SampleBufferProxy

- (BOOL)respondsToSelector:(SEL)sel {
    if (sel == @selector(captureOutput:didOutputSampleBuffer:fromConnection:)
        || sel == @selector(captureOutput:didDropSampleBuffer:fromConnection:)) {
        return [self.target respondsToSelector:sel];
    }
    if ([super respondsToSelector:sel]) {
        return YES;
    }
    return [self.target respondsToSelector:sel];
}

- (id)forwardingTargetForSelector:(SEL)sel {
    if ([super respondsToSelector:sel]) {
        return nil;
    }
    return self.target;
}

- (void)captureOutput:(AVCaptureOutput *)output
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
       fromConnection:(AVCaptureConnection *)connection {
    Team247ApplySampleBuffer(sampleBuffer);
    id<AVCaptureVideoDataOutputSampleBufferDelegate> target = self.target;
    if ([target respondsToSelector:@selector(captureOutput:didOutputSampleBuffer:fromConnection:)]) {
        [target captureOutput:output didOutputSampleBuffer:sampleBuffer fromConnection:connection];
    }
}

- (void)captureOutput:(AVCaptureOutput *)output
  didDropSampleBuffer:(CMSampleBufferRef)sampleBuffer
       fromConnection:(AVCaptureConnection *)connection {
    id<AVCaptureVideoDataOutputSampleBufferDelegate> target = self.target;
    if ([target respondsToSelector:@selector(captureOutput:didDropSampleBuffer:fromConnection:)]) {
        [target captureOutput:output didDropSampleBuffer:sampleBuffer fromConnection:connection];
    }
}

@end

%hook AVCaptureVideoDataOutput

- (void)setSampleBufferDelegate:(id<AVCaptureVideoDataOutputSampleBufferDelegate>)sampleBufferDelegate
                          queue:(dispatch_queue_t)sampleBufferCallbackQueue {
    if (!sampleBufferDelegate) {
        objc_setAssociatedObject(self, &kTeam247ProxyKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        %orig(nil, sampleBufferCallbackQueue);
        return;
    }
    if ([sampleBufferDelegate isKindOfClass:[Team247SampleBufferProxy class]]) {
        %orig;
        return;
    }

    Team247SampleBufferProxy *proxy = [Team247SampleBufferProxy new];
    proxy.target = sampleBufferDelegate;
    objc_setAssociatedObject(self, &kTeam247ProxyKey, proxy, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    %orig(proxy, sampleBufferCallbackQueue);
}

%end

static void Team247TweakStart(void) {
    Team247SetLogFn(Team247NSLogLine);
    if (!gStore) {
        gStore = Team247StoreCreate();
    }
    if (!gStore) {
        NSLog(@"[TEAM247FrameTweak] frame store unavailable");
        return;
    }
    gListener = Team247ListenerCreate(gStore, TEAM247_FRAME_SOCK_PATH, 0);
    if (!gListener || Team247ListenerStart(gListener) != 0) {
        NSLog(@"[TEAM247FrameTweak] not listening on %s; camera buffers stay unchanged",
              TEAM247_FRAME_SOCK_PATH);
        return;
    }
    NSLog(@"[TEAM247FrameTweak] TEST-ONLY ready at %s", TEAM247_FRAME_SOCK_PATH);
}

%ctor {
    %init();
    Team247TweakStart();
}
