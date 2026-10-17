# TEAM247FrameTweak (TEST-ONLY)

Tweak Theos/Logos cho pipeline camera của **một app test**. Khi có khung hình gửi tới socket cục bộ, tweak chép khung đó vào sample buffer `32BGRA`. Khi chưa có khung hợp lệ, tweak không ghi buffer và vẫn gọi delegate gốc.

Máy soạn mã này không có Xcode/Theos và không cài lên iPhone. Thư mục Mac `/Users/aech/Downloads/...` không nằm trên máy soạn thảo nên không bị sửa. Cài `.deb` là việc thủ công trên Mac của bạn.

## Nối với TEAM247FrameReceiver v0.2.4

Build `TEAM247FrameReceiver` (project trong `TEAM247-RootHide-IPC-Stream-Receiver-v0.2.4-TEST-ONLY`) đã **BUILD SUCCEEDED**, ra `TEAM247FrameReceiver.app` ở `build/Release-iphoneos`.

Chiều còn lại là tweak này:

1. Copy cả thư mục `TEAM247FrameTweak` lên Mac, cạnh project receiver.
2. Sửa bundle id trong `TEAM247FrameTweak.plist` (bên dưới).
3. Đóng gói bằng Theos trên Mac, rồi cài thủ công vào máy test.
4. Mở **app camera test** trước. Tweak trong tiến trình đó tạo socket.
5. Để `TEAM247FrameReceiver` (hoặc đoạn gửi bạn gắn cạnh app đó) gửi **một datagram Unix** đúng layout bên dưới tới `/var/tmp/team247.frame.sock`.

App receiver là phía gửi. Tweak là phía nhận, chỉ trong app có tên trong filter. Datagram gửi trước khi socket tồn tại sẽ mất. Khung hợp lệ cuối cùng được giữ và chép vào các callback sau, cho tới khi có datagram hợp lệ mới.

README nguồn không ghi bundle id app test, nên filter đang để placeholder:

`com.team247.EDIT_ME.framelab`

Đổi thành bundle id app camera test của bạn trước khi `make package`. Không điền app ngân hàng, KYC, hay đăng nhập.

## Giao thức

Socket datagram Unix: `/var/tmp/team247.frame.sock`. Một datagram là một khung. Số nguyên là little-endian.

| Offset | Số byte | Trường |
| --- | --- | --- |
| 0 | 4 | Magic ASCII `T247` |
| 4 | 4 | `width` uint32 |
| 8 | 4 | `height` uint32 |
| 12 | 4 | `bytesPerRow` uint32 |
| 16 | 4 | `pixelFormat` uint32 = `0x42475241` (`BGRA`, byte trên dây `41 52 47 42`) |
| 20 | `height * bytesPerRow` | Pixel thô, B, G, R, A |

Ràng buộc: `width` và `height` từ 1 đến 4096, `bytesPerRow >= width * 4`, tổng pixel không quá 16 MiB, và độ dài datagram đúng bằng `20 + height * bytesPerRow`. Sai magic, sai format, sai kích thước, hoặc bị cắt thì khung đang stage không bị thay.

Khi chép vào camera, buffer đích phải là `32BGRA`, cùng `width`/`height`. Tweak chỉ chép `width * 4` byte mỗi hàng (bỏ padding nguồn). `bytesPerRow` đích được phép lớn hơn. Khác kích thước hoặc khác format thì buffer camera giữ nguyên. Tweak không scale.

Ví dụ 1×1, pixel xanh dương đục `(B,G,R,A) = (255,0,0,255)`:

```text
54 32 34 37  01 00 00 00  01 00 00 00  04 00 00 00  41 52 47 42  FF 00 00 FF
```

Khung 1080p BGRA khoảng 8 MB. Datagram Unix có thể không chứa nổi khung lớn (`EMSGSIZE`). Preset camera và khung gửi phải cùng kích thước, và phải vừa một datagram. Tweak không tự chia mảnh.

## Hook

`captureOutput:didOutputSampleBuffer:fromConnection:` là callback của delegate, không phải method của `AVCaptureVideoDataOutput`. Tweak hook `setSampleBufferDelegate:queue:` rồi bọc delegate bằng proxy. Proxy mới là chỗ thực hiện selector đó: có khung khớp thì chép pixel, sau đó gọi delegate gốc trên cùng queue. Không có khung thì không ghi gì và vẫn gọi delegate gốc.

Filter plist giới hạn app được tiêm. Không có logic giấu tweak, không bypass phát hiện jailbreak, không che RootHide.

## Build trên Mac

```bash
export THEOS=...   # Theos rootless hoặc RootHide
cd TEAM247FrameTweak
make package THEOS_PACKAGE_SCHEME=rootless
# RootHide Theos:
make package THEOS_PACKAGE_SCHEME=roothide
```

Gói `com.team247.vcam.frametweak`, version `0.2.4`, `ARCHS = arm64`, deployment iOS 15.0. `make install` không kill tiến trình nào (`INSTALL_TARGET_PROCESSES` trống) và repo này không ssh, không cài máy.

Kiểm tra parser và socket trên máy có clang (không cần Theos):

```bash
clang -Wall -Wextra -Werror -std=c11 -pthread -o frame_stage_test frame_stage.c frame_stage_test.c
./frame_stage_test
```
