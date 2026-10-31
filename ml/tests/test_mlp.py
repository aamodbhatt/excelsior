"""The NumPy MLP is the reference the spreadsheet is checked against, so it must itself be correct."""

from __future__ import annotations

import numpy as np

from excelsior_ml.mlp import (
    MlpConfig,
    Params,
    flatten,
    forward,
    init_params,
    loss,
    step,
    trajectory,
    two_spirals,
)


def numeric_grad(p: Params, x: np.ndarray, y: np.ndarray, eps: float = 1e-6) -> list[float]:
    """Central finite differences over every parameter in neuron-table order."""
    base = flatten(p)
    grads: list[float] = []
    h = p.w.shape[0]

    def rebuild(vec: list[float]) -> Params:
        rows = np.array(vec[:-1]).reshape(h, 4)
        return Params(w=rows[:, :2].copy(), b=rows[:, 2].copy(), v=rows[:, 3].copy(), c=vec[-1])

    for i in range(len(base)):
        plus = list(base)
        minus = list(base)
        plus[i] += eps
        minus[i] -= eps
        lp = loss(forward(rebuild(plus), x)[1], y)
        lm = loss(forward(rebuild(minus), x)[1], y)
        grads.append((lp - lm) / (2 * eps))
    return grads


def test_gradient_step_matches_finite_differences() -> None:
    cfg = MlpConfig(points_per_class=10, hidden=4)
    x, y = two_spirals(cfg)
    p = init_params(cfg)
    lr = 1e-3
    analytic = (np.array(flatten(p)) - np.array(flatten(step(p, x, y, lr)))) / lr
    np.testing.assert_allclose(analytic, numeric_grad(p, x, y), rtol=1e-5, atol=1e-8)


def test_stable_loss_matches_naive_cross_entropy() -> None:
    z = np.array([-3.0, -0.5, 0.0, 0.7, 4.0])
    y = np.array([0.0, 1.0, 1.0, 0.0, 1.0])
    p = 1 / (1 + np.exp(-z))
    naive = -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
    assert abs(loss(z, y) - naive) < 1e-12


def test_training_reduces_loss_and_is_deterministic() -> None:
    cfg = MlpConfig(steps=150, learning_rate=1.0)
    a = trajectory(cfg)
    b = trajectory(cfg)
    losses = a["loss"]
    assert isinstance(losses, list)
    assert losses[-1] < losses[0] / 2
    assert a["params"] == b["params"]


def test_flatten_uses_neuron_table_order() -> None:
    p = Params(w=np.array([[1.0, 2.0], [5.0, 6.0]]), b=np.array([3.0, 7.0]), v=np.array([4.0, 8.0]), c=9.0)
    assert flatten(p) == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]
