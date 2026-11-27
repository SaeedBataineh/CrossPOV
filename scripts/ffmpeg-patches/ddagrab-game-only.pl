#!/usr/bin/perl
# Screen capture (ddagrab) that records only the game: with `only_hwnd` set,
# new pictures are taken only while that window is in front and is what's
# seen on the screen. Otherwise (alt-tabbed, or a Discord stream or browser
# drawn over the game), the last game picture is repeated instead, so the
# desktop never gets into the recording, and nothing is drawn over it.
# Before the game's first picture, a black one stands in: the picture must
# start with the sound (FFmpeg starts each input's clock at its first frame;
# a late first picture left the sound coming in only in bursts).
# Windows can stop handing screen capture the game's frames (a windowed
# game drawn past the desktop); it then returns its last desktop picture as
# if new. With only_hwnd that is never taken: the last game picture repeats,
# and after 3 s with the game in front and no new picture a warning says so,
# so CrossPOV can switch to window capture.
# The screen recorded is the one the game is on, found from its window
# (only_hwnd, or monitor_hwnd for the whole screen without the game-only part):
# a number worked out by another program pointed at the wrong monitor.
# Usage: perl ddagrab-game-only.pl libavfilter/vsrc_ddagrab.c
use strict;
use warnings;

my $path = shift or die "usage: $0 vsrc_ddagrab.c\n";
open my $in, '<', $path or die "$path: $!\n";
local $/;
my $src = <$in>;
close $in;

sub patch {
    my ($what, $re, $new) = @_;
    $src =~ s/$re/$new/ or die "ddagrab patch: $what not found\n";
}

patch('context field', qr/    int        dup_frames;\n\} DdagrabContext;\n/,
      "    int        dup_frames;\n    int64_t    only_hwnd;\n    int64_t    monitor_hwnd;\n} DdagrabContext;\n");

patch('option', qr/(                                                   OFFSET\(dup_frames\), AV_OPT_TYPE_BOOL,       \{ \.i64 = 1    \},       0,       1, FLAGS \},\n)/,
      "                                                   OFFSET(dup_frames), AV_OPT_TYPE_BOOL,       { .i64 = 1    },       0,       1, FLAGS },\n"
    . "    { \"only_hwnd\",  \"take new pictures only while this window is in front\",\n"
    . "                                                   OFFSET(only_hwnd),  AV_OPT_TYPE_INT64,      { .i64 = 0    },       0, INT64_MAX, FLAGS },\n"
    . "    { \"monitor_hwnd\", \"record the screen this window is on\",\n"
    . "                                                   OFFSET(monitor_hwnd), AV_OPT_TYPE_INT64,    { .i64 = 0    },       0, INT64_MAX, FLAGS },\n");

patch('game frame time', qr/    int64_t first_pts;\n/, "    int64_t first_pts;\n    int64_t last_game_frame;\n    int64_t stall_warned;\n    int64_t cover_warned;\n");

patch('no stale desktop', qr/        if \(need_frame\) \{\n/, "        if (need_frame || dda->only_hwnd) {\n");

patch('render target', qr/    if \(dda->draw_mouse\)\n        dda->frames_hwctx->BindFlags \|= D3D11_BIND_RENDER_TARGET;\n/,
      "    if (dda->draw_mouse || dda->only_hwnd)\n        dda->frames_hwctx->BindFlags |= D3D11_BIND_RENDER_TARGET;\n");

my $black = <<'C';
// The game is what's on this screen: the window in front, not minimised,
// and the window seen in the middle of the screen (Windows can keep a game
// "in front" while a Discord stream or browser is drawn over it).
static int game_visible(AVFilterContext *avctx, DdagrabContext *dda)
{
    HWND game = (HWND)(intptr_t)dda->only_hwnd;
    const RECT *r = &dda->output_desc.DesktopCoordinates;
    POINT mid = { r->left + (r->right - r->left) / 2, r->top + (r->bottom - r->top) / 2 };
    HWND seen;

    if (GetForegroundWindow() != game || IsIconic(game))
        return 0;
    seen = WindowFromPoint(mid);
    seen = seen ? GetAncestor(seen, GA_ROOT) : NULL;
    if (seen != game) {
        // Say what covers it, once a minute (an always-on-top overlay would show up here).
        int64_t t = av_gettime_relative();
        if (t - dda->cover_warned > 60000000) {
            char cls[64] = "";
            dda->cover_warned = t;
            if (seen)
                GetClassNameA(seen, cls, sizeof(cls));
            av_log(avctx, AV_LOG_WARNING, "Game in front but covered by another window (%s)\n", cls);
        }
        return 0;
    }
    return 1;
}

// A black frame, for before the game's first picture.
static AVFrame *black_frame(AVFilterLink *outlink)
{
    DdagrabContext *dda = outlink->src->priv;
    D3D11_TEXTURE2D_DESC desc;
    D3D11_RENDER_TARGET_VIEW_DESC rtv_desc = { 0 };
    ID3D11RenderTargetView *rtv = NULL;
    static const float black[4] = { 0.f, 0.f, 0.f, 1.f };
    AVFrame *frame = ff_get_video_buffer(outlink, dda->width, dda->height);

    if (!frame)
        return NULL;
    ID3D11Texture2D_GetDesc((ID3D11Texture2D*)frame->data[0], &desc);
    rtv_desc.Format = desc.Format;
    if (desc.ArraySize > 1) {
        rtv_desc.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2DARRAY;
        rtv_desc.Texture2DArray.ArraySize = 1;
        rtv_desc.Texture2DArray.FirstArraySlice = (UINT)(intptr_t)frame->data[1];
    } else {
        rtv_desc.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
    }
    if (FAILED(ID3D11Device_CreateRenderTargetView(dda->device_hwctx->device, (ID3D11Resource*)frame->data[0], &rtv_desc, &rtv))) {
        av_frame_free(&frame);
        return NULL;
    }
    ID3D11DeviceContext_ClearRenderTargetView(dda->device_hwctx->device_context, rtv, black);
    ID3D11RenderTargetView_Release(rtv);

    frame->sample_aspect_ratio = (AVRational){1, 1};
    frame->color_range     = AVCOL_RANGE_JPEG;
    frame->color_primaries = AVCOL_PRI_BT709;
    frame->color_trc       = dda->raw_format == DXGI_FORMAT_R16G16B16A16_FLOAT ? AVCOL_TRC_LINEAR : AVCOL_TRC_IEC61966_2_1;
    frame->colorspace      = AVCOL_SPC_RGB;
    return frame;
}

static int ddagrab_request_frame(AVFilterLink *outlink)
C
patch('black frame', qr/static int ddagrab_request_frame\(AVFilterLink \*outlink\)\n/, $black);

my $check = <<'C';
    } else {
        cur_texture = dda->probed_texture;
        dda->probed_texture = NULL;
        ret = 0;
    }

    // Another window in front of the game: keep the last game picture.
    if (dda->only_hwnd && !game_visible(avctx, dda)) {
        if (ret == 0) {
            release_resource(&cur_texture);
            IDXGIOutputDuplication_ReleaseFrame(dda->dxgi_outdupl);
            ret = AVERROR(EAGAIN);
        }
        dda->last_game_frame = av_gettime_relative();
    } else if (dda->only_hwnd) {
        // The game in front: is Windows still giving us its pictures?
        int64_t t = av_gettime_relative();
        if (ret == 0 || !dda->last_game_frame)
            dda->last_game_frame = t;
        else if (t - dda->last_game_frame > 3000000 && t - dda->stall_warned > 30000000) {
            dda->stall_warned = t;
            av_log(avctx, AV_LOG_WARNING, "Game in front but no new pictures for 3 s\n");
        }
    }
    // No game picture yet: black (kept, so it repeats until there is one).
    if (dda->only_hwnd && ret == AVERROR(EAGAIN) && !dda->last_frame->buf[0]) {
        frame = black_frame(outlink);
        if (!frame)
            return AVERROR(ENOMEM);
        ret = av_frame_replace(dda->last_frame, frame);
        if (ret < 0) {
            av_frame_free(&frame);
            return ret;
        }
        goto frame_done;
    }
C
patch('frame check', qr/    \} else \{\n        cur_texture = dda->probed_texture;\n        dda->probed_texture = NULL;\n        ret = 0;\n    \}\n/, $check);

my $pick = <<'C';
    // Recording a game: capture the screen the game is on (by its monitor,
    // not a number another program worked out; a minimised game counts as
    // where it goes back to).
    if (dda->only_hwnd || dda->monitor_hwnd) {
        HWND game = (HWND)(intptr_t)(dda->only_hwnd ? dda->only_hwnd : dda->monitor_hwnd);
        HMONITOR mon;
        WINDOWPLACEMENT place = { sizeof(place) };
        if (IsIconic(game) && GetWindowPlacement(game, &place))
            mon = MonitorFromRect(&place.rcNormalPosition, MONITOR_DEFAULTTONEAREST);
        else
            mon = MonitorFromWindow(game, MONITOR_DEFAULTTONEAREST);
        for (UINT i = 0; ; i++) {
            IDXGIOutput *o = NULL;
            DXGI_OUTPUT_DESC d;
            if (FAILED(IDXGIAdapter_EnumOutputs(dxgi_adapter, i, &o)))
                break;
            if (SUCCEEDED(IDXGIOutput_GetDesc(o, &d)) && d.Monitor == mon) {
                if ((int)i != dda->output_idx)
                    av_log(avctx, AV_LOG_WARNING, "The game is on screen %u (not %d): recording that one\n", i, dda->output_idx);
                dda->output_idx = i;
                IDXGIOutput_Release(o);
                break;
            }
            IDXGIOutput_Release(o);
        }
    }

    hr = IDXGIAdapter_EnumOutputs(dxgi_adapter, dda->output_idx, &dxgi_output);
C
patch('pick output', qr/    hr = IDXGIAdapter_EnumOutputs\(dxgi_adapter, dda->output_idx, &dxgi_output\);\n/, $pick);

open my $out, '>', $path or die "$path: $!\n";
print $out $src;
close $out;
