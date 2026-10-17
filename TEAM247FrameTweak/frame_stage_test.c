#include "frame_stage.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

static void write_le32(uint8_t *p, uint32_t value) {
    p[0] = (uint8_t)(value & 0xffu);
    p[1] = (uint8_t)((value >> 8) & 0xffu);
    p[2] = (uint8_t)((value >> 16) & 0xffu);
    p[3] = (uint8_t)((value >> 24) & 0xffu);
}

static uint8_t *build_frame(uint32_t width,
                           uint32_t height,
                           uint32_t bytesPerRow,
                           uint32_t pixelFormat,
                           const uint8_t *pixels,
                           size_t *outLen) {
    size_t pixelBytes = (size_t)bytesPerRow * (size_t)height;
    size_t len = TEAM247_FRAME_HEADER_SIZE + pixelBytes;
    uint8_t *buf = (uint8_t *)calloc(1, len);
    assert(buf);
    memcpy(buf, "T247", 4);
    write_le32(buf + 4, width);
    write_le32(buf + 8, height);
    write_le32(buf + 12, bytesPerRow);
    write_le32(buf + 16, pixelFormat);
    if (pixels && pixelBytes) {
        memcpy(buf + TEAM247_FRAME_HEADER_SIZE, pixels, pixelBytes);
    }
    *outLen = len;
    return buf;
}

static void expect_status(const uint8_t *data, size_t len, Team247ParseStatus want) {
    Team247StagedFrame frame;
    Team247ParseStatus status = Team247ParseFrame(data, len, &frame);
    assert(status == want);
    assert(frame.pixels == NULL);
}

static void test_parser(void) {
    uint8_t pixels[32];
    size_t len = 0;
    uint8_t *packet;
    Team247StagedFrame frame;
    unsigned i;

    for (i = 0; i < sizeof(pixels); i++) {
        pixels[i] = (uint8_t)(0x10 + i);
    }
    packet = build_frame(2, 2, 16, TEAM247_PIXEL_FORMAT_BGRA, pixels, &len);
    assert(packet[16] == 0x41 && packet[17] == 0x52 && packet[18] == 0x47 && packet[19] == 0x42);
    assert(Team247ParseFrame(packet, len, &frame) == TEAM247_OK);
    assert(frame.width == 2 && frame.height == 2 && frame.bytesPerRow == 16);
    assert(frame.pixelBytes == 32);
    assert(memcmp(frame.pixels, pixels, 32) == 0);
    Team247StagedFrameFree(&frame);
    free(packet);

    packet = build_frame(2, 2, 16, TEAM247_PIXEL_FORMAT_BGRA, pixels, &len);
    for (i = 0; i < TEAM247_FRAME_HEADER_SIZE; i++) {
        expect_status(packet, i, TEAM247_ERR_TOO_SMALL);
    }
    packet[0] = 'X';
    expect_status(packet, len, TEAM247_ERR_MAGIC);
    packet[0] = 'T';
    write_le32(packet + 16, 0x41524742u);
    expect_status(packet, len, TEAM247_ERR_FORMAT);
    write_le32(packet + 16, TEAM247_PIXEL_FORMAT_BGRA);
    write_le32(packet + 4, 0);
    expect_status(packet, len, TEAM247_ERR_DIMENSIONS);
    write_le32(packet + 4, 4097);
    expect_status(packet, len, TEAM247_ERR_DIMENSIONS);
    write_le32(packet + 4, 2);
    write_le32(packet + 12, 4);
    expect_status(packet, len, TEAM247_ERR_ROW_BYTES);
    write_le32(packet + 12, 16);
    expect_status(packet, len - 1, TEAM247_ERR_LENGTH);
    expect_status(packet, len + 1, TEAM247_ERR_LENGTH);
    free(packet);
}

static void test_copy_rules(void) {
    uint8_t src[32];
    uint8_t guard[8 + 64 + 8];
    uint8_t *dest;
    Team247StagedFrame frame;
    size_t len = 0;
    uint8_t *packet;
    uint32_t y;
    unsigned i;

    for (i = 0; i < sizeof(src); i++) {
        src[i] = (uint8_t)(0x40 + i);
    }
    packet = build_frame(2, 2, 16, TEAM247_PIXEL_FORMAT_BGRA, src, &len);
    assert(Team247ParseFrame(packet, len, &frame) == TEAM247_OK);

    memset(guard, 0xA5, sizeof(guard));
    dest = guard + 8;
    assert(Team247CopyFrame(&frame, dest, 2, 2, 8, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_COPIED);
    assert(memcmp(dest, src, 8) == 0);
    assert(memcmp(dest + 8, src + 16, 8) == 0);
    for (i = 0; i < 8; i++) {
        assert(guard[i] == 0xA5);
        assert(guard[8 + 16 + i] == 0xA5);
    }

    memset(guard, 0xA5, sizeof(guard));
    assert(Team247CopyFrame(&frame, dest, 2, 2, 32, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_COPIED);
    for (y = 0; y < 2; y++) {
        assert(memcmp(dest + (y * 32), src + (y * 16), 8) == 0);
        for (i = 8; i < 32; i++) {
            assert(dest[(y * 32) + i] == 0xA5);
        }
    }

    memset(dest, 0x5A, 16);
    assert(Team247CopyFrame(&frame, dest, 3, 2, 12, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_MISMATCH);
    assert(Team247CopyFrame(&frame, dest, 2, 2, 8, 0) == TEAM247_APPLY_MISMATCH);
    for (i = 0; i < 16; i++) {
        assert(dest[i] == 0x5A);
    }

    Team247StagedFrameFree(&frame);
    free(packet);
}

static void test_store_holds_last_good_frame(void) {
    Team247Store *store = Team247StoreCreate();
    uint8_t dest[8];
    uint8_t firstPixels[8] = {1, 2, 3, 4, 5, 6, 7, 8};
    uint8_t secondPixels[8] = {9, 9, 9, 9, 8, 8, 8, 8};
    uint8_t bad[4] = {'n', 'o', 'p', 'e'};
    size_t len = 0;
    uint8_t *packet;
    Team247ParseStatus status = TEAM247_OK;

    assert(store);
    memset(dest, 0x11, sizeof(dest));
    assert(!Team247StoreHasFrame(store));
    assert(Team247StoreCopyInto(store, dest, 2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_NO_FRAME);
    assert(dest[0] == 0x11);

    packet = build_frame(2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA, firstPixels, &len);
    assert(Team247StoreReplace(store, packet, len, &status));
    assert(status == TEAM247_OK);
    free(packet);
    assert(Team247StoreCopyInto(store, dest, 2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_COPIED);
    assert(memcmp(dest, firstPixels, 8) == 0);

    assert(!Team247StoreReplace(store, bad, sizeof(bad), &status));
    assert(status == TEAM247_ERR_TOO_SMALL);
    memset(dest, 0, sizeof(dest));
    assert(Team247StoreCopyInto(store, dest, 2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_COPIED);
    assert(memcmp(dest, firstPixels, 8) == 0);

    packet = build_frame(2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA, secondPixels, &len);
    assert(Team247StoreReplace(store, packet, len, NULL));
    free(packet);
    assert(Team247StoreCopyInto(store, dest, 2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_COPIED);
    assert(memcmp(dest, secondPixels, 8) == 0);
    assert(Team247StoreCopyInto(store, dest, 1, 1, 4, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_MISMATCH);

    Team247StoreDestroy(store);
}

static int send_datagram(const char *path, const uint8_t *data, size_t len) {
    struct sockaddr_un addr;
    int fd;
    ssize_t n;
    size_t pathLen = strlen(path);

    fd = socket(AF_UNIX, SOCK_DGRAM, 0);
    if (fd < 0) {
        return -1;
    }
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    memcpy(addr.sun_path, path, pathLen + 1);
    n = sendto(fd, data, len, 0, (struct sockaddr *)&addr,
               (socklen_t)(offsetof(struct sockaddr_un, sun_path) + pathLen + 1));
    close(fd);
    return n == (ssize_t)len ? 0 : -1;
}

static void wait_until_copied(Team247Store *store, uint8_t *dest, const uint8_t *want, size_t wantLen) {
    int i;
    for (i = 0; i < 200; i++) {
        struct timespec ts;
        if (Team247StoreCopyInto(store, dest, 2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_COPIED
            && memcmp(dest, want, wantLen) == 0) {
            return;
        }
        ts.tv_sec = 0;
        ts.tv_nsec = 10 * 1000 * 1000;
        nanosleep(&ts, NULL);
    }
    fprintf(stderr, "timed out waiting for staged datagram\n");
    assert(0);
}

static void test_datagram_socket(void) {
    char path[80];
    char missingDir[80];
    Team247Store *store = Team247StoreCreate();
    Team247Listener *listener;
    Team247Listener *tiny;
    Team247Store *tinyStore;
    uint8_t pixels[8] = {11, 22, 33, 44, 55, 66, 77, 88};
    uint8_t dest[8];
    size_t len = 0;
    uint8_t *packet;

    snprintf(path, sizeof(path), "/tmp/team247.frame.%d.sock", (int)getpid());
    snprintf(missingDir, sizeof(missingDir), "/tmp/no-such-team247-%d/sock", (int)getpid());
    listener = Team247ListenerCreate(store, missingDir, 0);
    assert(listener);
    assert(Team247ListenerStart(listener) != 0);
    Team247ListenerDestroy(listener);

    listener = Team247ListenerCreate(store, path, 0);
    assert(Team247ListenerStart(listener) == 0);
    packet = build_frame(2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA, pixels, &len);
    assert(send_datagram(path, packet, len) == 0);
    memset(dest, 0, sizeof(dest));
    wait_until_copied(store, dest, pixels, sizeof(pixels));

    assert(send_datagram(path, (const uint8_t *)"T247", 4) == 0);
    assert(send_datagram(path, (const uint8_t *)"", 0) == 0);
    {
        struct timespec ts = {0, 50 * 1000 * 1000};
        nanosleep(&ts, NULL);
    }
    memset(dest, 0, sizeof(dest));
    assert(Team247StoreCopyInto(store, dest, 2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA) == TEAM247_APPLY_COPIED);
    assert(memcmp(dest, pixels, sizeof(pixels)) == 0);

    pixels[0] = 99;
    free(packet);
    packet = build_frame(2, 1, 8, TEAM247_PIXEL_FORMAT_BGRA, pixels, &len);
    assert(send_datagram(path, packet, len) == 0);
    memset(dest, 0, sizeof(dest));
    wait_until_copied(store, dest, pixels, sizeof(pixels));

    tinyStore = Team247StoreCreate();
    tiny = Team247ListenerCreate(tinyStore, path, 8);
    Team247ListenerDestroy(listener);
    assert(Team247ListenerStart(tiny) == 0);
    assert(send_datagram(path, packet, len) == 0);
    {
        int i;
        for (i = 0; i < 200 && Team247ListenerDropped(tiny) == 0; i++) {
            struct timespec ts = {0, 10 * 1000 * 1000};
            nanosleep(&ts, NULL);
        }
    }
    assert(Team247ListenerDropped(tiny) >= 1);
    assert(!Team247StoreHasFrame(tinyStore));
    Team247ListenerDestroy(tiny);
    Team247StoreDestroy(tinyStore);
    Team247StoreDestroy(store);
    free(packet);
    assert(strcmp(TEAM247_FRAME_SOCK_PATH, "/var/tmp/team247.frame.sock") == 0);
}

int main(void) {
    test_parser();
    test_copy_rules();
    test_store_holds_last_good_frame();
    test_datagram_socket();
    puts("frame_stage_test: ok");
    return 0;
}
