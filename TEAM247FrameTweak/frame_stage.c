#include "frame_stage.h"

#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define TEAM247_SUN_PATH_MAX 104

struct Team247Store {
    pthread_mutex_t mu;
    Team247StagedFrame frame;
    bool hasFrame;
};

struct Team247Listener {
    Team247Store *store;
    char path[TEAM247_SUN_PATH_MAX];
    size_t recvCap;
    int fd;
    int stop;
    int bound;
    int started;
    uint64_t dropped;
    pthread_t thread;
    pthread_mutex_t mu;
    pthread_cond_t cv;
};

static Team247LogFn g_log;

static void team247_default_log(const char *line) {
    fprintf(stderr, "%s\n", line);
}

void Team247SetLogFn(Team247LogFn fn) {
    g_log = fn ? fn : team247_default_log;
}

static void team247_log(const char *fmt, ...) {
    char buf[512];
    va_list ap;
    Team247LogFn fn;

    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    fn = g_log ? g_log : team247_default_log;
    fn(buf);
}

static uint32_t team247_read_le32(const uint8_t *p) {
    return (uint32_t)p[0]
        | ((uint32_t)p[1] << 8)
        | ((uint32_t)p[2] << 16)
        | ((uint32_t)p[3] << 24);
}

static void team247_log_status_once(Team247ParseStatus status) {
    static int seen[8];
    const char *name = "unknown";

    if ((int)status < 0 || (int)status >= 8 || seen[status]) {
        return;
    }
    seen[status] = 1;
    switch (status) {
    case TEAM247_OK: name = "ok"; break;
    case TEAM247_ERR_TOO_SMALL: name = "too-small"; break;
    case TEAM247_ERR_MAGIC: name = "bad-magic"; break;
    case TEAM247_ERR_FORMAT: name = "bad-format"; break;
    case TEAM247_ERR_DIMENSIONS: name = "bad-dimensions"; break;
    case TEAM247_ERR_ROW_BYTES: name = "bad-row-bytes"; break;
    case TEAM247_ERR_LENGTH: name = "bad-length"; break;
    case TEAM247_ERR_NOMEM: name = "nomem"; break;
    }
    team247_log("[TEAM247FrameTweak] rejected datagram (%s)", name);
}

void Team247StagedFrameFree(Team247StagedFrame *frame) {
    if (!frame) {
        return;
    }
    free(frame->pixels);
    memset(frame, 0, sizeof(*frame));
}

Team247ParseStatus Team247ParseFrame(const uint8_t *data, size_t len, Team247StagedFrame *out) {
    uint32_t width;
    uint32_t height;
    uint32_t bytesPerRow;
    uint32_t pixelFormat;
    uint64_t minRow;
    uint64_t pixelBytes;
    uint8_t *pixels;

    if (!out) {
        return TEAM247_ERR_TOO_SMALL;
    }
    memset(out, 0, sizeof(*out));
    if (!data || len < TEAM247_FRAME_HEADER_SIZE) {
        return TEAM247_ERR_TOO_SMALL;
    }
    if (memcmp(data, TEAM247_FRAME_MAGIC, 4) != 0) {
        return TEAM247_ERR_MAGIC;
    }

    width = team247_read_le32(data + 4);
    height = team247_read_le32(data + 8);
    bytesPerRow = team247_read_le32(data + 12);
    pixelFormat = team247_read_le32(data + 16);
    if (pixelFormat != TEAM247_PIXEL_FORMAT_BGRA) {
        return TEAM247_ERR_FORMAT;
    }
    if (width == 0 || height == 0
        || width > TEAM247_FRAME_MAX_DIMENSION
        || height > TEAM247_FRAME_MAX_DIMENSION) {
        return TEAM247_ERR_DIMENSIONS;
    }

    minRow = (uint64_t)width * 4u;
    if ((uint64_t)bytesPerRow < minRow || (uint64_t)bytesPerRow > TEAM247_FRAME_MAX_BYTES) {
        return TEAM247_ERR_ROW_BYTES;
    }
    pixelBytes = (uint64_t)bytesPerRow * (uint64_t)height;
    if (pixelBytes > TEAM247_FRAME_MAX_BYTES) {
        return TEAM247_ERR_ROW_BYTES;
    }
    if (len != TEAM247_FRAME_HEADER_SIZE + (size_t)pixelBytes) {
        return TEAM247_ERR_LENGTH;
    }

    pixels = (uint8_t *)malloc((size_t)pixelBytes);
    if (!pixels) {
        return TEAM247_ERR_NOMEM;
    }
    memcpy(pixels, data + TEAM247_FRAME_HEADER_SIZE, (size_t)pixelBytes);
    out->width = width;
    out->height = height;
    out->bytesPerRow = bytesPerRow;
    out->pixelFormat = pixelFormat;
    out->pixels = pixels;
    out->pixelBytes = (size_t)pixelBytes;
    return TEAM247_OK;
}

Team247ApplyResult Team247CopyFrame(const Team247StagedFrame *frame,
                                    uint8_t *dest,
                                    uint32_t destWidth,
                                    uint32_t destHeight,
                                    uint32_t destBytesPerRow,
                                    uint32_t destPixelFormat) {
    uint64_t rowBytes;
    uint32_t y;

    if (!frame || !frame->pixels || !dest || frame->pixelBytes == 0) {
        return TEAM247_APPLY_BAD_DEST;
    }
    if (frame->pixelFormat != TEAM247_PIXEL_FORMAT_BGRA
        || destPixelFormat != TEAM247_PIXEL_FORMAT_BGRA
        || frame->width != destWidth
        || frame->height != destHeight
        || frame->width == 0
        || frame->height == 0) {
        return TEAM247_APPLY_MISMATCH;
    }

    rowBytes = (uint64_t)frame->width * 4u;
    if ((uint64_t)frame->bytesPerRow < rowBytes
        || (uint64_t)destBytesPerRow < rowBytes
        || (uint64_t)frame->bytesPerRow * (uint64_t)frame->height != (uint64_t)frame->pixelBytes) {
        return TEAM247_APPLY_MISMATCH;
    }

    for (y = 0; y < frame->height; y++) {
        memcpy(dest + ((uint64_t)y * destBytesPerRow),
               frame->pixels + ((uint64_t)y * frame->bytesPerRow),
               (size_t)rowBytes);
    }
    return TEAM247_APPLY_COPIED;
}

Team247Store *Team247StoreCreate(void) {
    Team247Store *store = (Team247Store *)calloc(1, sizeof(*store));
    if (!store) {
        return NULL;
    }
    if (pthread_mutex_init(&store->mu, NULL) != 0) {
        free(store);
        return NULL;
    }
    return store;
}

void Team247StoreDestroy(Team247Store *store) {
    if (!store) {
        return;
    }
    Team247StagedFrameFree(&store->frame);
    pthread_mutex_destroy(&store->mu);
    free(store);
}

bool Team247StoreHasFrame(Team247Store *store) {
    bool hasFrame;
    if (!store) {
        return false;
    }
    pthread_mutex_lock(&store->mu);
    hasFrame = store->hasFrame;
    pthread_mutex_unlock(&store->mu);
    return hasFrame;
}

bool Team247StoreReplace(Team247Store *store,
                         const uint8_t *datagram,
                         size_t len,
                         Team247ParseStatus *statusOut) {
    Team247StagedFrame parsed;
    Team247ParseStatus status;

    if (!store) {
        if (statusOut) {
            *statusOut = TEAM247_ERR_TOO_SMALL;
        }
        return false;
    }
    memset(&parsed, 0, sizeof(parsed));
    status = Team247ParseFrame(datagram, len, &parsed);
    if (statusOut) {
        *statusOut = status;
    }
    if (status != TEAM247_OK) {
        team247_log_status_once(status);
        return false;
    }

    pthread_mutex_lock(&store->mu);
    Team247StagedFrameFree(&store->frame);
    store->frame = parsed;
    store->hasFrame = true;
    pthread_mutex_unlock(&store->mu);
    team247_log("[TEAM247FrameTweak] staged %ux%u BGRA row=%u",
                parsed.width, parsed.height, parsed.bytesPerRow);
    return true;
}

Team247ApplyResult Team247StoreCopyInto(Team247Store *store,
                                        uint8_t *dest,
                                        uint32_t destWidth,
                                        uint32_t destHeight,
                                        uint32_t destBytesPerRow,
                                        uint32_t destPixelFormat) {
    Team247ApplyResult result;

    if (!store || !dest) {
        return TEAM247_APPLY_BAD_DEST;
    }
    pthread_mutex_lock(&store->mu);
    if (!store->hasFrame) {
        pthread_mutex_unlock(&store->mu);
        return TEAM247_APPLY_NO_FRAME;
    }
    result = Team247CopyFrame(&store->frame, dest, destWidth, destHeight, destBytesPerRow, destPixelFormat);
    pthread_mutex_unlock(&store->mu);
    return result;
}

static void team247_listener_note_drop(Team247Listener *listener) {
    pthread_mutex_lock(&listener->mu);
    listener->dropped += 1;
    pthread_cond_signal(&listener->cv);
    pthread_mutex_unlock(&listener->mu);
}

static void team247_listener_set_bound(Team247Listener *listener, int bound) {
    pthread_mutex_lock(&listener->mu);
    listener->bound = bound;
    pthread_cond_signal(&listener->cv);
    pthread_mutex_unlock(&listener->mu);
}

static void *team247_listener_main(void *arg) {
    Team247Listener *listener = (Team247Listener *)arg;
    struct sockaddr_un addr;
    socklen_t addrlen;
    size_t pathLen;
    size_t cap;
    uint8_t *buf;
    int fd;
    int rcvBuf;

    fd = socket(AF_UNIX, SOCK_DGRAM, 0);
    if (fd < 0) {
        team247_log("[TEAM247FrameTweak] socket() failed errno=%d", errno);
        team247_listener_set_bound(listener, -1);
        return NULL;
    }

    rcvBuf = (int)TEAM247_FRAME_MAX_BYTES;
    if (setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcvBuf, sizeof(rcvBuf)) != 0) {
        team247_log("[TEAM247FrameTweak] SO_RCVBUF not raised errno=%d", errno);
    }

    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    pathLen = strlen(listener->path);
    memcpy(addr.sun_path, listener->path, pathLen + 1);
    addrlen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + pathLen + 1);
#ifdef __APPLE__
    addr.sun_len = (unsigned char)addrlen;
#endif

    unlink(listener->path);
    if (bind(fd, (struct sockaddr *)&addr, addrlen) != 0) {
        team247_log("[TEAM247FrameTweak] bind %s failed errno=%d", listener->path, errno);
        close(fd);
        team247_listener_set_bound(listener, -1);
        return NULL;
    }
    chmod(listener->path, 0666);

    cap = listener->recvCap;
    buf = (uint8_t *)malloc(cap);
    if (!buf) {
        close(fd);
        unlink(listener->path);
        team247_listener_set_bound(listener, -1);
        return NULL;
    }

    pthread_mutex_lock(&listener->mu);
    listener->fd = fd;
    listener->bound = 1;
    pthread_cond_signal(&listener->cv);
    pthread_mutex_unlock(&listener->mu);
    team247_log("[TEAM247FrameTweak] listening on %s", listener->path);

    for (;;) {
        struct iovec iov;
        struct msghdr msg;
        ssize_t n;
        int stop;

        pthread_mutex_lock(&listener->mu);
        stop = listener->stop;
        pthread_mutex_unlock(&listener->mu);
        if (stop) {
            break;
        }

        memset(&msg, 0, sizeof(msg));
        iov.iov_base = buf;
        iov.iov_len = cap;
        msg.msg_iov = &iov;
        msg.msg_iovlen = 1;
        n = recvmsg(fd, &msg, 0);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        if (n == 0) {
            pthread_mutex_lock(&listener->mu);
            stop = listener->stop;
            pthread_mutex_unlock(&listener->mu);
            if (stop) {
                break;
            }
            team247_log_status_once(TEAM247_ERR_TOO_SMALL);
            team247_listener_note_drop(listener);
            continue;
        }
        if (msg.msg_flags & MSG_TRUNC) {
            team247_log_status_once(TEAM247_ERR_LENGTH);
            team247_listener_note_drop(listener);
            continue;
        }
        if (!Team247StoreReplace(listener->store, buf, (size_t)n, NULL)) {
            team247_listener_note_drop(listener);
        }
    }

    close(fd);
    free(buf);
    unlink(listener->path);
    pthread_mutex_lock(&listener->mu);
    listener->fd = -1;
    pthread_mutex_unlock(&listener->mu);
    return NULL;
}

Team247Listener *Team247ListenerCreate(Team247Store *store, const char *path, size_t recvCap) {
    Team247Listener *listener;
    size_t pathLen;

    if (!store || !path) {
        return NULL;
    }
    pathLen = strlen(path);
    if (pathLen == 0 || pathLen >= TEAM247_SUN_PATH_MAX) {
        return NULL;
    }
    listener = (Team247Listener *)calloc(1, sizeof(*listener));
    if (!listener) {
        return NULL;
    }
    listener->store = store;
    listener->fd = -1;
    memcpy(listener->path, path, pathLen + 1);
    if (recvCap == 0 || recvCap > TEAM247_FRAME_MAX_BYTES + TEAM247_FRAME_HEADER_SIZE) {
        listener->recvCap = TEAM247_FRAME_MAX_BYTES + TEAM247_FRAME_HEADER_SIZE;
    } else {
        listener->recvCap = recvCap;
    }
    if (pthread_mutex_init(&listener->mu, NULL) != 0) {
        free(listener);
        return NULL;
    }
    if (pthread_cond_init(&listener->cv, NULL) != 0) {
        pthread_mutex_destroy(&listener->mu);
        free(listener);
        return NULL;
    }
    return listener;
}

uint64_t Team247ListenerDropped(Team247Listener *listener) {
    uint64_t dropped = 0;
    if (!listener) {
        return 0;
    }
    pthread_mutex_lock(&listener->mu);
    dropped = listener->dropped;
    pthread_mutex_unlock(&listener->mu);
    return dropped;
}

int Team247ListenerStart(Team247Listener *listener) {
    int bound;

    if (!listener || listener->started) {
        return -1;
    }
    listener->stop = 0;
    listener->bound = 0;
    if (pthread_create(&listener->thread, NULL, team247_listener_main, listener) != 0) {
        return -1;
    }
    pthread_mutex_lock(&listener->mu);
    while (listener->bound == 0) {
        pthread_cond_wait(&listener->cv, &listener->mu);
    }
    bound = listener->bound;
    pthread_mutex_unlock(&listener->mu);
    if (bound != 1) {
        pthread_join(listener->thread, NULL);
        return -1;
    }
    listener->started = 1;
    return 0;
}

void Team247ListenerDestroy(Team247Listener *listener) {
    int fd;

    if (!listener) {
        return;
    }
    if (listener->started) {
        pthread_mutex_lock(&listener->mu);
        listener->stop = 1;
        fd = listener->fd;
        pthread_mutex_unlock(&listener->mu);
        if (fd >= 0) {
            shutdown(fd, SHUT_RDWR);
        }
        pthread_join(listener->thread, NULL);
        listener->started = 0;
    }
    pthread_cond_destroy(&listener->cv);
    pthread_mutex_destroy(&listener->mu);
    free(listener);
}
