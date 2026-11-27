#!/usr/bin/perl
# Keeps window capture's timeline on real time, so picture and sound stay
# together:
# - Frames that come faster than the frame rate are dropped. Windows has sent
#   thousands a second (e.g. while alt-tabbed); each one got its own 1/fps
#   slot, so the picture's clock raced minutes ahead of the sound: clips were
#   minutes of frozen picture, and the sound fell out of them.
# - Frames that come bunched (two at once, then a double gap) are spread onto
#   the 1/fps grid: each gets the next free slot, at most 2 slots late.
# - While the game sends nothing (hidden, minimised), the last frame is
#   repeated every 100 ms at the real time, like whole-screen capture keeps
#   going.
# Usage: perl gfxcapture-keep-going.pl libavfilter/vsrc_gfxcapture_winrt.cpp
use strict;
use warnings;

my $path = shift or die "usage: $0 vsrc_gfxcapture_winrt.cpp\n";
open my $in, '<', $path or die "$path: $!\n";
local $/;
my $src = <$in>;
close $in;

sub patch {
    my ($what, $re, $new) = @_;
    $src =~ s/$re/$new/ or die "gfxcapture patch: $what not found\n";
}

patch('context fields', qr/(    int64_t first_pts \{ 0 \};\n    int64_t last_pts \{ 0 \};\n)/,
      "    int64_t first_pts { 0 };\n    int64_t last_pts { 0 };\n    int64_t last_out_pts { -1 };\n    uint64_t dropped { 0 };\n    AVFrame *last_frame { nullptr };\n");

patch('uninit', qr/(\n    av_buffer_unref\(&ctx->frames_ref\);\n    av_buffer_unref\(&ctx->device_ref\);\n)/,
      "\n    av_frame_free(&ctx->last_frame);\n    av_buffer_unref(&ctx->frames_ref);\n    av_buffer_unref(&ctx->device_ref);\n");

patch('frame interval helper', qr/\nstatic int process_frame_if_exists\(AVFilterLink \*outlink\)\n/,
      "\n// One frame's time at the chosen frame rate, in TIMESPAN_RES units.\nstatic int64_t frame_interval(GfxCaptureContext *cctx)\n{\n    return FFMAX(1, av_rescale_q(1, av_inv_q(cctx->frame_rate), AVRational{1, TIMESPAN_RES}));\n}\n\nstatic int process_frame_if_exists(AVFilterLink *outlink)\n");

my $drop = <<'C';
        CHECK_HR_RET(capture_frame->get_SystemRelativeTime(&frame_time));

        // Came more than 2 frame slots before its turn: one too many, drop it.
        if (ctx->first_pts && ctx->last_out_pts >= 0) {
            int64_t ivl = frame_interval(cctx);
            if (ctx->last_out_pts + ivl - (frame_time.Duration - ctx->first_pts) > 2 * ivl) {
                if (!(ctx->dropped++ % 1000))
                    av_log(avctx, AV_LOG_WARNING, "Dropping frames that come faster than the frame rate (%" PRIu64 " so far)\n", ctx->dropped);
                return 1;
            }
        }
C
patch('frame time', qr/        CHECK_HR_RET\(capture_frame->get_SystemRelativeTime\(&frame_time\)\);\n/, $drop);
patch('dropped frame', qr/(    \}\);\n)(    if \(ret < 0\)\n        return ret;\n\n    frame->sample_aspect_ratio)/,
      "    });\n    if (ret == 1)\n        return 1;\n    if (ret < 0)\n        return ret;\n\n    frame->sample_aspect_ratio");
patch('activate retry', qr/        int ret = process_frame_if_exists\(outlink\);\n        if \(ret != AVERROR\(EAGAIN\)\)\n            return ret;\n/,
      "        int ret = process_frame_if_exists(outlink);\n        if (ret == 1)\n            continue;\n        if (ret != AVERROR(EAGAIN))\n            return ret;\n");

my $repeat = <<'C';
    frame->pts -= ctx->first_pts;
    if (ctx->last_out_pts >= 0 && frame->pts < ctx->last_out_pts + frame_interval(cctx))
        frame->pts = ctx->last_out_pts + frame_interval(cctx);
    ctx->last_out_pts = frame->pts;

    av_frame_free(&ctx->last_frame);
    ctx->last_frame = av_frame_clone(frame);

    return ff_filter_frame(outlink, frame);
}

// The last frame again, at the current time (the same clock as
// SystemRelativeTime), while the window sends nothing new.
static int repeat_last_frame(AVFilterLink *outlink)
{
    GfxCaptureContext *cctx = CCTX(outlink->src->priv);
    GfxCaptureContextCpp *ctx = cctx->ctx;
    LARGE_INTEGER now, freq;

    if (!ctx->last_frame || !ctx->first_pts)
        return 0;
    QueryPerformanceCounter(&now);
    QueryPerformanceFrequency(&freq);
    int64_t pts = av_rescale(now.QuadPart, TIMESPAN_RES, freq.QuadPart) - ctx->first_pts;
    if (pts < ctx->last_out_pts + frame_interval(cctx))
        return 0;

    AVFrame *frame = av_frame_clone(ctx->last_frame);
    if (!frame)
        return AVERROR(ENOMEM);
    frame->pts = pts;
    ctx->last_out_pts = pts;
    return ff_filter_frame(outlink, frame);
}
C
patch('frame output', qr/    frame->pts -= ctx->first_pts;\n\n    return ff_filter_frame\(outlink, frame\);\n\}\n/, $repeat);

patch('frame wait',
      qr/        if \(!wgctx->frame_arrived_cond\.wait_for\(frame_lock, std::chrono::seconds\(1\), \[&\]\(\) \{\n            return wgctx->frame_seq != last_seq \|\| wgctx->window_closed;\n        \}\)\)\n            break;\n/,
      "        if (!wgctx->frame_arrived_cond.wait_for(frame_lock, std::chrono::milliseconds(100), [&]() {\n            return wgctx->frame_seq != last_seq || wgctx->window_closed;\n        })) {\n            frame_lock.unlock();\n            return repeat_last_frame(outlink);\n        }\n");

open my $out, '>', $path or die "$path: $!\n";
print $out $src;
close $out;
