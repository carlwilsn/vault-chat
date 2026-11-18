#!/usr/bin/env python3
"""Where the macOS traffic lights sit against the title bar, measured from a window screenshot.

Usage: macos-traffic-lights.py window.png [max_off_px]
Prints one line of numbers (for checks.txt) and exits 1 when the close button's vertical centre is more than
max_off_px (default 1) from the title bar's centre (half way from the window's top to the bar's bottom border).
Pure Python (zlib PNG reader): a CI runner needs no imaging library. Pixels are the screenshot's own (1x or 2x).
"""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, w = 8, b"", None
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and interlace == 0 and ctype in (2, 6), "only 8-bit RGB/RGBA, not interlaced"
            bpp = 4 if ctype == 6 else 3
        elif kind == b"IDAT":
            idat += body
    raw, stride, rows, prev = zlib.decompress(idat), w * bpp, [], bytearray(w * bpp)
    i = 0
    for _ in range(h):
        f, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b, c = prev[x], (prev[x - bpp] if x >= bpp else 0)
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append([tuple(line[x:x + 3]) for x in range(0, stride, bpp)])
        prev = line
    return w, h, rows


def measure(path):
    w, h, px = read_png(path)
    s = 2 if w >= 2000 else 1  # a Retina capture is twice the points
    # The close button: the reddest blob in the top-left corner.
    red = [(x, y) for y in range(min(h, 60 * s)) for x in range(min(w, 60 * s))
           if px[y][x][0] > 180 and px[y][x][1] < 130 and px[y][x][2] < 130]
    if not red:
        return None, "no red close button in the top-left corner (window not focused or not in the shot)"
    ys = [y for _, y in red]
    xs = [x for x, _ in red]
    button = (min(ys) + max(ys)) / 2
    # The bar's bottom border: the first row below the buttons where most of the bar's width changes at once.
    cols = list(range(w // 3, w - 20, 7))
    border = None
    for y in range(max(ys) + 1, min(h - 1, 80 * s)):
        changed = sum(1 for x in cols if sum(abs(a - b) for a, b in zip(px[y][x], px[y - 1][x])) > 12)
        if changed > 0.8 * len(cols):
            border = y
            break
    if border is None:
        return None, "no title bar border found"
    bar = border / 2
    return {"scale": s, "button_top": min(ys), "button_bottom": max(ys), "button_left": min(xs), "button_right": max(xs),
            "button_centre": button, "bar_border": border, "bar_centre": bar, "off": button - bar}, None


if __name__ == "__main__":
    m, why = measure(sys.argv[1])
    limit = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    if m is None:
        print(f"traffic lights: FAIL ({why})")
        sys.exit(1)
    ok = abs(m["off"]) <= limit * m["scale"]
    print("traffic lights: {} close button rows {}-{} (centre {:.1f}), cols {}-{}; title bar border at {} (centre {:.1f}); "
          "off by {:+.1f} px (limit {} px, scale {}x)".format(
              "ok" if ok else "FAIL", m["button_top"], m["button_bottom"], m["button_centre"], m["button_left"],
              m["button_right"], m["bar_border"], m["bar_centre"], m["off"], limit, m["scale"]))
    sys.exit(0 if ok else 1)
