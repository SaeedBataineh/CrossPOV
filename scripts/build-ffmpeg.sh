#!/usr/bin/env bash
# Builds a small FFmpeg for Windows with only what CrossPOV uses, by
# cross-compiling on Linux with MinGW. About a tenth the size of a full
# build, and LGPL (no GPL parts), so CrossPOV can ship it.
#
#   scripts/build-ffmpeg.sh OUTPUT.exe [WORK_DIR]
#
# What CrossPOV asks FFmpeg to do, and what that needs:
#   record:     lavfi ddagrab (screen, D3D11) + f32le audio on stdin
#               -> scale_d3d11 (resize on the GPU) or hwdownload/format/scale,
#                  pan/alimiter filters
#               -> h264_nvenc / h264_amf / h264_mf (CPU fallback via Windows) + aac
#               -> segment muxer writing MPEG-TS
#   save clip:  concat demuxer -> mp4 / matroska, aac_adtstoasc
#   thumbnail:  decode h264 -> scale -> mjpeg into a .jpg
#   streamer clips (via yt-dlp): HLS over HTTPS (Windows' own TLS) -> mp4
#   encoder check: lavfi color source -> null muxer
#   tests:      lavfi testsrc2
# Intel GPUs encode through Media Foundation (h264_mf), so there is no QSV.
set -euo pipefail

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
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure \
  --prefix="$PREFIX" \
  --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include -O2" \
  --extra-ldflags="-static -static-libgcc -s" \
  --disable-everything --disable-autodetect \
  --disable-debug --disable-doc --disable-ffplay --disable-ffprobe \
  --disable-shared --enable-static \
  --enable-w32threads --enable-d3d11va --enable-ffnvcodec --enable-nvenc --enable-amf \
  --enable-mediafoundation --enable-schannel --enable-network \
  --enable-indev=lavfi \
  --enable-filter=ddagrab,scale_d3d11,hwdownload,hwupload,format,scale,pan,alimiter,aresample,aformat,anull,null,color,testsrc2,setpts,asetpts,trim,atrim,copy,acopy \
  --enable-encoder=h264_nvenc,h264_amf,h264_mf,aac,mjpeg,wrapped_avframe,rawvideo,pcm_s16le \
  --enable-decoder=h264,hevc,aac,aac_fixed,mp3float,pcm_f32le,pcm_s16le,mjpeg,png,rawvideo,wrapped_avframe \
  --enable-demuxer=concat,mpegts,mov,matroska,hls,aac,h264,pcm_f32le,flv,image2,mjpeg \
  --enable-muxer=segment,mpegts,mp4,mov,matroska,null,image2,mjpeg,adts,hls \
  --enable-parser=h264,hevc,aac,mjpeg \
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,h264_metadata \
  --enable-protocol=file,pipe,http,https,tcp,tls,crypto,hls,data,concat \
  --enable-swscale --enable-swresample

make -s -j"$(nproc)"
mkdir -p "$(dirname "$OUT")"
cp ffmpeg.exe "$OUT"
ls -la "$OUT"
