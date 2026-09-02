"""Erzeugt ein einfarbiges Testvideo plus Punkte-Cache aus dem kuenstlichen Tretzyklus,
damit sich das Overlay ohne echtes Video pruefen laesst:
    python make_synth_video.py && python bikefit.py render testdata/synth.mp4
"""
import subprocess
from pathlib import Path
import numpy as np
import selftest as st

HERE = Path(__file__).resolve().parent
(HERE / "testdata").mkdir(exist_ok=True)
(HERE / "out").mkdir(exist_ok=True)
fps = 60000 / 1001
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                "-i", f"color=c=0x2a3a4a:s=1080x1920:r=60000/1001:d=15",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(HERE / "testdata/synth.mp4")], check=True)
xy, conf, _ = st.synth_cycle(fps, 88.0, 15.0, 40.0, 2.5, np.random.default_rng(3))
box = np.stack([np.nanmin(xy[:, :, 0], 1) - 40, np.nanmin(xy[:, :, 1], 1) - 120,
                np.nanmax(xy[:, :, 0], 1) + 40, np.nanmax(xy[:, :, 1], 1) + 40], 1)
np.savez_compressed(HERE / "out/synth_keypoints.npz", xy=xy, conf=conf, box=box, fps=fps, w=1080, h=1920)
print("testdata/synth.mp4 und out/synth_keypoints.npz geschrieben")
