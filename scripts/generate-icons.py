#!/usr/bin/env python3
import os
import sys

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.abspath(os.path.join(script_dir, ".."))
    svg_path = os.path.join(project_dir, "share", "open-cursor.svg")

    if not os.path.exists(svg_path):
        print(f"Error: SVG not found at {svg_path}", file=sys.stderr)
        return 1

    try:
        import gi
        gi.require_version('Rsvg', '2.0')
        from gi.repository import Rsvg
        import cairo
    except ImportError as e:
        print(f"Warning: Rsvg or Cairo not available ({e}), skipping PNG icon rendering.")
        return 0

    handle = Rsvg.Handle.new_from_file(svg_path)
    sizes = [16, 24, 32, 48, 64, 128, 256, 512]
    home = os.path.expanduser("~")

    for size in sizes:
        dir_path = os.path.join(home, ".local", "share", "icons", "hicolor", f"{size}x{size}", "apps")
        os.makedirs(dir_path, exist_ok=True)
        out_path = os.path.join(dir_path, "open-cursor.png")
        surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
        cr = cairo.Context(surface)
        cr.scale(size / 256.0, size / 256.0)
        handle.render_cairo(cr)
        surface.write_to_png(out_path)

    # Scalable icon
    scalable_dir = os.path.join(home, ".local", "share", "icons", "hicolor", "scalable", "apps")
    os.makedirs(scalable_dir, exist_ok=True)
    with open(svg_path, "rb") as sf, open(os.path.join(scalable_dir, "open-cursor.svg"), "wb") as df:
        df.write(sf.read())

    print("Icons successfully rendered and installed to ~/.local/share/icons/hicolor/")
    return 0

if __name__ == "__main__":
    sys.exit(main())
