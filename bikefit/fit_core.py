"""
fit_core.py -- reine Geometrie und Signalverarbeitung fuer die Sitzpositionsanalyse.

Hier steckt alles, was aus 17 Koerperpunkten je Bild einen Kniewinkel am unteren
Totpunkt macht. Kein Modell, keine Videos, nur numpy. Dadurch laesst sich die Kette
mit einem kuenstlichen Tretzyklus pruefen (selftest.py), bevor sie ein echtes Video
anfasst.

Alle Koordinaten sind PIXEL (x nach rechts, y nach unten). Nie die auf 0..1
normierten Werte hier hineingeben -- die sind je Achse normiert und stauchen jeden
Winkel in einem Hochformatvideo.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# COCO-17 Reihenfolge, wie sie das Ultralytics-Posenmodell liefert
KP = {
    "nose": 0,
    "l_eye": 1, "r_eye": 2, "l_ear": 3, "r_ear": 4,
    "l_shoulder": 5, "r_shoulder": 6,
    "l_elbow": 7, "r_elbow": 8,
    "l_wrist": 9, "r_wrist": 10,
    "l_hip": 11, "r_hip": 12,
    "l_knee": 13, "r_knee": 14,
    "l_ankle": 15, "r_ankle": 16,
}
SIDE_JOINTS = ["shoulder", "elbow", "wrist", "hip", "knee", "ankle"]

# Mindestzuversicht, ab der ein Punkt als "gesehen" gilt
KP_CONF_MIN = 0.5

# ----------------------------------------------------------------------------
# Bewertungsschwellen -- EINE Quelle fuer Farbe UND Text (WICHTIG 4)
# ----------------------------------------------------------------------------
TOL = 2.5  # Grad Toleranz an den Bandraendern (Handyvideo loest ~2-3 Grad auf)

BANDS = {
    # name: (unten, oben, Bezeichnung, Basis)
    "knee":  (30.0, 40.0, "Kniebeugung UT", "Sollband"),
    "torso": (40.0, 50.0, "Rumpfneigung", "Erfahrungswert"),
    "elbow": (15.0, 30.0, "Ellbogenbeugung", "Erfahrungswert"),
}
UNRATED = {
    "shoulder": "Schulterwinkel",
    "hip": "Hueftwinkel",
}

GREEN = (76, 201, 110)
YELLOW = (240, 196, 60)
RED = (230, 70, 70)
WHITE = (240, 240, 240)
GREY = (160, 160, 160)
LEVEL_COLOR = {"ok": GREEN, "edge": YELLOW, "low": RED, "high": RED, "none": GREY, "nodata": GREY}


def verdict(name: str, value: float | None) -> dict:
    """Einheitliches Urteil fuer einen Winkel.

    Liefert level in {"ok","edge","low","high","none","nodata"}, die Farbe dazu und
    ein kurzes Wort fuer die Kachel. "low"/"high" beziehen sich auf den WERT
    (Wert unter dem Band / ueber dem Band), die Bedeutung fuer den Sattel macht
    saddle_sentence() daraus.
    """
    if name in UNRATED:
        return {"level": "none", "color": GREY, "word": "ohne Bewertung", "band": None}
    lo, hi, _, _ = BANDS[name]
    if value is None or not np.isfinite(value):
        return {"level": "nodata", "color": GREY, "word": "nicht messbar", "band": (lo, hi)}
    if lo <= value <= hi:
        level, word = "ok", "passt"
    elif lo - TOL < value < lo:
        level, word = "edge", "Grenzbereich"
    elif hi < value < hi + TOL:
        level, word = "edge", "Grenzbereich"
    elif value <= lo - TOL:
        level, word = "low", "zu wenig"
    else:
        level, word = "high", "zu viel"
    return {"level": level, "color": LEVEL_COLOR[level], "word": word, "band": (lo, hi)}


# ----------------------------------------------------------------------------
# Elementare Geometrie
# ----------------------------------------------------------------------------
def angle_at(a, b, c) -> float:
    """Innenwinkel (Grad) am Punkt b zwischen den Strecken b->a und b->c."""
    a, b, c = np.asarray(a, float), np.asarray(b, float), np.asarray(c, float)
    if not (np.all(np.isfinite(a)) and np.all(np.isfinite(b)) and np.all(np.isfinite(c))):
        return float("nan")
    v1, v2 = a - b, c - b
    n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
    if n1 < 1e-9 or n2 < 1e-9:
        return float("nan")
    cosang = float(np.dot(v1, v2) / (n1 * n2))
    return math.degrees(math.acos(max(-1.0, min(1.0, cosang))))


def knee_flexion(hip, knee, ankle) -> float:
    """Kniebeugung = 180 - Innenwinkel Huefte-Knie-Knoechel."""
    return 180.0 - angle_at(hip, knee, ankle)


def elbow_flexion(shoulder, elbow, wrist) -> float:
    return 180.0 - angle_at(shoulder, elbow, wrist)


def torso_angle(shoulder, hip) -> float:
    """Neigung der Linie Huefte->Schulter gegen die Waagerechte, in Bildkoordinaten
    (y nach unten). 0 = waagerecht, 90 = aufrecht. Vorzeichenfrei."""
    shoulder, hip = np.asarray(shoulder, float), np.asarray(hip, float)
    if not (np.all(np.isfinite(shoulder)) and np.all(np.isfinite(hip))):
        return float("nan")
    dx = abs(shoulder[0] - hip[0])
    dy = hip[1] - shoulder[1]  # Schulter liegt ueber der Huefte -> positiv
    if dx < 1e-9 and abs(dy) < 1e-9:
        return float("nan")
    return math.degrees(math.atan2(dy, dx))


def shoulder_angle(hip, shoulder, elbow) -> float:
    """Winkel Rumpf-Oberarm, gemessen an der Schulter (Huefte-Schulter-Ellbogen)."""
    return angle_at(hip, shoulder, elbow)


def hip_angle(shoulder, hip, knee) -> float:
    """Winkel Rumpf-Oberschenkel, gemessen an der Huefte (Schulter-Huefte-Knie)."""
    return angle_at(shoulder, hip, knee)


# ----------------------------------------------------------------------------
# Punkte je Bild -> Zeitreihen
# ----------------------------------------------------------------------------
@dataclass
class Series:
    fps: float
    n: int
    side: str                      # "l" oder "r": die kameranahe Seite
    pts: np.ndarray                # (n, 6, 2) Pixel der Seitenpunkte, NaN wenn fehlt
    conf: np.ndarray               # (n, 6) Zuversicht der Seitenpunkte
    knee_flex: np.ndarray = field(default=None)
    elbow_flex: np.ndarray = field(default=None)
    torso: np.ndarray = field(default=None)
    shoulder: np.ndarray = field(default=None)
    hipang: np.ndarray = field(default=None)
    ankle_y: np.ndarray = field(default=None)
    leg_conf: np.ndarray = field(default=None)   # Mittel Huefte/Knie/Knoechel je Bild


def choose_side(kp_xy: np.ndarray, kp_conf: np.ndarray) -> str:
    """Einmal fuer den ganzen Clip: welche Seite ist naeher an der Kamera?
    Entscheidung ueber die mittlere Zuversicht der sechs Seitenpunkte."""
    def mean_side(prefix):
        idx = [KP[f"{prefix}_{j}"] for j in SIDE_JOINTS]
        return float(np.nanmean(kp_conf[:, idx]))
    return "l" if mean_side("l") >= mean_side("r") else "r"


def build_series(kp_xy: np.ndarray, kp_conf: np.ndarray, fps: float,
                 side: str | None = None, conf_min: float = KP_CONF_MIN) -> Series:
    """kp_xy: (n,17,2) Pixel, kp_conf: (n,17). Bilder ohne Person: alles NaN/0."""
    n = kp_xy.shape[0]
    if side is None:
        side = choose_side(kp_xy, kp_conf)
    idx = [KP[f"{side}_{j}"] for j in SIDE_JOINTS]
    pts = kp_xy[:, idx, :].astype(float).copy()
    conf = kp_conf[:, idx].astype(float).copy()
    pts[conf < conf_min] = np.nan

    S = Series(fps=fps, n=n, side=side, pts=pts, conf=conf)
    sh, el, wr, hp, kn, an = (pts[:, i, :] for i in range(6))
    S.knee_flex = np.array([knee_flexion(hp[i], kn[i], an[i]) for i in range(n)])
    S.elbow_flex = np.array([elbow_flexion(sh[i], el[i], wr[i]) for i in range(n)])
    S.torso = np.array([torso_angle(sh[i], hp[i]) for i in range(n)])
    S.shoulder = np.array([shoulder_angle(hp[i], sh[i], el[i]) for i in range(n)])
    S.hipang = np.array([hip_angle(sh[i], hp[i], kn[i]) for i in range(n)])
    S.ankle_y = an[:, 1].copy()
    S.leg_conf = conf[:, 3:6].mean(axis=1)
    return S


# ----------------------------------------------------------------------------
# Signalhelfer (ohne scipy)
# ----------------------------------------------------------------------------
def interp_nan(y: np.ndarray) -> np.ndarray:
    """Lineare Interpolation ueber NaN-Luecken, Raender werden fortgeschrieben."""
    y = np.asarray(y, float).copy()
    ok = np.isfinite(y)
    if ok.sum() == 0:
        return y
    if ok.sum() < len(y):
        y[~ok] = np.interp(np.flatnonzero(~ok), np.flatnonzero(ok), y[ok])
    return y


def moving_average(y: np.ndarray, win: int) -> np.ndarray:
    win = max(1, int(win))
    if win % 2 == 0:
        win += 1
    if win == 1:
        return np.asarray(y, float).copy()
    pad = win // 2
    yp = np.pad(np.asarray(y, float), pad, mode="edge")
    return np.convolve(yp, np.ones(win) / win, mode="valid")


def local_maxima(y: np.ndarray, min_dist: int) -> np.ndarray:
    """Indizes lokaler Maxima mit Mindestabstand, absteigend nach Hoehe ausgewaehlt."""
    n = len(y)
    cand = [i for i in range(1, n - 1) if y[i] >= y[i - 1] and y[i] > y[i + 1]]
    cand.sort(key=lambda i: -y[i])
    taken = []
    for i in cand:
        if all(abs(i - j) >= min_dist for j in taken):
            taken.append(i)
    return np.array(sorted(taken), dtype=int)


def estimate_period(sig: np.ndarray, fps: float,
                    min_period_s: float = 0.35, max_period_s: float = 2.5) -> float | None:
    """Trittdauer in BILDERN aus der Autokorrelation eines Signals (Knoechelhoehe).
    Erster deutlicher Autokorrelationsgipfel im Bereich 24..170 U/min, parabolisch
    verfeinert. None, wenn keine Periodik gefunden wird."""
    x = interp_nan(sig)
    if np.isfinite(x).sum() < int(3 * min_period_s * fps):
        return None
    x = x - moving_average(x, int(2.0 * fps))          # Trend raus
    x = x - x.mean()
    n = len(x)
    if np.allclose(x, 0):
        return None
    ac = np.correlate(x, x, mode="full")[n - 1:]
    ac = ac / (ac[0] + 1e-12)
    lo = max(2, int(min_period_s * fps))
    hi = min(int(max_period_s * fps), n // 2 - 1)
    if hi <= lo + 2:
        return None
    seg = ac[lo:hi + 1]
    peaks = [k + lo for k in range(1, len(seg) - 1) if seg[k] >= seg[k - 1] and seg[k] > seg[k + 1]]
    if not peaks:
        return None
    best = max(ac[k] for k in peaks)
    if best < 0.2:
        return None
    k = next(p for p in peaks if ac[p] >= 0.5 * best)   # erster kraeftiger Gipfel
    # parabolische Verfeinerung des Gipfels
    y0, y1, y2 = ac[k - 1], ac[k], ac[k + 1]
    denom = (y0 - 2 * y1 + y2)
    off = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-12 else 0.0
    return float(k + max(-1.0, min(1.0, off)))


def parabola_vertex(t: np.ndarray, y: np.ndarray):
    """Ausgleichsparabel durch (t,y); liefert (t_scheitel, y_scheitel).
    Fuer ein Minimum muss a>0 sein; sonst wird das kleinste Stuetzelement genommen.
    Liegt der Scheitel ausserhalb des Fensters, wird er auf den Rand begrenzt."""
    t = np.asarray(t, float); y = np.asarray(y, float)
    ok = np.isfinite(y)
    if ok.sum() < 3:
        return None, None
    t, y = t[ok], y[ok]
    tc = t - t.mean()
    a, b, c = np.polyfit(tc, y, 2)
    if a <= 1e-12:
        i = int(np.argmin(y))
        return float(t[i]), float(y[i])
    tv = -b / (2 * a)
    tv = max(tc.min(), min(tc.max(), tv))
    yv = a * tv * tv + b * tv + c
    return float(tv + t.mean()), float(yv)


# ----------------------------------------------------------------------------
# Treten erkennen und den unteren Totpunkt je Umdrehung auslesen
# ----------------------------------------------------------------------------
@dataclass
class BDCResult:
    period_frames: float | None
    cadence_rpm: float | None
    pedaling: np.ndarray            # (n,) bool: Bild zaehlt als "tritt"
    cycles: list                    # je Umdrehung: dict(rough, vertex_t, vertex_flex, win)
    knee_bdc: float | None          # Median der Scheitel ueber alle Umdrehungen
    knee_bdc_spread: float | None   # halbe Interquartilsbreite der Scheitel
    bdc_frame: int | None           # das Bild, das dem Median-Scheitel am naechsten ist
    torso: float | None
    elbow: float | None
    shoulder: float | None
    hip: float | None
    notes: list


def analyse_series(S: Series, min_cycles: int = 3) -> BDCResult:
    fps, n = S.fps, S.n
    notes = []
    empty = BDCResult(None, None, np.zeros(n, bool), [], None, None, None,
                      None, None, None, None, notes)

    # 1) Trittdauer aus der Knoechelhoehe
    T = estimate_period(S.ankle_y, fps)
    if T is None:
        notes.append("Keine regelmaessige Schwingung der Knoechelhoehe gefunden -- tritt die Person?")
        return empty
    cadence = 60.0 * fps / T

    # 2) Knoechel-Tiefpunkte (in Bildkoordinaten: Maxima von y) als Umdrehungszaehler
    ay = interp_nan(S.ankle_y)
    ay_s = moving_average(ay, max(3, int(round(T / 10))))
    peaks = local_maxima(ay_s, min_dist=int(0.6 * T))
    half = int(round(T / 2))
    amps = []
    for p in peaks:
        lo, hi = max(0, p - half), min(n, p + half + 1)
        # Schwingung muss auf BEIDEN Seiten des Tiefpunkts da sein -- sonst ist es die
        # Kante zum Danebenstehen (Fuss am Boden), nicht ein Tritt
        left = ay_s[p] - ay_s[lo:p + 1].min()
        right = ay_s[p] - ay_s[p:hi].min()
        amps.append(min(left, right))
    amps = np.array(amps)
    if len(peaks) == 0:
        notes.append("Keine Knoechel-Tiefpunkte gefunden.")
        return empty
    amp_ref = float(np.median(amps))

    # Ein Tiefpunkt gilt als echter Tritt, wenn er kraeftig genug ist, ein Nachbar im
    # Abstand 0.7..1.3 T liegt und er nicht in der ersten oder letzten Sekunde liegt.
    valid = np.zeros(len(peaks), bool)
    for i, p in enumerate(peaks):
        if p < fps or p > n - 1 - fps:
            continue
        if amps[i] < 0.4 * amp_ref:
            continue
        neigh = []
        if i > 0:
            neigh.append(p - peaks[i - 1])
        if i < len(peaks) - 1:
            neigh.append(peaks[i + 1] - p)
        if any(0.7 * T <= d <= 1.3 * T for d in neigh):
            valid[i] = True
    good = peaks[valid]
    pedaling = np.zeros(n, bool)
    if len(good) >= 2:
        # Bilder zwischen benachbarten gueltigen Tiefpunkten gelten als Treten
        for a, b in zip(good[:-1], good[1:]):
            if 0.7 * T <= b - a <= 1.3 * T:
                pedaling[a:b + 1] = True
        pedaling[: int(fps)] = False
        pedaling[n - int(fps):] = False

    if len(good) < min_cycles:
        notes.append(f"Nur {len(good)} brauchbare Umdrehungen gefunden (mindestens {min_cycles} noetig).")
        return BDCResult(T, cadence, pedaling, [], None, None, None,
                         None, None, None, None, notes)

    # 3) Je Umdrehung: grober Ort = Minimum der GEGLAETTETEN Beugung nahe dem
    #    Knoechel-Tiefpunkt; Scheitel = Ausgleichsparabel auf der UNGEGLAETTETEN
    #    Beugung in einem Fenster von T/4 Breite um den groben Ort.
    kf_raw = S.knee_flex.copy()
    kf_i = interp_nan(kf_raw)
    kf_s = moving_average(kf_i, max(3, int(round(T / 10))))
    hw = max(2, int(round(T / 8)))          # halbe Fensterbreite -> Breite ~ T/4
    search = int(round(0.3 * T))
    cycles = []
    for p in good:
        lo, hi = max(0, p - search), min(n, p + search + 1)
        if hi - lo < 3:
            continue
        seg = np.where(pedaling[lo:hi], kf_s[lo:hi], np.inf)   # nur Bilder, in denen getreten wird
        if not np.isfinite(seg).any():
            continue
        rough = lo + int(np.argmin(seg))
        wlo, whi = max(0, rough - hw), min(n, rough + hw + 1)
        t = np.arange(wlo, whi)
        y = np.where(pedaling[wlo:whi], kf_raw[wlo:whi], np.nan)   # ungeglaettet!
        if np.isfinite(y).sum() < max(3, (whi - wlo) // 2):
            continue
        tv, yv = parabola_vertex(t, y)
        if tv is None:
            continue
        cycles.append({"rough": int(rough), "vertex_t": tv, "vertex_flex": yv,
                       "win": (int(wlo), int(whi - 1)), "ankle_peak": int(p)})

    if len(cycles) < min_cycles:
        notes.append(f"Nur {len(cycles)} Umdrehungen mit auswertbarem Kniewinkel.")
        return BDCResult(T, cadence, pedaling, cycles, None, None, None,
                         None, None, None, None, notes)

    vals = np.array([c["vertex_flex"] for c in cycles])
    knee_bdc = float(np.median(vals))
    q1, q3 = np.percentile(vals, [25, 75])
    spread = float((q3 - q1) / 2)
    # Bild fuer das Standbild: die Umdrehung, deren Scheitel dem Median am naechsten liegt
    j = int(np.argmin(np.abs(vals - knee_bdc)))
    bdc_frame = int(round(cycles[j]["vertex_t"]))

    ped = pedaling & np.isfinite(S.torso)
    torso = float(np.median(S.torso[ped])) if ped.any() else None
    ped = pedaling & np.isfinite(S.elbow_flex)
    elbow = float(np.median(S.elbow_flex[ped])) if ped.any() else None
    ped = pedaling & np.isfinite(S.shoulder)
    shoulder = float(np.median(S.shoulder[ped])) if ped.any() else None
    # Hueftwinkel am Totpunkt (offenster Zustand), Median ueber die groben Orte
    hv = [S.hipang[c["rough"]] for c in cycles if np.isfinite(S.hipang[c["rough"]])]
    hip = float(np.median(hv)) if hv else None

    return BDCResult(T, cadence, pedaling, cycles, knee_bdc, spread, bdc_frame,
                     torso, elbow, shoulder, hip, notes)


# ----------------------------------------------------------------------------
# Sattelverstellung aus dem Kosinussatz
# ----------------------------------------------------------------------------
def mm_per_degree(femur_mm: float, shank_mm: float, knee_angle_deg: float) -> float:
    """Abstand Huefte-Pedal D(theta) = sqrt(F^2 + S^2 - 2 F S cos theta).
    dD/dtheta = F S sin(theta) / D  [mm je rad]  ->  * pi/180 fuer mm je Grad."""
    th = math.radians(knee_angle_deg)
    D = math.sqrt(femur_mm ** 2 + shank_mm ** 2 - 2 * femur_mm * shank_mm * math.cos(th))
    return femur_mm * shank_mm * math.sin(th) / D * math.pi / 180.0


def saddle_advice(knee_flex_bdc: float | None, femur_mm: float, shank_mm: float) -> dict:
    """Urteil + Millimeter. Benutzt dieselbe verdict()-Schwelle wie die Farbe."""
    v = verdict("knee", knee_flex_bdc)
    out = {"level": v["level"], "color": v["color"], "mm": 0.0, "mm_per_deg": None,
           "target": 35.0, "sentence": ""}
    if v["level"] == "nodata":
        out["sentence"] = "Kniewinkel am unteren Totpunkt war nicht sauber messbar -- keine Empfehlung."
        return out
    lo, hi = v["band"]
    target = 0.5 * (lo + hi)
    mpd = mm_per_degree(femur_mm, shank_mm, 180.0 - knee_flex_bdc)
    out["mm_per_deg"] = mpd
    # Mehr Beugung -> Sattel hoeher (Abstand Huefte-Pedal wird groesser, Beugung kleiner)
    delta_deg = knee_flex_bdc - target
    mm = delta_deg * mpd
    out["mm"] = mm
    if v["level"] == "ok":
        out["sentence"] = (f"Kniebeugung {knee_flex_bdc:.1f} Grad liegt im Band {lo:.0f}-{hi:.0f} Grad: "
                           f"Sattelhoehe passt, nichts verstellen.")
    elif v["level"] == "edge":
        richtung = "hoeher" if mm > 0 else "tiefer"
        out["sentence"] = (f"Kniebeugung {knee_flex_bdc:.1f} Grad liegt am Rand des Bands {lo:.0f}-{hi:.0f} Grad, "
                           f"innerhalb der Messgenauigkeit. Wer nachstellen will: Sattel etwa {abs(mm):.0f} mm {richtung}.")
    elif v["level"] == "high":
        out["sentence"] = (f"Kniebeugung {knee_flex_bdc:.1f} Grad: Sattel zu tief. "
                           f"Sattel etwa {abs(mm):.0f} mm hoeher stellen (Ziel {target:.0f} Grad).")
    else:
        out["sentence"] = (f"Kniebeugung {knee_flex_bdc:.1f} Grad: Sattel zu hoch. "
                           f"Sattel etwa {abs(mm):.0f} mm tiefer stellen (Ziel {target:.0f} Grad).")
    return out


# ----------------------------------------------------------------------------
# Aufnahmepruefung (Schritt 2)
# ----------------------------------------------------------------------------
def camera_check(kp_xy: np.ndarray, kp_conf: np.ndarray, conf_min: float = KP_CONF_MIN) -> dict:
    """Seitenansicht? Waagerechter Schulterabstand / Strecke Schulter-Huefte.
    Ueber ~0.25 stand die Kamera schraeg. Dazu Hueftabstand als zweiter Wert."""
    ls, rs = KP["l_shoulder"], KP["r_shoulder"]
    lh, rh = KP["l_hip"], KP["r_hip"]
    ratios, hip_ratios = [], []
    for i in range(kp_xy.shape[0]):
        c = kp_conf[i]
        if min(c[ls], c[rs], c[lh], c[rh]) < conf_min:
            continue
        sh_dx = abs(kp_xy[i, ls, 0] - kp_xy[i, rs, 0])
        hp_dx = abs(kp_xy[i, lh, 0] - kp_xy[i, rh, 0])
        # Rumpflaenge: Mittel beider Seiten
        tl = 0.5 * (np.linalg.norm(kp_xy[i, ls] - kp_xy[i, lh]) + np.linalg.norm(kp_xy[i, rs] - kp_xy[i, rh]))
        if tl < 1:
            continue
        ratios.append(sh_dx / tl)
        hip_ratios.append(hp_dx / tl)
    if not ratios:
        return {"ok": False, "shoulder_ratio": None, "hip_ratio": None, "frames": 0,
                "msg": "Schultern und Hueften beider Seiten wurden nie zusammen sicher erkannt -- Seitenansicht nicht pruefbar."}
    r = float(np.median(ratios)); hr = float(np.median(hip_ratios))
    ok = r <= 0.25
    return {"ok": ok, "shoulder_ratio": r, "hip_ratio": hr, "frames": len(ratios),
            "msg": ("Seitenansicht in Ordnung" if ok else
                    "Kamera stand schraeg -- jede Winkelmessung faellt dann zu klein aus")}
