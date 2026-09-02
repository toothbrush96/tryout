"""
selftest.py -- Schritt 4: Die Messkette an einem kuenstlichen Tretzyklus pruefen.

Tretlager im Ursprung, Huefte fest darueber und leicht dahinter, Pedal auf einem
Kreis mit 172,5 mm Radius, Oberschenkel 430 mm, Unterschenkel 440 mm. Das Knie ist
der Schnittpunkt zweier Kreise. Die Huefthoehe wird ueber den Kosinussatz so
gesetzt, dass am unteren Totpunkt genau 35 Grad Kniebeugung herauskommen.

Der Zyklus wird als Pixel-Koordinaten (y nach unten) in dieselbe Kette gesteckt,
die spaeter das echte Video auswertet (fit_core.build_series + analyse_series).
"""
from __future__ import annotations

import math
import sys

import numpy as np

import fit_core as fc

CRANK = 172.5
FEMUR = 430.0
SHANK = 440.0
TARGET_FLEX = 35.0
HIP_BEHIND_BB = 60.0          # mm, "leicht dahinter"


def hip_position(target_flex: float, hx: float = HIP_BEHIND_BB):
    """Huefthoehe ueber dem Tretlager so, dass die kleinste Beugung im Zyklus (= unterer
    Totpunkt, Pedal am weitesten von der Huefte) genau target_flex ist.

    Kosinussatz: D = sqrt(F^2 + S^2 - 2 F S cos(180 - flex)) ist der Abstand
    Huefte-Pedal bei dieser Beugung. Der groesste Abstand ueber den Kreis ist
    |Huefte-Tretlager| + r, also |Huefte-Tretlager| = D - r.
    """
    theta = math.radians(180.0 - target_flex)
    D = math.sqrt(FEMUR ** 2 + SHANK ** 2 - 2 * FEMUR * SHANK * math.cos(theta))
    d_bb = D - CRANK
    hy = math.sqrt(d_bb ** 2 - hx ** 2)
    return np.array([-hx, hy]), D


def knee_point(hip, pedal):
    """Schnittpunkt Kreis(hip, FEMUR) mit Kreis(pedal, SHANK); die vordere Loesung."""
    d = np.linalg.norm(pedal - hip)
    if d > FEMUR + SHANK or d < abs(FEMUR - SHANK):
        raise ValueError("Bein passt nicht: Abstand Huefte-Pedal %.1f" % d)
    a = (FEMUR ** 2 - SHANK ** 2 + d ** 2) / (2 * d)
    h = math.sqrt(max(0.0, FEMUR ** 2 - a ** 2))
    u = (pedal - hip) / d
    base = hip + a * u
    perp = np.array([-u[1], u[0]])
    k1, k2 = base + h * perp, base - h * perp
    return k1 if k1[0] > k2[0] else k2      # Knie liegt vorn (x groesser)


def synth_cycle(fps: float, cadence_rpm: float, seconds: float, phase_deg: float,
                noise_px: float, rng: np.random.Generator, px_per_mm: float = 0.8,
                width: int = 1080, height: int = 1920):
    """Liefert kp_xy (n,17,2) in Pixeln, kp_conf (n,17), plus die wahre kleinste Beugung.
    Vor der ersten und nach der letzten Sekunde 'steht' die Person daneben:
    Bein gestreckt, Fuss am Boden -- genau die Bilder, die die Kette verwerfen muss."""
    hip_mm, _ = hip_position(TARGET_FLEX)
    n = int(round(seconds * fps))
    omega = 2 * math.pi * cadence_rpm / 60.0
    # Bildkoordinaten: Tretlager bei (width*0.45, height*0.72), y nach unten
    bb_px = np.array([width * 0.45, height * 0.72])

    def to_px(p_mm):
        return bb_px + np.array([p_mm[0], -p_mm[1]]) * px_per_mm

    shoulder_mm = hip_mm + np.array([420.0, 380.0])     # ~42 Grad Rumpf
    elbow_mm = shoulder_mm + np.array([230.0, -200.0])
    wrist_mm = elbow_mm + np.array([180.0, -170.0])

    kp_xy = np.full((n, 17, 2), np.nan)
    kp_conf = np.zeros((n, 17))
    stand_a = int(1.2 * fps); stand_b = n - int(1.2 * fps)
    true_flex = []
    for i in range(n):
        t = i / fps
        if stand_a <= i < stand_b:
            ang = omega * t + math.radians(phase_deg)   # 0 = Pedal vorn, pi/2 = oben ...
            pedal = CRANK * np.array([math.cos(ang), math.sin(ang)])
            knee = knee_point(hip_mm, pedal)
            hip = hip_mm
            true_flex.append(180.0 - fc.angle_at(hip, knee, pedal))
        else:
            # daneben stehen: Fuss am Boden (tiefer als jedes Pedal), Bein fast gestreckt
            pedal = np.array([40.0, -CRANK - 120.0])
            hip = np.array([-20.0, math.hypot(FEMUR, 0) + SHANK - 25.0 - CRANK - 120.0 + 0.0])
            hip = np.array([-20.0, pedal[1] + math.sqrt((FEMUR + SHANK - 8.0) ** 2 - 60.0 ** 2)])
            knee = knee_point(hip, pedal)
            true_flex.append(np.nan)
        pts = {
            "l_shoulder": shoulder_mm, "l_elbow": elbow_mm, "l_wrist": wrist_mm,
            "l_hip": hip, "l_knee": knee, "l_ankle": pedal,
        }
        for name, p in pts.items():
            j = fc.KP[name]
            xy = to_px(p)
            if noise_px > 0:
                xy = xy + rng.normal(0.0, noise_px, 2)
            kp_xy[i, j] = xy
            kp_conf[i, j] = 0.9
        # ferne Seite: schwaecher, leicht versetzt (nur damit choose_side etwas hat)
        for name, p in pts.items():
            j = fc.KP[name.replace("l_", "r_")]
            kp_xy[i, j] = to_px(p) + np.array([8.0, 3.0])
            kp_conf[i, j] = 0.4
    true_min = float(np.nanmin(np.array(true_flex)))
    return kp_xy, kp_conf, true_min


def run_once(fps, cadence, phase, noise, seed, seconds=20.0):
    rng = np.random.default_rng(seed)
    kp_xy, kp_conf, true_min = synth_cycle(fps, cadence, seconds, phase, noise, rng)
    S = fc.build_series(kp_xy, kp_conf, fps)
    R = fc.analyse_series(S)
    return R, true_min


def main():
    hip_mm, D = hip_position(TARGET_FLEX)
    # Kontrolle: Beugung bei Pedal exakt senkrecht unter dem Tretlager
    pedal_down = np.array([0.0, -CRANK])
    flex_down = 180.0 - fc.angle_at(hip_mm, knee_point(hip_mm, pedal_down), pedal_down)
    print("Kuenstlicher Tretzyklus")
    print(f"  Kurbel {CRANK} mm, Oberschenkel {FEMUR:.0f} mm, Unterschenkel {SHANK:.0f} mm")
    print(f"  Huefte: {HIP_BEHIND_BB:.0f} mm hinter, {hip_mm[1]:.1f} mm ueber dem Tretlager (Kosinussatz, D={D:.1f} mm)")
    print(f"  Wahre kleinste Beugung im Zyklus: {TARGET_FLEX:.2f} Grad "
          f"(bei Pedal exakt senkrecht unten: {flex_down:.2f} Grad -- die Huefte sitzt hinter dem Tretlager)")
    print(f"  mm je Grad aus dem Kosinussatz bei 35 Grad: {fc.mm_per_degree(FEMUR, SHANK, 145.0):.2f}")
    print()

    # 1) sauberer Durchlauf
    R, true_min = run_once(30.0, 90.0, 0.0, 0.0, 0)
    print(f"Sauberer Durchlauf (30 fps, 90 U/min, kein Rauschen): "
          f"gemessen {R.knee_bdc:.2f} Grad, wahr {true_min:.2f}, Fehler {R.knee_bdc - true_min:+.2f}, "
          f"Umdrehungen {len(R.cycles)}, Trittfrequenz {R.cadence_rpm:.1f}")

    # 2) zwei Dutzend Durchlaeufe mit Rauschen, verschiedenen Bildraten, Trittfrequenzen, Phasen
    rng = np.random.default_rng(42)
    cases = []
    for k in range(24):
        fps = [24.0, 25.0, 30.0, 50.0, 59.94, 60.0][k % 6]
        cadence = [72.0, 85.0, 95.0, 105.0][k % 4]
        noise = [2.0, 3.0, 4.0][k % 3]
        phase = float(rng.uniform(0, 360))
        cases.append((fps, cadence, phase, noise, 100 + k))

    print()
    print(f"{'fps':>6} {'U/min':>6} {'Phase':>6} {'Rausch':>6} {'Umdr':>5} {'gemessen':>9} {'wahr':>6} {'Fehler':>7}")
    errs = []
    worst = None
    for fps, cadence, phase, noise, seed in cases:
        R, true_min = run_once(fps, cadence, phase, noise, seed)
        if R.knee_bdc is None:
            print(f"{fps:6.2f} {cadence:6.0f} {phase:6.0f} {noise:6.1f}   FEHLGESCHLAGEN: {R.notes}")
            errs.append(float("nan"))
            continue
        e = R.knee_bdc - true_min
        errs.append(e)
        if worst is None or abs(e) > abs(worst[0]):
            worst = (e, fps, cadence, phase, noise)
        print(f"{fps:6.2f} {cadence:6.0f} {phase:6.0f} {noise:6.1f} {len(R.cycles):5d} {R.knee_bdc:9.2f} {true_min:6.2f} {e:+7.2f}")

    errs = np.array(errs)
    ok = np.isfinite(errs)
    print()
    print(f"Mittlerer Fehler (Betrag): {np.nanmean(np.abs(errs)):.2f} Grad")
    print(f"Mittlerer Fehler (mit Vorzeichen): {np.nanmean(errs):+.2f} Grad")
    print(f"Schlechtester Einzelfall: {worst[0]:+.2f} Grad bei {worst[1]:.2f} fps, {worst[2]:.0f} U/min, "
          f"Phase {worst[3]:.0f} Grad, Rauschen {worst[4]:.1f} px")
    print(f"Fehlgeschlagene Durchlaeufe: {(~ok).sum()} von {len(errs)}")
    mean_abs = float(np.nanmean(np.abs(errs)))
    if mean_abs > 1.0 or (~ok).any():
        print("ERGEBNIS: NICHT BESTANDEN -- Fehler in der Kette suchen, bevor es weitergeht.")
        return 1
    print("ERGEBNIS: bestanden (mittlerer Fehler unter 1 Grad)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
