#!/usr/bin/env bash
# Builds a small FFmpeg for Windows with only what CrossPOV uses, by
# cross-compiling on Linux with MinGW. About a tenth the size of a full
# build, and LGPL (no GPL parts), so CrossPOV can ship it.
#
#   scripts/build-ffmpeg.sh OUTPUT.exe [WORK_DIR]
#
# What CrossPOV asks FFmpeg to do, and what that needs:
#   record:     lavfi gfxcapture (the game's window) or ddagrab (screen),
#               both D3D11, + f32le audio on stdin
#               -> scale_d3d11 (resize on the GPU) or hwdownload/format/scale,
#                  pan/alimiter filters
#               -> h264_nvenc / h264_amf / h264_mf (CPU fallback via Windows) + aac
#               -> segment muxer writing MPEG-TS
#   save clip:  concat demuxer -> mp4 / matroska, aac_adtstoasc; parts where
#               you'd tabbed out: decode (d3d11va) -> drawbox -> re-encode
#   thumbnail:  decode h264 -> scale -> mjpeg into a .jpg
#   streamer clips (via yt-dlp): HLS over HTTPS (Windows' own TLS) -> mp4
#   encoder check: lavfi color source -> null muxer
#   tests:      lavfi testsrc2
# Intel GPUs encode through Media Foundation (h264_mf), so there is no QSV.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(realpath -m "${1:?output path}")
WORK=$(realpath -m "${2:-$(mktemp -d)}")
FFMPEG_TAG=n8.1.3
# NVENC headers set the oldest NVIDIA driver that works: 12.1 needs 531.61+
# (spring 2023). Newer headers would quietly drop older drivers.
NVCODEC_TAG=n12.1.14.0
mkdir -p "$WORK" && cd "$WORK"

# A work folder left from another version would silently build that version.
if [ -d ffmpeg ] && [ "$(git -C ffmpeg describe --tags --exact-match 2>/dev/null)" != "$FFMPEG_TAG" ]; then rm -rf ffmpeg; fi
if [ -d nv-codec-headers ] && [ "$(git -C nv-codec-headers describe --tags --exact-match 2>/dev/null)" != "$NVCODEC_TAG" ]; then rm -rf nv-codec-headers prefix; fi
[ -d ffmpeg ] || git clone -q --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git ffmpeg
[ -d nv-codec-headers ] || git clone -q --depth 1 --branch "$NVCODEC_TAG" https://github.com/FFmpeg/nv-codec-headers.git
if [ ! -d amf ]; then
  git clone -q --depth 1 --filter=blob:none --sparse https://github.com/GPUOpen-LibrariesAndSDKs/AMF.git amf
  (cd amf && git sparse-checkout set amf/public/include)
fi

# Header-only SDKs: the GPU drivers provide the actual encoders at run time.
PREFIX="$WORK/prefix"
make -s -C nv-codec-headers PREFIX="$PREFIX" install
mkdir -p "$PREFIX/include/AMF" && cp -r amf/amf/public/include/* "$PREFIX/include/AMF/"

cd ffmpeg
# Window capture keeps only 2 frames waiting for FFmpeg; when frames arrive
# bunched up (Windows composes them unevenly), the rest are dropped. Keep 4.
sed -i 's/^#define CAPTURE_POOL_SIZE 2$/#define CAPTURE_POOL_SIZE 4/' libavfilter/vsrc_gfxcapture_winrt.cpp
grep -q '^#define CAPTURE_POOL_SIZE 4$' libavfilter/vsrc_gfxcapture_winrt.cpp || { echo "couldn't set the window capture pool size" >&2; exit 1; }
# A game can draw a smaller picture than its window (VALORANT at 1568x1080 in
# a 1920x1080 window). Window capture notices but only says so at "verbose";
# say it as a warning so CrossPOV (which logs warnings) can record at the
# game's real size.
sed -i 's/AV_LOG_VERBOSE, "Capture size changed to/AV_LOG_WARNING, "Capture size changed to/' libavfilter/vsrc_gfxcapture_winrt.cpp
grep -q 'AV_LOG_WARNING, "Capture size changed to' libavfilter/vsrc_gfxcapture_winrt.cpp || { echo "couldn't make window capture report its size" >&2; exit 1; }
# VALORANT's picture flips between 1079 and 1080 lines. Window capture
# rebuilds its frame buffers on every size change, dropping the frames in
# them: 1920x1080 clips came out at ~70 fps instead of 144. Keep the buffers
# while the picture still fits in them (and is at most 8 px smaller); only
# what's read from them follows the new size.
perl -0pi -e '
  s/(    SizeInt32 cap_size \{ 0, 0 \};\n)/$1    SizeInt32 pool_size { 0, 0 };\n/ or die "cap_size field not found\n";
  s/(CreateFreeThreaded\([^;]*;\n)/$1    wgctx->pool_size = wgctx->cap_size;\n/ or die "pool creation not found\n";
  s/        CHECK_HR_RET\(wgctx->frame_pool->Recreate\(wgctx->d3d_device.Get\(\), fmt, CAPTURE_POOL_SIZE, frame_size\)\);\n/        bool fits = frame_size.Width <= wgctx->pool_size.Width && frame_size.Height <= wgctx->pool_size.Height &&\n                    wgctx->pool_size.Width - frame_size.Width <= 8 && wgctx->pool_size.Height - frame_size.Height <= 8;\n        if (!fits) {\n            CHECK_HR_RET(wgctx->frame_pool->Recreate(wgctx->d3d_device.Get(), fmt, CAPTURE_POOL_SIZE, frame_size));\n            wgctx->pool_size = frame_size;\n        }\n/ or die "pool recreate not found\n";
' libavfilter/vsrc_gfxcapture_winrt.cpp
grep -q 'wgctx->pool_size = frame_size;' libavfilter/vsrc_gfxcapture_winrt.cpp || { echo "couldn't keep window capture buffers on small size changes" >&2; exit 1; }
# Keep window capture's timeline on real time: drop frames that come faster
# than the frame rate, spread bunched ones onto the grid, and repeat the last
# frame while the game sends none (alt-tabbed). See the patch for why.
perl "$HERE/ffmpeg-patches/gfxcapture-keep-going.pl" libavfilter/vsrc_gfxcapture_winrt.cpp
grep -q 'repeat_last_frame(outlink)' libavfilter/vsrc_gfxcapture_winrt.cpp || { echo "couldn't keep window capture on real time" >&2; exit 1; }
# Screen capture of a full-screen game records only the game: new pictures
# only while its window is in front (only_hwnd), the last one repeated while
# you're tabbed out. See the patch.
perl "$HERE/ffmpeg-patches/ddagrab-game-only.pl" libavfilter/vsrc_ddagrab.c
grep -q 'only_hwnd' libavfilter/vsrc_ddagrab.c || { echo "couldn't make screen capture game-only" >&2; exit 1; }
# Window capture enlarges with a cubic B-spline (its "bilinear" and "bicubic"
# both use it), which smooths as it enlarges: stretched clips looked blurry.
# Swap in Catmull-Rom, the sharp bicubic (9 bilinear samples; MIT, after
# TheRealMJP's SampleTextureCatmullRom).
CATMULL="$HERE/ffmpeg-patches/gfxcapture-catmull-rom.hlsl" perl -0pi -e '
  local $/; open my $f, "<", $ENV{CATMULL} or die "patch file: $!"; my $new = <$f>;
  s/    float4 texBicubic\(.*?(?=    float4 unpremultiply\()/$new/s or die "texBicubic not found\n";
' libavfilter/vsrc_gfxcapture_shader.h
grep -q 'float2 w12 = w1 + w2;' libavfilter/vsrc_gfxcapture_shader.h || { echo "couldn't switch window capture to Catmull-Rom" >&2; exit 1; }
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure \
  --prefix="$PREFIX" \
  --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include -O2" \
  --extra-cxxflags="-I$PREFIX/include -O2" \
  --extra-ldflags="-static -static-libgcc -s" \
  --disable-everything --disable-autodetect \
  --disable-debug --disable-doc --disable-ffplay --disable-ffprobe \
  --disable-shared --enable-static \
  --enable-w32threads --enable-d3d11va --enable-ffnvcodec --enable-nvenc --enable-amf \
  --enable-mediafoundation --enable-schannel --enable-network \
  --enable-indev=lavfi \
  --enable-filter=ddagrab,gfxcapture,fps,drawbox,setsar,scale_d3d11,hwdownload,hwupload,format,scale,pan,alimiter,aresample,aformat,anull,null,color,testsrc2,setpts,asetpts,trim,atrim,copy,acopy \
  --enable-encoder=h264_nvenc,h264_amf,h264_mf,hevc_nvenc,hevc_amf,hevc_mf,aac,mjpeg,wrapped_avframe,rawvideo,pcm_s16le \
  --enable-decoder=h264,hevc,aac,aac_fixed,mp3float,pcm_f32le,pcm_s16le,mjpeg,png,rawvideo,wrapped_avframe \
  --enable-demuxer=concat,mpegts,mov,matroska,hls,aac,h264,pcm_f32le,flv,image2,mjpeg \
  --enable-muxer=segment,mpegts,mp4,mov,matroska,null,image2,mjpeg,adts,hls \
  --enable-parser=h264,hevc,aac,mjpeg \
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,h264_metadata \
  --enable-protocol=file,pipe,http,https,tcp,tls,crypto,hls,data,concat \
  --enable-hwaccel=h264_d3d11va,hevc_d3d11va \
  --enable-swscale --enable-swresample

# Window capture needs MinGW 13+ (Windows' capture headers); say so plainly
# instead of quietly building without it.
grep -q "CONFIG_GFXCAPTURE_FILTER 1" config_components.h || { echo "gfxcapture (window capture) was not enabled: MinGW 13 or newer is needed" >&2; exit 1; }

make -s -j"$(nproc)"
mkdir -p "$(dirname "$OUT")"
cp ffmpeg.exe "$OUT"
ls -la "$OUT"
