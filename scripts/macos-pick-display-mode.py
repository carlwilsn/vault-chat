#!/usr/bin/env python3
"""Pick the display mode for the Mac CI proof from `displayplacer list` output (stdin).

Prints one displayplacer argument ("id:<persistent id> mode:<n>") for the main
screen, or nothing when no better mode is offered. Preference: a HiDPI
(scaling:on) mode that looks like 1440-1512 px wide (a 13-14" MacBook), then the
scaled mode closest to 1440 wide, then an unscaled mode the app's 1400x900 window
fits in, closest to 1440x900. A runner's display offers what its virtual GPU offers;
whatever is picked, the job logs what it got.
"""
import re
import sys


def pick(text: str):
    screens = re.split(r"\n(?=Persistent screen id:)", text)
    for scr in screens:
        m = re.search(r"Persistent screen id:\s*(\S+)", scr)
        if not m:
            continue
        sid = m.group(1)
        modes = []
        for mm in re.finditer(r"mode (\d+): res:(\d+)x(\d+)(?: hz:(\d+))?.*?(?:scaling:(on|off))?(\s*<-- current mode)?$", scr, re.M):
            n, w, h = int(mm.group(1)), int(mm.group(2)), int(mm.group(3))
            modes.append((n, w, h, mm.group(5) == "on", bool(mm.group(6))))
        if not modes:
            continue
        scaled = [m for m in modes if m[3]]
        good = [m for m in scaled if 1440 <= m[1] <= 1512 and m[2] >= 820]
        if good:
            best = min(good, key=lambda m: (abs(m[1] - 1440), -m[2]))
        elif scaled:
            best = min(scaled, key=lambda m: (abs(m[1] - 1440), -m[2]))
        else:
            plain = [m for m in modes if m[1] >= 1280 and m[2] >= 800]
            if not plain:
                return None
            # The app's window (1400x900) fits whole first, then the closest to 1440x900.
            best = min(plain, key=lambda m: (not (m[1] >= 1440 and m[2] >= 900), abs(m[1] - 1440) + abs(m[2] - 900)))
        if best[4]:
            return None
        return f"id:{sid} mode:{best[0]}"
    return None


if __name__ == "__main__":
    arg = pick(sys.stdin.read())
    if arg:
        print(arg)
