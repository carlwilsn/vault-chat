// A MacBook-like display for the Mac CI proof: a virtual 1440x900-point HiDPI (2x, 2880x1800 px) screen made
// with CoreGraphics' CGVirtualDisplay (the class Sidecar/AirPlay displays use; private, but present on macOS 14+
// and used by DeskPad, BetterDisplay, Chromium's tests), moved to the origin so it is the main display, where
// the app's window opens and `screencapture` records. A hosted runner's own screen is a paravirtual 1024x768 at 1x
// that offers no HiDPI modes. The display lives as long as this process: run it in the background, it never exits.
//
// Build: clang -fobjc-arc -framework Foundation -framework CoreGraphics macos-virtual-display.m -o vdisplay
// Run:   ./vdisplay [width height]   (points; default 1440 900). Prints the display id and its bounds, then waits.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

@class CGVirtualDisplay;
@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(copy, nonatomic) void (^terminationHandler)(id, CGVirtualDisplay *);
@end
@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)refreshRate;
@end
@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end
@interface CGVirtualDisplay : NSObject
@property(readonly, nonatomic) unsigned int displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    unsigned int w = argc > 2 ? (unsigned int)atoi(argv[1]) : 1440, h = argc > 2 ? (unsigned int)atoi(argv[2]) : 900;
    if (!NSClassFromString(@"CGVirtualDisplay")) { fprintf(stderr, "no CGVirtualDisplay on this macOS\n"); return 2; }
    CGVirtualDisplayDescriptor *d = [[NSClassFromString(@"CGVirtualDisplayDescriptor") alloc] init];
    d.queue = dispatch_get_main_queue();
    d.name = @"vault-chat CI 14-inch";
    d.maxPixelsWide = w * 2;
    d.maxPixelsHigh = h * 2;
    d.sizeInMillimeters = CGSizeMake(w * 25.4 / 127.0, h * 25.4 / 127.0);  // ~254 px/in at 2x, a MacBook's density
    d.serialNum = 0x5643; d.productID = 0x1440; d.vendorID = 0x5643;
    d.terminationHandler = ^(id a, CGVirtualDisplay *b) { fprintf(stderr, "virtual display terminated\n"); exit(3); };
    CGVirtualDisplay *display = [[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:d];
    if (!display || !display.displayID) { fprintf(stderr, "could not make the virtual display\n"); return 4; }
    CGVirtualDisplaySettings *s = [[NSClassFromString(@"CGVirtualDisplaySettings") alloc] init];
    s.hiDPI = 1;
    s.modes = @[ [[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:w height:h refreshRate:60] ];
    if (![display applySettings:s]) { fprintf(stderr, "the virtual display refused its HiDPI mode\n"); return 5; }
    CGDirectDisplayID vid = display.displayID, old = CGMainDisplayID();
    [NSThread sleepForTimeInterval:2];
    // The virtual display at the origin = the main display; the runner's own screen to its right.
    CGDisplayConfigRef cfg;
    if (CGBeginDisplayConfiguration(&cfg) == kCGErrorSuccess) {
      CGConfigureDisplayOrigin(cfg, vid, 0, 0);
      if (old != vid) CGConfigureDisplayOrigin(cfg, old, (int32_t)w, 0);
      CGError e = CGCompleteDisplayConfiguration(cfg, kCGConfigureForSession);
      if (e != kCGErrorSuccess) fprintf(stderr, "display arrangement failed: %d\n", e);
    }
    [NSThread sleepForTimeInterval:1];
    CGRect b = CGDisplayBounds(vid);
    CGDisplayModeRef m = CGDisplayCopyDisplayMode(vid);
    printf("virtual display %u: %.0fx%.0f points, %zux%zu pixels, main: %s\n", vid, b.size.width, b.size.height,
           m ? CGDisplayModeGetPixelWidth(m) : 0, m ? CGDisplayModeGetPixelHeight(m) : 0, CGMainDisplayID() == vid ? "yes" : "no");
    fflush(stdout);
    if (m) CGDisplayModeRelease(m);
    dispatch_main();
  }
}
