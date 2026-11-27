#!/usr/bin/perl
# Windows Graphics Capture of a whole monitor (hmonitor=) that records only
# the game: with only_hwnd set, a new picture is used only while that window
# is the one in front, isn't minimised, and is what's seen in the middle of
# its monitor. Otherwise (alt-tabbed, a Discord stream or browser over it)
# the last game picture repeats, at the frame rate, so the desktop never gets
# into the recording and the picture keeps pace with the sound.
# Monitor capture gets the finished picture of the screen, so it also sees a
# full-screen game that Windows shows past the desktop, which window capture
# (no frames) and Desktop Duplication (none either) missed on some PCs.
# Needs gfxcapture-keep-going.pl first (repeat_last_frame, dropped frames).
# Usage: perl gfxcapture-game-only.pl libavfilter
use strict;
use warnings;

my $dir = shift or die "usage: $0 libavfilter-dir\n";

sub edit {
    my ($file, @subs) = @_;
    my $path = "$dir/$file";
    open my $in, '<', $path or die "$path: $!\n";
    local $/;
    my $src = <$in>;
    close $in;
    while (my ($what, $re, $new) = splice(@subs, 0, 3)) {
        $src =~ s/$re/$new/ or die "gfxcapture game-only patch: $what not found in $file\n";
    }
    open my $out, '>', $path or die "$path: $!\n";
    print $out $src;
    close $out;
}

edit('vsrc_gfxcapture.h',
    'field', qr/(    uint64_t user_hmonitor;\n)/, "    uint64_t user_hmonitor;\n    uint64_t only_hwnd;\n");

edit('vsrc_gfxcapture.c',
    'option', qr/(    \{ "hmonitor",[^\n]*\n)/,
    "    { \"hmonitor\",        \"pre-existing HMONITOR handle\",      OFFSET(user_hmonitor),  AV_OPT_TYPE_UINT64,     { .i64 = 0 },      0, UINT64_MAX, FLAGS },\n"
  . "    { \"only_hwnd\",       \"new pictures only while this window is what's seen\", OFFSET(only_hwnd), AV_OPT_TYPE_UINT64, { .i64 = 0 }, 0, UINT64_MAX, FLAGS },\n");

my $visible = <<'C';
// The game is what's seen: the window in front, not minimised, and the
// window in the middle of its monitor (Windows can keep a game "in front"
// while a Discord stream or browser is drawn over it).
static bool game_visible(GfxCaptureContext *cctx)
{
    HWND game = (HWND)(uintptr_t)cctx->only_hwnd;
    MONITORINFO mi = { sizeof(mi) };

    if (GetForegroundWindow() != game || IsIconic(game))
        return false;
    if (!GetMonitorInfoW(MonitorFromWindow(game, MONITOR_DEFAULTTONEAREST), &mi))
        return true;
    POINT mid = { mi.rcMonitor.left + (mi.rcMonitor.right - mi.rcMonitor.left) / 2,
                  mi.rcMonitor.top + (mi.rcMonitor.bottom - mi.rcMonitor.top) / 2 };
    HWND seen = WindowFromPoint(mid);
    return seen && GetAncestor(seen, GA_ROOT) == game;
}

static int process_frame_if_exists(AVFilterLink *outlink)
C

my $hidden = <<'C';
        CHECK_HR_RET(capture_frame->get_SystemRelativeTime(&frame_time));

        // Something else is on screen: don't use this picture.
        if (cctx->only_hwnd && !game_visible(cctx))
            return 2;

C

edit('vsrc_gfxcapture_winrt.cpp',
    'helper', qr/static int process_frame_if_exists\(AVFilterLink \*outlink\)\n/, $visible,
    'check', qr/        CHECK_HR_RET\(capture_frame->get_SystemRelativeTime\(&frame_time\)\);\n\n/, $hidden,
    'pass on', qr/    if \(ret == 1\)\n        return 1;\n    if \(ret < 0\)\n        return ret;\n/,
    "    if (ret == 1 || ret == 2)\n        return ret;\n    if (ret < 0)\n        return ret;\n",
    'repeat while hidden', qr/        if \(ret == 1\)\n            continue;\n/,
    "        if (ret == 1)\n            continue;\n"
  . "        if (ret == 2) {\n"
  . "            // Not the game: the last game picture again, when one is due.\n"
  . "            int64_t before = ctx->last_out_pts;\n"
  . "            int r = repeat_last_frame(outlink);\n"
  . "            if (r < 0)\n                return r;\n"
  . "            if (ctx->last_out_pts != before)\n                return 0;\n"
  . "            continue;\n"
  . "        }\n");
