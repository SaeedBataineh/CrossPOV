# CrossPOV Recorder

A small program with no windows that records games with OBS Studio's engine
(libobs), for the CrossPOV app. It loads `obs.dll` and OBS's own plugins
(Game Capture, the hardware encoders, application audio capture, the replay
buffer) from an unmodified OBS Studio, and takes its orders from CrossPOV
over a private connection on this PC (127.0.0.1, with a random key).

It sits in OBS's `bin/64bit` folder, next to `obs.dll`:

    crosspov-recorder.exe --port <port> --key <key>

It connects to 127.0.0.1:<port>, sends the key, then answers one JSON
request per line (`setup`, `apply`, `save`, `stats`, `show_game`,
`running`, `quit`). libobs writes its own log to standard output.

Licensed under the GNU General Public License, version 2 or later (see
LICENSE), like OBS Studio, whose libobs it uses.
