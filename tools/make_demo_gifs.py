#!/usr/bin/env python3
"""Generate demo GIFs for Clean Copy READMEs from real CLI output (Pillow only)."""
from PIL import Image, ImageDraw, ImageFont
import glob

W, H = 880, 420
SCALE = 2  # retina render, downscale at save
BG = (30, 30, 40)
BAR = (58, 58, 70)
FG = (220, 224, 235)
PROMPT = (120, 220, 160)
ACCENT = (130, 180, 255)
DIM = (140, 145, 158)

def font(size):
    for p in ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf",
              "/Library/Fonts/JetBrainsMono-Regular.ttf"]:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()

F = lambda s: font(s * SCALE)

def frame(lines):
    img = Image.new("RGB", (W * SCALE, H * SCALE), BG)
    d = ImageDraw.Draw(img)
    # title bar with traffic lights
    d.rectangle([0, 0, W * SCALE, 36 * SCALE], fill=BAR)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([14 * SCALE + i * 22 * SCALE, 12 * SCALE, 26 * SCALE + i * 22 * SCALE, 24 * SCALE], fill=c)
    d.text((W * SCALE // 2 - 60 * SCALE, 10 * SCALE), "terminal", font=F(13), fill=DIM)
    y = 56 * SCALE
    lh = int(17 * SCALE * 1.45)
    for kind, text in lines:
        color = {"cmd": PROMPT, "out": FG, "dim": DIM, "accent": ACCENT}[kind]
        prefix = "$ " if kind == "cmd" else ""
        # simple word wrap
        maxch = (W - 60) * SCALE // d.textlength("M", font=F(13))
        cur = ""
        for word in text.split(" "):
            trial = (cur + " " + word).strip()
            if d.textlength(prefix + trial, font=F(13)) > (W - 60) * SCALE:
                d.text((30 * SCALE, y), prefix + cur, font=F(13), fill=color)
                y += lh
                prefix = "  "
                cur = word
            else:
                cur = trial
        d.text((30 * SCALE, y), prefix + cur, font=F(13), fill=color)
        y += lh
    return img.resize((W, H), Image.LANCZOS)

# ---- CLI demo: three scenes from REAL output ----
scene1 = [
    ("dim", "# paste dirty HTML, get clean Markdown"),
    ("cmd", 'echo \'<h1>Title</h1><p>Some <b>bold</b> text and a <a href="https://example.com">link</a>.</p>\' | clean-copy'),
    ("out", ""),
    ("out", "# Title"),
    ("out", ""),
    ("out", "Some **bold** text and a [link](https://example.com)."),
    ("out", ""),
    ("dim", "clean-copy: 1 block → markdown (112 chars)"),
]
scene2 = [
    ("dim", "# any web page → readable Markdown"),
    ("cmd", "clean-copy -u https://v8.dev/blog/json-stringify"),
    ("out", "`JSON.stringify` is a core JavaScript function for serializing"),
    ("out", "data. Its performance directly affects common operations across"),
    ("out", "the web, from serializing data for a network request to saving"),
    ("out", "data to `localStorage`. A faster `JSON.stringify` translates to"),
    ("out", "quicker page interactions and more responsive applications..."),
    ("dim", "clean-copy: v8.dev → markdown (19,642 chars)"),
]
scene3 = [
    ("dim", "# plain-text mode strips all formatting"),
    ("cmd", "clean-copy -t rich_text.html | pbcopy"),
    ("out", "Quarterly revenue grew 18% year over year, driven by"),
    ("out", "subscription upgrades in EMEA."),
    ("out", ""),
    ("dim", "# macOS round-trip: dirty clipboard in, clean Markdown out"),
    ("cmd", "pbpaste | clean-copy | pbcopy"),
]

frames = []
for sc in [scene1, scene2, scene3]:
    # progressive reveal within each scene
    shown = []
    for line in sc:
        shown.append(line)
        frames.append(frame(shown))
    for _ in range(8):   # hold scene
        frames.append(frame(shown))

def save_gif(path, fps_ms=550):
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=fps_ms, loop=0)

save_gif("demo-cli.gif")

# ---- Extension demo: before/after selection copy ----
def ext_frame(step):
    img = Image.new("RGB", (W * SCALE, H * SCALE), (245, 245, 248))
    d = ImageDraw.Draw(img)
    f_ui = F(12); f_mono = F(11)
    # fake browser chrome
    d.rectangle([0, 0, W * SCALE, 44 * SCALE], fill=(222, 223, 228))
    d.rounded_rectangle([120 * SCALE, 10 * SCALE, (W - 120) * SCALE, 34 * SCALE], radius=10 * SCALE, fill=(255, 255, 255))
    d.text((136 * SCALE, 15 * SCALE), "example.com/quarterly-report", font=f_ui, fill=(90, 90, 100))
    body = [
        "Q3 Report — FY2026",
        "",
        "Revenue increased by eighteen percent (18%) compared to the",
        "same period last fiscal year, primarily attributable to",
        "subscription tier upgrades within the EMEA market segment.",
    ]
    y = 70 * SCALE
    for ln in body:
        color = (25, 25, 35) if not step or step > 1 else (25, 25, 35)
        d.text((50 * SCALE, y), ln, font=f_ui, fill=color)
        y += 26 * SCALE
    if step >= 1:  # highlight the messy paragraph
        hl = (255, 236, 150)
        d.rectangle([46 * SCALE, 122 * SCALE - 4 * SCALE, (W - 60) * SCALE, 200 * SCALE], fill=hl,
                    outline=None)
        yy = 122 * SCALE
        for ln in body[2:]:
            d.text((50 * SCALE, yy), ln, font=f_ui, fill=(25, 25, 35))
            yy += 26 * SCALE
        d.text(((W - 210) * SCALE, 210 * SCALE), "→ right-click → Clean Copy", font=f_ui, fill=(60, 60, 200))
    if step >= 2:  # result clipboard card
        card = [
            "### Q3 Report — FY2026",
            "",
            "Revenue increased **18%** YoY, driven by subscription",
            "upgrades in EMEA.",
        ]
        ch = 34 * SCALE
        top = H * SCALE - (len(card) + 1) * ch - 20 * SCALE
        d.rounded_rectangle([40 * SCALE, top - 14 * SCALE, (W - 40) * SCALE, H * SCALE - 16 * SCALE],
                            radius=12 * SCALE, fill=(255, 255, 255), outline=(200, 200, 210), width=SCALE)
        d.text((56 * SCALE, top - 10 * SCALE), "📋 clipboard (Markdown)", font=f_ui, fill=(120, 120, 130))
        yy = top + 16 * SCALE
        for ln in card:
            d.text((56 * SCALE, yy), ln, font=font(11 * SCALE), fill=(30, 30, 40))
            yy += ch
    return img.resize((W, H), Image.LANCZOS)

eframes = [ext_frame(s) for s in range(3) for _ in range(5)]
eframes[0].save("demo-extension.gif", save_all=True, append_images=eframes[1:], duration=900, loop=0)
print("done:", len(frames), "cli frames,", len(eframes), "ext frames")
