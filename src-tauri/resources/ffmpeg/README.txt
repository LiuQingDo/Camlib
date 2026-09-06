Place the platform ffmpeg executable here before a release build:

- Windows: ffmpeg.exe
- macOS/Linux: ffmpeg

Development uses CAMLIB_FFMPEG_PATH first, then ffmpeg on PATH. The packaged
application looks in this resource directory first. This file is kept in the
repository so the resource layout is explicit without shipping a third-party
binary.
