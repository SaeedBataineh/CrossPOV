#!/usr/bin/perl
# Screen capture (ddagrab) that reconnects instead of stopping. Windows takes
# Desktop Duplication away (DXGI_ERROR_ACCESS_LOST, 887a0026) on full-screen
# switches, alt-tabbing into games, display mode changes and UAC prompts;
# FFmpeg's ddagrab then ended the recording for good (the picture froze on
# the last frame, or a clip had no picture at all). As Microsoft documents,
# the lost duplication is released and a new one made; until it's back, the
# last picture repeats, so the recording never stops.
# Usage: perl ddagrab-reconnect.pl libavfilter/vsrc_ddagrab.c
use strict;
use warnings;

my $path = shift or die "usage: $0 vsrc_ddagrab.c\n";
open my $in, '<', $path or die "$path: $!\n";
local $/;
my $src = <$in>;
close $in;

sub patch {
    my ($what, $re, $new) = @_;
    $src =~ s/$re/$new/ or die "ddagrab reconnect patch: $what not found\n";
}

patch('field', qr/(    int64_t first_pts;\n)/, "    int64_t first_pts;\n    int64_t reconnect_at;\n");

my $start = <<'C';
static int next_frame_internal(AVFilterContext *avctx, ID3D11Texture2D **desktop_texture, int need_frame)
{
    DXGI_OUTDUPL_FRAME_INFO frame_info;
    DdagrabContext *dda = avctx->priv;
    IDXGIResource *desktop_resource = NULL;
    HRESULT hr;
    int ret;

    // Lost (see the top of this patch): make a new one, at most 4 times a second.
    if (!dda->dxgi_outdupl) {
        int64_t t = av_gettime_relative();
        if (t - dda->reconnect_at < 250000)
            return AVERROR(EAGAIN);
        dda->reconnect_at = t;
        if (init_dxgi_dda(avctx) < 0 || !dda->dxgi_outdupl)
            return AVERROR(EAGAIN);
        av_log(avctx, AV_LOG_WARNING, "Screen capture reconnected\n");
    }
C
patch('reconnect on entry',
      qr/static int next_frame_internal\(AVFilterContext \*avctx, ID3D11Texture2D \*\*desktop_texture, int need_frame\)\n\{\n    DXGI_OUTDUPL_FRAME_INFO frame_info;\n    DdagrabContext \*dda = avctx->priv;\n    IDXGIResource \*desktop_resource = NULL;\n    HRESULT hr;\n    int ret;\n/,
      $start);

patch('access lost',
      qr/    \} else if \(FAILED\(hr\)\) \{\n        av_log\(avctx, AV_LOG_ERROR, "AcquireNextFrame failed: %lx\\n", hr\);\n        return AVERROR_EXTERNAL;\n    \}\n/,
      "    } else if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) {\n"
    . "        av_log(avctx, AV_LOG_WARNING, \"Screen capture lost (%lx), reconnecting\\n\", hr);\n"
    . "        release_resource(&dda->dxgi_outdupl);\n"
    . "        dda->reconnect_at = 0;\n"
    . "        return AVERROR(EAGAIN);\n"
    . "    } else if (FAILED(hr)) {\n"
    . "        av_log(avctx, AV_LOG_ERROR, \"AcquireNextFrame failed: %lx\\n\", hr);\n"
    . "        return AVERROR_EXTERNAL;\n"
    . "    }\n");

patch('error release',
      qr/    hr = IDXGIOutputDuplication_ReleaseFrame\(dda->dxgi_outdupl\);\n    if \(FAILED\(hr\)\)\n        av_log\(avctx, AV_LOG_ERROR, "DDA error ReleaseFrame failed!\\n"\);\n/,
      "    if (dda->dxgi_outdupl && FAILED(IDXGIOutputDuplication_ReleaseFrame(dda->dxgi_outdupl)))\n"
    . "        release_resource(&dda->dxgi_outdupl); // lost: reconnect next time\n");

patch('frame release',
      qr/    hr = IDXGIOutputDuplication_ReleaseFrame\(dda->dxgi_outdupl\);\n    if \(FAILED\(hr\)\) \{\n        av_log\(avctx, AV_LOG_ERROR, "DDA ReleaseFrame failed!\\n"\);\n        ret = AVERROR_EXTERNAL;\n        goto fail;\n    \}\n/,
      "    // The picture is already copied: if the duplication was lost meanwhile,\n"
    . "    // keep this frame and reconnect next time.\n"
    . "    hr = dda->dxgi_outdupl ? IDXGIOutputDuplication_ReleaseFrame(dda->dxgi_outdupl) : S_OK;\n"
    . "    if (FAILED(hr)) {\n"
    . "        av_log(avctx, AV_LOG_WARNING, \"Screen capture lost (%lx), reconnecting\\n\", hr);\n"
    . "        release_resource(&dda->dxgi_outdupl);\n"
    . "        dda->reconnect_at = 0;\n"
    . "    }\n");

patch('fail release',
      qr/    if \(cur_texture\)\n        IDXGIOutputDuplication_ReleaseFrame\(dda->dxgi_outdupl\);\n/,
      "    if (cur_texture && dda->dxgi_outdupl)\n        IDXGIOutputDuplication_ReleaseFrame(dda->dxgi_outdupl);\n");

open my $out, '>', $path or die "$path: $!\n";
print $out $src;
close $out;
