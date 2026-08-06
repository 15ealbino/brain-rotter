Drop a whisper.cpp build here before packaging if you want to bundle one.

Expected layout:
  resources/whisper/whisper-cli        (Linux/macOS)
  resources/whisper/whisper-cli.exe    (Windows)

Nothing is vendored by default: whisper.cpp is MIT-licensed but its binaries are
platform-specific and large, so Brain Rotter detects a system install instead.
See the README for build instructions.
