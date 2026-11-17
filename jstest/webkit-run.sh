#!/bin/sh
# Playwright's WebKit (WPE MiniBrowser, headless) with our unpacked system libraries: its own wrapper replaces
# LD_LIBRARY_PATH, so this one adds jstest/.libs after the bundled ones. Used by webkit-engine.mjs.
H="$(cd "$(dirname "$0")" && pwd)"
D="$(ls -d "$HOME"/.cache/ms-playwright/webkit-*/minibrowser-wpe | tail -1)"
export WEBKIT_EXEC_PATH="$D/bin" WEBKIT_INJECTED_BUNDLE_PATH="$D/lib" WEBKIT_INSPECTOR_RESOURCES_PATH="$D/share"
export LD_LIBRARY_PATH="$D/lib:$D/sys/lib:$H/.libs/usr/lib/x86_64-linux-gnu:$H/.libs/lib/x86_64-linux-gnu"
export WEBKIT_FORCE_COMPLEX_TEXT=1
# Software EGL (Mesa llvmpipe) from .libs, for a headless host without a GPU.
export __EGL_VENDOR_LIBRARY_DIRS="$H/.libs/usr/share/glvnd/egl_vendor.d" LIBGL_DRIVERS_PATH="$H/.libs/usr/lib/x86_64-linux-gnu/dri"
export EGL_PLATFORM=surfaceless LIBGL_ALWAYS_SOFTWARE=1
export GIO_EXTRA_MODULES="$H/.libs/gio-tls" # TLS only (glib-networking); its proxy/dconf modules break the network process
exec "$D/bin/MiniBrowser" "$@"
