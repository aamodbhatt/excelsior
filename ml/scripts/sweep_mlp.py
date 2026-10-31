"""Small sweep used to pick the in-sheet MLP hyperparameters (dataset difficulty vs. steps to converge)."""

from __future__ import annotations

from excelsior_ml.mlp import MlpConfig, trajectory


def main() -> None:
    for turns in (0.75, 1.0):
        for hidden in (12, 16):
            for lr in (0.5, 1.0, 2.0):
                cfg = MlpConfig(turns=turns, hidden=hidden, learning_rate=lr, steps=1500)
                t = trajectory(cfg)
                losses = t["loss"]
                assert isinstance(losses, list)
                marks = " ".join(f"{k}:{losses[k]:.3f}" for k in (0, 200, 400, 800, 1500))
                print(f"turns={turns} H={hidden} lr={lr}  {marks}  acc={t['final_accuracy']:.3f}")


if __name__ == "__main__":
    main()
