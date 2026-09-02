"""
bikefit.py -- Sitzpositionsanalyse aus einem Seitenvideo auf der Rolle.

Befehle:
  python bikefit.py check  VIDEO                 Aufnahme pruefen (Schritt 2)
  python bikefit.py run    VIDEO [--femur 430 --shank 440] [--model yolo11x-pose.pt]
                                                 Messen, Video mit Overlay, Bericht (Schritt 5)
  python bikefit.py render VIDEO                 Nur das Overlay neu zeichnen (Punkte aus dem Cache)

Die Geometrie steckt in fit_core.py, der Selbsttest in selftest.py.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

import fit_core as fc

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"


# ----------------------------------------------------------------------------
# Video-Metadaten
# ----------------------------------------------------------------------------
def ffprobe_info(path: Path) -> dict:
    """Bildrate, Dauer, Drehung, Groesse aus der Datei -- nichts raten."""
    info = {"r_frame_rate": None, "avg_frame_rate": None, "fps": None, "duration": None,
            "width": None, "height": None, "rotation": 0, "nb_frames": None}
    if shutil.which("ffprobe") is None:
        return info
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
           "stream=r_frame_rate,avg_frame_rate,width,height,nb_frames,duration:stream_side_data=rotation:stream_tags=rotate",
           "-of", "json", str(path)]
    try:
        js = json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)
    except Exception:
        return info
    st = (js.get("streams") or [{}])[0]

    def frac(s):
        try:
            a, b = s.split("/")
            return float(a) / float(b) if float(b) else None
        except Exception:
            return None

    info["r_frame_rate"] = st.get("r_frame_rate")
    info["avg_frame_rate"] = st.get("avg_frame_rate")
    info["fps"] = frac(st.get("avg_frame_rate") or "") or frac(st.get("r_frame_rate") or "")
    info["width"], info["height"] = st.get("width"), st.get("height")
    try:
        info["duration"] = float(st.get("duration"))
    except Exception:
        pass
    try:
        info["nb_frames"] = int(st.get("nb_frames"))
    except Exception:
        pass
    rot = 0
    for sd in st.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(round(float(sd["rotation"])))
    if not rot and (st.get("tags") or {}).get("rotate"):
        rot = int(st["tags"]["rotate"])
    info["rotation"] = rot % 360
    return info


class FrameReader:
    """Liest Bilder mit OpenCV; dreht von Hand nach, falls OpenCV die Drehung ignoriert."""

    def __init__(self, path: Path):
        import cv2
        self.cv2 = cv2
        self.path = path
        self.meta = ffprobe_info(path)
        self.cap = cv2.VideoCapture(str(path))
        if not self.cap.isOpened():
            raise SystemExit(f"Video laesst sich nicht oeffnen: {path}")
        cv_fps = float(self.cap.get(cv2.CAP_PROP_FPS) or 0)
        self.fps = self.meta["fps"] or cv_fps
        if self.meta["fps"] and cv_fps and abs(cv_fps - self.meta["fps"]) / self.meta["fps"] > 0.02:
            print(f"  Hinweis: OpenCV meldet {cv_fps:.3f} fps, ffprobe {self.meta['fps']:.3f} fps -- ffprobe gewinnt.")
        self.n_est = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        ok, f0 = self.cap.read()
        if not ok:
            raise SystemExit("Kein einziges Bild lesbar.")
        self.manual_rot = None
        rot = self.meta["rotation"]
        if rot in (90, 270) and self.meta["width"] and f0.shape[1] == self.meta["width"]:
            # OpenCV hat NICHT gedreht -> selbst drehen
            self.manual_rot = cv2.ROTATE_90_CLOCKWISE if rot == 90 else cv2.ROTATE_90_COUNTERCLOCKWISE
            f0 = cv2.rotate(f0, self.manual_rot)
        elif rot == 180 and self.meta["width"] and f0.shape[1] == self.meta["width"]:
            self.manual_rot = cv2.ROTATE_180
            f0 = cv2.rotate(f0, self.manual_rot)
        self.h, self.w = f0.shape[:2]
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    def frames(self):
        self.cap.set(self.cv2.CAP_PROP_POS_FRAMES, 0)
        while True:
            ok, f = self.cap.read()
            if not ok:
                break
            if self.manual_rot is not None:
                f = self.cv2.rotate(f, self.manual_rot)
            yield f

    def frame_at(self, idx: int):
        self.cap.set(self.cv2.CAP_PROP_POS_FRAMES, idx)
        ok, f = self.cap.read()
        if not ok:
            return None
        if self.manual_rot is not None:
            f = self.cv2.rotate(f, self.manual_rot)
        return f


# ----------------------------------------------------------------------------
# Posenmodell
# ----------------------------------------------------------------------------
def pick_device(want: str | None) -> str:
    import torch
    if want and want != "auto":
        return want
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(weights: str):
    from ultralytics import YOLO
    return YOLO(weights)


def best_person(result):
    """Person mit der hoechsten mittleren Zuversicht der 17 Punkte.
    Liefert (xy Pixel (17,2), conf (17,), box xyxy (4,)) oder None."""
    kps = result.keypoints
    if kps is None or kps.conf is None or kps.xy.shape[0] == 0:
        return None
    conf = kps.conf.cpu().numpy()          # (N,17)
    xy = kps.xy.cpu().numpy()              # (N,17,2)  PIXEL, nicht xyn!
    i = int(np.argmax(conf.mean(axis=1)))
    box = result.boxes.xyxy.cpu().numpy()[i] if result.boxes is not None and len(result.boxes) > i else np.full(4, np.nan)
    return xy[i], conf[i], box


def run_pose(model, frame_bgr, device: str, imgsz: int):
    res = model.predict(frame_bgr, device=device, imgsz=imgsz, verbose=False, conf=0.25)
    return best_person(res[0])


def extract_keypoints(reader: FrameReader, model, device: str, imgsz: int, cache: Path) -> dict:
    n_est = reader.n_est or reader.meta.get("nb_frames") or 0
    xy_all, conf_all, box_all = [], [], []
    t0 = time.time()
    for i, frame in enumerate(reader.frames()):
        r = run_pose(model, frame, device, imgsz)
        if r is None:
            xy_all.append(np.full((17, 2), np.nan)); conf_all.append(np.zeros(17)); box_all.append(np.full(4, np.nan))
        else:
            xy_all.append(r[0]); conf_all.append(r[1]); box_all.append(r[2])
        if (i + 1) % 50 == 0 or i == 0:
            el = time.time() - t0
            rate = (i + 1) / el
            rest = (n_est - i - 1) / rate if n_est else float("nan")
            print(f"  Bild {i + 1}/{n_est or '?'}  {rate:.2f} Bilder/s  Rest ~{rest / 60:.1f} min", flush=True)
    data = {"xy": np.array(xy_all), "conf": np.array(conf_all), "box": np.array(box_all),
            "fps": reader.fps, "w": reader.w, "h": reader.h}
    np.savez_compressed(cache, **data)
    print(f"  {len(xy_all)} Bilder in {(time.time() - t0) / 60:.1f} min, Punkte gespeichert: {cache}")
    return data


# ----------------------------------------------------------------------------
# Schritt 2: Aufnahme pruefen
# ----------------------------------------------------------------------------
def cmd_check(args):
    path = Path(args.video)
    reader = FrameReader(path)
    n_est = reader.n_est or reader.meta.get("nb_frames") or 0
    dur = reader.meta["duration"] or (n_est / reader.fps if reader.fps else 0)
    print(f"Datei: {path.name}")
    print(f"  {reader.w} x {reader.h} Pixel, {reader.fps:.3f} fps (ffprobe: {reader.meta['avg_frame_rate']}), "
          f"{dur:.1f} s, ~{n_est} Bilder, Drehung {reader.meta['rotation']} Grad"
          + (" (von Hand nachgedreht)" if reader.manual_rot is not None else ""))
    device = pick_device(args.device)
    model = load_model(args.model)
    k = max(8, min(args.samples, n_est))
    idxs = np.linspace(0, max(0, n_est - 1), k).astype(int) if n_est else np.arange(k)
    xy, conf = [], []
    for i in idxs:
        f = reader.frame_at(int(i))
        if f is None:
            continue
        r = run_pose(model, f, device, args.imgsz)
        if r is None:
            xy.append(np.full((17, 2), np.nan)); conf.append(np.zeros(17))
        else:
            xy.append(r[0]); conf.append(r[1])
    xy, conf = np.array(xy), np.array(conf)
    found = (conf.mean(axis=1) > 0).sum()
    cam = fc.camera_check(xy, conf)
    side = fc.choose_side(xy, conf)
    li = [fc.KP[f"{side}_{j}"] for j in ("hip", "knee", "ankle")]
    leg = conf[:, li].mean(axis=1)
    leg_ok = float((leg >= 0.5).mean()) if len(leg) else 0.0

    problems = []
    if dur < 10:
        problems.append(f"Clip nur {dur:.1f} s lang -- unter zehn Sekunden reicht es nicht fuer mehrere Umdrehungen")
    if found < 0.8 * len(idxs):
        problems.append(f"Person nur in {found} von {len(idxs)} Stichproben gefunden")
    if leg_ok < 0.7:
        problems.append(f"Huefte/Knie/Knoechel nur in {leg_ok * 100:.0f} % der Stichproben sicher (>=0.5) -- zu dunkel oder etwas steht im Weg")
    if cam["shoulder_ratio"] is None:
        problems.append(cam["msg"])
    elif not cam["ok"]:
        problems.append(f"Schulterabstand/Rumpflaenge = {cam['shoulder_ratio']:.2f} (> 0.25): {cam['msg']}")

    print(f"  Stichproben: {len(idxs)} Bilder, Person gefunden in {found}")
    print(f"  Seitenansicht: Schulterabstand/Rumpf = "
          f"{cam['shoulder_ratio'] if cam['shoulder_ratio'] is None else round(cam['shoulder_ratio'], 2)}, "
          f"Hueftabstand/Rumpf = {cam['hip_ratio'] if cam['hip_ratio'] is None else round(cam['hip_ratio'], 2)} "
          f"(Grenze 0.25) -- {cam['msg']}")
    print(f"  Kameranahe Seite: {'links' if side == 'l' else 'rechts'}; "
          f"Huefte/Knie/Knoechel sicher in {leg_ok * 100:.0f} % der Stichproben (Median-Zuversicht {np.median(leg):.2f})")
    print()
    if problems:
        print("ERGEBNIS: " + "; ".join(problems) + ".")
    else:
        print(f"ERGEBNIS: Aufnahme brauchbar -- Seitenansicht ({cam['shoulder_ratio']:.2f}), "
              f"{dur:.0f} s, Beinpunkte in {leg_ok * 100:.0f} % der Stichproben sicher.")
    json.dump({"file": str(path), "w": reader.w, "h": reader.h, "fps": reader.fps, "duration": dur,
               "rotation": reader.meta["rotation"], "camera": cam, "side": side, "leg_conf_ok": leg_ok,
               "problems": problems}, open(OUT / "check.json", "w"), indent=2)
    return 0 if not problems else 2


# ----------------------------------------------------------------------------
# Schriften und Zeichenhelfer (Pillow)
# ----------------------------------------------------------------------------
FONT_SANS = [
    "/System/Library/Fonts/SFCompact.ttf", "/System/Library/Fonts/SFCompactDisplay.ttf",
    "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/HelveticaNeue.ttc",
    "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf",
]
FONT_BOLD = [
    "/System/Library/Fonts/SFCompact.ttf", "/System/Library/Fonts/SFCompactDisplay.ttf",
    "/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]
FONT_MONO = [
    "/System/Library/Fonts/SFMono.ttf", "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf",
    "C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
]


class Fonts:
    def __init__(self):
        self.sans = next((p for p in FONT_SANS if os.path.exists(p)), None)
        self.bold = next((p for p in FONT_BOLD if os.path.exists(p)), None) or self.sans
        self.mono = next((p for p in FONT_MONO if os.path.exists(p)), None)
        self._cache = {}

    def get(self, kind: str, size: float):
        from PIL import ImageFont
        size = max(8, int(round(size)))
        key = (kind, size)
        if key not in self._cache:
            path = {"sans": self.sans, "bold": self.bold, "mono": self.mono}[kind]
            try:
                f = ImageFont.truetype(path, size) if path else ImageFont.load_default(size)
            except Exception:
                f = ImageFont.load_default(size)
            self._cache[key] = f
        return self._cache[key]

    def describe(self):
        return f"sans={self.sans or 'Pillow-Standard'}, bold={self.bold or 'Pillow-Standard'}, mono={self.mono or 'Pillow-Standard'}"


def rgba(c, a=255):
    return (int(c[0]), int(c[1]), int(c[2]), int(a))


def draw_line2(d, p, q, color, s, w_out=10, w_in=5):
    """Strich zweimal: erst dick schwarz, dann duenner in Farbe."""
    d.line([tuple(p), tuple(q)], fill=(0, 0, 0, 230), width=max(1, int(w_out * s)))
    d.line([tuple(p), tuple(q)], fill=rgba(color), width=max(1, int(w_in * s)))


def draw_joint(d, p, s, r=7):
    x, y = p
    rr = r * s
    d.ellipse([x - rr - 2 * s, y - rr - 2 * s, x + rr + 2 * s, y + rr + 2 * s], fill=(20, 20, 20, 230))
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, 255, 255, 255))


def draw_panel(d, box, alpha=170, radius=10, outline=None, ow=2):
    d.rounded_rectangle(box, radius=radius, fill=(12, 12, 14, alpha),
                        outline=rgba(outline) if outline else None, width=ow if outline else 0)


def fmt_deg(v):
    return "--" if v is None or not np.isfinite(v) else f"{v:.0f}°"


# ----------------------------------------------------------------------------
# Overlay
# ----------------------------------------------------------------------------
class Overlay:
    def __init__(self, W, H, fps, n, S: fc.Series, R: fc.BDCResult, advice: dict, model_name: str,
                 clip: dict):
        from PIL import Image, ImageDraw
        self.Image, self.ImageDraw = Image, ImageDraw
        self.W, self.H, self.fps, self.n = W, H, fps, n
        self.S, self.R, self.advice, self.model_name = S, R, advice, model_name
        self.clip = clip                  # Clip-Werte + Urteile je Winkel
        self.s = min(W, H) / 1080.0       # Massstab: Bildbreite/1080 im Hochformat
        self.fonts = Fonts()
        self.pad = 24 * self.s
        self.tile_w = 320 * self.s
        # Kacheln auf die Seite, auf der die Person nicht steht
        cx = np.nanmedian(S.pts[:, :, 0]) if np.isfinite(S.pts[:, :, 0]).any() else W / 2
        self.tiles_right = cx <= W / 2
        self.header_h = 118 * self.s
        self.bar_h = 60 * self.s
        self.plot_h = 210 * self.s
        # Verlaufskurve: geglaettete Beugung nur dort, wo getreten wird
        kf = fc.interp_nan(S.knee_flex)
        self.curve = np.where(R.pedaling, kf, np.nan)
        ped = self.curve[np.isfinite(self.curve)]
        if len(ped):
            self.ylo = math.floor(min(ped.min() - 5, 25) / 5) * 5
            self.yhi = math.ceil(max(ped.max() + 5, 45) / 5) * 5
        else:
            self.ylo, self.yhi = 20, 120
        self._static = None
        self.static_layer()

    # -- feste Teile einmal zeichnen (Kopfleiste, Kacheln, Diagrammhintergrund, Fussleiste)
    def static_layer(self):
        if self._static is not None:
            return self._static
        s, W, H = self.s, self.W, self.H
        layer = self.Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = self.ImageDraw.Draw(layer)
        F = self.fonts.get
        pad = self.pad
        # Kopfleiste
        d.rectangle([0, 0, W, self.header_h], fill=(10, 10, 12, 185))
        d.text((pad, 16 * s), "BIKEFIT", font=F("bold", 48 * s), fill=rgba(fc.WHITE))
        d.text((pad, 76 * s), f"Modell {self.model_name}  ·  ultralytics", font=F("sans", 18 * s), fill=rgba(fc.GREY))
        # Kacheln rechts
        x0 = (W - pad - self.tile_w) if self.tiles_right else pad
        y = self.header_h + 20 * s
        th, gap = 112 * s, 12 * s
        for key in ("knee", "torso", "elbow", "shoulder", "hip"):
            c = self.clip[key]
            v = c["verdict"]
            draw_panel(d, [x0, y, x0 + self.tile_w, y + th], alpha=175, radius=10 * s, outline=v["color"], ow=max(2, int(3 * s)))
            fw = F("bold", 15 * s)
            ww = d.textlength(v["word"], font=fw)
            d.text((x0 + self.tile_w - 14 * s, y + 12 * s), v["word"], font=fw, fill=rgba(v["color"]), anchor="ra")
            self._fit_text(d, c["label"], (x0 + 14 * s, y + 20 * s), self.tile_w - ww - 36 * s, 18 * s, kind="sans")
            d.text((x0 + 14 * s, y + 38 * s), fmt_deg(c["value"]), font=F("mono", 44 * s), fill=rgba(fc.WHITE))
            self._fit_text(d, c["band_text"], (x0 + 14 * s, y + 96 * s), self.tile_w - 28 * s, 14 * s, kind="sans", color=fc.GREY)
            y += th + gap
        # Diagrammhintergrund
        px0, px1 = pad, W - pad
        py1 = H - self.bar_h - 14 * s
        py0 = py1 - self.plot_h
        self.plot_box = (px0, py0, px1, py1)
        draw_panel(d, [px0, py0, px1, py1], alpha=175, radius=10 * s)
        ix0, iy0, ix1, iy1 = px0 + 62 * s, py0 + 30 * s, px1 - 16 * s, py1 - 28 * s
        self.plot_inner = (ix0, iy0, ix1, iy1)
        d.text((px0 + 14 * s, py0 + 8 * s), "Kniebeugung im Verlauf  [Grad]", font=F("sans", 15 * s), fill=rgba(fc.GREY))
        # Zielband
        lo, hi = fc.BANDS["knee"][0], fc.BANDS["knee"][1]
        d.rectangle([ix0, self.y2p(hi), ix1, self.y2p(lo)], fill=rgba(fc.GREEN, 55))
        rng_ = self.yhi - self.ylo
        ticks = {lo, hi, self.yhi}
        if lo - self.ylo >= 0.08 * rng_:
            ticks.add(self.ylo)
        for val in sorted(ticks):
            yy = self.y2p(val)
            d.line([ix0, yy, ix1, yy], fill=(255, 255, 255, 40), width=1)
            d.text((ix0 - 8 * s, yy), f"{val:.0f}", font=F("mono", 13 * s), fill=rgba(fc.GREY), anchor="rm")
        # Zeitachse
        total = self.n / self.fps
        step = 5 if total > 20 else 2
        for tsec in np.arange(0, total + 0.01, step):
            xx = self.t2p(tsec)
            d.line([xx, iy1, xx, iy1 + 4 * s], fill=(255, 255, 255, 90), width=1)
            d.text((xx, iy1 + 6 * s), f"{tsec:.0f}s", font=F("mono", 12 * s), fill=rgba(fc.GREY), anchor="ma")
        # Kurve (statisch) und Totpunkte
        pts = []
        segs = []
        for i in range(self.n):
            v = self.curve[i]
            if np.isfinite(v):
                pts.append((self.t2p(i / self.fps), self.y2p(v)))
            else:
                if len(pts) > 1:
                    segs.append(pts)
                pts = []
        if len(pts) > 1:
            segs.append(pts)
        for seg in segs:
            d.line(seg, fill=(255, 255, 255, 230), width=max(1, int(2 * s)))
        kc = self.clip["knee"]["verdict"]["color"]
        for c in self.R.cycles:
            xx, yy = self.t2p(c["vertex_t"] / self.fps), self.y2p(c["vertex_flex"])
            r = 5 * s
            d.ellipse([xx - r - 1.5 * s, yy - r - 1.5 * s, xx + r + 1.5 * s, yy + r + 1.5 * s], fill=(0, 0, 0, 220))
            d.ellipse([xx - r, yy - r, xx + r, yy + r], fill=rgba(kc))
        # Fussleiste mit dem Ergebnis
        d.rectangle([0, H - self.bar_h, W, H], fill=(10, 10, 12, 200))
        d.rectangle([0, H - self.bar_h, 10 * s, H], fill=rgba(self.advice["color"]))
        self._fit_text(d, self.advice["sentence"], (pad, H - self.bar_h / 2), W - 2 * pad, 22 * s)
        self._static = layer
        return layer

    def _fit_text(self, d, text, pos, max_w, size, kind="sans", color=fc.WHITE):
        f = self.fonts.get(kind, size)
        while size > 9 and d.textlength(text, font=f) > max_w:
            size -= 1
            f = self.fonts.get(kind, size)
        d.text(pos, text, font=f, fill=rgba(color), anchor="lm")

    def y2p(self, v):
        ix0, iy0, ix1, iy1 = self.plot_inner
        return iy1 - (v - self.ylo) / (self.yhi - self.ylo) * (iy1 - iy0)

    def t2p(self, t):
        ix0, iy0, ix1, iy1 = self.plot_inner
        total = max(1e-6, self.n / self.fps)
        return ix0 + t / total * (ix1 - ix0)

    # -- je Bild
    def render(self, frame_bgr, i: int, box):
        import cv2
        s, W, H = self.s, self.W, self.H
        F = self.fonts.get
        base = self.Image.fromarray(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)).convert("RGBA")
        layer = self.Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = self.ImageDraw.Draw(layer)
        S, R = self.S, self.R
        pts = S.pts[i]
        sh, el, wr, hp, kn, an = (pts[j] for j in range(6))
        colors = {k: self.clip[k]["verdict"]["color"] for k in ("knee", "torso", "elbow")}

        # Rahmen: nur die vier Ecken
        if box is not None and np.all(np.isfinite(box)):
            x1, y1, x2, y2 = box
            L = 34 * s
            wdt = max(2, int(3 * s))
            for (cx, cy, dx, dy) in ((x1, y1, 1, 1), (x2, y1, -1, 1), (x1, y2, 1, -1), (x2, y2, -1, -1)):
                d.line([cx, cy, cx + dx * L, cy], fill=(255, 255, 255, 220), width=wdt)
                d.line([cx, cy, cx, cy + dy * L], fill=(255, 255, 255, 220), width=wdt)
            n_seen = int((S.conf[i] >= fc.KP_CONF_MIN).sum())
            d.text((x1, y2 + 8 * s), f"{n_seen}/6 Punkte {'links' if S.side == 'l' else 'rechts'}",
                   font=F("mono", 14 * s), fill=rgba(fc.WHITE))

        # Skelett: fuenf Striche
        def ok(*ps):
            return all(np.all(np.isfinite(p)) for p in ps)

        for a, b, col in ((hp, kn, colors["knee"]), (kn, an, colors["knee"]), (sh, hp, colors["torso"]),
                          (sh, el, colors["elbow"]), (el, wr, colors["elbow"])):
            if ok(a, b):
                draw_line2(d, a, b, col, s)
        for p in (sh, el, wr, hp, kn, an):
            if ok(p):
                draw_joint(d, p, s)

        # Kniebogen + live-Wert
        if ok(hp, kn, an):
            a1 = math.degrees(math.atan2(hp[1] - kn[1], hp[0] - kn[0]))
            a2 = math.degrees(math.atan2(an[1] - kn[1], an[0] - kn[0]))
            dd = (a2 - a1) % 360
            start, end = (a1, a2) if dd <= 180 else (a2, a1)
            r = 58 * s
            d.arc([kn[0] - r, kn[1] - r, kn[0] + r, kn[1] + r], start, end, fill=(0, 0, 0, 220), width=max(2, int(7 * s)))
            d.arc([kn[0] - r, kn[1] - r, kn[0] + r, kn[1] + r], start, end, fill=rgba(colors["knee"]), width=max(1, int(4 * s)))
            mid = math.radians(start + ((end - start) % 360) / 2)
            tx, ty = kn[0] + math.cos(mid) * 92 * s, kn[1] + math.sin(mid) * 92 * s
            live = S.knee_flex[i]
            txt = fmt_deg(live)
            f_big = F("mono", 34 * s)
            tw = d.textlength(txt, font=f_big)
            bx0, by0 = tx - tw / 2 - 10 * s, ty - 26 * s
            draw_panel(d, [bx0, by0, bx0 + tw + 20 * s + 46 * s, by0 + 50 * s], alpha=190, radius=8 * s)
            d.text((bx0 + 10 * s, ty), txt, font=f_big, fill=rgba(fc.WHITE), anchor="lm")
            d.text((bx0 + tw + 16 * s, ty + 4 * s), "live", font=F("sans", 15 * s), fill=rgba(colors["knee"]), anchor="lm")

        # Kopfleiste rechts: Bildnummer, Sekunde, Bildrate
        pad = self.pad
        d.text((W - pad, 22 * s), f"Bild {i + 1:d}/{self.n:d}", font=F("mono", 22 * s), fill=rgba(fc.WHITE), anchor="ra")
        d.text((W - pad, 58 * s), f"{i / self.fps:6.2f} s   {self.fps:.2f} fps", font=F("mono", 18 * s), fill=rgba(fc.GREY), anchor="ra")

        # Erkennungsguete links
        q = float(S.leg_conf[i]) if np.isfinite(S.leg_conf[i]) else 0.0
        qx = pad if self.tiles_right else W - pad - 230 * s
        qy = self.header_h + 20 * s
        draw_panel(d, [qx, qy, qx + 230 * s, qy + 86 * s], alpha=175, radius=10 * s)
        d.text((qx + 14 * s, qy + 8 * s), "Erkennung Huefte/Knie/Knoechel", font=F("sans", 13 * s), fill=rgba(fc.GREY))
        d.text((qx + 14 * s, qy + 28 * s), f"{q * 100:3.0f} %", font=F("mono", 30 * s), fill=rgba(fc.WHITE))
        bx0, by0, bw = qx + 14 * s, qy + 68 * s, 202 * s
        d.rectangle([bx0, by0, bx0 + bw, by0 + 8 * s], fill=(60, 60, 60, 255))
        qc = fc.GREEN if q >= 0.7 else (fc.YELLOW if q >= 0.5 else fc.RED)
        d.rectangle([bx0, by0, bx0 + bw * q, by0 + 8 * s], fill=rgba(qc))
        if R.pedaling[i]:
            d.text((qx + 230 * s - 14 * s, qy + 40 * s), "tritt", font=F("sans", 14 * s), fill=rgba(fc.GREY), anchor="rm")

        # Zeitmarke im Diagramm
        ix0, iy0, ix1, iy1 = self.plot_inner
        xx = self.t2p(i / self.fps)
        d.line([xx, iy0, xx, iy1], fill=(255, 255, 255, 230), width=max(1, int(2 * s)))
        v = self.curve[i]
        if np.isfinite(v):
            yy = self.y2p(v)
            r = 4 * s
            d.ellipse([xx - r, yy - r, xx + r, yy + r], fill=(255, 255, 255, 255))

        out = self.Image.alpha_composite(base, self.static_layer())
        out = self.Image.alpha_composite(out, layer)
        return cv2.cvtColor(np.asarray(out.convert("RGB")), cv2.COLOR_RGB2BGR)


# ----------------------------------------------------------------------------
# Auswertung + Bericht
# ----------------------------------------------------------------------------
def clip_values(S: fc.Series, R: fc.BDCResult) -> dict:
    def band_text(key):
        lo, hi, _, basis = fc.BANDS[key]
        return f"{basis} {lo:.0f}-{hi:.0f}°"
    clip = {
        "knee": {"label": "Kniebeugung UT", "value": R.knee_bdc, "verdict": fc.verdict("knee", R.knee_bdc),
                 "band_text": band_text("knee") + "  (unterer Totpunkt)"},
        "torso": {"label": "Rumpfneigung", "value": R.torso, "verdict": fc.verdict("torso", R.torso),
                  "band_text": band_text("torso") + " zur Waagerechten"},
        "elbow": {"label": "Ellbogenbeugung", "value": R.elbow, "verdict": fc.verdict("elbow", R.elbow),
                  "band_text": band_text("elbow")},
        "shoulder": {"label": "Schulterwinkel", "value": R.shoulder, "verdict": fc.verdict("shoulder", R.shoulder),
                     "band_text": "Rumpf-Oberarm, keine belegte Norm"},
        "hip": {"label": "Hueftwinkel UT", "value": R.hip, "verdict": fc.verdict("hip", R.hip),
                "band_text": "Rumpf-Oberschenkel, keine belegte Norm"},
    }
    return clip




def cmd_run(args, render_only=False):
    OUT.mkdir(exist_ok=True)
    path = Path(args.video)
    stem = path.stem
    cache = OUT / f"{stem}_keypoints.npz"
    reader = FrameReader(path)
    print(f"Video: {path.name}  {reader.w}x{reader.h}  {reader.fps:.3f} fps  "
          f"(ffprobe {reader.meta['avg_frame_rate']}, Drehung {reader.meta['rotation']})")

    if render_only or (cache.exists() and not args.fresh):
        if not cache.exists():
            raise SystemExit("Kein Punkte-Cache vorhanden -- erst 'run' ausfuehren.")
        z = np.load(cache)
        data = {k: z[k] for k in z.files}
        print(f"Punkte aus Cache: {cache} ({data['xy'].shape[0]} Bilder)")
    else:
        device = pick_device(args.device)
        print(f"Rechne auf: {device}")
        model = load_model(args.model)
        data = extract_keypoints(reader, model, device, args.imgsz, cache)

    fps = float(data["fps"]) if "fps" in data else reader.fps
    xy, conf = data["xy"], data["conf"]
    box = data["box"] if "box" in data else np.full((xy.shape[0], 4), np.nan)
    n = xy.shape[0]

    cam = fc.camera_check(xy, conf)
    S = fc.build_series(xy, conf, fps)
    R = fc.analyse_series(S)
    femur, shank = args.femur, args.shank
    advice = fc.saddle_advice(R.knee_bdc, femur, shank)
    clip = clip_values(S, R)

    print()
    print(f"Kameranahe Seite: {'links' if S.side == 'l' else 'rechts'}")
    print(f"Seitenansicht: Schulterabstand/Rumpf {cam['shoulder_ratio'] if cam['shoulder_ratio'] is None else round(cam['shoulder_ratio'], 2)} -- {cam['msg']}")
    if R.period_frames:
        print(f"Trittdauer {R.period_frames:.1f} Bilder = {R.cadence_rpm:.0f} U/min, "
              f"{len(R.cycles)} Umdrehungen ausgewertet, {int(R.pedaling.sum())} von {n} Bildern als Treten erkannt")
    for note in R.notes:
        print("Hinweis:", note)
    if R.knee_bdc is not None:
        vals = [c["vertex_flex"] for c in R.cycles]
        print(f"Kniebeugung am unteren Totpunkt: {R.knee_bdc:.1f} Grad "
              f"(Median ueber {len(vals)} Umdrehungen, Streuung ±{R.knee_bdc_spread:.1f}, "
              f"Spanne {min(vals):.1f}..{max(vals):.1f})")
    print(f"Rumpfneigung {fmt_deg(R.torso)}, Ellbogen {fmt_deg(R.elbow)}, Schulter {fmt_deg(R.shoulder)}, Huefte am UT {fmt_deg(R.hip)}")
    if advice["mm_per_deg"]:
        print(f"Sattel: {advice['mm_per_deg']:.2f} mm je Grad (Oberschenkel {femur:.0f} mm, Unterschenkel {shank:.0f} mm)")
    print("ERGEBNIS:", advice["sentence"])

    # Bericht
    report = {
        "video": str(path), "width": int(reader.w), "height": int(reader.h), "fps": fps, "frames": int(n),
        "model": Path(args.model).name, "device": None if render_only else pick_device(args.device),
        "side": S.side, "camera_check": cam,
        "period_frames": R.period_frames, "cadence_rpm": R.cadence_rpm,
        "cycles": [{"frame": c["rough"], "vertex_frame": c["vertex_t"], "flex": c["vertex_flex"]} for c in R.cycles],
        "knee_flex_bdc": R.knee_bdc, "knee_flex_bdc_spread": R.knee_bdc_spread, "bdc_frame": R.bdc_frame,
        "torso_deg": R.torso, "elbow_flex_deg": R.elbow, "shoulder_deg": R.shoulder, "hip_deg_bdc": R.hip,
        "verdicts": {k: {"level": v["verdict"]["level"], "word": v["verdict"]["word"], "value": v["value"]} for k, v in clip.items()},
        "femur_mm": femur, "shank_mm": shank, "leg_lengths_are_defaults": bool(args.leg_defaults),
        "mm_per_deg": advice["mm_per_deg"], "saddle_mm": advice["mm"], "sentence": advice["sentence"],
        "notes": R.notes, "thresholds": {"bands": fc.BANDS, "tolerance_deg": fc.TOL},
    }
    json.dump(report, open(OUT / f"{stem}_bericht.json", "w"), indent=2, default=float)
    write_report_md(OUT / f"{stem}_bericht.md", report, clip, advice)

    # Standbild vom unteren Totpunkt + Video
    ov = Overlay(reader.w, reader.h, fps, n, S, R, advice, Path(args.model).stem, clip)
    print(f"Schriften: {ov.fonts.describe()}")
    if R.bdc_frame is not None:
        import cv2
        f = reader.frame_at(R.bdc_frame)
        if f is not None:
            img = ov.render(f, R.bdc_frame, box[R.bdc_frame])
            cv2.imwrite(str(OUT / f"{stem}_totpunkt.png"), img)
            print(f"Standbild unterer Totpunkt (Bild {R.bdc_frame}): {OUT / (stem + '_totpunkt.png')}")

    if args.no_video:
        return 0
    out_mp4 = OUT / f"{stem}_analyse.mp4"
    rate = reader.meta["avg_frame_rate"] or reader.meta["r_frame_rate"] or f"{fps:.6f}"
    if rate in (None, "0/0"):
        rate = f"{fps:.6f}"
    W2, H2 = reader.w - reader.w % 2, reader.h - reader.h % 2
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{reader.w}x{reader.h}", "-r", str(rate), "-i", "-", "-an",
           "-vf", f"crop={W2}:{H2}:0:0", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_mp4)]
    print(f"Schreibe Video mit {rate} fps nach H.264: {out_mp4}")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t0 = time.time()
    for i, frame in enumerate(reader.frames()):
        if i >= n:
            break
        img = ov.render(frame, i, box[i])
        proc.stdin.write(img.tobytes())
        if (i + 1) % 100 == 0:
            print(f"  Overlay Bild {i + 1}/{n}  ({(i + 1) / (time.time() - t0):.1f} Bilder/s)", flush=True)
    proc.stdin.close()
    rc = proc.wait()
    if rc != 0:
        raise SystemExit(f"ffmpeg ist mit Code {rc} abgebrochen.")
    print(f"Fertig: {out_mp4}  ({out_mp4.stat().st_size / 1e6:.1f} MB)")
    return 0


def write_report_md(path: Path, rep: dict, clip: dict, advice: dict):
    L = []
    L.append(f"# Bikefit-Bericht: {Path(rep['video']).name}")
    L.append("")
    L.append(f"- Video: {rep['width']}x{rep['height']}, {rep['fps']:.3f} fps, {rep['frames']} Bilder, Modell {rep['model']}")
    cam = rep["camera_check"]
    sr = cam["shoulder_ratio"]
    L.append(f"- Kameranahe Seite: {'links' if rep['side'] == 'l' else 'rechts'}; Seitenansicht: "
             f"{'%.2f' % sr if sr is not None else 'nicht pruefbar'} (Grenze 0.25) -- {cam['msg']}")
    if rep["cadence_rpm"]:
        L.append(f"- Trittfrequenz {rep['cadence_rpm']:.0f} U/min, {len(rep['cycles'])} Umdrehungen ausgewertet")
    for note in rep["notes"]:
        L.append(f"- Hinweis: {note}")
    L.append("")
    L.append("## Messwerte")
    L.append("")
    L.append("| Winkel | Wert | Band | Urteil |")
    L.append("|---|---|---|---|")
    for k in ("knee", "torso", "elbow", "shoulder", "hip"):
        c = clip[k]
        L.append(f"| {c['label']} | {fmt_deg(c['value'])} | {c['band_text']} | {c['verdict']['word']} |")
    if rep["knee_flex_bdc"] is not None:
        L.append("")
        L.append(f"Kniebeugung am unteren Totpunkt: **{rep['knee_flex_bdc']:.1f} Grad** "
                 f"(Median ueber {len(rep['cycles'])} Umdrehungen, Streuung ±{rep['knee_flex_bdc_spread']:.1f} Grad; "
                 f"ein Handyvideo loest etwa 2-3 Grad auf).")
    L.append("")
    L.append("## Sattel")
    L.append("")
    if rep["mm_per_deg"]:
        L.append(f"- Kosinussatz mit Oberschenkel {rep['femur_mm']:.0f} mm und Unterschenkel {rep['shank_mm']:.0f} mm"
                 f"{' (Standardwerte, nicht deine Masse!)' if rep['leg_lengths_are_defaults'] else ''}: "
                 f"**{rep['mm_per_deg']:.2f} mm je Grad** Kniewinkel.")
    L.append(f"- **{advice['sentence']}**")
    L.append("")
    L.append("Rumpf- und Ellbogenband sind Erfahrungswerte aus der Praxis, keine belegte Norm. "
             "Schulter- und Hueftwinkel werden gemessen, aber nicht bewertet, weil die zitierte Studie den Gelenkpunkt anders "
             "definiert als das Posenmodell ihn setzt.")
    L.append("")
    L.append("## Grenzen dieser Messung")
    L.append("")
    L.append("Ein Seitenvideo kann Sattelhoehe und Oberkoerperhaltung einordnen. Es sieht nicht, ob die Knie nach innen oder "
             "aussen wandern, und es sagt nichts ueber die Schuhplatten -- dafuer braeuchte es eine Aufnahme von vorn. "
             "Bei Schmerzen ersetzt das keinen Menschen, der dich anschaut. Immer nur eine Sache aendern und danach neu filmen.")
    path.write_text("\n".join(L), encoding="utf-8")


# ----------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["check", "run", "render"])
    ap.add_argument("video")
    ap.add_argument("--model", default=str(HERE / "yolo11x-pose.pt"))
    ap.add_argument("--device", default="auto", help="auto | cpu | cuda | mps")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--samples", type=int, default=40, help="Stichproben fuer 'check'")
    ap.add_argument("--femur", type=float, default=None, help="Oberschenkel Huefte-Knie in mm")
    ap.add_argument("--shank", type=float, default=None, help="Unterschenkel Knie-Knoechel in mm")
    ap.add_argument("--fresh", action="store_true", help="Punkte neu berechnen statt Cache")
    ap.add_argument("--no-video", action="store_true")
    args = ap.parse_args(argv)
    args.leg_defaults = args.femur is None or args.shank is None
    if args.femur is None:
        args.femur = 430.0
    if args.shank is None:
        args.shank = 440.0
    OUT.mkdir(exist_ok=True)
    if args.cmd == "check":
        return cmd_check(args)
    if args.cmd == "run":
        return cmd_run(args)
    return cmd_run(args, render_only=True)


if __name__ == "__main__":
    sys.exit(main())
