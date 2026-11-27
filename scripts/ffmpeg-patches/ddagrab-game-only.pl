#!/usr/bin/perl
# Screen capture (ddagrab) that records only the game: with `only_hwnd` set,
# new pictures are taken only while that window is in front. While another
# window is (alt-tabbed), the last game picture is repeated instead, so the
# desktop never gets into the recording, and nothing is drawn over it.
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
      "    int        dup_frames;\n    int64_t    only_hwnd;\n} DdagrabContext;\n");

patch('option', qr/(                                                   OFFSET\(dup_frames\), AV_OPT_TYPE_BOOL,       \{ \.i64 = 1    \},       0,       1, FLAGS \},\n)/,
      "                                                   OFFSET(dup_frames), AV_OPT_TYPE_BOOL,       { .i64 = 1    },       0,       1, FLAGS },\n"
    . "    { \"only_hwnd\",  \"take new pictures only while this window is in front\",\n"
    . "                                                   OFFSET(only_hwnd),  AV_OPT_TYPE_INT64,      { .i64 = 0    },       0, INT64_MAX, FLAGS },\n");

my $check = <<'C';
    } else {
        cur_texture = dda->probed_texture;
        dda->probed_texture = NULL;
        ret = 0;
    }

    // Another window in front of the game: keep the last game picture.
    // Before the first one, wait for the game to come to the front.
    if (ret == 0 && dda->only_hwnd && GetForegroundWindow() != (HWND)(intptr_t)dda->only_hwnd) {
        release_resource(&cur_texture);
        IDXGIOutputDuplication_ReleaseFrame(dda->dxgi_outdupl);
        ret = AVERROR(EAGAIN);
    }
C
patch('frame check', qr/    \} else \{\n        cur_texture = dda->probed_texture;\n        dda->probed_texture = NULL;\n        ret = 0;\n    \}\n/, $check);

open my $out, '>', $path or die "$path: $!\n";
print $out $src;
close $out;
