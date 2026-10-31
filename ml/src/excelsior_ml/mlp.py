"""A 2-layer tanh MLP trained by full-batch gradient descent, written to mirror the spreadsheet formulas.

The spreadsheet evaluates exactly these equations, one gradient step per iteration of iterative
calculation, so this module is the reference trajectory the in-sheet training is checked against.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

F64 = NDArray[np.float64]


@dataclass(frozen=True)
class MlpConfig:
    """Dataset and training hyperparameters (typed so runs are reproducible from the fixture alone)."""

    points_per_class: int = 100
    turns: float = 1.0
    noise: float = 0.06
    hidden: int = 16
    learning_rate: float = 0.5
    steps: int = 600
    seed: int = 7


@dataclass
class Params:
    """Hidden neurons as rows: w (H x 2), b (H), v (H) output weights, c output bias."""

    w: F64
    b: F64
    v: F64
    c: float


def two_spirals(cfg: MlpConfig) -> tuple[F64, F64]:
    """Two interleaved spirals in [-1, 1]^2 with uniform noise; labels are 0 and 1."""
    rng = np.random.default_rng(cfg.seed)
    n = cfg.points_per_class
    t = np.linspace(0.0, 1.0, n, endpoint=False) + 0.5 / n
    xs, ys = [], []
    for label in (0, 1):
        angle = t * cfg.turns * 2 * np.pi + label * np.pi
        radius = 0.15 + 0.8 * t
        pts = np.stack([radius * np.cos(angle), radius * np.sin(angle)], axis=1)
        pts = pts + rng.uniform(-cfg.noise, cfg.noise, size=pts.shape)
        xs.append(pts)
        ys.append(np.full(n, float(label)))
    return np.concatenate(xs), np.concatenate(ys)


def init_params(cfg: MlpConfig) -> Params:
    rng = np.random.default_rng(cfg.seed + 1)
    h = cfg.hidden
    return Params(
        w=rng.normal(0.0, 1.5, size=(h, 2)),
        b=rng.normal(0.0, 0.5, size=h),
        v=rng.normal(0.0, 1.0 / np.sqrt(h), size=h),
        c=0.0,
    )


def forward(p: Params, x: F64) -> tuple[F64, F64]:
    """Returns hidden activations (N x H) and logits (N)."""
    a = np.tanh(x @ p.w.T + p.b)
    return a, a @ p.v + p.c


def loss(z: F64, y: F64) -> float:
    """Numerically stable binary cross-entropy on logits (the same expression the sheet uses)."""
    return float(np.mean(np.where(z > 0, z, 0.0) - y * z + np.log(1.0 + np.exp(-np.abs(z)))))


def step(p: Params, x: F64, y: F64, lr: float) -> Params:
    """One full-batch gradient-descent step."""
    a, z = forward(p, x)
    n = x.shape[0]
    dz = (1.0 / (1.0 + np.exp(-z)) - y) / n
    dv = a.T @ dz
    dc = float(np.sum(dz))
    da = np.outer(dz, p.v) * (1.0 - a * a)
    dw = da.T @ x
    db = da.sum(axis=0)
    return Params(w=p.w - lr * dw, b=p.b - lr * db, v=p.v - lr * dv, c=p.c - lr * dc)


def flatten(p: Params) -> list[float]:
    """Neuron-table order used by the sheet: per neuron [w_x, w_y, b, v], then c."""
    rows = np.concatenate([p.w, p.b[:, None], p.v[:, None]], axis=1)
    return [*rows.ravel().tolist(), p.c]


def trajectory(cfg: MlpConfig) -> dict[str, object]:
    x, y = two_spirals(cfg)
    p = init_params(cfg)
    losses: list[float] = []
    params: list[list[float]] = []
    for k in range(cfg.steps + 1):
        _, z = forward(p, x)
        losses.append(loss(z, y))
        params.append(flatten(p))
        if k < cfg.steps:
            p = step(p, x, y, cfg.learning_rate)
    accuracy = float(np.mean((z > 0) == (y > 0.5)))
    return {
        "config": asdict(cfg),
        "x": x.tolist(),
        "y": y.tolist(),
        "init": params[0],
        "loss": losses,
        "params": params,
        "final_accuracy": accuracy,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Write the MLP reference trajectory fixture.")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=MlpConfig.steps)
    parser.add_argument("--lr", type=float, default=MlpConfig.learning_rate)
    parser.add_argument("--hidden", type=int, default=MlpConfig.hidden)
    parser.add_argument("--turns", type=float, default=MlpConfig.turns)
    args = parser.parse_args()
    cfg = MlpConfig(steps=args.steps, learning_rate=args.lr, hidden=args.hidden, turns=args.turns)
    data = trajectory(cfg)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data))
    losses = data["loss"]
    assert isinstance(losses, list)
    print(f"loss {losses[0]:.4f} -> {losses[-1]:.4f}, accuracy {data['final_accuracy']:.3f}")


if __name__ == "__main__":
    main()
