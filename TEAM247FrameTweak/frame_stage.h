#ifndef TEAM247_FRAME_STAGE_H
#define TEAM247_FRAME_STAGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TEAM247_FRAME_MAGIC "T247"
#define TEAM247_FRAME_HEADER_SIZE 20u
#define TEAM247_PIXEL_FORMAT_BGRA 0x42475241u
#define TEAM247_FRAME_SOCK_PATH "/var/tmp/team247.frame.sock"
#define TEAM247_FRAME_MAX_DIMENSION 4096u
#define TEAM247_FRAME_MAX_BYTES (16u * 1024u * 1024u)

typedef enum {
    TEAM247_OK = 0,
    TEAM247_ERR_TOO_SMALL = 1,
    TEAM247_ERR_MAGIC = 2,
    TEAM247_ERR_FORMAT = 3,
    TEAM247_ERR_DIMENSIONS = 4,
    TEAM247_ERR_ROW_BYTES = 5,
    TEAM247_ERR_LENGTH = 6,
    TEAM247_ERR_NOMEM = 7
} Team247ParseStatus;

typedef enum {
    TEAM247_APPLY_COPIED = 0,
    TEAM247_APPLY_NO_FRAME = 1,
    TEAM247_APPLY_MISMATCH = 2,
    TEAM247_APPLY_BAD_DEST = 3
} Team247ApplyResult;

typedef struct Team247StagedFrame {
    uint32_t width;
    uint32_t height;
    uint32_t bytesPerRow;
    uint32_t pixelFormat;
    uint8_t *pixels;
    size_t pixelBytes;
} Team247StagedFrame;

typedef struct Team247Store Team247Store;
typedef struct Team247Listener Team247Listener;

typedef void (*Team247LogFn)(const char *line);

void Team247SetLogFn(Team247LogFn fn);

Team247ParseStatus Team247ParseFrame(const uint8_t *data, size_t len, Team247StagedFrame *out);
void Team247StagedFrameFree(Team247StagedFrame *frame);

Team247ApplyResult Team247CopyFrame(const Team247StagedFrame *frame,
                                    uint8_t *dest,
                                    uint32_t destWidth,
                                    uint32_t destHeight,
                                    uint32_t destBytesPerRow,
                                    uint32_t destPixelFormat);

Team247Store *Team247StoreCreate(void);
void Team247StoreDestroy(Team247Store *store);
bool Team247StoreHasFrame(Team247Store *store);
bool Team247StoreReplace(Team247Store *store,
                         const uint8_t *datagram,
                         size_t len,
                         Team247ParseStatus *statusOut);
Team247ApplyResult Team247StoreCopyInto(Team247Store *store,
                                        uint8_t *dest,
                                        uint32_t destWidth,
                                        uint32_t destHeight,
                                        uint32_t destBytesPerRow,
                                        uint32_t destPixelFormat);

/* recvCap 0 uses the 16 MiB protocol cap. A smaller cap rejects oversized datagrams. */
Team247Listener *Team247ListenerCreate(Team247Store *store, const char *path, size_t recvCap);
int Team247ListenerStart(Team247Listener *listener);
uint64_t Team247ListenerDropped(Team247Listener *listener);
void Team247ListenerDestroy(Team247Listener *listener);

#endif
